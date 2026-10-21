//! Homescreen pins retain the registered app ID and icon across index refreshes.
use crate::launcher::{InstalledApp, launcher_apps};
use rusqlite::{Connection, params};
use tauri::{AppHandle, Emitter, Manager};

fn open(app: &AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let db =
        Connection::open(directory.join("home-shortcuts.sqlite3")).map_err(|e| e.to_string())?;
    initialize(&db)?;
    Ok(db)
}

fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS shortcuts (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, icon TEXT);").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn home_shortcuts(app: AppHandle) -> Result<Vec<InstalledApp>, String> {
    let db = open(&app)?;
    entries(&db)
}

fn entries(db: &Connection) -> Result<Vec<InstalledApp>, String> {
    let mut statement = db
        .prepare("SELECT id, name, icon FROM shortcuts ORDER BY position")
        .map_err(|e| e.to_string())?;
    statement
        .query_map([], |row| {
            Ok(InstalledApp {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_home_shortcut(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    let db = open(&app)?;
    if pinned {
        let entry = launcher_apps(app.clone())
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or("App is no longer in the index. Refresh apps and try again.")?;
        pin(&db, &entry)?;
    } else {
        db.execute("DELETE FROM shortcuts WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    app.emit("home://shortcuts", ()).map_err(|e| e.to_string())
}

fn pin(db: &Connection, entry: &InstalledApp) -> Result<(), String> {
    db.execute("INSERT INTO shortcuts(id,name,icon) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name,icon=excluded.icon", params![entry.id, entry.name, entry.icon]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn launch_home_shortcut(app: AppHandle, id: String) -> Result<(), String> {
    if !home_shortcuts(app)?.iter().any(|entry| entry.id == id) {
        return Err("This app is no longer pinned to Home.".into());
    }
    crate::launcher::launch_registered_app(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_survive_reopen_without_duplicates_and_keep_their_order() {
        let path = std::env::temp_dir().join(format!(
            "wallp-home-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = InstalledApp {
            id: "first".into(),
            name: "First app".into(),
            icon: Some("data:image/png;base64,example".into()),
        };
        let second = InstalledApp {
            id: "second".into(),
            name: "Second app".into(),
            icon: None,
        };
        {
            let db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            pin(&db, &first).unwrap();
            pin(&db, &second).unwrap();
            pin(
                &db,
                &InstalledApp {
                    name: "Updated name".into(),
                    ..first.clone()
                },
            )
            .unwrap();
        }
        {
            let db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            let saved = entries(&db).unwrap();
            assert_eq!(
                saved.iter().map(|app| app.id.as_str()).collect::<Vec<_>>(),
                ["first", "second"]
            );
            assert_eq!(saved[0].name, "Updated name");
            assert_eq!(saved[0].icon, first.icon);
            assert_eq!(saved[1].icon, None);
            db.execute("DELETE FROM shortcuts WHERE id=?1", [&first.id])
                .unwrap();
            assert_eq!(entries(&db).unwrap()[0].id, "second");
            assert_eq!(entries(&db).unwrap().len(), 1);
        }
        std::fs::remove_file(path).unwrap();
    }
}
