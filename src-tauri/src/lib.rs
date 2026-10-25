#[cfg(not(any(windows, target_os = "linux")))]
compile_error!(
    "wallp embeds itself in the Windows, GNOME or XFCE desktop and only builds for those."
);

mod agnes;
mod ai_history;
mod clipboard_history;
#[cfg_attr(target_os = "linux", path = "linux/desktop.rs")]
mod desktop;
mod email_digest;
mod gmail;
mod home_shortcuts;
mod launcher;
#[cfg(target_os = "linux")]
mod linux;
mod mail_cache;
mod power;
mod quick_settings;
#[cfg_attr(target_os = "linux", path = "linux/taskbar.rs")]
mod taskbar;
#[cfg_attr(target_os = "linux", path = "linux/tray_apps.rs")]
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

    #[cfg(windows)]
    let attachment = desktop::attach(window.hwnd()?)?;
    #[cfg(target_os = "linux")]
    let attachment = desktop::attach(&window)?;
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
#[cfg(windows)]
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

/// Built-in desktop shortcuts use the apps' desktop entries, native or Flatpak.
/// Custom homescreen pins launch separately from the launcher index.
#[cfg(target_os = "linux")]
#[tauri::command]
fn launch_shortcut(app: AppHandle, target: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let open_path = |path: std::path::PathBuf| {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|err| format!("Couldn't open {target}: {err}"))
    };
    let ids: &[&str] = match target {
        // Nautilus' Other Locations lists drives, like This PC.
        "pc" => {
            return std::process::Command::new("nautilus")
                .arg("other-locations:///")
                .spawn()
                .map(|_| ())
                .or_else(|_| open_path("/".into()));
        }
        "downloads" => return open_path(app.path().download_dir().map_err(|err| err.to_string())?),
        "edge" => &[
            "microsoft-edge.desktop",
            "microsoft-edge-beta.desktop",
            "microsoft-edge-dev.desktop",
            "com.microsoft.Edge.desktop",
        ],
        "steam" => &["steam.desktop", "com.valvesoftware.Steam.desktop"],
        "riot" => return Err("Riot Games isn't available on Linux.".into()),
        "t3" => &["com.t3tools.T3Code.desktop", "t3code.desktop"],
        _ => return Err("Unknown desktop shortcut".into()),
    };
    let id = ids
        .iter()
        .find(|id| linux::apps::exists(id))
        .ok_or_else(|| format!("Couldn't find {target}. Check that it is installed."))?;
    linux::apps::launch(id)
}

/// Puts the desktop back the way Explorer left it.
fn restore_desktop(app: &AppHandle) {
    let state = app.state::<Desktop>();
    state.quitting.store(true, Ordering::Relaxed);
    taskbar::restore(app);
    #[cfg(target_os = "linux")]
    launcher::release_shortcuts(app);
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
    #[cfg(windows)]
    let restore_label = Some("Restore Windows taskbar");
    // GNOME keeps its own panel, so there is no taskbar to restore there.
    #[cfg(target_os = "linux")]
    let restore_label = linux::is_xfce().then_some("Restore XFCE panel");
    let restore_taskbar = restore_label
        .map(|label| MenuItem::with_id(app, "restore-taskbar", label, true, None::<&str>))
        .transpose()?;
    let quit = MenuItem::with_id(app, "quit", "Quit wallp", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&show_icons, &commands];
    if let Some(item) = &restore_taskbar {
        items.push(item);
    }
    items.extend([
        &reload as &dyn tauri::menu::IsMenuItem<_>,
        &separator,
        &quit,
    ]);
    let menu = Menu::with_items(app, &items)?;

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
        // GNOME shortcuts reach the running copy as arguments of a second one.
        // (XFCE's are grabbed directly; see linux/hotkeys.rs.)
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _| {
            #[cfg(target_os = "linux")]
            launcher::handle_shortcut_args(_app, &_args);
        }))
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
            quick_settings::quick_settings_status,
            quick_settings::set_quick_setting,
            quick_settings::open_system_settings,
            quick_settings::bluetooth_devices,
            quick_settings::bluetooth_device,
            taskbar::taskbar_supported,
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
            power::launcher_power,
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
            #[cfg(target_os = "linux")]
            linux::exit_on_signals(&handle);
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
