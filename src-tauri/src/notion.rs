//! Notion access. Reading is open to the sync; writing is narrow on purpose.
//!
//! Read: the frontend asks for a database's rows; this module adds the token
//! from Credential Manager, pages through the results, stays under Notion's
//! rate limit (about 3 requests a second) and retries a 429 after
//! Retry-After. Property mapping happens in TypeScript.
//!
//! Write (only while the `notion_write_enabled` setting is "true"), exactly
//! three operations and nothing else:
//!   - set the Done checkbox of an existing assignment page
//!   - create a page in the assignments database with title, date, course
//!   - update the title and/or date of an existing assignment page
//! There is no code path that deletes, archives, moves or edits any other
//! property or database (Grade, Weight, Weighted Mark, Courses are never
//! written). Property names come from the mapping settings, are checked, and
//! are the only keys a write body can contain.
//!
//! Conflict rule for updates (Done, title, date): the page is always read
//! first. When the caller passes the local `syncedAt` and the page was edited
//! in Notion since then, nothing is written and the fresh page comes back as
//! `stale`; the frontend refreshes its copy and calls again without
//! `syncedAt` to write on top of the fresh data.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::db;
use crate::http::{self, ApiError};
use crate::secrets;

const API: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";
const MIN_GAP: Duration = Duration::from_millis(350);
const MAX_RETRIES: u32 = 3;
const PAGE_SIZE: u32 = 100;
/// 50 × 100 rows is far more than a semester has; stops a runaway loop.
const MAX_PAGES: usize = 50;
const MAX_NAME: usize = 2000;

static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::const_new(None);

/// One database row (or page): its id, raw `properties` object, whether it
/// was archived (deleted) in Notion, and when it was last edited there.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotionRow {
    id: String,
    archived: bool,
    properties: Value,
    last_edited_time: Option<String>,
}

fn row_of(page: &Value) -> Option<NotionRow> {
    Some(NotionRow {
        id: page["id"].as_str()?.to_string(),
        archived: page["archived"].as_bool().unwrap_or(false) || page["in_trash"].as_bool().unwrap_or(false),
        properties: page["properties"].clone(),
        last_edited_time: page["last_edited_time"].as_str().map(str::to_string),
    })
}

/// A database or page id is 32 hex digits, with or without dashes. Anything
/// else is rejected here so it can never change the request path.
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

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Read,
    Write,
}

/// One request with pacing and 429 retries. A 429 means Notion did not act,
/// so retrying is safe even for a create. On writes, 403 means the
/// integration may only read.
async fn send(base: &str, token: &str, method: reqwest::Method, path: &str, body: Option<&Value>, kind: Kind) -> Result<Value, ApiError> {
    let url = format!("{base}{path}");
    let mut attempt = 0;
    loop {
        pace().await;
        let mut req = http::client()
            .request(method.clone(), &url)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION);
        if let Some(b) = body {
            req = req.json(b);
        }
        let response = req.send().await?;
        let status = response.status().as_u16();
        if status == 429 && attempt < MAX_RETRIES {
            attempt += 1;
            tokio::time::sleep(http::retry_after(&response, 2)).await;
            continue;
        }
        if status == 403 && kind == Kind::Write {
            return Err(ApiError::ReadOnly);
        }
        if !(200..300).contains(&status) {
            return Err(http::from_status(status));
        }
        return response.json::<Value>().await.map_err(ApiError::from);
    }
}

// ── Read ──

async fn query_all(base: &str, token: &str, id: &str) -> Result<Vec<NotionRow>, ApiError> {
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut body = json!({ "page_size": PAGE_SIZE });
        if let Some(c) = &cursor {
            body["start_cursor"] = json!(c);
        }
        let page = send(base, token, reqwest::Method::POST, &format!("/databases/{id}/query"), Some(&body), Kind::Read).await?;
        let results = page["results"].as_array().ok_or(ApiError::BadResponse)?;
        rows.extend(results.iter().filter_map(row_of));
        match (page["has_more"].as_bool(), page["next_cursor"].as_str()) {
            (Some(true), Some(next)) => cursor = Some(next.to_string()),
            _ => return Ok(rows),
        }
    }
    Ok(rows)
}

