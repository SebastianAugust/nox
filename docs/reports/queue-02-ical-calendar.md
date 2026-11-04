# Queue 02: Calendar via iCal feeds (read-only)

Status: **done**. Gate green: `tsc`, `build`, `npm test` (152), `cargo check`; `cargo test` 24.

## What was built

- **Parser and expansion** (`src-tauri/src/calendar.rs`), using `icalendar` (parser) and `rrule`
  (expansion), with `chrono-tz`:
  - RRULE within the window, EXDATE, RECURRENCE-ID overrides (moved or cancelled occurrences).
  - CANCELLED events left out, all-day events kept as dates.
  - TZID by IANA name, with a fallback to the timezone setting (default Asia/Jakarta).
  - A malformed file gives an error or skips events; it never crashes.
  - Fixtures (`src-tauri/tests/fixtures/*.ics`) cover all-day, weekly with an EXDATE plus a moved
    occurrence, another timezone (New York + UTC), cancelled event and cancelled occurrence, and
    malformed files.
- **Secrets:** feed URLs go to Credential Manager as `calendar_feed_<id>` through
  `calendar_feed_set` and are never returned or logged. The general `secret_*` commands cannot read
  or write these entries.
- **Fetching:** https only; a redirect to non-https is refused; 15 s; 5 MB cap, enforced while
  streaming (new error `TooLarge`).
- **Storage and sync** (migration 0007):
  - Tables `calendar_feeds` (id, name, enabled, last_synced_at, last_error) and `calendar_events`
    (feed_id, uid, start, end, all_day, title, location); a trigger removes events with their feed.
  - Sync on start, every 30 min and on "Sync now". A failure keeps the last good events and marks
    them stale.
- **Integrations → Calendars:** add (name + write-only URL field), enable/disable, remove with
  confirm, last sync, event count, error text; up to 5 feeds. Also holds the nudge minutes setting.
- **Home "Today's schedule":** all-day first, then by time, with a now/next marker, a stale mark,
  plain empty and setup copy.
- **Briefing** lists today's events first. **Commands** `/jadwal`, `/jadwal besok`,
  `/jadwal minggu` (also `/schedule`) in the pet chat and Telegram.
- **Nudges:** `calendar_nudge_minutes` (default 15, 0 = off), one per timed event, recorded in
  `calendar_nudges_sent` before delivery so a restart never repeats one. They use the new deliver
  kind `calendar`, held during focus and merged when several are queued.

## Files changed or added

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (icalendar, rrule, chrono, chrono-tz)
- `src-tauri/src/calendar.rs` (new), `src-tauri/tests/fixtures/*.ics` (new, 5 files)
- `src-tauri/src/secrets.rs` (calendar entries: `store`, `forget`, token-only commands)
- `src-tauri/src/http.rs` (`TooLarge`), `src-tauri/src/lib.rs` (module, 3 commands, migration 7)
- `src-tauri/migrations/0007_calendar.sql` (new)
- `src/lib/calendar.ts`, `src/lib/calendarLogic.ts`, `src/lib/calendar.test.ts` (new)
- `src/lib/commands.ts`, `src/lib/commandRunner.ts`, `src/lib/commandParser.test.ts`
- `src/lib/briefing.ts`, `src/lib/briefing.test.ts`, `src/lib/briefingScheduler.ts`
- `src/lib/deliver.ts`, `src/App.tsx`
- `src/dashboard/widgets/TodaySchedule.tsx` (new), `src/dashboard/pages/Home.tsx`, `src/dashboard/pages/Integrations.tsx`
- `src/lib/i18n.ts`, `src/styles/dashboard.css`, `docs/ARCHITECTURE.md`

## Migrations

`0007_calendar.sql`

## Deviations

- **VTIMEZONE:** TZIDs are matched by IANA name (Google and most feeds use those). Custom VTIMEZONE
  rule blocks (e.g. Outlook's "SE Asia Standard Time") are not interpreted; such events use the
  fallback zone (setting, default Asia/Jakarta). This matches "VTIMEZONE with a fallback to
  Asia/Jakarta" in spirit, not in full.
- **RDATE** (extra one-off dates) is not expanded.
- **Rejected rules:** a rule the `rrule` crate rejects (e.g. a floating UNTIL with a zoned DTSTART)
  shows only its first occurrence, rather than failing the feed.
- **Days and times** on Home and in `/jadwal` use the PC's clock. The timezone setting is passed to
  Rust only as the fallback zone for parsing.
- **No Telegram push:** calendar nudges are not pushed to Telegram, which the prompt did not ask
  for.

## Not tested live

No real feed was fetched. Parsing and expansion were tested on fixtures, and storage, stale
handling and nudge dedupe on real SQLite with a mocked fetch. Untested: the https-only redirect
policy and the 5 MB streaming cap against a real server, real Google ICS output (large recurring
series, its VTIMEZONE blocks), and Credential Manager storage of the URL.

## Manual checklist for Bas

1. In Google Calendar settings copy the "Secret address in iCal format" and add it in Nox; events
   for today appear on Home.
2. A weekly recurring class shows on the right days; a cancelled one does not.
3. `/jadwal` and `/jadwal besok` work from the pet and from Telegram.
4. The briefing lists today's events once.
5. Wi-Fi off: the last events stay visible with a stale mark.
6. The feed URL never appears in devtools, logs or the database file.
