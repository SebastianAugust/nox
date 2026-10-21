mod ollama;
mod pet;

use std::sync::Mutex;
use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

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

/// Show the pet from the tray and focus it.
fn reveal_window(window: &WebviewWindow) {
    show_pet(window);
    let _ = window.set_focus();
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
    vec![Migration {
        version: 1,
        description: "init",
        sql: include_str!("../migrations/0001_init.sql"),
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            if let Some(window) = app.get_webview_window("main") {
                pet::restore_position(&window);
            }
            pet::start_click_through(app.handle());

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
                    "show" => {
                        remember_pet(app, true);
                        if let Some(w) = app.get_webview_window("main") {
                            reveal_window(&w);
                        }
                    }
                    "hide" => {
                        remember_pet(app, false);
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
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
                            if w.is_visible().unwrap_or(false) {
                                remember_pet(app, false);
                                let _ = w.hide();
                            } else {
                                remember_pet(app, true);
                                reveal_window(&w);
                            }
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
            ollama::ollama_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
