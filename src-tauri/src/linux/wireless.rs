//! Wi-Fi networks (NetworkManager) and Bluetooth devices (BlueZ) for wallp's
//! Quick Settings panel. The webview only sends an SSID, password or device
//! address, always as a single argument; nothing runs through a shell.
use crate::system_controls::{bluetooth, run, run_for};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    ssid: String,
    /// 0-100.
    signal: u8,
    /// "open", "password" or "enterprise".
    security: &'static str,
    saved: bool,
    connected: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum WifiAction {
    Connect {
        ssid: String,
        password: Option<String>,
    },
    Disconnect,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDevice {
    id: String,
    name: String,
    paired: bool,
    connected: bool,
    can_connect: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceAction {
    Pair,
    Connect,
    Disconnect,
    Forget,
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn desktop(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("System controls are only available from the desktop.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn wifi_networks(scan: bool) -> Result<Vec<WifiNetwork>, String> {
    blocking(move || networks(scan)).await
}

#[tauri::command]
pub async fn wifi_network(window: tauri::WebviewWindow, action: WifiAction) -> Result<(), String> {
    desktop(&window)?;
    blocking(move || wifi(action)).await
}

/// Split one line of `nmcli -t` output, where `:` and `\` in values are
/// escaped with a backslash.
fn fields(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => fields.last_mut().unwrap().extend(chars.next()),
            ':' => fields.push(String::new()),
            c => fields.last_mut().unwrap().push(c),
        }
    }
    fields
}

fn security(value: &str) -> &'static str {
    let value = value.trim();
    if value.is_empty() || value == "--" || value == "OWE" {
        "open"
    } else if value.contains("802.1X") {
        "enterprise"
    } else {
        "password"
    }
}

fn parse_networks(list: &str, saved: &[String]) -> Vec<WifiNetwork> {
    let mut networks: Vec<WifiNetwork> = Vec::new();
    for line in list.lines() {
        let [in_use, ssid, signal, kind] = fields(line).try_into().unwrap_or_default();
        // Hidden networks have no name to show or connect to.
        if ssid.is_empty() {
            continue;
        }
        let signal = signal.parse::<u8>().unwrap_or(0).min(100);
        let connected = in_use.trim() == "*";
        // nmcli lists every access point; show one entry per network name.
        match networks.iter_mut().find(|known| known.ssid == ssid) {
            Some(known) => {
                known.signal = known.signal.max(signal);
                known.connected |= connected;
            }
            None => networks.push(WifiNetwork {
                saved: saved.contains(&ssid),
                ssid,
                signal,
                security: security(&kind),
                connected,
            }),
        }
    }
    networks.sort_by(|a, b| {
        (!a.connected, std::cmp::Reverse(a.signal), a.ssid.to_lowercase()).cmp(&(
            !b.connected,
            std::cmp::Reverse(b.signal),
            b.ssid.to_lowercase(),
        ))
    });
    networks
}

fn wifi_on() -> Result<(), String> {
    match run("nmcli", &["radio", "wifi"])?.as_str() {
        "enabled" => Ok(()),
        _ => Err("Turn on Wi-Fi to see networks.".into()),
    }
}

/// NetworkManager names Wi-Fi profiles after their SSID by default.
fn saved_networks() -> Vec<String> {
    run("nmcli", &["-t", "-f", "NAME,TYPE", "connection", "show"])
        .map(|output| {
            output
                .lines()
                .map(fields)
                .filter(|f| f.len() == 2 && f[1] == "802-11-wireless")
                .map(|f| f[0].clone())
                .collect()
        })
        .unwrap_or_default()
}

fn networks(scan: bool) -> Result<Vec<WifiNetwork>, String> {
    wifi_on()?;
    let list = |rescan: &str| {
        run_for(
            "nmcli",
            &[
                "-t",
                "-f",
                "IN-USE,SSID,SIGNAL,SECURITY",
                "device",
                "wifi",
                "list",
                "--rescan",
                rescan,
            ],
            Duration::from_secs(30),
        )
    };
    // A scan can be refused while another one is running; show the cached list.
    let output = if scan {
        list("yes").or_else(|_| list("no"))?
    } else {
        list("no")?
    };
    Ok(parse_networks(&output, &saved_networks()))
}

fn wifi(action: WifiAction) -> Result<(), String> {
    match action {
        WifiAction::Disconnect => {
            let devices = run("nmcli", &["-t", "-f", "DEVICE,TYPE,STATE", "device"])?;
            let device = devices
                .lines()
                .map(fields)
                .find(|f| f.len() == 3 && f[1] == "wifi" && f[2] == "connected")
                .map(|f| f[0].clone())
                .ok_or("Wi-Fi is not connected.")?;
            run("nmcli", &["device", "disconnect", &device])?;
            Ok(())
        }
        WifiAction::Connect { ssid, password } => {
            if ssid.is_empty() || ssid.len() > 32 {
                return Err("Invalid network name.".into());
            }
            let password = password.filter(|password| !password.is_empty());
            if password.as_ref().is_some_and(|password| password.len() > 128) {
                return Err("That password is too long.".into());
            }
            // nmcli reuses a saved profile for this SSID, or creates one. It
            // only accepts a new password as an argument.
            let mut args = vec!["--wait", "40", "device", "wifi", "connect", ssid.as_str()];
            if let Some(password) = &password {
                args.extend(["password", password.as_str()]);
            }
            run_for("nmcli", &args, Duration::from_secs(45))
                .map(|_| ())
                .map_err(|error| connect_error(&ssid, &error))
        }
    }
}

fn connect_error(ssid: &str, error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("secrets were required")
        || lower.contains("no secrets")
        || lower.contains("psk")
        || lower.contains("password")
    {
        "Wrong or missing password.".into()
    } else if lower.contains("no network with ssid") {
        "That network is out of range. Refresh the list.".into()
    } else if lower.contains("802-1x") || lower.contains("802.1x") {
        "This network needs a sign-in wallp can't provide. Use Manage networks.".into()
    } else {
        format!("Could not connect to {ssid}: {}", error.trim_start_matches("nmcli: "))
    }
}

#[tauri::command]
pub async fn bluetooth_devices(scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    blocking(move || devices(scan)).await
}

#[tauri::command]
pub async fn bluetooth_device(
    window: tauri::WebviewWindow,
    id: String,
    action: DeviceAction,
) -> Result<(), String> {
    desktop(&window)?;
    if !valid_address(&id) {
        return Err("Invalid Bluetooth address.".into());
    }
    blocking(move || device(&id, action)).await
}

/// Only `AA:BB:CC:DD:EE:FF` reaches bluetoothctl, never free text.
fn valid_address(address: &str) -> bool {
    address.len() == 17
        && address.split(':').count() == 6
        && address
            .split(':')
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn parse_devices(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("Device ")?;
            let (address, name) = rest.split_once(' ').unwrap_or((rest, ""));
            if !valid_address(address) {
                return None;
            }
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

/// `devices Paired` needs BlueZ 5.65+; older versions have `paired-devices`.
fn paired() -> Result<Vec<String>, String> {
    let output = run("bluetoothctl", &["devices", "Paired"])
        .or_else(|_| run("bluetoothctl", &["paired-devices"]))?;
    Ok(parse_devices(&output).into_iter().map(|d| d.0).collect())
}

fn connected(addresses: &[String]) -> Vec<String> {
    if let Ok(output) = run("bluetoothctl", &["devices", "Connected"]) {
        return parse_devices(&output).into_iter().map(|d| d.0).collect();
    }
    addresses
        .iter()
        .filter(|address| {
            run("bluetoothctl", &["info", address.as_str()])
                .is_ok_and(|info| info.lines().any(|l| l.trim() == "Connected: yes"))
        })
        .cloned()
        .collect()
}

fn devices(scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    if !bluetooth()? {
        return Err("Turn on Bluetooth to see devices.".into());
    }
    if scan {
        // Discovered devices stay listed for ~30 s after discovery stops.
        run_for(
            "bluetoothctl",
            &["--timeout", "8", "scan", "on"],
            Duration::from_secs(12),
        )?;
    }
    let all = parse_devices(&run("bluetoothctl", &["devices"])?);
    let paired = paired()?;
    let connected = connected(&paired);
    let mut devices: Vec<_> = all
        .into_iter()
        .map(|(address, name)| BluetoothDevice {
            paired: paired.contains(&address),
            connected: connected.contains(&address),
            can_connect: true,
            id: address,
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

fn device(address: &str, action: DeviceAction) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_escaped_nmcli_fields() {
        assert_eq!(fields(r"*:Cafe\:Guest:72:WPA2"), ["*", "Cafe:Guest", "72", "WPA2"]);
        assert_eq!(fields(r":back\\slash:5:"), ["", r"back\slash", "5", ""]);
    }

    #[test]
    fn merges_access_points_and_classifies_security() {
        let list = "*:Home:60:WPA2\n:Home:80:WPA2\n:Cafe:40:\n:Office:90:WPA2 802.1X\n::30:WPA2";
        let networks = parse_networks(list, &["Home".to_string()]);
        assert_eq!(networks.len(), 3);
        assert_eq!(networks[0].ssid, "Home");
        assert!(networks[0].connected && networks[0].saved);
        assert_eq!(networks[0].signal, 80);
        assert_eq!(networks[1].security, "enterprise");
        assert_eq!(networks[2].security, "open");
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

    #[test]
    fn accepts_only_plain_bluetooth_addresses() {
        assert!(valid_address("14:B5:cd:BA:2D:4A"));
        assert!(!valid_address("14:B5:CD:BA:2D"));
        assert!(!valid_address("14:B5:CD:BA:2D:4G"));
        assert!(!valid_address("14:B5:CD:BA:2D:4A; rm"));
    }

    #[test]
    fn rejects_unknown_actions() {
        assert!(serde_json::from_str::<WifiAction>(r#"{"type":"command","ssid":"x"}"#).is_err());
        assert!(serde_json::from_str::<DeviceAction>(r#""remove""#).is_err());
        assert!(serde_json::from_str::<WifiAction>(r#"{"type":"disconnect"}"#).is_ok());
    }
}
