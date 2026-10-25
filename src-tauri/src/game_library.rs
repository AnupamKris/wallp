//! Installed games for Game Mode: Steam, Epic Games, and Riot are detected from
//! their local manifests; anything else can be added by hand.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    id: String,
    name: String,
    source: &'static str,
    /// Portrait or header artwork on disk, served through the asset protocol.
    art: Option<String>,
    /// Wide background artwork on disk.
    hero: Option<String>,
    /// Executable icon as a data URL, used when there is no artwork.
    icon: Option<String>,
    last_played: Option<u64>,
    hidden: bool,
    /// Path or URI for games added by hand, shown so they can be recognised.
    target: Option<String>,
    #[serde(skip)]
    launch: Launch,
}

#[derive(Clone, Default)]
enum Launch {
    #[default]
    None,
    Uri(String),
    Program(PathBuf, Vec<String>),
}

#[derive(Clone, Serialize, Deserialize)]
struct CustomGame {
    id: String,
    name: String,
    target: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    custom: Vec<CustomGame>,
    hidden: Vec<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("games.json"))
}
fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    std::fs::write(
        settings_path(app)?,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Couldn't save your game list: {e}"))
}

fn vdf_values(text: &str, key: &str) -> Vec<String> {
    Regex::new(&format!(r#"(?i)"{key}"\s+"((?:[^"\\]|\\.)*)""#))
        .unwrap()
        .captures_iter(text)
        .map(|c| c[1].replace("\\\\", "\\").replace("\\\"", "\""))
        .collect()
}
fn vdf_value(text: &str, key: &str) -> Option<String> {
    vdf_values(text, key).into_iter().next()
}

fn steam_root() -> Option<PathBuf> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .ok();
    let path = key
        .and_then(|k| k.get_value::<String, _>("SteamPath").ok())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("ProgramFiles(x86)").map(|p| PathBuf::from(p).join("Steam")))?;
    path.join("steamapps").is_dir().then_some(path)
}

/// Steam keeps artwork either at the top of the app's cache folder or one
/// hashed folder below it, depending on the client version.
fn steam_art(cache: &Path, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        let direct = cache.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        if let Ok(entries) = std::fs::read_dir(cache) {
            for entry in entries.flatten() {
                let nested = entry.path().join(name);
                if nested.is_file() {
                    return Some(nested);
                }
            }
        }
    }
    None
}

fn steam_games(app: &AppHandle, art: bool) -> Vec<Game> {
    let Some(root) = steam_root() else {
        return vec![];
    };
    let mut libraries = vec![root.clone()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps/libraryfolders.vdf")) {
        for path in vdf_values(&text, "path").into_iter().map(PathBuf::from) {
            if !libraries.iter().any(|known| same_path(known, &path)) {
                libraries.push(path);
            }
        }
    }
    let cache = root.join("appcache/librarycache");
    if art && cache.is_dir() {
        let _ = app.asset_protocol_scope().allow_directory(&cache, true);
    }
    // Redistributables, runtimes, and the Spacewar test app are not games.
    let tools = Regex::new(r"(?i)^(steamworks|steam linux runtime|proton|spacewar$)").unwrap();
    let mut games = vec![];
    for library in libraries {
        let Ok(entries) = std::fs::read_dir(library.join("steamapps")) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_lowercase();
            if !file.starts_with("appmanifest_") || !file.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let (Some(appid), Some(name)) = (vdf_value(&text, "appid"), vdf_value(&text, "name"))
            else {
                continue;
            };
            let installed = vdf_value(&text, "StateFlags")
                .and_then(|flags| flags.parse::<u32>().ok())
                .is_some_and(|flags| flags & 4 != 0);
            if !installed || appid == "228980" || tools.is_match(&name) {
                continue;
            }
            let folder = cache.join(&appid);
            let art_path = |names: &[&str]| {
                art.then(|| steam_art(&folder, names))
                    .flatten()
                    .map(|p| p.to_string_lossy().into_owned())
            };
            games.push(Game {
                id: format!("steam:{appid}"),
                name,
                source: "steam",
                art: art_path(&["library_600x900.jpg", "library_capsule.jpg", "header.jpg", "library_header.jpg"]),
                hero: art_path(&["library_hero.jpg"]),
                icon: None,
                last_played: vdf_value(&text, "LastPlayed")
                    .and_then(|v| v.parse().ok())
                    .filter(|v| *v > 0),
                hidden: false,
                target: None,
                launch: Launch::Uri(format!("steam://rungameid/{appid}")),
            });
        }
    }
    games
}

