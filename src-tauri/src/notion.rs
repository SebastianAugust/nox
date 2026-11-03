//! Read-only Notion access. Nothing here ever writes to Notion.
//!
//! The frontend asks for a database's rows; this module adds the token from
//! Credential Manager, pages through the results, stays under Notion's rate
//! limit (about 3 requests a second) and retries a 429 after Retry-After.
//! Property mapping happens in TypeScript (`src/lib/notionMapping.ts`).

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::http::{self, ApiError};
use crate::secrets;

const API: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";
const MIN_GAP: Duration = Duration::from_millis(350);
const MAX_RETRIES: u32 = 3;
const PAGE_SIZE: u32 = 100;
/// 50 × 100 rows is far more than a semester has; stops a runaway loop.
const MAX_PAGES: usize = 50;

static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::const_new(None);

/// One database row: its id, raw `properties` object and whether it was
/// archived (deleted) in Notion.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionRow {
    id: String,
    archived: bool,
    properties: Value,
}

/// A database id is 32 hex digits, with or without dashes. Anything else is
/// rejected here so it can never change the request path.
fn clean_id(raw: &str) -> Result<String, ApiError> {
    let hex: String = raw.chars().filter(|c| *c != '-').collect();
    if hex.len() == 32 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(hex.to_ascii_lowercase())
    } else {
        Err(ApiError::Invalid)
    }
}

/// Wait until at least MIN_GAP has passed since the previous Notion request.
async fn pace() {
    let mut last = LAST_REQUEST.lock().await;
    if let Some(at) = *last {
        let since = at.elapsed();
        if since < MIN_GAP {
            tokio::time::sleep(MIN_GAP - since).await;
        }
    }
    *last = Some(Instant::now());
}

async fn query_page(token: &str, id: &str, cursor: Option<&str>) -> Result<Value, ApiError> {
    let mut body = json!({ "page_size": PAGE_SIZE });
    if let Some(c) = cursor {
        body["start_cursor"] = json!(c);
    }
    let url = format!("{API}/databases/{id}/query");

    let mut attempt = 0;
    loop {
        pace().await;
        let response = http::client()
            .post(&url)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
            .json(&body)
            .send()
            .await?;
        let status = response.status().as_u16();
        if status == 429 && attempt < MAX_RETRIES {
            attempt += 1;
            tokio::time::sleep(http::retry_after(&response, 2)).await;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(http::from_status(status));
        }
        return response.json::<Value>().await.map_err(ApiError::from);
    }
}

/// Every row of a Notion database (read-only).
#[tauri::command]
pub async fn notion_query_database(database_id: String) -> Result<Vec<NotionRow>, ApiError> {
    let id = clean_id(&database_id)?;
    let token = secrets::get(secrets::NOTION_TOKEN).ok_or(ApiError::NoToken)?;

    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = query_page(&token, &id, cursor.as_deref()).await?;
        let results = page["results"].as_array().ok_or(ApiError::BadResponse)?;
        for r in results {
            let Some(id) = r["id"].as_str() else { continue };
            rows.push(NotionRow {
                id: id.to_string(),
                archived: r["archived"].as_bool().unwrap_or(false)
                    || r["in_trash"].as_bool().unwrap_or(false),
                properties: r["properties"].clone(),
            });
        }
        match (page["has_more"].as_bool(), page["next_cursor"].as_str()) {
            (Some(true), Some(next)) => cursor = Some(next.to_string()),
            _ => return Ok(rows),
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::clean_id;

    #[test]
    fn accepts_only_hex_ids() {
        assert_eq!(
            clean_id("1A2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d").unwrap(),
            "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"
        );
        assert!(clean_id("../users/me").is_err());
        assert!(clean_id("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6").is_err());
    }
}
