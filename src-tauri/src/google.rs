//! Google Calendar: OAuth for a desktop app, reading events, creating events.
//!
//! OAuth (Authorization Code + PKCE, loopback redirect):
//!   - Nox opens the system browser at Google's consent page with a fresh
//!     PKCE verifier (S256) and a random `state`, and listens once on
//!     127.0.0.1 at a random free port for the redirect.
//!   - Scopes: `calendar.readonly` and `calendar.events`, nothing else.
//!   - The client id/secret Bas pasted and the refresh token live in Windows
//!     Credential Manager (`secrets.rs`); the access token only in memory.
//!     None of them is ever returned to the frontend, logged, or put in an
//!     error (errors are `ApiError` kinds).
//!   - Disconnect revokes the token with Google and deletes it locally.
//!
//! Calendar writes: exactly one, creating an event (title, start, end,
//! optional location). There is no code path that edits or deletes events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::http::{self, ApiError};
use crate::secrets;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API_URL: &str = "https://www.googleapis.com/calendar/v3";
pub const SCOPE_READ: &str = "https://www.googleapis.com/auth/calendar.readonly";
pub const SCOPE_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";
/// How long Nox waits for Bas to finish in the browser.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Refresh the access token this long before Google says it expires.
const EARLY: Duration = Duration::from_secs(60);
const MAX_PAGES: usize = 40;
const MAX_TITLE: usize = 300;

/// Where requests go; tests point these at a local mock server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub token: String,
    pub revoke: String,
    pub api: String,
}

fn live() -> Endpoints {
    Endpoints { token: TOKEN_URL.into(), revoke: REVOKE_URL.into(), api: API_URL.into() }
}

struct Client {
    id: String,
    secret: String,
}

fn client() -> Result<Client, ApiError> {
    let id = secrets::get(secrets::GOOGLE_CLIENT_ID).ok_or(ApiError::NoToken)?;
    let secret = secrets::get(secrets::GOOGLE_CLIENT_SECRET).ok_or(ApiError::NoToken)?;
    Ok(Client { id, secret })
}

static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::const_new(None);
static LOGIN_RUNNING: AtomicBool = AtomicBool::new(false);

// ── PKCE and state ──

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64(n: usize) -> Result<String, ApiError> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).map_err(|_| ApiError::Invalid)?;
    Ok(b64(&bytes))
}

/// A PKCE code verifier: 64 characters from the unreserved set (RFC 7636
/// allows 43-128).
fn new_verifier() -> Result<String, ApiError> {
    random_b64(48)
}

/// S256: base64url(SHA-256(verifier)), no padding.
fn challenge(verifier: &str) -> String {
    b64(&Sha256::digest(verifier.as_bytes()))
}

fn auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> Result<reqwest::Url, ApiError> {
    reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", &format!("{SCOPE_READ} {SCOPE_EVENTS}")),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            // A refresh token every time (also on reconnect).
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|_| ApiError::Invalid)
}

/// Equal-time comparison for the state value.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Read the redirect's request line. `Ok(None)`: not the redirect (a
/// favicon request, say), keep waiting. Errors: Bas declined
/// (`unauthorized`), or a wrong/missing state (`invalid`).
fn parse_callback(request: &str, state: &str) -> Result<Option<String>, ApiError> {
    let line = request.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let (Some("GET"), Some(path)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    if !(path == "/" || path.starts_with("/?")) {
        return Ok(None);
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|_| ApiError::Invalid)?;
    let get = |k: &str| url.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
    if !get("state").is_some_and(|s| same(&s, state)) {
        return Err(ApiError::Invalid);
    }
    if get("error").is_some() {
        return Err(ApiError::Unauthorized);
    }
    match get("code") {
        Some(code) if !code.is_empty() && code.len() <= 512 => Ok(Some(code)),
        _ => Err(ApiError::Invalid),
    }
}

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>Nox</title><body style=\"font-family:sans-serif;padding:2rem\">\
<h1>Nox is connected to Google Calendar.</h1><p>You can close this tab. / Nox sudah terhubung. Tab ini boleh ditutup.</p>";
const PAGE_FAIL: &str = "<!doctype html><meta charset=utf-8><title>Nox</title><body style=\"font-family:sans-serif;padding:2rem\">\
<h1>Nox did not connect.</h1><p>Go back to Nox and try again. / Kembali ke Nox dan coba lagi.</p>";

async fn reply(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait on the loopback listener for the redirect with the right state.
async fn wait_for_code(listener: &TcpListener, state: &str, timeout: Duration) -> Result<String, ApiError> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let (mut stream, _) = tokio::time::timeout(left, listener.accept())
            .await
            .map_err(|_| ApiError::Timeout)?
            .map_err(|_| ApiError::Offline)?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        while len < buf.len() {
            let n = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[len..])).await {
                Ok(Ok(n)) => n,
                _ => 0,
            };
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buf[..len]).to_string();
        match parse_callback(&request, state) {
            Ok(Some(code)) => {
                reply(&mut stream, "200 OK", PAGE_OK).await;
                return Ok(code);
            }
            Ok(None) => reply(&mut stream, "404 Not Found", "").await,
            Err(e) => {
                reply(&mut stream, "400 Bad Request", PAGE_FAIL).await;
                return Err(e);
            }
        }
    }
}

