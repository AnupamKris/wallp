//! Floating dock on XFCE: a dock-typed window that pops up at the bottom
//! edge and lists the window manager's client windows, like the Windows dock.
//! Bottom panels share that edge, so they're hidden while it's on (see
//! `xfce`), and a recovery process brings them back if wallp dies.
//!
//! GNOME keeps its own dock and panel, and an XWayland client can't see or
//! focus Wayland windows to replace them, so there the dock is unavailable.
//! The desktop shortcuts it shares with Ctrl+Alt+W/D still work.
use crate::linux::{X11, is_xfce, x11};
use gtk::{gdk::WindowTypeHint, prelude::*};
use serde::Serialize;
use std::{
    collections::HashMap,
    process::{Child, Command},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use x11rb::protocol::xproto::ConnectionExt;

const LABEL: &str = "taskbar";
const HEIGHT: i32 = 88;
const UNAVAILABLE: &str = "The wallp dock isn't available on GNOME, which keeps its own dock.";
const RECOVERY_FLAG: &str = "--wallp-taskbar-recovery";

#[derive(Default)]
pub struct Taskbar(pub Mutex<State>);

#[derive(Default)]
pub struct State {
    enabled: bool,
    width: i32,
    last_hover: Option<Instant>,
    helper: Option<Child>,
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

/// Centres the dock above the primary monitor's bottom edge.
fn position(window: &tauri::WebviewWindow, width: i32) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Couldn't locate the primary monitor")?;
    let (origin, size, scale) = (monitor.position(), monitor.size(), monitor.scale_factor());
    let height = (HEIGHT as f64 * scale) as i32;
    let width = ((width.max(160) as f64 * scale) as i32).min(size.width as i32 - 32);
    let left = origin.x + (size.width as i32 - width) / 2;
    let top = origin.y + size.height as i32 - height - (8. * scale) as i32;
    window
        .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(left, top))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_dock(app: AppHandle, window: tauri::WebviewWindow, width: i32) -> Result<(), String> {
    if !is_xfce() {
        return Err(UNAVAILABLE.into());
    }
    if window.label() != LABEL {
        return Err("Only the dock can resize itself".into());
    }
    let width = width.clamp(160, 2000);
    app.state::<Taskbar>().0.lock().unwrap().width = width;
    position(&window, width)
}

#[tauri::command]
pub fn taskbar_supported() -> bool {
    is_xfce()
}

#[tauri::command]
pub fn taskbar_enabled(app: AppHandle) -> bool {
    app.state::<Taskbar>().0.lock().unwrap().enabled
}

#[tauri::command]
pub async fn set_taskbar_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if !is_xfce() {
        return if enabled {
            Err(UNAVAILABLE.into())
        } else {
            Ok(false)
        };
    }
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

/// Creates the hidden dock window; it enables itself once its page loads.
/// Must run on the main thread.
pub fn create_bar(app: &AppHandle) -> Result<(), String> {
    if !is_xfce() || app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?view=taskbar".into()),
    )
    .title("wallp dock")
    .decorations(false)
    .skip_taskbar(true)
    // GTK won't resize a non-resizable window from code. Without
    // decorations, users can't resize it either way.
    .resizable(true)
    .shadow(false)
    .transparent(true)
    .focused(false)
    .inner_size(780., HEIGHT as f64)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    // xfwm4 keeps dock windows above others, on every workspace, out of
    // Alt+Tab, and never focuses them: what HWND_TOPMOST and
    // SWP_NOACTIVATE give the Windows dock. The type is read when mapped.
    let gtk = window.gtk_window().map_err(|e| e.to_string())?;
    gtk.set_type_hint(WindowTypeHint::Dock);
    gtk.set_keep_above(true);
    gtk.set_skip_taskbar_hint(true);
    gtk.set_skip_pager_hint(true);
    gtk.set_accept_focus(false);
    gtk.set_focus_on_map(false);
    gtk.stick();
    Ok(())
}

