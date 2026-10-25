//! App-only launcher and persistent text/image clipboard. No filesystem search.
use crate::clipboard_history::{Content, History, Page};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::{
    os::windows::process::CommandExt, process::Command, sync::atomic::AtomicU32, time::Duration,
};
use std::{
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(windows)]
use windows::{
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, WPARAM},
        System::{DataExchange::*, Memory::*, Threading::GetCurrentThreadId},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
    core::w,
};

const LABEL: &str = "launcher";
const TEXT_LIMIT: usize = 100_000;
#[cfg(windows)]
const INPUT_TAG: usize = 0x57414c50;
static READY: AtomicBool = AtomicBool::new(false);
static CAPTURE: AtomicBool = AtomicBool::new(true);
#[cfg(windows)]
static HOTKEY_THREAD: AtomicU32 = AtomicU32::new(0);
static CTRL_SPACE: AtomicBool = AtomicBool::new(true);
static SHADCN_COMMAND: AtomicBool = AtomicBool::new(false);
static EXPANDED: AtomicBool = AtomicBool::new(false);
static OPEN: OnceLock<mpsc::Sender<&'static str>> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    ctrl_space: bool,
    clipboard: bool,
    shadcn_command: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            ctrl_space: true,
            clipboard: true,
            shadcn_command: false,
        }
    }
}
#[derive(Default)]
pub struct Launcher {
    apps: Mutex<Vec<InstalledApp>>,
    refreshing: AtomicBool,
    history: Mutex<Option<History>>,
    /// The window and process to paste into.
    #[cfg(windows)]
    target: Mutex<(usize, u32)>,
    mode: Mutex<String>,
    shortcut_error: Mutex<Option<String>>,
}
fn data_path(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(path) = data_path(app, "launcher-apps.json") {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(mut apps) = serde_json::from_slice::<Vec<InstalledApp>>(&bytes) {
                apps.retain(is_application);
                *app.state::<Launcher>().apps.lock().unwrap() = apps;
            }
        }
    }
    if let Ok(path) = data_path(app, "launcher-preferences.json") {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(prefs) = serde_json::from_slice::<Preferences>(&bytes) {
                CTRL_SPACE.store(prefs.ctrl_space, Ordering::Relaxed);
                CAPTURE.store(prefs.clipboard, Ordering::Relaxed);
                SHADCN_COMMAND.store(prefs.shadcn_command, Ordering::Relaxed);
            }
        }
    }
    *app.state::<Launcher>().history.lock().unwrap() = Some(History::open(&data_path(
        app,
        "clipboard-history.sqlite3",
    )?)?);
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=launcher".into()),
    )
    .title("wallp commands")
    .decorations(false)
    .skip_taskbar(true)
    .resizable(false)
    .always_on_top(true)
    .inner_size(720., 510.)
    .min_inner_size(360., 300.)
    .visible(false)
    .focused(false)
    .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Keep the webview and its pending AI turn alive on Alt+F4/native close.
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window(LABEL) {
                let _ = window.hide();
            }
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            READY.store(false, Ordering::Relaxed);
        }
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            if let Some(window) = handle.get_webview_window(LABEL) {
                // A queued blur from the previous hide may arrive after reopening.
                #[cfg(windows)]
                let blurred = window
                    .hwnd()
                    .is_ok_and(|hwnd| unsafe { GetForegroundWindow() } != hwnd);
                #[cfg(target_os = "linux")]
                let blurred = !window.is_focused().unwrap_or(false);
                if blurred {
                    let _ = window.hide();
                }
            }
        }
    });
    let (tx, rx) = mpsc::channel();
    let _ = OPEN.set(tx);
    let handle = app.clone();
    thread::spawn(move || {
        for mode in rx {
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Err(err) = show(&app, mode) {
                    eprintln!("wallp launcher: {err}");
                }
            });
        }
    });
    spawn_hotkey(app.clone());
    spawn_clipboard(app.clone());
    refresh_background(app.clone());
    Ok(())
}
fn refresh_background(app: AppHandle) {
    thread::spawn(move || {
        if let Err(error) = refresh_apps(&app) {
            let _ = app.emit("launcher://error", error);
        }
    });
}
fn is_application(app: &InstalledApp) -> bool {
    let id = app.id.to_ascii_lowercase();
    if id.is_empty()
        || app.name.trim().is_empty()
        || app.name.to_ascii_lowercase().starts_with("uninstall ")
    {
        return false;
    }
    if id.starts_with("http:") || id.starts_with("https:") || id.starts_with("file:") {
        return false;
    }
    if id.contains("://") {
        return [
            "steam://",
            "battlenet://",
            "uplay://",
            "com.epicgames.launcher://",
            "origin2://",
            "riotclient://",
        ]
        .iter()
        .any(|prefix| id.starts_with(prefix));
    }
    if id.contains(['\\', '/']) {
        return [".exe", ".com", ".msc", ".cpl", ".appref-ms"]
            .iter()
            .any(|ext| id.ends_with(ext));
    }
    // Registered app IDs (including packaged apps) are not filesystem paths.
    ![
        ".chm", ".url", ".html", ".htm", ".pdf", ".txt", ".ini", ".docx", ".xlsx",
    ]
    .iter()
    .any(|ext| id.ends_with(ext))
}
fn refresh_apps(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Launcher>();
    if state.refreshing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = (|| {
        let mut apps = installed_apps()?;
        apps.retain(is_application);
        apps.sort_by_cached_key(|a| a.name.to_lowercase());
        let mut ids = std::collections::HashSet::new();
        apps.retain(|app| ids.insert(app.id.clone()));
        #[cfg(windows)]
        populate_icons(&mut apps);
        std::fs::write(
            data_path(app, "launcher-apps.json")?,
            serde_json::to_vec(&apps).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        *state.apps.lock().unwrap() = apps.clone();
        let _ = app.emit("launcher://apps", apps);
        Ok(())
    })();
    state.refreshing.store(false, Ordering::SeqCst);
    result
}

/// GNOME's app grid entries, with icons resolved from the icon theme.
#[cfg(target_os = "linux")]
fn installed_apps() -> Result<Vec<InstalledApp>, String> {
    Ok(crate::linux::apps::installed())
}

#[cfg(windows)]
fn installed_apps() -> Result<Vec<InstalledApp>, String> {
    {
        // Only Start registrations are scanned. Filter help/document shortcuts that Windows also lists.
        let output = Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-StartApps | ForEach-Object { @{ id=$_.AppID; name=$_.Name } })"])
            .creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Couldn't refresh installed apps: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Couldn't read installed apps: {e}"))
    }
}

