//! Explorer's private notification-area COM interface, also used by Chromium.
//! Enumerate briefly and unregister immediately. Do not change tray preferences.
use serde::Serialize;
use std::{
    ffi::c_void,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND},
        System::{
            Com::{
                CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize,
            },
            Threading::{
                GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
                TerminateProcess,
            },
        },
        UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow},
    },
    core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, Interface, PCWSTR, PWSTR},
};

#[repr(C)]
struct NotifyItem {
    exe: PCWSTR,
    tip: PCWSTR,
    icon: isize,
    hwnd: HWND,
    preference: u32,
    id: u32,
    guid: GUID,
}

windows::core::imp::define_interface!(
    TrayNotify,
    TrayNotifyVtbl,
    0xd133ce13_3537_48ba_93a7_afcd5d2053b4
);
#[repr(C)]
pub struct TrayNotifyVtbl {
    base: IUnknown_Vtbl,
    register: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut u32) -> HRESULT,
    unregister: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
}

const CALLBACK_IID: GUID = GUID::from_u128(0xd782ccba_afb0_43f1_94db_fda3779eaccb);
#[repr(C)]
struct CallbackVtbl {
    base: IUnknown_Vtbl,
    notify: unsafe extern "system" fn(*mut c_void, u32, *const NotifyItem) -> HRESULT,
}
#[repr(C)]
struct Callback {
    vtable: *const CallbackVtbl,
    refs: AtomicU32,
    items: Mutex<Vec<TrayApp>>,
}

unsafe extern "system" fn query(
    this: *mut c_void,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> HRESULT {
    unsafe {
        if iid.is_null() || out.is_null() {
            return HRESULT(0x80004003u32 as i32);
        }
        *out = std::ptr::null_mut();
        if *iid == CALLBACK_IID || *iid == IUnknown::IID {
            *out = this;
            add_ref(this);
            HRESULT(0)
        } else {
            HRESULT(0x80004002u32 as i32)
        }
    }
}
unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    unsafe {
        (*this.cast::<Callback>())
            .refs
            .fetch_add(1, Ordering::Relaxed)
            + 1
    }
}
unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    unsafe {
        let count = (*this.cast::<Callback>())
            .refs
            .fetch_sub(1, Ordering::AcqRel)
            - 1;
        if count == 0 {
            drop(Box::from_raw(this.cast::<Callback>()));
        }
        count
    }
}
unsafe extern "system" fn notify(
    this: *mut c_void,
    _event: u32,
    item: *const NotifyItem,
) -> HRESULT {
    unsafe {
        if let Some(item) = item.as_ref() {
            // Explorer caches exited apps. A live owning HWND and matching image
            // exclude stale entries, including recycled window handles.
            if IsWindow(Some(item.hwnd)).as_bool() {
                let mut pid = 0;
                GetWindowThreadProcessId(item.hwnd, Some(&mut pid));
                if let Ok((path, started)) = process_identity(pid) {
                    let cached = item.exe.to_string().unwrap_or_default();
                    if path.eq_ignore_ascii_case(&cached) {
                        let name = path.rsplit('\\').next().unwrap_or(&path).to_string();
                        let reason = if pid == std::process::id() {
                            Some("Use Quit wallp from its tray menu")
                        } else if name.eq_ignore_ascii_case("explorer.exe") {
                            Some("Windows shell")
                        } else if pid <= 4 {
                            Some("Windows system process")
                        } else {
                            None
                        };
                        let app = TrayApp {
                            pid,
                            started,
                            name,
                            tooltip: item.tip.to_string().unwrap_or_default(),
                            path,
                            blocked_reason: reason.map(str::to_string),
                            icon: None,
                        };
                        if let Ok(mut items) = (*this.cast::<Callback>()).items.lock() {
                            items.push(app);
                        }
                    }
                }
            }
        }
        HRESULT(0)
    }
}
static CALLBACK_VTABLE: CallbackVtbl = CallbackVtbl {
    base: IUnknown_Vtbl {
        QueryInterface: query,
        AddRef: add_ref,
        Release: release,
    },
    notify,
};

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

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn identity(handle: HANDLE) -> Result<(String, String), String> {
    unsafe {
        let mut path = vec![0u16; 32768];
        let mut len = path.len() as u32;
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut len,
        )
        .map_err(|e| e.to_string())?;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(|e| e.to_string())?;
        Ok((
            String::from_utf16_lossy(&path[..len as usize]),
            format!("{}:{}", created.dwHighDateTime, created.dwLowDateTime),
        ))
    }
}
fn process_identity(pid: u32) -> Result<(String, String), String> {
    let process = Process(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(|e| e.to_string())?,
    );
    identity(process.0)
}

