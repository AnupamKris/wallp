//! Independent reader for the Tantivy 0.25 index maintained by Sigma 2.1.
//! Never creates, repairs, scans, or writes index contents. Only Tantivy's
//! metadata lock is shared with Sigma while opening segment readers.
use serde::Serialize;
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tantivy::{
    Index, ReloadPolicy, TantivyDocument, Term,
    collector::TopDocs,
    directory::{
        Directory, DirectoryLock, FileHandle, Lock, MmapDirectory, WatchCallback, WatchHandle,
        WritePtr,
        error::{DeleteError, LockError, OpenReadError, OpenWriteError},
    },
    query::{BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, Query, TermQuery},
    schema::{IndexRecordOption, Value},
};

#[derive(Clone, Debug)]
struct SearchDirectory(MmapDirectory);
fn read_only() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "Sigma index is read-only")
}
impl Directory for SearchDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Arc<dyn FileHandle>, OpenReadError> {
        self.0.get_file_handle(path)
    }
    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        self.0.exists(path)
    }
    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        self.0.atomic_read(path)
    }
    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        Err(DeleteError::IoError {
            io_error: Arc::new(read_only()),
            filepath: path.into(),
        })
    }
    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        Err(OpenWriteError::wrap_io_error(read_only(), path.into()))
    }
    fn atomic_write(&self, _: &Path, _: &[u8]) -> io::Result<()> {
        Err(read_only())
    }
    fn sync_directory(&self) -> io::Result<()> {
        Err(read_only())
    }
    fn acquire_lock(&self, lock: &Lock) -> Result<DirectoryLock, LockError> {
        if lock.filepath != Path::new(".tantivy-meta.lock") {
            return Err(LockError::wrap_io_error(read_only()));
        }
        // Keep standard cross-process protection against Sigma's segment GC.
        self.0.acquire_lock(lock)
    }
    fn watch(&self, _: WatchCallback) -> tantivy::Result<WatchHandle> {
        Ok(WatchHandle::empty())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    name: String,
    path: String,
    is_dir: bool,
}

fn sigma_index() -> Result<PathBuf, String> {
    let roaming = std::env::var_os("APPDATA").ok_or("Windows app data folder is unavailable")?;
    Ok(PathBuf::from(roaming).join("com.sigma-file-manager.app/global-search/index"))
}

fn search_index(path: &Path, query: &str) -> Result<Vec<FileResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    if query.chars().count() > 256 {
        return Err("Keep file searches under 256 characters.".into());
    }
    if !path.join("meta.json").is_file() {
        return Err("Sigma's search index was not found. Open Sigma File Manager and enable global search indexing first.".into());
    }
    let search = || -> tantivy::Result<Vec<FileResult>> {
        let index = Index::open(SearchDirectory(MmapDirectory::open(path)?))?;
        let schema = index.schema();
        let name = schema.get_field("name")?;
        let exact_name = schema.get_field("name_lower")?;
        let path_field = schema.get_field("path")?;
        let directory = schema.get_field("is_dir")?;
        let mut tokenizer = index
            .tokenizers()
            .get("default")
            .ok_or_else(|| tantivy::TantivyError::InvalidArgument("Missing tokenizer".into()))?;
        let mut words = Vec::new();
        tokenizer
            .token_stream(query)
            .process(&mut |token| words.push(token.text.clone()));
        if words.is_empty() {
            return Ok(vec![]);
        }
        if words.len() > 12 {
            return Err(tantivy::TantivyError::InvalidArgument(
                "Use at most 12 search words".into(),
            ));
        }
        let clauses: Vec<(Occur, Box<dyn Query>)> = words
            .iter()
            .map(|word| {
                let term = Term::from_field_text(name, word);
                let prefix: Box<dyn Query> = Box::new(BoostQuery::new(
                    Box::new(FuzzyTermQuery::new_prefix(term.clone(), 0, true)),
                    3.0,
                ));
                let matching: Box<dyn Query> = if word.chars().count() >= 4 {
                    Box::new(BooleanQuery::new(vec![
                        (Occur::Should, prefix),
                        (Occur::Should, Box::new(FuzzyTermQuery::new(term, 1, true))),
                    ]))
                } else {
                    prefix
                };
                (Occur::Must, matching)
            })
            .collect();
        let query = BooleanQuery::new(vec![
            (Occur::Should, Box::new(BooleanQuery::new(clauses))),
            (
                Occur::Should,
                Box::new(BoostQuery::new(
                    Box::new(TermQuery::new(
                        Term::from_field_text(exact_name, &query.to_lowercase()),
                        IndexRecordOption::Basic,
                    )),
                    20.0,
                )),
            ),
        ]);
        // Reopen per request so Sigma's directory replacements are picked up and
        // mapped segments aren't retained between searches (especially on Windows).
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let searcher = reader.searcher();
        let hits = searcher.search(&query, &TopDocs::with_limit(50))?;
        let mut results = Vec::new();
        for (_, address) in hits {
            let doc: TantivyDocument = searcher.doc(address)?;
            let Some(path) = doc.get_first(path_field).and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(name) = doc.get_first(name).and_then(|v| v.as_str()) else {
                continue;
            };
            results.push(FileResult {
                name: name.into(),
                path: path.into(),
                is_dir: doc.get_first(directory).and_then(|v| v.as_u64()) == Some(1),
            });
        }
        Ok(results)
    };
    // A scan can replace the directory while we open it. Retry once from disk.
    search().or_else(|_| search()).map_err(|e| format!("Could not read Sigma's index. It may be rebuilding or incompatible. Try again after indexing finishes. ({e})"))
}