#[cfg(windows)]
fn populate_icons(apps: &mut [InstalledApp]) {
    use windows::Win32::System::Com::*;
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return;
        }
        for app in apps {
            app.icon = shell_icon(&format!("shell:AppsFolder\\{}", app.id), 32);
        }
        CoUninitialize();
    }
}

/// Render the shell icon for a parsing name (an AppsFolder ID or a file path) as a PNG data URL.
#[cfg(windows)]
pub(crate) fn shell_icon(parsing_name: &str, size: i32) -> Option<String> {
    use base64::Engine;
    use windows::{
        Win32::{Foundation::SIZE, Graphics::Gdi::*, UI::Shell::*},
        core::PCWSTR,
    };
    unsafe {
        let path: Vec<u16> = parsing_name
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None).ok()?;
        let bitmap = factory
            .GetImage(
                SIZE { cx: size, cy: size },
                SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
            )
            .ok()?;
        let mut object = BITMAP::default();
        if GetObjectW(
            bitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut object as *mut BITMAP).cast()),
        ) == 0
        {
            let _ = DeleteObject(bitmap.into());
            return None;
        }
        let width = object.bmWidth;
        let height = object.bmHeight.abs();
        if width <= 0 || height <= 0 || width > 512 || height > 512 {
            let _ = DeleteObject(bitmap.into());
            return None;
        }
        let dc = CreateCompatibleDC(None);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut rgba = vec![0u8; width as usize * height as usize * 4];
        let lines = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(rgba.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        let _ = DeleteObject(bitmap.into());
        if lines != height {
            return None;
        }
        let has_alpha = rgba.chunks_exact(4).any(|p| p[3] != 0);
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if !has_alpha {
                pixel[3] = 255;
            } else if pixel[3] > 0 {
                for i in 0..3 {
                    pixel[i] = ((pixel[i] as u32 * 255) / pixel[3] as u32).min(255) as u8;
                }
            }
        }
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
        }
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}
#[tauri::command]
pub fn launcher_apps(app: AppHandle) -> Vec<InstalledApp> {
    app.state::<Launcher>().apps.lock().unwrap().clone()
}
#[tauri::command]
pub async fn refresh_launcher_apps(app: AppHandle) -> Result<Vec<InstalledApp>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_apps(&app)?;
        Ok(launcher_apps(app))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn launcher_ready(app: AppHandle) -> String {
    READY.store(true, Ordering::Relaxed);
    app.state::<Launcher>().mode.lock().unwrap().clone()
}
fn show(app: &AppHandle, mode: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Command menu isn't ready")?;
    if !READY.load(Ordering::Relaxed) {
        return Err("Command menu is loading. Try again shortly.".into());
    }
    if mode == "apps" && window.is_visible().unwrap_or(false) {
        return window.hide().map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    let foreground = unsafe { GetForegroundWindow() };
    #[cfg(windows)]
    if window.hwnd().map_err(|e| e.to_string())? != foreground {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(foreground, Some(&mut pid));
        }
        *app.state::<Launcher>().target.lock().unwrap() = (foreground.0 as usize, pid);
    }
    *app.state::<Launcher>().mode.lock().unwrap() = mode.to_owned();
    let _ = size_launcher(&window, EXPANDED.load(Ordering::Relaxed));
    window.show().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    window.set_focus().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::linux::activate(&window)?;
    window
        .emit("launcher://open", mode)
        .map_err(|e| e.to_string())
}

