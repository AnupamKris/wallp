//! Only aggregate activity reaches Home: no key codes, text, or input history.
use serde::Serialize;
use std::{
    sync::{Once, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
    time::{Duration, Instant},
};
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, POINT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetCursorPos, MSG, PM_REMOVE, PeekMessageW,
        SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_SYSKEYDOWN,
    },
};

static START: Once = Once::new();
static CLOCK: OnceLock<Instant> = OnceLock::new();
static ENABLED_UNTIL: AtomicU64 = AtomicU64::new(0);
static PRESSES: AtomicU64 = AtomicU64::new(0);
static FAILED: AtomicBool = AtomicBool::new(false);

fn elapsed() -> u64 { CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64 }

unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && ENABLED_UNTIL.load(Ordering::Relaxed) > elapsed()
        && matches!(message.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN)
    {
        // Deliberately do not inspect the keyboard event's data.
        PRESSES.fetch_add(1, Ordering::Relaxed);
    }
    unsafe { CallNextHookEx(None, code, message, data) }
}

fn spawn() {
    thread::spawn(|| {
        let mut hook = None;
        loop {
            let enabled = ENABLED_UNTIL.load(Ordering::Relaxed) > elapsed();
            if enabled && hook.is_none() {
                let installed = unsafe {
                    GetModuleHandleW(None).and_then(|module|
                        SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module.into()), 0))
                };
                match installed {
                    Ok(value) => { hook = Some(value); FAILED.store(false, Ordering::Relaxed); }
                    Err(_) => { FAILED.store(true, Ordering::Relaxed); thread::sleep(Duration::from_millis(500)); }
                }
            } else if !enabled {
                if let Some(value) = hook.take() { let _ = unsafe { UnhookWindowsHookEx(value) }; }
            }
            let mut message = MSG::default();
            while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
                unsafe { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
            }
            thread::sleep(Duration::from_millis(if enabled { 8 } else { 100 }));
        }
    });
}

#[derive(Serialize)]
pub struct Activity { x: i32, y: i32, presses: u64 }

#[tauri::command]
pub fn desk_buddy_activity(window: WebviewWindow, enabled: bool) -> Result<Activity, String> {
    if window.label() != "desktop" { return Err("Desk buddy is only available on Home.".into()); }
    // Lease ensures a closed/crashed webview also stops keyboard observation.
    ENABLED_UNTIL.store(if enabled { elapsed() + 1000 } else { 0 }, Ordering::Relaxed);
    if enabled { START.call_once(spawn); }
    let mut position = POINT::default();
    if enabled {
        unsafe { GetCursorPos(&mut position) }.map_err(|_| "Mouse activity unavailable".to_string())?;
        if FAILED.load(Ordering::Relaxed) { return Err("Keyboard activity unavailable".into()); }
    }
    Ok(Activity { x: position.x, y: position.y, presses: PRESSES.load(Ordering::Relaxed) })
}
