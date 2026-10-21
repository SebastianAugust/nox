use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, WebviewWindow,
};

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

#[tauri::command]
fn hide_window(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn show_window(window: WebviewWindow) {
    reveal_window(&window);
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

/// Open the dashboard window and pause the pet overlay.
fn open_dashboard(app: &tauri::AppHandle) {
    if let (Some(main_win), Some(dash_win)) = (
        app.get_webview_window("main"),
        app.get_webview_window("dashboard"),
    ) {
        let _ = main_win.hide(); // pause the pet overlay
        let _ = dash_win.center();
        let _ = dash_win.show();
        let _ = dash_win.set_focus();
    }
}

/// Close the dashboard and bring the pet overlay back.
#[tauri::command]
fn close_dashboard(app: tauri::AppHandle) {
    if let (Some(main_win), Some(dash_win)) = (
        app.get_webview_window("main"),
        app.get_webview_window("dashboard"),
    ) {
        let _ = dash_win.hide();
        let _ = main_win.show();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
                        if let Some(w) = app.get_webview_window("main") {
                            reveal_window(&w);
                        }
                    }
                    "hide" => {
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
                                let _ = w.hide();
                            } else {
                                reveal_window(&w);
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_window,
            show_window,
            resize_window,
            close_dashboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