fn size_launcher(window: &tauri::WebviewWindow, expanded: bool) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Could not determine the command menu's monitor.")?;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let (width, height) = if expanded {
        (1120f64, 860f64)
    } else {
        (720f64, 510f64)
    };
    let width = width.min((size.width as f64 / scale - 32.).max(320.));
    let height = height.min((size.height as f64 / scale - 80.).max(240.));
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // GTK's center() misplaces hidden windows, so place it ourselves.
    #[cfg(target_os = "linux")]
    {
        let origin = monitor.position();
        window
            .set_position(tauri::PhysicalPosition::new(
                origin.x + (size.width as f64 - width * scale) as i32 / 2,
                origin.y + (size.height as f64 - height * scale) as i32 / 2,
            ))
            .map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    window.center().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launcher_set_expanded(app: AppHandle, expanded: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Command menu unavailable")?;
    size_launcher(&window, expanded)?;
    EXPANDED.store(expanded, Ordering::Relaxed);
    Ok(expanded)
}
#[tauri::command]
pub fn open_launcher(app: AppHandle, mode: Option<String>) -> Result<(), String> {
    show(
        &app,
        match mode.as_deref() {
            Some("clipboard") => "clipboard",
            Some("capture") => "capture",
            _ => "apps",
        },
    )
}
#[tauri::command]
pub fn close_launcher(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(LABEL)
        .ok_or("Command menu unavailable")?
        .hide()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn launch_app(app: AppHandle, id: String) -> Result<(), String> {
    if !app
        .state::<Launcher>()
        .apps
        .lock()
        .unwrap()
        .iter()
        .any(|a| a.id == id)
    {
        return Err("App is no longer in the index. Refresh apps and try again.".into());
    }
    launch_registered_app(&id)?;
    close_launcher(app)
}

#[cfg(target_os = "linux")]
pub(crate) fn launch_registered_app(id: &str) -> Result<(), String> {
    crate::linux::apps::launch(id)
}

#[cfg(windows)]
pub(crate) fn launch_registered_app(id: &str) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{id}"))
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn launcher_search(app: AppHandle, engine: String, query: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base = match engine.as_str() {
        "g" => "https://www.google.com/search?q=",
        "y" => "https://www.youtube.com/results?search_query=",
        "d" => "https://duckduckgo.com/?q=",
        "w" => "https://en.wikipedia.org/w/index.php?search=",
        "gh" => "https://github.com/search?q=",
        "r" => "https://www.reddit.com/search/?q=",
        _ => return Err("Unknown search shortcut".into()),
    };
    let query = query.trim();
    if query.is_empty() {
        return Err("Type something to search for".into());
    }
    let encoded: String = query
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    app.opener()
        .open_url(format!("{base}{encoded}"), None::<&str>)
        .map_err(|e| e.to_string())?;
    close_launcher(app)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceStatus {
    ctrl_space: bool,
    clipboard: bool,
    shadcn_command: bool,
    shortcut_error: Option<String>,
}
#[tauri::command]
pub fn launcher_preferences(app: AppHandle) -> PreferenceStatus {
    PreferenceStatus {
        ctrl_space: CTRL_SPACE.load(Ordering::Relaxed),
        clipboard: CAPTURE.load(Ordering::Relaxed),
        shadcn_command: SHADCN_COMMAND.load(Ordering::Relaxed),
        shortcut_error: app
            .state::<Launcher>()
            .shortcut_error
            .lock()
            .unwrap()
            .clone(),
    }
}
#[tauri::command]
pub fn set_launcher_preferences(app: AppHandle, preferences: Preferences) -> Result<(), String> {
    std::fs::write(
        data_path(&app, "launcher-preferences.json")?,
        serde_json::to_vec(&preferences).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    CTRL_SPACE.store(preferences.ctrl_space, Ordering::Relaxed);
    #[cfg(windows)]
    {
        let thread_id = HOTKEY_THREAD.load(Ordering::Relaxed);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_APP, WPARAM(0), LPARAM(0));
            }
        }
    }
    #[cfg(target_os = "linux")]
    spawn_hotkey(app.clone());
    CAPTURE.store(preferences.clipboard, Ordering::Relaxed);
    SHADCN_COMMAND.store(preferences.shadcn_command, Ordering::Relaxed);
    let _ = app.emit("launcher://preferences", launcher_preferences(app.clone()));
    Ok(())
}

#[cfg(windows)]
fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                dwExtraInfo: INPUT_TAG,
                ..Default::default()
            },
        },
    }
}
fn request_open(mode: &'static str) {
    if let Some(tx) = OPEN.get() {
        let _ = tx.send(mode);
    }
}
#[cfg(windows)]
fn configure_ctrl_space(app: &AppHandle, registered: &mut bool) {
    if *registered {
        unsafe {
            let _ = UnregisterHotKey(None, 1);
        }
        *registered = false;
    }
    let error = if CTRL_SPACE.load(Ordering::Relaxed) {
        match unsafe { RegisterHotKey(None, 1, MOD_CONTROL | MOD_NOREPEAT, VK_SPACE.0 as u32) } {
            Ok(()) => {
                *registered = true;
                None
            }
            Err(error) => Some(format!(
                "Ctrl+Space is unavailable (another app may use it): {error}"
            )),
        }
    } else {
        None
    };
    *app.state::<Launcher>().shortcut_error.lock().unwrap() = error;
    let _ = app.emit("launcher://preferences", launcher_preferences(app.clone()));
}
#[cfg(windows)]
fn spawn_hotkey(app: AppHandle) {
    thread::spawn(move || unsafe {
        let mut msg = MSG::default();
        // All global shortcuts are owned by this message thread.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        HOTKEY_THREAD.store(GetCurrentThreadId(), Ordering::Relaxed);
        let mut registered = false;
        configure_ctrl_space(&app, &mut registered);
        let workspace_registered =
            match RegisterHotKey(None, 2, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, b'W' as u32) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("wallp: Ctrl+Alt+W is unavailable (another app may use it): {error}");
                    false
                }
            };
        let desktop_registered =
            match RegisterHotKey(None, 3, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, b'D' as u32) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("wallp: Ctrl+Alt+D is unavailable (another app may use it): {error}");
                    false
                }
            };
        let capture_registered =
            match RegisterHotKey(None, 4, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, b'N' as u32) {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("wallp: Ctrl+Alt+N is unavailable (another app may use it): {error}");
                    false
                }
            };
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_HOTKEY && msg.wParam.0 == 4 {
                if READY.load(Ordering::Relaxed) {
                    request_open("capture");
                }
                continue;
            }
            if msg.message == WM_HOTKEY && matches!(msg.wParam.0, 2 | 3) {
                let workspace = msg.wParam.0 == 2;
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = crate::taskbar::show_wallp_desktop(handle, workspace) {
                        let screen = if workspace { "workspace" } else { "desktop" };
                        eprintln!("wallp: couldn't open {screen}: {error}");
                    }
                });
                continue;
            }
            if msg.message == WM_HOTKEY && msg.wParam.0 == 1 {
                if READY.load(Ordering::Relaxed) {
                    request_open("apps");
                }
                continue;
            }
            if msg.message == WM_APP {
                configure_ctrl_space(&app, &mut registered);
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        HOTKEY_THREAD.store(0, Ordering::Relaxed);
        if capture_registered {
            let _ = UnregisterHotKey(None, 4);
        }
        if desktop_registered {
            let _ = UnregisterHotKey(None, 3);
        }
        if workspace_registered {
            let _ = UnregisterHotKey(None, 2);
        }
        if registered {
            let _ = UnregisterHotKey(None, 1);
        }
    });
}

