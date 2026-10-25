//! Hardware controls for wallp's custom Quick Settings panel, through the
//! desktop's own utilities. Never accept shell commands or settings URIs from
//! the webview. Missing hardware/services disable only their own control.
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioControl {
    name: String,
    kind: String,
    enabled: bool,
    controllable: bool,
}

#[derive(Serialize)]
pub struct AudioControl {
    volume: u8,
    muted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    radios: Vec<RadioControl>,
    radio_error: Option<String>,
    audio: Option<AudioControl>,
    audio_error: Option<String>,
    brightness: Option<u8>,
    brightness_error: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Radio {
        name: String,
        kind: String,
        enabled: bool,
    },
    Volume {
        value: u8,
    },
    Mute {
        enabled: bool,
    },
    Brightness {
        value: u8,
    },
}

const WIFI: &str = "Wi-Fi";
const BLUETOOTH: &str = "Bluetooth";

#[tauri::command]
pub async fn quick_settings_state() -> Result<Controls, String> {
    tauri::async_runtime::spawn_blocking(state)
        .await
        .map_err(|e| e.to_string())
}

fn state() -> Controls {
    // Read independently: one missing service must not disable the others.
    let (wifi, bluetooth, audio, brightness) = std::thread::scope(|s| {
        let wifi = s.spawn(wifi);
        let bluetooth = s.spawn(bluetooth);
        let audio = s.spawn(audio);
        let brightness = s.spawn(brightness);
        (
            wifi.join().unwrap(),
            bluetooth.join().unwrap(),
            audio.join().unwrap(),
            brightness.join().unwrap(),
        )
    });
    let mut radios = Vec::new();
    let mut radio_errors = Vec::new();
    match wifi {
        Ok(enabled) => radios.push(RadioControl {
            name: WIFI.into(),
            kind: "wifi".into(),
            enabled,
            controllable: true,
        }),
        Err(e) => radio_errors.push(e),
    }
    match bluetooth {
        Ok(enabled) => radios.push(RadioControl {
            name: BLUETOOTH.into(),
            kind: "bluetooth".into(),
            enabled,
            // A hardware block can't be cleared from software.
            controllable: enabled || !bluetooth_blocks().1,
        }),
        Err(e) => radio_errors.push(e),
    }
    let (audio, audio_error) = match audio {
        Ok(value) => (Some(value), None),
        Err(_) => (None, Some("No available audio output.".into())),
    };
    let (brightness, brightness_error) = match brightness {
        Ok(value) => (Some(value), None),
        Err(e) => (None, Some(e)),
    };
    Controls {
        radios,
        radio_error: (!radio_errors.is_empty()).then(|| radio_errors.join(" ")),
        audio,
        audio_error,
        brightness,
        brightness_error,
    }
}

#[tauri::command]
pub async fn set_quick_setting(window: tauri::WebviewWindow, change: Change) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("System controls are only available from the desktop.".into());
    }
    tauri::async_runtime::spawn_blocking(move || set(change))
        .await
        .map_err(|e| e.to_string())?
}

