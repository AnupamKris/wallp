//! Wayland clients can't grab global shortcuts, so wallp registers GNOME
//! custom shortcuts that run `wallp --launcher` and friends. The single-instance
//! plugin forwards those arguments to the running copy (see `lib.rs`).
//!
//! Ctrl+Alt+D is GNOME's Show Desktop by default. wallp takes it over while
//! running and journals the original setting so a crash can't lose it.
use std::path::{Path, PathBuf};

const MEDIA_KEYS: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM_ROOT: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
const WM_KEYS: &str = "org.gnome.desktop.wm.keybindings";
const JOURNAL: &str = "gnome-show-desktop.journal";

pub const LAUNCHER: &str = "--launcher";
pub const WORKSPACE: &str = "--workspace";
pub const DESKTOP: &str = "--desktop";

struct Binding {
    key: &'static str,
    name: &'static str,
    accel: &'static str,
    arg: &'static str,
}
const BINDINGS: [Binding; 3] = [
    Binding { key: "wallp-launcher", name: "wallp command menu", accel: "<Control>space", arg: LAUNCHER },
    Binding { key: "wallp-workspace", name: "wallp workspace", accel: "<Control><Alt>w", arg: WORKSPACE },
    Binding { key: "wallp-desktop", name: "wallp desktop", accel: "<Control><Alt>d", arg: DESKTOP },
];

fn path(binding: &Binding) -> String {
    format!("{CUSTOM_ROOT}{}/", binding.key)
}

fn gsettings(args: &[&str]) -> Result<String, String> {
    super::command_output("gsettings", args)
}

/// Parses gsettings' `as` output: `['a', 'b']` or `@as []`.
fn parse_list(value: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut chars = value.trim().trim_start_matches("@as").chars();
    while let Some(c) = chars.next() {
        if c == '\'' || c == '"' {
            let mut item = String::new();
            while let Some(next) = chars.next() {
                match next {
                    '\\' => item.extend(chars.next()),
                    q if q == c => break,
                    other => item.push(other),
                }
            }
            items.push(item);
        }
    }
    items
}

/// GVariant text for a string, or a list of strings.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}
fn format_list(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|i| quote(i)).collect::<Vec<_>>().join(", "))
}

fn is_ctrl_alt_d(accel: &str) -> bool {
    let accel = accel.to_ascii_lowercase().replace("<primary>", "<control>");
    accel == "<control><alt>d"
}

/// Registers or updates wallp's GNOME shortcuts. Ctrl+Space follows the
/// launcher preference.
pub fn install(data_dir: &Path, ctrl_space: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = format!("'{}'", exe.display().to_string().replace('\'', r"'\''"));
    let mut list = parse_list(&gsettings(&["get", MEDIA_KEYS, "custom-keybindings"])?);
    for binding in &BINDINGS {
        let path = path(binding);
        let enabled = binding.arg != LAUNCHER || ctrl_space;
        list.retain(|p| *p != path);
        if !enabled {
            continue;
        }
        let schema = format!("{MEDIA_KEYS}.custom-keybinding:{path}");
        gsettings(&["set", &schema, "name", &quote(binding.name)])?;
        gsettings(&["set", &schema, "command", &quote(&format!("{exe} {}", binding.arg))])?;
        gsettings(&["set", &schema, "binding", &quote(binding.accel)])?;
        list.push(path);
    }
    gsettings(&["set", MEDIA_KEYS, "custom-keybindings", &format_list(&list)])?;
    release_show_desktop(data_dir)
}

/// Removes wallp's shortcuts and gives Ctrl+Alt+D back to GNOME.
pub fn remove(data_dir: &Path) {
    if let Ok(value) = gsettings(&["get", MEDIA_KEYS, "custom-keybindings"]) {
        let mut list = parse_list(&value);
        let ours: Vec<_> = BINDINGS.iter().map(path).collect();
        list.retain(|p| !ours.contains(p));
        let _ = gsettings(&["set", MEDIA_KEYS, "custom-keybindings", &format_list(&list)]);
    }
    for binding in &BINDINGS {
        let schema = format!("{MEDIA_KEYS}.custom-keybinding:{}", path(binding));
        for key in ["name", "command", "binding"] {
            let _ = gsettings(&["reset", &schema, key]);
        }
    }
    restore_show_desktop(data_dir);
}

fn journal(data_dir: &Path) -> PathBuf {
    data_dir.join(JOURNAL)
}

fn release_show_desktop(data_dir: &Path) -> Result<(), String> {
    let current = parse_list(&gsettings(&["get", WM_KEYS, "show-desktop"])?);
    if !current.iter().any(|a| is_ctrl_alt_d(a)) {
        return Ok(());
    }
    // Only the first run journals; after a crash the journal holds the original.
    let journal = journal(data_dir);
    if !journal.exists() {
        std::fs::write(&journal, format_list(&current)).map_err(|e| e.to_string())?;
    }
    let rest: Vec<_> = current.into_iter().filter(|a| !is_ctrl_alt_d(a)).collect();
    gsettings(&["set", WM_KEYS, "show-desktop", &format_list(&rest)]).map(|_| ())
}

/// Puts back a show-desktop shortcut journaled by this or a crashed run.
pub fn restore_show_desktop(data_dir: &Path) {
    let journal = journal(data_dir);
    if let Ok(original) = std::fs::read_to_string(&journal) {
        if gsettings(&["set", WM_KEYS, "show-desktop", original.trim()]).is_ok() {
            let _ = std::fs::remove_file(journal);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_gsettings_lists() {
        assert!(parse_list("@as []").is_empty());
        let list = parse_list("['/a/', '/it\\'s/']");
        assert_eq!(list, ["/a/", "/it's/"]);
        assert_eq!(parse_list(&format_list(&list)), list);
    }

    #[test]
    fn recognises_ctrl_alt_d_spellings() {
        assert!(is_ctrl_alt_d("<Primary><Alt>d"));
        assert!(is_ctrl_alt_d("<Control><Alt>D"));
        assert!(!is_ctrl_alt_d("<Super>d"));
        assert!(!is_ctrl_alt_d("<Primary><Super>d"));
    }
}
