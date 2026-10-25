//! Opt-in desktop controls while Game Mode is open. XInput is observed, not intercepted.
use std::{
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::UI::Input::{
    KeyboardAndMouse::*,
    XboxController::{
        XINPUT_GAMEPAD, XINPUT_STATE, XINPUT_VIBRATION, XInputGetState, XInputSetState,
    },
};
use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GetAncestor, GetClassNameW, GetForegroundWindow};

#[derive(Default)]
pub struct ControllerMouse(pub Mutex<Status>);
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub active: bool,
    pub error: String,
}

#[tauri::command]
pub fn game_mouse_enabled(
    window: WebviewWindow,
    state: tauri::State<ControllerMouse>,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "desktop" {
        return Err("Controller mouse is only available in Game Mode.".into());
    }
    let mut status = state.0.lock().unwrap();
    status.enabled = enabled;
    if !enabled {
        status.active = false;
    }
    status.error.clear();
    Ok(())
}

fn mouse(flags: MOUSE_EVENT_FLAGS, x: i32, y: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data as u32,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
fn key(code: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    KEYBD_EVENT_FLAGS(0)
                },
                ..Default::default()
            },
        },
    }
}
fn send(inputs: &[INPUT]) -> bool {
    unsafe { SendInput(inputs, size_of::<INPUT>() as i32) == inputs.len() as u32 }
}
fn release() {
    send(&[
        mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0),
        mouse(MOUSEEVENTF_RIGHTUP, 0, 0, 0),
    ]);
}

/// Radial dead zone with quadratic acceleration and full speed at the stick edge.
fn velocity(x: i16, y: i16) -> (f64, f64) {
    let x = x as f64 / 32768.0;
    let y = -(y as f64) / 32768.0;
    let length = x.hypot(y);
    if length <= 0.22 {
        return (0.0, 0.0);
    }
    let speed = ((length.min(1.0) - 0.22) / 0.78).powi(2);
    (x / length * speed, y / length * speed)
}
fn chord(pad: &XINPUT_GAMEPAD) -> bool {
    pad.wButtons.0 & 0x300 == 0x300 && pad.bLeftTrigger > 200 && pad.bRightTrigger > 200
}
fn neutral(pad: &XINPUT_GAMEPAD) -> bool {
    pad.wButtons.0 == 0
        && pad.bLeftTrigger < 30
        && pad.bRightTrigger < 30
        && velocity(pad.sThumbLX, pad.sThumbLY) == (0.0, 0.0)
        && velocity(pad.sThumbRX, pad.sThumbRY) == (0.0, 0.0)
}