fn enumerate() -> Result<Vec<TrayApp>, String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let tray: TrayNotify = CoCreateInstance(
            &GUID::from_u128(0x25dead04_1eac_4911_9e3a_ad0a4ab560fd),
            None,
            CLSCTX_LOCAL_SERVER,
        )
        .map_err(|e| format!("Windows could not enumerate tray apps: {e}"))?;
        let callback = Box::into_raw(Box::new(Callback {
            vtable: &CALLBACK_VTABLE,
            refs: AtomicU32::new(1),
            items: Mutex::new(Vec::new()),
        }));
        let mut cookie = 0;
        let result = (tray.vtable().register)(tray.as_raw(), callback.cast(), &mut cookie);
        let unregister = (tray.vtable().unregister)(tray.as_raw(), &mut cookie);
        let items = (*callback)
            .items
            .lock()
            .map(|items| items.clone())
            .unwrap_or_default();
        release(callback.cast());
        result
            .ok()
            .map_err(|e| format!("Could not read the system tray: {e}"))?;
        unregister
            .ok()
            .map_err(|e| format!("Could not release the tray subscription: {e}"))?;
        let mut items = if items.is_empty() {
            modern_tray()?
        } else {
            items
        };
        items.sort_by_key(|app| (app.name.to_lowercase(), app.pid));
        items.dedup_by_key(|app| app.pid);
        Ok(items)
    }
}

// Recent Windows 11 builds no longer populate the old COM list. The settings
// registry supplies icon identities; GetRect verifies each is registered now.
// Never treat the historical registry cache alone as a running tray app.
fn modern_tray() -> Result<Vec<TrayApp>, String> {
    use windows::Win32::{
        Foundation::LPARAM,
        System::{Com::CoTaskMemFree, Diagnostics::ToolHelp::*},
        UI::{Shell::*, WindowsAndMessaging::*},
    };
    use windows::core::BOOL;
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        unsafe {
            (*(data.0 as *mut Vec<HWND>)).push(hwnd);
        }
        BOOL(1)
    }
    unsafe {
        let root = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Control Panel\\NotifyIconSettings")
        {
            Ok(key) => key,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(format!("Could not read tray settings: {err}")),
        };
        let mut icons = Vec::new();
        for key in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey(key) else {
                continue;
            };
            let Ok(mut path) = key.get_value::<String, _>("ExecutablePath") else {
                continue;
            };
            if path.starts_with('{') {
                if let Some(end) = path.find('}') {
                    if let Some(guid) = parse_guid(&path[..=end]) {
                        if let Ok(folder) = SHGetKnownFolderPath(&guid, KF_FLAG_DEFAULT, None) {
                            let expanded = folder.to_string().unwrap_or_default();
                            CoTaskMemFree(Some(folder.0.cast()));
                            path = format!("{}{}", expanded, &path[end + 1..]);
                        }
                    }
                }
            }
            let guid = key
                .get_value::<String, _>("IconGuid")
                .ok()
                .and_then(|s| parse_guid(&s));
            let uid = key.get_value::<u32, _>("UID").unwrap_or_default();
            let tip = key
                .get_value::<String, _>("InitialTooltip")
                .unwrap_or_default();
            icons.push((path, guid, uid, tip));
        }
        let mut windows = Vec::<HWND>::new();
        let data = LPARAM(&mut windows as *mut _ as isize);
        let _ = EnumWindows(Some(collect), data);
        // Tray owner windows are often message-only windows.
        let mut after = None;
        while let Ok(hwnd) =
            FindWindowExW(Some(HWND_MESSAGE), after, PCWSTR::null(), PCWSTR::null())
        {
            windows.push(hwnd);
            after = Some(hwnd);
        }
        let parents = windows.clone();
        for hwnd in parents {
            let _ = EnumChildWindows(Some(hwnd), Some(collect), data);
        }
        let snapshot =
            Process(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut next = Process32FirstW(snapshot.0, &mut entry);
        let mut apps = Vec::new();
        while next.is_ok() {
            let pid = entry.th32ProcessID;
            if let Ok((path, started)) = process_identity(pid) {
                // Electron/browser helpers share the main executable. Represent
                // the application root, not each renderer or utility process.
                if process_identity(entry.th32ParentProcessID)
                    .is_ok_and(|(parent_path, _)| path.eq_ignore_ascii_case(&parent_path))
                {
                    next = Process32NextW(snapshot.0, &mut entry);
                    continue;
                }
                for (cached, guid, uid, tip) in &icons {
                    if !path.eq_ignore_ascii_case(cached) {
                        continue;
                    }
                    let registered = if let Some(guid) = guid {
                        Shell_NotifyIconGetRect(&NOTIFYICONIDENTIFIER {
                            cbSize: std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32,
                            guidItem: *guid,
                            ..Default::default()
                        })
                        .is_ok()
                    } else {
                        windows.iter().any(|hwnd| {
                            let mut owner = 0;
                            GetWindowThreadProcessId(*hwnd, Some(&mut owner));
                            owner == pid
                                && Shell_NotifyIconGetRect(&NOTIFYICONIDENTIFIER {
                                    cbSize: std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32,
                                    hWnd: *hwnd,
                                    uID: *uid,
                                    ..Default::default()
                                })
                                .is_ok()
                        })
                    };
                    if !registered {
                        continue;
                    }
                    let name = path.rsplit('\\').next().unwrap_or(&path).to_string();
                    let blocked_reason = if pid == std::process::id() {
                        Some("Use Quit wallp from its tray menu".into())
                    } else if name.eq_ignore_ascii_case("explorer.exe") {
                        Some("Windows shell".into())
                    } else {
                        None
                    };
                    apps.push(TrayApp {
                        pid,
                        started: started.clone(),
                        name,
                        tooltip: tip.clone(),
                        path: path.clone(),
                        blocked_reason,
                        icon: None,
                    });
                    break;
                }
            }
            next = Process32NextW(snapshot.0, &mut entry);
        }
        let mut counts = std::collections::HashMap::new();
        for app in &apps {
            *counts.entry(app.path.to_lowercase()).or_insert(0) += 1;
        }
        for app in &mut apps {
            if counts.get(&app.path.to_lowercase()).copied().unwrap_or(0) > 1
                && app.blocked_reason.is_none()
            {
                app.blocked_reason =
                    Some("Multiple instances: Windows did not identify the icon's owner".into());
            }
        }
        Ok(apps)
    }
}