/// Every row of a Notion database (read-only).
#[tauri::command]
pub async fn notion_query_database(database_id: String) -> Result<Vec<NotionRow>, ApiError> {
    let id = clean_id(&database_id)?;
    let token = secrets::get(secrets::NOTION_TOKEN).ok_or(ApiError::NoToken)?;
    query_all(API, &token, &id).await
}

// ── Write ──

/// The property names a write may use, from the mapping settings (empty =
/// the "student essentials" template names). Nothing else is ever written.
#[derive(Debug, Clone, PartialEq)]
struct WriteProps {
    title: String,
    date: String,
    course: String,
    done: String,
}

fn valid_prop(name: &str) -> bool {
    !name.trim().is_empty() && name.len() <= 100 && !name.chars().any(char::is_control)
}

async fn write_props(app: &AppHandle) -> Result<WriteProps, ApiError> {
    let get = |key: &'static str, fallback: &'static str| async move {
        db::read_setting_async(app, key)
            .await
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    let props = WriteProps {
        title: get("notion_map_title", "Name").await,
        date: get("notion_map_due", "Date").await,
        course: get("notion_map_course", "Courses").await,
        done: get("notion_map_done", "Done").await,
    };
    if [&props.title, &props.date, &props.course, &props.done].iter().all(|p| valid_prop(p)) {
        Ok(props)
    } else {
        Err(ApiError::Invalid)
    }
}

async fn writes_enabled(app: &AppHandle) -> Result<String, ApiError> {
    if db::read_setting_async(app, "notion_write_enabled").await.as_deref() != Some("true") {
        return Err(ApiError::WritesOff);
    }
    secrets::get(secrets::NOTION_TOKEN).ok_or(ApiError::NoToken)
}

/// "2026-11-06" or "2026-11-06T18:30:00+07:00": a Notion date start.
fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    let date_ok = b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    date_ok
        && (b.len() == 10
            || (b.len() <= 29 && b[10] == b'T' && s[11..].chars().all(|c| c.is_ascii_digit() || ":+-.Z".contains(c))))
}

/// What an update did. `stale`: the page changed in Notion since `syncedAt`,
/// so nothing was written and `row` is the fresh page. Otherwise `row` is
/// the page as Notion has it afterwards (`written` false when it already had
/// those values).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    stale: bool,
    written: bool,
    row: NotionRow,
}

/// Was the page edited at or after the local sync? Notion's
/// `last_edited_time` has minute precision, so the sync time is rounded down
/// to its minute: an edit in the same minute counts as newer (one extra
/// refresh, never a missed edit).
fn edited_since(last_edited: Option<&str>, synced_at: &str) -> Result<bool, ApiError> {
    use chrono::{DateTime, Timelike};
    let synced = DateTime::parse_from_rfc3339(synced_at).map_err(|_| ApiError::Invalid)?;
    let synced = synced.with_second(0).and_then(|d| d.with_nanosecond(0)).ok_or(ApiError::Invalid)?;
    // No timestamp from Notion: assume it changed (refresh first).
    let Some(edited) = last_edited.and_then(|e| DateTime::parse_from_rfc3339(e).ok()) else {
        return Ok(true);
    };
    Ok(edited >= synced)
}

/// Read the page before any update: it must exist, and with `synced_at`, it
/// must not have changed in Notion since (else `Ok(Err(fresh row))`).
async fn read_for_update(base: &str, token: &str, page_id: &str, synced_at: Option<&str>) -> Result<Result<Value, NotionRow>, ApiError> {
    let page = send(base, token, reqwest::Method::GET, &format!("/pages/{page_id}"), None, Kind::Write).await?;
    if page["archived"].as_bool() == Some(true) || page["in_trash"].as_bool() == Some(true) {
        return Err(ApiError::NotFound);
    }
    if let Some(s) = synced_at {
        if edited_since(page["last_edited_time"].as_str(), s)? {
            return Ok(Err(row_of(&page).ok_or(ApiError::BadResponse)?));
        }
    }
    Ok(Ok(page))
}

async fn patch(base: &str, token: &str, page_id: &str, props: serde_json::Map<String, Value>) -> Result<NotionRow, ApiError> {
    let body = json!({ "properties": Value::Object(props) });
    let updated = send(base, token, reqwest::Method::PATCH, &format!("/pages/{page_id}"), Some(&body), Kind::Write).await?;
    row_of(&updated).ok_or(ApiError::BadResponse)
}

