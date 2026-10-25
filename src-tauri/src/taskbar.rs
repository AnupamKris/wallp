//! Floating dock: never registers an AppBar or reserves desktop space.
use serde::Serialize;
use std::{os::windows::process::CommandExt, path::PathBuf, process::Command, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint},
        System::Threading::{INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
        UI::{Shell::*, WindowsAndMessaging::*},
    },
    core::{BOOL, PCWSTR, w},
};

const LABEL: &str = "taskbar";
const HEIGHT: i32 = 88;
#[derive(Default)]
pub struct Taskbar(pub Mutex<State>);
#[derive(Default)]
pub struct State {
    enabled: bool,
    width: i32,
    last_hover: Option<std::time::Instant>,
    original: Option<u32>,
    helper: Option<std::process::Child>,
}
fn data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        ..Default::default()
    }
}
fn journal() -> PathBuf {
    std::env::temp_dir().join(format!("wallp-taskbar-{}.json", std::process::id()))
}
fn native_bar() -> Option<HWND> {
    unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok() }
}
fn set_native(state: u32, visible: bool) {
    if let Some(hwnd) = native_bar() {
        unsafe {
            let mut d = data(hwnd);
            if SHAppBarMessage(ABM_GETSTATE, &mut d) as u32 != state {
                d.lParam = LPARAM(state as isize);
                SHAppBarMessage(ABM_SETSTATE, &mut d);
            }
            let _ = ShowWindow(hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
    }
}
fn position(hwnd: HWND, width: i32) -> Result<(), String> {
    unsafe {
        let monitor = MonitorFromPoint(Default::default(), MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("Couldn't locate the primary monitor".into());
        }
        let scale = windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) as i32;
        let height = HEIGHT * scale / 96;
        let width =
            (width.max(160) * scale / 96).min(info.rcMonitor.right - info.rcMonitor.left - 32);
        let left = info.rcMonitor.left + (info.rcMonitor.right - info.rcMonitor.left - width) / 2;
        let top = info.rcMonitor.bottom - height - 8 * scale / 96;
        let after = if crate::desktop::fullscreen_app_running() {
            HWND_BOTTOM
        } else {
            HWND_TOPMOST
        };
        SetWindowPos(hwnd, Some(after), left, top, width, height, SWP_NOACTIVATE)
            .map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub fn resize_dock(app: AppHandle, window: tauri::WebviewWindow, width: i32) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only the dock can resize itself".into());
    }
    let width = width.clamp(160, 2000);
    app.state::<Taskbar>().0.lock().unwrap().width = width;
    position(window.hwnd().map_err(|e| e.to_string())?, width)
}

#[tauri::command]
pub fn taskbar_supported() -> bool {
    true
}
#[tauri::command]
pub fn taskbar_enabled(app: AppHandle) -> bool {
    app.state::<Taskbar>().0.lock().unwrap().enabled
}
#[tauri::command]
pub async fn set_taskbar_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(if enabled {
            create_bar(&handle).map(|_| true)
        } else {
            restore(&handle);
            Ok(false)
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}
pub fn create_bar(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=taskbar".into()),
    )
    .title("wallp bar")
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .focused(false)
    .inner_size(780., HEIGHT as f64)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn taskbar_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only the bar can register itself".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = ready_inner(&handle, &window);
        if let Err(ref error) = result {
            restore(&handle);
            let _ = handle.emit("taskbar://error", error);
        }
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}
fn ready_inner(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only the bar can register itself".into());
    }
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    if state.enabled {
        return Ok(());
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let native =
        native_bar().ok_or("Windows taskbar isn't available yet. Try enabling the bar again.")?;
    let original = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut data(native)) as u32 };
    state.original = Some(original);
    // Recovery runs outside Tauri and survives a crash or forced termination.
    std::fs::write(journal(), original.to_string()).map_err(|e| e.to_string())?;
    if state
        .helper
        .as_mut()
        .is_none_or(|child| child.try_wait().ok().flatten().is_some())
    {
        state.helper = Some(
            Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args(["--wallp-taskbar-recovery", &std::process::id().to_string()])
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| e.to_string())?,
        );
    }
    let result = (|| {
        set_native(original | ABS_AUTOHIDE, false);
        position(hwnd, if state.width > 0 { state.width } else { 160 })?;
        position(hwnd, if state.width > 0 { state.width } else { 160 })?;
        Ok(())
    })();
    if let Err(error) = result {
        return Err(error);
    }
    state.enabled = true;
    drop(state);
    let _ = app.emit("taskbar://enabled", true);
    Ok(())
}
pub fn restore(app: &AppHandle) {
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    state.enabled = false;
    state.last_hover = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    if let Some(original) = state.original.take() {
        set_native(original, true);
    }
    let _ = std::fs::remove_file(journal());
    drop(state);
    let _ = app.emit("taskbar://enabled", false);
}
pub fn tick(app: &AppHandle) {
    let enabled = app.state::<Taskbar>().0.lock().unwrap().enabled;
    if !enabled {
        return;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Ok(hwnd) = window.hwnd() {
            let binding = app.state::<Taskbar>();
            let mut state = binding.0.lock().unwrap();
            if state
                .helper
                .as_mut()
                .is_none_or(|child| !matches!(child.try_wait(), Ok(None)))
            {
                drop(state);
                restore(app);
                let _ = app.emit(
                    "taskbar://error",
                    "The recovery process stopped. Windows taskbar has been restored.",
                );
                return;
            }
            let width = state.width.max(160);
            drop(state);
            if let Some(original) = app.state::<Taskbar>().0.lock().unwrap().original {
                set_native(original | ABS_AUTOHIDE, false);
            }
            let _ = position(hwnd, width);
        }
    } else {
        restore(app);
    }
}

