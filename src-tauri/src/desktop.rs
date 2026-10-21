//! Embeds a window into the Windows desktop (the "WorkerW trick").
//!
//! Explorer draws the wallpaper and the icon view (`SHELLDLL_DefView`) inside
//! `Progman`. Sending `Progman` the undocumented message `0x052C` makes
//! Explorer create a `WorkerW` that sits behind the icons. Reparenting our
//! window into that layer makes it part of the desktop: it isn't affected by
//! Win+D, doesn't show up in Alt+Tab, and stays put when other windows change.
//!
//! Two layouts exist:
//! - **Before Windows 11 24H2:** the icons live in a top-level `WorkerW` (or
//!   `Progman`), and the wallpaper `WorkerW` is the next top-level window after
//!   it. We become a child of that wallpaper `WorkerW`.
//! - **24H2 and later:** `SHELLDLL_DefView` and `WorkerW` are *children* of
//!   `Progman`. We become a child of `Progman` too, inserted just below the
//!   icon view. `Progman` is composed without a redirection bitmap here, so
//!   our window has to be layered or it won't be drawn at all.

use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, POINT, WPARAM},
        Graphics::Gdi::MapWindowPoints,
        UI::{
            Shell::{
                QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
                SHQueryUserNotificationState,
            },
            WindowsAndMessaging::*,
        },
    },
    core::{BOOL, PCWSTR, Result, w},
};

/// Undocumented: asks Explorer to create the wallpaper `WorkerW`.
const WM_SPAWN_WORKER: u32 = 0x052C;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// Where our window was attached. Handles are stored as `isize` so this can
/// cross threads; they're only ever turned back into `HWND`s for Win32 calls.
#[derive(Clone, Copy, Debug)]
pub struct Attachment {
    window: isize,
    parent: isize,
    /// `SHELLDLL_DefView`, the desktop icon list.
    icons: isize,
    /// Pre-24H2 only: the top-level `WorkerW` holding the icons. It covers the
    /// screen, so it has to be hidden with them or it swallows our clicks.
    icons_host: Option<isize>,
    /// The virtual screen we were sized to, in screen coordinates.
    pub bounds: Rect,
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

/// The bounding box of all monitors. Its origin can be negative when a
/// monitor sits left of or above the primary one.
pub fn virtual_screen() -> Rect {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Reparents `window` into the desktop and sizes it to cover every monitor.
/// Safe to call again on an attached window, e.g. after Explorer restarts or
/// the monitor layout changes.
pub fn attach(window: HWND) -> Result<Attachment> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null())?;
        SendMessageTimeoutW(
            progman,
            WM_SPAWN_WORKER,
            WPARAM(0xD),
            LPARAM(1),
            SMTO_NORMAL,
            1000,
            None,
        );

        let (parent, icons, icons_host) = match find_legacy_worker() {
            Some((host, worker)) => {
                let icons =
                    FindWindowExW(Some(host), None, w!("SHELLDLL_DefView"), PCWSTR::null())?;
                (worker, icons, (host != progman).then_some(host))
            }
            None => {
                let icons =
                    FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null())?;
                (progman, icons, None)
            }
        };

        // SetParent's return value is the *previous* parent, which is null
        // the first time, so check the result directly instead.
        let _ = SetParent(window, Some(parent));
        if GetAncestor(window, GA_PARENT) != parent {
            return Err(windows::core::Error::from_thread());
        }

        let attachment = Attachment {
            window: window.0 as isize,
            parent: parent.0 as isize,
            icons: icons.0 as isize,
            icons_host: icons_host.map(|h| h.0 as isize),
            bounds: virtual_screen(),
        };
        attachment.place()?;
        Ok(attachment)
    }
}

/// Pre-24H2: finds the top-level window containing `SHELLDLL_DefView`, and
/// the wallpaper `WorkerW` that follows it. Returns `(icon_host, worker)`.
fn find_legacy_worker() -> Option<(HWND, HWND)> {
    unsafe extern "system" fn visit(top: HWND, out: LPARAM) -> BOOL {
        unsafe {
            if FindWindowExW(Some(top), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
                if let Ok(worker) = FindWindowExW(None, Some(top), w!("WorkerW"), PCWSTR::null()) {
                    *(out.0 as *mut Option<(HWND, HWND)>) = Some((top, worker));
                    return false.into();
                }
            }
        }
        true.into()
    }

    let mut found: Option<(HWND, HWND)> = None;
    unsafe {
        // Errors when the callback stops early, which is the success case.
        let _ = EnumWindows(Some(visit), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

impl Attachment {
    /// Positions the window over the virtual screen, in parent coordinates,
    /// and applies the style and z-order the layout needs. Call it again
    /// after showing the window: Tauri's `show()` resets both.
    pub fn place(&self) -> Result<()> {
        let window = hwnd(self.window);
        let b = self.bounds;
        let mut origin = [POINT { x: b.x, y: b.y }];
        unsafe {
            MapWindowPoints(None, Some(hwnd(self.parent)), &mut origin);
            // On 24H2+ we share a parent with the icons: be layered so we get
            // drawn at all, and sit directly below them.
            let shares_parent = GetAncestor(hwnd(self.icons), GA_PARENT) == hwnd(self.parent);
            let (after, flags) = if shares_parent {
                let ex = GetWindowLongPtrW(window, GWL_EXSTYLE);
                SetWindowLongPtrW(window, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as isize);
                SetLayeredWindowAttributes(window, COLORREF(0), 255, LWA_ALPHA)?;
                (Some(hwnd(self.icons)), SWP_NOACTIVATE)
            } else {
                (None, SWP_NOACTIVATE | SWP_NOZORDER)
            };
            SetWindowPos(window, after, origin[0].x, origin[0].y, b.w, b.h, flags)
        }
    }

    /// False once Explorer has restarted or something else reparented us.
    pub fn is_intact(&self) -> bool {
        unsafe {
            IsWindow(Some(hwnd(self.window))).as_bool()
                && IsWindow(Some(hwnd(self.parent))).as_bool()
                && GetAncestor(hwnd(self.window), GA_PARENT) == hwnd(self.parent)
        }
    }

    pub fn set_icons_visible(&self, visible: bool) {
        let cmd = if visible { SW_SHOW } else { SW_HIDE };
        unsafe {
            if let Some(host) = self.icons_host {
                let _ = ShowWindow(hwnd(host), cmd);
            }
            let _ = ShowWindow(hwnd(self.icons), cmd);
        }
    }
}

/// True while a fullscreen game, video or presentation is in front, so the
/// desktop can't be seen and animations should pause.
pub fn fullscreen_app_running() -> bool {
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

/// Re-applies the current wallpaper. Run on exit so the last frame of our
/// window doesn't linger on the desktop.
pub fn refresh_wallpaper() {
    let mut path = [0u16; 260];
    unsafe {
        if SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            path.len() as u32,
            Some(path.as_mut_ptr().cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .is_ok()
        {
            let _ = SystemParametersInfoW(
                SPI_SETDESKWALLPAPER,
                0,
                Some(path.as_mut_ptr().cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            );
        }
    }
}