#[derive(Default)]
struct Tracker {
    id: Option<u32>,
    ready: bool,
    hold: Option<Instant>,
    latched: bool,
    clicks_ready: bool,
    buttons: u16,
    left: bool,
    right: bool,
    remainder: (f64, f64),
    scroll: f64,
    overlay: bool,
    /// The on-screen keyboard is open, so face buttons and shoulders become typing shortcuts.
    keyboard: bool,
    /// Task View or Alt+Tab is in front. Windows navigates it with the gamepad itself,
    /// so the pointer, A, B and D-pad stay out of its way.
    switcher: bool,
    /// Shoulder controls (LB, RB, LT, RT bits) and stick clicks (L3, R3) seen since all were released.
    shoulders: u8,
    sticks: u16,
    launcher_hold: Option<Instant>,
    launcher_latched: bool,
    ui_direction: Option<&'static str>,
    ui_repeat: Option<Instant>,
    pending: Vec<&'static str>,
}
impl Tracker {
    fn reset(&mut self) {
        if self.left || self.right {
            release();
        }
        *self = Self::default();
    }
    fn tick(&mut self, pad: &XINPUT_GAMEPAD, now: Instant, dt: f64, status: &mut Status) {
        if !self.ready {
            self.ready = neutral(pad);
            return;
        }
        // L3 + R3 held: command menu, available whether or not mouse mode is on.
        let sticks = pad.wButtons.0 & STICKS;
        if sticks == STICKS {
            let start = *self.launcher_hold.get_or_insert(now);
            if !self.launcher_latched && now.duration_since(start) >= LAUNCHER_HOLD {
                self.launcher_latched = true;
                self.pending.push("launcher");
            }
        } else {
            self.launcher_hold = None;
            if sticks == 0 {
                self.launcher_latched = false;
            }
        }
        let holding = chord(pad);
        if holding {
            self.shoulders = SPOILED;
            if self.left || self.right {
                release();
                self.left = false;
                self.right = false;
            }
            self.clicks_ready = false;
            let start = *self.hold.get_or_insert(now);
            if !self.latched && now.duration_since(start) >= Duration::from_secs(1) {
                status.active = !status.active;
                status.error.clear();
                self.latched = true;
            }
            self.buttons = pad.wButtons.0;
            return;
        }
        // Require all four controls to be released before rearming the chord.
        if pad.wButtons.0 & 0x300 == 0 && pad.bLeftTrigger < 30 && pad.bRightTrigger < 30 {
            self.latched = false;
        }
        self.hold = None;
        let mut pressed = pad.wButtons.0 & !self.buttons;
        self.buttons = pad.wButtons.0;
        if self.switcher && !self.overlay {
            pressed &= !(0x1000 | 0x2000 | 0x2);
        }
        if !status.active {
            return;
        }
        if !self.clicks_ready {
            self.clicks_ready = neutral(pad);
            return;
        }
        // A lone stick click acts on release, so pressing both for the command menu does neither.
        if sticks != 0 {
            self.sticks |= sticks;
        } else if self.sticks != 0 {
            match std::mem::take(&mut self.sticks) {
                0x40 => self.pending.push("keyboard"),
                0x80 => self.pending.push("desktop"),
                _ => {}
            }
        }
        if let Some(action) = mouse_action(pressed, self.overlay, self.keyboard) {
            if self.left || self.right {
                release();
                self.left = false;
                self.right = false;
            }
            self.pending.push(action);
            return;
        }
        if self.overlay {
            if self.left || self.right {
                release();
                self.left = false;
                self.right = false;
            }
            let direction = if pad.wButtons.0 & 4 != 0 {
                Some("left")
            } else if pad.wButtons.0 & 8 != 0 {
                Some("right")
            } else if pad.wButtons.0 & 1 != 0 {
                Some("up")
            } else if pad.wButtons.0 & 2 != 0 {
                Some("down")
            } else if pad.sThumbLX < -18000 {
                Some("left")
            } else if pad.sThumbLX > 18000 {
                Some("right")
            } else if pad.sThumbLY > 18000 {
                Some("up")
            } else if pad.sThumbLY < -18000 {
                Some("down")
            } else {
                None
            };
            if let Some(direction) = direction {
                if self.ui_direction != Some(direction)
                    || self.ui_repeat.is_none_or(|time| now >= time)
                {
                    self.pending.push(direction);
                    self.ui_repeat = Some(
                        now + Duration::from_millis(if self.ui_direction == Some(direction) {
                            110
                        } else {
                            350
                        }),
                    );
                }
            }
            self.ui_direction = direction;
            if pressed & 0x1000 != 0 {
                self.pending.push("accept");
            }
            if pressed & 0x2000 != 0 {
                self.pending.push("back");
            }
            if self.keyboard {
                for (mask, action) in [(0x4000, "backspace"), (0x8000, "space"), (0x10, "enter")] {
                    if pressed & mask != 0 {
                        self.pending.push(action);
                    }
                }
                // Shoulders fire on release and only alone, so starting the mouse chord types nothing.
                let held = shoulders(pad);
                if held != 0 {
                    self.shoulders |= held;
                } else if let Some(action) = match std::mem::take(&mut self.shoulders) {
                    1 => Some("cursor-left"),
                    2 => Some("cursor-right"),
                    4 => Some("shift"),
                    8 => Some("symbols"),
                    _ => None,
                } {
                    self.pending.push(action);
                }
            } else {
                self.shoulders = 0;
            }
            return;
        }
        let (vx, vy) = if self.switcher {
            self.remainder = (0.0, 0.0);
            (0.0, 0.0)
        } else {
            velocity(pad.sThumbLX, pad.sThumbLY)
        };
        self.remainder.0 += vx * 1400.0 * dt;
        self.remainder.1 += vy * 1400.0 * dt;
        let (dx, dy) = (
            self.remainder.0.trunc() as i32,
            self.remainder.1.trunc() as i32,
        );
        self.remainder.0 -= dx as f64;
        self.remainder.1 -= dy as f64;
        let mut inputs = Vec::new();
        if dx != 0 || dy != 0 {
            inputs.push(mouse(MOUSEEVENTF_MOVE, dx, dy, 0));
        }
        let left = if self.left {
            pad.bLeftTrigger > 30
        } else {
            pad.bLeftTrigger > 100
        };
        let right = if self.right {
            pad.bRightTrigger > 30
        } else {
            pad.bRightTrigger > 100
        };
        if left != self.left {
            inputs.push(mouse(
                if left {
                    MOUSEEVENTF_LEFTDOWN
                } else {
                    MOUSEEVENTF_LEFTUP
                },
                0,
                0,
                0,
            ));
        }
        if right != self.right {
            inputs.push(mouse(
                if right {
                    MOUSEEVENTF_RIGHTDOWN
                } else {
                    MOUSEEVENTF_RIGHTUP
                },
                0,
                0,
                0,
            ));
        }
        self.left = left;
        self.right = right;
        let scroll = if self.switcher { 0.0 } else { velocity(pad.sThumbRX, pad.sThumbRY).1 };
        self.scroll -= scroll * 900.0 * dt;
        let wheel = self.scroll.trunc() as i32;
        self.scroll -= wheel as f64;
        if wheel != 0 {
            inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, wheel));
        }
        // Avoid releasing modifiers physically held on the keyboard.
        let modifiers_clear = [VK_MENU, VK_CONTROL, VK_SHIFT, VK_LWIN, VK_RWIN]
            .iter()
            .all(|k| unsafe { GetAsyncKeyState(k.0 as i32) >= 0 });
        if modifiers_clear {
            for (mask, code, modifier) in [
                (0x1000, VK_RETURN, None),
                (0x2000, VK_ESCAPE, None),
                (0x4000, VK_TAB, Some(VK_MENU)),
                (0x8000, VK_TAB, Some(VK_LWIN)),
            ] {
                if pressed & mask != 0 {
                    if let Some(m) = modifier {
                        inputs.push(key(m, false));
                    }
                    inputs.extend([key(code, false), key(code, true)]);
                    if let Some(m) = modifier {
                        inputs.push(key(m, true));
                    }
                }
            }
        }
        if !inputs.is_empty() && !send(&inputs) {
            release();
            // Repair partial shortcut insertion before disabling the mode.
            if modifiers_clear {
                send(&[
                    key(VK_MENU, true),
                    key(VK_LWIN, true),
                    key(VK_TAB, true),
                    key(VK_RETURN, true),
                    key(VK_ESCAPE, true),
                ]);
            }
            status.active = false;
            status.error = "Windows blocked controller mouse input. Elevated apps may require a physical mouse and keyboard.".into();
            self.reset();
        }
    }
}