fn parse_guid(value: &str) -> Option<GUID> {
    let digits: String = value
        .chars()
        .filter(|c| !matches!(c, '{' | '}' | '-'))
        .collect();
    if digits.len() != 32 {
        return None;
    }
    u128::from_str_radix(&digits, 16).ok().map(GUID::from_u128)
}

// Extract the installed application's icon locally; no network image lookup.
fn executable_icon(path: &str) -> Option<String> {
    use base64::Engine;
    use windows::Win32::{
        Graphics::Gdi::*,
        Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        UI::{Shell::*, WindowsAndMessaging::*},
    };
    unsafe {
        let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
        let mut info = SHFILEINFOW::default();
        if SHGetFileInfoW(
            PCWSTR(path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        ) == 0
        {
            return None;
        }
        let result = (|| {
            let dc = CreateCompatibleDC(None);
            if dc.0.is_null() {
                return None;
            }
            let mut bitmap_info = BITMAPINFO::default();
            bitmap_info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 32,
                biHeight: -32,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = match CreateDIBSection(
                Some(dc),
                &bitmap_info,
                DIB_RGB_COLORS,
                &mut bits,
                None,
                0,
            ) {
                Ok(bitmap) => bitmap,
                Err(_) => {
                    let _ = DeleteDC(dc);
                    return None;
                }
            };
            let old = SelectObject(dc, bitmap.into());
            // Opaque card background also handles legacy icons without an alpha channel.
            let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), 32 * 32 * 4);
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.copy_from_slice(&[30, 30, 30, 255]);
            }
            let drawn = DrawIconEx(dc, 0, 0, info.hIcon, 32, 32, 0, None, DI_NORMAL).is_ok();
            let _ = GdiFlush();
            let mut rgb = Vec::with_capacity(32 * 32 * 3);
            for pixel in pixels.chunks_exact(4) {
                rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
            SelectObject(dc, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(dc);
            if !drawn {
                return None;
            }
            let mut bytes = Vec::new();
            let mut encoder = png::Encoder::new(&mut bytes, 32, 32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().ok()?.write_image_data(&rgb).ok()?;
            Some(format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        })();
        let _ = DestroyIcon(info.hIcon);
        result
    }
}

#[tauri::command]
pub async fn list_tray_apps() -> Result<Vec<TrayApp>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut apps = enumerate()?;
        for app in &mut apps {
            app.icon = executable_icon(&app.path);
        }
        Ok(apps)
    })
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
        let process = Process(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    false,
                    pid,
                )
            }
            .map_err(|e| format!("Windows could not end {}: {e}", app.name))?,
        );
        let (path, current_started) = identity(process.0)?;
        if current_started != started || !path.eq_ignore_ascii_case(&app.path) {
            return Err("The process changed. Refresh and try again.".into());
        }
        unsafe { TerminateProcess(process.0, 1) }
            .map_err(|e| format!("Windows could not end {}: {e}", app.name))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_app_icons_are_valid_png_images() {
        use base64::Engine;
        let path = std::env::current_exe().unwrap();
        let icon = executable_icon(path.to_str().unwrap())
            .expect("Windows should provide an application icon");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        assert_eq!((reader.info().width, reader.info().height), (32, 32));
    }

    #[test]
    fn live_tray_entries_have_matching_process_identity() {
        let apps = enumerate().expect("Explorer tray enumeration should succeed");
        eprintln!("Enumerated {} running tray apps", apps.len());
        for app in apps {
            eprintln!("{} (PID {})", app.name, app.pid);
            if let Ok((path, started)) = process_identity(app.pid) {
                assert!(path.eq_ignore_ascii_case(&app.path));
                assert_eq!(started, app.started);
            }
        }
    }

    #[test]
    fn rejects_a_process_that_is_not_a_current_tray_entry() {
        let result = tauri::async_runtime::block_on(end_tray_app(
            std::process::id(),
            "invalid-start-time".into(),
        ));
        assert!(result.is_err());
        assert!(process_identity(std::process::id()).is_ok());
    }
}