/// Poll the actual screen edge even while the webview is hidden.
/// A hidden native window cannot receive DOM mouse-enter events.
pub fn spawn_dock_hover(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(70));
            if !app.state::<Taskbar>().0.lock().unwrap().enabled {
                continue;
            }
            let handle = app.clone();
            if app
                .run_on_main_thread(move || update_hover(&handle))
                .is_err()
            {
                break;
            }
        }
    });
}
fn update_hover(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    if !state.enabled {
        return;
    }
    unsafe {
        let mut cursor = Default::default();
        if GetCursorPos(&mut cursor).is_err() {
            return;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(
            MonitorFromPoint(Default::default(), MONITOR_DEFAULTTOPRIMARY),
            &mut info,
        )
        .as_bool()
        {
            return;
        }
        let mut rect = Default::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return;
        }
        let visible = IsWindowVisible(hwnd).as_bool();
        let edge = cursor.x >= info.rcMonitor.left
            && cursor.x < info.rcMonitor.right
            && cursor.y >= info.rcMonitor.bottom - 4
            && cursor.y < info.rcMonitor.bottom;
        // Include the gap below the floating dock so it stays reachable from the edge.
        let over = visible
            && cursor.x >= rect.left
            && cursor.x < rect.right
            && cursor.y >= rect.top
            && cursor.y < info.rcMonitor.bottom;
        let fullscreen = crate::desktop::fullscreen_app_running();
        if !fullscreen && (edge || over) {
            state.last_hover = Some(std::time::Instant::now());
            if !visible {
                let _ = position(hwnd, state.width.max(160));
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        } else if visible
            && (fullscreen
                || state
                    .last_hover
                    .is_none_or(|time| time.elapsed() >= std::time::Duration::from_millis(350)))
        {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// Called before Tauri/single-instance setup in the recovery process.
pub fn recovery_entry() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--wallp-taskbar-recovery") {
        return false;
    }
    if let Some(pid) = args.get(2).and_then(|v| v.parse::<u32>().ok()) {
        if let Ok(process) = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
            unsafe {
                WaitForSingleObject(process, INFINITE);
                let _ = CloseHandle(process);
            }
        }
        let path = std::env::temp_dir().join(format!("wallp-taskbar-{pid}.json"));
        if let Ok(value) = std::fs::read_to_string(&path) {
            if let Ok(state) = value.parse::<u32>() {
                set_native(state, true);
            }
            let _ = std::fs::remove_file(path);
        }
    }
    true
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindow {
    id: String,
    pid: u32,
    title: String,
    active: bool,
    minimized: bool,
    icon: Option<String>,
}
fn windows() -> Vec<AppWindow> {
    unsafe extern "system" fn visit(hwnd: HWND, out: LPARAM) -> BOOL {
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if pid == std::process::id()
                || !IsWindowVisible(hwnd).as_bool()
                || ex & WS_EX_TOOLWINDOW.0 != 0
                || GetWindow(hwnd, GW_OWNER).is_ok()
            {
                return true.into();
            }
            let mut cloaked = 0u32;
            let _ = windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(
                hwnd,
                windows::Win32::Graphics::Dwm::DWMWA_CLOAKED,
                &mut cloaked as *mut _ as _,
                4,
            );
            if cloaked != 0 {
                return true.into();
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return true.into();
            }
            let mut title = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut title);
            let mut class = [0u16; 64];
            let c = GetClassNameW(hwnd, &mut class);
            let class = String::from_utf16_lossy(&class[..c as usize]);
            if [
                "Progman",
                "WorkerW",
                "Shell_TrayWnd",
                "Shell_SecondaryTrayWnd",
            ]
            .contains(&class.as_str())
            {
                return true.into();
            }
            (*(out.0 as *mut Vec<AppWindow>)).push(AppWindow {
                id: (hwnd.0 as usize).to_string(),
                pid,
                title: String::from_utf16_lossy(&title[..n as usize]),
                active: GetForegroundWindow() == hwnd,
                minimized: IsIconic(hwnd).as_bool(),
                icon: app_icon(pid),
            });
            true.into()
        }
    }
    let mut list = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut list as *mut _ as isize));
    }
    list
}
#[tauri::command]
pub fn list_app_windows() -> Vec<AppWindow> {
    windows()
}
#[tauri::command]
pub fn activate_app_window(id: String, pid: u32) -> Result<(), String> {
    let entry = windows()
        .into_iter()
        .find(|w| w.id == id && w.pid == pid)
        .ok_or("That window has closed. Refresh and try again.")?;
    let hwnd = HWND(entry.id.parse::<usize>().map_err(|e| e.to_string())? as *mut _);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            return Err("Windows couldn't focus this window. Try again or use Alt+Tab.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn show_wallp_desktop(app: AppHandle, workspace: bool) -> Result<(), String> {
    let desktop = app
        .get_webview_window("desktop")
        .ok_or("The desktop is reconnecting. Try again shortly.")?;
    for window in windows() {
        if let Ok(id) = window.id.parse::<usize>() {
            unsafe {
                let _ = ShowWindowAsync(HWND(id as *mut _), SW_MINIMIZE);
            }
        }
    }
    app.emit("taskbar://workspace", workspace)
        .map_err(|e| e.to_string())?;
    desktop.set_focus().map_err(|e| e.to_string())
}
// Read the executable icon once per path; polling never repeatedly decodes it.
fn app_icon(pid: u32) -> Option<String> {
    use base64::Engine;
    use std::{collections::HashMap, sync::OnceLock};
    use windows::{
        Win32::{Graphics::Gdi::*, System::Threading::*},
        core::PWSTR,
    };
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = vec![0u16; 32768];
        let mut len = path.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        path.truncate(len as usize);
        let key = String::from_utf16_lossy(&path).to_lowercase();
        let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
        if let Some(icon) = cache.get(&key) {
            return icon.clone();
        }
        path.push(0);
        let mut icon = HICON::default();
        let value = (|| {
            if ExtractIconExW(PCWSTR(path.as_ptr()), 0, Some(&mut icon), None, 1) == 0
                || icon.is_invalid()
            {
                return None;
            }
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                let _ = DestroyIcon(icon);
                return None;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: 32,
                    biHeight: -32,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            {
                Ok(bitmap) => bitmap,
                Err(_) => {
                    let _ = DeleteDC(dc);
                    let _ = DestroyIcon(icon);
                    return None;
                }
            };
            let old = SelectObject(dc, bitmap.into());
            std::ptr::write_bytes(bits, 0, 32 * 32 * 4);
            let drawn = DrawIconEx(dc, 0, 0, icon, 32, 32, 0, None, DI_NORMAL).is_ok();
            let _ = GdiFlush();
            let mut rgba = std::slice::from_raw_parts(bits as *const u8, 32 * 32 * 4).to_vec();
            let _ = SelectObject(dc, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            let _ = DestroyIcon(icon);
            if !drawn {
                return None;
            }
            let has_alpha = rgba.chunks_exact(4).any(|p| p[3] != 0);
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2);
                if !has_alpha {
                    pixel[3] = 255;
                }
                // DrawIconEx supplies premultiplied color; PNG needs straight alpha.
                else if pixel[3] > 0 {
                    for i in 0..3 {
                        pixel[i] = ((pixel[i] as u32 * 255) / pixel[3] as u32).min(255) as u8;
                    }
                }
            }
            let mut bytes = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut bytes, 32, 32);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
            }
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })();
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, value.clone());
        value
    }
}
