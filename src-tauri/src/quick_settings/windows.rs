use super::*;
use ::windows::{
    Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState},
    Win32::{
        Media::Audio::{
            Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator, eConsole,
            eRender,
        },
        System::Com::{
            CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
        },
    },
};

fn radios(kind: RadioKind) -> Result<Vec<Radio>, String> {
    let radios = Radio::GetRadiosAsync()
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    for radio in radios {
        if radio.Kind().map_err(|e| e.to_string())? == kind {
            found.push(radio);
        }
    }
    if found.is_empty() {
        return Err("No compatible radio adapter found. Use system settings.".into());
    }
    Ok(found)
}
fn radio_status(kind: RadioKind) -> Result<bool, String> {
    let mut on = false;
    for radio in radios(kind)? {
        let state = radio.State().map_err(|e| e.to_string())?;
        if state == RadioState::Disabled || state == RadioState::Unknown {
            return Err("Radio is disabled by hardware or system policy.".into());
        }
        on |= state == RadioState::On;
    }
    Ok(on)
}
fn set_radio(kind: RadioKind, on: bool) -> Result<(), String> {
    let access = Radio::RequestAccessAsync()
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|e| e.to_string())?;
    if access != RadioAccessStatus::Allowed {
        return Err("Windows denied radio access. Use system settings.".into());
    }
    for radio in radios(kind)? {
        let result = radio
            .SetStateAsync(if on { RadioState::On } else { RadioState::Off })
            .map_err(|e| e.to_string())?
            .join()
            .map_err(|e| e.to_string())?;
        if result != RadioAccessStatus::Allowed {
            return Err(
                "Windows could not change the radio. Check hardware switches and system settings."
                    .into(),
            );
        }
    }
    Ok(())
}
struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
fn endpoint<T>(
    f: impl FnOnce(IAudioEndpointVolume) -> ::windows::core::Result<T>,
) -> Result<T, String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _com = Com;
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        let endpoint = device
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;
        f(endpoint).map_err(|e| e.to_string())
    }
}
fn audio() -> Result<Audio, String> {
    endpoint(|endpoint| unsafe {
        Ok(Audio {
            volume: (endpoint.GetMasterVolumeLevelScalar()? * 100.0)
                .round()
                .clamp(0.0, 100.0) as u8,
            muted: endpoint.GetMute()?.as_bool(),
        })
    })
}
fn powershell(script: &str) -> Result<String, String> {
    // Only fixed scripts and validated numeric brightness values reach here.
    run(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("$ErrorActionPreference='Stop'; {script}"),
        ],
    )
}
fn brightness() -> Result<u8, String> {
    powershell("$b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1; if ($null -eq $b) { throw 'No supported display backlight found.' }; $b.CurrentBrightness")?
        .parse().map_err(|_| "Display brightness is unavailable. Use display settings.".into())
}
pub fn status() -> Status {
    std::thread::scope(|s| {
        let wifi = s.spawn(|| radio_status(RadioKind::WiFi));
        let bluetooth = s.spawn(|| radio_status(RadioKind::Bluetooth));
        let audio = s.spawn(audio);
        let brightness = s.spawn(brightness);
        Status {
            wifi: wifi.join().unwrap().into(),
            bluetooth: bluetooth.join().unwrap().into(),
            audio: audio.join().unwrap().into(),
            brightness: brightness.join().unwrap().into(),
        }
    })
}
pub fn set(setting: Setting) -> Result<(), String> {
    match setting {
        Setting::Wifi(on) => set_radio(RadioKind::WiFi, on),
        Setting::Bluetooth(on) => set_radio(RadioKind::Bluetooth, on),
        Setting::Volume(value) => endpoint(|e| unsafe {
            e.SetMasterVolumeLevelScalar(value as f32 / 100.0, std::ptr::null())
        }),
        Setting::Muted(on) => endpoint(|e| unsafe { e.SetMute(on, std::ptr::null()) }),
        Setting::Brightness(value) => {
            powershell(&format!(
                "$b = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods); if ($b.Count -eq 0) {{ throw 'No supported display backlight found.' }}; $b | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=[uint32]0; Brightness=[byte]{}}} | Out-Null",
                value.max(1)
            ))?;
            Ok(())
        }
    }
}
// Windows pairing needs its consent UI; the panel links to Settings instead.
pub fn devices(_scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    Err("Pair devices in Windows Bluetooth settings.".into())
}
pub fn device(_address: &str, _action: DeviceAction) -> Result<(), String> {
    Err("Pair devices in Windows Bluetooth settings.".into())
}
pub fn open(page: SettingsPage) -> Result<(), String> {
    let uri = match page {
        SettingsPage::Wifi => "ms-settings:network-wifi",
        SettingsPage::Bluetooth => "ms-settings:bluetooth",
        SettingsPage::Sound => "ms-settings:sound",
        SettingsPage::Display => "ms-settings:display",
        SettingsPage::Power => "ms-settings:powersleep",
    };
    use tauri_plugin_opener::open_url;
    open_url(uri, None::<&str>).map_err(|e| e.to_string())
}