#[tauri::command]
pub async fn taskbar_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !is_xfce() {
        return Err(UNAVAILABLE.into());
    }
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
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    if state.enabled {
        return Ok(());
    }
    let dir = crate::linux::state_dir().ok_or("Couldn't find wallp's data folder")?;
    // Recovery runs outside Tauri and survives a crash or SIGKILL.
    if state
        .helper
        .as_mut()
        .is_none_or(|child| child.try_wait().ok().flatten().is_some())
    {
        state.helper = Some(
            Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args([RECOVERY_FLAG, &std::process::id().to_string()])
                .spawn()
                .map_err(|e| e.to_string())?,
        );
    }
    crate::linux::xfce::hide_bottom_panels(&dir)
        .map_err(|e| format!("Couldn't hide the XFCE panel: {e}"))?;
    position(window, state.width.max(160))?;
    state.enabled = true;
    drop(state);
    let _ = app.emit("taskbar://enabled", true);
    Ok(())
}

/// Removes the dock and gives the bottom edge back to XFCE's panels.
pub fn restore(app: &AppHandle) {
    if !is_xfce() {
        return;
    }
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    state.enabled = false;
    state.last_hover = None;
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
    if let Some(dir) = crate::linux::state_dir() {
        crate::linux::xfce::restore_panels(&dir);
    }
    if let Some(mut helper) = state.helper.take() {
        let _ = helper.kill();
        let _ = helper.wait();
    }
    drop(state);
    let _ = app.emit("taskbar://enabled", false);
}

/// Keeps the dock in place, and gives up if the recovery process is gone.
pub fn tick(app: &AppHandle) {
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    if !state.enabled {
        return;
    }
    let Some(window) = app.get_webview_window(LABEL) else {
        drop(state);
        return restore(app);
    };
    if state
        .helper
        .as_mut()
        .is_none_or(|child| !matches!(child.try_wait(), Ok(None)))
    {
        drop(state);
        restore(app);
        let _ = app.emit(
            "taskbar://error",
            "The recovery process stopped. The XFCE panel has been restored.",
        );
        return;
    }
    let width = state.width.max(160);
    drop(state);
    if window.is_visible().unwrap_or(false) {
        let _ = position(&window, width);
    }
}

/// Poll the pointer even while the dock is hidden: a hidden window can't
/// receive DOM mouse-enter events.
pub fn spawn_dock_hover(app: AppHandle) {
    if !is_xfce() {
        return;
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(70));
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
    let binding = app.state::<Taskbar>();
    let mut state = binding.0.lock().unwrap();
    if !state.enabled {
        return;
    }
    let Ok(x) = x11() else {
        return;
    };
    let Some(pointer) = x
        .conn
        .query_pointer(x.root)
        .ok()
        .and_then(|c| c.reply().ok())
    else {
        return;
    };
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let (cx, cy) = (pointer.root_x as i32, pointer.root_y as i32);
    let (mx, my) = (monitor.position().x, monitor.position().y);
    let (right, bottom) = (
        mx + monitor.size().width as i32,
        my + monitor.size().height as i32,
    );
    let visible = window.is_visible().unwrap_or(false);
    let edge = cx >= mx && cx < right && cy >= bottom - 4 && cy < bottom;
    // Include the gap below the floating dock so it stays reachable from the edge.
    let over = visible
        && window
            .outer_position()
            .ok()
            .zip(window.outer_size().ok())
            .is_some_and(|(p, s)| {
                cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < bottom
            });
    let fullscreen = crate::desktop::fullscreen_app_running();
    if !fullscreen && (edge || over) {
        state.last_hover = Some(Instant::now());
        if !visible {
            let width = state.width.max(160);
            let _ = position(&window, width);
            let _ = window.show();
            // The window manager places windows when they're mapped.
            let _ = position(&window, width);
        }
    } else if visible
        && (fullscreen
            || state
                .last_hover
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(350)))
    {
        let _ = window.hide();
    }
}

