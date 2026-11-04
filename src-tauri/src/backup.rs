//! Automatic backups of nox.db (queue step 04). Secrets are not in the
//! database (Credential Manager), so a backup never holds a token.
//!
//! - A copy is always made with SQLite's own `VACUUM INTO` (never by copying
//!   the open file), then opened read-only and checked with
//!   `PRAGMA integrity_check`; a copy that is not "ok" is deleted.
//! - Retention keeps the newest `backup_keep` (default 14) and deletes older
//!   files in the backup folder that match `nox-YYYYMMDD-HHMM[-n].db` exactly.
//!   Nothing else in that folder is ever touched.
//! - Before pending migrations run (at startup, before the SQL plugin opens
//!   the database), a backup is made; if it fails, the migrations are not
//!   registered, so the database stays as it was and the app says why.
//! - Once a day (first start), in the background, never blocking startup.
//!
//! Restore is manual on purpose: close Nox, copy a backup over nox.db.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Local};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

use crate::db;

/// tauri.conf.json `identifier`; the SQL plugin keeps nox.db in
/// %APPDATA%\<identifier> (the app config dir).
const IDENTIFIER: &str = "com.lenovo.nox";
const DB_FILE: &str = "nox.db";
pub const DEFAULT_KEEP: usize = 14;
const MAX_KEEP: usize = 365;

/// Error codes the frontend words (never a path with secrets; there are none).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupError {
    FolderInvalid,
    FolderCreate,
    Copy,
    Integrity,
    Database,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    file: String,
    size: u64,
    /// Local time, "YYYY-MM-DD HH:MM".
    at: String,
    deleted: usize,
}

/// Set when the pre-migration backup failed and migrations were held back.
#[derive(Default)]
pub struct BackupHold(pub Mutex<Option<BackupError>>);

pub fn app_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(IDENTIFIER))
}

pub fn default_folder() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Documents")
        .join("NoxBackups")
}

/// A usable backup folder: absolute, sane, and not Nox's own data folder.
/// Does not create it.
pub fn validate_folder(raw: &str, app_dir: Option<&Path>) -> Result<PathBuf, BackupError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(default_folder());
    }
    if raw.len() > 240 || raw.chars().any(|c| c.is_control() || "<>\"|?*".contains(c)) {
        return Err(BackupError::FolderInvalid);
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(BackupError::FolderInvalid);
    }
    if path.exists() && !path.is_dir() {
        return Err(BackupError::FolderInvalid);
    }
    if let Some(app) = app_dir {
        if path.starts_with(app) {
            return Err(BackupError::FolderInvalid);
        }
    }
    Ok(path)
}

