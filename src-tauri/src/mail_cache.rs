//! Local Gmail cache so the Emails panel opens instantly and syncs quietly.
//! Stores the inbox listing and whole conversations as JSON, per account.
use rusqlite::{Connection, OptionalExtension, params};
use tauri::Manager;

/// Conversations kept on disk; the least recently synced are pruned first.
const MAX_THREADS: i64 = 1000;

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let db = Connection::open(directory.join("mail-cache.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS inbox (account TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads (
            account TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
            updated_at INTEGER NOT NULL, PRIMARY KEY (account, id)
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(db)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load_inbox(app: &tauri::AppHandle, account: &str) -> Option<String> {
    open(app)
        .ok()?
        .query_row("SELECT data FROM inbox WHERE account=?1", [account], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten()
}

pub fn save_inbox(app: &tauri::AppHandle, account: &str, data: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "INSERT INTO inbox(account,data) VALUES(?1,?2)
            ON CONFLICT(account) DO UPDATE SET data=excluded.data",
            params![account, data],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn load_thread(app: &tauri::AppHandle, account: &str, id: &str) -> Option<String> {
    open(app)
        .ok()?
        .query_row(
            "SELECT data FROM threads WHERE account=?1 AND id=?2",
            [account, id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

pub fn save_thread(
    app: &tauri::AppHandle,
    account: &str,
    id: &str,
    data: &str,
) -> Result<(), String> {
    let db = open(app)?;
    db.execute(
        "INSERT INTO threads(account,id,data,updated_at) VALUES(?1,?2,?3,?4)
        ON CONFLICT(account,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
        params![account, id, data, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM threads WHERE account=?1 AND id NOT IN
        (SELECT id FROM threads WHERE account=?1 ORDER BY updated_at DESC LIMIT ?2)",
        params![account, MAX_THREADS],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Removes every cached message, for all accounts.
pub fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    open(app)?
        .execute_batch("DELETE FROM inbox; DELETE FROM threads;")
        .map_err(|e| e.to_string())
}