/// Called before Tauri starts, in the recovery process: waits for wallp to
/// exit, then restores any panels it left hidden.
pub fn recovery_entry() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(RECOVERY_FLAG) {
        return false;
    }
    if let Some(pid) = args.get(2).and_then(|v| v.parse::<libc::pid_t>().ok()) {
        while unsafe { libc::kill(pid, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        {
            std::thread::sleep(Duration::from_millis(500));
        }
        if let Some(dir) = crate::linux::state_dir() {
            crate::linux::xfce::restore_panels(&dir);
        }
    }
    true
}

/// Windows the window manager would show in a taskbar, oldest first.
fn windows() -> Vec<AppWindow> {
    let Ok(x) = x11() else {
        return Vec::new();
    };
    let own = std::process::id();
    let active = x.active_window();
    let clients = x.values(x.root, "_NET_CLIENT_LIST").unwrap_or_default();
    let normal = x.atom("_NET_WM_WINDOW_TYPE_NORMAL").unwrap_or(0);
    let mut list = Vec::new();
    for id in clients.iter().copied() {
        let pid = x
            .values(id, "_NET_WM_PID")
            .ok()
            .and_then(|v| v.first().copied())
            .unwrap_or(0);
        let types = x.values(id, "_NET_WM_WINDOW_TYPE").unwrap_or_default();
        if pid == own
            || !(types.is_empty() || types.contains(&normal))
            || x.has(id, "_NET_WM_STATE", "_NET_WM_STATE_SKIP_TASKBAR")
            || x.values(id, "WM_TRANSIENT_FOR")
                .is_ok_and(|v| v.first().is_some_and(|w| *w != 0))
        {
            continue;
        }
        let title = x
            .text(id, "_NET_WM_NAME")
            .ok()
            .filter(|t| !t.is_empty())
            .or_else(|| x.text(id, "WM_NAME").ok())
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        list.push(AppWindow {
            id: id.to_string(),
            pid,
            title,
            active: active == Some(id),
            minimized: x.has(id, "_NET_WM_STATE", "_NET_WM_STATE_HIDDEN"),
            icon: None,
        });
    }
    with_icons(x, &mut list);
    list
}

/// Icons are decoded once per window: the dock polls every second.
fn with_icons(x: &X11, list: &mut [AppWindow]) {
    static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    cache.retain(|id, _| list.iter().any(|w| w.id == *id));
    for window in list {
        let icon = cache.entry(window.id.clone()).or_insert_with(|| {
            let id = window.id.parse().unwrap_or(0);
            wm_icon(x, id).or_else(|| {
                let (instance, class) = x.class(id);
                crate::linux::apps::icon_for_class(&instance, &class)
            })
        });
        window.icon = icon.clone();
    }
}

/// The best-fitting image from `_NET_WM_ICON`: a list of width, height and
/// ARGB pixels. The dock shows 30px icons, sharper on HiDPI from 48px up.
fn wm_icon(x: &X11, window: u32) -> Option<String> {
    let data = x.values(window, "_NET_WM_ICON").ok()?;
    let mut images = Vec::new();
    let mut rest = &data[..];
    while let [w, h, tail @ ..] = rest {
        let len = (*w as usize).checked_mul(*h as usize)?;
        if *w == 0 || len > tail.len() {
            break;
        }
        images.push((*w, *h, &tail[..len]));
        rest = &tail[len..];
    }
    let (w, h, pixels) = images
        .iter()
        .filter(|(w, _, _)| *w >= 48)
        .min_by_key(|(w, _, _)| *w)
        .or_else(|| images.iter().max_by_key(|(w, _, _)| *w))?;
    let rgba = pixels
        .iter()
        .flat_map(|p| [(p >> 16) as u8, (p >> 8) as u8, *p as u8, (p >> 24) as u8])
        .collect();
    crate::linux::apps::png_data_url(&image::RgbaImage::from_raw(*w, *h, rgba)?)
}

#[tauri::command]
pub fn list_app_windows() -> Vec<AppWindow> {
    if is_xfce() { windows() } else { Vec::new() }
}

#[tauri::command]
pub fn activate_app_window(id: String, pid: u32) -> Result<(), String> {
    if !is_xfce() {
        return Err(UNAVAILABLE.into());
    }
    let entry = windows()
        .into_iter()
        .find(|w| w.id == id && w.pid == pid)
        .ok_or("That window has closed. Refresh and try again.")?;
    crate::linux::activate_xid(entry.id.parse().map_err(|_| "Unknown window")?)
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
