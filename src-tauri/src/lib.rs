mod ollama;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder, WindowEvent,
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

// Window logical dimensions (must match tauri.conf.json).
const WIN_W: f64 = 160.0;
const WIN_H: f64 = 200.0;
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_BOTTOM: f64 = 48.0;

/// Dock a window of the given logical size to the bottom-right of the primary
/// monitor, above the taskbar.
fn position_window_sized(window: &WebviewWindow, w: f64, h: f64) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let x = size.width as i32 - (w * scale) as i32 - (MARGIN_RIGHT * scale) as i32;
        let y = size.height as i32 - (h * scale) as i32 - (MARGIN_BOTTOM * scale) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// Dock the window at its default (collapsed) size.
fn position_window(window: &WebviewWindow) {
    position_window_sized(window, WIN_W, WIN_H);
}

/// Show the window at its docked position and focus it.
fn reveal_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    position_window(window);
}

/// Resize the window to a new height, keeping its bottom and left edges fixed
/// (the pet is bottom-anchored) so a dragged position is preserved instead of
/// snapping back to the bottom-right dock.
#[tauri::command]
fn resize_window(window: WebviewWindow, height: u32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let old_pos = window.outer_position().ok();
    let old_size = window.outer_size().ok();
    let new_ph = (height as f64 * scale).round() as i32;

    let _ = window.set_size(tauri::LogicalSize::new(WIN_W, height as f64));

    if let (Some(pos), Some(size)) = (old_pos, old_size) {
        let bottom = pos.y + size.height as i32;
        let _ = window.set_position(PhysicalPosition::new(pos.x, bottom - new_ph));
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
    let show_pet = pet_after_dashboard(app).take().unwrap_or(false);
    if show_pet {
        if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.show();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DashboardState::default())
        .manage(ollama::OllamaRequests::default())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                position_window(&window);
            }

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
            resize_window,
            show_dashboard,
            close_dashboard,
            ollama::ollama_chat,
            ollama::ollama_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
