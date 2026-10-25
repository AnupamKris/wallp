//! Open the Windows-owned flyout so hardware support and device management
//! stay with the shell, even when wallp hides the native taskbar.
use std::{thread, time::Duration};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    }
}

#[tauri::command]
pub async fn open_quick_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("Quick Settings can only be opened from the desktop.".into());
    }
    tauri::async_runtime::spawn_blocking(|| unsafe {
        // Keyboard activation can arrive before the user releases Enter/Space.
        // Wait instead of changing a physically held modifier's state.
        for _ in 0..40 {
            if [
                VK_LWIN, VK_RWIN, VK_CONTROL, VK_MENU, VK_SHIFT, VK_RETURN, VK_SPACE, VK_A,
            ]
            .iter()
            .all(|code| GetAsyncKeyState(code.0 as i32) >= 0)
            {
                let inputs = [
                    key(VK_LWIN, false),
                    key(VK_A, false),
                    key(VK_A, true),
                    key(VK_LWIN, true),
                ];
                let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
                if sent != inputs.len() as u32 {
                    // A partial insertion must not leave our synthetic keys down.
                    if sent > 0 {
                        let release = [key(VK_A, true), key(VK_LWIN, true)];
                        let _ = SendInput(&release, std::mem::size_of::<INPUT>() as i32);
                    }
                    return Err("Windows blocked Quick Settings. Press Win+A to open it.".into());
                }
                return Ok(());
            }
            thread::sleep(Duration::from_millis(25));
        }
        Err("Release the keyboard keys and try Quick Settings again, or press Win+A.".into())
    })
    .await
    .map_err(|err| err.to_string())?
}
