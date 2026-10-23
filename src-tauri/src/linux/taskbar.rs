//! GNOME keeps its own dock and panel, and an XWayland client can't see or
//! focus Wayland windows to replace them, so the wallp dock is Windows-only.
//! The desktop shortcuts it shares with Ctrl+Alt+W/D still work here.
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const UNAVAILABLE: &str = "The wallp dock is only available on Windows. GNOME keeps its own dock.";

#[derive(Default)]
pub struct Taskbar;

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

#[tauri::command]
#[allow(unused_variables)]
pub fn resize_dock(width: i32) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn taskbar_enabled() -> bool {
    false
}

#[tauri::command]
pub async fn set_taskbar_enabled(enabled: bool) -> Result<bool, String> {
    if enabled { Err(UNAVAILABLE.into()) } else { Ok(false) }
}

/// Nothing to create: see the module docs.
pub fn create_bar(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn taskbar_ready() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

pub fn restore(_app: &AppHandle) {}

pub fn tick(_app: &AppHandle) {}

pub fn spawn_dock_hover(_app: AppHandle) {}

/// The Windows build restores its taskbar from a helper process.
pub fn recovery_entry() -> bool {
    false
}

#[tauri::command]
pub fn list_app_windows() -> Vec<AppWindow> {
    Vec::new()
}

#[tauri::command]
#[allow(unused_variables)]
pub fn activate_app_window(id: String, pid: u32) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn show_wallp_desktop(app: AppHandle, workspace: bool) -> Result<(), String> {
    let desktop = app
        .get_webview_window("desktop")
        .ok_or("The desktop is reconnecting. Try again shortly.")?;
    crate::linux::show_desktop()?;
    app.emit("taskbar://workspace", workspace)
        .map_err(|e| e.to_string())?;
    crate::linux::activate(&desktop)
}
