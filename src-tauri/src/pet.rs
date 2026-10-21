//! The pet window: where it sits on screen, and which parts of it take clicks.
//!
//! Positions are physical pixels. A saved position (`pet_position`) is the
//! top-left the window would have at its collapsed height, so a move made
//! while the chat is open (taller window) restores to the same spot.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread::{self, Thread};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};

use crate::db::read_setting;

// Window logical dimensions (must match tauri.conf.json).
const WIN_W: f64 = 160.0;
const WIN_H: f64 = 200.0;
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_BOTTOM: f64 = 200.0;

/// Cursor poll rate while the pet is visible (~40 Hz).
const POLL: Duration = Duration::from_millis(25);
/// While hidden the loop parks; `show` wakes it. The timeout is a backstop
/// in case the window is shown some other way.
const HIDDEN_PARK: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// Move `rect` fully inside the work area it overlaps most. `None` when it
/// is on no current monitor at all (e.g. that monitor was unplugged).
fn fit(app: &AppHandle, rect: Rect) -> Option<PhysicalPosition<i32>> {
    let area = app
        .available_monitors()
        .ok()?
        .iter()
        .map(|m| {
            let wa = m.work_area();
            Rect {
                x: wa.position.x,
                y: wa.position.y,
                w: wa.size.width as i32,
                h: wa.size.height as i32,
            }
        })
        .map(|wa| {
            let ox = (rect.x + rect.w).min(wa.x + wa.w) - rect.x.max(wa.x);
            let oy = (rect.y + rect.h).min(wa.y + wa.h) - rect.y.max(wa.y);
            (ox.max(0) as i64 * oy.max(0) as i64, wa)
        })
        .filter(|(overlap, _)| *overlap > 0)
        .max_by_key(|(overlap, _)| *overlap)?
        .1;
    // Top/left win when the window is larger than the area.
    let x = rect.x.min(area.x + area.w - rect.w).max(area.x);
    let y = rect.y.min(area.y + area.h - rect.h).max(area.y);
    Some(PhysicalPosition::new(x, y))
}

fn current_rect(window: &WebviewWindow) -> Option<Rect> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: pos.x,
        y: pos.y,
        w: size.width as i32,
        h: size.height as i32,
    })
}

/// The default spot: bottom-right of the work area of the monitor under the
/// cursor (or the primary one), as a collapsed top-left.
fn dock_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    Some(PhysicalPosition::new(
        wa.position.x + wa.size.width as i32 - ((WIN_W + MARGIN_RIGHT) * scale).round() as i32,
        wa.position.y + wa.size.height as i32 - ((WIN_H + MARGIN_BOTTOM) * scale).round() as i32,
    ))
}

/// Put the window at a collapsed top-left, keeping it on screen; dock it if
/// that spot is on no monitor.
fn place(window: &WebviewWindow, collapsed: PhysicalPosition<i32>) {
    let app = window.app_handle();
    let Some(rect) = current_rect(window) else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let collapsed_h = (WIN_H * scale).round() as i32;
    // Bottom-anchored: an open chat makes the window grow upward.
    let wanted = Rect {
        x: collapsed.x,
        y: collapsed.y + collapsed_h - rect.h,
        ..rect
    };
    let pos = fit(app, wanted).or_else(|| {
        let dock = dock_position(app)?;
        fit(app, Rect { x: dock.x, y: dock.y + collapsed_h - rect.h, ..rect })
    });
    if let Some(pos) = pos {
        let _ = window.set_position(pos);
    }
}

/// Startup: the saved position if it is still on a monitor, else the dock.
pub fn restore_position(window: &WebviewWindow) {
    let saved = read_setting(window.app_handle(), "pet_position")
        .and_then(|raw| serde_json::from_str::<SavedPosition>(&raw).ok())
        .map(|p| PhysicalPosition::new(p.x, p.y));
    match saved.or_else(|| dock_position(window.app_handle())) {
        Some(pos) => place(window, pos),
        None => eprintln!("no monitor to place the pet on"),
    }
}

