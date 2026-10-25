//! Home navigation stays foreground-only; native controller mouse runs separately.
use serde::Serialize;
use tauri::{Manager, WebviewWindow};
use windows::Win32::UI::{
    Input::{
        KeyboardAndMouse::GetAsyncKeyState,
        XboxController::{XINPUT_STATE, XInputGetState},
    },
    WindowsAndMessaging::{GA_ROOT, GetAncestor, GetClassNameW, GetForegroundWindow},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    id: u32,
    buttons: u16,
    x: f32,
    y: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
    home_foreground: bool,
    shortcut: bool,
    controllers: Vec<Controller>,
    mouse: crate::controller_mouse::Status,
}

#[tauri::command]
pub fn game_input_state(window: WebviewWindow, key: u32) -> Result<InputState, String> {
    if window.label() != "desktop" {
        return Err("Game input is only available on Home.".into());
    }
    let foreground = unsafe { GetForegroundWindow() };
    let root = unsafe { GetAncestor(foreground, GA_ROOT) };
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(root, &mut class) };
    let class = String::from_utf16_lossy(&class[..len.max(0) as usize]);
    let home_foreground = !foreground.is_invalid()
        && (foreground == window.hwnd().map_err(|e| e.to_string())?
            || matches!(class.as_str(), "Progman" | "WorkerW"));
    let mut state = InputState {
        home_foreground,
        shortcut: false,
        controllers: vec![],
        mouse: window.state::<crate::controller_mouse::ControllerMouse>().0.lock().unwrap().clone(),
    };
    if !home_foreground {
        return Ok(state);
    }
    // Pointer controls must not also activate Home's spatial navigation.
    if state.mouse.active { return Ok(state); }
    // Ctrl+Alt plus a configurable letter. High bit means down; ignore the
    // unreliable low bit ("pressed since last call") shared with other apps.
    let down = |key| unsafe { GetAsyncKeyState(key) < 0 };
    state.shortcut = (65..=90).contains(&key)
        && down(0x11)
        && down(0x12)
        && down(key as i32)
        && !down(0x10)
        && !down(0x5b)
        && !down(0x5c);
    for id in 0..4 {
        let mut pad = XINPUT_STATE::default();
        if unsafe { XInputGetState(id, &mut pad) } == 0 {
            state.controllers.push(Controller {
                id,
                buttons: pad.Gamepad.wButtons.0,
                x: pad.Gamepad.sThumbLX as f32 / 32768.0,
                y: -(pad.Gamepad.sThumbLY as f32) / 32768.0,
            });
        }
    }
    Ok(state)
}

#[tauri::command]
pub fn game_focus_home(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("Game Mode is only available on Home.".into());
    }
    // Do not minimize or activate over a game that took focus during polling.
    if game_input_state(window.clone(), 0)?.home_foreground {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
