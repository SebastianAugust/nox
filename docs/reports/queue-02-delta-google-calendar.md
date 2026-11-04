# Queue 02 delta: Google Calendar (read and create events)

Status: **done**. Gate green: `tsc`, `build`, `npm test` (235), `cargo check`; `cargo test` 56.

Google Calendar is now the main calendar source, next to the iCal feeds from the first version
of step 02. The feeds still work unchanged and show as "Other calendar feeds (iCal)".

## What was built

- **OAuth for a desktop app** (`src-tauri/src/google.rs`):
  - Authorization Code + PKCE (S256), a random `state`, loopback redirect on 127.0.0.1 with a
    random free port, and the system browser (`rundll32 url.dll,FileProtocolHandler`, no
    shell).
  - Scopes: `calendar.readonly` and `calendar.events` only.
  - Client id/secret and the refresh token are in Credential Manager. Only `google.rs` can read
    them: the generic `secret_*` commands refuse these names, and no command returns them.
  - The access token is kept in memory and refreshed 60 s before it expires.
  - `invalid_grant` becomes "connect again".
  - Disconnect revokes the token with Google (best effort; it says so when Google cannot be
    reached), deletes the token, and clears Google's calendars and events locally. "Remove
    client" also deletes the client id/secret.
- **Setup guide** `docs/GOOGLE_SETUP.md`: project, Calendar API, consent screen, Desktop app
  client, then connect. It includes a section on refresh-token expiry in Testing, with quotes
  and sources (summary below).
- **Sync** (`src/lib/googleCalendar.ts`, through the existing `syncCalendars`: start, every
  30 minutes, Sync now):
  - Calendar list: the primary calendar is on by default, others are off, and calendars that
    are gone are removed.
  - `events.list` with `singleEvents=true` over yesterday … +30 days, then incremental with
    `syncToken`. A 410 falls back to a full list. A new day or a re-enabled calendar also
    triggers a full resync.
  - A failure keeps the last good events and shows the stale mark.
- **One table for both sources:** `calendar_events` now holds Google rows (`source='google'`,
  `calendar_id`, `google_id`, `status`, `updated_at`, `html_link`) next to the iCal rows.
  Home's "Today's schedule", the briefing, `/jadwal`, `/jadwal besok`, `/jadwal minggu` and the
  nudges read both without changes to their own code.
- **Pending actions** (`pending_actions`, `pendingActions.ts` + `confirmations.ts`): one
  confirmation mechanism.
  - Step 03 already had one (an in-memory map in `telegram.ts` and React state in the pet).
    Both now use this table, so there is a single mechanism.
  - The pet shows a card (Add / Edit / Cancel); Telegram shows inline buttons `pa:yes:<id>` /
    `pa:no:<id>`, accepted only from the paired private chat.
  - Actions expire after 10 minutes. Confirm is atomic, so an action runs once, and only from
    where it was offered.
- **`/event <text>`** (also `/acara`), for the pet and Telegram:
  - `eventParse.ts` extends the shared quick-add parser with a time range, `~duration`, and a
    place after `di`/`at`. The default length is 1 hour; no time means all-day; no date means
    today; an end earlier than the start runs past midnight.
  - The preview warns about overlapping events.
  - The event is created only after Confirm, into the primary calendar. It is stored locally at
    once, and the reply shows the event link.
  - Only creating: there is no code path that edits or deletes events.
  - Edit in the pet puts the `/event` line back into the chat input.
- **Integrations → Google Calendar:**
  - client id/secret (write-only)
  - Save client, Connect, Disconnect, Remove client
  - status, and a warning when creating events was not allowed
  - the calendar list with toggles, color, last sync, event count and errors
  - nudge minutes (default 60) and Sync now

  The nudge setting moved here from the iCal card.
- **i18n** en + id for every new string, and `/event` added to the help.

## Refresh tokens in "Testing" (what the guide says, with sources)

- **They expire after 7 days.**
  - <https://developers.google.com/identity/protocols/oauth2>: an app in "Testing" "is issued a
    refresh token expiring in 7 days", unless it only asks for name/email/profile.
  - <https://support.google.com/cloud/answer/15549945>: test-user authorizations "expire seven
    days from the time of consent", and the refresh token "will also expire".