#[derive(Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

/// Show the pet where it was (pulled back on screen if the monitors changed
/// while it was hidden) and wake the click-through loop.
pub fn show(window: &WebviewWindow) {
    if let Some(rect) = current_rect(window) {
        match fit(window.app_handle(), rect) {
            Some(pos) => {
                let _ = window.set_position(pos);
            }
            None => {
                if let Some(dock) = dock_position(window.app_handle()) {
                    place(window, dock);
                }
            }
        }
    }
    let _ = window.show();
    if let Some(looper) = window.try_state::<ClickThroughLoop>() {
        looper.0.unpark();
    }
}

/// Resize the window to a new height, keeping its bottom-left fixed (the pet
/// is bottom-anchored), but never past the top of the screen.
#[tauri::command]
pub fn resize_window(window: WebviewWindow, height: u32) {
    let old = current_rect(&window);
    let scale = window.scale_factor().unwrap_or(1.0);
    let new_h = (height as f64 * scale).round() as i32;

    let _ = window.set_size(LogicalSize::new(WIN_W, height as f64));

    if let Some(old) = old {
        let grown = Rect {
            y: old.y + old.h - new_h,
            h: new_h,
            ..old
        };
        let pos = fit(window.app_handle(), grown).unwrap_or(PhysicalPosition::new(grown.x, grown.y));
        let _ = window.set_position(pos);
    }
}

// ── Click-through ───────────────────────────────────────────────────────────
//
// A window that ignores the cursor gets no mouse events, so it cannot notice
// the cursor coming back. Instead the page reports where its visible parts
// are, and a Rust loop compares those with the global cursor position.

/// A rectangle in CSS pixels relative to the window's client area.
#[derive(Clone, Copy, Deserialize)]
pub struct HitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
pub struct HitRegions {
    /// `None` until the page first reports: until then the whole window
    /// takes clicks, so a page that failed to load cannot become unclickable.
    rects: Mutex<Option<Vec<HitRect>>>,
    /// Chat open or a drag in progress: never let clicks through.
    solid: AtomicBool,
}

struct ClickThroughLoop(Thread);

#[tauri::command]
pub fn set_hit_regions(regions: State<'_, HitRegions>, rects: Vec<HitRect>, solid: bool) {
    *regions.rects.lock().unwrap_or_else(|e| e.into_inner()) = Some(rects);
    regions.solid.store(solid, Ordering::Relaxed);
}

/// Whether the cursor is over something the pet shows (or we cannot tell).
fn takes_clicks(app: &AppHandle, window: &WebviewWindow) -> bool {
    let regions = app.state::<HitRegions>();
    if regions.solid.load(Ordering::Relaxed) {
        return true;
    }
    // Copy out, so no lock is held across the window calls below.
    let Some(rects) = regions.rects.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
        return true;
    };
    let (Ok(cursor), Ok(origin), Ok(scale)) = (
        app.cursor_position(),
        window.inner_position(),
        window.scale_factor(),
    ) else {
        return true;
    };
    let x = (cursor.x - origin.x as f64) / scale;
    let y = (cursor.y - origin.y as f64) / scale;
    rects
        .iter()
        .any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

/// Run the click-through loop for the pet window. It polls only while the
/// pet is visible, parks while hidden, and ends when the window is gone.
pub fn start_click_through(app: &AppHandle) {
    let app_handle = app.clone();
    let handle = thread::spawn(move || {
        let app = app_handle;
        let mut ignoring = false;
        while let Some(window) = app.get_webview_window("main") {
            if !window.is_visible().unwrap_or(false) {
                thread::park_timeout(HIDDEN_PARK);
                continue;
            }
            let ignore = !takes_clicks(&app, &window);
            // Only touch the window when the state actually changes.
            if ignore != ignoring && window.set_ignore_cursor_events(ignore).is_ok() {
                ignoring = ignore;
            }
            thread::sleep(POLL);
        }
    });
    app.manage(ClickThroughLoop(handle.thread().clone()));
}
