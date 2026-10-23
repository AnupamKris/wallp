//! Clipboard change notifications. Mutter mirrors the Wayland clipboard into
//! XWayland, so XFixes tells us when it changes, the way Windows' clipboard
//! sequence number does. Content itself is read with arboard.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        Event,
        xfixes::{ConnectionExt as _, SelectionEventMask},
        xproto::{AtomEnum, ConnectionExt as _, CreateWindowAux, WindowClass},
    },
    rust_connection::RustConnection,
};

pub enum Kind {
    Text,
    Image,
}

/// KeePassXC and other password managers mark secrets with this target.
const SECRET_HINT: &str = "x-kde-passwordManagerHint";
const TEXT_TARGETS: [&str; 5] = ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT"];

pub struct Watcher {
    conn: RustConnection,
    window: u32,
    clipboard: u32,
    targets: u32,
    property: u32,
}

impl Watcher {
    pub fn new() -> Result<Self, String> {
        let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[screen].root;
        let window = conn.generate_id().map_err(|e| e.to_string())?;
        conn.create_window(0, window, root, 0, 0, 1, 1, 0, WindowClass::INPUT_ONLY, 0, &CreateWindowAux::new())
            .map_err(|e| e.to_string())?;
        let atom = |name: &str| -> Result<u32, String> {
            Ok(conn
                .intern_atom(false, name.as_bytes())
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?
                .atom)
        };
        let clipboard = atom("CLIPBOARD")?;
        let targets = atom("TARGETS")?;
        let property = atom("WALLP_CLIPBOARD_TARGETS")?;
        conn.xfixes_query_version(5, 0)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| format!("XFixes is unavailable: {e}"))?;
        conn.xfixes_select_selection_input(
            window,
            clipboard,
            SelectionEventMask::SET_SELECTION_OWNER
                | SelectionEventMask::SELECTION_WINDOW_DESTROY
                | SelectionEventMask::SELECTION_CLIENT_CLOSE,
        )
        .map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())?;
        Ok(Self { conn, window, clipboard, targets, property })
    }

    /// Blocks until the clipboard changes. `None` means it is empty, holds
    /// something other than text or an image, or was marked as a secret.
    pub fn next(&self) -> Result<Option<Kind>, String> {
        loop {
            let event = self.conn.wait_for_event().map_err(|e| e.to_string())?;
            if let Event::XfixesSelectionNotify(notify) = event {
                if notify.selection == self.clipboard {
                    return self.offered();
                }
            }
        }
    }

    fn offered(&self) -> Result<Option<Kind>, String> {
        self.conn
            .convert_selection(self.window, self.clipboard, self.targets, self.property, x11rb::CURRENT_TIME)
            .map_err(|e| e.to_string())?;
        self.conn.flush().map_err(|e| e.to_string())?;
        // An owner that never answers must not stall history forever.
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            match self.conn.poll_for_event().map_err(|e| e.to_string())? {
                Some(Event::SelectionNotify(reply)) if reply.requestor == self.window => {
                    if reply.property == u32::from(AtomEnum::NONE) {
                        return Ok(None);
                    }
                    break;
                }
                // A newer change supersedes this one; its targets arrive next.
                Some(_) => {}
                None if Instant::now() > deadline => return Ok(None),
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        let reply = self
            .conn
            .get_property(true, self.window, self.property, AtomEnum::ATOM, 0, 4096)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let mut names = Vec::new();
        for atom in reply.value32().into_iter().flatten() {
            if let Ok(reply) = self.conn.get_atom_name(atom).map_err(|e| e.to_string())?.reply() {
                names.push(String::from_utf8_lossy(&reply.name).into_owned());
            }
        }
        Ok(classify(&names))
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        let _ = self.conn.destroy_window(self.window);
        let _ = self.conn.flush();
    }
}

fn classify(targets: &[String]) -> Option<Kind> {
    if targets.iter().any(|t| t == SECRET_HINT) {
        None
    } else if targets.iter().any(|t| t.starts_with("image/")) {
        Some(Kind::Image)
    } else if targets.iter().any(|t| TEXT_TARGETS.contains(&t.as_str())) {
        Some(Kind::Text)
    } else {
        None
    }
}

/// X11 clipboard content is served by its owner, so keep one arboard handle
/// alive for the whole session or pasted entries vanish when it drops.
pub fn with<R>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<R, arboard::Error>) -> Result<R, String> {
    static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);
    let mut slot = CLIPBOARD.lock().unwrap();
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    f(slot.as_mut().unwrap()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_targets_and_skips_secrets() {
        let t = |v: &[&str]| classify(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(matches!(t(&["TARGETS", "UTF8_STRING"]), Some(Kind::Text)));
        assert!(matches!(t(&["text/html", "image/png", "UTF8_STRING"]), Some(Kind::Image)));
        assert!(t(&["UTF8_STRING", SECRET_HINT]).is_none());
        assert!(t(&["text/uri-list"]).is_none());
    }
}