#[cfg(target_os = "linux")]
fn spawn_hotkey(app: AppHandle) {
    // gsettings and xfconf round-trips are slow; keep them off the main thread.
    thread::spawn(move || install_shortcuts(&app));
}

/// Registers wallp's shortcuts: GNOME custom shortcuts that launch
/// `wallp --launcher` and friends, or on XFCE, keys grabbed directly.
#[cfg(target_os = "linux")]
fn install_shortcuts(app: &AppHandle) {
    let ctrl_space = CTRL_SPACE.load(Ordering::Relaxed);
    let error = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            if !crate::linux::is_xfce() {
                return crate::linux::keybindings::install(&dir, ctrl_space)
                    .map_err(|error| format!("Couldn't register GNOME shortcuts: {error}"));
            }
            // xfwm4 must let go of Ctrl+Alt+D before wallp can grab it.
            let released = crate::linux::xfce::release_show_desktop(&dir);
            let handle = app.clone();
            let grabbed = crate::linux::hotkeys::install(ctrl_space, move |flag| {
                handle_shortcut(&handle, flag)
            });
            released
                .map_err(|error| format!("Couldn't free Ctrl+Alt+D from Xfwm: {error}"))
                .and(grabbed)
        })
        .err();
    *app.state::<Launcher>().shortcut_error.lock().unwrap() = error;
    let _ = app.emit("launcher://preferences", launcher_preferences(app.clone()));
}

