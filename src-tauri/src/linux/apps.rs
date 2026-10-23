//! Installed apps come from freedesktop `.desktop` entries (through GIO, which
//! applies NoDisplay/OnlyShowIn and user overrides). Icons are resolved from the
//! icon theme here so the index can be built off the main thread.
use crate::launcher::InstalledApp;
use base64::Engine;
use gtk::gio::{self, prelude::*};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const ICON_SIZE: u32 = 64;
/// Larger SVGs are usually illustrations, and the icon is stored in the index.
const SVG_LIMIT: u64 = 256 * 1024;

pub fn installed() -> Vec<InstalledApp> {
    let icons = icon_index(true);
    gio::AppInfo::all()
        .into_iter()
        .filter(|info| info.should_show())
        .filter_map(|info| {
            Some(InstalledApp {
                id: info.id()?.to_string(),
                name: info.display_name().to_string(),
                icon: info.icon().and_then(|icon| icons.data_url(&icon)),
            })
        })
        .collect()
}

pub fn exists(id: &str) -> bool {
    gio::DesktopAppInfo::new(id).is_some()
}

pub fn launch(id: &str) -> Result<(), String> {
    let info = gio::DesktopAppInfo::new(id)
        .ok_or("App is no longer installed. Refresh apps and try again.")?;
    info.launch(&[], None::<&gio::AppLaunchContext>)
        .map_err(|e| format!("Couldn't open {}: {e}", info.display_name()))
}

/// Looks up a themed icon name, e.g. a tray item's `IconName`.
pub fn icon_named(name: &str, extra_dir: Option<&Path>) -> Option<String> {
    if let Some(dir) = extra_dir {
        for ext in ["png", "svg"] {
            let path = dir.join(format!("{name}.{ext}"));
            if path.is_file() {
                return encode(&path);
            }
        }
    }
    icon_index(false).named(name)
}

/// Tray icons are looked up every refresh, so reuse a recent theme scan.
fn icon_index(fresh: bool) -> Arc<IconIndex> {
    static CACHE: Mutex<Option<(Instant, Arc<IconIndex>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap();
    match &*cache {
        Some((built, index)) if !fresh && built.elapsed() < Duration::from_secs(300) => index.clone(),
        _ => {
            let index = Arc::new(IconIndex::build());
            *cache = Some((Instant::now(), index.clone()));
            index
        }
    }
}

pub fn png_data_url(image: &image::RgbaImage) -> Option<String> {
    let image = if image.width() > ICON_SIZE || image.height() > ICON_SIZE {
        image::imageops::thumbnail(image, ICON_SIZE, ICON_SIZE)
    } else {
        image.clone()
    };
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    ))
}

fn encode(path: &Path) -> Option<String> {
    match path.extension()?.to_str()? {
        "svg" => {
            if std::fs::metadata(path).ok()?.len() > SVG_LIMIT {
                return None;
            }
            Some(format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(std::fs::read(path).ok()?)
            ))
        }
        "png" => png_data_url(&image::open(path).ok()?.to_rgba8()),
        _ => None,
    }
}

/// Every icon file in the active theme chain, keyed by name. Walking the
/// themes once is far cheaper than searching them for each app.
struct IconIndex(HashMap<String, Vec<(usize, u32, PathBuf)>>);

impl IconIndex {
    fn build() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let mut bases = vec![home.join(".icons")];
        bases.extend(super::data_dirs().into_iter().map(|d| d.join("icons")));
        let themes = theme_chain(&bases);
        let mut index: HashMap<String, Vec<_>> = HashMap::new();
        for (rank, theme) in themes.iter().enumerate() {
            for base in &bases {
                walk(&base.join(theme), 0, &mut |path| {
                    if let Some((name, score)) = candidate(path) {
                        index.entry(name).or_default().push((rank, score, path.to_path_buf()));
                    }
                });
            }
        }
        for dir in [PathBuf::from("/usr/share/pixmaps")].into_iter().chain(bases) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for path in entries.flatten().map(|e| e.path()) {
                    if let Some((name, score)) = candidate(&path) {
                        index.entry(name).or_default().push((themes.len(), score, path));
                    }
                }
            }
        }
        for paths in index.values_mut() {
            paths.sort_by_key(|(rank, score, _)| (*rank, *score));
        }
        Self(index)
    }

    fn named(&self, name: &str) -> Option<String> {
        self.0.get(name)?.iter().find_map(|(_, _, path)| encode(path))
    }

    fn data_url(&self, icon: &gio::Icon) -> Option<String> {
        if let Some(file) = icon.downcast_ref::<gio::FileIcon>() {
            return encode(&file.file().path()?);
        }
        let themed = icon.downcast_ref::<gio::ThemedIcon>()?;
        themed.names().iter().find_map(|name| {
            let path = Path::new(name.as_str());
            if path.is_absolute() {
                encode(path)
            } else {
                self.named(name)
            }
        })
    }
}

