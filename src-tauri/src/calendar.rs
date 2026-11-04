//! Calendar feeds (ICS / "secret address in iCal format"), read-only.
//!
//! A feed URL grants read access to a calendar, so it is a secret: it lives in
//! Credential Manager as `calendar_feed_<id>`, is only ever read here, and is
//! never returned, logged or put in an error. Fetching is https only (a
//! redirect to anything else is refused), 15 s, at most 5 MB.
//!
//! Parsing and expansion: `icalendar` reads the file, `rrule` expands RRULE
//! within the window, EXDATE removes dates, a RECURRENCE-ID entry replaces
//! (or, when CANCELLED, removes) one occurrence, CANCELLED events are left
//! out, all-day events stay dates. Time zones: TZID by IANA name (what Google
//! and most feeds use); anything else, and floating times, use the fallback
//! zone (the timezone setting, default Asia/Jakarta). A broken file or event
//! is an error or a skipped event, never a crash.

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::Duration;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use icalendar::parser::{read_calendar, unfold, Component};
use serde::Serialize;

use crate::http::ApiError;
use crate::secrets;

const MAX_BODY: usize = 5 * 1024 * 1024;
const MAX_URL: usize = 2048;
const MAX_OCCURRENCES: u16 = 500;
pub const FALLBACK_TZ: chrono_tz::Tz = chrono_tz::Asia::Jakarta;

/// One event occurrence. Timed: UTC "YYYY-MM-DD HH:MM:SS"; all-day: dates
/// ("end" is exclusive, as in ICS).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub uid: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum When {
    Date(NaiveDate),
    Time(DateTime<Utc>),
}

impl When {
    fn utc(self, tz: chrono_tz::Tz) -> DateTime<Utc> {
        match self {
            When::Time(t) => t,
            When::Date(d) => local(tz, d.and_hms_opt(0, 0, 0).unwrap_or_default()),
        }
    }
}

fn local(tz: chrono_tz::Tz, naive: NaiveDateTime) -> DateTime<Utc> {
    // A DST gap has no such local time; take the earliest valid reading.
    tz.from_local_datetime(&naive)
        .earliest()
        .unwrap_or_else(|| Utc.from_utc_datetime(&naive).with_timezone(&tz))
        .with_timezone(&Utc)
}

fn param<'a>(c: &'a Component, prop: &str, key: &str) -> Option<String> {
    let p = c.find_prop(prop)?;
    p.params
        .iter()
        .find(|x| x.key.as_str().eq_ignore_ascii_case(key))
        .and_then(|x| x.val.as_ref())
        .map(|v| v.as_str().trim_matches('"').to_string())
}

fn value(c: &Component, prop: &str) -> Option<String> {
    c.find_prop(prop).map(|p| p.val.as_str().trim().to_string())
}

