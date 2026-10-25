//! Tray icons on GNOME are StatusNotifierItems, collected by the AppIndicator
//! extension's `org.kde.StatusNotifierWatcher`. D-Bus says which process owns
//! each item; `/proc` identifies it so a reused PID is never ended by mistake.
use dbus::blocking::{Connection, stdintf::org_freedesktop_dbus::Properties};
use serde::Serialize;
use std::{path::Path, time::Duration};

const TIMEOUT: Duration = Duration::from_millis(800);
/// The desktop's own processes; ending them would end the session, its
/// services or its panel. `wrapper-2.0` hosts XFCE panel plugins.
const SHELL: [&str; 11] = [
    "gnome-shell",
    "gnome-session-binary",
    "gnome-session",
    "systemd",
    "xfce4-session",
    "xfwm4",
    "xfce4-panel",
    "xfdesktop",
    "xfsettingsd",
    "xfconfd",
    "wrapper-2.0",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayApp {
    pid: u32,
    started: String,
    name: String,
    tooltip: String,
    path: String,
    blocked_reason: Option<String>,
    icon: Option<String>,
}

type Pixmaps = Vec<(i32, i32, Vec<u8>)>;

/// Watcher entries are `:1.42/org/ayatana/...`, `:1.42@/path`, or a bare bus
/// name using the default object path.
fn split_item(item: &str) -> (String, String) {
    match item.find('/') {
        Some(i) => (
            item[..i].trim_end_matches('@').to_string(),
            item[i..].to_string(),
        ),
        None => (item.to_string(), "/StatusNotifierItem".to_string()),
    }
}

/// Start time in clock ticks since boot: with the PID, a stable identity.
fn started(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = stat.rsplit_once(')')?;
    rest.split_whitespace().nth(19).map(str::to_string)
}

fn owner_uid(pid: u32) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(format!("/proc/{pid}"))
        .ok()
        .map(|m| m.uid())
}

fn executable(pid: u32) -> String {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .map(|p| p.display().to_string())
        .or_else(|_| {
            std::fs::read_to_string(format!("/proc/{pid}/comm")).map(|c| c.trim().to_string())
        })
        .unwrap_or_default()
}

fn pixmap_icon(pixmaps: Pixmaps) -> Option<String> {
    // Closest to 64px wins; anything bigger is scaled down when encoded.
    let (w, h, argb) = pixmaps
        .into_iter()
        .filter(|(w, h, data)| *w > 0 && *h > 0 && data.len() == (*w * *h * 4) as usize)
        .min_by_key(|(w, _, _)| (w - 64).abs())?;
    // Network byte order ARGB to RGBA.
    let rgba = argb
        .chunks_exact(4)
        .flat_map(|p| [p[1], p[2], p[3], p[0]])
        .collect();
    crate::linux::apps::png_data_url(&image::RgbaImage::from_raw(w as u32, h as u32, rgba)?)
}