fn set(change: Change) -> Result<(), String> {
    match change {
        Change::Radio {
            name,
            kind,
            enabled,
        } => match (kind.as_str(), name.as_str()) {
            ("wifi", WIFI) => {
                run(
                    "nmcli",
                    &[
                        "--wait",
                        "8",
                        "radio",
                        "wifi",
                        if enabled { "on" } else { "off" },
                    ],
                )?;
            }
            ("bluetooth", BLUETOOTH) => set_bluetooth(enabled)?,
            ("wifi" | "bluetooth", _) => {
                return Err(
                    "The wireless adapter changed or is ambiguous. Refresh the panel.".into(),
                );
            }
            _ => return Err("Unknown radio type.".into()),
        },
        Change::Volume { value } => {
            if value > 100 {
                return Err("Volume must be between 0 and 100.".into());
            }
            let value = format!("{value}%");
            if run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &value]).is_err() {
                run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &value])?;
            }
        }
        Change::Mute { enabled } => {
            let value = if enabled { "1" } else { "0" };
            if run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", value]).is_err() {
                run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", value])?;
            }
        }
        Change::Brightness { value } => {
            if value > 100 {
                return Err("Brightness must be between 0 and 100.".into());
            }
            // 0% would turn the backlight off entirely.
            run(
                "brightnessctl",
                &["--class=backlight", "set", &format!("{}%", value.max(1))],
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn quick_settings_manage(target: String) -> Result<(), String> {
    let xfce = crate::linux::is_xfce();
    let (program, args): (&str, &[&str]) = match (target.as_str(), xfce) {
        ("wifi" | "network", true) => ("nm-connection-editor", &[]),
        ("bluetooth", true) => ("blueman-manager", &[]),
        ("sound", true) => ("pavucontrol", &[]),
        ("display", true) => ("xfce4-display-settings", &[]),
        ("power", true) => ("xfce4-power-manager-settings", &[]),
        // GNOME/Zorin settings are a separate process; do not wait for its window to close.
        ("wifi", false) => ("gnome-control-center", &["wifi"]),
        ("network", false) => ("gnome-control-center", &["network"]),
        ("bluetooth", false) => ("gnome-control-center", &["bluetooth"]),
        ("sound", false) => ("gnome-control-center", &["sound"]),
        ("display", false) => ("gnome-control-center", &["display"]),
        ("power", false) => ("gnome-control-center", &["power"]),
        _ => return Err("Unknown settings page.".into()),
    };
    launch(program, args)
}

fn wifi() -> Result<bool, String> {
    let devices = run("nmcli", &["-t", "-f", "TYPE", "device"])?;
    if !devices.lines().any(|line| line == "wifi") {
        return Err("No Wi-Fi adapter found.".into());
    }
    match run("nmcli", &["radio", "wifi"])?.as_str() {
        "enabled" => Ok(true),
        "disabled" => Ok(false),
        _ => Err("Wi-Fi status is unavailable.".into()),
    }
}

pub(crate) fn bluetooth() -> Result<bool, String> {
    // No `--timeout`: with it bluetoothctl always waits the full period.
    let output = run("bluetoothctl", &["show"])?;
    if output.lines().any(|l| l.trim() == "Powered: yes") {
        Ok(true)
    } else if output.lines().any(|l| l.trim() == "Powered: no") {
        // Includes "PowerState: off-blocked": turning it on clears the rfkill block.
        Ok(false)
    } else {
        Err("No Bluetooth adapter found.".into())
    }
}

/// (soft, hard) rfkill blocks across every Bluetooth switch, including laptop
/// vendor switches such as `ideapad_bluetooth`.
fn bluetooth_blocks() -> (bool, bool) {
    let (mut soft, mut hard) = (false, false);
    let Ok(entries) = std::fs::read_dir("/sys/class/rfkill") else {
        return (soft, hard);
    };
    let read = |path: std::path::PathBuf| std::fs::read_to_string(path).unwrap_or_default();
    for entry in entries.flatten() {
        let path = entry.path();
        if read(path.join("type")).trim() != "bluetooth" {
            continue;
        }
        soft |= read(path.join("soft")).trim() == "1";
        hard |= read(path.join("hard")).trim() == "1";
    }
    (soft, hard)
}

/// Clear the Bluetooth soft block without root. `/dev/rfkill` is writable by
/// the active session (logind ACL) or the netdev group on most desktops.
fn unblock_bluetooth() -> Result<(), String> {
    use std::io::Write;
    const RFKILL_TYPE_BLUETOOTH: u8 = 2;
    const RFKILL_OP_CHANGE_ALL: u8 = 3;
    // struct rfkill_event { u32 idx; u8 type, op, soft, hard; }
    let event = [
        0,
        0,
        0,
        0,
        RFKILL_TYPE_BLUETOOTH,
        RFKILL_OP_CHANGE_ALL,
        0,
        0,
    ];
    std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/rfkill")
        .and_then(|mut f| f.write_all(&event))
        .map_err(|e| {
            format!("Bluetooth is blocked and could not be unblocked ({e}). Run: rfkill unblock bluetooth")
        })?;
    let start = Instant::now();
    while bluetooth_blocks().0 && start.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn set_bluetooth(on: bool) -> Result<(), String> {
    if on {
        let (soft, hard) = bluetooth_blocks();
        if hard {
            return Err("Bluetooth is switched off in hardware. Turn off airplane mode (often Fn+F7) and try again.".into());
        }
        if soft {
            unblock_bluetooth()?;
        }
    }
    let state = if on { "on" } else { "off" };
    // BlueZ re-registers the adapter shortly after an unblock; retry briefly.
    let start = Instant::now();
    loop {
        match run("bluetoothctl", &["power", state]) {
            Ok(output) if output.contains("succeeded") => return Ok(()),
            result if start.elapsed() > Duration::from_secs(3) => {
                let detail = result.unwrap_or_else(|e| e);
                return Err(format!("Could not turn Bluetooth {state}: {detail}"));
            }
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
}

fn parse_audio(output: &str) -> Result<AudioControl, String> {
    let volume = output
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or("Could not read the default sound output.")?;
    Ok(AudioControl {
        volume: (volume * 100.0).round().clamp(0.0, 100.0) as u8,
        muted: output.contains("[MUTED]"),
    })
}

fn audio() -> Result<AudioControl, String> {
    // PulseAudio fallback also covers desktops without WirePlumber.
    if let Ok(output) = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"])
        && let Ok(audio) = parse_audio(&output)
    {
        return Ok(audio);
    }
    let volume = run("pactl", &["get-sink-volume", "@DEFAULT_SINK@"])?;
    let volume = volume
        .split_whitespace()
        .find_map(|word| word.strip_suffix('%').and_then(|v| v.parse::<u16>().ok()))
        .ok_or("Could not read output volume.")?
        .min(100) as u8;
    let muted = run("pactl", &["get-sink-mute", "@DEFAULT_SINK@"])?.trim() == "Mute: yes";
    Ok(AudioControl { volume, muted })
}

fn brightness() -> Result<u8, String> {
    // Restrict to backlights: keyboard LEDs are not display brightness.
    let current: f64 = run("brightnessctl", &["--class=backlight", "get"])?
        .parse()
        .map_err(|_| "No display backlight found.")?;
    let max: f64 = run("brightnessctl", &["--class=backlight", "max"])?
        .parse()
        .map_err(|_| "No display backlight found.")?;
    if !max.is_finite() || max <= 0.0 || !current.is_finite() {
        return Err("No display backlight found.".into());
    }
    Ok((current / max * 100.0).round().clamp(0.0, 100.0) as u8)
}

fn launch(program: &str, args: &[&str]) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not open system settings ({program}): {e}"))?;
    // Reap a long-lived settings process without blocking the command worker.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Bound external utilities so a stalled service cannot hold a request forever.
/// Drain both pipes while waiting, including on failure, to avoid pipe deadlocks.
pub(crate) fn run(program: &str, args: &[&str]) -> Result<String, String> {
    run_for(program, args, Duration::from_secs(15))
}

pub(crate) fn run_for(program: &str, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
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
    fn reads_audio_mute_and_clamps_amplification() {
        let audio = parse_audio("Volume: 0.42 [MUTED]").unwrap();
        assert_eq!(audio.volume, 42);
        assert!(audio.muted);
        assert_eq!(parse_audio("Volume: 1.50").unwrap().volume, 100);
        assert!(!parse_audio("Volume: 0.00").unwrap().muted);
        assert!(parse_audio("Volume: NaN").is_err());
        assert!(parse_audio("error").is_err());
    }

    #[test]
    fn rejects_untyped_and_out_of_range_changes() {
        assert!(serde_json::from_str::<Change>(r#"{"type":"command","value":"x"}"#).is_err());
        assert!(set(Change::Volume { value: 101 }).is_err());
        assert!(set(Change::Brightness { value: 255 }).is_err());
        assert!(
            set(Change::Radio {
                name: "Wi-Fi".into(),
                kind: "cellular".into(),
                enabled: true
            })
            .is_err()
        );
    }
}