/// `nox-20261104-0930.db` or `nox-20261104-0930-2.db`: the only names
/// retention may delete. Returns a sort key (date, time, n).
fn backup_key(name: &str) -> Option<(u32, u32, u32)> {
    let rest = name.strip_prefix("nox-")?.strip_suffix(".db")?;
    let mut parts = rest.split('-');
    let date = parts.next()?;
    let time = parts.next()?;
    let n = parts.next();
    if parts.next().is_some() || date.len() != 8 || time.len() != 4 {
        return None;
    }
    if !date.chars().chain(time.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n = match n {
        None => 0,
        Some(s) if !s.is_empty() && s.len() <= 3 && s.chars().all(|c| c.is_ascii_digit()) => s.parse().ok()?,
        _ => return None,
    };
    Some((date.parse().ok()?, time.parse().ok()?, n))
}

/// Keep the newest `keep` backups in `folder`; delete older ones. Only files
/// named like Nox's backups are considered; returns how many were deleted.
pub fn prune(folder: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(folder) else { return 0 };
    let mut ours: Vec<((u32, u32, u32), PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| backup_key(&e.file_name().to_string_lossy()).map(|k| (k, e.path())))
        .collect();
    ours.sort_by(|a, b| b.0.cmp(&a.0));
    let mut deleted = 0;
    for (_, path) in ours.into_iter().skip(keep.max(1)) {
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

fn target(folder: &Path, now: DateTime<Local>) -> PathBuf {
    let stem = format!("nox-{}", now.format("%Y%m%d-%H%M"));
    let mut path = folder.join(format!("{stem}.db"));
    let mut n = 2;
    while path.exists() && n < 1000 {
        path = folder.join(format!("{stem}-{n}.db"));
        n += 1;
    }
    path
}

async fn check(copy: &Path) -> bool {
    let opts = SqliteConnectOptions::new().filename(copy).read_only(true);
    let Ok(pool) = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await else {
        return false;
    };
    let ok = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await
        .map(|r| r == "ok")
        .unwrap_or(false);
    pool.close().await;
    ok
}

/// Copy the database behind `pool` into `folder`, check it, prune.
pub async fn backup_with(pool: &SqlitePool, folder: &Path, keep: usize, now: DateTime<Local>) -> Result<BackupInfo, BackupError> {
    std::fs::create_dir_all(folder).map_err(|_| BackupError::FolderCreate)?;
    let path = target(folder, now);
    sqlx::query("VACUUM INTO ?")
        .bind(path.to_string_lossy().to_string())
        .execute(pool)
        .await
        .map_err(|_| BackupError::Copy)?;
    if !check(&path).await {
        let _ = std::fs::remove_file(&path);
        return Err(BackupError::Integrity);
    }
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let deleted = prune(folder, keep);
    Ok(BackupInfo {
        file: path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
        size,
        at: now.format("%Y-%m-%d %H:%M").to_string(),
        deleted,
    })
}

#[derive(Debug, Clone)]
struct Options {
    enabled: bool,
    folder: Result<PathBuf, BackupError>,
    keep: usize,
}

async fn setting(pool: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn options(pool: &SqlitePool) -> Options {
    // Missing rows (before migration 0009 ran) mean the defaults.
    let enabled = setting(pool, "backup_enabled").await.as_deref() != Some("false");
    let folder = validate_folder(&setting(pool, "backup_folder").await.unwrap_or_default(), app_dir().as_deref());
    let keep = setting(pool, "backup_keep")
        .await
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_KEEP)
        .clamp(1, MAX_KEEP);
    Options { enabled, folder, keep }
}

async fn save(pool: &SqlitePool, key: &str, value: &str) {
    let _ = sqlx::query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await;
}

async fn record(pool: &SqlitePool, result: &Result<BackupInfo, BackupError>, now: DateTime<Local>) {
    match result {
        Ok(info) => {
            save(pool, "backup_last_at", &info.at).await;
            save(pool, "backup_last_file", &info.file).await;
            save(pool, "backup_last_error", "").await;
            save(pool, "last_backup_date", &now.format("%Y-%m-%d").to_string()).await;
        }
        Err(e) => {
            save(pool, "backup_last_error", &serde_json::to_string(e).unwrap_or_default()).await;
            save(pool, "backup_last_error_at", &now.format("%Y-%m-%d %H:%M").to_string()).await;
        }
    }
}

/// Is a migration newer than the database's newest applied one waiting?
async fn has_pending(pool: &SqlitePool, newest_known: i64) -> bool {
    let applied: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .ok()
        .flatten();
    applied.unwrap_or(0) < newest_known
}

/// What startup should do with the migrations.
#[derive(Debug, PartialEq)]
pub enum Startup {
    /// Nothing pending, no database yet, backups off, or a backup was made.
    Apply,
    /// The pre-migration backup failed: hold the migrations back.
    Hold(BackupError),
}

/// Run before the SQL plugin opens the database: back up if migrations are
/// pending. A fresh install (no file yet) has nothing to back up.
pub async fn before_migrations(db_path: &Path, newest_known: i64, now: DateTime<Local>) -> Startup {
    if !db_path.exists() {
        return Startup::Apply;
    }
    let opts = SqliteConnectOptions::new().filename(db_path);
    let Ok(pool) = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await else {
        return Startup::Apply; // the plugin will report a broken file itself
    };
    let decision = if !has_pending(&pool, newest_known).await {
        Startup::Apply
    } else {
        let o = options(&pool).await;
        if !o.enabled {
            Startup::Apply
        } else {
            let result = match &o.folder {
                Ok(folder) => backup_with(&pool, folder, o.keep, now).await,
                Err(e) => Err(e.clone()),
            };
            record(&pool, &result, now).await;
            match result {
                Ok(_) => Startup::Apply,
                Err(e) => Startup::Hold(e),
            }
        }
    };
    pool.close().await;
    decision
}

/// The startup check, for `run()`: blocks briefly, before any window exists.
pub fn startup_check(newest_known: i64) -> Startup {
    let Some(dir) = app_dir() else { return Startup::Apply };
    tauri::async_runtime::block_on(before_migrations(&dir.join(DB_FILE), newest_known, Local::now()))
}

async fn backup_via_plugin(app: &AppHandle, folder: Option<String>) -> Result<BackupInfo, BackupError> {
    let now = Local::now();
    db::with_pool(app, async |pool| {
        let o = options(pool).await;
        let folder = match folder {
            Some(f) => validate_folder(&f, app_dir().as_deref()),
            None => o.folder.clone(),
        };
        let result = match folder {
            Ok(f) => backup_with(pool, &f, o.keep, now).await,
            Err(e) => Err(e),
        };
        record(pool, &result, now).await;
        Some(result)
    })
    .await
    .unwrap_or(Err(BackupError::Database))
}

/// The daily backup: first start of the day, in the background.
pub fn start_daily(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let due = db::with_pool(&app, async |pool| {
            let o = options(pool).await;
            let today = Local::now().format("%Y-%m-%d").to_string();
            Some(o.enabled && setting(pool, "last_backup_date").await.as_deref() != Some(today.as_str()))
        })
        .await
        .unwrap_or(false);
        if due {
            let _ = backup_via_plugin(&app, None).await;
            let _ = app.emit("backup:status", ());
        }
    });
}

#[tauri::command]
pub async fn backup_now(app: AppHandle, folder: Option<String>) -> Result<BackupInfo, BackupError> {
    let r = backup_via_plugin(&app, folder).await;
    let _ = app.emit("backup:status", ());
    r
}

/// The folder as Nox would use it, or why it cannot.
#[tauri::command]
pub fn backup_check_folder(folder: String) -> Result<String, BackupError> {
    validate_folder(&folder, app_dir().as_deref()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn backup_default_folder() -> String {
    default_folder().to_string_lossy().to_string()
}

/// Open the backup folder in Explorer (creating it if needed).
#[tauri::command]
pub fn backup_open_folder(folder: String) -> Result<(), BackupError> {
    let path = validate_folder(&folder, app_dir().as_deref())?;
    std::fs::create_dir_all(&path).map_err(|_| BackupError::FolderCreate)?;
    std::process::Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|_| BackupError::FolderInvalid)
}

/// Set when migrations were held back at startup because the backup failed.
#[tauri::command]
pub fn backup_hold(app: AppHandle) -> Option<BackupError> {
    app.state::<BackupHold>().0.lock().ok().and_then(|g| g.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nox-backup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }

    fn at(d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, d, h, 0, 0).unwrap()
    }

    #[test]
    fn keeps_the_newest_and_deletes_only_nox_backups() {
        let dir = temp("retention");
        for d in 1..=16 {
            touch(&dir, &format!("nox-202611{d:02}-0900.db"));
        }
        // Things that must never be deleted.
        for other in ["nox.db", "notes.txt", "nox-old.db", "my-nox-20260101-0000.db", "nox-20261101-0900.db.bak", "NOX-20261101-0900.db"] {
            touch(&dir, other);
        }
        std::fs::create_dir(dir.join("nox-20260101-0000.db")).unwrap(); // a folder with the name
        assert_eq!(prune(&dir, 14), 2);
        let left = names(&dir);
        assert!(!left.contains(&"nox-20261101-0900.db".to_string()));
        assert!(!left.contains(&"nox-20261102-0900.db".to_string()));
        assert!(left.contains(&"nox-20261103-0900.db".to_string()));
        assert!(left.contains(&"nox-20261116-0900.db".to_string()));
        for other in ["nox.db", "notes.txt", "nox-old.db", "my-nox-20260101-0000.db", "nox-20261101-0900.db.bak", "NOX-20261101-0900.db", "nox-20260101-0000.db"] {
            assert!(left.contains(&other.to_string()), "{other} must survive");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_only_exact_backup_names() {
        assert_eq!(backup_key("nox-20261104-0930.db"), Some((20261104, 930, 0)));
        assert_eq!(backup_key("nox-20261104-0930-2.db"), Some((20261104, 930, 2)));
        for bad in ["nox.db", "nox-2026114-0930.db", "nox-20261104-930.db", "nox-20261104-0930.db.bak", "x-nox-20261104-0930.db", "nox-20261104-0930-a.db"] {
            assert_eq!(backup_key(bad), None, "{bad}");
        }
    }

    #[test]
    fn validates_folders() {
        let app = PathBuf::from(r"C:\Users\bas\AppData\Roaming\com.lenovo.nox");
        assert!(validate_folder(r"C:\Users\bas\Documents\NoxBackups", Some(&app)).is_ok());
        assert_eq!(validate_folder("relative\\path", Some(&app)), Err(BackupError::FolderInvalid));
        assert_eq!(validate_folder(r"C:\bad|name", Some(&app)), Err(BackupError::FolderInvalid));
        assert_eq!(validate_folder(r"C:\Users\bas\AppData\Roaming\com.lenovo.nox\b", Some(&app)), Err(BackupError::FolderInvalid));
        assert_eq!(validate_folder("", Some(&app)).unwrap(), default_folder());
        let dir = temp("file");
        touch(&dir, "a-file");
        assert_eq!(validate_folder(&dir.join("a-file").to_string_lossy(), None), Err(BackupError::FolderInvalid));
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn make_db(path: &Path, applied: &[i64], folder: Option<&Path>) {
        let opts = SqliteConnectOptions::new().filename(path).create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
             CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);
             CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO todos (title) VALUES ('keep me');",
        )
        .execute(&pool)
        .await
        .unwrap();
        for v in applied {
            sqlx::query("INSERT INTO _sqlx_migrations (version) VALUES (?)").bind(v).execute(&pool).await.unwrap();
        }
        if let Some(f) = folder {
            sqlx::query("INSERT INTO settings (key, value) VALUES ('backup_folder', ?)")
                .bind(f.to_string_lossy().to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
    }

    #[test]
    fn backs_up_before_pending_migrations_and_the_copy_is_checked() {
        tauri::async_runtime::block_on(async {
            let dir = temp("premigration");
            let backups = dir.join("backups");
            let db = dir.join("nox.db");
            make_db(&db, &[1, 2, 3], Some(&backups)).await;
            // Migration 4 is pending: a checked backup exists before we return Apply.
            assert_eq!(before_migrations(&db, 4, at(4, 9)).await, Startup::Apply);
            let files = names(&backups);
            assert_eq!(files, vec!["nox-20261104-0900.db"]);
            let copy = SqlitePoolOptions::new()
                .connect_with(SqliteConnectOptions::new().filename(backups.join(&files[0])).read_only(true))
                .await
                .unwrap();
            let title: String = sqlx::query_scalar("SELECT title FROM todos").fetch_one(&copy).await.unwrap();
            assert_eq!(title, "keep me");
            copy.close().await;
            // Nothing pending: no new backup.
            assert_eq!(before_migrations(&db, 3, at(4, 10)).await, Startup::Apply);
            assert_eq!(names(&backups).len(), 1);
            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn holds_the_migrations_when_the_backup_cannot_be_made() {
        tauri::async_runtime::block_on(async {
            let dir = temp("hold");
            let db = dir.join("nox.db");
            let blocker = dir.join("not-a-folder");
            touch(&dir, "not-a-folder"); // a file where the folder should be
            make_db(&db, &[1], Some(&blocker)).await;
            assert_eq!(before_migrations(&db, 2, at(4, 9)).await, Startup::Hold(BackupError::FolderInvalid));
            // A fresh install has nothing to back up.
            assert_eq!(before_migrations(&dir.join("missing.db"), 9, at(4, 9)).await, Startup::Apply);
            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