/// Task View and Alt+Tab: XAML shell hosts on Windows 11, older frames on Windows 10.
fn shell_switcher() -> bool {
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(GetAncestor(GetForegroundWindow(), GA_ROOT), &mut class) };
    switcher_class(&String::from_utf16_lossy(&class[..len.max(0) as usize]))
}
fn switcher_class(class: &str) -> bool {
    matches!(
        class,
        "XamlExplorerHostIslandWindow" | "MultitaskingViewFrame" | "TaskSwitcherWnd"
    )
}
const STICKS: u16 = 0x40 | 0x80;
const LAUNCHER_HOLD: Duration = Duration::from_millis(500);
/// Marks a shoulder sequence that became part of the mouse chord; it never fires.
const SPOILED: u8 = 0x80;
fn shoulders(pad: &XINPUT_GAMEPAD) -> u8 {
    let buttons = pad.wButtons.0;
    (buttons & 0x100 != 0) as u8
        | ((buttons & 0x200 != 0) as u8) << 1
        | ((pad.bLeftTrigger > 100) as u8) << 2
        | ((pad.bRightTrigger > 100) as u8) << 3
}
fn mouse_action(pressed: u16, overlay: bool, keyboard: bool) -> Option<&'static str> {
    if pressed & 0x10 != 0 && !keyboard {
        Some("confirm")
    } else if pressed & 0x20 != 0 {
        Some("keyboard")
    } else if !overlay && pressed & 0x2 != 0 {
        Some("desktop")
    } else {
        None
    }
}
/// Long and strong enough to feel through a game's own rumble and in lighter third-party pads.
const ON_RUMBLE_MS: u64 = 450;
const OFF_RUMBLE_MS: u64 = 320;
fn vibrate(id: u32, active: bool) {
    let vibration = XINPUT_VIBRATION {
        wLeftMotorSpeed: if active { 52000 } else { 36000 },
        wRightMotorSpeed: if active { 40000 } else { 52000 },
    };
    unsafe {
        XInputSetState(id, &vibration);
    }
}
fn stop_vibration(id: u32) {
    unsafe {
        XInputSetState(id, &XINPUT_VIBRATION::default());
    }
}