fn same_path(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    normal(a) == normal(b)
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct EpicManifest {
    display_name: String,
    app_name: String,
    catalog_namespace: String,
    catalog_item_id: String,
    #[serde(default)]
    install_location: String,
    #[serde(default)]
    launch_executable: String,
    #[serde(default)]
    main_game_app_name: String,
    #[serde(default)]
    app_categories: Vec<String>,
    #[serde(default, rename = "bIsIncompleteInstall")]
    incomplete: bool,
}

fn epic_games(art: bool) -> Vec<Game> {
    let Some(data) = std::env::var_os("ProgramData") else {
        return vec![];
    };
    let Ok(entries) = std::fs::read_dir(PathBuf::from(data).join("Epic/EpicGamesLauncher/Data/Manifests")) else {
        return vec![];
    };
    let mut games = vec![];
    for entry in entries.flatten() {
        if entry.path().extension().is_none_or(|ext| ext != "item") {
            continue;
        }
        let Some(item) = std::fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<EpicManifest>(&bytes).ok())
        else {
            continue;
        };
        // Engines, plugins, and DLC share the manifest folder with games.
        if item.incomplete
            || !item.main_game_app_name.is_empty()
            || !item.app_categories.iter().any(|c| c == "games")
        {
            continue;
        }
        let exe = Path::new(&item.install_location).join(&item.launch_executable);
        games.push(Game {
            id: format!("epic:{}", item.app_name),
            name: item.display_name,
            source: "epic",
            art: None,
            hero: None,
            icon: (art && exe.is_file())
                .then(|| crate::launcher::shell_icon(&exe.to_string_lossy(), 256))
                .flatten(),
            last_played: None,
            hidden: false,
            target: None,
            launch: Launch::Uri(format!(
                "com.epicgames.launcher://apps/{}%3A{}%3A{}?action=launch&silent=true",
                item.catalog_namespace, item.catalog_item_id, item.app_name
            )),
        });
    }
    games
}

