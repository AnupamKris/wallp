// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if wallp_lib::recovery_entry() {
        return;
    }
    wallp_lib::run()
}
