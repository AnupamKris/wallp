use super::*;

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
fn bluetooth() -> Result<bool, String> {
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
fn parse_devices(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("Device ")?;
            let (address, name) = rest.split_once(' ').unwrap_or((rest, ""));
            let name = name.trim();
            // BlueZ names unnamed devices after their address.
            let unnamed = name.is_empty() || name.replace('-', ":").eq_ignore_ascii_case(address);
            Some((
                address.to_string(),
                if unnamed {
                    String::new()
                } else {
                    name.to_string()
                },
            ))
        })
        .collect()
}
pub fn devices(scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    if !bluetooth()? {
        return Err("Turn on Bluetooth to see devices.".into());
    }
    if scan {
        // Discovered devices stay listed for ~30 s after discovery stops.
        run_for(
            "bluetoothctl",
            &["--timeout", "6", "scan", "on"],
            Duration::from_secs(10),
        )?;
    }
    let list = |filter: Option<&str>| -> Result<Vec<String>, String> {
        let mut args = vec!["devices"];
        args.extend(filter);
        Ok(parse_devices(&run("bluetoothctl", &args)?)
            .into_iter()
            .map(|d| d.0)
            .collect())
    };
    let paired = list(Some("Paired"))?;
    let connected = list(Some("Connected"))?;
    let mut devices: Vec<_> = parse_devices(&run("bluetoothctl", &["devices"])?)
        .into_iter()
        .map(|(address, name)| BluetoothDevice {
            paired: paired.contains(&address),
            connected: connected.contains(&address),
            address,
            name,
        })
        // Unnamed nearby beacons are noise; keep anything already paired.
        .filter(|d| d.paired || !d.name.is_empty())
        .collect();
    devices.sort_by(|a, b| {
        (!a.connected, !a.paired, a.name.to_lowercase()).cmp(&(
            !b.connected,
            !b.paired,
            b.name.to_lowercase(),
        ))
    });
    Ok(devices)
}
pub fn device(address: &str, action: DeviceAction) -> Result<(), String> {
    let bluez = |args: &[&str], ok: &[&str], limit: u64| -> Result<(), String> {
        let output = run_for("bluetoothctl", args, Duration::from_secs(limit))?;
        // bluetoothctl can exit 0 even when BlueZ rejected the request.
        if ok.iter().any(|ok| output.contains(ok)) {
            Ok(())
        } else {
            Err(output
                .lines()
                .last()
                .unwrap_or("Bluetooth request failed.")
                .to_string())
        }
    };
    match action {
        DeviceAction::Pair => {
            // NoInputNoOutput pairs headsets, mice and speakers without a PIN prompt.
            bluez(
                &["--agent", "NoInputNoOutput", "pair", address],
                &["Pairing successful"],
                30,
            )?;
            bluez(&["trust", address], &["succeeded"], 10)?;
            bluez(&["connect", address], &["Connection successful"], 20)
                .map_err(|e| format!("Paired, but could not connect: {e}"))
        }
        DeviceAction::Connect => bluez(&["connect", address], &["Connection successful"], 20),
        DeviceAction::Disconnect => bluez(
            &["disconnect", address],
            &["Disconnection successful", "Successful disconnected"],
            10,
        ),
        DeviceAction::Forget => bluez(&["remove", address], &["Device has been removed"], 10),
    }
}
fn parse_audio(output: &str) -> Result<Audio, String> {
    let volume = output
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or("Could not read the default sound output.")?;
    Ok(Audio {
        volume: (volume * 100.0).round().clamp(0.0, 100.0) as u8,
        muted: output.contains("[MUTED]"),
    })
}
fn audio() -> Result<Audio, String> {
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
    Ok(Audio { volume, muted })
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
pub fn status() -> Status {
    // Read independently: one missing service must not disable the others.
    std::thread::scope(|s| {
        let wifi = s.spawn(wifi);
        let bluetooth = s.spawn(bluetooth);
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
        Setting::Wifi(on) => {
            run(
                "nmcli",
                &[
                    "--wait",
                    "8",
                    "radio",
                    "wifi",
                    if on { "on" } else { "off" },
                ],
            )?;
        }
        Setting::Bluetooth(on) => set_bluetooth(on)?,
        Setting::Volume(value) => {
            let value = format!("{value}%");
            if run("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &value]).is_err() {
                run("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &value])?;
            }
        }
        Setting::Muted(on) => {
            let value = if on { "1" } else { "0" };
            if run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", value]).is_err() {
                run("pactl", &["set-sink-mute", "@DEFAULT_SINK@", value])?;
            }
        }
        Setting::Brightness(value) => {
            run(
                "brightnessctl",
                &["--class=backlight", "set", &format!("{}%", value.max(1))],
            )?;
        }
    }
    Ok(())
}
pub fn open(page: SettingsPage) -> Result<(), String> {
    let xfce = crate::linux::is_xfce();
    let (program, args): (&str, &[&str]) = if xfce {
        match page {
            SettingsPage::Wifi => ("nm-connection-editor", &[]),
            SettingsPage::Bluetooth => ("blueman-manager", &[]),
            SettingsPage::Sound => ("pavucontrol", &[]),
            SettingsPage::Display => ("xfce4-display-settings", &[]),
            SettingsPage::Power => ("xfce4-power-manager-settings", &[]),
        }
    } else {
        let panel = match page {
            SettingsPage::Wifi => "wifi",
            SettingsPage::Bluetooth => "bluetooth",
            SettingsPage::Sound => "sound",
            SettingsPage::Display => "display",
            SettingsPage::Power => "power",
        };
        // GNOME/Zorin settings are a separate process; do not wait for its window to close.
        return launch("gnome-control-center", &[panel]);
    };
    launch(program, args)
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
    fn parses_devices_and_hides_address_names() {
        let devices = parse_devices(
            "Device AA:BB:CC:DD:EE:01 WH-1000XM4\nDevice AA:BB:CC:DD:EE:02 AA-BB-CC-DD-EE-02\nnoise",
        );
        assert_eq!(devices.len(), 2);
        assert_eq!(
            devices[0],
            ("AA:BB:CC:DD:EE:01".into(), "WH-1000XM4".into())
        );
        assert_eq!(devices[1].1, "");
    }
}
