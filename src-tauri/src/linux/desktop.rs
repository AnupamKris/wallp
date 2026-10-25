//! Puts a window in the desktop layer of GNOME or XFCE.
//!
//! Mutter keeps X11 windows typed `_NET_WM_WINDOW_TYPE_DESKTOP` below every
//! other window, on every workspace, out of Alt+Tab and the overview, and
//! leaves them alone on Show Desktop: the same things the Windows `WorkerW`
//! trick gets us. Wayland has no equivalent, hence XWayland.
//!
//! Desktop icons are drawn by a GNOME Shell extension in a window of the same
//! layer, which would cover wallp and take its clicks, so hiding icons disables
//! that extension. The disabled list is journaled so a crash can't lose it.
//!
//! On XFCE, xfdesktop draws the wallpaper and icons in an opaque desktop
//! window of its own. xfwm4 ignores restack requests from desktop windows,
//! but stacks a newly mapped one on top of the others, so wallp re-maps itself
//! to get in front of xfdesktop, and "Show desktop icons" withdraws wallp so
//! xfdesktop shows through. Nothing in xfdesktop's settings changes.
use gtk::{gdk::WindowTypeHint, prelude::*};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use x11rb::{connection::Connection, protocol::xproto::*};

/// Desktop icon extensions for Zorin, Ubuntu and stock GNOME.
const ICON_EXTENSIONS: [&str; 4] = [
    "zorin-desktop-icons@zorinos.com",
    "ding@rastersoft.com",
    "gtk4-ding@smedius.gitlab.com",
    "desktop-icons@csoriano",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct Attachment {
    /// The X11 window id.
    window: u32,
    /// The work area we were sized to.
    pub bounds: Rect,
}

/// Whether xfdesktop's icons should be in front of wallp.
static ICONS_VISIBLE: AtomicBool = AtomicBool::new(false);
/// Set while wallp's window is withdrawn to show xfdesktop.
static WITHDRAWN: AtomicBool = AtomicBool::new(false);

/// The area not covered by the desktop's panels, across every monitor. Mutter
/// publishes it as `_NET_WORKAREA`; the root window is the fallback.
pub fn virtual_screen() -> Rect {
    let Ok(x) = crate::linux::x11() else {
        return Rect {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
        };
    };
    if let Ok(area) = x.cardinals(x.root, "_NET_WORKAREA") {
        if let [ax, ay, w, h, ..] = area[..] {
            if w > 0 && h > 0 {
                return Rect {
                    x: ax as i32,
                    y: ay as i32,
                    w: w as i32,
                    h: h as i32,
                };
            }
        }
    }
    let screen = &x.conn.setup().roots[0];
    Rect {
        x: 0,
        y: 0,
        w: screen.width_in_pixels.into(),
        h: screen.height_in_pixels.into(),
    }
}

/// Makes `window` a desktop window and sizes it to the work area. Safe to call
/// again, e.g. after the monitor layout changes.
pub fn attach(window: &tauri::WebviewWindow) -> Result<Attachment, String> {
    let gtk = window.gtk_window().map_err(|e| e.to_string())?;
    if gtk.type_hint() != WindowTypeHint::Desktop {
        // Mutter reads the type when a window is mapped, so set it while hidden.
        let shown = gtk.is_visible();
        if shown {
            gtk.hide();
        }
        gtk.set_type_hint(WindowTypeHint::Desktop);
        gtk.set_skip_pager_hint(true);
        gtk.set_skip_taskbar_hint(true);
        gtk.set_keep_below(true);
        gtk.stick();
        if shown {
            gtk.show();
        }
    }
    let attachment = Attachment {
        window: crate::linux::xid(window)?,
        bounds: virtual_screen(),
    };
    // GTK keeps its own idea of the size and would undo an X11-only resize.
    let (b, scale) = (attachment.bounds, gtk.scale_factor().max(1));
    gtk.move_(b.x / scale, b.y / scale);
    gtk.resize((b.w / scale).max(1), (b.h / scale).max(1));
    attachment.place()?;
    Ok(attachment)
}

impl Attachment {
    /// Moves the window over the work area. Call again after showing it:
    /// the window manager places windows when they're mapped.
    pub fn place(&self) -> Result<(), String> {
        let x = crate::linux::x11()?;
        let b = self.bounds;
        x.conn
            .configure_window(
                self.window,
                &ConfigureWindowAux::new()
                    .x(b.x)
                    .y(b.y)
                    .width(b.w.max(1) as u32)
                    .height(b.h.max(1) as u32)
                    .stack_mode(StackMode::BELOW),
            )
            .map_err(|e| e.to_string())?;
        // Only once the window manager lists us: until then we're still mapping.
        if !ICONS_VISIBLE.load(Ordering::Relaxed) && self.stacked_below_xfdesktop(x) {
            self.withdraw(x)?;
            self.map(x)?;
        }
        x.conn.flush().map_err(|e| e.to_string())
    }

    /// Unmaps the window the ICCCM way, so the window manager lets it go.
    fn withdraw(&self, x: &crate::linux::X11) -> Result<(), String> {
        x.conn
            .unmap_window(self.window)
            .map_err(|e| e.to_string())?;
        let event = UnmapNotifyEvent {
            response_type: UNMAP_NOTIFY_EVENT,
            sequence: 0,
            event: x.root,
            window: self.window,
            from_configure: false,
        };
        x.conn
            .send_event(
                false,
                x.root,
                EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
                event,
            )
            .map_err(|e| e.to_string())?;
        WITHDRAWN.store(true, Ordering::Relaxed);
        x.conn.flush().map_err(|e| e.to_string())
    }

    fn map(&self, x: &crate::linux::X11) -> Result<(), String> {
        x.conn.map_window(self.window).map_err(|e| e.to_string())?;
        WITHDRAWN.store(false, Ordering::Relaxed);
        x.conn.flush().map_err(|e| e.to_string())
    }

    /// False once the window is gone, or xfdesktop has come up in front of it.
    pub fn is_intact(&self) -> bool {
        if WITHDRAWN.load(Ordering::Relaxed) {
            return true;
        }
        let Ok(x) = crate::linux::x11() else {
            return false;
        };
        let mapped = x
            .conn
            .get_window_attributes(self.window)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|a| a.map_state == MapState::VIEWABLE);
        mapped && !self.stacked_below_xfdesktop(x)
    }

    /// True if xfdesktop is listed above us. False before we're listed.
    fn stacked_below_xfdesktop(&self, x: &crate::linux::X11) -> bool {
        let Some(top) = xfdesktop_windows(x).last().copied() else {
            return false;
        };
        let stacking = x.stacking();
        let position = |w| stacking.iter().position(|s| *s == w);
        position(self.window)
            .zip(position(top))
            .is_some_and(|(ours, theirs)| ours < theirs)
    }

    pub fn set_icons_visible(&self, visible: bool) {
        if !crate::linux::is_xfce() {
            return set_icon_extensions(visible);
        }
        ICONS_VISIBLE.store(visible, Ordering::Relaxed);
        let Ok(x) = crate::linux::x11() else {
            return;
        };
        // Only undo our own withdrawal: GTK maps the window when it's shown.
        let _ = if visible {
            self.withdraw(x)
        } else if WITHDRAWN.load(Ordering::Relaxed) {
            self.map(x).and_then(|_| self.place())
        } else {
            Ok(())
        };
    }
}