/// Preference for an icon file; lower is better. Mid-sized PNGs stay small
/// and sharp, SVGs scale but can be large.
fn candidate(path: &Path) -> Option<(String, u32)> {
    let ext = path.extension()?.to_str()?;
    if ext != "png" && ext != "svg" {
        return None;
    }
    let text = path.to_string_lossy();
    if text.contains("symbolic") {
        return None;
    }
    let size = path
        .ancestors()
        .filter_map(|p| p.file_name()?.to_str())
        .find_map(|part| part.split(['x', '@']).next()?.parse::<u32>().ok());
    let score = match (ext, size) {
        ("png", Some(64)) => 0,
        ("png", Some(48)) => 1,
        ("png", Some(96 | 128)) => 2,
        ("svg", _) => 3,
        ("png", Some(256 | 512)) => 4,
        ("png", Some(32)) => 5,
        _ => 10,
    };
    Some((path.file_stem()?.to_str()?.to_string(), score))
}

fn walk(dir: &Path, depth: u8, visit: &mut impl FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Follow symlinks: many themes link size directories together.
        if path.is_dir() {
            if depth < 3 {
                walk(&path, depth + 1, visit);
            }
        } else {
            visit(&path);
        }
    }
}

/// The current GNOME icon theme, the themes it inherits, then hicolor.
fn theme_chain(bases: &[PathBuf]) -> Vec<String> {
    let current = super::command_output("gsettings", &["get", "org.gnome.desktop.interface", "icon-theme"])
        .map(|v| v.trim_matches('\'').to_string())
        .unwrap_or_else(|_| "Adwaita".into());
    let mut chain = Vec::new();
    let mut queue = vec![current];
    while let Some(theme) = queue.pop() {
        if chain.contains(&theme) || chain.len() > 16 {
            continue;
        }
        let inherits = bases
            .iter()
            .find_map(|base| std::fs::read_to_string(base.join(&theme).join("index.theme")).ok())
            .and_then(|index| {
                index
                    .lines()
                    .find_map(|line| line.strip_prefix("Inherits=").map(str::to_string))
            })
            .unwrap_or_default();
        chain.push(theme);
        queue.extend(inherits.split(',').rev().map(str::trim).filter(|t| !t.is_empty()).map(String::from));
    }
    chain.retain(|t| t != "hicolor");
    chain.push("hicolor".into());
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_mid_sized_pngs_and_skips_symbolic_icons() {
        let score = |p: &str| candidate(Path::new(p)).map(|(_, s)| s);
        assert_eq!(score("/i/hicolor/64x64/apps/foo.png"), Some(0));
        assert_eq!(score("/i/hicolor/48x48@2/apps/foo.png"), Some(1));
        assert_eq!(score("/i/hicolor/scalable/apps/foo.svg"), Some(3));
        assert_eq!(score("/i/Papirus/apps/48/foo.png").is_some(), true);
        assert_eq!(score("/i/hicolor/symbolic/apps/foo-symbolic.svg"), None);
        assert_eq!(score("/i/hicolor/48x48/apps/foo.xpm"), None);
    }

    #[test]
    fn installed_apps_have_ids_names_and_some_icons() {
        let apps = installed();
        assert!(!apps.is_empty(), "GNOME should list .desktop apps");
        assert!(apps.iter().all(|a| a.id.ends_with(".desktop") && !a.name.is_empty()));
        assert!(apps.iter().any(|a| a.icon.is_some()), "some apps should resolve icons");
    }
}
