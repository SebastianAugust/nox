//! The shared HTTP client for outside services (Notion, Open-Meteo, Telegram)
//! and the one error type they report to the frontend.
//!
//! Errors carry a kind and at most a status code, never a URL, header or body:
//! a Telegram URL contains the bot token, so reqwest errors are stripped of
//! their URL before anything else sees them, and nothing here is logged.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

pub const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = concat!("Nox/", env!("CARGO_PKG_VERSION"));

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(USER_AGENT)
            .build()
            // The builder only fails on a broken TLS backend; fall back to
            // defaults rather than panic (requests then fail and say so).
            .unwrap_or_default()
    })
}

/// What went wrong, in words the UI can turn into a short message.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiError {
    /// No token saved for this service.
    NoToken,
    /// 401/403: the token is wrong, revoked or lacks access.
    Unauthorized,
    /// 404: the database, chat or place does not exist (or is not shared).
    NotFound,
    /// 429 that did not clear after retrying.
    RateLimited,
    /// No connection at all.
    Offline,
    Timeout,
    /// Any other non-2xx status.
    Http { status: u16 },
    /// The answer was not what we expected.
    BadResponse,
    /// The input was rejected before any request was made.
    Invalid,
    /// Telegram: no chat has been paired yet.
    NotPaired,
    /// The answer was bigger than allowed (a calendar feed over 5 MB).
    TooLarge,
    /// Notion: the "Notion writes" setting is off, so nothing was sent.
    WritesOff,
    /// Notion: 403 on a write; the integration lacks Update/Insert content.
    ReadOnly,
}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        let e = e.without_url();
        if e.is_timeout() {
            ApiError::Timeout
        } else if e.is_connect() || e.is_request() {
            ApiError::Offline
        } else if e.is_decode() || e.is_body() {
            ApiError::BadResponse
        } else if let Some(status) = e.status() {
            from_status(status.as_u16())
        } else {
            ApiError::Offline
        }
    }
}

pub fn from_status(status: u16) -> ApiError {
    match status {
        401 | 403 => ApiError::Unauthorized,
        404 => ApiError::NotFound,
        429 => ApiError::RateLimited,
        _ => ApiError::Http { status },
    }
}

/// Seconds to wait from a Retry-After header (seconds form), capped.
pub fn retry_after(response: &reqwest::Response, fallback: u64) -> Duration {
    let secs = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback);
    Duration::from_secs(secs.clamp(1, 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_statuses() {
        assert_eq!(from_status(401), ApiError::Unauthorized);
        assert_eq!(from_status(403), ApiError::Unauthorized);
        assert_eq!(from_status(429), ApiError::RateLimited);
        assert_eq!(from_status(500), ApiError::Http { status: 500 });
    }

    #[test]
    fn serializes_without_details() {
        let json = serde_json::to_string(&ApiError::Http { status: 502 }).unwrap();
        assert_eq!(json, r#"{"kind":"http","status":502}"#);
        assert_eq!(serde_json::to_string(&ApiError::NoToken).unwrap(), r#"{"kind":"noToken"}"#);
    }
}
