//! Hardware controls for wallp's custom Quick Settings panel.
use serde::{Deserialize, Serialize};
use std::{
    os::windows::process::CommandExt,
    process::Command,
    time::{Duration, Instant},
};
use windows::{
    Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState},
    Win32::{
        Media::Audio::{
            Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator, eConsole,
            eRender,
        },
        System::{
            Com::{CLSCTX_ALL, CoCreateInstance},
            WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        },
    },
};

pub(crate) struct Runtime;
impl Runtime {
    pub(crate) fn new() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioControl {
    name: String,
    kind: String,
    enabled: bool,
    controllable: bool,
}

fn radios() -> windows::core::Result<Vec<RadioControl>> {
    let radios = Radio::GetRadiosAsync()?.join()?;
    let mut result = Vec::new();
    for radio in radios {
        let kind = match radio.Kind()? {
            RadioKind::WiFi => "wifi",
            RadioKind::Bluetooth => "bluetooth",
            _ => continue,
        };
        let state = radio.State()?;
        result.push(RadioControl {
            name: radio.Name()?.to_string(),
            kind: kind.into(),
            enabled: state == RadioState::On,
            controllable: state == RadioState::On || state == RadioState::Off,
        });
    }
    Ok(result)
}

unsafe fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)?
            .Activate(CLSCTX_ALL, None)
    }
}

#[derive(Serialize)]
pub struct AudioControl {
    volume: u8,
    muted: bool,
}

// Fixed scripts only. The only interpolated value is a validated integer.
// CREATE_NO_WINDOW prevents a console flash on the desktop.
fn brightness_script(script: &str) -> Result<String, String> {
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not access display brightness: {e}"))?;
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Display brightness did not respond.".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("This display does not expose Windows brightness controls.".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
const FIND_DISPLAY: &str = "$ErrorActionPreference='Stop'; $b=Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness | Where-Object Active | Select-Object -First 1; if($null -eq $b){throw 'No supported display'};";

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

#[tauri::command]
pub async fn quick_settings_state() -> Result<Controls, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _runtime = Runtime::new()?;
        let (radios, radio_error) = match radios() {
            Ok(value) => (value, None),
            Err(e) => (vec![], Some(format!("Could not read wireless radios: {e}"))),
        };
        let audio = unsafe {
            endpoint().and_then(|device| {
                Ok(AudioControl {
                    volume: (device.GetMasterVolumeLevelScalar()? * 100.0).round() as u8,
                    muted: device.GetMute()?.as_bool(),
                })
            })
        };
        let (audio, audio_error) = match audio {
            Ok(value) => (Some(value), None),
            Err(_) => (None, Some("No available audio output.".into())),
        };
        let brightness = brightness_script(&format!("{FIND_DISPLAY} [int]$b.CurrentBrightness"))
            .and_then(|value| {
                value
                    .parse::<u8>()
                    .map_err(|_| "Could not read display brightness.".into())
            });
        let (brightness, brightness_error) = match brightness {
            Ok(value) => (Some(value), None),
            Err(e) => (None, Some(e)),
        };
        Ok(Controls {
            radios,
            radio_error,
            audio,
            audio_error,
            brightness,
            brightness_error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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

#[tauri::command]
pub async fn set_quick_setting(window: tauri::WebviewWindow, change: Change) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("System controls are only available from the desktop.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _runtime = Runtime::new()?;
        match change {
            Change::Radio { name, kind, enabled } => {
                let kind = match kind.as_str() { "wifi" => RadioKind::WiFi, "bluetooth" => RadioKind::Bluetooth, _ => return Err("Unknown radio type.".into()) };
                if Radio::RequestAccessAsync().and_then(|op| op.join()).map_err(|e| e.to_string())? != RadioAccessStatus::Allowed { return Err("Windows denied radio control. Check device permissions or use Manage devices.".into()); }
                let mut matches = Vec::new();
                for radio in Radio::GetRadiosAsync().and_then(|op| op.join()).map_err(|e| e.to_string())? {
                    if radio.Kind().map_err(|e| e.to_string())? == kind && radio.Name().map_err(|e| e.to_string())?.to_string() == name { matches.push(radio); }
                }
                if matches.len() != 1 { return Err("The wireless adapter changed or is ambiguous. Refresh the panel.".into()); }
                let radio = &matches[0];
                let desired = if enabled { RadioState::On } else { RadioState::Off };
                let access = radio.SetStateAsync(desired).and_then(|op| op.join()).map_err(|e| e.to_string())?;
                if access != RadioAccessStatus::Allowed { return Err("Windows or a hardware switch blocked this change.".into()); }
                // Some adapters apply changes after the operation completes.
                for _ in 0..20 {
                    if radio.State().map_err(|e| e.to_string())? == desired { return Ok(()); }
                    std::thread::sleep(Duration::from_millis(100));
                }
                return Err("The adapter has not applied the change. Refresh and check its hardware switch.".into());
            }
            Change::Volume { value } => {
                if value > 100 { return Err("Volume must be between 0 and 100.".into()); }
                unsafe { endpoint().and_then(|device| device.SetMasterVolumeLevelScalar(value as f32 / 100.0, std::ptr::null())) }.map_err(|e| e.to_string())?;
            }
            Change::Mute { enabled } => { unsafe { endpoint().and_then(|device| device.SetMute(enabled, std::ptr::null())) }.map_err(|e| e.to_string())?; }
            Change::Brightness { value } => {
                if value > 100 { return Err("Brightness must be between 0 and 100.".into()); }
                brightness_script(&format!("{FIND_DISPLAY} $m=Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods | Where-Object {{$_.InstanceName -eq $b.InstanceName}} | Select-Object -First 1; if($null -eq $m){{throw 'No display controls'}}; $r=Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{{Brightness=[byte]{value};Timeout=[uint32]0}}; if($r.ReturnValue -ne 0){{throw 'Display rejected brightness'}}"))?;
            }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn quick_settings_manage(target: String) -> Result<(), String> {
    let uri = match target.as_str() {
        "wifi" => "ms-settings:network-wifi",
        "bluetooth" => "ms-settings:bluetooth",
        "sound" => "ms-settings:sound",
        "display" => "ms-settings:display",
        "network" => "ms-settings:network",
        "power" => "ms-settings:powersleep",
        _ => return Err("Unknown settings page.".into()),
    };
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Read-only hardware smoke test: never switches a radio or changes a level.
    #[test]
    fn reads_hardware_controls() {
        let state =
            tauri::async_runtime::block_on(quick_settings_state()).expect("read device controls");
        assert!(state.audio.as_ref().is_none_or(|audio| audio.volume <= 100));
        assert!(state.brightness.is_none_or(|level| level <= 100));
        assert!(
            state
                .radios
                .iter()
                .all(|radio| matches!(radio.kind.as_str(), "wifi" | "bluetooth"))
        );
        println!(
            "Radios: {}; audio available: {}; brightness available: {}",
            state.radios.len(),
            state.audio.is_some(),
            state.brightness.is_some()
        );
        if let Some(error) = state.radio_error {
            println!("Radio read: {error}");
        }
        if let Some(error) = state.brightness_error {
            println!("Brightness read: {error}");
        }
    }
}
