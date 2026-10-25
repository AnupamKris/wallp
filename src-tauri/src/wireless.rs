//! Wi-Fi networks and Bluetooth devices for wallp's Quick Settings panel.
//! The webview only sends an SSID, password or device id; nothing it sends is
//! run as a command.
use crate::system_controls::Runtime;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use windows::{
    Devices::{
        Enumeration::{
            DeviceInformation, DeviceInformationCustomPairing, DeviceInformationKind,
            DeviceInformationUpdate, DevicePairingKinds, DevicePairingRequestedEventArgs,
            DevicePairingResultStatus, DeviceUnpairingResultStatus, DeviceWatcher,
        },
        Radios::{Radio, RadioKind, RadioState},
        WiFi::{WiFiAccessStatus, WiFiAdapter, WiFiConnectionStatus, WiFiReconnectionKind},
    },
    Foundation::{IReference, TypedEventHandler},
    Networking::Connectivity::{NetworkAuthenticationType, NetworkInformation},
    Security::Credentials::PasswordCredential,
    Win32::{
        Foundation::PROPERTYKEY,
        Media::{
            Audio::{
                DEVICE_STATE, DEVICE_STATE_ACTIVE, DEVICE_STATE_UNPLUGGED, IDeviceTopology,
                IMMDevice, IMMDeviceEnumerator, IPart, MMDeviceEnumerator, eAll,
            },
            KernelStreaming::{
                IKsControl, KSIDENTIFIER, KSIDENTIFIER_0, KSIDENTIFIER_0_0,
                KSPROPERTY_ONESHOT_DISCONNECT, KSPROPERTY_ONESHOT_RECONNECT, KSPROPERTY_TYPE_GET,
                KSPROPSETID_BtAudio,
            },
        },
        System::Com::{
            CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ,
            StructuredStorage::{PropVariantClear, PropVariantToGUID},
        },
    },
    core::{GUID, HSTRING, Interface, PCWSTR, Ref},
};
use windows_collections::IIterable;

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
    /// Windows can only connect and disconnect Bluetooth audio devices.
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
    tauri::async_runtime::spawn_blocking(move || {
        let _runtime = Runtime::new()?;
        work()
    })
    .await
    .map_err(|e| e.to_string())?
}

fn desktop(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("System controls are only available from the desktop.".into());
    }
    Ok(())
}

fn text(error: windows::core::Error) -> String {
    error.message()
}

