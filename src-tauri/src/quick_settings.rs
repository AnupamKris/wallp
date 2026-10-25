//! Small, typed system controls. Never accept shell commands or settings URIs
//! from the webview. Missing hardware/services disable only their own control.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Control<T> {
    value: Option<T>,
    error: Option<String>,
}
impl<T> From<Result<T, String>> for Control<T> {
    fn from(value: Result<T, String>) -> Self {
        match value {
            Ok(value) => Self {
                value: Some(value),
                error: None,
            },
            Err(error) => Self {
                value: None,
                error: Some(error),
            },
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    volume: u8,
    muted: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    wifi: Control<bool>,
    bluetooth: Control<bool>,
    audio: Control<Audio>,
    brightness: Control<u8>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Setting {
    Wifi(bool),
    Bluetooth(bool),
    Volume(u8),
    Muted(bool),
    Brightness(u8),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDevice {
    address: String,
    name: String,
    paired: bool,
    connected: bool,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceAction {
    Pair,
    Connect,
    Disconnect,
    Forget,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsPage {
    Wifi,
    Bluetooth,
    Sound,
    Display,
    Power,
}

#[tauri::command]
pub async fn quick_settings_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(platform::status)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn set_quick_setting(setting: Setting) -> Result<(), String> {
    validate(&setting)?;
    tauri::async_runtime::spawn_blocking(move || platform::set(setting))
        .await
        .map_err(|e| e.to_string())?
}
fn validate(setting: &Setting) -> Result<(), String> {
    match setting {
        Setting::Volume(value) | Setting::Brightness(value) if *value > 100 => {
            Err("Choose a value between 0 and 100.".into())
        }
        _ => Ok(()),
    }
}
/// Lists known devices; `scan` first runs a short discovery so new devices appear.
#[tauri::command]
pub async fn bluetooth_devices(scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::devices(scan))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bluetooth_device(address: String, action: DeviceAction) -> Result<(), String> {
    if !valid_address(&address) {
        return Err("Invalid Bluetooth address.".into());
    }
    tauri::async_runtime::spawn_blocking(move || platform::device(&address, action))
        .await
        .map_err(|e| e.to_string())?
}
/// Only `AA:BB:CC:DD:EE:FF` reaches a utility, never free text.
fn valid_address(address: &str) -> bool {
    address.len() == 17
        && address.split(':').count() == 6
        && address
            .split(':')
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}
#[tauri::command]
pub async fn open_system_settings(page: SettingsPage) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::open(page))
        .await
        .map_err(|e| e.to_string())?
}

/// Bound external utilities so a stalled service cannot hold a request forever.
/// Drain both pipes while waiting, including on failure, to avoid pipe deadlocks.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    run_for(program, args, Duration::from_secs(15))
}
fn run_for(program: &str, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| format!("{program}: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = std::thread::spawn(move || {
        let mut v = String::new();
        let _ = stdout.read_to_string(&mut v);
        v
    });
    let errors = std::thread::spawn(move || {
        let mut v = String::new();
        let _ = stderr.read_to_string(&mut v);
        v
    });
    let start = Instant::now();
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(40)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "{program} timed out. Try again or use system settings."
                ));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let stdout = output.join().unwrap_or_default();
    let stderr = errors.join().unwrap_or_default();
    if result?.success() {
        Ok(stdout.trim().into())
    } else {
        Err(format!(
            "{program}: {}",
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_out_of_range_and_untyped_actions() {
        assert!(validate(&Setting::Volume(101)).is_err());
        assert!(validate(&Setting::Brightness(255)).is_err());
        assert!(validate(&Setting::Volume(0)).is_ok());
        assert!(validate(&Setting::Brightness(100)).is_ok());
        assert!(
            serde_json::from_str::<Setting>(r#"{"kind":"command","value":"anything"}"#).is_err()
        );
        assert!(serde_json::from_str::<SettingsPage>(r#""file:///tmp/test""#).is_err());
    }
    #[test]
    fn accepts_only_plain_bluetooth_addresses() {
        assert!(valid_address("14:B5:cd:BA:2D:4A"));
        assert!(!valid_address("14:B5:CD:BA:2D"));
        assert!(!valid_address("14:B5:CD:BA:2D:4G"));
        assert!(!valid_address("14:B5:CD:BA:2D:4A; rm"));
        assert!(!valid_address("14:B5:CD:BA:2D:4A:0"));
    }
    #[test]
    fn failed_control_has_no_fabricated_value() {
        let control: Control<bool> = Err("No adapter".to_string()).into();
        assert!(control.value.is_none());
        assert_eq!(control.error.as_deref(), Some("No adapter"));
    }
}
