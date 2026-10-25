//! Non-activating controller panels: the target application keeps keyboard focus.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::{
    Foundation::HWND,
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

const LABEL: &str = "controller-overlay";
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub id: u64,
    pub kind: String,
    pub title: String,
    pub active: bool,
    #[serde(skip)]
    target: isize,
    #[serde(skip)]
    expires: Option<Instant>,
}
#[derive(Default)]
pub struct Overlay(pub Mutex<View>);
impl View {
    fn clear(&mut self) {
        self.id = self.id.wrapping_add(1);
        self.kind.clear();
        self.title.clear();
        self.target = 0;
        self.expires = None;
    }
    fn expire(&mut self, now: Instant) -> bool {
        if self.expires.is_some_and(|time| now >= time) {
            self.clear();
            true
        } else {
            false
        }
    }
}
fn hide_empty(hwnd: HWND, view: &View) -> bool {
    if view.kind.is_empty() {
        visible(hwnd, false);
        true
    } else {
        false
    }
}

pub fn interactive(app: &AppHandle) -> bool {
    matches!(
        app.state::<Overlay>().0.lock().unwrap().kind.as_str(),
        "confirm" | "keyboard"
    )
}
pub fn keyboard_open(app: &AppHandle) -> bool {
    app.state::<Overlay>().0.lock().unwrap().kind == "keyboard"
}
pub(crate) fn visible(hwnd: HWND, show: bool) {
    unsafe {
        let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
}
fn present(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let view = handle.state::<Overlay>().0.lock().unwrap().clone();
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        hide_empty(hwnd, &view);
        let _ = window.emit("controller-overlay://view", &view);
        if view.kind.is_empty() {
            return;
        }
        unsafe {
            use windows::Win32::Graphics::Gdi::{
                GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
            };
            let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO {
                cbSize: size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if GetMonitorInfoW(monitor, &mut info).as_bool() {
                let area = info.rcWork;
                let scale = window.scale_factor().unwrap_or(1.0);
                let (width, height) = match view.kind.as_str() {
                    "keyboard" => (900.0, 390.0),
                    "confirm" => (480.0, 264.0),
                    _ => (460.0, if view.active { 150.0 } else { 104.0 }),
                };
                let width = ((width * scale) as i32).min(area.right - area.left);
                let height = ((height * scale) as i32).min(area.bottom - area.top);
                let x = area.left + (area.right - area.left - width) / 2;
                let y = if view.kind == "confirm" {
                    area.top + (area.bottom - area.top - height) / 2
                } else {
                    (area.bottom - height - (24.0 * scale) as i32).max(area.top)
                };
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE,
                );
            }
        }
        visible(hwnd, true);
    });
}
fn update(
    app: &AppHandle,
    kind: &str,
    title: String,
    active: bool,
    target: isize,
    timeout: Option<Duration>,
) {
    let state = app.state::<Overlay>();
    let mut view = state.0.lock().unwrap();
    *view = View {
        id: view.id.wrapping_add(1),
        kind: kind.into(),
        title,
        active,
        target,
        expires: timeout.map(|d| Instant::now() + d),
    };
    drop(view);
    present(app);
}
pub fn hide(app: &AppHandle) {
    update(app, "", String::new(), false, 0, None);
}
pub fn feedback(app: &AppHandle, active: bool) {
    update(
        app,
        "toast",
        if active {
            "Controller mouse on"
        } else {
            "Controller mouse off"
        }
        .into(),
        active,
        0,
        Some(Duration::from_secs(3)),
    );
}
pub fn expire(app: &AppHandle) {
    let state = app.state::<Overlay>();
    let mut view = state.0.lock().unwrap();
    if view.expire(Instant::now()) {
        drop(view);
        present(app);
    }
}
fn target() -> (isize, String) {
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut title = [0u16; 512];
        let length = GetWindowTextW(hwnd, &mut title);
        (
            hwnd.0 as isize,
            String::from_utf16_lossy(&title[..length.max(0) as usize]),
        )
    }
}
pub fn open(app: &AppHandle, kind: &str) {
    if allowed(app).is_err() {
        return;
    }
    let keyboard_open = app.state::<Overlay>().0.lock().unwrap().kind == "keyboard";
    if kind == "keyboard" && keyboard_open {
        hide(app);
        return;
    }
    let (hwnd, title) = target();
    update(
        app,
        kind,
        if title.is_empty() {
            "Current application".into()
        } else {
            title
        },
        true,
        hwnd,
        if kind == "confirm" {
            Some(Duration::from_secs(30))
        } else {
            None
        },
    );
}
pub fn navigate(app: &AppHandle, action: &str) {
    if action == "back" {
        hide(app);
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit("controller-overlay://input", action);
    }
}
fn check(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("This action belongs to the controller overlay.".into());
    }
    Ok(())
}
fn allowed(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<crate::controller_mouse::ControllerMouse>();
    let status = state.0.lock().unwrap();
    if !status.enabled || !status.active {
        return Err("Turn on controller mouse mode first.".into());
    }
    Ok(())
}
fn validate_target(view: &View) -> Result<(), String> {
    if view.target == 0 || unsafe { GetForegroundWindow().0 as isize } != view.target {
        return Err("The active application changed. Dismiss this panel and open it again over the application you want to control.".into());
    }
    Ok(())
}
pub(crate) fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                ..Default::default()
            },
        },
    }
}
fn send_keys(inputs: &[INPUT], releases: &[INPUT]) -> Result<(), String> {
    if unsafe { SendInput(inputs, size_of::<INPUT>() as i32) } != inputs.len() as u32 {
        unsafe {
            SendInput(releases, size_of::<INPUT>() as i32);
        }
        return Err(
            "Windows blocked input to this app. Try a physical keyboard for elevated apps.".into(),
        );
    }
    Ok(())
}
pub(crate) fn shortcut(modifier: VIRTUAL_KEY, code: VIRTUAL_KEY) -> Result<(), String> {
    if [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|k| unsafe { GetAsyncKeyState(k.0 as i32) < 0 })
    {
        return Err("Release the keyboard modifier keys and try again.".into());
    }
    send_keys(
        &[
            key(modifier, false),
            key(code, false),
            key(code, true),
            key(modifier, true),
        ],
        &[key(code, true), key(modifier, true)],
    )
}
#[tauri::command]
pub fn controller_overlay_ready(app: AppHandle, window: WebviewWindow) -> Result<View, String> {
    check(&window)?;
    present(&app);
    Ok(app.state::<Overlay>().0.lock().unwrap().clone())
}
#[tauri::command]
pub fn controller_overlay_dismiss(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
) -> Result<(), String> {
    check(&window)?;
    let state = app.state::<Overlay>();
    let mut view = state.0.lock().unwrap();
    if view.id == id {
        view.clear();
        drop(view);
        present(&app);
    }
    Ok(())
}
#[tauri::command]
pub fn controller_overlay_confirm(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
) -> Result<(), String> {
    check(&window)?;
    allowed(&app)?;
    let state = app.state::<Overlay>();
    let mut view = state.0.lock().unwrap();
    if view.kind != "confirm" || view.id != id || view.expires.is_none_or(|t| Instant::now() >= t) {
        return Err("This confirmation expired.".into());
    }
    validate_target(&view)?;
    // Reject a changed foreground app instead of restoring focus behind the user's back.
    shortcut(VK_MENU, VK_F4)?;
    // Consume under the lock so concurrent clicks cannot send Alt+F4 twice.
    view.clear();
    drop(view);
    present(&app);
    Ok(())
}
fn text_inputs(text: &str) -> Vec<INPUT> {
    text.encode_utf16()
        .flat_map(|unit| {
            [false, true].map(|up| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wScan: unit,
                        dwFlags: KEYEVENTF_UNICODE
                            | if up {
                                KEYEVENTF_KEYUP
                            } else {
                                KEYBD_EVENT_FLAGS(0)
                            },
                        ..Default::default()
                    },
                },
            })
        })
        .collect()
}
#[tauri::command]
pub fn controller_overlay_key(
    app: AppHandle,
    window: WebviewWindow,
    id: u64,
    text: Option<String>,
    special: Option<String>,
) -> Result<(), String> {
    check(&window)?;
    allowed(&app)?;
    let view = app.state::<Overlay>().0.lock().unwrap().clone();
    if view.kind != "keyboard" || view.id != id {
        return Err("Open the controller keyboard first.".into());
    }
    validate_target(&view)?;
    if let Some(text) = text {
        if text.chars().count() != 1 || text.chars().any(char::is_control) {
            return Err("Choose a key from the keyboard.".into());
        }
        let inputs = text_inputs(&text);
        let releases: Vec<_> = inputs.iter().skip(1).step_by(2).copied().collect();
        return send_keys(&inputs, &releases);
    }
    let code = match special.as_deref() {
        Some("Backspace") => VK_BACK,
        Some("Enter") => VK_RETURN,
        Some("Tab") => VK_TAB,
        Some("Left") => VK_LEFT,
        Some("Right") => VK_RIGHT,
        Some("Escape") => VK_ESCAPE,
        _ => return Err("Unknown keyboard key.".into()),
    };
    send_keys(&[key(code, false), key(code, true)], &[key(code, true)])
}
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Overlay::default());
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=controller-overlay".into()),
    )
    .title("wallp controller controls")
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .always_on_top(true)
    .inner_size(900., 390.)
    .visible(false)
    .focused(false)
    .build()?;
    unsafe {
        let hwnd = window.hwnd()?;
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
    }
    window.on_window_event({
        let app = app.clone();
        move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide(&app);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_keys_have_matched_releases_including_surrogates() {
        let inputs = text_inputs("🙂");
        assert_eq!(inputs.len(), 4);
        for pair in inputs.chunks(2) {
            unsafe {
                assert_eq!(pair[0].Anonymous.ki.wScan, pair[1].Anonymous.ki.wScan);
                assert_eq!(pair[0].Anonymous.ki.dwFlags, KEYEVENTF_UNICODE);
                assert_eq!(
                    pair[1].Anonymous.ki.dwFlags,
                    KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
                );
            }
        }
    }
    #[test]
    fn native_dismiss_really_hides_a_nonactivating_window() {
        use windows::core::w;
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("controller overlay test"),
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
            for kind in ["toast", "confirm", "keyboard"] {
                let mut view = View {
                    kind: kind.into(),
                    title: "App title".into(),
                    target: 42,
                    ..Default::default()
                };
                visible(hwnd, true);
                assert!(IsWindowVisible(hwnd).as_bool());
                view.clear();
                assert!(hide_empty(hwnd, &view));
                assert!(!IsWindowVisible(hwnd).as_bool());
                assert!(view.title.is_empty());
                assert_eq!(view.target, 0);
            }
            for kind in ["toast", "confirm"] {
                let now = Instant::now();
                let mut view = View {
                    kind: kind.into(),
                    expires: Some(now + Duration::from_secs(3)),
                    ..Default::default()
                };
                visible(hwnd, true);
                assert!(!view.expire(now));
                assert!(!hide_empty(hwnd, &view));
                assert!(IsWindowVisible(hwnd).as_bool());
                assert!(view.expire(now + Duration::from_secs(3)));
                assert!(hide_empty(hwnd, &view));
                assert!(!IsWindowVisible(hwnd).as_bool());
            }
            let _ = DestroyWindow(hwnd);
        }
    }
    #[test]
    fn missing_target_is_rejected_before_any_input_is_sent() {
        assert!(validate_target(&View::default()).is_err());
    }
}
