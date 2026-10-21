#[cfg(not(windows))]
compile_error!("wallp embeds itself in the Windows desktop and only builds for Windows.");

mod agnes;
mod ai_history;
mod clipboard_history;
mod desktop;
mod email_digest;
mod gmail;
mod home_shortcuts;
mod launcher;
mod mail_cache;
mod taskbar;
mod tray_apps;
pub use taskbar::recovery_entry;

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

const DESKTOP: &str = "desktop";
/// How often to check that we're still attached, and whether to pause.
const WATCH_INTERVAL: Duration = Duration::from_secs(2);

struct Desktop {
    attachment: Mutex<Option<desktop::Attachment>>,
    icons_visible: AtomicBool,
    quitting: AtomicBool,
}

/// Creates the desktop window if needed and attaches it to the desktop.
/// Must run on the main thread.
fn attach_desktop(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = match app.get_webview_window(DESKTOP) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, DESKTOP, WebviewUrl::default())
            .title("wallp")
            .decorations(false)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .shadow(false)
            .visible(false)
            .build()?,
    };

    let attachment = desktop::attach(window.hwnd()?)?;
    let state = app.state::<Desktop>();
    attachment.set_icons_visible(state.icons_visible.load(Ordering::Relaxed));
    *state.attachment.lock().unwrap() = Some(attachment);
    window.show()?;
    attachment.place()?;
    Ok(())
}

fn reattach(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(err) = attach_desktop(&handle) {
            eprintln!("wallp: couldn't attach to the desktop: {err}");
        }
    });
}

/// Re-attaches after Explorer restarts or the monitor layout changes, and
/// tells the UI to pause while a fullscreen app covers the desktop.
///
/// Polling keeps this simple: Explorer's `TaskbarCreated` broadcast only
/// reaches top-level windows, and ours is a child of the desktop.
fn spawn_watchdog(app: AppHandle) {
    thread::spawn(move || {
        let mut paused = false;
        loop {
            thread::sleep(WATCH_INTERVAL);
            let state = app.state::<Desktop>();
            if state.quitting.load(Ordering::Relaxed) {
                return;
            }

            let attachment = *state.attachment.lock().unwrap();
            let stale =
                attachment.is_none_or(|a| !a.is_intact() || a.bounds != desktop::virtual_screen());
            if stale {
                reattach(&app);
            }

            let fullscreen = desktop::fullscreen_app_running();
            if fullscreen != paused {
                paused = fullscreen;
                let _ = app.emit("desktop://paused", paused);
            }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || taskbar::tick(&handle));
        }
    });
}

fn set_icons_visible_inner(app: &AppHandle, visible: bool) {
    let state = app.state::<Desktop>();
    state.icons_visible.store(visible, Ordering::Relaxed);
    if let Some(attachment) = *state.attachment.lock().unwrap() {
        attachment.set_icons_visible(visible);
    }
}

#[tauri::command]
fn set_icons_visible(app: AppHandle, visible: bool) {
    set_icons_visible_inner(&app, visible);
}

#[tauri::command]
fn desktop_paused() -> bool {
    desktop::fullscreen_app_running()
}

/// Built-in desktop shortcuts use fixed install paths. Custom homescreen pins
/// launch separately using registered app IDs from the launcher index.
#[tauri::command]
fn launch_shortcut(app: AppHandle, target: &str) -> Result<(), String> {
    use std::{path::PathBuf, process::Command};

    let env_path = |name: &str| -> Result<PathBuf, String> {
        std::env::var_os(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("Windows environment variable {name} is missing"))
    };
    let windows = env_path("WINDIR")?;
    let mut command = match target {
        "pc" => {
            let mut command = Command::new(windows.join("explorer.exe"));
            command.arg("shell:MyComputerFolder");
            command
        }
        "downloads" => {
            let mut command = Command::new(windows.join("explorer.exe"));
            command.arg(app.path().download_dir().map_err(|err| err.to_string())?);
            command
        }
        "edge" | "steam" | "riot" | "t3" => {
            let candidates = match target {
                "edge" => vec![
                    env_path("ProgramFiles(x86)")?.join("Microsoft/Edge/Application/msedge.exe"),
                    env_path("ProgramFiles")?.join("Microsoft/Edge/Application/msedge.exe"),
                    env_path("LOCALAPPDATA")?.join("Microsoft/Edge/Application/msedge.exe"),
                ],
                "steam" => vec![
                    env_path("ProgramFiles(x86)")?.join("Steam/steam.exe"),
                    env_path("ProgramFiles")?.join("Steam/steam.exe"),
                ],
                "riot" => vec![PathBuf::from(format!(
                    "{}/Riot Games/Riot Client/RiotClientServices.exe",
                    env_path("SystemDrive")?.display()
                ))],
                "t3" => vec![
                    env_path("LOCALAPPDATA")?.join("Programs/t3code/T3 Code (Nightly).exe"),
                    env_path("LOCALAPPDATA")?.join("Programs/t3code/T3 Code.exe"),
                ],
                _ => unreachable!(),
            };
            let path = candidates
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| format!("Couldn't find {target}. Check that it is installed."))?;
            let mut command = Command::new(&path);
            if let Some(parent) = path.parent() {
                command.current_dir(parent);
            }
            command
        }
        _ => return Err("Unknown desktop shortcut".into()),
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Couldn't open {target}: {err}"))
}