// ── Token endpoint ──

#[derive(Debug, PartialEq)]
struct Tokens {
    access: String,
    expires_in: u64,
    refresh: Option<String>,
    scope: String,
}

async fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Value, ApiError> {
    let response = http::client().post(url).form(form).send().await?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(body);
    }
    // invalid_grant: the refresh token was revoked or expired (for an app
    // in Testing, after 7 days). Bas has to connect again.
    if status == 400 && body["error"].as_str() == Some("invalid_grant") {
        return Err(ApiError::Unauthorized);
    }
    if status == 400 || status == 401 {
        return Err(if body["error"].as_str() == Some("invalid_client") { ApiError::Invalid } else { ApiError::Unauthorized });
    }
    Err(http::from_status(status))
}

fn tokens_of(v: &Value) -> Result<Tokens, ApiError> {
    Ok(Tokens {
        access: v["access_token"].as_str().filter(|s| !s.is_empty()).ok_or(ApiError::BadResponse)?.to_string(),
        expires_in: v["expires_in"].as_u64().unwrap_or(3600),
        refresh: v["refresh_token"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        scope: v["scope"].as_str().unwrap_or("").to_string(),
    })
}

async fn exchange(ep: &Endpoints, c: &Client, code: &str, verifier: &str, redirect: &str) -> Result<Tokens, ApiError> {
    let v = post_form(
        &ep.token,
        &[
            ("client_id", &c.id),
            ("client_secret", &c.secret),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect),
        ],
    )
    .await?;
    tokens_of(&v)
}

async fn refresh(ep: &Endpoints, c: &Client, refresh_token: &str) -> Result<Tokens, ApiError> {
    let v = post_form(
        &ep.token,
        &[("client_id", &c.id), ("client_secret", &c.secret), ("grant_type", "refresh_token"), ("refresh_token", refresh_token)],
    )
    .await?;
    tokens_of(&v)
}

/// The access token, refreshed when it is (nearly) expired.
async fn access_token(ep: &Endpoints) -> Result<String, ApiError> {
    let mut cache = ACCESS.lock().await;
    if let Some((token, until)) = cache.as_ref() {
        if Instant::now() + EARLY < *until {
            return Ok(token.clone());
        }
    }
    let rt = secrets::get(secrets::GOOGLE_REFRESH_TOKEN).ok_or(ApiError::NoToken)?;
    let t = refresh(ep, &client()?, &rt).await?;
    if let Some(new_rt) = &t.refresh {
        // Google may rotate it; keep the newest.
        let _ = secrets::store(secrets::GOOGLE_REFRESH_TOKEN, new_rt);
    }
    *cache = Some((t.access.clone(), Instant::now() + Duration::from_secs(t.expires_in)));
    Ok(t.access)
}

async fn forget_access() {
    *ACCESS.lock().await = None;
}

// ── Calendar API ──

fn api_url(ep: &Endpoints, segments: &[&str], query: &[(&str, &str)]) -> Result<reqwest::Url, ApiError> {
    let mut url = reqwest::Url::parse(&ep.api).map_err(|_| ApiError::Invalid)?;
    url.path_segments_mut().map_err(|_| ApiError::Invalid)?.extend(segments);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// One request with one 429 retry. 401 is reported as `unauthorized` so the
/// caller can refresh the access token and try once more.
async fn send(token: &str, method: reqwest::Method, url: reqwest::Url, body: Option<&Value>) -> Result<Value, ApiError> {
    for attempt in 0..2 {
        let mut req = http::client().request(method.clone(), url.clone()).bearer_auth(token);
        if let Some(b) = body {
            req = req.json(b);
        }
        let response = req.send().await?;
        let status = response.status().as_u16();
        if status == 429 && attempt == 0 {
            tokio::time::sleep(http::retry_after(&response, 2)).await;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(http::from_status(status));
        }
        return response.json::<Value>().await.map_err(ApiError::from);
    }
    Err(ApiError::RateLimited)
}

/// A Google calendar Bas can see.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GCalendar {
    id: String,
    name: String,
    color: Option<String>,
    primary: bool,
    /// Owner or writer: events can be created there.
    can_write: bool,
}