/// Read the page (conflict rule), then set only its Done checkbox.
async fn set_done_inner(base: &str, token: &str, page_id: &str, done_prop: &str, done: bool, synced_at: Option<&str>) -> Result<UpdateResult, ApiError> {
    let page = match read_for_update(base, token, page_id, synced_at).await? {
        Ok(page) => page,
        Err(fresh) => return Ok(UpdateResult { stale: true, written: false, row: fresh }),
    };
    // The property must really be a checkbox before anything is written.
    if page["properties"][done_prop]["type"].as_str() != Some("checkbox") {
        return Err(ApiError::Invalid);
    }
    if page["properties"][done_prop]["checkbox"].as_bool() == Some(done) {
        // Already so; write nothing.
        return Ok(UpdateResult { stale: false, written: false, row: row_of(&page).ok_or(ApiError::BadResponse)? });
    }
    let mut props = serde_json::Map::new();
    props.insert(done_prop.to_string(), json!({ "checkbox": done }));
    let row = patch(base, token, page_id, props).await?;
    Ok(UpdateResult { stale: false, written: true, row })
}

fn plain_title(prop: &Value) -> String {
    prop["title"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|p| p["plain_text"].as_str().or(p["text"]["content"].as_str())).collect())
        .unwrap_or_default()
}

/// Read the page (conflict rule), then set only its title and/or date: the
/// two keys from the mapping, and only those that differ.
async fn update_inner(
    base: &str,
    token: &str,
    page_id: &str,
    props: &WriteProps,
    name: Option<&str>,
    date: Option<&str>,
    synced_at: Option<&str>,
) -> Result<UpdateResult, ApiError> {
    let page = match read_for_update(base, token, page_id, synced_at).await? {
        Ok(page) => page,
        Err(fresh) => return Ok(UpdateResult { stale: true, written: false, row: fresh }),
    };
    let current = &page["properties"];
    let mut changes = serde_json::Map::new();
    if let Some(n) = name {
        if current[&props.title]["type"].as_str() != Some("title") {
            return Err(ApiError::Invalid);
        }
        if plain_title(&current[&props.title]) != n {
            changes.insert(props.title.clone(), json!({ "title": [{ "text": { "content": n } }] }));
        }
    }
    if let Some(d) = date {
        if current[&props.date]["type"].as_str() != Some("date") {
            return Err(ApiError::Invalid);
        }
        let now = current[&props.date]["date"]["start"].as_str();
        let same = now.is_some_and(|s| s == d || s.replace(".000", "") == d);
        if !same {
            changes.insert(props.date.clone(), json!({ "date": { "start": d } }));
        }
    }
    if changes.is_empty() {
        return Ok(UpdateResult { stale: false, written: false, row: row_of(&page).ok_or(ApiError::BadResponse)? });
    }
    let row = patch(base, token, page_id, changes).await?;
    Ok(UpdateResult { stale: false, written: true, row })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    page_id: String,
    /// True when an earlier, uncertain attempt had in fact created it.
    existed: bool,
}

struct NewPage<'a> {
    name: &'a str,
    date: Option<&'a str>,
    course_id: Option<&'a str>,
    /// Set on a retry: first look for a page this create already made.
    existing_since: Option<&'a str>,
}

async fn create_inner(base: &str, token: &str, db_id: &str, props: &WriteProps, p: NewPage<'_>) -> Result<Created, ApiError> {
    // A create is not idempotent. When an earlier attempt may have got
    // through (timeout, dropped connection), check before creating again.
    if let Some(since) = p.existing_since {
        let filter = json!({
            "page_size": 5,
            "filter": { "and": [
                { "property": props.title, "title": { "equals": p.name } },
                { "timestamp": "created_time", "created_time": { "on_or_after": since } }
            ]}
        });
        let found = send(base, token, reqwest::Method::POST, &format!("/databases/{db_id}/query"), Some(&filter), Kind::Write).await?;
        if let Some(id) = found["results"].as_array().and_then(|r| r.first()).and_then(|r| r["id"].as_str()) {
            return Ok(Created { page_id: id.to_string(), existed: true });
        }
    }

    let mut properties = serde_json::Map::new();
    properties.insert(props.title.clone(), json!({ "title": [{ "text": { "content": p.name } }] }));
    if let Some(d) = p.date {
        properties.insert(props.date.clone(), json!({ "date": { "start": d } }));
    }
    if let Some(c) = p.course_id {
        properties.insert(props.course.clone(), json!({ "relation": [{ "id": c }] }));
    }
    let body = json!({ "parent": { "database_id": db_id }, "properties": Value::Object(properties) });
    let page = send(base, token, reqwest::Method::POST, "/pages", Some(&body), Kind::Write).await?;
    let id = page["id"].as_str().ok_or(ApiError::BadResponse)?;
    Ok(Created { page_id: id.to_string(), existed: false })
}

