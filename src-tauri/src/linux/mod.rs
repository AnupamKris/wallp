//! GNOME and XFCE support. GNOME's Wayland compositor gives clients no way to
//! sit behind other windows, read the clipboard in the background or grab
//! global shortcuts, so wallp runs through XWayland (set in `main.rs`) and
//! leans on the X11 window manager protocols Mutter still honours, plus GNOME
//! settings. XFCE runs on X11 itself, so the same protocols reach every window
//! there, and `xfce` covers the settings that differ.
pub mod apps;
pub mod clipboard;
pub mod hotkeys;
pub mod keybindings;
pub mod xfce;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use x11rb::{
    connection::Connection,
    protocol::{
        Event,
        xproto::{
            AtomEnum, ClientMessageEvent, ConnectionExt, CreateWindowAux, EventMask, PropMode,
            Window, WindowClass,
        },
    },
    rust_connection::RustConnection,
};

pub struct X11 {
    pub conn: RustConnection,
    pub root: Window,
    atoms: Mutex<HashMap<String, u32>>,
}

/// True in an XFCE session. Anything else gets the GNOME behaviour.
pub fn is_xfce() -> bool {
    static XFCE: OnceLock<bool> = OnceLock::new();
    *XFCE.get_or_init(|| {
        std::env::var("XDG_CURRENT_DESKTOP")
            .is_ok_and(|v| v.split(':').any(|d| d.eq_ignore_ascii_case("xfce")))
    })
}

/// One shared connection for short requests. Long blocking event loops (the
/// clipboard watcher) open their own.
pub fn x11() -> Result<&'static X11, String> {
    static X11: OnceLock<Result<X11, String>> = OnceLock::new();
    X11.get_or_init(|| {
        let (conn, screen) =
            x11rb::connect(None).map_err(|e| format!("Couldn't reach the X server: {e}"))?;
        let root = conn.setup().roots[screen].root;
        Ok(X11 {
            conn,
            root,
            atoms: Mutex::default(),
        })
    })
    .as_ref()
    .map_err(Clone::clone)
}

impl X11 {
    pub fn atom(&self, name: &str) -> Result<u32, String> {
        if let Some(atom) = self.atoms.lock().unwrap().get(name) {
            return Ok(*atom);
        }
        let atom = self
            .conn
            .intern_atom(false, name.as_bytes())
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .atom;
        self.atoms.lock().unwrap().insert(name.into(), atom);
        Ok(atom)
    }

    /// A 32-bit property of any type: cardinals, windows or atoms.
    pub fn values(&self, window: Window, name: &str) -> Result<Vec<u32>, String> {
        let atom = self.atom(name)?;
        let reply = self
            .conn
            .get_property(false, window, atom, AtomEnum::ANY, 0, 1 << 20)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(reply.value32().map(Iterator::collect).unwrap_or_default())
    }

    /// A text property, e.g. `_NET_WM_NAME` (UTF-8) or `WM_NAME` (Latin-1).
    pub fn text(&self, window: Window, name: &str) -> Result<String, String> {
        let atom = self.atom(name)?;
        let reply = self
            .conn
            .get_property(false, window, atom, AtomEnum::ANY, 0, 4096)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&reply.value).into_owned())
    }

    /// Whether `window`'s list property, e.g. `_NET_WM_STATE`, holds `value`.
    pub fn has(&self, window: Window, name: &str, value: &str) -> bool {
        self.atom(value)
            .and_then(|atom| Ok(self.values(window, name)?.contains(&atom)))
            .unwrap_or(false)
    }

    /// The window with keyboard focus, as the window manager reports it.
    pub fn active_window(&self) -> Option<Window> {
        self.values(self.root, "_NET_ACTIVE_WINDOW")
            .ok()?
            .first()
            .copied()
            .filter(|w| *w != 0)
    }

    /// Top-level windows the window manager knows about, bottom first.
    pub fn stacking(&self) -> Vec<Window> {
        self.values(self.root, "_NET_CLIENT_LIST_STACKING")
            .unwrap_or_default()
    }

    /// `WM_CLASS` as (instance, class).
    pub fn class(&self, window: Window) -> (String, String) {
        let raw = self.text(window, "WM_CLASS").unwrap_or_default();
        let mut parts = raw.split('\0');
        let instance = parts.next().unwrap_or_default().to_string();
        (instance, parts.next().unwrap_or_default().to_string())
    }

    pub fn cardinals(&self, window: Window, name: &str) -> Result<Vec<u32>, String> {
        let atom = self.atom(name)?;
        let reply = self
            .conn
            .get_property(false, window, atom, AtomEnum::CARDINAL, 0, 1024)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        Ok(reply.value32().map(Iterator::collect).unwrap_or_default())
    }

    /// Sends an EWMH request to the window manager.
    pub fn send_root_message(
        &self,
        window: Window,
        name: &str,
        data: [u32; 5],
    ) -> Result<(), String> {
        let event = ClientMessageEvent::new(32, window, self.atom(name)?, data);
        self.conn
            .send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT,
                event,
            )
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())
    }
}