async fn list_calendars(ep: &Endpoints, token: &str) -> Result<Vec<GCalendar>, ApiError> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut q: Vec<(&str, &str)> = vec![("maxResults", "250")];
        if let Some(p) = &page {
            q.push(("pageToken", p));
        }
        let v = send(token, reqwest::Method::GET, api_url(ep, &["users", "me", "calendarList"], &q)?, None).await?;
        for c in v["items"].as_array().ok_or(ApiError::BadResponse)? {
            let Some(id) = c["id"].as_str() else { continue };
            let role = c["accessRole"].as_str().unwrap_or("");
            out.push(GCalendar {
                id: id.to_string(),
                name: c["summaryOverride"].as_str().or(c["summary"].as_str()).unwrap_or(id).to_string(),
                color: c["backgroundColor"].as_str().map(str::to_string),
                primary: c["primary"].as_bool().unwrap_or(false),
                can_write: role == "owner" || role == "writer",
            });
        }
        match v["nextPageToken"].as_str() {
            Some(p) => page = Some(p.to_string()),
            None => break,
        }
    }
    Ok(out)
}

/// One event as Nox stores it. Timed: UTC "YYYY-MM-DD HH:MM:SS"; all-day:
/// dates with an exclusive end (Google's own convention).
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GEvent {
    google_id: String,
    cancelled: bool,
    title: String,
    start: String,
    end: String,
    all_day: bool,
    location: Option<String>,
    html_link: Option<String>,
    updated: Option<String>,
}

fn utc_stamp(rfc3339: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc).format("%Y-%m-%d %H:%M:%S").to_string())
}

fn valid_day(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn map_event(v: &Value) -> Option<GEvent> {
    let id = v["id"].as_str()?.to_string();
    let cancelled = v["status"].as_str() == Some("cancelled");
    let text = |k: &str| v[k].as_str().map(|s| s.chars().take(MAX_TITLE).collect::<String>());
    // A cancelled item in an incremental sync may carry only its id.
    let (start, end, all_day) = match (v["start"]["date"].as_str(), v["start"]["dateTime"].as_str()) {
        (Some(d), _) if valid_day(d) => {
            let e = v["end"]["date"].as_str().filter(|e| valid_day(e)).unwrap_or(d);
            (d.to_string(), e.to_string(), true)
        }
        (_, Some(dt)) => {
            let s = utc_stamp(dt)?;
            let e = v["end"]["dateTime"].as_str().and_then(utc_stamp).unwrap_or_else(|| s.clone());
            (s, e, false)
        }
        _ if cancelled => (String::new(), String::new(), false),
        _ => return None,
    };
    Some(GEvent {
        google_id: id,
        cancelled,
        title: text("summary").unwrap_or_default(),
        start,
        end,
        all_day,
        location: text("location").filter(|s| !s.trim().is_empty()),
        html_link: v["htmlLink"].as_str().filter(|l| l.starts_with("https://")).map(str::to_string),
        updated: v["updated"].as_str().map(str::to_string),
    })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// True: these are all events in the window (replace the local copy).
    /// False: only what changed since the sync token (cancelled = removed).
    full: bool,
    events: Vec<GEvent>,
    next_sync_token: Option<String>,
}

async fn list_pages(ep: &Endpoints, token: &str, calendar_id: &str, base: &[(&str, &str)]) -> Result<(Vec<GEvent>, Option<String>), ApiError> {
    let mut events = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut q = base.to_vec();
        if let Some(p) = &page {
            q.push(("pageToken", p));
        }
        let url = api_url(ep, &["calendars", calendar_id, "events"], &q)?;
        let v = send(token, reqwest::Method::GET, url, None).await?;
        events.extend(v["items"].as_array().ok_or(ApiError::BadResponse)?.iter().filter_map(map_event));
        match v["nextPageToken"].as_str() {
            Some(p) => page = Some(p.to_string()),
            None => return Ok((events, v["nextSyncToken"].as_str().map(str::to_string))),
        }
    }
    Ok((events, None))
}

/// Incremental with a sync token; a full list of the window without one, or
/// when Google answers 410 (the token expired): then `full` is true.
async fn sync_events(
    ep: &Endpoints,
    token: &str,
    calendar_id: &str,
    sync_token: Option<&str>,
    time_min: &str,
    time_max: &str,
) -> Result<SyncResult, ApiError> {
    // singleEvents must be the same on the full and the incremental requests.
    if let Some(st) = sync_token {
        match list_pages(ep, token, calendar_id, &[("singleEvents", "true"), ("maxResults", "250"), ("syncToken", st)]).await {
            Ok((events, next)) => return Ok(SyncResult { full: false, events, next_sync_token: next }),
            Err(ApiError::Http { status: 410 }) => {} // full resync below
            Err(e) => return Err(e),
        }
    }
    let (events, next) = list_pages(
        ep,
        token,
        calendar_id,
        &[("singleEvents", "true"), ("maxResults", "250"), ("timeMin", time_min), ("timeMax", time_max), ("showDeleted", "false")],
    )
    .await?;
    Ok(SyncResult { full: true, events: events.into_iter().filter(|e| !e.cancelled).collect(), next_sync_token: next })
}

