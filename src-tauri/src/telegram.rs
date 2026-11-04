//! Telegram bot transport. The pet window drives the loop (one poller) and
//! decides what to answer; this module holds the token and enforces who may
//! talk to Nox:
//!
//! - Only the paired private chat (`telegram_chat_id`) gets through to the
//!   frontend. Every other chat is ignored silently.
//! - Pairing: the dashboard asks for a 6-digit code (valid 10 minutes, kept
//!   in memory only); a `/pair <code>` message with that code pairs its chat.
//! - Replies only ever go to the paired chat. No command here runs anything
//!   or reads files; the frontend only gets message text.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::http::{self, ApiError};
use crate::secrets;

const API: &str = "https://api.telegram.org";
const LONG_POLL_SECS: u64 = 30;
const PAIR_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_MESSAGE: usize = 4096;
pub const CHAT_KEY: &str = "telegram_chat_id";

static PAIRING: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn pairing() -> std::sync::MutexGuard<'static, Option<(String, Instant)>> {
    PAIRING.lock().unwrap_or_else(|e| e.into_inner())
}

fn token() -> Result<String, ApiError> {
    secrets::get(secrets::TELEGRAM_TOKEN).ok_or(ApiError::NoToken)
}

async fn call(token: &str, method: &str, body: &Value, timeout: Duration) -> Result<Value, ApiError> {
    let response = http::client()
        .post(format!("{API}/bot{token}/{method}"))
        .timeout(timeout)
        .json(body)
        .send()
        .await?;
    let status = response.status().as_u16();
    // Telegram answers a malformed token with 404, a revoked one with 401.
    if status == 404 {
        return Err(ApiError::Unauthorized);
    }
    if !(200..300).contains(&status) {
        return Err(http::from_status(status));
    }
    let data: Value = response.json().await?;
    if data["ok"].as_bool() != Some(true) {
        return Err(ApiError::BadResponse);
    }
    Ok(data["result"].clone())
}

async fn paired_chat(app: &AppHandle) -> Option<i64> {
    db::read_setting_async(app, CHAT_KEY)
        .await
        .and_then(|v| v.trim().parse().ok())
}

/// One message from the paired chat.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Incoming {
    Text { text: String },
    /// A location pin ("Share location"), to be saved as a place.
    Location { latitude: f64, longitude: f64 },
    /// A press on one of Nox's inline buttons (capture Confirm / Cancel).
    Callback { id: String, data: String },
}

/// Button data Nox itself sets: short, plain characters only.
fn valid_data(d: &str) -> bool {
    !d.is_empty() && d.len() <= 64 && d.chars().all(|c| c.is_ascii_alphanumeric() || ":_-".contains(c))
}

/// Button presses count only from the paired private chat; anything else
/// (another chat, a group, nothing paired yet) is dropped.
fn from_paired_chat(chat_id: i64, kind: &str, paired: Option<i64>) -> bool {
    paired == Some(chat_id) && kind == "private"
}

/// A button press: (chat, chat type, Incoming). Only data Nox could have set.
fn callback(update: &Value) -> Option<(i64, String, Incoming)> {
    let cb = &update["callback_query"];
    let id = cb["id"].as_str()?.to_string();
    let data = cb["data"].as_str()?.to_string();
    let chat = &cb["message"]["chat"];
    if !valid_data(&data) {
        return None;
    }
    Some((chat["id"].as_i64()?, chat["type"].as_str().unwrap_or("").to_string(), Incoming::Callback { id, data }))
}

/// Text or a location pin; anything else (photos, stickers, ...) is None.
fn incoming(message: &Value) -> Option<Incoming> {
    if let Some(text) = message["text"].as_str() {
        return Some(Incoming::Text { text: text.to_string() });
    }
    let loc = &message["location"];
    let (latitude, longitude) = (loc["latitude"].as_f64()?, loc["longitude"].as_f64()?);
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return None;
    }
    Some(Incoming::Location { latitude, longitude })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    /// Pass this as `offset` next time (and persist it) so nothing repeats.
    next_offset: i64,
    /// Messages from the paired chat, oldest first.
    messages: Vec<Incoming>,
    /// A `/pair` with the right code arrived and that chat is now paired.
    paired: bool,
}

