//! XFCE settings wallp borrows while it runs, through `xfconf-query`:
//!
//! - xfwm4's Ctrl+Alt+D (Show Desktop), so wallp's own Ctrl+Alt+D can grab it.
//! - Bottom panels, which would pop up at the same screen edge as the dock.
//!   xfce4-panel hides a panel whose monitor is missing, so wallp points them
//!   at one that doesn't exist, and restarts the panel to bring them back.
//!
//! Each change is journaled before it's made, so a crash can't lose the
//! original; the next run (or the dock's recovery process) puts it back.
use std::path::Path;

const SHORTCUTS: &str = "xfce4-keyboard-shortcuts";
const PANEL: &str = "xfce4-panel";
const SHOW_DESKTOP_JOURNAL: &str = "xfce-show-desktop.journal";
const PANEL_JOURNAL: &str = "xfce-panels.journal";
/// An output name no monitor has.
const HIDDEN_OUTPUT: &str = "wallp-hidden";

fn xfconf(args: &[&str]) -> Result<String, String> {
    super::command_output("xfconf-query", args)
}

fn get(channel: &str, property: &str) -> Option<String> {
    xfconf(&["-c", channel, "-p", property]).ok()
}

fn set(channel: &str, property: &str, value: &str) -> Result<(), String> {
    xfconf(&[
        "-c", channel, "-p", property, "-n", "-t", "string", "-s", value,
    ])
    .map(|_| ())
}

fn reset(channel: &str, property: &str) {
    let _ = xfconf(&["-c", channel, "-p", property, "-r"]);
}

/// Journal lines are `key<TAB>value`.
fn read_journal(path: &Path) -> Vec<(String, String)> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn write_journal(path: &Path, entries: &[(String, String)]) -> Result<(), String> {
    let text: String = entries.iter().map(|(k, v)| format!("{k}\t{v}\n")).collect();
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Takes Ctrl+Alt+D from xfwm4. Only the first run journals; after a crash
/// the journal still holds the original binding.
pub fn release_show_desktop(data_dir: &Path) -> Result<(), String> {
    let properties = xfconf(&["-c", SHORTCUTS, "-l"])?;
    let taken: Vec<(String, String)> = properties
        .lines()
        .filter(|p| {
            p.strip_prefix("/xfwm4/custom/")
                .is_some_and(super::keybindings::is_ctrl_alt_d)
        })
        .filter_map(|p| Some((p.to_string(), get(SHORTCUTS, p)?)))
        .collect();
    if taken.is_empty() {
        return Ok(());
    }
    let journal = data_dir.join(SHOW_DESKTOP_JOURNAL);
    if !journal.exists() {
        write_journal(&journal, &taken)?;
    }
    for (property, _) in &taken {
        reset(SHORTCUTS, property);
    }
    Ok(())
}

/// Gives back a Ctrl+Alt+D journaled by this or a crashed run.
pub fn restore_show_desktop(data_dir: &Path) {
    let journal = data_dir.join(SHOW_DESKTOP_JOURNAL);
    let entries = read_journal(&journal);
    if entries.iter().all(|(p, v)| set(SHORTCUTS, p, v).is_ok()) {
        let _ = std::fs::remove_file(journal);
    }
}

/// Panel ids from the `/panels` array.
fn panels() -> Vec<String> {
    get(PANEL, "/panels")
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

/// Horizontal panels snapped to the bottom edge: SE, SW, bottom centre and
/// full-width bottom in xfce4-panel's snap positions.
fn is_bottom_panel(id: &str) -> bool {
    let base = format!("/panels/panel-{id}");
    let snap = get(PANEL, &format!("{base}/position"))
        .and_then(|p| {
            p.split(';')
                .find_map(|part| part.strip_prefix("p=").and_then(|v| v.parse::<u32>().ok()))
        })
        .unwrap_or(0);
    let horizontal = get(PANEL, &format!("{base}/mode")).is_none_or(|m| m == "0");
    horizontal && matches!(snap, 4 | 8 | 10 | 12)
}

/// Hides the bottom panels so the dock owns the bottom edge.
pub fn hide_bottom_panels(data_dir: &Path) -> Result<(), String> {
    let journal = data_dir.join(PANEL_JOURNAL);
    let mut saved = read_journal(&journal);
    let mut hide = Vec::new();
    for id in panels().into_iter().filter(|id| is_bottom_panel(id)) {
        let property = format!("/panels/panel-{id}/output-name");
        let current = get(PANEL, &property).unwrap_or_default();
        if !saved.iter().any(|(saved, _)| *saved == id) {
            // A panel still hidden by a run whose journal was lost had no output set.
            let original = if current == HIDDEN_OUTPUT {
                String::new()
            } else {
                current.clone()
            };
            saved.push((id.clone(), original));
        }
        if current != HIDDEN_OUTPUT {
            hide.push(property);
        }
    }
    if hide.is_empty() {
        return Ok(());
    }
    write_journal(&journal, &saved)?;
    for property in hide {
        set(PANEL, &property, HIDDEN_OUTPUT)?;
    }
    Ok(())
}

/// Puts back panels hidden by this or a crashed run. xfce4-panel doesn't
/// re-show a panel when its output comes back, so it's restarted.
pub fn restore_panels(data_dir: &Path) {
    let journal = data_dir.join(PANEL_JOURNAL);
    let saved = read_journal(&journal);
    if saved.is_empty() {
        return;
    }
    for (id, original) in &saved {
        let property = format!("/panels/panel-{id}/output-name");
        if original.is_empty() {
            reset(PANEL, &property);
        } else {
            let _ = set(PANEL, &property, original);
        }
    }
    let _ = super::command_output("xfce4-panel", &["-r"]);
    let _ = std::fs::remove_file(journal);
}

/// The icon theme from XFCE's settings, which GTK apps follow.
pub fn icon_theme() -> Option<String> {
    get("xsettings", "/Net/IconThemeName").filter(|t| !t.is_empty())
}
