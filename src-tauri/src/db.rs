//! Settings access from Rust, through the SQL plugin's preloaded pool (its
//! setup, which runs the migrations, happens before ours).

use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const DB: &str = "sqlite:nox.db";

pub(crate) async fn with_pool<T>(
    app: &AppHandle,
    f: impl AsyncFnOnce(&sqlx::SqlitePool) -> Option<T>,
) -> Option<T> {
    let instances = app.try_state::<DbInstances>()?;
    let dbs = instances.0.read().await;
    // Only the sqlite driver is enabled, but the enum may grow.
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = dbs.get(DB)? else {
        return None;
    };
    f(pool).await
}

/// One row of the `settings` table, from async code.
pub async fn read_setting_async(app: &AppHandle, key: &str) -> Option<String> {
    with_pool(app, async |pool| {
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(|e| eprintln!("could not read setting {key}: {e}"))
            .ok()
            .flatten()
    })
    .await
}

/// One row of the `settings` table. Blocks; call it from setup or a thread.
pub fn read_setting(app: &AppHandle, key: &str) -> Option<String> {
    tauri::async_runtime::block_on(read_setting_async(app, key))
}

/// Write a setting and wait for it, from async code.
pub async fn write_setting_async(app: &AppHandle, key: &str, value: &str) -> bool {
    with_pool(app, async |pool| {
        sqlx::query(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map_err(|e| eprintln!("could not save setting {key}: {e}"))
        .ok()
    })
    .await
    .is_some()
}

/// Write a setting in the background (never blocks the caller).
pub fn write_setting(app: &AppHandle, key: &'static str, value: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        with_pool(&app, async |pool| {
            sqlx::query(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            )
            .bind(key)
            .bind(&value)
            .execute(pool)
            .await
            .map_err(|e| eprintln!("could not save setting {key}: {e}"))
            .ok()
        })
        .await;
    });
}
