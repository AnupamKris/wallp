// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // GNOME's Wayland session has no way to sit behind other windows or use
    // global shortcuts; XWayland does (see src/linux/desktop.rs).
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        // SAFETY: nothing else is running yet.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }
    if wallp_lib::recovery_entry() {
        return;
    }
    wallp_lib::run()
}