fn radio_on(kind: RadioKind) -> bool {
    // If radios can't be read, let the adapter calls report the problem.
    Radio::GetRadiosAsync()
        .and_then(|op| op.join())
        .map(|radios| {
            radios.into_iter().any(|radio| {
                radio.Kind().ok() == Some(kind) && radio.State().ok() == Some(RadioState::On)
            })
        })
        .unwrap_or(true)
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

const LOCATION: &str = "Windows blocked Wi-Fi access. Turn on Location and \"Let desktop apps access your location\" in Settings > Privacy & security > Location.";

fn adapter() -> Result<WiFiAdapter, String> {
    if !radio_on(RadioKind::WiFi) {
        return Err("Turn on Wi-Fi to see networks.".into());
    }
    let access = WiFiAdapter::RequestAccessAsync()
        .and_then(|op| op.join())
        .map_err(text)?;
    if access != WiFiAccessStatus::Allowed {
        return Err(LOCATION.into());
    }
    let adapters = WiFiAdapter::FindAllAdaptersAsync()
        .and_then(|op| op.join())
        .map_err(text)?;
    if adapters.Size().map_err(text)? == 0 {
        return Err("No Wi-Fi adapter found.".into());
    }
    adapters.GetAt(0).map_err(text)
}

fn connected_ssid(adapter: &WiFiAdapter) -> Option<String> {
    let profile = adapter
        .NetworkAdapter()
        .ok()?
        .GetConnectedProfileAsync()
        .ok()?
        .join()
        .ok()?;
    let ssid = profile
        .WlanConnectionProfileDetails()
        .ok()?
        .GetConnectedSsid()
        .ok()?;
    Some(ssid.to_string())
}

/// Windows names Wi-Fi profiles after their SSID.
fn saved_networks() -> HashSet<String> {
    NetworkInformation::GetConnectionProfiles()
        .map(|profiles| {
            profiles
                .into_iter()
                .filter(|profile| profile.IsWlanConnectionProfile().unwrap_or(false))
                .filter_map(|profile| profile.ProfileName().ok())
                .map(|name| name.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn security_kind(kind: NetworkAuthenticationType) -> &'static str {
    match kind {
        NetworkAuthenticationType::None
        | NetworkAuthenticationType::Open80211
        | NetworkAuthenticationType::Owe => "open",
        NetworkAuthenticationType::Wpa
        | NetworkAuthenticationType::Rsna
        | NetworkAuthenticationType::Wpa3Enterprise
        | NetworkAuthenticationType::Wpa3Enterprise192Bits
        | NetworkAuthenticationType::Ihv => "enterprise",
        _ => "password",
    }
}

fn networks(scan: bool) -> Result<Vec<WifiNetwork>, String> {
    let adapter = adapter()?;
    if scan {
        adapter.ScanAsync().and_then(|op| op.join()).map_err(text)?;
    }
    let connected = connected_ssid(&adapter);
    let saved = saved_networks();
    let mut networks: Vec<WifiNetwork> = Vec::new();
    let report = adapter
        .NetworkReport()
        .and_then(|report| report.AvailableNetworks())
        .map_err(text)?;
    for network in report {
        let Ok(ssid) = network.Ssid().map(|ssid| ssid.to_string()) else {
            continue;
        };
        // Hidden networks have no name to show or connect to.
        if ssid.is_empty() {
            continue;
        }
        let rssi = network.NetworkRssiInDecibelMilliwatts().unwrap_or(-100.0);
        let signal = ((rssi + 100.0) * 2.0).clamp(0.0, 100.0) as u8;
        let security = network
            .SecuritySettings()
            .and_then(|settings| settings.NetworkAuthenticationType())
            .map(security_kind)
            .unwrap_or("password");
        // One entry per network name, from its strongest access point.
        match networks.iter_mut().find(|known| known.ssid == ssid) {
            Some(known) => known.signal = known.signal.max(signal),
            None => networks.push(WifiNetwork {
                connected: connected.as_deref() == Some(ssid.as_str()),
                saved: saved.contains(&ssid),
                ssid,
                signal,
                security,
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
    Ok(networks)
}

fn wifi(action: WifiAction) -> Result<(), String> {
    let adapter = adapter()?;
    let (ssid, password) = match action {
        WifiAction::Disconnect => return adapter.Disconnect().map_err(text),
        WifiAction::Connect { ssid, password } => (ssid, password),
    };
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("Invalid network name.".into());
    }
    let password = password.filter(|password| !password.is_empty());
    if password.as_ref().is_some_and(|password| password.len() > 128) {
        return Err("That password is too long.".into());
    }
    let network = adapter
        .NetworkReport()
        .and_then(|report| report.AvailableNetworks())
        .map_err(text)?
        .into_iter()
        .filter(|network| network.Ssid().is_ok_and(|name| name.to_string() == ssid))
        .max_by(|a, b| {
            let rssi = |n: &windows::Devices::WiFi::WiFiAvailableNetwork| {
                n.NetworkRssiInDecibelMilliwatts().unwrap_or(-100.0)
            };
            rssi(a).total_cmp(&rssi(b))
        })
        .ok_or("That network is out of range. Refresh the list.")?;
    let kind = WiFiReconnectionKind::Automatic;
    let status = match password {
        Some(password) => {
            let credential = PasswordCredential::new().map_err(text)?;
            credential
                .SetPassword(&HSTRING::from(password))
                .map_err(text)?;
            adapter.ConnectWithPasswordCredentialAsync(&network, kind, &credential)
        }
        None => adapter.ConnectAsync(&network, kind),
    }
    .and_then(|op| op.join())
    .and_then(|result| result.ConnectionStatus())
    .map_err(text)?;
    match status {
        WiFiConnectionStatus::Success => Ok(()),
        WiFiConnectionStatus::InvalidCredential => Err("Wrong or missing password.".into()),
        WiFiConnectionStatus::NetworkNotAvailable => {
            Err("That network is out of range. Refresh the list.".into())
        }
        WiFiConnectionStatus::Timeout => Err(format!("{ssid} did not respond. Try again.")),
        WiFiConnectionStatus::UnsupportedAuthenticationProtocol => {
            Err("This network needs a sign-in wallp can't provide. Use Manage networks.".into())
        }
        _ => Err(format!("Windows could not connect to {ssid}.")),
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
    // Association endpoint ids look like `Bluetooth#Bluetooth00:11:...-aa:bb:...`.
    if !id.starts_with("Bluetooth") || id.len() > 200 {
        return Err("Unknown Bluetooth device.".into());
    }
    blocking(move || device(&id, action)).await
}

const CLASSIC: &str = "{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}";
const LOW_ENERGY: &str = "{bb7bb05e-5972-42b5-94fc-76eaa7084d49}";
const IS_CONNECTED: &str = "System.Devices.Aep.IsConnected";
const IS_PAIRED: &str = "System.Devices.Aep.IsPaired";
const CONTAINER: &str = "System.Devices.Aep.ContainerId";

fn filter(paired: bool) -> HSTRING {
    let paired = if paired { "True" } else { "False" };
    HSTRING::from(format!(
        "(System.Devices.Aep.ProtocolId:=\"{CLASSIC}\" OR System.Devices.Aep.ProtocolId:=\"{LOW_ENERGY}\") AND {IS_PAIRED}:=System.StructuredQueryType.Boolean#{paired}"
    ))
}

fn properties() -> IIterable<HSTRING> {
    IIterable::from(vec![
        HSTRING::from(IS_CONNECTED),
        HSTRING::from(IS_PAIRED),
        HSTRING::from(CONTAINER),
    ])
}

fn property<T: windows::core::RuntimeType + 'static>(
    info: &DeviceInformation,
    key: &str,
) -> Option<T> {
    info.Properties()
        .ok()?
        .Lookup(&HSTRING::from(key))
        .ok()?
        .cast::<IReference<T>>()
        .ok()?
        .Value()
        .ok()
}

/// Watch for unpaired devices for `duration`; FindAll would wait for every
/// Bluetooth LE advertisement to time out.
fn discover(duration: Duration) -> Result<Vec<DeviceInformation>, String> {
    let watcher = DeviceInformation::CreateWatcherWithKindAqsFilterAndAdditionalProperties(
        &filter(false),
        &properties(),
        DeviceInformationKind::AssociationEndpoint,
    )
    .map_err(text)?;
    let found: Arc<Mutex<Vec<DeviceInformation>>> = Arc::default();
    let added = found.clone();
    watcher
        .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
            move |_, info: Ref<DeviceInformation>| {
                if let (Ok(info), Ok(mut list)) = (info.ok(), added.lock()) {
                    list.push(info.clone());
                }
                Ok(())
            },
        ))
        .map_err(text)?;
    let updated = found.clone();
    watcher
        .Updated(
            &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                move |_, update: Ref<DeviceInformationUpdate>| {
                    let (Ok(update), Ok(list)) = (update.ok(), updated.lock()) else {
                        return Ok(());
                    };
                    let id = update.Id()?;
                    for info in list.iter() {
                        if info.Id()? == id {
                            info.Update(update)?;
                        }
                    }
                    Ok(())
                },
            ),
        )
        .map_err(text)?;
    watcher.Start().map_err(text)?;
    std::thread::sleep(duration);
    let _ = watcher.Stop();
    let found = found.lock().map(|list| list.clone()).unwrap_or_default();
    Ok(found)
}

fn devices(scan: bool) -> Result<Vec<BluetoothDevice>, String> {
    if !radio_on(RadioKind::Bluetooth) {
        return Err("Turn on Bluetooth to see devices.".into());
    }
    let mut found: Vec<DeviceInformation> =
        DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
            &filter(true),
            &properties(),
            DeviceInformationKind::AssociationEndpoint,
        )
        .and_then(|op| op.join())
        .map_err(text)?
        .into_iter()
        .collect();
    if scan {
        found.extend(discover(Duration::from_secs(8))?);
    }
    let audio: HashSet<GUID> = audio_controls()
        .into_iter()
        .map(|(container, _)| container)
        .collect();
    let mut devices: Vec<(Option<GUID>, BluetoothDevice)> = Vec::new();
    for info in found {
        let Ok(id) = info.Id().map(|id| id.to_string()) else {
            continue;
        };
        let name = info.Name().map(|name| name.to_string()).unwrap_or_default();
        let paired = property::<bool>(&info, IS_PAIRED).unwrap_or(false);
        // Unnamed nearby beacons are noise; keep anything already paired.
        if !paired && name.trim().is_empty() {
            continue;
        }
        let connected = property::<bool>(&info, IS_CONNECTED).unwrap_or(false);
        let container = property::<GUID>(&info, CONTAINER);
        // Dual-mode devices have a Classic and an LE endpoint; show one.
        if let Some(existing) = devices
            .iter_mut()
            .find(|(known, device)| (container.is_some() && *known == container) || device.id == id)
        {
            existing.1.connected |= connected;
            continue;
        }
        devices.push((
            container,
            BluetoothDevice {
                can_connect: container.is_some_and(|container| audio.contains(&container)),
                id,
                name,
                paired,
                connected,
            },
        ));
    }
    let mut devices: Vec<BluetoothDevice> = devices.into_iter().map(|(_, device)| device).collect();
    devices.sort_by(|a, b| {
        (!a.connected, !a.paired, a.name.to_lowercase()).cmp(&(
            !b.connected,
            !b.paired,
            b.name.to_lowercase(),
        ))
    });
    Ok(devices)
}

fn device(id: &str, action: DeviceAction) -> Result<(), String> {
    let info = DeviceInformation::CreateFromIdAsyncWithKindAndAdditionalProperties(
        &HSTRING::from(id),
        &properties(),
        DeviceInformationKind::AssociationEndpoint,
    )
    .and_then(|op| op.join())
    .map_err(|_| "That device is no longer available. Refresh the list.".to_string())?;
    match action {
        DeviceAction::Pair => pair(&info),
        DeviceAction::Forget => {
            let status = info
                .Pairing()
                .and_then(|pairing| pairing.UnpairAsync())
                .and_then(|op| op.join())
                .and_then(|result| result.Status())
                .map_err(text)?;
            match status {
                DeviceUnpairingResultStatus::Unpaired
                | DeviceUnpairingResultStatus::AlreadyUnpaired => Ok(()),
                DeviceUnpairingResultStatus::AccessDenied => {
                    Err("Windows denied removing this device. Use Manage devices.".into())
                }
                _ => Err("Windows could not remove this device.".into()),
            }
        }
        DeviceAction::Connect | DeviceAction::Disconnect => {
            let connect = matches!(action, DeviceAction::Connect);
            let container = property::<GUID>(&info, CONTAINER)
                .ok_or("Windows can't connect this device from wallp. Use Manage devices.")?;
            audio_connection(container, connect)
        }
    }
}

fn pair(info: &DeviceInformation) -> Result<(), String> {
    let custom = info
        .Pairing()
        .and_then(|pairing| pairing.Custom())
        .map_err(text)?;
    // Accept only "just works" pairing, as headsets, speakers and mice use.
    // Devices that show or ask for a PIN are left to Windows settings.
    let token = custom
        .PairingRequested(&TypedEventHandler::<
            DeviceInformationCustomPairing,
            DevicePairingRequestedEventArgs,
        >::new(|_, args: Ref<DevicePairingRequestedEventArgs>| {
            if let Ok(args) = args.ok() {
                args.Accept()?;
            }
            Ok(())
        }))
        .map_err(text)?;
    let status = custom
        .PairAsync(DevicePairingKinds::ConfirmOnly)
        .and_then(|op| op.join())
        .and_then(|result| result.Status());
    let _ = custom.RemovePairingRequested(token);
    match status.map_err(text)? {
        DevicePairingResultStatus::Paired | DevicePairingResultStatus::AlreadyPaired => Ok(()),
        DevicePairingResultStatus::AuthenticationTimeout
        | DevicePairingResultStatus::NotReadyToPair => {
            Err("The device did not respond. Put it in pairing mode and try again.".into())
        }
        DevicePairingResultStatus::RequiredHandlerNotRegistered
        | DevicePairingResultStatus::AuthenticationNotAllowed => {
            Err("This device needs a PIN. Pair it from Manage devices.".into())
        }
        _ => Err("Windows could not pair this device.".into()),
    }
}

const PKEY_DEVICE_CONTAINER_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x8c7ed206_3f8a_4827_b3ab_ae9e1faefc6c),
    pid: 2,
};

fn container_id(endpoint: &IMMDevice) -> Option<GUID> {
    unsafe {
        let store = endpoint.OpenPropertyStore(STGM_READ).ok()?;
        let mut value = store.GetValue(&PKEY_DEVICE_CONTAINER_ID).ok()?;
        let id = PropVariantToGUID(&value).ok();
        let _ = PropVariantClear(&mut value);
        id
    }
}

/// The kernel-streaming filter behind an audio endpoint, which is where the
/// Bluetooth audio driver accepts its connect/disconnect requests.
fn filter_control(
    enumerator: &IMMDeviceEnumerator,
    topology: &IDeviceTopology,
    connector: u32,
) -> windows::core::Result<IKsControl> {
    unsafe {
        let part: IPart = topology.GetConnector(connector)?.GetConnectedTo()?.cast()?;
        let id = part.GetTopologyObject()?.GetDeviceId()?;
        let filter = enumerator.GetDevice(PCWSTR(id.0));
        CoTaskMemFree(Some(id.0 as *const _));
        filter?.Activate::<IKsControl>(CLSCTX_ALL, None)
    }
}

/// Bluetooth audio filters keyed by the physical device's container id.
/// Disconnected headsets keep their endpoints as "unplugged".
fn audio_controls() -> Vec<(GUID, IKsControl)> {
    let mut controls = Vec::new();
    let enumerator: windows::core::Result<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) };
    let Ok(enumerator) = enumerator else {
        return controls;
    };
    let states = DEVICE_STATE(DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0);
    let Ok(endpoints) = (unsafe { enumerator.EnumAudioEndpoints(eAll, states) }) else {
        return controls;
    };
    for index in 0..unsafe { endpoints.GetCount() }.unwrap_or(0) {
        let Ok(endpoint) = (unsafe { endpoints.Item(index) }) else {
            continue;
        };
        let Some(container) = container_id(&endpoint) else {
            continue;
        };
        let Ok(topology) = (unsafe { endpoint.Activate::<IDeviceTopology>(CLSCTX_ALL, None) })
        else {
            continue;
        };
        for connector in 0..unsafe { topology.GetConnectorCount() }.unwrap_or(0) {
            if let Ok(control) = filter_control(&enumerator, &topology, connector) {
                controls.push((container, control));
            }
        }
    }
    controls
}

fn audio_connection(container: GUID, connect: bool) -> Result<(), String> {
    let id = if connect {
        KSPROPERTY_ONESHOT_RECONNECT
    } else {
        KSPROPERTY_ONESHOT_DISCONNECT
    };
    let property = KSIDENTIFIER {
        Anonymous: KSIDENTIFIER_0 {
            Anonymous: KSIDENTIFIER_0_0 {
                Set: KSPROPSETID_BtAudio,
                Id: id.0 as u32,
                Flags: KSPROPERTY_TYPE_GET,
            },
        },
    };
    let mut sent = false;
    // A headset has several endpoints (stereo, hands-free); any one is enough.
    for (_, control) in audio_controls()
        .into_iter()
        .filter(|(known, _)| *known == container)
    {
        let mut returned = 0u32;
        sent |= unsafe {
            control.KsProperty(
                &property,
                std::mem::size_of::<KSIDENTIFIER>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
            )
        }
        .is_ok();
    }
    if sent {
        Ok(())
    } else {
        Err("Windows can only connect Bluetooth audio devices from wallp. Use Manage devices for this one.".into())
    }
}