#[tauri::command]
pub async fn search_files(query: String) -> Result<Vec<FileResult>, String> {
    tauri::async_runtime::spawn_blocking(move || search_index(&sigma_index()?, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_search_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let opener = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&path);
        if !target.is_absolute() || !target.exists() {
            return Err(
                "This file or folder is no longer available. Refresh Sigma's index and try again."
                    .into(),
            );
        }
        opener
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::launcher::close_launcher(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_existing_index_without_changing_contents() {
        use tantivy::{
            doc,
            schema::{FAST, STORED, STRING, Schema, TEXT},
        };
        let temp = tempfile::tempdir().unwrap();
        let mut schema = Schema::builder();
        let name = schema.add_text_field("name", TEXT | STORED);
        let lower = schema.add_text_field("name_lower", STRING | STORED);
        let path = schema.add_text_field("path", STRING | STORED);
        let is_dir = schema.add_u64_field("is_dir", FAST | STORED);
        let index = Index::create_in_dir(temp.path(), schema.build()).unwrap();
        let mut writer = index.writer(15_000_000).unwrap();
        for (filename, folder) in [
            ("Budget Report.pdf", false),
            ("Budget Reports", true),
            ("Holiday.jpg", false),
        ] {
            writer.add_document(doc!(name => filename, lower => filename.to_lowercase(), path => format!("C:/fixture/{filename}"), is_dir => u64::from(folder))).unwrap();
        }
        writer.commit().unwrap();
        drop(writer);
        let contents = || {
            let mut files: Vec<_> = std::fs::read_dir(temp.path())
                .unwrap()
                .map(|f| {
                    let f = f.unwrap();
                    (f.file_name(), std::fs::read(f.path()).unwrap())
                })
                .collect();
            files.sort_by(|a, b| a.0.cmp(&b.0));
            files
        };
        let before = contents();
        assert_eq!(search_index(temp.path(), "report bud").unwrap().len(), 2);
        assert_eq!(search_index(temp.path(), "budgte").unwrap().len(), 2);
        let exact = search_index(temp.path(), "BUDGET REPORT.PDF").unwrap();
        assert_eq!(exact[0].name, "Budget Report.pdf");
        assert!(
            search_index(temp.path(), "holiday")
                .unwrap()
                .iter()
                .all(|f| !f.is_dir)
        );
        assert!(search_index(temp.path(), "unfindable").unwrap().is_empty());
        assert!(search_index(temp.path(), "  ").unwrap().is_empty());
        assert_eq!(before, contents());
        let directory = SearchDirectory(MmapDirectory::open(temp.path()).unwrap());
        assert!(
            directory
                .atomic_write(Path::new("meta.json"), b"broken")
                .is_err()
        );
        assert!(directory.open_write(Path::new("new-file")).is_err());
        assert!(directory.delete(Path::new("meta.json")).is_err());
        assert_eq!(before, contents());
        let missing = temp.path().join("missing");
        assert!(
            search_index(&missing, "budget")
                .unwrap_err()
                .contains("not found")
        );
        assert!(!missing.exists());
    }

    #[test]
    #[ignore = "reads the locally installed Sigma index"]
    fn installed_sigma_index() {
        let path = sigma_index().unwrap();
        let before = std::fs::read(path.join("meta.json")).unwrap();
        let results = search_index(&path, "wallp").unwrap();
        assert!(!results.is_empty());
        assert!(results.iter().all(|r| Path::new(&r.path).is_absolute()));
        assert_eq!(before, std::fs::read(path.join("meta.json")).unwrap());
        println!("Sigma live index: {} results", results.len());
    }
}
