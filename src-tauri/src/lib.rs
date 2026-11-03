mod db;
mod http;
mod notion;
mod ollama;
mod pet;
mod secrets;
mod telegram;
mod weather;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_sql::{Migration, MigrationKind};

/// While the dashboard is open: whether the pet should be visible once it
/// closes (its visibility before opening, updated by tray show/hide in the
/// meantime). `None` while the dashboard is closed.
#[derive(Default)]
struct DashboardState(Mutex<Option<bool>>);

fn pet_after_dashboard(app: &AppHandle) -> std::sync::MutexGuard<'_, Option<bool>> {
    let state = app.state::<DashboardState>();
    // A poisoned lock still holds a usable bool; never panic over it.
    state.inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// A tray show/hide while the dashboard is open is the user's choice for the
/// pet, so closing the dashboard must honour it.
fn remember_pet(app: &AppHandle, visible: bool) {
    let mut after = pet_after_dashboard(app);
    if after.is_some() {
        *after = Some(visible);
    }
}

/// Show the pet (where it was, kept on screen) and tell it, so held messages
/// and missed reminders come out.
fn show_pet(window: &WebviewWindow) {
    pet::show(window);
    let _ = window.emit("pet:shown", ());
}

/// The user shows or hides the pet (tray, second launch). Remembered across
/// restarts in `pet_visible`, unlike the dashboard pausing it.
fn set_pet_visible(app: &AppHandle, visible: bool) {
    remember_pet(app, visible);
    db::write_setting(app, "pet_visible", visible.to_string());
    if let Some(w) = app.get_webview_window("main") {
        if visible {
            show_pet(&w);
            let _ = w.set_focus();
        } else {
            let _ = w.hide();
        }
    }
}

/// Make "Start with Windows" match the `autostart` setting. The first run
/// (no row yet) turns it on.
fn sync_autostart(app: &AppHandle) {
    let wanted = match db::read_setting(app, "autostart") {
        Some(v) => v != "false",
        None => {
            db::write_setting(app, "autostart", "true".into());
            true
        }
    };
    let launcher = app.autolaunch();
    if launcher.is_enabled().unwrap_or(!wanted) == wanted {
        return;
    }
    let result = if wanted { launcher.enable() } else { launcher.disable() };
    if let Err(e) = result {
        eprintln!("could not change autostart: {e}");
    }
}

/// The dashboard window, rebuilt from tauri.conf.json if it no longer exists
/// (closing is intercepted below, so this is a safety net).
fn dashboard_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("dashboard") {
        return Some(w);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "dashboard")?
        .clone();
    WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.build())
        .map_err(|e| eprintln!("could not recreate dashboard: {e}"))
        .ok()
}

/// Open the dashboard window and pause the pet overlay.
fn open_dashboard(app: &AppHandle) {
    let Some(dash_win) = dashboard_window(app) else {
        return;
    };
    if let Some(main_win) = app.get_webview_window("main") {
        let mut after = pet_after_dashboard(app);
        // Only the first open records it; a second open while already open
        // would otherwise see the pet hidden by us.
        if after.is_none() {
            *after = Some(main_win.is_visible().unwrap_or(true));
        }
        drop(after);
        let _ = main_win.hide(); // pause the pet overlay
    }
    let _ = dash_win.center();
    let _ = dash_win.show();
    let _ = dash_win.set_focus();
}

/// Hide the dashboard and put the pet back the way the user left it.
fn hide_dashboard(app: &AppHandle) {
    if let Some(dash_win) = app.get_webview_window("dashboard") {
        let _ = dash_win.hide();
    }
    let pet_wanted = pet_after_dashboard(app).take().unwrap_or(false);
    if pet_wanted {
        if let Some(main_win) = app.get_webview_window("main") {
            show_pet(&main_win);
        }
    }
}

// Async so that rebuilding the dashboard window does not run on the main
// thread (creating a window from a sync command deadlocks on Windows).
#[tauri::command]
async fn show_dashboard(app: AppHandle) {
    open_dashboard(&app);
}

