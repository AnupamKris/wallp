//! Background Gmail polling and a separate topmost window, independent of desktop visibility.
use crate::{email_codes, email_digest::now_ms, gmail};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::{
    Foundation::{HWND, RECT},
    UI::WindowsAndMessaging::*,
};

const LABEL: &str = "email-code";
const EVENT: &str = "email-code://changed";
const MAX_AGE: i64 = 120_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeNotification {
    id: String,
    sender: String,
    email: String,
    subject: String,
    code: String,
    date: i64,
}

#[derive(Default)]
pub struct Notifications {
    queue: Mutex<VecDeque<CodeNotification>>,
}

fn check_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("Only the code notification can use this action.".into())
    }
}

fn set_native_visibility(hwnd: HWND, visible: bool) {
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
}

/// Runs on the main thread. Showing with SW_SHOWNOACTIVATE preserves the user's typing focus.
fn present(app: &AppHandle) {
    let state = app.state::<Notifications>();
    let mut queue = state.queue.lock().unwrap();
    queue.retain(|item| now_ms() - item.date < MAX_AGE);
    let current = queue.front().cloned();
    drop(queue);
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if current.is_none() {
        // Showing through Win32 leaves Tauri's cached visibility set to hidden.
        // Hide through the same API, before clearing the webview content.
        if let Ok(hwnd) = window.hwnd() {
            set_native_visibility(hwnd, false);
        }
    }
    if let Err(error) = window.emit(EVENT, &current) {
        eprintln!("wallp: couldn't update code notification: {error}");
    }
    let Some(item) = current else {
        return;
    };
    if let Ok(hwnd) = window.hwnd() {
        // Use the work area of the monitor containing the foreground application.
        unsafe {
            use windows::Win32::Graphics::Gdi::{
                GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
            };
            let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                let RECT {
                    left, top, right, ..
                } = info.rcWork;
                let scale = window.scale_factor().unwrap_or(1.0);
                let width = ((400.0 * scale) as i32).min(right - left);
                let height = (176.0 * scale) as i32;
                let gap = (16.0 * scale) as i32;
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    (right - width - gap).max(left),
                    top + gap,
                    width,
                    height,
                    SWP_NOACTIVATE,
                );
            }
            set_native_visibility(hwnd, true);
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(25)).await;
        dismiss(&handle, &item.id);
    });
}

fn dismiss(app: &AppHandle, id: &str) {
    let handle = app.clone();
    let id = id.to_owned();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<Notifications>();
        let mut queue = state.queue.lock().unwrap();
        // A stale timer or click must never dismiss a newer code.
        if !queue.front().is_some_and(|item| item.id == id) {
            return;
        }
        queue.pop_front();
        drop(queue);
        present(&handle);
    });
}

pub fn clear(app: &AppHandle) {
    app.state::<Notifications>().queue.lock().unwrap().clear();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || present(&handle));
}

#[tauri::command]
pub async fn email_code_ready(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    check_window(&window)?;
    let handle = app.clone();
    app.run_on_main_thread(move || present(&handle))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn email_code_dismiss(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    check_window(&window)?;
    dismiss(&app, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;

    #[test]
    fn hides_externally_shown_window_and_can_show_it_again() {
        // Off-screen native window: reproduce showing outside Tauri's visibility cache.
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("wallp notification test"),
                WS_POPUP,
                -32000,
                -32000,
                2,
                2,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            assert!(!IsWindowVisible(hwnd).as_bool());
            for _ in 0..2 {
                set_native_visibility(hwnd, true);
                assert!(IsWindowVisible(hwnd).as_bool());
                set_native_visibility(hwnd, false);
                assert!(
                    !IsWindowVisible(hwnd).as_bool(),
                    "The empty notification must not remain visible"
                );
            }
            let _ = DestroyWindow(hwnd);
        }
    }
}

#[tauri::command]
pub fn email_code_copy(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    check_window(&window)?;
    let state = app.state::<Notifications>();
    let queue = state.queue.lock().unwrap();
    let item = queue
        .front()
        .filter(|item| item.id == id && now_ms() - item.date < MAX_AGE)
        .ok_or("This code notification has expired.")?;
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(item.code.clone()))
        .map_err(|e| format!("Couldn't copy code: {e}"))
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=email-code".into()),
    )
    .title("wallp verification code")
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .always_on_top(true)
    .inner_size(400., 176.)
    .visible(false)
    .focused(false)
    .build()?;
    window.on_window_event({
        let handle = app.clone();
        move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                clear(&handle);
            }
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut account = gmail::account_email().unwrap_or_default();
        let mut baseline = now_ms();
        let mut seen = HashMap::<String, i64>::new();
        let mut failures = 0u32;
        loop {
            let last_check = now_ms();
            // Bounded backoff for offline/expired credentials; no overlapping requests.
            tokio::time::sleep(Duration::from_secs(
                (10 * (1u64 << failures.min(3))).min(60),
            ))
            .await;
            let current = gmail::account_email().unwrap_or_default();
            if current != account {
                clear(&handle);
                account = current;
                baseline = last_check;
                seen.clear();
                failures = 0;
                continue;
            }
            if account.is_empty() {
                continue;
            }
            let through = now_ms();
            seen.retain(|_, date| through - *date < MAX_AGE + 10_000);
            let known: HashSet<String> = seen.keys().cloned().collect();
            // Overlap covers Gmail indexing delays, while the baseline suppresses old OTPs on launch.
            let result =
                gmail::received_messages(baseline.max(through - MAX_AGE), through, false, &known)
                    .await;
            let Ok(mut messages) = result else {
                failures = failures.saturating_add(1);
                if failures == 1 {
                    eprintln!("wallp: code notification email check failed; retrying with backoff");
                }
                continue;
            };
            failures = 0;
            if gmail::account_email().ok().as_deref() != Some(account.as_str()) {
                continue;
            }
            messages.sort_by_key(|m| m.date);
            let mut notifications = Vec::new();
            for message in messages {
                seen.insert(message.id.clone(), message.date);
                let html_text = message.body_html.as_deref().map(email_codes::html_text);
                let body = message
                    .body
                    .as_deref()
                    .filter(|text| !text.trim().is_empty())
                    .or(html_text.as_deref());
                if let Some(code) = email_codes::extract(&message.subject, &message.snippet, body) {
                    notifications.push(CodeNotification {
                        id: message.id,
                        sender: message
                            .from
                            .name
                            .unwrap_or_else(|| message.from.email.clone()),
                        email: message.from.email,
                        subject: message.subject,
                        code,
                        date: message.date,
                    });
                }
            }
            if notifications.is_empty() {
                continue;
            }
            let app = handle.clone();
            let expected_account = account.clone();
            let _ = handle.run_on_main_thread(move || {
                // Disconnect may have happened after the network request completed.
                if gmail::account_email().ok().as_deref() != Some(expected_account.as_str()) {
                    return;
                }
                let state = app.state::<Notifications>();
                let mut queue = state.queue.lock().unwrap();
                let was_empty = queue.is_empty();
                for item in notifications {
                    if queue.len() < 5 {
                        queue.push_back(item);
                    }
                }
                drop(queue);
                if was_empty {
                    present(&app);
                }
            });
        }
    });
    Ok(())
}