/// Puts the desktop back the way Explorer left it.
fn restore_desktop(app: &AppHandle) {
    let state = app.state::<Desktop>();
    state.quitting.store(true, Ordering::Relaxed);
    taskbar::restore(app);
    if let Some(attachment) = state.attachment.lock().unwrap().take() {
        attachment.set_icons_visible(true);
    }
    desktop::refresh_wallpaper();
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let icons_visible = app.state::<Desktop>().icons_visible.load(Ordering::Relaxed);
    let show_icons = CheckMenuItem::with_id(
        app,
        "icons",
        "Show desktop icons",
        true,
        icons_visible,
        None::<&str>,
    )?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
    let commands = MenuItem::with_id(app, "commands", "Open command menu", true, None::<&str>)?;
    let restore_taskbar = MenuItem::with_id(
        app,
        "restore-taskbar",
        "Restore Windows taskbar",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit wallp", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_icons,
            &commands,
            &restore_taskbar,
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("wallp")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("bundle has an icon"),
        )
        .tooltip("wallp")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "icons" => set_icons_visible_inner(app, show_icons.is_checked().unwrap_or(false)),
            "commands" => {
                let _ = launcher::open_launcher(app.clone(), None);
            }
            "restore-taskbar" => taskbar::restore(app),
            "reload" => {
                if let Some(window) = app.get_webview_window(DESKTOP) {
                    let _ = window.reload();
                }
            }
            "quit" => {
                restore_desktop(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second copy would fight the first over the desktop.
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_opener::init())
        .manage(taskbar::Taskbar::default())
        .manage(launcher::Launcher::default())
        .manage(Desktop {
            attachment: Mutex::new(None),
            icons_visible: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            set_icons_visible,
            desktop_paused,
            launch_shortcut,
            tray_apps::list_tray_apps,
            tray_apps::end_tray_app,
            taskbar::taskbar_enabled,
            taskbar::set_taskbar_enabled,
            taskbar::taskbar_ready,
            taskbar::resize_dock,
            taskbar::list_app_windows,
            taskbar::activate_app_window,
            taskbar::show_wallp_desktop,
            launcher::launcher_ready,
            launcher::open_launcher,
            launcher::close_launcher,
            launcher::launcher_apps,
            launcher::refresh_launcher_apps,
            launcher::launch_app,
            home_shortcuts::home_shortcuts,
            home_shortcuts::set_home_shortcut,
            home_shortcuts::launch_home_shortcut,
            launcher::launcher_search,
            agnes::launcher_ai,
            email_digest::email_digest_cached,
            email_digest::email_digest_refresh,
            gmail::email_account,
            gmail::email_connect,
            gmail::email_disconnect,
            gmail::email_cached_inbox,
            gmail::email_inbox,
            gmail::email_cached_thread,
            gmail::email_prefetch,
            gmail::email_thread,
            gmail::email_reply,
            ai_history::ai_save_chat,
            ai_history::ai_list_chats,
            ai_history::ai_load_chat,
            ai_history::ai_delete_chat,
            launcher::clipboard_entries,
            launcher::paste_clipboard,
            launcher::clear_clipboard_history,
            launcher::launcher_preferences,
            launcher::set_launcher_preferences
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = email_digest::initialize(&handle) {
                eprintln!("wallp: couldn't initialize email digest: {error}");
            }
            build_tray(&handle)?;
            launcher::setup(&handle)?;
            if let Err(err) = attach_desktop(&handle) {
                // Explorer may still be starting (e.g. launched at login).
                eprintln!("wallp: couldn't attach to the desktop yet: {err}");
            }
            taskbar::spawn_dock_hover(handle.clone());
            spawn_watchdog(handle);
            if let Err(error) = taskbar::create_bar(app.handle()) {
                eprintln!("wallp: couldn't create the bar: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building wallp")
        .run(|app, event| match event {
            // Explorer destroys our window along with its own when it
            // restarts. Stay alive so the watchdog can bring it back.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            RunEvent::Exit => {
                if let Err(error) = email_digest::record_close(app) {
                    eprintln!("wallp: couldn't save email last-closed time: {error}");
                }
                restore_desktop(app);
            }
            _ => {}
        });
}