fn text(c: &Component, prop: &str) -> Option<String> {
    c.find_prop(prop)
        .map(|p| p.val.clone().unescape_text().as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// An IANA zone from a TZID ("Asia/Jakarta", "/mozilla.org/.../Europe/Berlin").
fn zone(tzid: Option<&str>, fallback: chrono_tz::Tz) -> chrono_tz::Tz {
    let Some(id) = tzid else { return fallback };
    if let Ok(tz) = chrono_tz::Tz::from_str(id) {
        return tz;
    }
    // Try the trailing "Area/City" of a prefixed id.
    let parts: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        if let Ok(tz) = chrono_tz::Tz::from_str(&parts[parts.len() - 2..].join("/")) {
            return tz;
        }
    }
    fallback
}

/// One DATE / DATE-TIME value with its parameters.
fn parse_when(raw: &str, value_type: Option<&str>, tzid: Option<&str>, fallback: chrono_tz::Tz) -> Option<When> {
    let raw = raw.trim();
    if value_type.is_some_and(|v| v.eq_ignore_ascii_case("DATE")) || raw.len() == 8 {
        return NaiveDate::parse_from_str(&raw[..8.min(raw.len())], "%Y%m%d").ok().map(When::Date);
    }
    if let Some(utc) = raw.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some(When::Time(Utc.from_utc_datetime(&naive)));
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M"))
        .ok()?;
    Some(When::Time(local(zone(tzid, fallback), naive)))
}

fn when_of(c: &Component, prop: &str, fallback: chrono_tz::Tz) -> Option<When> {
    let raw = value(c, prop)?;
    parse_when(&raw, param(c, prop, "VALUE").as_deref(), param(c, prop, "TZID").as_deref(), fallback)
}

/// ISO 8601 durations as used in ICS: P1D, PT1H30M, P1W, -PT15M.
fn parse_duration(raw: &str) -> Option<chrono::Duration> {
    let s = raw.trim();
    let (neg, s) = s.strip_prefix('-').map(|r| (true, r)).unwrap_or((false, s.strip_prefix('+').unwrap_or(s)));
    let s = s.strip_prefix('P')?;
    let mut total = chrono::Duration::zero();
    let mut num = String::new();
    let mut in_time = false;
    for ch in s.chars() {
        match ch {
            'T' => in_time = true,
            '0'..='9' => num.push(ch),
            unit => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (unit, in_time) {
                    ('W', _) => chrono::Duration::weeks(n),
                    ('D', _) => chrono::Duration::days(n),
                    ('H', true) => chrono::Duration::hours(n),
                    ('M', true) => chrono::Duration::minutes(n),
                    ('S', true) => chrono::Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(if neg { -total } else { total })
}

fn fmt_time(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

struct Raw<'a> {
    c: &'a Component<'a>,
    uid: String,
    start: When,
    length: chrono::Duration,
    cancelled: bool,
}

fn raw_event<'a>(c: &'a Component<'a>, index: usize, fallback: chrono_tz::Tz) -> Option<Raw<'a>> {
    let start = when_of(c, "DTSTART", fallback)?;
    let end = when_of(c, "DTEND", fallback);
    let length = match (start, end) {
        (When::Date(a), Some(When::Date(b))) if b > a => b - a,
        (When::Time(a), Some(When::Time(b))) if b >= a => b - a,
        _ => value(c, "DURATION")
            .and_then(|d| parse_duration(&d))
            .filter(|d| *d >= chrono::Duration::zero())
            .unwrap_or_else(|| match start {
                When::Date(_) => chrono::Duration::days(1),
                When::Time(_) => chrono::Duration::zero(),
            }),
    };
    Some(Raw {
        c,
        uid: value(c, "UID").filter(|u| !u.is_empty()).unwrap_or_else(|| format!("no-uid-{index}")),
        start,
        length,
        cancelled: value(c, "STATUS").is_some_and(|s| s.eq_ignore_ascii_case("CANCELLED")),
    })
}

fn occurrence(r: &Raw, start: When) -> CalEvent {
    let (s, e, all_day) = match start {
        When::Date(d) => {
            let end = d + r.length.max(chrono::Duration::days(1));
            (d.format("%Y-%m-%d").to_string(), end.format("%Y-%m-%d").to_string(), true)
        }
        When::Time(t) => (fmt_time(t), fmt_time(t + r.length), false),
    };
    CalEvent {
        uid: r.uid.clone(),
        start: s,
        end: e,
        all_day,
        title: text(r.c, "SUMMARY").unwrap_or_else(|| "(no title)".into()),
        location: text(r.c, "LOCATION"),
    }
}

/// Every start of a master event within [from, to): its RRULE expanded and
/// EXDATEs removed, or just DTSTART.
fn starts(r: &Raw, from: DateTime<Utc>, to: DateTime<Utc>, fallback: chrono_tz::Tz) -> Vec<When> {
    let Some(rule) = value(r.c, "RRULE") else { return vec![r.start] };
    let tz_of_start = zone(param(r.c, "DTSTART", "TZID").as_deref(), fallback);
    let dt_start = match r.start {
        When::Time(t) => t.with_timezone(&tz_of_start),
        When::Date(d) => match tz_of_start.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default()).earliest() {
            Some(t) => t,
            None => return vec![r.start],
        },
    };
    let rtz: rrule::Tz = tz_of_start.into();
    let dt_start = dt_start.with_timezone(&rtz);
    let set = rrule::RRule::from_str(&rule).ok().and_then(|rr| rr.build(dt_start).ok());
    // A rule the expander cannot read still shows its first occurrence.
    let Some(mut set) = set else { return vec![r.start] };

    for p in r.c.properties.iter().filter(|p| p.name.as_str().eq_ignore_ascii_case("EXDATE")) {
        let vt = p.params.iter().find(|x| x.key.as_str().eq_ignore_ascii_case("VALUE")).and_then(|x| x.val.as_ref()).map(|v| v.as_str().to_string());
        let tzid = p.params.iter().find(|x| x.key.as_str().eq_ignore_ascii_case("TZID")).and_then(|x| x.val.as_ref()).map(|v| v.as_str().trim_matches('"').to_string());
        for one in p.val.as_str().split(',') {
            if let Some(w) = parse_when(one, vt.as_deref(), tzid.as_deref(), tz_of_start) {
                set = set.exdate(w.utc(tz_of_start).with_timezone(&rtz));
            }
        }
    }

    let span = r.length.max(chrono::Duration::zero());
    let after = (from - span - chrono::Duration::seconds(1)).with_timezone(&rtz);
    let before = to.with_timezone(&rtz);
    set.after(after)
        .before(before)
        .all(MAX_OCCURRENCES)
        .dates
        .into_iter()
        .map(|d| match r.start {
            When::Date(_) => When::Date(d.date_naive()),
            When::Time(_) => When::Time(d.with_timezone(&Utc)),
        })
        .collect()
}

fn overlaps(r: &Raw, start: When, from: DateTime<Utc>, to: DateTime<Utc>, fallback: chrono_tz::Tz) -> bool {
    let s = start.utc(fallback);
    let e = s + r.length.max(match start {
        When::Date(_) => chrono::Duration::days(1),
        When::Time(_) => chrono::Duration::zero(),
    });
    s < to && (e > from || (e == s && s >= from))
}

/// Parse an ICS file and list event occurrences overlapping [from, to).
pub fn expand(ics: &str, from: DateTime<Utc>, to: DateTime<Utc>, fallback: chrono_tz::Tz) -> Result<Vec<CalEvent>, String> {
    let unfolded = unfold(ics);
    let cal = read_calendar(&unfolded)?;
    let events: Vec<&Component> = cal.components.iter().filter(|c| c.name.as_str().eq_ignore_ascii_case("VEVENT")).collect();

    let mut masters: Vec<Raw> = Vec::new();
    // uid → (recurrence-id instant in UTC → replacement, or None when cancelled)
    let mut overrides: HashMap<String, Vec<(DateTime<Utc>, Option<Raw>)>> = HashMap::new();
    for (i, c) in events.into_iter().enumerate() {
        let Some(r) = raw_event(c, i, fallback) else { continue }; // no usable DTSTART: skip
        if let Some(rid) = when_of(c, "RECURRENCE-ID", fallback) {
            let key = rid.utc(fallback);
            let replacement = if r.cancelled { None } else { Some(r) };
            let uid = replacement.as_ref().map(|x| x.uid.clone()).unwrap_or_else(|| value(c, "UID").unwrap_or_default());
            overrides.entry(uid).or_default().push((key, replacement));
        } else if !r.cancelled {
            masters.push(r);
        }
    }

    let mut out = Vec::new();
    for m in &masters {
        let replaced = overrides.get(&m.uid);
        for s in starts(m, from, to, fallback) {
            let at = s.utc(fallback);
            if replaced.is_some_and(|o| o.iter().any(|(k, _)| *k == at)) {
                continue; // an override (or a cancellation) takes this slot
            }
            if overlaps(m, s, from, to, fallback) {
                out.push(occurrence(m, s));
            }
        }
    }
    for list in overrides.values() {
        for r in list.iter().filter_map(|(_, r)| r.as_ref()) {
            if overlaps(r, r.start, from, to, fallback) {
                out.push(occurrence(r, r.start));
            }
        }
    }
    out.sort_by(|a, b| (!a.all_day, &a.start).cmp(&(!b.all_day, &b.start)).then(a.title.cmp(&b.title)));
    Ok(out)
}

// ── Feeds ──

fn secret_name(feed_id: i64) -> Result<String, ApiError> {
    if (1..=1_000_000).contains(&feed_id) {
        Ok(format!("calendar_feed_{feed_id}"))
    } else {
        Err(ApiError::Invalid)
    }
}

/// webcal:// is the same feed over https; anything that is not https is refused.
fn clean_url(raw: &str) -> Result<reqwest::Url, ApiError> {
    let raw = raw.trim();
    let raw = raw.strip_prefix("webcal://").map(|r| format!("https://{r}")).unwrap_or_else(|| raw.to_string());
    if raw.len() > MAX_URL {
        return Err(ApiError::Invalid);
    }
    let url = reqwest::Url::parse(&raw).map_err(|_| ApiError::Invalid)?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(ApiError::Invalid);
    }
    Ok(url)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(crate::http::TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("Nox/", env!("CARGO_PKG_VERSION")))
            // Follow a few redirects, and only to https.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .unwrap_or_default()
    })
}

