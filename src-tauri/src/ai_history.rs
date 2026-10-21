//! Completed AI turns are saved locally, separately from clipboard history.
use crate::agnes::Message;
use rusqlite::{Connection, params};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    id: String,
    title: String,
    updated_at: i64,
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let db = Connection::open(directory.join("ai-chats.sqlite3")).map_err(|e| e.to_string())?;
    initialize(&db)?;
    Ok(db)
}

fn initialize(db: &Connection) -> Result<(), String> {
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())
}

fn save(db: &Connection, id: &str, messages: &[Message]) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || messages.is_empty() {
        return Err("Invalid conversation.".into());
    }
    let title: String = messages[0]
        .content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100)
        .collect();
    let data = serde_json::to_string(messages).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO chats(id,title,messages,updated_at) VALUES(?1,?2,?3,?4)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,messages=excluded.messages,updated_at=excluded.updated_at",
        params![id, title, data, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn ai_save_chat(
    app: tauri::AppHandle,
    id: String,
    messages: Vec<Message>,
) -> Result<(), String> {
    save(&open(&app)?, &id, &messages)
}

#[tauri::command]
pub fn ai_list_chats(app: tauri::AppHandle) -> Result<Vec<ChatSummary>, String> {
    let db = open(&app)?;
    let mut statement = db
        .prepare("SELECT id,title,updated_at FROM chats ORDER BY updated_at DESC,id")
        .map_err(|e| e.to_string())?;
    statement
        .query_map([], |row| {
            Ok(ChatSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_load_chat(app: tauri::AppHandle, id: String) -> Result<Vec<Message>, String> {
    let data: String = open(&app)?
        .query_row("SELECT messages FROM chats WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|_| "Could not open this saved chat.".to_owned())?;
    serde_json::from_str(&data).map_err(|_| "This saved chat could not be read.".into())
}

#[tauri::command]
pub fn ai_delete_chat(app: tauri::AppHandle, id: String) -> Result<(), String> {
    open(&app)?
        .execute("DELETE FROM chats WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_chat_survives_reopen_updates_and_deletes() {
        let path = std::env::temp_dir().join(format!(
            "wallp-ai-test-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let messages: Vec<Message> = serde_json::from_str(r##"[{"role":"user","content":"A question"},{"role":"assistant","content":"# Answer\n**Yes**"}]"##).unwrap();
        {
            let db = Connection::open(&path).unwrap();
            initialize(&db).unwrap();
            save(&db, "first", &messages).unwrap();
            save(&db, "second", &messages).unwrap();
        }
        let db = Connection::open(&path).unwrap();
        let raw: String = db
            .query_row("SELECT messages FROM chats WHERE id='first'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(serde_json::to_string(&messages).unwrap(), raw);
        save(&db, "first", &messages[..1]).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM chats", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        db.execute("DELETE FROM chats WHERE id=?1", ["first"])
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM chats", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