- **The way around it is In production ("Publish app").** With unverified scopes Google shows
  an unverified-app warning and limits the app to 100 new users (sources: 15549945 and
  <https://support.google.com/cloud/answer/7454865>).
- **Not found, so not claimed:** Google's pages mention no personal-use exemption from
  verification. They also do not say on an official page whether the Calendar scopes are
  labelled "sensitive" (the Calendar scope page has no such column). The guide says this
  plainly.

## Files changed or added in this delta

- `src-tauri/migrations/0010_google_calendar.sql` (new)
- `src-tauri/src/google.rs` (new)
- `src-tauri/src/secrets.rs` (Google names, Rust-only)
- `src-tauri/src/telegram.rs` (`from_paired_chat` + test)
- `src-tauri/src/lib.rs` (module, 8 commands, migration 10)
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`:
  - `sha2` 0.10 and `base64` 0.22, both already in the lockfile as transitive dependencies
  - tokio features `net` and `io-util`
  - reqwest feature `form`
- `src/lib/googleCalendar.ts`, `googleCalendar.test.ts` (new)
- `src/lib/pendingActions.ts`, `confirmations.ts` (new)
- `src/lib/eventParse.ts`, `eventParse.test.ts` (new)
- `src/lib/calendar.ts`: both sources in `getEvents`, stale, `hasCalendarSource`, the default
  nudge, and the Google sync
- `src/lib/calendarLogic.ts`: event fields and `overlapping`
- `src/lib/commands.ts`, `commandRunner.ts` (`/event`, `confirm` result)
- `src/lib/telegram.ts`, `src/App.tsx`, `src/components/ChatInput.tsx` (pending actions,
  `initialText`)
- `src/lib/api.ts` (service `google`)
- `src/lib/i18n.ts`
- `src/dashboard/pages/Integrations.tsx`, `src/dashboard/widgets/TodaySchedule.tsx`,
  `src/styles/dashboard.css`
- `docs/GOOGLE_SETUP.md` (new), `docs/ARCHITECTURE.md`

Several of these files also hold uncommitted work from earlier steps, so review hunks when
committing.

## Migrations

**0010** `google calendar and pending actions`:

- new tables `calendar_sources` and `pending_actions`
- new columns on `calendar_events`
- `calendar_nudge_minutes` 15 → 60, only if Bas never changed it

No old migration was edited.

## Tests (mocked HTTP only)

- Rust (`google.rs`, local mock server):
  - PKCE against the RFC 7636 example, and the verifier format
  - the consent URL (two scopes, S256, state, offline)
  - state checks on the redirect (right, wrong, missing, `error=`, a favicon request ignored)
  - the real loopback listener: other requests are skipped, a forged state is refused, and it
    times out instead of hanging
  - the code exchange with the verifier
  - refresh, and `invalid_grant` / `invalid_client` / a bad answer
  - revoke
  - event mapping (timed with an offset, all-day, cancelled)
  - full sync with paging, incremental with only the token, 410 → full resync
  - the calendar id encoded in the path
  - the create body: only summary, start, end, location
  - new-event validation, scope and refresh-token checks, client id validation
- `telegram.rs`: callbacks only from the paired private chat; `pa:` data is accepted.
- TypeScript:
  - Sync: nothing while disconnected; primary on and others off; incremental and cancelled; full
    resync on a new day; failure keeps events and marks them stale; Google next to iCal;
    disabled calendars hidden; clear on disconnect; the window.
  - Pending actions: once only; other source refused; 10-minute expiry; cancel; button parsing.
  - `/event`: preview with an overlap warning and nothing created; Confirm creates once and
    stores the link; Cancel creates nothing; expired creates nothing.
  - Parser: range, duration, place, `at <time>`, all-day, past midnight, missing title, and the
    Edit text read back.

## Deviations

- **iCal kept** as a second source ("Other calendar feeds"), as asked. The spec's
  `calendar_events` columns were added to the existing table, not created anew.
- **Disconnect deletes the refresh token, not the client id/secret**, so reconnecting needs no
  re-pasting (checklist item 6). "Remove client" deletes those too.
- **The nudge setting is on Integrations → Google Calendar**, next to the calendars, not on the
  Settings page.
- **Step 03 bug fixed on the way:** the Telegram capture buttons used the regex
  `/^cap:(yes|no):(d+)$/` (missing the `\`), so Confirm never matched. That code is now
  replaced by pending actions. Old `cap:` buttons answer "expired".
- **Step 03 previews now expire after 10 minutes** (was 15), the shared pending-action rule.
- **Overlap warning:** only timed events count as clashes; existing all-day events do not.

## Not tested live

Nothing reached Google. Not tried:

- the real consent screen and redirect, and whether Google accepts the loopback redirect for
  this client
- real tokens, refresh and revoke
- the real `calendarList` and `events.list` answers, sync-token behaviour and a real 410
- creating an event and its `htmlLink`
- the browser opening through `rundll32`

The Integrations card, the pet card and Telegram buttons were not run in the app (types,
build and unit tests only).

## Manual checklist for Bas (from the spec)

1. Follow docs/GOOGLE_SETUP.md, connect, and see today's events on Home.
2. A weekly class appears on the right days; a cancelled one does not.
3. `/jadwal` and `/jadwal besok` work from the pet and Telegram.
4. `/event rapat tes jumat 14:00 ~1h` shows a preview; Confirm creates it in Google Calendar;
   Cancel creates nothing; an overlapping time shows a warning.
5. A nudge arrives 60 minutes before an event and not again after a restart.
6. Disconnect removes the tokens; reconnecting works.
7. No client secret or token appears in devtools, logs or the database file.

Extra for this delta:

- A capture from step 03 ("ingetin besok jam 7 bayar kos") in Telegram: Confirm now works.
- An `/event` card left for over 10 minutes says it expired.
- If the app stays in Testing, reconnect after 7 days.