async fn fetch_capped(url: reqwest::Url) -> Result<String, ApiError> {
    let mut response = client().get(url).send().await?;
    let status = response.status();
    if status.is_redirection() {
        return Err(ApiError::Invalid); // a redirect we refused to follow
    }
    if !status.is_success() {
        return Err(crate::http::from_status(status.as_u16()));
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_BODY) {
        return Err(ApiError::TooLarge);
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(ApiError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Save (or replace) a feed's URL in Credential Manager. Never returned.
#[tauri::command]
pub fn calendar_feed_set(feed_id: i64, url: String) -> Result<(), ApiError> {
    let url = clean_url(&url)?;
    secrets::store(&secret_name(feed_id)?, url.as_str()).map_err(|_| ApiError::Invalid)
}

#[tauri::command]
pub fn calendar_feed_delete(feed_id: i64) -> Result<(), ApiError> {
    secrets::forget(&secret_name(feed_id)?).map_err(|_| ApiError::Invalid)
}

/// Fetch a feed and list its occurrences from `days_back` days ago to
/// `days_ahead` days ahead. `time_zone` is the fallback zone.
#[tauri::command]
pub async fn calendar_fetch(feed_id: i64, days_back: i64, days_ahead: i64, time_zone: Option<String>) -> Result<Vec<CalEvent>, ApiError> {
    let url = secrets::get(&secret_name(feed_id)?).ok_or(ApiError::NoToken)?;
    let url = clean_url(&url)?;
    let body = fetch_capped(url).await?;
    let fallback = time_zone.as_deref().and_then(|z| chrono_tz::Tz::from_str(z).ok()).unwrap_or(FALLBACK_TZ);
    let now = Utc::now();
    let from = now - chrono::Duration::days(days_back.clamp(0, 30)) - chrono::Duration::hours(24);
    let to = now + chrono::Duration::days(days_ahead.clamp(1, 60));
    expand(&body, from, to, fallback).map_err(|_| ApiError::BadResponse)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        Utc.from_utc_datetime(&NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap())
    }

    fn run(ics: &str) -> Vec<CalEvent> {
        expand(ics, at("2026-11-01 00:00"), at("2026-12-01 00:00"), FALLBACK_TZ).unwrap()
    }

    const ALL_DAY: &str = include_str!("../tests/fixtures/all_day.ics");
    const WEEKLY: &str = include_str!("../tests/fixtures/weekly_exception.ics");
    const OTHER_TZ: &str = include_str!("../tests/fixtures/other_timezone.ics");
    const CANCELLED: &str = include_str!("../tests/fixtures/cancelled.ics");
    const MALFORMED: &str = include_str!("../tests/fixtures/malformed.ics");

    #[test]
    fn keeps_all_day_events_as_dates() {
        let e = run(ALL_DAY);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].start.as_str(), e[0].end.as_str(), e[0].all_day), ("2026-11-10", "2026-11-12", true));
        assert_eq!(e[0].title, "Dies Natalis, libur");
    }

    #[test]
    fn expands_weekly_with_an_exdate_and_a_moved_occurrence() {
        let e = run(WEEKLY);
        let starts: Vec<&str> = e.iter().filter(|x| x.uid == "jarkom@kampus").map(|x| x.start.as_str()).collect();
        // Tuesdays 08:00 WIB = 01:00 UTC; 10 Nov removed (EXDATE); 17 Nov moved to Wednesday 18 Nov 09:00 WIB.
        assert_eq!(starts, vec!["2026-11-03 01:00:00", "2026-11-18 02:00:00", "2026-11-24 01:00:00"]);
        let moved = e.iter().find(|x| x.start == "2026-11-18 02:00:00").unwrap();
        assert_eq!(moved.title, "Prak Jarkom (pindah)");
        assert_eq!(moved.location.as_deref(), Some("Lab 2"));
        assert_eq!(moved.end, "2026-11-18 04:00:00");
    }

    #[test]
    fn converts_an_event_in_another_timezone() {
        let e = run(OTHER_TZ);
        // 09:00 in New York on 5 Nov 2026 (EST, UTC-5) = 14:00 UTC; Z time stays.
        assert_eq!(e.iter().map(|x| x.start.as_str()).collect::<Vec<_>>(), vec!["2026-11-05 14:00:00", "2026-11-06 03:30:00"]);
    }

    #[test]
    fn leaves_out_cancelled_events_and_occurrences() {
        let e = run(CANCELLED);
        let titles: Vec<&str> = e.iter().map(|x| x.title.as_str()).collect();
        assert!(!titles.contains(&"Rapat batal"));
        // A cancelled occurrence of a daily series: 4 Nov is missing.
        let daily: Vec<&str> = e.iter().filter(|x| x.uid == "daily@nox").map(|x| &x.start[..10]).collect();
        assert_eq!(daily, vec!["2026-11-02", "2026-11-03", "2026-11-05"]);
    }

    #[test]
    fn a_malformed_file_does_not_crash() {
        let r = expand(MALFORMED, at("2026-11-01 00:00"), at("2026-12-01 00:00"), FALLBACK_TZ);
        // Either a clean error or the one good event; never a panic.
        if let Ok(events) = r {
            assert!(events.iter().all(|e| e.title == "Masih bagus"));
        }
        assert!(expand("not a calendar at all", at("2026-11-01 00:00"), at("2026-12-01 00:00"), FALLBACK_TZ).map(|e| e.is_empty()).unwrap_or(true));
        assert!(expand("", at("2026-11-01 00:00"), at("2026-12-01 00:00"), FALLBACK_TZ).map(|e| e.is_empty()).unwrap_or(true));
    }

    #[test]
    fn refuses_non_https_feed_urls() {
        assert_eq!(clean_url("webcal://calendar.google.com/x.ics").unwrap().scheme(), "https");
        assert!(clean_url("http://example.com/x.ics").is_err());
        assert!(clean_url("file:///C:/x.ics").is_err());
        assert!(clean_url("javascript:alert(1)").is_err());
        assert!(secret_name(0).is_err());
        assert_eq!(secret_name(3).unwrap(), "calendar_feed_3");
    }

    #[test]
    fn reads_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(chrono::Duration::minutes(90)));
        assert_eq!(parse_duration("P1D"), Some(chrono::Duration::days(1)));
        assert_eq!(parse_duration("P1W"), Some(chrono::Duration::weeks(1)));
        assert_eq!(parse_duration("nope"), None);
    }
}
