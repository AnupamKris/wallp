//! Global shortcuts on a plain X11 session (XFCE). wallp grabs the keys on
//! the root window itself, like Windows' `RegisterHotKey`, so nothing is left
//! in the desktop's settings if it dies. GNOME's XWayland can't do this; see
//! `keybindings`.
use super::keybindings::{DESKTOP, LAUNCHER, WORKSPACE};
use std::{
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::Duration,
};
use x11rb::{
    connection::Connection,
    protocol::{Event, xproto::*},
    rust_connection::RustConnection,
};

struct Hotkey {
    flag: &'static str,
    label: &'static str,
    keysym: u32,
    modifiers: u16,
}

// X11 modifier bits.
const SHIFT: u16 = 1 << 0;
const LOCK: u16 = 1 << 1;
const CONTROL: u16 = 1 << 2;
const ALT: u16 = 1 << 3;
const NUM_LOCK: u16 = 1 << 4;
const SUPER: u16 = 1 << 6;

const KEYS: [Hotkey; 3] = [
    Hotkey {
        flag: LAUNCHER,
        label: "Ctrl+Space",
        keysym: 0x20,
        modifiers: CONTROL,
    },
    Hotkey {
        flag: WORKSPACE,
        label: "Ctrl+Alt+W",
        keysym: 0x77,
        modifiers: CONTROL | ALT,
    },
    Hotkey {
        flag: DESKTOP,
        label: "Ctrl+Alt+D",
        keysym: 0x64,
        modifiers: CONTROL | ALT,
    },
];

/// Caps Lock and Num Lock change the modifier state, so each shortcut is
/// grabbed with every combination of them.
const LOCKS: [u16; 4] = [0, LOCK, NUM_LOCK, LOCK | NUM_LOCK];
/// Modifiers that make a different shortcut.
const SIGNIFICANT: u16 = CONTROL | ALT | SHIFT | SUPER;

struct Grabber {
    conn: RustConnection,
    root: Window,
    codes: [Option<Keycode>; 3],
    grabbed: Mutex<[bool; 3]>,
}

impl Grabber {
    fn connect() -> Result<Self, String> {
        let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[screen].root;
        let (min, max) = (conn.setup().min_keycode, conn.setup().max_keycode);
        let map = conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let per = map.keysyms_per_keycode.max(1) as usize;
        let codes = KEYS.map(|key| {
            map.keysyms
                .chunks(per)
                .position(|syms| syms.contains(&key.keysym))
                .map(|i| min + i as u8)
        });
        Ok(Self {
            conn,
            root,
            codes,
            grabbed: Mutex::new([false; 3]),
        })
    }

    fn grab(&self, index: usize) -> Result<(), String> {
        let code = self.codes[index].ok_or("no key for it on this keyboard layout")?;
        for lock in LOCKS {
            let modifiers = ModMask::from(KEYS[index].modifiers | lock);
            let result = self
                .conn
                .grab_key(
                    true,
                    self.root,
                    modifiers,
                    code,
                    GrabMode::ASYNC,
                    GrabMode::ASYNC,
                )
                .map_err(|e| e.to_string())
                .and_then(|cookie| {
                    cookie
                        .check()
                        .map_err(|_| "another app uses it".to_string())
                });
            if let Err(error) = result {
                self.ungrab(index);
                return Err(error);
            }
        }
        Ok(())
    }

    fn ungrab(&self, index: usize) {
        if let Some(code) = self.codes[index] {
            for lock in LOCKS {
                let _ = self.conn.ungrab_key(
                    code,
                    self.root,
                    ModMask::from(KEYS[index].modifiers | lock),
                );
            }
            let _ = self.conn.flush();
        }
    }

    /// Calls `on_key` for each shortcut press. Key repeat sends a release and
    /// a press with the same timestamp; those presses are skipped.
    fn listen(&self, on_key: impl Fn(&'static str)) {
        let mut released: [Option<Timestamp>; 3] = [None; 3];
        loop {
            let Ok(event) = self.conn.wait_for_event() else {
                return;
            };
            let (pressed, code, time, state) = match event {
                Event::KeyPress(e) => (true, e.detail, e.time, u16::from(e.state)),
                Event::KeyRelease(e) => (false, e.detail, e.time, u16::from(e.state)),
                _ => continue,
            };
            let Some(index) = (0..KEYS.len()).find(|&i| {
                self.codes[i] == Some(code) && (state & SIGNIFICANT) == KEYS[i].modifiers
            }) else {
                continue;
            };
            if !pressed {
                released[index] = Some(time);
            } else if released[index] != Some(time) {
                on_key(KEYS[index].flag);
            }
        }
    }
}

fn grabber(
    on_key: impl Fn(&'static str) + Send + 'static,
) -> Result<&'static Arc<Grabber>, String> {
    static GRABBER: OnceLock<Result<Arc<Grabber>, String>> = OnceLock::new();
    let mut on_key = Some(on_key);
    GRABBER
        .get_or_init(|| {
            let grabber = Arc::new(Grabber::connect()?);
            let listener = grabber.clone();
            let on_key = on_key.take().expect("initialised once");
            thread::spawn(move || listener.listen(on_key));
            Ok(grabber)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Grabs wallp's shortcuts, or releases Ctrl+Space when it's turned off.
/// `on_key` receives the same flags the GNOME shortcuts pass on the command
/// line. Retries briefly: the window manager may still hold a key it was
/// just asked to give up.
pub fn install(
    ctrl_space: bool,
    on_key: impl Fn(&'static str) + Send + 'static,
) -> Result<(), String> {
    let grabber = grabber(on_key)?;
    let mut grabbed = grabber.grabbed.lock().unwrap();
    let mut errors = Vec::new();
    for (index, key) in KEYS.iter().enumerate() {
        let wanted = key.flag != LAUNCHER || ctrl_space;
        if wanted == grabbed[index] {
            continue;
        }
        if !wanted {
            grabber.ungrab(index);
            grabbed[index] = false;
            continue;
        }
        let mut result = grabber.grab(index);
        for _ in 0..20 {
            if result.is_ok() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
            result = grabber.grab(index);
        }
        match result {
            Ok(()) => grabbed[index] = true,
            Err(error) => errors.push(format!("{} is unavailable ({error})", key.label)),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