/// Wait up to ~30 s for new messages.
#[tauri::command]
pub async fn telegram_poll(app: AppHandle, offset: i64) -> Result<PollResult, ApiError> {
    let token = token()?;
    let updates = call(
        &token,
        "getUpdates",
        &json!({ "offset": offset, "timeout": LONG_POLL_SECS, "allowed_updates": ["message", "callback_query"] }),
        Duration::from_secs(LONG_POLL_SECS + 15),
    )
    .await?;
    let updates = updates.as_array().ok_or(ApiError::BadResponse)?;

    let mut result = PollResult { next_offset: offset, messages: Vec::new(), paired: false };
    let mut chat = paired_chat(&app).await;
    for update in updates {
        if let Some(id) = update["update_id"].as_i64() {
            result.next_offset = result.next_offset.max(id + 1);
        }
        // Inline-button presses: from the paired private chat only.
        if let Some((chat_id, kind, msg)) = callback(update) {
            if from_paired_chat(chat_id, &kind, chat) {
                result.messages.push(msg);
            }
            continue;
        }
        let message = &update["message"];
        let (Some(chat_id), Some(msg)) = (message["chat"]["id"].as_i64(), incoming(message)) else {
            continue;
        };
        if message["chat"]["type"].as_str() != Some("private") {
            continue;
        }
        if Some(chat_id) == chat {
            result.messages.push(msg);
        } else if matches!(&msg, Incoming::Text { text } if try_pair(text))
            && db::write_setting_async(&app, CHAT_KEY, &chat_id.to_string()).await
        {
            chat = Some(chat_id);
            result.paired = true;
            let _ = app.emit("telegram:paired", ());
        }
        // Anything else, from anyone else: no reply, no trace.
    }
    Ok(result)
}

/// True (and the code is used up) when `text` is `/pair <current code>`.
fn try_pair(text: &str) -> bool {
    let mut parts = text.split_whitespace();
    let command = parts.next().unwrap_or("");
    // Telegram appends "@BotName" to commands picked from the menu.
    if command.split('@').next() != Some("/pair") {
        return false;
    }
    let Some(given) = parts.next() else { return false };
    let mut slot = pairing();
    match slot.as_ref() {
        Some((code, issued)) if issued.elapsed() < PAIR_TTL && code == given => {
            *slot = None;
            true
        }
        _ => false,
    }
}

/// A fresh 6-digit pairing code, valid for 10 minutes. Replaces any older one.
#[tauri::command]
pub fn telegram_pairing_start() -> Result<String, ApiError> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|_| ApiError::Invalid)?;
    let code = format!("{:06}", u32::from_le_bytes(bytes) % 1_000_000);
    *pairing() = Some((code.clone(), Instant::now()));
    Ok(code)
}