fn check_synced(synced_at: Option<&str>) -> Result<(), ApiError> {
    match synced_at {
        Some(s) if chrono::DateTime::parse_from_rfc3339(s).is_err() => Err(ApiError::Invalid),
        _ => Ok(()),
    }
}

/// Set (or clear) the Done checkbox of an assignment page. With `syncedAt`
/// (the local copy's sync time), a page changed in Notion since then comes
/// back `stale` and nothing is written.
#[tauri::command]
pub async fn notion_set_done(app: AppHandle, page_id: String, done: bool, synced_at: Option<String>) -> Result<UpdateResult, ApiError> {
    let id = clean_id(&page_id)?;
    check_synced(synced_at.as_deref())?;
    let token = writes_enabled(&app).await?;
    let props = write_props(&app).await?;
    set_done_inner(API, &token, &id, &props.done, done, synced_at.as_deref()).await
}

/// Change the title and/or date of an assignment page; nothing else. Same
/// `syncedAt` rule as `notion_set_done`.
#[tauri::command]
pub async fn notion_update_assignment(
    app: AppHandle,
    page_id: String,
    name: Option<String>,
    date_iso: Option<String>,
    synced_at: Option<String>,
) -> Result<UpdateResult, ApiError> {
    let id = clean_id(&page_id)?;
    let name = name.as_deref().map(str::trim);
    if name.is_some_and(|n| n.is_empty() || n.chars().count() > MAX_NAME) {
        return Err(ApiError::Invalid);
    }
    if date_iso.as_deref().is_some_and(|d| !valid_date(d)) {
        return Err(ApiError::Invalid);
    }
    if name.is_none() && date_iso.is_none() {
        return Err(ApiError::Invalid);
    }
    check_synced(synced_at.as_deref())?;
    let token = writes_enabled(&app).await?;
    let props = write_props(&app).await?;
    update_inner(API, &token, &id, &props, name, date_iso.as_deref(), synced_at.as_deref()).await
}