/// xfdesktop's desktop windows, bottom first. Empty outside XFCE.
fn xfdesktop_windows(x: &crate::linux::X11) -> Vec<u32> {
    if !crate::linux::is_xfce() {
        return Vec::new();
    }
    x.stacking()
        .into_iter()
        .filter(|w| x.class(*w).1 == "Xfdesktop")
        .collect()
}

fn journal() -> Option<PathBuf> {
    let data = crate::linux::data_dirs().into_iter().next()?;
    let dir = data.join("com.anupa.wallp");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("hidden-desktop-icons.journal"))
}

/// Enables or disables the desktop icon extensions that were enabled before
/// wallp hid them. Skips the work when nothing changes.
fn set_icon_extensions(visible: bool) {
    static STATE: Mutex<Option<bool>> = Mutex::new(None);
    let mut state = STATE.lock().unwrap();
    if *state == Some(visible) {
        return;
    }
    let journal = journal();
    let mut hidden: Vec<String> = journal
        .as_ref()
        .and_then(|j| std::fs::read_to_string(j).ok())
        .map(|v| v.lines().map(str::to_string).collect())
        .unwrap_or_default();
    if visible {
        for id in &hidden {
            let _ = crate::linux::command_output("gnome-extensions", &["enable", id]);
        }
        if let Some(journal) = journal {
            let _ = std::fs::remove_file(journal);
        }
    } else {
        let enabled = crate::linux::command_output("gnome-extensions", &["list", "--enabled"])
            .unwrap_or_default();
        for id in enabled.lines().filter(|id| ICON_EXTENSIONS.contains(id)) {
            if !hidden.iter().any(|h| h == id) {
                hidden.push(id.to_string());
            }
        }
        // Journal before disabling, so a crash still knows what to restore.
        if let Some(journal) = &journal {
            let _ = std::fs::write(journal, hidden.join("\n"));
        }
        for id in &hidden {
            let _ = crate::linux::command_output("gnome-extensions", &["disable", id]);
        }
    }
    *state = Some(visible);
}

/// True while a fullscreen window has focus, so the desktop can't be seen.
/// On GNOME that would mean seeing Wayland windows, which XWayland clients
/// can't, so animations keep running; GNOME stops drawing hidden windows.
pub fn fullscreen_app_running() -> bool {
    if !crate::linux::is_xfce() {
        return false;
    }
    let Ok(x) = crate::linux::x11() else {
        return false;
    };
    x.active_window()
        .is_some_and(|w| x.has(w, "_NET_WM_STATE", "_NET_WM_STATE_FULLSCREEN"))
}

/// GNOME and xfdesktop redraw their own background when our window goes away.
pub fn refresh_wallpaper() {}