fn riot_games(art: bool) -> Vec<Game> {
    let Some(data) = std::env::var_os("ProgramData").map(|p| PathBuf::from(p).join("Riot Games")) else {
        return vec![];
    };
    let client = std::fs::read(data.join("RiotClientInstalls.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v["rc_default"].as_str().map(PathBuf::from))
        .filter(|path| path.is_file());
    let Some(client) = client else {
        return vec![];
    };
    let install = Regex::new(r#"(?m)^product_install_full_path:\s*"([^"]+)""#).unwrap();
    [("valorant", "VALORANT"), ("league_of_legends", "League of Legends"), ("bacon", "Legends of Runeterra")]
        .into_iter()
        .filter_map(|(product, name)| {
            let folder = data.join(format!("Metadata/{product}.live"));
            let settings = std::fs::read_to_string(folder.join(format!("{product}.live.product_settings.yaml"))).ok()?;
            let path = PathBuf::from(&install.captures(&settings)?[1]);
            path.is_dir().then_some(())?;
            let ico = folder.join(format!("{product}.live.ico"));
            Some(Game {
                id: format!("riot:{product}"),
                name: name.into(),
                source: "riot",
                art: None,
                hero: None,
                icon: (art && ico.is_file())
                    .then(|| crate::launcher::shell_icon(&ico.to_string_lossy(), 256))
                    .flatten(),
                last_played: None,
                hidden: false,
                target: None,
                launch: Launch::Program(
                    client.clone(),
                    vec![format!("--launch-product={product}"), "--launch-patchline=live".into()],
                ),
            })
        })
        .collect()
}

fn is_uri(target: &str) -> bool {
    Regex::new(r"^[A-Za-z][A-Za-z0-9+.\-]+://").unwrap().is_match(target)
}

fn custom_games(settings: &Settings, art: bool) -> Vec<Game> {
    settings
        .custom
        .iter()
        .map(|game| {
            // Shortcuts, links, and scripts open through the shell like a double-click.
            let uri = is_uri(&game.target) || !game.target.to_lowercase().ends_with(".exe");
            Game {
                id: game.id.clone(),
                name: game.name.clone(),
                source: "custom",
                art: None,
                hero: None,
                icon: (art && !uri)
                    .then(|| crate::launcher::shell_icon(&game.target, 256))
                    .flatten(),
                last_played: None,
                hidden: false,
                target: Some(game.target.clone()),
                launch: if uri {
                    Launch::Uri(game.target.clone())
                } else {
                    Launch::Program(game.target.clone().into(), vec![])
                },
            }
        })
        .collect()
}

fn scan(app: &AppHandle, art: bool) -> Vec<Game> {
    let settings = load(app);
    let com = art && unsafe {
        windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED).is_ok()
    };
    let mut games = steam_games(app, art);
    games.extend(epic_games(art));
    games.extend(riot_games(art));
    games.extend(custom_games(&settings, art));
    if com {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
    for game in &mut games {
        game.hidden = settings.hidden.contains(&game.id);
    }
    games.sort_by(|a, b| {
        b.last_played
            .cmp(&a.last_played)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    games
}

#[tauri::command]
pub async fn game_library(app: AppHandle) -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(move || scan(&app, true))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launch_game(app: AppHandle, id: String) -> Result<(), String> {
    let game = scan(&app, false)
        .into_iter()
        .find(|game| game.id == id)
        .ok_or("This game is no longer installed. Refresh the library and try again.")?;
    let spawned = match game.launch {
        Launch::Uri(uri) => Command::new("explorer.exe")
            .arg(uri)
            .creation_flags(0x08000000)
            .spawn(),
        Launch::Program(path, args) => {
            if !path.is_file() {
                return Err(format!("Couldn't find {}. Edit the game and choose its program again.", path.display()));
            }
            let mut command = Command::new(&path);
            if let Some(dir) = path.parent() {
                command.current_dir(dir);
            }
            command.args(args).spawn()
        }
        Launch::None => return Err("This game has no launch target.".into()),
    };
    spawned
        .map(|_| ())
        .map_err(|e| format!("Couldn't start {}: {e}", game.name))
}

#[tauri::command]
pub fn add_custom_game(app: AppHandle, name: String, target: String) -> Result<(), String> {
    let name = name.trim().to_string();
    let target = target.trim().trim_matches('"').to_string();
    if name.is_empty() {
        return Err("Enter a name for the game.".into());
    }
    if !is_uri(&target) && !Path::new(&target).is_file() {
        return Err("Choose a program (.exe) that exists, or enter a launch link such as steam://rungameid/730.".into());
    }
    let mut settings = load(&app);
    let id = format!(
        "custom:{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    settings.custom.push(CustomGame { id, name, target });
    save(&app, &settings)
}

#[tauri::command]
pub fn remove_custom_game(app: AppHandle, id: String) -> Result<(), String> {
    let mut settings = load(&app);
    settings.custom.retain(|game| game.id != id);
    settings.hidden.retain(|hidden| *hidden != id);
    save(&app, &settings)
}

#[tauri::command]
pub fn set_game_hidden(app: AppHandle, id: String, hidden: bool) -> Result<(), String> {
    let mut settings = load(&app);
    settings.hidden.retain(|known| *known != id);
    if hidden {
        settings.hidden.push(id);
    }
    save(&app, &settings)
}

/// Native file picker for a game's program.
#[tauri::command]
pub async fn pick_game_program() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| unsafe {
        use windows::{
            Win32::{System::Com::*, UI::Shell::{Common::COMDLG_FILTERSPEC, *}},
            core::w,
        };
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| -> Result<Option<String>, String> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let filters = [
                COMDLG_FILTERSPEC { pszName: w!("Programs"), pszSpec: w!("*.exe;*.lnk;*.url;*.bat") },
                COMDLG_FILTERSPEC { pszName: w!("All files"), pszSpec: w!("*.*") },
            ];
            dialog.SetFileTypes(&filters).map_err(|e| e.to_string())?;
            dialog.SetTitle(w!("Choose a game")).map_err(|e| e.to_string())?;
            // Return shortcuts themselves instead of resolving them to their target.
            let options = dialog.GetOptions().map_err(|e| e.to_string())?;
            dialog
                .SetOptions(options | FOS_NODEREFERENCELINKS | FOS_FILEMUSTEXIST)
                .map_err(|e| e.to_string())?;
            if dialog.Show(None).is_err() {
                return Ok(None);
            }
            let item = dialog.GetResult().map_err(|e| e.to_string())?;
            let path = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|e| e.to_string())?;
            let text = path.to_string().map_err(|e| e.to_string());
            CoTaskMemFree(Some(path.0 as _));
            text.map(Some)
        })();
        if initialized {
            CoUninitialize();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_library_paths_and_manifest_fields() {
        let folders = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"H:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(vdf_values(folders, "path"), ["C:\\Program Files (x86)\\Steam", "H:\\SteamLibrary"]);
        let manifest = "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"StateFlags\"\t\t\"4\"\n}";
        assert_eq!(vdf_value(manifest, "appid").as_deref(), Some("730"));
        assert_eq!(vdf_value(manifest, "name").as_deref(), Some("Counter-Strike 2"));
        assert!(same_path(Path::new("c:/program files (x86)/steam"), Path::new("C:\\Program Files (x86)\\Steam\\")));
    }

    #[test]
    fn launch_links_are_not_paths() {
        assert!(is_uri("steam://rungameid/730"));
        assert!(is_uri("com.epicgames.launcher://apps/x"));
        assert!(!is_uri("C:\\Games\\game.exe"));
    }
}