/// Create an assignment page: title, optional date, optional course (a
/// synced course page id, matched by name in the frontend).
#[tauri::command]
pub async fn notion_create_assignment(
    app: AppHandle,
    database_id: String,
    name: String,
    date_iso: Option<String>,
    course_page_id: Option<String>,
    existing_since: Option<String>,
) -> Result<Created, ApiError> {
    let db_id = clean_id(&database_id)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(ApiError::Invalid);
    }
    if date_iso.as_deref().is_some_and(|d| !valid_date(d)) {
        return Err(ApiError::Invalid);
    }
    let course = course_page_id.as_deref().map(clean_id).transpose()?;
    if existing_since.as_deref().is_some_and(|d| !valid_date(d)) {
        return Err(ApiError::Invalid);
    }
    let token = writes_enabled(&app).await?;
    let props = write_props(&app).await?;
    create_inner(
        API,
        &token,
        &db_id,
        &props,
        NewPage { name, date: date_iso.as_deref(), course_id: course.as_deref(), existing_since: existing_since.as_deref() },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex as StdMutex};

    type Log = Arc<StdMutex<Vec<String>>>;

    /// A tiny HTTP server: answers each request with the first canned
    /// response whose "METHOD /path" prefix matches, and logs every request
    /// as "METHOD /path BODY".
    fn mock(routes: Vec<(&'static str, u16, String)>) -> (String, Log) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log: Log = Arc::new(StdMutex::new(Vec::new()));
        let seen = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read headers, then the body by Content-Length.
                let (head_end, len) = loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break (buf.len(), 0);
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                            .unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + len {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let text = String::from_utf8_lossy(&buf).to_string();
                let line = text.lines().next().unwrap_or("").to_string();
                let mut parts = line.split_whitespace();
                let key = format!("{} {}", parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                let body = text.get(head_end..).unwrap_or("").to_string();
                seen.lock().unwrap().push(format!("{key} {body}"));
                let (status, reply) = routes
                    .iter()
                    .find(|(p, _, _)| key.starts_with(p))
                    .map(|(_, s, b)| (*s, b.clone()))
                    .unwrap_or((404, "{}".into()));
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (base, log)
    }

    const PAGE: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    const DB: &str = "aaaaaaaabbbbccccddddeeeeeeeeeeee";

    fn props() -> WriteProps {
        WriteProps { title: "Name".into(), date: "Date".into(), course: "Courses".into(), done: "Done".into() }
    }

    fn page(done: bool) -> String {
        json!({ "id": PAGE, "archived": false, "last_edited_time": "2026-11-04T01:00:00.000Z",
                "properties": { "Done": { "type": "checkbox", "checkbox": done }, "Name": { "type": "title", "title": [] } } })
        .to_string()
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn accepts_only_hex_ids() {
        assert_eq!(clean_id("1A2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d").unwrap(), "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
        assert!(clean_id("../users/me").is_err());
        assert!(clean_id("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6").is_err());
    }

    #[test]
    fn checks_dates_and_property_names() {
        assert!(valid_date("2026-11-06"));
        assert!(valid_date("2026-11-06T18:30:00+07:00"));
        assert!(!valid_date("tomorrow"));
        assert!(!valid_date("2026-11-06T18:30\"}"));
        assert!(valid_prop("Done"));
        assert!(!valid_prop("  "));
        assert!(!valid_prop("a\nb"));
    }

    #[test]
    fn set_done_reads_first_and_writes_only_the_done_checkbox() {
        let (base, log) = mock(vec![("GET /pages/", 200, page(false)), ("PATCH /pages/", 200, page(true))]);
        let row = run(set_done_inner(&base, "tok", PAGE, "Done", true, None)).unwrap().row;
        assert_eq!(row.properties["Done"]["checkbox"], json!(true));
        let log = log.lock().unwrap();
        assert!(log[0].starts_with(&format!("GET /pages/{PAGE}")));
        assert!(log[1].starts_with(&format!("PATCH /pages/{PAGE}")));
        let body: Value = serde_json::from_str(log[1].splitn(3, ' ').nth(2).unwrap()).unwrap();
        // The property allow-list: exactly one key, the Done checkbox.
        assert_eq!(body, json!({ "properties": { "Done": { "checkbox": true } } }));
    }

    #[test]
    fn set_done_writes_nothing_when_already_set() {
        let (base, log) = mock(vec![("GET /pages/", 200, page(true))]);
        run(set_done_inner(&base, "tok", PAGE, "Done", true, None)).unwrap();
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[test]
    fn refuses_a_done_property_that_is_not_a_checkbox() {
        let mut p: Value = serde_json::from_str(&page(false)).unwrap();
        p["properties"]["Done"] = json!({ "type": "status", "status": { "name": "Done" } });
        let (base, log) = mock(vec![("GET /pages/", 200, p.to_string())]);
        assert_eq!(run(set_done_inner(&base, "tok", PAGE, "Done", true, None)), Err(ApiError::Invalid));
        assert_eq!(log.lock().unwrap().len(), 1, "no PATCH was sent");
    }

    #[test]
    fn maps_a_403_on_write_to_read_only() {
        let (base, _) = mock(vec![("GET /pages/", 403, r#"{"code":"restricted_resource"}"#.into())]);
        assert_eq!(run(set_done_inner(&base, "tok", PAGE, "Done", true, None)), Err(ApiError::ReadOnly));
        let (base, _) = mock(vec![("POST /pages", 403, "{}".into())]);
        let r = run(create_inner(&base, "tok", DB, &props(), NewPage { name: "x", date: None, course_id: None, existing_since: None }));
        assert_eq!(r, Err(ApiError::ReadOnly));
    }

    #[test]
    fn creates_with_only_title_date_and_course() {
        let (base, log) = mock(vec![("POST /pages", 200, json!({ "id": PAGE }).to_string())]);
        let r = run(create_inner(
            &base,
            "tok",
            DB,
            &props(),
            NewPage { name: "laporan test", date: Some("2026-11-06"), course_id: Some(PAGE), existing_since: None },
        ))
        .unwrap();
        assert_eq!(r, Created { page_id: PAGE.into(), existed: false });
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 1);
        let body: Value = serde_json::from_str(log[0].splitn(3, ' ').nth(2).unwrap()).unwrap();
        assert_eq!(body["parent"], json!({ "database_id": DB }));
        let mut keys: Vec<_> = body["properties"].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["Courses", "Date", "Name"]);
    }

    #[test]
    fn a_retried_create_finds_the_page_an_earlier_attempt_made() {
        let (base, log) = mock(vec![
            ("POST /databases/", 200, json!({ "results": [{ "id": PAGE }] }).to_string()),
            ("POST /pages", 200, json!({ "id": "other" }).to_string()),
        ]);
        let r = run(create_inner(
            &base,
            "tok",
            DB,
            &props(),
            NewPage { name: "x", date: None, course_id: None, existing_since: Some("2026-11-04T01:00:00Z") },
        ))
        .unwrap();
        assert_eq!(r, Created { page_id: PAGE.into(), existed: true });
        assert_eq!(log.lock().unwrap().len(), 1, "no second create was sent");
    }

    #[test]
    fn a_retried_create_creates_when_nothing_was_made() {
        let (base, log) = mock(vec![
            ("POST /databases/", 200, json!({ "results": [] }).to_string()),
            ("POST /pages", 200, json!({ "id": PAGE }).to_string()),
        ]);
        let r = run(create_inner(
            &base,
            "tok",
            DB,
            &props(),
            NewPage { name: "x", date: None, course_id: None, existing_since: Some("2026-11-04T01:00:00Z") },
        ))
        .unwrap();
        assert!(!r.existed);
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    // ── Update (title, date) and the conflict rule ──

    /// An assignment page as Notion returns it, with the properties a write
    /// must never touch.
    fn full_page(name: &str, date: &str, edited: &str) -> String {
        json!({ "id": PAGE, "archived": false, "last_edited_time": edited,
                "properties": {
                    "Name": { "type": "title", "title": [{ "plain_text": name, "text": { "content": name } }] },
                    "Date": { "type": "date", "date": { "start": date } },
                    "Done": { "type": "checkbox", "checkbox": false },
                    "Courses": { "type": "relation", "relation": [] },
                    "Grade": { "type": "number", "number": 90 },
                    "Weight": { "type": "number", "number": 0.2 },
                    "Weighted Mark": { "type": "formula", "formula": { "number": 18 } } } })
        .to_string()
    }

    fn body_of(entry: &str) -> Value {
        serde_json::from_str(entry.splitn(3, ' ').nth(2).unwrap()).unwrap()
    }

    #[test]
    fn update_writes_only_title_and_date() {
        let (base, log) = mock(vec![
            ("GET /pages/", 200, full_page("old", "2026-11-06", "2026-11-04T01:00:00.000Z")),
            ("PATCH /pages/", 200, full_page("new", "2026-11-07T23:59:00+07:00", "2026-11-04T02:00:00.000Z")),
        ]);
        let r = run(update_inner(&base, "tok", PAGE, &props(), Some("new"), Some("2026-11-07T23:59:00+07:00"), None)).unwrap();
        assert!(r.written && !r.stale);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 2);
        assert!(log[1].starts_with(&format!("PATCH /pages/{PAGE}")));
        // The allow-list: Name and Date only, never Grade, Weight, Weighted Mark, Done, Courses.
        assert_eq!(
            body_of(&log[1]),
            json!({ "properties": {
                "Name": { "title": [{ "text": { "content": "new" } }] },
                "Date": { "date": { "start": "2026-11-07T23:59:00+07:00" } } } })
        );
    }

    #[test]
    fn update_sends_only_what_changed_and_nothing_when_equal() {
        let (base, log) = mock(vec![
            ("GET /pages/", 200, full_page("same", "2026-11-06", "2026-11-04T01:00:00.000Z")),
            ("PATCH /pages/", 200, full_page("same", "2026-11-08", "2026-11-04T02:00:00.000Z")),
        ]);
        run(update_inner(&base, "tok", PAGE, &props(), Some("same"), Some("2026-11-08"), None)).unwrap();
        assert_eq!(body_of(&log.lock().unwrap()[1]), json!({ "properties": { "Date": { "date": { "start": "2026-11-08" } } } }));

        let (base, log) = mock(vec![("GET /pages/", 200, full_page("same", "2026-11-06T18:30:00.000+07:00", "2026-11-04T01:00:00.000Z"))]);
        let r = run(update_inner(&base, "tok", PAGE, &props(), Some("same"), Some("2026-11-06T18:30:00+07:00"), None)).unwrap();
        assert!(!r.written);
        assert_eq!(log.lock().unwrap().len(), 1, "no PATCH when nothing differs");
    }

    #[test]
    fn a_page_edited_since_the_sync_comes_back_stale_and_nothing_is_written() {
        let (base, log) = mock(vec![
            ("GET /pages/", 200, full_page("edited in Notion", "2026-11-06", "2026-11-04T10:05:00.000Z")),
            ("PATCH /pages/", 200, full_page("x", "2026-11-06", "2026-11-04T10:06:00.000Z")),
        ]);
        let r = run(update_inner(&base, "tok", PAGE, &props(), Some("new"), None, Some("2026-11-04T10:00:30.000Z"))).unwrap();
        assert!(r.stale && !r.written);
        assert_eq!(r.row.properties["Name"]["title"][0]["plain_text"], json!("edited in Notion"));
        assert_eq!(log.lock().unwrap().len(), 1, "read only");
        // Done follows the same rule.
        let (base, log) = mock(vec![("GET /pages/", 200, full_page("x", "2026-11-06", "2026-11-04T10:05:00.000Z"))]);
        let r = run(set_done_inner(&base, "tok", PAGE, "Done", true, Some("2026-11-04T10:00:00Z"))).unwrap();
        assert!(r.stale && !r.written);
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_older_edit_is_not_stale_so_the_write_goes_through() {
        let (base, log) = mock(vec![
            ("GET /pages/", 200, full_page("old", "2026-11-06", "2026-11-04T09:00:00.000Z")),
            ("PATCH /pages/", 200, full_page("new", "2026-11-06", "2026-11-04T10:06:00.000Z")),
        ]);
        let r = run(update_inner(&base, "tok", PAGE, &props(), Some("new"), None, Some("2026-11-04T10:00:30.000Z"))).unwrap();
        assert!(r.written && !r.stale);
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    #[test]
    fn edits_in_the_sync_minute_count_as_newer() {
        // Notion rounds last_edited_time down to the minute.
        assert!(edited_since(Some("2026-11-04T10:00:00.000Z"), "2026-11-04T10:00:40.000Z").unwrap());
        assert!(!edited_since(Some("2026-11-04T09:59:00.000Z"), "2026-11-04T10:00:40.000Z").unwrap());
        assert!(edited_since(None, "2026-11-04T10:00:40Z").unwrap());
        assert_eq!(edited_since(Some("2026-11-04T10:00:00Z"), "yesterday"), Err(ApiError::Invalid));
    }

    #[test]
    fn update_maps_403_to_read_only_and_refuses_wrong_property_types() {
        let (base, _) = mock(vec![
            ("GET /pages/", 200, full_page("old", "2026-11-06", "2026-11-04T01:00:00.000Z")),
            ("PATCH /pages/", 403, r#"{"code":"restricted_resource"}"#.into()),
        ]);
        let r = run(update_inner(&base, "tok", PAGE, &props(), Some("new"), None, None));
        assert_eq!(r, Err(ApiError::ReadOnly));

        // A mapping that points the date at a non-date property writes nothing.
        let mut wrong = props();
        wrong.date = "Grade".into();
        let (base, log) = mock(vec![("GET /pages/", 200, full_page("old", "2026-11-06", "2026-11-04T01:00:00.000Z"))]);
        assert_eq!(run(update_inner(&base, "tok", PAGE, &wrong, None, Some("2026-11-08"), None)), Err(ApiError::Invalid));
        assert_eq!(log.lock().unwrap().len(), 1, "no PATCH was sent");
    }

    #[test]
    fn update_refuses_an_archived_page() {
        let mut p: Value = serde_json::from_str(&full_page("x", "2026-11-06", "2026-11-04T01:00:00.000Z")).unwrap();
        p["archived"] = json!(true);
        let (base, log) = mock(vec![("GET /pages/", 200, p.to_string())]);
        assert_eq!(run(update_inner(&base, "tok", PAGE, &props(), Some("y"), None, None)), Err(ApiError::NotFound));
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[test]
    fn validates_synced_at() {
        assert!(check_synced(None).is_ok());
        assert!(check_synced(Some("2026-11-04T10:00:00.123Z")).is_ok());
        assert_eq!(check_synced(Some("2026-11-04 10:00")), Err(ApiError::Invalid));
    }
}
