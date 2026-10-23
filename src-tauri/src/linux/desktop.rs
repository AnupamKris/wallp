//! Puts a window in GNOME's desktop layer.
//!
//! Mutter keeps X11 windows typed `_NET_WM_WINDOW_TYPE_DESKTOP` below every
//! other window, on every workspace, out of Alt+Tab and the overview, and
//! leaves them alone on Show Desktop: the same things the Windows `WorkerW`
//! trick gets us. Wayland has no equivalent, hence XWayland.
//!
//! Desktop icons are drawn by a GNOME Shell extension in a window of the same
//! layer, which would cover wallp and take its clicks, so hiding icons disables
//! that extension. The disabled list is journaled so a crash can't lose it.
use gtk::{gdk::WindowTypeHint, prelude::*};
use std::{path::PathBuf, sync::Mutex};
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

/// The area not covered by GNOME's panels, across every monitor. Mutter
/// publishes it as `_NET_WORKAREA`; the root window is the fallback.
pub fn virtual_screen() -> Rect {
    let Ok(x) = crate::linux::x11() else {
        return Rect { x: 0, y: 0, w: 0, h: 0 };
    };
    if let Ok(area) = x.cardinals(x.root, "_NET_WORKAREA") {
        if let [ax, ay, w, h, ..] = area[..] {
            if w > 0 && h > 0 {
                return Rect { x: ax as i32, y: ay as i32, w: w as i32, h: h as i32 };
            }
        }
    }
    let screen = &x.conn.setup().roots[0];
    Rect { x: 0, y: 0, w: screen.width_in_pixels.into(), h: screen.height_in_pixels.into() }
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
        x.conn.flush().map_err(|e| e.to_string())
    }

    /// False once the window is gone.
    pub fn is_intact(&self) -> bool {
        crate::linux::x11().is_ok_and(|x| {
            x.conn
                .get_window_attributes(self.window)
                .ok()
                .and_then(|c| c.reply().ok())
                .is_some_and(|a| a.map_state == MapState::VIEWABLE)
        })
    }

    pub fn set_icons_visible(&self, visible: bool) {
        set_icon_extensions(visible);
    }
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
        let enabled = crate::linux::command_output("gnome-extensions", &["list", "--enabled"]).unwrap_or_default();
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

/// Fullscreen detection would need to see Wayland windows, which XWayland
/// clients can't. Animations keep running; GNOME stops drawing hidden windows.
pub fn fullscreen_app_running() -> bool {
    false
}

/// GNOME redraws its own background when our window goes away.
pub fn refresh_wallpaper() {}