/// The X11 id of a Tauri window. Fails if GTK isn't running on X11.
pub fn xid(window: &tauri::WebviewWindow) -> Result<u32, String> {
    use gtk::prelude::WidgetExt;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    // GTK creates the X11 window lazily.
    window.gtk_window().map_err(|e| e.to_string())?.realize();
    let handle = window.window_handle().map_err(|e| e.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => Ok(handle.window as u32),
        _ => Err("wallp needs X11 or XWayland. Start it without GDK_BACKEND=wayland.".into()),
    }
}

/// The X server's current time, read back from a throwaway property change.
fn server_time() -> Result<u32, String> {
    let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[screen].root;
    let window = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_window(
        0,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(|e| e.to_string())?;
    conn.change_property(
        PropMode::APPEND,
        window,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        8,
        0,
        &[],
    )
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    loop {
        if let Event::PropertyNotify(event) = conn.wait_for_event().map_err(|e| e.to_string())? {
            return Ok(event.time);
        }
    }
}

/// Raises and focuses `window`. Mutter ignores focus requests from XWayland
/// apps that carry no fresh timestamp, so ask the way a pager would.
pub fn activate(window: &tauri::WebviewWindow) -> Result<(), String> {
    activate_xid(xid(window)?)
}

/// Raises, restores and focuses any top-level window.
pub fn activate_xid(id: Window) -> Result<(), String> {
    x11()?.send_root_message(id, "_NET_ACTIVE_WINDOW", [2, server_time()?, 0, 0, 0])
}

/// Minimizes every window, like the desktop's own Show Desktop.
pub fn show_desktop() -> Result<(), String> {
    let x = x11()?;
    x.send_root_message(x.root, "_NET_SHOWING_DESKTOP", [1, 0, 0, 0, 0])
}

pub fn command_output(program: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("Couldn't run {program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `$XDG_DATA_HOME`, then each of `$XDG_DATA_DIRS`, most important first.
pub fn data_dirs() -> Vec<std::path::PathBuf> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let mut dirs = vec![
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share")),
    ];
    let system = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    dirs.extend(system.split(':').filter(|d| !d.is_empty()).map(Into::into));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// Where wallp keeps its data, and the journals that let a later run undo
/// desktop settings a crashed one changed. Same as Tauri's local data dir.
pub fn state_dir() -> Option<PathBuf> {
    let dir = data_dirs().into_iter().next()?.join("com.anupa.wallp");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Logging out sends SIGTERM (and a terminal SIGINT/SIGHUP). Quit through
/// Tauri instead so shortcuts, icons and panels are given back to the desktop.
pub fn exit_on_signals(app: &tauri::AppHandle) {
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        let app = app.clone();
        gtk::glib::unix_signal_add_local(signal, move || {
            app.exit(0);
            gtk::glib::ControlFlow::Break
        });
    }
}
