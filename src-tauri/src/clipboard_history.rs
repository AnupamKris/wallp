//! Disk-backed history. Only a page of previews crosses the webview boundary.
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub enum Content {
    Text(String),
    Image(image::RgbaImage),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    id: i64,
    kind: String,
    text: String,
    preview: Option<String>,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub entries: Vec<Clip>,
    total: i64,
    has_more: bool,
}

pub struct History(Connection);
impl History {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let mut connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA journal_mode=WAL;
            PRAGMA secure_delete=ON;
            CREATE TABLE IF NOT EXISTS clips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash BLOB NOT NULL UNIQUE, kind TEXT NOT NULL, text TEXT NOT NULL, search_text TEXT NOT NULL,
                image BLOB, preview BLOB, width INTEGER NOT NULL, height INTEGER NOT NULL
            );").map_err(|e| e.to_string())?;
        let has_search = {
            let mut columns = connection
                .prepare("PRAGMA table_info(clips)")
                .map_err(|e| e.to_string())?;
            let names = columns
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            names
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
                .iter()
                .any(|name| name == "search_text")
        };
        if !has_search {
            let tx = connection.transaction().map_err(|e| e.to_string())?;
            tx.execute_batch("ALTER TABLE clips ADD COLUMN search_text TEXT NOT NULL DEFAULT '';")
                .map_err(|e| e.to_string())?;
            {
                let mut rows = tx
                    .prepare("SELECT id,text FROM clips ORDER BY id")
                    .map_err(|e| e.to_string())?;
                let entries = rows
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                for entry in entries {
                    let (id, text) = entry.map_err(|e| e.to_string())?;
                    tx.execute(
                        "UPDATE clips SET search_text=?1 WHERE id=?2",
                        params![text.to_lowercase(), id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(Self(connection))
    }

    pub fn remember(&mut self, content: Content) -> Result<(), String> {
        let (kind, text, bytes, preview, width, height) = match content {
            Content::Text(text) => ("text", text, Vec::new(), Vec::new(), 0, 0),
            Content::Image(image) => {
                let (width, height) = image.dimensions();
                let image = image::DynamicImage::ImageRgba8(image);
                let thumb = image.thumbnail(160, 96);
                let mut preview = std::io::Cursor::new(Vec::new());
                thumb
                    .write_to(&mut preview, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
                let mut bytes = std::io::Cursor::new(Vec::new());
                image
                    .write_to(&mut bytes, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
                (
                    "image",
                    format!("Image {width} × {height}"),
                    bytes.into_inner(),
                    preview.into_inner(),
                    width,
                    height,
                )
            }
        };
        let mut hash = Sha256::new();
        hash.update(kind.as_bytes());
        hash.update(text.as_bytes());
        hash.update(&bytes);
        let hash = hash.finalize();
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        // Re-copying moves a duplicate to the front without losing older distinct entries.
        tx.execute("DELETE FROM clips WHERE hash=?1", [hash.as_slice()])
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO clips(hash,kind,text,image,preview,width,height,search_text) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![hash.as_slice(), kind, text, bytes, preview, width, height, text.to_lowercase()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn page(&self, query: &str, offset: u64) -> Result<Page, String> {
        // instr treats %, _ and backslashes as literal search text.
        let query = query.to_lowercase();
        let total: i64 = self
            .0
            .query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut statement = self
            .0
            .prepare(
                "SELECT id,kind,text,preview,width,height FROM clips
            WHERE instr(search_text,?1)>0 ORDER BY id DESC LIMIT 51 OFFSET ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut entries = statement
            .query_map(
                params![query, i64::try_from(offset).map_err(|e| e.to_string())?],
                |r| {
                    let preview: Vec<u8> = r.get(3)?;
                    Ok(Clip {
                        id: r.get(0)?,
                        kind: r.get(1)?,
                        text: r.get(2)?,
                        preview: if preview.is_empty() {
                            None
                        } else {
                            Some(format!(
                                "data:image/png;base64,{}",
                                STANDARD.encode(preview)
                            ))
                        },
                        width: r.get(4)?,
                        height: r.get(5)?,
                    })
                },
            )
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let has_more = entries.len() > 50;
        entries.truncate(50);
        Ok(Page {
            entries,
            total,
            has_more,
        })
    }

    pub fn get(&self, id: i64) -> Result<Content, String> {
        let (kind, text, bytes): (String, String, Vec<u8>) = self
            .0
            .query_row("SELECT kind,text,image FROM clips WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        if kind == "image" {
            Ok(Content::Image(
                image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
                    .map_err(|e| e.to_string())?
                    .to_rgba8(),
            ))
        } else {
            Ok(Content::Text(text))
        }
    }

    pub fn clear(&self) -> Result<(), String> {
        self.0
            .execute_batch("DELETE FROM clips; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn older_database_gets_unicode_search_without_losing_entries() {
        let path = std::env::temp_dir().join(format!(
            "wallp-history-migration-test-{}.db",
            std::process::id()
        ));
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE clips (id INTEGER PRIMARY KEY AUTOINCREMENT, hash BLOB UNIQUE NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, image BLOB, preview BLOB, width INTEGER NOT NULL, height INTEGER NOT NULL);
                INSERT INTO clips VALUES (1,X'01','text','ÉTÉ',X'',X'',0,0);").unwrap();
        }
        {
            let history = History::open(&path).unwrap();
            let page = history.page("été", 0).unwrap();
            assert_eq!(page.entries.len(), 1);
            assert_eq!(page.entries[0].id, 1);
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn history_survives_restart_and_pages_without_a_retention_cap() {
        let path =
            std::env::temp_dir().join(format!("wallp-history-test-{}.db", std::process::id()));
        {
            let mut history = History::open(&path).unwrap();
            for n in 0..125 {
                history
                    .remember(Content::Text(format!("Text {n}")))
                    .unwrap();
            }
            history.remember(Content::Text("Text 50".into())).unwrap();
            let page = history.page("", 0).unwrap();
            assert_eq!(page.total, 125);
            assert_eq!(page.entries[0].text, "Text 50");
            assert!(page.has_more);
        }
        {
            let mut history = History::open(&path).unwrap();
            assert_eq!(history.page("", 100).unwrap().entries.len(), 25);
            assert_eq!(history.page("Text 0", 0).unwrap().entries.len(), 1);
            history
                .remember(Content::Text("ÉTÉ 100%_literal".into()))
                .unwrap();
            assert_eq!(history.page("été", 0).unwrap().entries.len(), 1);
            assert_eq!(history.page("%_", 0).unwrap().entries.len(), 1);
            let image = image::RgbaImage::from_pixel(4, 3, image::Rgba([12, 34, 56, 255]));
            history.remember(Content::Image(image.clone())).unwrap();
            let page = history.page("image", 0).unwrap();
            assert!(
                page.entries[0]
                    .preview
                    .as_ref()
                    .unwrap()
                    .starts_with("data:image/png;base64,")
            );
            match history.get(page.entries[0].id).unwrap() {
                Content::Image(saved) => assert_eq!(saved, image),
                _ => panic!("Expected image"),
            }
            history.clear().unwrap();
            assert_eq!(history.page("", 0).unwrap().total, 0);
        }
        std::fs::remove_file(path).unwrap();
    }
}