pub fn spawn(app: AppHandle) {
    thread::spawn(move || {
        let mut tracker = Tracker::default();
        let mut armed = std::collections::HashSet::new();
        let mut previous = Instant::now();
        let mut last_active = false;
        let mut last_id = None;
        let mut rumble: Option<(u32, Instant)> = None;
        loop {
            thread::sleep(Duration::from_millis(8));
            let now = Instant::now();
            let dt = now.duration_since(previous).as_secs_f64().min(0.032);
            previous = now;
            crate::controller_overlay::expire(&app);
            if rumble.is_some_and(|(_, until)| now >= until) {
                if let Some((id, _)) = rumble.take() {
                    stop_vibration(id);
                }
            }
            let state = app.state::<ControllerMouse>();
            let mut status = state.0.lock().unwrap();
            if app
                .state::<crate::Desktop>()
                .quitting
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                tracker.reset();
                if let Some((id, _)) = rumble {
                    stop_vibration(id);
                }
                return;
            }
            if !status.enabled || app.get_webview_window("desktop").is_none() {
                tracker.reset();
                armed.clear();
                status.active = false;
                drop(status);
                if last_active {
                    last_active = false;
                    crate::controller_overlay::feedback(&app, false);
                    if let Some(id) = last_id {
                        if let Some((previous_id, _)) = rumble.take() {
                            stop_vibration(previous_id);
                        }
                        vibrate(id, false);
                        rumble = Some((id, now + Duration::from_millis(OFF_RUMBLE_MS)));
                    }
                }
                continue;
            }
            let pads: Vec<_> = (0..4)
                .filter_map(|id| {
                    let mut pad = XINPUT_STATE::default();
                    (unsafe { XInputGetState(id, &mut pad) } == 0).then_some((id, pad.Gamepad))
                })
                .collect();
            armed.retain(|id| pads.iter().any(|p| p.0 == *id));
            for (id, pad) in &pads {
                if neutral(pad) {
                    armed.insert(*id);
                }
            }
            let selected = tracker.id.and_then(|id| pads.iter().find(|p| p.0 == id));
            if tracker.id.is_some() && selected.is_none() {
                tracker.reset();
                status.active = false;
            }
            let selected = if status.active {
                selected
            } else {
                pads.iter()
                    .find(|p| chord(&p.1) && armed.contains(&p.0))
                    .or(selected)
            }
            .or_else(|| pads.first());
            if let Some((id, pad)) = selected {
                if tracker.id != Some(*id) {
                    tracker.reset();
                    tracker.ready = armed.contains(id);
                }
                tracker.id = Some(*id);
                let overlay = crate::controller_overlay::interactive(&app);
                if tracker.overlay && !overlay {
                    tracker.clicks_ready = false;
                }
                tracker.overlay = overlay;
                tracker.keyboard = crate::controller_overlay::keyboard_open(&app);
                tracker.switcher = status.active && shell_switcher();
                tracker.tick(pad, now, dt, &mut status);
            }
            let pending = std::mem::take(&mut tracker.pending);
            let active = status.active;
            let id = if active {
                tracker.id
            } else {
                last_id.or(tracker.id)
            };
            drop(status);
            if active != last_active {
                last_active = active;
                crate::controller_overlay::feedback(&app, active);
                if let Some(id) = id {
                    if let Some((previous_id, _)) = rumble.take() {
                        stop_vibration(previous_id);
                    }
                    vibrate(id, active);
                    rumble = Some((
                        id,
                        now + Duration::from_millis(if active { ON_RUMBLE_MS } else { OFF_RUMBLE_MS }),
                    ));
                }
            }
            last_id = tracker.id.or(last_id);
            for action in pending {
                if action == "launcher" {
                    crate::controller_overlay::hide(&app);
                    if let Err(error) = crate::launcher::open_launcher(app.clone(), None) {
                        app.state::<ControllerMouse>().0.lock().unwrap().error = error;
                    }
                    continue;
                }
                if active {
                    match action {
                        "confirm" | "keyboard" => crate::controller_overlay::open(&app, action),
                        "desktop" => {
                            crate::controller_overlay::hide(&app);
                            if let Err(error) = crate::controller_overlay::shortcut(VK_LWIN, VK_D) {
                                app.state::<ControllerMouse>().0.lock().unwrap().error = error;
                            }
                        }
                        _ => crate::controller_overlay::navigate(&app, action),
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_actions_require_mouse_mode_and_only_fire_on_press() {
        for (mask, action) in [
            (0x10, "confirm"),
            (0x20, "keyboard"),
            (0x2, "desktop"),
        ] {
            let mut tracker = Tracker {
                ready: true,
                clicks_ready: true,
                ..Default::default()
            };
            let mut status = Status::default();
            let now = Instant::now();
            let mut pad = XINPUT_GAMEPAD::default();
            pad.wButtons.0 = mask;
            tracker.tick(&pad, now, 0.008, &mut status);
            assert!(tracker.pending.is_empty());
            status.active = true;
            tracker.buttons = 0;
            tracker.tick(&pad, now, 0.008, &mut status);
            assert_eq!(tracker.pending, vec![action]);
            tracker.pending.clear();
            tracker.tick(&pad, now, 0.008, &mut status);
            assert!(tracker.pending.is_empty());
        }
    }
    #[test]
    fn task_view_keeps_the_pointer_still_and_leaves_navigation_to_windows() {
        assert!(switcher_class("XamlExplorerHostIslandWindow"));
        assert!(switcher_class("MultitaskingViewFrame"));
        assert!(!switcher_class("Progman"));
        let mut tracker = Tracker {
            ready: true,
            clicks_ready: true,
            switcher: true,
            ..Default::default()
        };
        let mut status = Status {
            active: true,
            ..Default::default()
        };
        let mut pad = XINPUT_GAMEPAD::default();
        pad.sThumbLX = 32000;
        pad.wButtons.0 = 0x2;
        tracker.tick(&pad, Instant::now(), 0.032, &mut status);
        assert!(tracker.pending.is_empty());
        assert_eq!(tracker.remainder, (0.0, 0.0));
        assert!(status.active && status.error.is_empty());
    }
    #[test]
    fn panels_route_confirm_and_navigation_without_desktop_key_injection() {
        let mut tracker = Tracker {
            ready: true,
            clicks_ready: true,
            overlay: true,
            ..Default::default()
        };
        let mut status = Status {
            active: true,
            ..Default::default()
        };
        let now = Instant::now();
        let mut pad = XINPUT_GAMEPAD::default();
        pad.wButtons.0 = 0x1008;
        tracker.tick(&pad, now, 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["right", "accept"]);
        tracker.pending.clear();
        tracker.tick(&pad, now + Duration::from_millis(100), 0.008, &mut status);
        assert!(tracker.pending.is_empty());
        tracker.tick(&pad, now + Duration::from_millis(350), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["right"]);
        tracker.pending.clear();
        pad.wButtons.0 = 0x2000;
        tracker.tick(&pad, now + Duration::from_millis(400), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["back"]);
        tracker.pending.clear();
        pad.wButtons.0 = 0x2;
        tracker.tick(&pad, now + Duration::from_millis(450), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["down"]);
        tracker.pending.clear();
        pad.wButtons.0 = 0x40;
        tracker.tick(&pad, now + Duration::from_millis(500), 0.008, &mut status);
        assert!(tracker.pending.is_empty());
        pad.wButtons.0 = 0;
        tracker.tick(&pad, now + Duration::from_millis(520), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["keyboard"]);
        tracker.pending.clear();
        pad.wButtons.0 = 0x80;
        tracker.tick(&pad, now + Duration::from_millis(550), 0.008, &mut status);
        pad.wButtons.0 = 0;
        tracker.tick(&pad, now + Duration::from_millis(570), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["desktop"]);
    }
    #[test]
    fn both_stick_clicks_open_the_command_menu_without_mouse_mode() {
        let mut tracker = Tracker {
            ready: true,
            ..Default::default()
        };
        let mut status = Status::default();
        let now = Instant::now();
        let mut pad = XINPUT_GAMEPAD::default();
        pad.wButtons.0 = 0xC0;
        tracker.tick(&pad, now, 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_millis(499), 0.008, &mut status);
        assert!(tracker.pending.is_empty());
        tracker.tick(&pad, now + Duration::from_millis(500), 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_millis(900), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["launcher"]);
        // In mouse mode, the combined press must not also toggle the keyboard or show the desktop.
        tracker.pending.clear();
        status.active = true;
        tracker.clicks_ready = true;
        pad.wButtons.0 = 0;
        tracker.tick(&pad, now + Duration::from_secs(1), 0.008, &mut status);
        pad.wButtons.0 = 0xC0;
        tracker.tick(&pad, now + Duration::from_secs(2), 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_millis(2600), 0.008, &mut status);
        pad.wButtons.0 = 0;
        tracker.tick(&pad, now + Duration::from_secs(3), 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["launcher"]);
    }
    #[test]
    fn keyboard_shortcuts_type_and_lone_shoulders_fire_on_release() {
        let mut tracker = Tracker {
            ready: true,
            clicks_ready: true,
            overlay: true,
            keyboard: true,
            ..Default::default()
        };
        let mut status = Status {
            active: true,
            ..Default::default()
        };
        let now = Instant::now();
        let mut pad = XINPUT_GAMEPAD::default();
        for (mask, action) in [(0x4000, "backspace"), (0x8000, "space"), (0x10, "enter")] {
            pad.wButtons.0 = mask;
            tracker.tick(&pad, now, 0.008, &mut status);
            assert_eq!(tracker.pending, vec![action]);
            tracker.pending.clear();
            pad.wButtons.0 = 0;
            tracker.tick(&pad, now, 0.008, &mut status);
        }
        for (buttons, left, right, action) in [
            (0x100, 0, 0, "cursor-left"),
            (0x200, 0, 0, "cursor-right"),
            (0, 255, 0, "shift"),
            (0, 0, 255, "symbols"),
        ] {
            pad.wButtons.0 = buttons;
            pad.bLeftTrigger = left;
            pad.bRightTrigger = right;
            tracker.tick(&pad, now, 0.008, &mut status);
            assert!(tracker.pending.is_empty());
            pad = XINPUT_GAMEPAD::default();
            tracker.tick(&pad, now, 0.008, &mut status);
            assert_eq!(tracker.pending, vec![action]);
            tracker.pending.clear();
        }
        // Building up the mouse chord types nothing, even if it's abandoned.
        pad.wButtons.0 = 0x100;
        tracker.tick(&pad, now, 0.008, &mut status);
        pad.bLeftTrigger = 255;
        tracker.tick(&pad, now, 0.008, &mut status);
        pad = XINPUT_GAMEPAD::default();
        tracker.tick(&pad, now, 0.008, &mut status);
        assert!(tracker.pending.is_empty());
        // Menu types Enter rather than offering to close the app.
        tracker.keyboard = false;
        pad.wButtons.0 = 0x10;
        tracker.tick(&pad, now, 0.008, &mut status);
        assert_eq!(tracker.pending, vec!["confirm"]);
    }
    #[test]
    fn chord_requires_one_second_and_release_before_clicks() {
        let mut tracker = Tracker::default();
        let mut status = Status::default();
        let now = Instant::now();
        let mut pad = XINPUT_GAMEPAD::default();
        tracker.tick(&pad, now, 0.008, &mut status);
        pad.wButtons.0 = 0x300;
        pad.bLeftTrigger = 255;
        pad.bRightTrigger = 255;
        tracker.tick(&pad, now, 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_millis(999), 0.008, &mut status);
        assert!(!status.active);
        tracker.tick(&pad, now + Duration::from_secs(1), 0.008, &mut status);
        assert!(status.active);
        assert!(!tracker.clicks_ready);
        tracker.tick(&pad, now + Duration::from_secs(3), 0.008, &mut status);
        assert!(status.active);
        pad = XINPUT_GAMEPAD::default();
        tracker.tick(&pad, now, 0.008, &mut status);
        assert!(tracker.clicks_ready);
        pad.wButtons.0 = 0x300;
        pad.bLeftTrigger = 255;
        pad.bRightTrigger = 255;
        tracker.tick(&pad, now, 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_secs(1), 0.008, &mut status);
        assert!(!status.active);
    }
    #[test]
    fn reconnect_requires_neutral_and_stick_has_dead_zone() {
        assert_eq!(velocity(4000, -4000), (0.0, 0.0));
        assert!(velocity(32767, 0).0 > 0.99);
        let mut tracker = Tracker::default();
        let mut status = Status::default();
        let mut pad = XINPUT_GAMEPAD::default();
        pad.wButtons.0 = 0x300;
        pad.bLeftTrigger = 255;
        pad.bRightTrigger = 255;
        tracker.tick(&pad, Instant::now(), 0.008, &mut status);
        assert!(!tracker.ready);
        assert!(!status.active);
    }
    #[test]
    fn short_hold_cancels_and_partial_release_does_not_retoggle() {
        let mut tracker = Tracker::default();
        let mut status = Status::default();
        let now = Instant::now();
        let mut pad = XINPUT_GAMEPAD::default();
        tracker.tick(&pad, now, 0.008, &mut status);
        pad.wButtons.0 = 0x300;
        pad.bLeftTrigger = 255;
        pad.bRightTrigger = 255;
        tracker.tick(&pad, now, 0.008, &mut status);
        pad.bRightTrigger = 0;
        tracker.tick(&pad, now + Duration::from_millis(900), 0.008, &mut status);
        pad.bRightTrigger = 255;
        tracker.tick(&pad, now + Duration::from_secs(1), 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_millis(1999), 0.008, &mut status);
        assert!(!status.active);
        tracker.tick(&pad, now + Duration::from_secs(2), 0.008, &mut status);
        assert!(status.active);
        pad.bRightTrigger = 0;
        tracker.tick(&pad, now + Duration::from_secs(3), 0.008, &mut status);
        pad.bRightTrigger = 255;
        tracker.tick(&pad, now + Duration::from_secs(4), 0.008, &mut status);
        tracker.tick(&pad, now + Duration::from_secs(6), 0.008, &mut status);
        assert!(status.active);
        assert!(!tracker.clicks_ready);
    }
}