/// The one write: a new event with a title, start, end and optional
/// location. Nothing else is sent.
async fn create_event(ep: &Endpoints, token: &str, calendar_id: &str, ev: &NewEvent) -> Result<GEvent, ApiError> {
    let (start, end) = if ev.all_day {
        (json!({ "date": ev.start }), json!({ "date": ev.end }))
    } else {
        (json!({ "dateTime": ev.start }), json!({ "dateTime": ev.end }))
    };
    let mut body = json!({ "summary": ev.title, "start": start, "end": end });
    if let Some(l) = ev.location.as_deref().filter(|l| !l.trim().is_empty()) {
        body["location"] = json!(l);
    }
    let url = api_url(ep, &["calendars", calendar_id, "events"], &[])?;
    let v = send(token, reqwest::Method::POST, url, Some(&body)).await?;
    map_event(&v).ok_or(ApiError::BadResponse)
}

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    title: String,
    /// All-day: "YYYY-MM-DD"; timed: RFC 3339 with offset.
    start: String,
    /// All-day: exclusive end date; timed: RFC 3339.
    end: String,
    all_day: bool,
    location: Option<String>,
}

fn check_new(ev: &NewEvent) -> Result<(), ApiError> {
    let title = ev.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE || ev.location.as_ref().is_some_and(|l| l.chars().count() > MAX_TITLE) {
        return Err(ApiError::Invalid);
    }
    let ordered = if ev.all_day {
        valid_day(&ev.start) && valid_day(&ev.end) && ev.start < ev.end
    } else {
        match (chrono::DateTime::parse_from_rfc3339(&ev.start), chrono::DateTime::parse_from_rfc3339(&ev.end)) {
            (Ok(s), Ok(e)) => s < e,
            _ => false,
        }
    };
    if ordered { Ok(()) } else { Err(ApiError::Invalid) }
}

/// A calendar id goes into the URL path (encoded); keep it sane anyway.
fn check_calendar_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty() || id.len() > 255 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        Err(ApiError::Invalid)
    } else {
        Ok(())
    }
}

/// Run `f` with an access token; on 401 drop the cached token, refresh, and
/// try once more.
async fn with_token<T, F, Fut>(f: F) -> Result<T, ApiError>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, ApiError>>,
{
    let ep = live();
    let token = access_token(&ep).await?;
    match f(token).await {
        Err(ApiError::Unauthorized) => {
            forget_access().await;
            f(access_token(&ep).await?).await
        }
        r => r,
    }
}

// ── Commands ──

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    has_client: bool,
    connected: bool,
}

/// Saved or not, never the values.
#[tauri::command]
pub fn google_status() -> GoogleStatus {
    GoogleStatus {
        has_client: secrets::get(secrets::GOOGLE_CLIENT_ID).is_some() && secrets::get(secrets::GOOGLE_CLIENT_SECRET).is_some(),
        connected: secrets::get(secrets::GOOGLE_REFRESH_TOKEN).is_some(),
    }
}

fn plain(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && v.chars().all(|c| c.is_ascii_graphic())
}

/// Store the OAuth client (write-only).
#[tauri::command]
pub fn google_set_client(client_id: String, client_secret: String) -> Result<(), ApiError> {
    let (id, secret) = (client_id.trim(), client_secret.trim());
    if !plain(id, 200) || !id.ends_with(".apps.googleusercontent.com") || !plain(secret, 200) {
        return Err(ApiError::Invalid);
    }
    secrets::store(secrets::GOOGLE_CLIENT_ID, id).map_err(|_| ApiError::Invalid)?;
    secrets::store(secrets::GOOGLE_CLIENT_SECRET, secret).map_err(|_| ApiError::Invalid)
}

/// Forget the OAuth client (the token, if any, is disconnected first).
#[tauri::command]
pub async fn google_clear_client() -> Result<(), ApiError> {
    google_disconnect().await?;
    secrets::forget(secrets::GOOGLE_CLIENT_ID).map_err(|_| ApiError::Invalid)?;
    secrets::forget(secrets::GOOGLE_CLIENT_SECRET).map_err(|_| ApiError::Invalid)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    /// Bas allowed `calendar.events` (creating events) too.
    can_create: bool,
}

/// Open the browser, wait for the redirect, store the refresh token.
#[tauri::command]
pub async fn google_connect() -> Result<Connected, ApiError> {
    if LOGIN_RUNNING.swap(true, Ordering::SeqCst) {
        return Err(ApiError::Invalid);
    }
    let r = connect_inner().await;
    LOGIN_RUNNING.store(false, Ordering::SeqCst);
    r
}

