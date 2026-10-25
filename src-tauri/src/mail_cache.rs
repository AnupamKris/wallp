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

pub fn search(
    app: &tauri::AppHandle,
    account: &str,
    query: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let db = open(app)?;
    search_db(&db, account, query)
}

fn search_db(
    db: &Connection,
    account: &str,
    query: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut statement = db.prepare("SELECT data FROM inbox WHERE account=?1 UNION ALL SELECT data FROM threads WHERE account=?1").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([account], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let query = query.to_lowercase();
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let data: serde_json::Value =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let messages = data
            .as_array()
            .or_else(|| data.get("messages").and_then(|v| v.as_array()));
        for message in messages.into_iter().flatten() {
            let matches = ["subject", "snippet", "body", "bodyHtml"]
                .iter()
                .any(|field| {
                    message
                        .get(field)
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s.to_lowercase().contains(&query))
                })
                || message
                    .get("from")
                    .is_some_and(|v| v.to_string().to_lowercase().contains(&query));
            if matches
                && let Some(id) = message.get("id").and_then(|v| v.as_str())
                && seen.insert(id.to_owned())
            {
                found.push(serde_json::json!({ "id": id, "threadId": message["threadId"], "subject": message["subject"], "snippet": message["snippet"] }));
                if found.len() >= 50 {
                    return Ok(found);
                }
            }
        }
    }
    Ok(found)
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

#[cfg(test)]
mod search_tests {
    use super::*;
    #[test]
    fn cached_search_matches_bodies_and_senders_and_stays_within_the_account() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE inbox(account TEXT,data TEXT); CREATE TABLE threads(account TEXT,data TEXT);").unwrap();
        let message = serde_json::json!({"id":"abc", "threadId":"thread", "subject":"Travel", "snippet":"Trip", "body":"Train confirmation", "from":{"email":"Tickets@example.com"}});
        let inbox = serde_json::json!({"messages":[message]}).to_string();
        db.execute("INSERT INTO inbox VALUES (?1,?2)", params!["mine", inbox])
            .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1,?2)",
            params!["mine", serde_json::json!([message]).to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO inbox VALUES (?1,?2)",
            params![
                "other",
                serde_json::json!({"messages":[{"id":"private","subject":"Secret confirmation"}]})
                    .to_string()
            ],
        )
        .unwrap();
        let found = search_db(&db, "mine", "CONFIRMATION").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], "abc");
        assert!(found[0].get("body").is_none());
        assert_eq!(
            search_db(&db, "mine", "tickets@example.com").unwrap().len(),
            1
        );
        assert!(search_db(&db, "mine", "Secret").unwrap().is_empty());
    }
}
