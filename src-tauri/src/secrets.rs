//! API tokens in Windows Credential Manager.
//!
//! The frontend can store, remove and ask "is one saved?", but no command ever
//! returns a token to JavaScript. Tokens are read only here, by the Rust code
//! that calls the API, and never written to the database, a log or an error.

use keyring::Entry;

/// Credential Manager "service" the entries are filed under.
const SERVICE: &str = "com.lenovo.nox";

/// The only names the frontend may touch.
pub const NOTION_TOKEN: &str = "notion_token";
pub const TELEGRAM_TOKEN: &str = "telegram_bot_token";
const ALLOWED: [&str; 2] = [NOTION_TOKEN, TELEGRAM_TOKEN];

const MAX_LEN: usize = 512;

fn entry(name: &str) -> Result<Entry, String> {
    if !ALLOWED.contains(&name) {
        return Err("unknown secret".into());
    }
    Entry::new(SERVICE, name).map_err(|_| "credential store unavailable".into())
}

/// The stored token, for Rust callers only. `None` when not set or unreadable.
pub fn get(name: &str) -> Option<String> {
    entry(name)
        .ok()?
        .get_password()
        .ok()
        .filter(|v| !v.is_empty())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let value = value.trim();
    // Tokens are a single printable word. Rejecting anything else also keeps a
    // Telegram token safe to place in its URL path.
    if value.is_empty()
        || value.len() > MAX_LEN
        || !value.chars().all(|c| c.is_ascii_graphic())
    {
        return Err("invalid token".into());
    }
    entry(&name)?
        .set_password(value)
        .map_err(|_| "could not save to Credential Manager".into())
}

#[tauri::command]
pub fn secret_exists(name: String) -> Result<bool, String> {
    entry(&name)?;
    Ok(get(&name).is_some())
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("could not remove from Credential Manager".into()),
    }
}