async fn connect_inner() -> Result<Connected, ApiError> {
    let c = client()?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| ApiError::Offline)?;
    let port = listener.local_addr().map_err(|_| ApiError::Offline)?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = new_verifier()?;
    let state = random_b64(24)?;
    let url = auth_url(&c.id, &redirect, &challenge(&verifier), &state)?;
    // The system browser, without a shell (the URL contains '&').
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn()
        .map_err(|_| ApiError::Invalid)?;
    let code = wait_for_code(&listener, &state, LOGIN_TIMEOUT).await?;
    drop(listener);
    let t = exchange(&live(), &c, &code, &verifier, &redirect).await?;
    finish_connect(t).await
}

async fn finish_connect(t: Tokens) -> Result<Connected, ApiError> {
    let scopes: Vec<&str> = t.scope.split_whitespace().collect();
    // Reading is the point; without it there is nothing to keep.
    if !scopes.contains(&SCOPE_READ) && !scopes.contains(&SCOPE_EVENTS) {
        return Err(ApiError::Unauthorized);
    }
    let rt = t.refresh.ok_or(ApiError::BadResponse)?;
    secrets::store(secrets::GOOGLE_REFRESH_TOKEN, &rt).map_err(|_| ApiError::Invalid)?;
    *ACCESS.lock().await = Some((t.access, Instant::now() + Duration::from_secs(t.expires_in)));
    Ok(Connected { can_create: scopes.contains(&SCOPE_EVENTS) })
}