#[tauri::command]
async fn close_dashboard(app: AppHandle) {
    hide_dashboard(&app);
}

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "appearance settings",
            sql: include_str!("../migrations/0002_appearance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "connected nox",
            sql: include_str!("../migrations/0003_connected.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "places, course status, briefing 07:30",
            sql: include_str!("../migrations/0004_places.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch exits before building anything; it only
        // brings the running pet back.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            set_pet_visible(app, true);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(DashboardState::default())
        .manage(ollama::OllamaRequests::default())
        .manage(pet::HitRegions::default())
        // Migrations run once at startup for the preloaded database (see
        // `plugins.sql.preload` in tauri.conf.json), before any window queries.
        // Never edit a released migration; add the next number instead.
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:nox.db", migrations())
                .build(),
        )
        .setup(|app| {
            // The pet starts hidden (tauri.conf.json) and is shown once
            // placed, unless the user had hidden it.
            if let Some(window) = app.get_webview_window("main") {
                pet::restore_position(&window);
                if db::read_setting(app.handle(), "pet_visible").as_deref() != Some("false") {
                    show_pet(&window);
                }
            }
            pet::start_click_through(app.handle());

            sync_autostart(app.handle());
            // The dashboard announces every settings write.
            let handle = app.handle().clone();
            app.listen("settings:changed", move |event| {
                if event.payload().contains("\"autostart\"") {
                    // Off the event thread: this reads the database and the registry.
                    let handle = handle.clone();
                    std::thread::spawn(move || sync_autostart(&handle));
                }
            });

            // Right-click tray menu.
            let dashboard_i =
                MenuItem::with_id(app, "dashboard", "Open Dashboard", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Nox", true, None::<&str>)?;
            let hide_i = MenuItem::with_id(app, "hide", "Hide Nox", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&dashboard_i, &sep1, &show_i, &hide_i, &sep2, &quit_i],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nox")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "dashboard" => open_dashboard(app),
                    "show" => set_pet_visible(app, true),
                    "hide" => set_pet_visible(app, false),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            set_pet_visible(app, !w.is_visible().unwrap_or(false));
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Closing the dashboard any way at all (Alt+F4, taskbar, ...) only
        // hides it, so the tray can always reopen it.
        .on_window_event(|window, event| {
            if window.label() == "dashboard" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    hide_dashboard(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pet::resize_window,
            pet::set_hit_regions,
            show_dashboard,
            close_dashboard,
            ollama::ollama_chat,
            ollama::ollama_cancel,
            secrets::secret_set,
            secrets::secret_exists,
            secrets::secret_delete,
            notion::notion_query_database,
            weather::weather_geocode,
            weather::weather_fetch,
            weather::location_detect,
            telegram::telegram_poll,
            telegram::telegram_pairing_start,
            telegram::telegram_send,
            telegram::telegram_typing
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod migration_tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        // One connection: every in-memory connection is its own database.
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    async fn run(pool: &SqlitePool, versions: std::ops::RangeInclusive<i64>) {
        for m in super::migrations().into_iter().filter(|m| versions.contains(&m.version)) {
            sqlx::raw_sql(m.sql).execute(pool).await.unwrap();
        }
    }

    async fn setting(pool: &SqlitePool, key: &str) -> String {
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[test]
    fn fresh_database_gets_0730_and_no_places() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            run(&pool, 1..=4).await;
            assert_eq!(setting(&pool, "briefing_time").await, "07:30");
            assert_eq!(setting(&pool, "active_place_id").await, "");
            assert_eq!(setting(&pool, "location_detect_enabled").await, "false");
        });
    }

    #[test]
    fn keeps_a_saved_time_and_moves_the_old_location_into_places() {
        tauri::async_runtime::block_on(async {
            let pool = pool().await;
            run(&pool, 1..=3).await;
            for (key, value) in [
                ("briefing_time", "07:00"),
                ("weather_location", "Jatinangor, Sumedang"),
                ("weather_lat", "-6.93"),
                ("weather_lon", "107.77"),
                ("weather_place", "Jatinangor, West Java"),
            ] {
                // Saved by Bas later than the 0003 defaults.
                sqlx::query("UPDATE settings SET value = ?, updated_at = '2999-01-01 00:00:00' WHERE key = ?")
                    .bind(value)
                    .bind(key)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            run(&pool, 4..=4).await;
            assert_eq!(setting(&pool, "briefing_time").await, "07:00");
            let (name, label, lat): (String, String, f64) =
                sqlx::query_as("SELECT name, label, latitude FROM places")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((name.as_str(), label.as_str(), lat), ("Jatinangor", "Jatinangor, West Java", -6.93));
            assert_eq!(setting(&pool, "active_place_id").await, "1");
        });
    }
}