/// Removes the GNOME shortcuts and gives Ctrl+Alt+D back to Show Desktop.
/// XFCE's grabs end with the process.
#[cfg(target_os = "linux")]
pub fn release_shortcuts(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        if crate::linux::is_xfce() {
            crate::linux::xfce::restore_show_desktop(&dir);
        } else {
            crate::linux::keybindings::remove(&dir);
        }
    }
}

/// Handles a GNOME shortcut forwarded from a second `wallp` process. False
/// when the second process wasn't started by a shortcut.
#[cfg(target_os = "linux")]
pub fn handle_shortcut_args(app: &AppHandle, args: &[String]) -> bool {
    use crate::linux::keybindings::{DESKTOP, LAUNCHER, WORKSPACE};
    let Some(flag) = args.iter().skip(1).find_map(|arg| {
        [LAUNCHER, WORKSPACE, DESKTOP]
            .into_iter()
            .find(|f| f == arg)
    }) else {
        return false;
    };
    handle_shortcut(app, flag);
    true
}

/// Runs a shortcut, named by its command-line flag.
#[cfg(target_os = "linux")]
fn handle_shortcut(app: &AppHandle, flag: &str) {
    use crate::linux::keybindings::{DESKTOP, LAUNCHER, WORKSPACE};
    match flag {
        LAUNCHER if CTRL_SPACE.load(Ordering::Relaxed) && READY.load(Ordering::Relaxed) => {
            request_open("apps")
        }
        WORKSPACE | DESKTOP => {
            let workspace = flag == WORKSPACE;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(error) = crate::taskbar::show_wallp_desktop(handle, workspace) {
                    let screen = if workspace { "workspace" } else { "desktop" };
                    eprintln!("wallp: couldn't open {screen}: {error}");
                }
            });
        }
        _ => {}
    }
}