fn enumerate() -> Result<Vec<TrayApp>, String> {
    let conn =
        Connection::new_session().map_err(|e| format!("Couldn't reach the session bus: {e}"))?;
    let watcher = conn.with_proxy(
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        TIMEOUT,
    );
    let items: Vec<String> = watcher
        .get(
            "org.kde.StatusNotifierWatcher",
            "RegisteredStatusNotifierItems",
        )
        .map_err(|_| {
            if crate::linux::is_xfce() {
                "No system tray is running. Add a Status Tray plugin to the XFCE panel."
            } else {
                "No system tray is running. Enable the AppIndicator extension in GNOME Extensions."
            }
        })?;
    let bus = conn.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", TIMEOUT);
    let uid = unsafe { libc::getuid() };
    let mut apps = Vec::new();
    for item in items {
        let (name, path) = split_item(&item);
        let Ok((pid,)) = bus.method_call::<(u32,), _, _, _>(
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            (name.as_str(),),
        ) else {
            continue;
        };
        let Some(started) = started(pid) else {
            continue;
        };
        let proxy = conn.with_proxy(name.as_str(), path.as_str(), TIMEOUT);
        let interface = [
            "org.kde.StatusNotifierItem",
            "org.freedesktop.StatusNotifierItem",
        ]
        .into_iter()
        .find(|i| proxy.get::<String>(i, "Id").is_ok())
        .unwrap_or("org.kde.StatusNotifierItem");
        let text = |key: &str| proxy.get::<String>(interface, key).unwrap_or_default();
        let exe = executable(pid);
        let program = Path::new(&exe)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let title = [text("Title"), text("Id"), program.clone()]
            .into_iter()
            .find(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("Process {pid}"));
        let tooltip = proxy
            .get::<(String, Pixmaps, String, String)>(interface, "ToolTip")
            .map(|(_, _, title, body)| if title.is_empty() { body } else { title })
            .unwrap_or_default();
        let blocked_reason = if pid == std::process::id() {
            Some("Use Quit wallp from its tray menu".into())
        } else if SHELL.contains(&program.as_str()) || program.starts_with("gsd-") {
            Some(
                if crate::linux::is_xfce() {
                    "XFCE desktop"
                } else {
                    "GNOME shell"
                }
                .into(),
            )
        } else if program == "xdg-dbus-proxy" {
            Some("Sandboxed app: quit it from its own menu".into())
        } else if owner_uid(pid) != Some(uid) {
            Some("Runs as another user".into())
        } else {
            None
        };
        let icon_name = text("IconName");
        let theme_path = text("IconThemePath");
        let icon = proxy
            .get::<Pixmaps>(interface, "IconPixmap")
            .ok()
            .and_then(pixmap_icon)
            .or_else(|| {
                (!icon_name.is_empty()).then(|| {
                    crate::linux::apps::icon_named(
                        &icon_name,
                        (!theme_path.is_empty()).then(|| Path::new(&theme_path)),
                    )
                })?
            });
        apps.push(TrayApp {
            pid,
            started,
            name: title,
            tooltip,
            path: exe,
            blocked_reason,
            icon,
        });
    }
    apps.sort_by_key(|app| (app.name.to_lowercase(), app.pid));
    apps.dedup_by_key(|app| app.pid);
    Ok(apps)
}

#[tauri::command]
pub async fn list_tray_apps() -> Result<Vec<TrayApp>, String> {
    tauri::async_runtime::spawn_blocking(enumerate)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn end_tray_app(pid: u32, started: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = enumerate()?
            .into_iter()
            .find(|app| app.pid == pid && app.started == started)
            .ok_or("This tray app has exited or changed. Refresh and try again.")?;
        if let Some(reason) = app.blocked_reason {
            return Err(reason);
        }
        if self::started(pid).as_deref() != Some(started.as_str()) {
            return Err("The process changed. Refresh and try again.".into());
        }
        if unsafe { libc::kill(pid as i32, libc::SIGKILL) } != 0 {
            return Err(format!(
                "Couldn't end {}: {}",
                app.name,
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_watcher_entries() {
        assert_eq!(
            split_item(":1.115@/org/ayatana/NotificationItem/x"),
            (":1.115".into(), "/org/ayatana/NotificationItem/x".into())
        );
        assert_eq!(
            split_item(":1.9/StatusNotifierItem"),
            (":1.9".into(), "/StatusNotifierItem".into())
        );
        assert_eq!(
            split_item("org.kde.StatusNotifierItem-1-1"),
            (
                "org.kde.StatusNotifierItem-1-1".into(),
                "/StatusNotifierItem".into()
            )
        );
    }

    #[test]
    fn reads_this_process_identity() {
        let pid = std::process::id();
        assert!(started(pid).is_some_and(|s| s.parse::<u64>().is_ok()));
        assert_eq!(owner_uid(pid), Some(unsafe { libc::getuid() }));
    }

    #[test]
    fn converts_argb_pixmaps() {
        let url = pixmap_icon(vec![(1, 1, vec![255, 10, 20, 30])]).unwrap();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }
}