/// Send text to the paired chat, split into Telegram-sized parts.
#[tauri::command]
pub async fn telegram_send(app: AppHandle, text: String) -> Result<(), ApiError> {
    let token = token()?;
    let chat = paired_chat(&app).await.ok_or(ApiError::NotPaired)?;
    for part in split_message(&text, MAX_MESSAGE) {
        call(
            &token,
            "sendMessage",
            &json!({ "chat_id": chat, "text": part }),
            http::TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct Button {
    label: String,
    data: String,
}

/// Send text with one row of inline buttons to the paired chat.
#[tauri::command]
pub async fn telegram_send_buttons(app: AppHandle, text: String, buttons: Vec<Button>) -> Result<(), ApiError> {
    if buttons.is_empty()
        || buttons.len() > 4
        || buttons.iter().any(|b| !valid_data(&b.data) || b.label.is_empty() || b.label.chars().count() > 40)
    {
        return Err(ApiError::Invalid);
    }
    let token = token()?;
    let chat = paired_chat(&app).await.ok_or(ApiError::NotPaired)?;
    let row: Vec<Value> = buttons.iter().map(|b| json!({ "text": b.label, "callback_data": b.data })).collect();
    let text: String = text.chars().take(MAX_MESSAGE).collect();
    call(
        &token,
        "sendMessage",
        &json!({ "chat_id": chat, "text": text, "reply_markup": { "inline_keyboard": [row] } }),
        http::TIMEOUT,
    )
    .await
    .map(|_| ())
}

/// Acknowledge a button press (stops the spinner on the phone).
#[tauri::command]
pub async fn telegram_answer_callback(callback_id: String, text: Option<String>) -> Result<(), ApiError> {
    if callback_id.is_empty() || callback_id.len() > 128 || !callback_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(ApiError::Invalid);
    }
    let token = token()?;
    let mut body = json!({ "callback_query_id": callback_id });
    if let Some(t) = text {
        body["text"] = json!(t.chars().take(200).collect::<String>());
    }
    call(&token, "answerCallbackQuery", &body, http::TIMEOUT).await.map(|_| ())
}

/// Show "typing…" in the paired chat (Telegram clears it after ~5 s).
#[tauri::command]
pub async fn telegram_typing(app: AppHandle) -> Result<(), ApiError> {
    let token = token()?;
    let chat = paired_chat(&app).await.ok_or(ApiError::NotPaired)?;
    call(&token, "sendChatAction", &json!({ "chat_id": chat, "action": "typing" }), http::TIMEOUT)
        .await
        .map(|_| ())
}

/// Split into parts of at most `limit` UTF-16 units (Telegram's measure),
/// preferring to break at a newline, then a space.
fn split_message(text: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let mut units = 0;
        let mut end = rest.len();
        for (i, c) in rest.char_indices() {
            units += c.len_utf16();
            if units > limit {
                end = i;
                break;
            }
        }
        if end < rest.len() {
            let window = &rest[..end];
            if let Some(cut) = window.rfind('\n').or_else(|| window.rfind(' ')).filter(|&c| c > 0) {
                end = cut;
            }
        }
        parts.push(rest[..end].trim_end().to_string());
        rest = rest[end..].trim_start();
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_long_messages_at_line_breaks() {
        let line = "a".repeat(3000);
        let text = format!("{line}\n{line}\n{line}");
        let parts = split_message(&text, 4096);
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= 4096));
        assert_eq!(split_message("hi", 4096), vec!["hi"]);
        // No break point at all: hard cut, nothing lost.
        let blob = "x".repeat(9000);
        let parts = split_message(&blob, 4096);
        assert_eq!(parts.iter().map(String::len).sum::<usize>(), 9000);
    }

    #[test]
    fn button_presses_count_only_from_the_paired_private_chat() {
        assert!(from_paired_chat(7, "private", Some(7)));
        assert!(!from_paired_chat(8, "private", Some(7)));
        assert!(!from_paired_chat(7, "group", Some(7)));
        assert!(!from_paired_chat(7, "private", None));
        // Pending-action buttons pass the data check; anything else does not.
        assert!(valid_data("pa:yes:12") && valid_data("pa:no:3"));
        assert!(!valid_data("pa:yes:12; rm"));
    }

    #[test]
    fn reads_button_presses_with_safe_data_only() {
        let ok = json!({ "callback_query": { "id": "42", "data": "cap:yes:3", "message": { "chat": { "id": 7, "type": "private" } } } });
        assert_eq!(callback(&ok), Some((7, "private".into(), Incoming::Callback { id: "42".into(), data: "cap:yes:3".into() })));
        let bad = json!({ "callback_query": { "id": "42", "data": "rm -rf /", "message": { "chat": { "id": 7, "type": "private" } } } });
        assert_eq!(callback(&bad), None);
        assert_eq!(callback(&json!({ "message": { "text": "hi" } })), None);
    }

    #[test]
    fn reads_text_and_location_pins_only() {
        assert_eq!(
            incoming(&json!({ "text": "hi" })),
            Some(Incoming::Text { text: "hi".into() })
        );
        assert_eq!(
            incoming(&json!({ "location": { "latitude": -6.93, "longitude": 107.77 } })),
            Some(Incoming::Location { latitude: -6.93, longitude: 107.77 })
        );
        assert_eq!(incoming(&json!({ "location": { "latitude": 123.0, "longitude": 0.0 } })), None);
        assert_eq!(incoming(&json!({ "photo": [] })), None);
    }

    #[test]
    fn pairs_only_with_the_current_code() {
        *pairing() = Some(("123456".into(), Instant::now()));
        assert!(!try_pair("/pair 000000"));
        assert!(!try_pair("hello"));
        assert!(try_pair("/pair@NoxBot 123456"));
        // Used up.
        assert!(!try_pair("/pair 123456"));
    }
}