async fn revoke(ep: &Endpoints, token: &str) -> Result<(), ApiError> {
    post_form(&ep.revoke, &[("token", token)]).await.map(|_| ())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Disconnected {
    /// Google confirmed the revoke (false when offline; the local token is
    /// deleted either way, and Google drops it after 6 months unused).
    revoked: bool,
}

/// Revoke the token with Google, then delete it here.
#[tauri::command]
pub async fn google_disconnect() -> Result<Disconnected, ApiError> {
    let mut revoked = false;
    if let Some(rt) = secrets::get(secrets::GOOGLE_REFRESH_TOKEN) {
        revoked = revoke(&live(), &rt).await.is_ok();
    }
    forget_access().await;
    secrets::forget(secrets::GOOGLE_REFRESH_TOKEN).map_err(|_| ApiError::Invalid)?;
    Ok(Disconnected { revoked })
}

#[tauri::command]
pub async fn google_calendars() -> Result<Vec<GCalendar>, ApiError> {
    with_token(|t| async move { list_calendars(&live(), &t).await }).await
}

#[tauri::command]
pub async fn google_sync_events(calendar_id: String, sync_token: Option<String>, time_min: String, time_max: String) -> Result<SyncResult, ApiError> {
    check_calendar_id(&calendar_id)?;
    for t in [&time_min, &time_max] {
        chrono::DateTime::parse_from_rfc3339(t).map_err(|_| ApiError::Invalid)?;
    }
    if sync_token.as_ref().is_some_and(|s| !plain(s, 1024)) {
        return Err(ApiError::Invalid);
    }
    with_token(|t| {
        let (cal, st, min, max) = (calendar_id.clone(), sync_token.clone(), time_min.clone(), time_max.clone());
        async move { sync_events(&live(), &t, &cal, st.as_deref(), &min, &max).await }
    })
    .await
}

/// Create an event (after Bas confirmed it in Nox). Nothing else is written.
#[tauri::command]
pub async fn google_create_event(calendar_id: String, event: NewEvent) -> Result<GEvent, ApiError> {
    check_calendar_id(&calendar_id)?;
    check_new(&event)?;
    let event = NewEvent { title: event.title.trim().to_string(), ..event };
    // Not retried on 401 after a send: only the token fetch can be retried
    // safely, so a create is never sent twice.
    let ep = live();
    let token = access_token(&ep).await?;
    create_event(&ep, &token, &calendar_id, &event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener as StdListener;
    use std::sync::{Arc, Mutex as StdMutex};

    type Log = Arc<StdMutex<Vec<String>>>;

    /// A tiny HTTP server: the first route whose "METHOD /path" prefix
    /// matches answers (each route is used once when `once` is set); every
    /// request is logged as "METHOD /path?query BODY".
    fn mock(routes: Vec<(&'static str, u16, String)>) -> (String, Log) {
        let listener = StdListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log: Log = Arc::new(StdMutex::new(Vec::new()));
        let seen = log.clone();
        let routes = Arc::new(StdMutex::new(routes));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
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
                seen.lock().unwrap().push(format!("{key} {}", text.get(head_end..).unwrap_or("")));
                let mut routes = routes.lock().unwrap();
                // A route listed twice answers in order: the first is used up.
                let found = routes.iter().position(|(p, _, _)| key.starts_with(p));
                let (status, reply) = match found {
                    Some(i) => {
                        let (p, s, b) = routes[i].clone();
                        if routes.iter().filter(|(q, _, _)| *q == p).count() > 1 {
                            routes.remove(i);
                        }
                        (s, b)
                    }
                    None => (404, "{}".into()),
                };
                let resp = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (base, log)
    }

    fn ep(base: &str) -> Endpoints {
        Endpoints { token: format!("{base}/token"), revoke: format!("{base}/revoke"), api: format!("{base}/calendar/v3") }
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn client() -> Client {
        Client { id: "id.apps.googleusercontent.com".into(), secret: "s3cret".into() }
    }

    #[test]
    fn pkce_matches_the_rfc_7636_example_and_verifiers_are_valid() {
        // RFC 7636, Appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let a = new_verifier().unwrap();
        let b = new_verifier().unwrap();
        assert_ne!(a, b);
        assert!((43..=128).contains(&a.len()));
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
    }

    #[test]
    fn the_consent_url_asks_for_the_two_calendar_scopes_with_s256() {
        let url = auth_url("id.apps.googleusercontent.com", "http://127.0.0.1:5555", "CH", "ST").unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], format!("{SCOPE_READ} {SCOPE_EVENTS}"));
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "CH");
        assert_eq!(q["state"], "ST");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
        assert_eq!(q["access_type"], "offline");
        assert!(url.as_str().starts_with(AUTH_URL));
    }

    #[test]
    fn the_redirect_needs_the_right_state() {
        assert_eq!(parse_callback("GET /?state=abc&code=4%2Fxyz HTTP/1.1\r\n", "abc"), Ok(Some("4/xyz".into())));
        assert_eq!(parse_callback("GET /?state=evil&code=x HTTP/1.1\r\n", "abc"), Err(ApiError::Invalid));
        assert_eq!(parse_callback("GET /?code=x HTTP/1.1\r\n", "abc"), Err(ApiError::Invalid));
        assert_eq!(parse_callback("GET /?state=abc&error=access_denied HTTP/1.1\r\n", "abc"), Err(ApiError::Unauthorized));
        // Not the redirect: keep waiting.
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n", "abc"), Ok(None));
        assert_eq!(parse_callback("POST /?state=abc&code=x HTTP/1.1\r\n", "abc"), Ok(None));
    }

    #[test]
    fn the_loopback_listener_skips_other_requests_and_rejects_a_wrong_state() {
        run(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            std::thread::spawn(move || {
                for req in ["GET /favicon.ico HTTP/1.1\r\n\r\n", "GET /?state=good&code=abc HTTP/1.1\r\n\r\n"] {
                    let mut s = std::net::TcpStream::connect(addr).unwrap();
                    s.write_all(req.as_bytes()).unwrap();
                    let mut out = String::new();
                    let _ = s.read_to_string(&mut out);
                }
            });
            assert_eq!(wait_for_code(&listener, "good", Duration::from_secs(10)).await, Ok("abc".into()));

            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            std::thread::spawn(move || {
                let mut s = std::net::TcpStream::connect(addr).unwrap();
                s.write_all(b"GET /?state=forged&code=abc HTTP/1.1\r\n\r\n").unwrap();
                let mut out = String::new();
                let _ = s.read_to_string(&mut out);
            });
            assert_eq!(wait_for_code(&listener, "good", Duration::from_secs(10)).await, Err(ApiError::Invalid));

            // Nobody comes back: a timeout, not a hang.
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            assert_eq!(wait_for_code(&listener, "good", Duration::from_millis(200)).await, Err(ApiError::Timeout));
        });
    }

    #[test]
    fn exchanges_the_code_with_the_verifier() {
        let (base, log) = mock(vec![(
            "POST /token",
            200,
            json!({ "access_token": "at", "expires_in": 3599, "refresh_token": "rt", "scope": format!("{SCOPE_READ} {SCOPE_EVENTS}") }).to_string(),
        )]);
        let t = run(exchange(&ep(&base), &client(), "the-code", "the-verifier", "http://127.0.0.1:1")).unwrap();
        assert_eq!(t, Tokens { access: "at".into(), expires_in: 3599, refresh: Some("rt".into()), scope: format!("{SCOPE_READ} {SCOPE_EVENTS}") });
        let body = log.lock().unwrap()[0].clone();
        for part in ["grant_type=authorization_code", "code=the-code", "code_verifier=the-verifier", "redirect_uri=http%3A%2F%2F127.0.0.1%3A1"] {
            assert!(body.contains(part), "{part} in {body}");
        }
    }

    #[test]
    fn refreshes_and_maps_a_revoked_or_expired_refresh_token() {
        let (base, log) = mock(vec![("POST /token", 200, json!({ "access_token": "new", "expires_in": 3600 }).to_string())]);
        let t = run(refresh(&ep(&base), &client(), "rt")).unwrap();
        assert_eq!(t.access, "new");
        assert_eq!(t.refresh, None);
        assert!(log.lock().unwrap()[0].contains("grant_type=refresh_token"));

        let (base, _) = mock(vec![("POST /token", 400, json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }).to_string())]);
        assert_eq!(run(refresh(&ep(&base), &client(), "rt")), Err(ApiError::Unauthorized));
        let (base, _) = mock(vec![("POST /token", 401, json!({ "error": "invalid_client" }).to_string())]);
        assert_eq!(run(refresh(&ep(&base), &client(), "rt")), Err(ApiError::Invalid));
        let (base, _) = mock(vec![("POST /token", 200, json!({ "token_type": "Bearer" }).to_string())]);
        assert_eq!(run(refresh(&ep(&base), &client(), "rt")), Err(ApiError::BadResponse));
    }

    #[test]
    fn revoke_posts_the_token() {
        let (base, log) = mock(vec![("POST /revoke", 200, "{}".into())]);
        run(revoke(&ep(&base), "rt")).unwrap();
        assert!(log.lock().unwrap()[0].contains("token=rt"));
        let (base, _) = mock(vec![("POST /revoke", 400, json!({ "error": "invalid_token" }).to_string())]);
        assert!(run(revoke(&ep(&base), "rt")).is_err());
    }

    fn timed(id: &str, summary: &str, start: &str, end: &str) -> Value {
        json!({ "id": id, "status": "confirmed", "summary": summary, "start": { "dateTime": start }, "end": { "dateTime": end },
                "htmlLink": format!("https://www.google.com/calendar/event?eid={id}"), "updated": "2026-11-04T01:00:00.000Z" })
    }

    #[test]
    fn maps_timed_all_day_and_cancelled_events() {
        let e = map_event(&timed("a", "Jarkom", "2026-11-06T08:00:00+07:00", "2026-11-06T10:00:00+07:00")).unwrap();
        assert_eq!((e.start.as_str(), e.end.as_str(), e.all_day), ("2026-11-06 01:00:00", "2026-11-06 03:00:00", false));
        assert_eq!(e.html_link.as_deref(), Some("https://www.google.com/calendar/event?eid=a"));
        let d = map_event(&json!({ "id": "b", "summary": "Libur", "start": { "date": "2026-11-10" }, "end": { "date": "2026-11-11" } })).unwrap();
        assert_eq!((d.start.as_str(), d.end.as_str(), d.all_day), ("2026-11-10", "2026-11-11", true));
        let c = map_event(&json!({ "id": "c", "status": "cancelled" })).unwrap();
        assert!(c.cancelled);
        assert_eq!(map_event(&json!({ "id": "d", "start": {} })), None);
    }

    #[test]
    fn a_full_sync_lists_the_window_with_single_events() {
        let page1 = json!({ "items": [timed("a", "A", "2026-11-06T08:00:00Z", "2026-11-06T09:00:00Z")], "nextPageToken": "p2" });
        let page2 = json!({ "items": [timed("b", "B", "2026-11-07T08:00:00Z", "2026-11-07T09:00:00Z")], "nextSyncToken": "sync1" });
        let (base, log) = mock(vec![
            ("GET /calendar/v3/calendars/primary/events", 200, page1.to_string()),
            ("GET /calendar/v3/calendars/primary/events", 200, page2.to_string()),
        ]);
        let r = run(sync_events(&ep(&base), "at", "primary", None, "2026-11-03T00:00:00Z", "2026-12-04T00:00:00Z")).unwrap();
        assert!(r.full);
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.next_sync_token.as_deref(), Some("sync1"));
        let log = log.lock().unwrap();
        assert!(log[0].contains("singleEvents=true") && log[0].contains("timeMin=2026-11-03T00%3A00%3A00Z"));
        assert!(log[1].contains("pageToken=p2"));
    }

    #[test]
    fn an_incremental_sync_sends_only_the_token_and_keeps_cancellations() {
        let changed = json!({ "items": [{ "id": "a", "status": "cancelled" }], "nextSyncToken": "sync2" });
        let (base, log) = mock(vec![("GET /calendar/v3/calendars/primary/events", 200, changed.to_string())]);
        let r = run(sync_events(&ep(&base), "at", "primary", Some("sync1"), "2026-11-03T00:00:00Z", "2026-12-04T00:00:00Z")).unwrap();
        assert!(!r.full);
        assert!(r.events[0].cancelled);
        assert_eq!(r.next_sync_token.as_deref(), Some("sync2"));
        let first = log.lock().unwrap()[0].clone();
        assert!(first.contains("syncToken=sync1") && !first.contains("timeMin"));
    }

    #[test]
    fn a_410_on_the_sync_token_falls_back_to_a_full_resync() {
        let full = json!({ "items": [timed("a", "A", "2026-11-06T08:00:00Z", "2026-11-06T09:00:00Z")], "nextSyncToken": "fresh" });
        let (base, log) = mock(vec![
            ("GET /calendar/v3/calendars/primary/events", 410, json!({ "error": { "code": 410 } }).to_string()),
            ("GET /calendar/v3/calendars/primary/events", 200, full.to_string()),
        ]);
        let r = run(sync_events(&ep(&base), "at", "primary", Some("old"), "2026-11-03T00:00:00Z", "2026-12-04T00:00:00Z")).unwrap();
        assert!(r.full);
        assert_eq!(r.next_sync_token.as_deref(), Some("fresh"));
        let log = log.lock().unwrap();
        assert!(log[0].contains("syncToken=old"));
        assert!(log[1].contains("timeMin=") && !log[1].contains("syncToken"));
    }

    #[test]
    fn a_calendar_id_is_encoded_in_the_path() {
        let url = api_url(&ep("http://x"), &["calendars", "id#holiday@group.v.calendar.google.com", "events"], &[]).unwrap();
        assert_eq!(url.path(), "/calendar/v3/calendars/id%23holiday@group.v.calendar.google.com/events");
        assert!(check_calendar_id("primary").is_ok());
        assert!(check_calendar_id("a b").is_err());
        assert!(check_calendar_id("").is_err());
    }

    fn new_event(all_day: bool) -> NewEvent {
        if all_day {
            NewEvent { title: "Libur".into(), start: "2026-11-10".into(), end: "2026-11-11".into(), all_day: true, location: None }
        } else {
            NewEvent {
                title: "rapat himatif".into(),
                start: "2026-11-06T14:00:00+07:00".into(),
                end: "2026-11-06T15:30:00+07:00".into(),
                all_day: false,
                location: Some("sekre".into()),
            }
        }
    }

    #[test]
    fn creates_an_event_with_only_title_time_and_location() {
        let created = json!({ "id": "new1", "summary": "rapat himatif", "start": { "dateTime": "2026-11-06T14:00:00+07:00" },
                              "end": { "dateTime": "2026-11-06T15:30:00+07:00" }, "location": "sekre",
                              "htmlLink": "https://www.google.com/calendar/event?eid=new1" });
        let (base, log) = mock(vec![("POST /calendar/v3/calendars/primary/events", 200, created.to_string())]);
        let e = run(create_event(&ep(&base), "at", "primary", &new_event(false))).unwrap();
        assert_eq!(e.html_link.as_deref(), Some("https://www.google.com/calendar/event?eid=new1"));
        let entry = log.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_str(entry.splitn(3, ' ').nth(2).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({ "summary": "rapat himatif", "location": "sekre",
                    "start": { "dateTime": "2026-11-06T14:00:00+07:00" }, "end": { "dateTime": "2026-11-06T15:30:00+07:00" } })
        );
    }

    #[test]
    fn checks_a_new_event_before_sending() {
        assert!(check_new(&new_event(false)).is_ok());
        assert!(check_new(&new_event(true)).is_ok());
        let mut e = new_event(false);
        e.end = "2026-11-06T13:00:00+07:00".into();
        assert_eq!(check_new(&e), Err(ApiError::Invalid), "end before start");
        let mut e = new_event(true);
        e.end = e.start.clone();
        assert_eq!(check_new(&e), Err(ApiError::Invalid));
        let mut e = new_event(false);
        e.title = "   ".into();
        assert_eq!(check_new(&e), Err(ApiError::Invalid));
        let mut e = new_event(false);
        e.start = "jumat 14:00".into();
        assert_eq!(check_new(&e), Err(ApiError::Invalid));
    }

    #[test]
    fn keeps_only_the_granted_scopes_and_needs_a_refresh_token() {
        run(async {
            let t = Tokens { access: "a".into(), expires_in: 10, refresh: None, scope: SCOPE_READ.into() };
            assert_eq!(finish_connect(t).await.err(), Some(ApiError::BadResponse));
            let t = Tokens { access: "a".into(), expires_in: 10, refresh: Some("r".into()), scope: "openid email".into() };
            assert_eq!(finish_connect(t).await.err(), Some(ApiError::Unauthorized));
        });
    }

    #[test]
    fn client_ids_are_checked() {
        assert_eq!(google_set_client("not-a-client".into(), "x".into()), Err(ApiError::Invalid));
        assert_eq!(google_set_client("1.apps.googleusercontent.com".into(), "has space".into()), Err(ApiError::Invalid));
    }
}
