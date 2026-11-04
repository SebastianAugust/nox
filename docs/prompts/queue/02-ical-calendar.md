# Queue 02 — Google Calendar (read and create events)

Recommended: Opus, effort high. Run npm/tauri from Windows PowerShell, not WSL.
(File name kept as 02-ical-calendar.md for the queue; this file replaces the
earlier iCal-only plan. Bas uses Google Calendar and also Notion Calendar, which
is a front end over the same Google calendars, so Google covers both.)

DECISIONS (from Bas): Google Calendar is the source. He wants to read his
schedule and also create events from Nox and Telegram. Reminder before an event:
60 minutes by default, changeable in Settings. The schedule is shown separately
from Todos (Home), not inside the Todos page.

## Rules
1. Read docs/ARCHITECTURE.md, the HTTP layer, secrets code, briefing,
   deliver.ts, the commands module, the Telegram handler and the Home page first.
2. New numbered migration(s) only; check the latest number first.
3. Secrets (OAuth client id/secret, refresh token) live in Windows Credential
   Manager, used only in Rust, never logged, never returned to the frontend.
4. i18n en + id, plain copy. Do not git commit or push.
5. tsc, build, test, cargo check green. You cannot reach Google from here: use
   mocked HTTP and say so in the report.

## Tasks
1. **OAuth for a desktop app.** Authorization Code flow with PKCE and a
   loopback redirect (127.0.0.1, random free port), opening the system browser.
   Scopes: calendar read (`calendar.readonly`) and event create/edit
   (`calendar.events`) only. Store the refresh token in Credential Manager; keep
   the access token in memory and refresh it when needed. A "Disconnect" button
   revokes the token with Google and deletes the stored secrets. Tests for the
   PKCE verifier/challenge, state check, token refresh and error paths.
2. **Setup guide** `docs/GOOGLE_SETUP.md` for Bas: create a Google Cloud
   project, enable the Calendar API, configure the OAuth consent screen,
   create an OAuth client of type "Desktop app", paste client id/secret into
   Nox's Settings. Note and verify against Google's current documentation
   whether refresh tokens expire while an app is in "Testing" status and how to
   avoid that for a personal app; write what you found and the source in the
   guide. Do not invent policy details.
3. **Sync.** Table `calendar_events` (id, calendar_id, google_id, title, start,
   end, all_day, location, status, updated_at) and `calendar_sources`
   (calendar_id, name, color, enabled). Use `events.list` with
   `singleEvents=true` over a window of yesterday to +30 days, with incremental
   `syncToken` and a full resync on 410. Default: the primary calendar enabled;
   Bas can enable others. Refresh on start, every 30 minutes, via "Sync now".
   Offline or failed: keep the last good events and show a stale mark.
4. **Home widget** "Today's schedule": today's events by time, all-day first,
   now/next marker, plain empty state. The briefing includes today's events.
5. **Pending actions + confirmation (shared mechanism).** A table
   `pending_actions` (id, kind, payload JSON, source pet/telegram, expires_at,
   status). Any action that creates data from free text first stores a pending
   action and asks Bas to confirm: in the pet a small card (Add, Edit, Cancel),
   in Telegram an inline keyboard (Confirm, Cancel) handled as callback queries
   from the paired chat only. Expire after 10 minutes. This mechanism will be
   reused by the next queue item.
6. **Create events.** `/event <text>` in the pet and Telegram, e.g.
   `/event rapat himatif jumat 14:00-15:30 di sekre`. Extend the shared parser
   with a time range or duration (`~1h`) and a location (`di <place>` / `at
   <place>`); default duration 1 hour; all-day when no time. Show a preview, warn
   if it overlaps an existing event, and create only after confirmation. After
   creation, store and show the event link. Creating only: no editing or
   deleting events in this task.
7. **Commands.** `/jadwal` (today), `/jadwal besok`, `/jadwal minggu` (next 7
   days) in the pet and Telegram.
8. **Nudges.** `calendar_nudge_minutes` (default 60, 0 = off), one nudge per
   event through deliver.ts, deduped with a new `calendar_nudges_sent` table so
   a restart never repeats. Held during focus like other non-reminder kinds.
9. **Integrations UI.** Section "Google Calendar": client id/secret fields
   (write-only), Connect, Disconnect, connection status, calendar list with
   toggles, last sync, event count, errors, nudge setting.
10. Update docs/ARCHITECTURE.md.

## Out of scope
Editing or deleting events, RSVP/invitations, attendees, attachments, other
Google services, Notion Calendar integration (it reads the same Google data).

## Manual checklist for Bas (put it in the report)
1. Follow docs/GOOGLE_SETUP.md, connect, and see today's events on Home.
2. A weekly class appears on the right days; a cancelled one does not.
3. `/jadwal` and `/jadwal besok` work from the pet and Telegram.
4. `/event rapat tes jumat 14:00 ~1h` shows a preview; Confirm creates it in
   Google Calendar; Cancel creates nothing; an overlapping time shows a warning.
5. A nudge arrives 60 minutes before an event and not again after a restart.
6. Disconnect removes the tokens; reconnecting works.
7. No client secret or token appears in devtools, logs or the database file.
