use serde::Deserialize;
use std::{os::windows::process::CommandExt, process::Command};
use tauri::AppHandle;
use windows::Win32::{
    Foundation::{CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID},
    Security::{
        AdjustTokenPrivileges, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED,
        SE_SHUTDOWN_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    },
    System::{
        Power::SetSuspendState,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerAction {
    PowerOff,
    Restart,
    Sleep,
}

#[tauri::command]
pub async fn launcher_power(app: AppHandle, action: PowerAction) -> Result<(), String> {
    // Sleep can block until resume, so keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        match action {
            PowerAction::Sleep => {
                crate::launcher::close_launcher(app)?;
                sleep_pc()
            }
            PowerAction::PowerOff | PowerAction::Restart => {
                let windows = std::env::var_os("SystemRoot").ok_or("SystemRoot is unavailable")?;
                let output =
                    Command::new(std::path::PathBuf::from(windows).join("System32/shutdown.exe"))
                        .args([
                            if matches!(action, PowerAction::Restart) {
                                "/r"
                            } else {
                                "/s"
                            },
                            "/t",
                            "0",
                        ])
                        .creation_flags(0x08000000) // CREATE_NO_WINDOW
                        .output()
                        .map_err(|err| err.to_string())?;
                if !output.status.success() {
                    return Err(format!(
                        "Windows could not run the power command: {}{}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    ));
                }
                crate::launcher::close_launcher(app)
            }
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

fn sleep_pc() -> Result<(), String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .map_err(|err| err.to_string())?;
        let result = (|| {
            let mut luid = LUID::default();
            LookupPrivilegeValueW(None, SE_SHUTDOWN_NAME, &mut luid)
                .map_err(|err| err.to_string())?;
            let privileges = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: luid,
                    Attributes: SE_PRIVILEGE_ENABLED,
                }],
            };
            let mut previous = TOKEN_PRIVILEGES::default();
            let mut length = 0;
            AdjustTokenPrivileges(
                token,
                false,
                Some(&privileges),
                size_of::<TOKEN_PRIVILEGES>() as u32,
                Some(&mut previous),
                Some(&mut length),
            )
            .map_err(|err| err.to_string())?;
            if GetLastError() == ERROR_NOT_ALL_ASSIGNED {
                return Err("Windows has not granted permission to put this PC to sleep.".into());
            }
            // Request sleep, not hibernation, and preserve scheduled wake events.
            let result = if SetSuspendState(false, false, false) {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error().to_string())
            };
            let _ = AdjustTokenPrivileges(token, false, Some(&previous), 0, None, None);
            result
        })();
        let _ = CloseHandle(token);
        result
    }
}