/// Saves a clipboard capture and tells the command menu.
fn remember(app: &AppHandle, content: Content) {
    let state = app.state::<Launcher>();
    let mut history = state.history.lock().unwrap();
    let result = history
        .as_mut()
        .ok_or("History unavailable".to_string())
        .and_then(|h| h.remember(content));
    drop(history);
    match result {
        Ok(()) => {
            let _ = app.emit("launcher://clipboard", ());
        }
        Err(error) => {
            let _ = app.emit(
                "launcher://error",
                format!("Couldn't save clipboard history: {error}"),
            );
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_clipboard(app: AppHandle) {
    use crate::linux::clipboard::{Kind, Watcher, with};
    thread::spawn(move || {
        let watcher = match Watcher::new() {
            Ok(watcher) => watcher,
            Err(error) => {
                let _ = app.emit(
                    "launcher://error",
                    format!("Clipboard history is unavailable: {error}"),
                );
                return;
            }
        };
        loop {
            let kind = match watcher.next() {
                Ok(kind) => kind,
                Err(error) => {
                    eprintln!("wallp: clipboard watcher stopped: {error}");
                    return;
                }
            };
            if !CAPTURE.load(Ordering::Relaxed) {
                continue;
            }
            let content = match kind {
                Some(Kind::Text) => with(|c| c.get_text())
                    .ok()
                    .filter(|text| {
                        !text.trim().is_empty() && text.encode_utf16().count() <= TEXT_LIMIT
                    })
                    .map(Content::Text),
                Some(Kind::Image) => with(|c| c.get_image())
                    .ok()
                    .and_then(|image| {
                        image::RgbaImage::from_raw(
                            u32::try_from(image.width).ok()?,
                            u32::try_from(image.height).ok()?,
                            image.bytes.into_owned(),
                        )
                    })
                    .map(Content::Image),
                None => None,
            };
            if let Some(content) = content {
                remember(&app, content);
            }
        }
    });
}

#[cfg(windows)]
enum Capture {
    Text(String),
    Image,
}

// Clipboard handles remain owned by Windows. Always unlock and close before returning.
#[cfg(windows)]
unsafe fn clipboard_content() -> Result<Option<Capture>, String> {
    unsafe {
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let result = (|| {
            let excluded =
                RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
            if excluded != 0 && IsClipboardFormatAvailable(excluded).is_ok() {
                return Ok(None);
            }
            let history = RegisterClipboardFormatW(w!("CanIncludeInClipboardHistory"));
            if let Ok(handle) = GetClipboardData(history) {
                let handle = HGLOBAL(handle.0);
                let ptr = GlobalLock(handle);
                if !ptr.is_null() {
                    let blocked =
                        GlobalSize(handle) >= 4 && std::ptr::read_unaligned(ptr as *const u32) == 0;
                    let _ = GlobalUnlock(handle);
                    if blocked {
                        return Ok(None);
                    }
                }
            }
            if [2, 8, 17]
                .iter()
                .any(|format| IsClipboardFormatAvailable(*format).is_ok())
            {
                return Ok(Some(Capture::Image));
            }
            let Ok(handle) = GetClipboardData(13) else {
                return Ok(None);
            };
            let handle = HGLOBAL(handle.0);
            let len = GlobalSize(handle) / 2;
            if len == 0 || len > TEXT_LIMIT + 1 {
                return Ok(None);
            }
            let ptr = GlobalLock(handle) as *const u16;
            if ptr.is_null() {
                return Err("Couldn't read clipboard".into());
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            let end = slice.iter().position(|v| *v == 0).unwrap_or(len);
            let text = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(handle);
            Ok(if text.trim().is_empty() {
                None
            } else {
                Some(Capture::Text(text))
            })
        })();
        let _ = CloseClipboard();
        result
    }
}
#[cfg(windows)]
fn spawn_clipboard(app: AppHandle) {
    thread::spawn(move || {
        let mut sequence = unsafe { GetClipboardSequenceNumber() };
        loop {
            thread::sleep(Duration::from_millis(250));
            let current = unsafe { GetClipboardSequenceNumber() };
            if !CAPTURE.load(Ordering::Relaxed) {
                sequence = current;
                continue;
            }
            if current == sequence {
                continue;
            }
            let capture = (|| -> Result<Option<Content>, String> {
                let content = unsafe { clipboard_content() }?;
                let content = match content {
                    Some(Capture::Image) => {
                        let image = arboard::Clipboard::new()
                            .map_err(|e| e.to_string())?
                            .get_image()
                            .map_err(|e| e.to_string())?;
                        let width = u32::try_from(image.width).map_err(|e| e.to_string())?;
                        let height = u32::try_from(image.height).map_err(|e| e.to_string())?;
                        let image =
                            image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
                                .ok_or("Invalid clipboard image")?;
                        Some(Content::Image(image))
                    }
                    Some(Capture::Text(text)) => Some(Content::Text(text)),
                    None => None,
                };
                // Privacy markers and payload must belong to the same clipboard revision.
                if unsafe { GetClipboardSequenceNumber() } != current {
                    return Ok(None);
                }
                Ok(content)
            })();
            if let Ok(content) = capture {
                sequence = current;
                if let Some(content) = content {
                    remember(&app, content);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn clipboard_image_preserves_orientation_colors_and_alpha() {
        let image = image::RgbaImage::from_raw(1, 2, vec![255, 0, 0, 128, 0, 0, 255, 255]).unwrap();
        let formats = clipboard_image_formats(image.clone()).unwrap();
        let decoded = image::load_from_memory_with_format(&formats[0].1, image::ImageFormat::Png)
            .unwrap()
            .to_rgba8();
        assert_eq!(decoded, image);
        assert_eq!(formats[1].0, 17);
        let dib = &formats[1].1;
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        assert_eq!(&dib[124..], &[255, 0, 0, 255, 0, 0, 255, 128]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_app_registration_provides_a_png_icon() {
        let output = Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-StartApps | Select-Object -First 10 | ForEach-Object { @{ id=$_.AppID; name=$_.Name } })"])
            .creation_flags(0x08000000).output().unwrap();
        assert!(output.status.success());
        let mut apps: Vec<InstalledApp> = serde_json::from_slice(&output.stdout).unwrap();
        populate_icons(&mut apps);
        let icons: Vec<_> = apps.iter().filter_map(|app| app.icon.as_ref()).collect();
        assert!(
            !icons.is_empty(),
            "Windows should return an icon for installed apps"
        );
        use base64::Engine;
        for icon in icons {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            assert!(image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).is_ok());
        }
    }

    #[test]
    fn old_preferences_migrate_to_ctrl_space_without_windows_overrides() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"replaceStart":true,"clipboard":false}"#).unwrap();
        assert!(preferences.ctrl_space);
        assert!(!preferences.clipboard);
        assert!(!preferences.shadcn_command);
        let saved = serde_json::to_value(preferences).unwrap();
        assert_eq!(saved["ctrlSpace"], true);
        assert_eq!(saved["shadcnCommand"], false);
        assert!(saved.get("replaceStart").is_none());
    }

    #[test]
    fn command_menu_preference_survives_round_trip() {
        let preferences: Preferences =
            serde_json::from_str(r#"{"ctrlSpace":true,"clipboard":false,"shadcnCommand":true}"#)
                .unwrap();
        let restored: Preferences =
            serde_json::from_slice(&serde_json::to_vec(&preferences).unwrap()).unwrap();
        assert!(restored.shadcn_command);
        assert!(!restored.clipboard);
    }

    #[test]
    fn index_excludes_documents_and_web_shortcuts_but_keeps_apps() {
        for id in [
            r"{known-folder}\7-Zip\7-zip.chm",
            r"C:\Apps\readme.txt",
            r"C:\Apps\manual.pdf",
            r"C:\Apps\help.url",
            r"http:\docs.example.com\readme",
            "https://example.com/help",
            "file:///C:/notes.txt",
        ] {
            assert!(
                !is_application(&InstalledApp {
                    id: id.into(),
                    name: "Shortcut".into(),
                    icon: None
                }),
                "{id}"
            );
        }
        for id in [
            r"{known-folder}\7-Zip\7zFM.exe",
            r"C:\Apps\tools.msc",
            "com.t3tools.t3code",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            "steam://rungameid/123",
            "battlenet://game/auks",
        ] {
            assert!(
                is_application(&InstalledApp {
                    id: id.into(),
                    name: "App".into(),
                    icon: None
                }),
                "{id}"
            );
        }
    }
}
#[tauri::command]
pub async fn clipboard_entries(
    app: AppHandle,
    query: Option<String>,
    offset: Option<u64>,
) -> Result<Page, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Launcher>();
        let history = state.history.lock().unwrap();
        history
            .as_ref()
            .ok_or("History unavailable")?
            .page(&query.unwrap_or_default(), offset.unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn clear_clipboard_history(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Launcher>();
        state
            .history
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("History unavailable")?
            .clear()?;
        let _ = app.emit("launcher://clipboard", ());
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(windows)]
unsafe fn write_clipboard_formats(owner: HWND, formats: &[(u32, Vec<u8>)]) -> Result<(), String> {
    unsafe {
        for attempt in 0..6 {
            match OpenClipboard(Some(owner)) {
                Ok(()) => break,
                Err(error) if attempt == 5 => return Err(error.to_string()),
                Err(_) => thread::sleep(Duration::from_millis(5)),
            }
        }
        let result = (|| {
            EmptyClipboard().map_err(|e| e.to_string())?;
            for (format, bytes) in formats {
                let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
                let ptr = GlobalLock(memory) as *mut u8;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(memory));
                    return Err("Couldn't write clipboard".into());
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                let _ = GlobalUnlock(memory);
                if let Err(err) = SetClipboardData(*format, Some(HANDLE(memory.0))) {
                    let _ = GlobalFree(Some(memory));
                    return Err(err.to_string());
                }
            } // Windows now owns each successful allocation.
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}
#[cfg(windows)]
fn clipboard_image_formats(image: image::RgbaImage) -> Result<Vec<(u32, Vec<u8>)>, String> {
    use windows::Win32::Graphics::Gdi::{BI_BITFIELDS, BITMAPV5HEADER, LCS_GM_IMAGES};
    let width = i32::try_from(image.width()).map_err(|e| e.to_string())?;
    let height = i32::try_from(image.height()).map_err(|e| e.to_string())?;
    if width == 0 || height == 0 {
        return Err("Cannot copy an empty image".into());
    }
    let size = u32::try_from(image.as_raw().len()).map_err(|e| e.to_string())?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let png_format = unsafe { RegisterClipboardFormatW(w!("PNG")) };
    if png_format == 0 {
        return Err("Couldn't register PNG clipboard format".into());
    }
    let header = BITMAPV5HEADER {
        bV5Size: std::mem::size_of::<BITMAPV5HEADER>() as u32,
        bV5Width: width,
        bV5Height: height,
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5SizeImage: size,
        bV5RedMask: 0x00ff0000,
        bV5GreenMask: 0x0000ff00,
        bV5BlueMask: 0x000000ff,
        bV5AlphaMask: 0xff000000,
        bV5CSType: 0x73524742, // LCS_sRGB
        bV5Intent: LCS_GM_IMAGES as u32,
        ..Default::default()
    };
    let mut dib = unsafe {
        std::slice::from_raw_parts(
            &header as *const BITMAPV5HEADER as *const u8,
            std::mem::size_of::<BITMAPV5HEADER>(),
        )
        .to_vec()
    };
    // Positive height and bottom-up BGRA pixels also work in Word/WordPad.
    for row in image.rows().rev() {
        for pixel in row {
            let [r, g, b, a] = pixel.0;
            dib.extend_from_slice(&[b, g, r, a]);
        }
    }
    Ok(vec![(png_format, png.into_inner()), (17, dib)]) // CF_DIBV5
}
/// Wayland lets no app type into another, so the entry is only copied. Hiding
/// the menu returns focus to the previous app, ready for Ctrl+V.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn paste_clipboard(app: AppHandle, id: i64) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let content = handle
            .state::<Launcher>()
            .history
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("History unavailable")?
            .get(id)?;
        crate::linux::clipboard::with(|clipboard| match content {
            Content::Text(text) => clipboard.set_text(text),
            Content::Image(image) => clipboard.set_image(arboard::ImageData {
                width: image.width() as usize,
                height: image.height() as usize,
                bytes: image.into_raw().into(),
            }),
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    close_launcher(app)
}

#[cfg(windows)]
#[tauri::command]
pub async fn paste_clipboard(app: AppHandle, id: i64) -> Result<(), String> {
    let handle = app.clone();
    let content = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Launcher>();
        state
            .history
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("History unavailable")?
            .get(id)
    })
    .await
    .map_err(|e| e.to_string())??;
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Command menu unavailable")?;
    let owner = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        let formats = match content {
            Content::Text(text) => vec![(
                13,
                text.encode_utf16()
                    .chain(Some(0))
                    .flat_map(u16::to_le_bytes)
                    .collect(),
            )],
            Content::Image(image) => clipboard_image_formats(image)?,
        };
        // Images need the same valid owner HWND as text. Opening with NULL and
        // emptying the clipboard leaves no owner and can make SetClipboardData fail.
        unsafe { write_clipboard_formats(HWND(owner as *mut _), &formats) }
    })
    .await
    .map_err(|e| e.to_string())??;
    let (target, target_pid) = *app.state::<Launcher>().target.lock().unwrap();
    close_launcher(app)?;
    tauri::async_runtime::spawn_blocking(move || unsafe {
        let target = HWND(target as *mut _);
        let mut pid = 0;
        GetWindowThreadProcessId(target, Some(&mut pid));
        if target.0.is_null() || !IsWindow(Some(target)).as_bool() || pid != target_pid {
            return Err("Copied. The original app closed; use Ctrl+V to paste elsewhere.".into());
        }
        if pid == std::process::id() {
            return Err("Copied. Focus the app you want and press Ctrl+V to paste.".into());
        }
        let _ = SetForegroundWindow(target);
        // Never inject paste while a shortcut modifier is held or into the wrong app.
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(25));
            if [VK_LWIN, VK_RWIN, VK_CONTROL, VK_MENU, VK_SHIFT]
                .iter()
                .all(|v| GetAsyncKeyState(v.0 as i32) >= 0)
            {
                if GetForegroundWindow() != target {
                    return Err(
                        "Copied. Windows couldn't focus the original app; use Ctrl+V to paste."
                            .into(),
                    );
                }
                let inputs = [
                    key(VK_CONTROL, false),
                    key(VK_V, false),
                    key(VK_V, true),
                    key(VK_CONTROL, true),
                ];
                if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) != inputs.len() as u32 {
                    return Err(
                        "Copied. Automatic paste was blocked; use Ctrl+V in the target app.".into(),
                    );
                }
                return Ok(());
            }
        }
        Err("Copied. Release the shortcut keys and press Ctrl+V to paste.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pin_clipboard(app: AppHandle, id: i64, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Launcher>();
        let history = state.history.lock().unwrap();
        history.as_ref().ok_or("History unavailable")?.pin(id, &key)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_clipboard_pin(app: AppHandle, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Launcher>();
        let history = state.history.lock().unwrap();
        history.as_ref().ok_or("History unavailable")?.unpin(&key)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn copy_history_content(
    app: AppHandle,
    id: Option<i64>,
    key: Option<String>,
) -> Result<(), String> {
    let owner = app
        .get_webview_window(LABEL)
        .ok_or("Command menu unavailable")?
        .hwnd()
        .map_err(|e| e.to_string())?
        .0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        let content = {
            let state = app.state::<Launcher>();
            let history = state.history.lock().unwrap();
            let history = history.as_ref().ok_or("History unavailable")?;
            if let Some(key) = key {
                history.get_pin(&key)?
            } else {
                history.get(id.ok_or("Missing clipboard ID")?)?
            }
        };
        let formats = match content {
            Content::Text(text) => vec![(
                13,
                text.encode_utf16()
                    .chain(Some(0))
                    .flat_map(u16::to_le_bytes)
                    .collect(),
            )],
            Content::Image(image) => clipboard_image_formats(image)?,
        };
        unsafe { write_clipboard_formats(HWND(owner as *mut _), &formats) }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn copy_clipboard_entry(app: AppHandle, id: i64) -> Result<(), String> {
    copy_history_content(app, Some(id), None).await
}

#[tauri::command]
pub async fn copy_clipboard_pin(app: AppHandle, key: String) -> Result<(), String> {
    copy_history_content(app, None, Some(key)).await
}
