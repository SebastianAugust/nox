# Architecture

Nox is a Tauri v2 app with two windows that load the same React bundle
(`src/main.tsx` picks the view by window label). Data lives in one SQLite file
reached through `tauri-plugin-sql`; Rust runs the schema migrations at startup.

## Windows

| Window | Label | Root | Size | Role |
|---|---|---|---|---|
| Pet | `main` | `src/App.tsx` | 330×350 logical, transparent, always on top | The sprite, its dialog-box bubble, chat, check-ins. Owns every scheduler, the pomodoro timer, the Notion sync and the Telegram poller, because it is the one window that is always alive. |
| Dashboard | `dashboard` | `src/dashboard/Dashboard.tsx` | 1000×760 | Home, Habits, Focus, Todos, Recap, Integrations, Settings. A view plus remote control; hidden, not destroyed, when closed. |

### Pet window size and click-through

The pet window is bottom-right anchored: content stacks upward from the
bottom (`.pet-root`), and the window grows upward when the chat or a check-in
opens (`resize_window` keeps the bottom edge). Its collapsed height must match
in three places: `WIN_W`/`WIN_H` in `src-tauri/src/pet.rs`, the `main` window in
`tauri.conf.json`, and `HEIGHT_CLOSED` in `App.tsx`.

Most of the window is transparent. Every visible part carries `data-hit`
(the dialog box including its name tag, the chat pill, the sprite); `App.tsx`
reports their rectangles to Rust (`set_hit_regions`), and a Rust loop toggles
`set_ignore_cursor_events` as the cursor moves in and out of them. The pet's
saved position is the collapsed top-left (`pet_position`).

## Source layout

```
src/
  main.tsx                 picks the window view; imports fonts and all CSS once
  App.tsx                  pet window
  components/
    Pet.tsx                the sprite + eyelid expressions (do not restyle)
    Bubble.tsx, ChatInput.tsx, CheckinPrompt.tsx   pet window parts
    Pomodoro.tsx           usePomodoro (view of the engine), FocusRing, Focus page block
    ui/                    DialogBox, ChunkyButton, Pill, Tag, Card, StatCard, Toggle, IconButton
    deco/                  NightSky, Lightning, SlitEyes, ClawMarks, Footprint, StreakEgg, Wings, MoonStars
  dashboard/
    Dashboard.tsx          shell: floating top bar, page switch, shortcuts
    PageHeader.tsx         sky band (compact, or Home's hero)
    nav.ts                 page order = 1-7 shortcuts
    format.ts              due-date wording, rich-text template fill
    pages/                 one file per page (Integrations = Notion, briefing, Telegram, weather)
    todos/                 the Todos page parts: QuickAdd, TodoRow, DetailsPanel, BulkBar, Toasts, format
    widgets/               TodoItem, AddTodo, WeekFootprints, HabitItem, Reminders, SettingControls, SecretField, Places, ListsManager
  lib/
    db.ts, db-helpers.ts   all SQL
    i18n.ts                en + id strings, t(), useLanguage()
    theme.ts               appearance settings → :root (useAppearance)
    bolt.ts                procedural lightning bolt generator (pure, tested)
    homeMessage.ts         Home's rule-based Nox message (pure, tested)
    streaks.ts             per-habit streaks, day shifting (pure, tested)
    commands.ts            slash-command parser + plain-text rendering (pure, tested)
    commandRunner.ts       carries out a parsed command (pet chat and Telegram)
    deadlines.ts           urgency labels, 3d/1d/3h nudge selection (pure, tested)
    notionMapping.ts       Notion rows → assignments/courses, property mapping, id from URL (pure, tested)
    briefing.ts            briefing timing and text (pure, tested)
    notionSync.ts          read-only sync, upsert, status (pet window)
    nudgeScheduler.ts, briefingScheduler.ts   pet-window schedulers
    weather.ts             Open-Meteo reading for the active place, 30 min cache, wording
    places.ts              saved places, active place, seeding, Detect now
    todoParse.ts           quick-add parser for todos, also /todo (pure, tested)
    todoLogic.ts           todo views, counts, grouping, sort, search, repeat (pure, tested)
    todoRepo.ts            every todo read/write: lists, steps, bulk, Notion copies (tested on real SQLite)
    testSqlite.ts          tests only: node:sqlite with the real migrations
    telegram.ts            Telegram poll loop and pushes (pet window)
    api.ts                 Rust API error → message; secret_* wrappers
    pomodoroEngine.ts      the timer (pet window only)
    deliver.ts             one gate for every bubble / toast
    checkin.ts, friction.ts, recap.ts, reminders.ts   schedulers
  styles/
    tokens.css             every color, size, radius, shadow, duration
    motion.css             decorative keyframes + reduced-motion / paused / off rules
    ui.css                 shared components and the night sky
    pet.css                pet window
    dashboard.css          dashboard shell and pages
  index.css                base reset and the sprite's expression keyframes
src-tauri/
  migrations/0001_init.sql … 0005_todos.sql
  src/lib.rs               app setup, dashboard show/hide, migrations list, command list
  src/pet.rs               pet placement, resize, click-through
  src/ollama.rs            streaming chat to the local Ollama
  src/http.rs              shared HTTPS client (15 s timeout, User-Agent Nox/x.y), ApiError
  src/secrets.rs           tokens in Windows Credential Manager
  src/notion.rs            Notion database query (read-only, paginated, rate-limited)
  src/weather.rs           Open-Meteo geocoding and forecast
  src/telegram.rs          Telegram long poll, pairing allowlist, send
```

## Cross-window events

| Event | From → to | Payload |
|---|---|---|
| `settings:changed` | dashboard → all | `{ key }`; both windows re-read language and appearance |
| `pomodoro:cmd` | dashboard or pet bubble → engine | `{ type: "start" \| "stop" \| "skip" }` |
| `pomodoro:request` | dashboard → engine | engine answers with a snapshot |
| `pomodoro:state` | engine → all | `PomSnapshot` on every change (deadline-based, not per second) |
| `secrets:changed` | dashboard → all | `{ name }` after a token is saved or removed (never the value) |
| `notion:sync` | dashboard → pet | "Sync now" |
| `notion:status` | pet → all | after every sync attempt; status is in settings |
| `telegram:status` | pet → all | poller state changed (`telegram_status` setting) |
| `telegram:paired` | Rust → all | a `/pair` with the right code paired a chat |
| `calendar:sync` | dashboard → pet | "Sync now" / a feed was added or enabled |
| `calendar:status` | pet or dashboard → all | after a calendar sync or a feed change |
| `notion:outbox` | any window → all | a Notion write was queued or sent |
| `todos:changed` | any window → all | after every write in `todoRepo.ts` (the page, Home, `/todo`, `/done`, Telegram) |

`pomodoro:cmd` `start` may carry `minutes` (one session only, `/fokus 5`),
`context` (the assignment a deadline nudge offered focus for, or a todo's
title) and `todoId` (Todos page "Start focus"; the finished session is saved
with that `pomodoro_sessions.todo_id`).

## Rust commands

| Command | Used by | Returns |
|---|---|---|
| `secret_set(name, value)`, `secret_delete(name)` | dashboard | nothing |
| `secret_exists(name)` | both | `bool`, never the value |
| `notion_query_database(databaseId)` | pet (sync) | every row: `{ id, archived, properties, lastEditedTime }` |
| `notion_set_done(pageId, done)` | pet (outbox) | refreshes the page, then sets only its Done checkbox; returns the page; needs `notion_write_enabled` |
| `notion_create_assignment(databaseId, name, dateIso?, coursePageId?, existingSince?)` | pet (outbox) | `{ pageId, existed }`; with `existingSince` it first looks for a page an earlier attempt made |
| `weather_geocode(name)` | both | places |
| `weather_fetch(latitude, longitude)` | both | current + today's forecast |
| `calendar_feed_set(feedId, url)`, `calendar_feed_delete(feedId)` | dashboard | stores/removes a feed URL in Credential Manager (`calendar_feed_<id>`); https/webcal only; never returned |
| `calendar_fetch(feedId, daysBack, daysAhead, timeZone?)` | pet | expanded occurrences in the window; https only, redirects only to https, 15 s, 5 MB cap |
| `location_detect()` | dashboard ("Detect now") | rough city + lat/lon from the public IP (ipapi.co); refuses unless `location_detect_enabled` is `true`; the IP is not returned |
| `telegram_poll(offset)` | pet | `{ nextOffset, messages, paired }`, paired chat only; a message is `{ kind: "text", text }` or `{ kind: "location", latitude, longitude }` |
| `telegram_send(text)`, `telegram_typing()` | pet | to the paired chat only, split at 4096 |
| `telegram_pairing_start()` | dashboard | a 6-digit code, valid 10 min, kept in Rust memory |

Errors are `{ kind, status? }` (`noToken`, `unauthorized`, `notFound`,
`rateLimited`, `offline`, `timeout`, `http`, `badResponse`, `invalid`,
`writesOff` (Notion writes are off), `readOnly` (403 on a Notion write),
`notPaired`); `src/lib/api.ts` words them.

## Connected Nox (Phase 2)

```
             Notion API        Open-Meteo        Telegram Bot API
                 ▲                 ▲                    ▲
     token from  │                 │ no key             │ token from
 Credential Mgr  │                 │                    │ Credential Mgr
            ┌────┴─────────────────┴────────────────────┴────┐
            │ Rust: http.rs client · notion · weather · telegram │
            └────▲───────────────────────▲───────────────────▲┘
                 │ invoke                │ invoke            │ invoke
   pet window: notionSync (start, 30 min,│  dashboard: Home   │ pet window:
   "Sync now") → notion_* tables         │  chip, Integrations│ telegram.ts loop
   nudgeScheduler → deliver + Telegram   │                    │ → commandRunner / Ollama
   briefingScheduler → deliver + Telegram│                    │
```

- **Notion (read-only).** `notion_assignments_db_id` / `notion_courses_db_id`
  accept a URL or an id. Rust pages through the query (≤ ~3 req/s, retries a
  429 after Retry-After). `notionMapping.ts` picks the property per field:
  the pinned name from `notion_map_*`, else by type and a likely name. A
  pinned name that is gone or has the wrong type is stored as
  `notion_last_error` and shown on Integrations; the data is left untouched.
  Rows are upserted by `notion_id`; each run stamps `last_synced_at`, and
  rows a complete run did not see become `status = 'removed'` (done upstream
  → `'done'`). Nothing is hard-deleted.
  - Defaults follow Bas's "student essentials" template: assignments `Name`
    (title), `Date`, `Done` (checkbox), `Courses` (relation); courses
    `Course Name`, `Status`, `Semester/Year`. Grade, Weight, Weighted Mark and
    Final Mark are not read; the notebooks database is not synced. If a
    default name is missing, the type-based guess still applies.
  - Courses sync first. An assignment's `Courses` relation (a Notion page id)
    is stored as `course_notion_id` and joined on `notion_courses.notion_id`,
    so the course shown is always a name; an unknown id shows no course.
  - What counts (`isRelevantAssignment` in `deadlines.ts`, also used by
    `getOpenAssignments`): not Done, has a name and a date, not overdue by
    more than 30 days, and its course is current (`Status` "In progress") or
    it has none. The radar, briefing, nudges and `/tugas` all read through
    it; SQL-only counts use `CURRENT_ASSIGNMENTS` in `db-helpers.ts`, which
    mirrors it. An empty or old database is simply "No upcoming deadlines".
- **Places and weather.** Saved places live in `places` (name, geocoded
  label, lat/lon); `active_place_id` picks one. A fresh install seeds
  "Jatinangor" by geocoding `weather_location`; migration 0004 moved an older
  single location into the first place. Places are added in Settings (search
  → pick a result → name it), from a Telegram location pin, or by "Detect
  now". Switching (Settings, the Home weather chip, Integrations, `/lokasi`)
  announces `settings:changed`, and every weather view refetches. Readings
  are cached in `weather_cache` for 30 min per lat/lon, so a switch fetches
  at once unless that place has a fresh one; a failed refresh serves the
  cache marked stale. Rain is only mentioned in the briefing, `/cuaca` and
  the weather chip.
- **Detect now.** Off by default (`location_detect_enabled`), because it sends
  the public IP to ipapi.co. One HTTPS call from Rust on a button press; the
  result is labelled approximate and only saved after Bas confirms. There is
  no background or continuous location tracking.
- **Briefing.** At `briefing_time` in `user_timezone`, or on the first tick
  after it if Nox started late. `last_briefing_date` is written before the
  briefing is built, so it never repeats. Facts come from SQL; Ollama may only
  write the opener (8 s limit, static fallback). Delivered as kind
  `briefing` (held during focus) and pushed to Telegram if enabled.
- **Deadline nudges.** Every 5 min and after each sync: assignments due
  within 4 days; for each, the most urgent of 3d / 1d / 3h crossed, unless
  `nudges_sent` already has that (assignment, threshold). The row is written
  before delivery. Kind `nudge` is held during focus; its "Start focus"
  starts the pomodoro with the assignment as context.
- **Commands.** Anything starting with `/` goes to `parseCommand` (pure) →
  `runCommand` → `renderResult`, in the pet chat and over Telegram alike.
  Only the listed commands exist (`/tugas`, `/todo`, `/done`, `/ingat`,
  `/fokus`, `/stop`, `/status`, `/cuaca`, `/lokasi [name]`, `/bantu`, plus
  pet-only `/clear`, `/dashboard`); none runs programs or reads files.
  `/lokasi` shows the active place; `/lokasi <name>` switches to a saved
  place (case-insensitive, or a unique start of the name) and answers with
  the new weather, or lists the saved names when there is no match.
- **Telegram.** One loop in the pet window long-polls through Rust. Rust
  passes on only messages from the paired private chat (`telegram_chat_id`);
  other chats are ignored silently; `/pair <code>` pairs a chat when the code
  matches. The offset is stored in `telegram_offset` after each batch, so
  messages sent while Nox was off are handled once on start. 401 stops the
  loop ("Token invalid") until a new token is saved; other errors back off up
  to 5 min. Reminders are delivered by the pet first; Telegram gets a copy.
  A location pin from the paired chat makes Nox ask for a name; the next
  plain message (within 10 min) saves the place, makes it active and replies
  with its weather. Pins from any other chat are dropped in Rust.

## Tables added in 0003 and 0004

| Table / columns | Holds |
|---|---|
| `notion_assignments` + `notion_status`, `course_notion_id`, `last_synced_at` | `status` is now Nox's own: `pending` / `done` / `removed` |
| `notion_courses` + `last_synced_at` | `status`: `in_progress` / `removed` |
| `nudges_sent (assignment_id, threshold)` | one row per nudge ever sent |
| `weather_cache` (existing) | `location` = "lat,lon", `forecast` = reading JSON |
| 0004: `places (id, name, label, latitude, longitude)` | saved places; setting `active_place_id` |
| 0004: `notion_courses` + `notion_status` | Notion's course status, for "current course" |
| 0004 settings | `briefing_time` default 07:30 (only the untouched 0003 default is moved), `location_detect_enabled` = `false` |

## Security notes

- Tokens (`notion_token`, `telegram_bot_token`) live only in Windows
  Credential Manager (service `com.lenovo.nox`). No command returns them; the
  UI only learns "saved / not saved". They never go into SQLite, a log, an
  error or an event payload. The dashboard holds a pasted token only until it
  is handed to `secret_set`.
- All outbound HTTP is Rust (reqwest, native TLS). The webview CSP still
  allows no remote connections.
- reqwest errors are stripped of their URL (a Telegram URL contains the
  token) and turned into `ApiError` before anything sees them; nothing in
  `http.rs`, `notion.rs`, `weather.rs` or `telegram.rs` logs.
- Notion is never written to. A database id is checked to be 32 hex digits
  before it reaches a request path; a token must be printable ASCII.
- Telegram answers only the paired private chat; the pairing code is random,
  single-use, expires after 10 minutes and never touches the database.

## Styling

Components use class names from the CSS files above; every value in those
files is a `var(--token)` from `tokens.css` (see `docs/TOKENS.md`). Inline
styles remain only for data-driven geometry (star positions, the lightning
glow position, the sprite's eye offsets). Tailwind is still imported in
`index.css` for its Preflight reset; no utility classes are used, so avoid
class names that collide with Tailwind utilities (`ring`, `shadow`, `border`,
`flex`, `grid`, `hidden`, ...).

The mint accent is fixed; the lightning blue (`--bolt`) is set at runtime from
`ui_bolt_color`. Both windows call `useAppearance()` at their root.

## Decorative motion

`NightSky` draws the header sky. Its CSS animations pause (`data-paused`) while
the dashboard is hidden or unfocused, stop under `html[data-animations="off"]`
(`ui_animations`), and are removed by the reduced-motion rule in `motion.css`.
`Lightning` is mounted only when animations and `ui_lightning` are on, motion
is not reduced, and the window is active; unmounting clears its timers.

A strike: every 15-45 s, half the time a bolt from `generateBolt()` (midpoint
displacement, 32 or 64 segments, 1-3 fading branches, blurred glow) and half
the time sheet lightning (a glow in a cloud). Opacity follows a real flash
curve (flash, ~60 ms dim, second flash, ~500 ms fade) via the Web Animations
API. At most two flashes per strike and strikes 15 s apart keep it far under
3 flashes per second; the sky glow never exceeds 0.12 opacity.

## Todos page

```
QuickAdd ─ todoParse.parseQuickAdd ─┐            pet /todo, Telegram ─┐
                                     ▼                                 ▼
                     todoRepo.createFromQuickAdd (#list → todo_lists, @course → notion_courses)
                                     │ emits todos:changed
Todos page: listTodos + Notion assignments ─► todoLogic.buildList(view, search, sort) ─► groups ─► rows
                                            └► viewCounts / summary (header line, chip counts)
```

- **Data (migration 0005).** `todos` gained `due_time`, `priority` (0-3),
  `list_id`, `estimate_pomodoros`, `repeat_rule`, `sort_order`,
  `completed_at`, `course_name`, `source_notion_id` (unique when set). New
  `todo_lists` (one `is_default`, at most 8, colors from `--list-*`) and
  `todo_subtasks` (deleted with their todo by a trigger, since foreign keys
  are per connection). `pomodoro_sessions.todo_id` counts focus per todo.
  The backfill split any `due_date` with a time, put every todo in the
  default list and set `completed_at` for finished ones.
- **Quick add.** Symbols anywhere (`!high`, `#list`, `@course`, `~3p` /
  `~25m`); dates, times and repeats only from the end of the text, so a
  sentence that merely contains "besok" or "3 hari" gets no date. The
  "Nox understood" chips show the parse as you type. Unknown `#names` go to
  the default list (the page says so). Home's add field and `/todo` use it.
- **Views.** Today = overdue + due today, Upcoming, Inbox (no date),
  Overdue, Done, All. Grouped by due date only (Overdue, Today, Tomorrow,
  each later day, No date, Completed); sorted by due date then time by
  default. Search covers title, notes and course. The page loads every open
  todo plus the latest 300 done ones (`DONE_LOADED`); groups use
  `content-visibility` so 500 rows stay smooth.
- **Completing.** A toast "Marked done · title" with Undo for 5 s. A
  repeating todo spawns its next occurrence (`nextDue`: one step after its
  due date, moved past today so it is never born overdue; monthly keeps the
  day, clamped); Undo deletes that occurrence again.
- **Details panel.** Autosaves (600 ms debounce or on blur; pending edits are
  sent when the panel closes). "Remind me" adds a `reminders` row with
  `todo_id`, which the row shows as a bell and the Reminders card as
  "linked todo". "Start focus" sends `pomodoro:cmd` with `todoId`.
- **Notion rows.** With Notion set up, "Show Notion assignments" (setting
  `todos_show_notion`, on by default) mixes in the radar's assignments
  (same current-course rules) as read-only rows. "Add to my todos" copies
  one into `todos` with `source_notion_id`; a second click finds the copy,
  and the unique index refuses a duplicate even if two windows race. A
  copied assignment shows once, as the copy. Notion is never written to.
- **Keys.** N new, / search, ↑↓ move between rows, Space done, Enter open,
  Esc closes the panel (or select mode) before the dashboard's own Esc.
  Nothing fires while a field has focus.
- **Dev seed.** In `npm run tauri dev`, `window.__noxSeedTodos(500)` in the
  dashboard devtools fills the list for a performance check; it is not in
  the UI or the release bundle's behaviour.

## Home's message

`pickSuggestion()` picks, in order: the oldest overdue todo, something due
today, open habits, an idle line. No model call. "Start focus" sends
`pomodoro:cmd`; "Later" snoozes that suggestion for an hour in memory.

## Tests

`npm test` runs Vitest on the pure modules in `src/lib/*.test.ts`.

## Notion write-back (queue step 01)

Off until Bas turns on **Notion writes** (`notion_write_enabled`, migration
0006). Exactly two writes exist, both in `src-tauri/src/notion.rs`:

- **Done**: `notion_set_done` reads the page first (so a page edited in
  Notion since the last sync is current before anything is written, and the
  Done property must really be a checkbox), then PATCHes a body with one key,
  the Done checkbox. Nothing else is sent.
- **Create**: `notion_create_assignment` POSTs a page with only the title,
  date and course relation properties. Property names come from the mapping
  settings (`notion_map_*`, default the template's Name, Date, Courses,
  Done), are checked, and are the only keys a write body can hold.

There is no command or code path that deletes, archives, renames, moves or
edits anything else, or touches another database. A 403 on a write becomes
`readOnly` ("enable Update/Insert content"). Ids are 32 hex digits; dates
are checked before they reach a request.

**Outbox** (`notion_outbox`, `src/lib/notionOutbox.ts`): every write is a row
first (`set_done` or `create`, JSON payload, `pending | sent | failed`,
attempts, last error). The pet window sends pending rows after every sync
(so on start), and when `notion:outbox` says one was queued. Five failed
attempts make a row `failed`, shown on Integrations with Retry; a failed Done
is not reverted locally. While writes are off, rows wait and attempts are not
counted. A pending Done for the same page is updated, not doubled (Undo).

Creates are not idempotent in Notion. After an attempt that may have reached
Notion (timeout, offline, bad response, 5xx), the row gets
`uncertain_since`; the next attempt passes it (minus a minute, Notion's
created_time has minute precision) and Rust looks for a page with that title
created since then before creating one. A sent create is mirrored into
`notion_assignments` and stored as the todo's `source_notion_id`, so the
next sync upserts the same row and the Todos page shows it once.

Where it is used: the checkbox on Notion rows in the Todos page (optimistic,
with Undo), "Send to Notion" in a todo's details (a linked todo cannot be
sent twice), and `/tugas tambah <text>` / `/tugas selesai <n>` in the pet chat
and Telegram (course from `@course`, matched by name against synced courses;
no match leaves the relation empty and says so).

## Calendar feeds (queue step 02)

Read-only ICS feeds (Google Calendar's "secret address in iCal format",
campus feeds), up to 5. A feed URL grants read access, so it is a secret: it
goes from the Integrations field straight to Rust (`calendar_feed_set`) and
Credential Manager as `calendar_feed_<id>`; the database keeps only the id
and a name (`calendar_feeds`, migration 0007). The `secret_*` commands cannot
reach these entries; only `calendar.rs` can.

`src-tauri/src/calendar.rs` fetches (https only, a redirect to anything else
is refused, 15 s, 5 MB) and expands with `icalendar` + `rrule`: RRULE within
yesterday … +30 days, EXDATE, RECURRENCE-ID overrides (moved or cancelled
occurrences), CANCELLED events left out, all-day events kept as dates.
TZIDs are read as IANA names (also a trailing `Area/City` of a prefixed id);
an unknown TZID or a floating time uses the timezone setting, default
Asia/Jakarta. Custom VTIMEZONE rules are not interpreted. RDATE is not
expanded. A rule the expander rejects still shows its first occurrence; a
broken file is an error, a broken event is skipped, nothing panics.

`src/lib/calendar.ts` (pet window): sync on start, every 30 minutes and on
`calendar:sync`; a good fetch replaces that feed's rows in
`calendar_events`, a failed one keeps them and stores `last_error` (shown as
"may be out of date"). Event nudges: `calendar_nudge_minutes` (default 15,
0 = off) before each timed event, recorded in `calendar_nudges_sent` before
delivery (kind `calendar`, held during focus like other non-reminder kinds).
Home's "Today's schedule" lists today's events (all-day first) with a
now/next marker; the briefing lists them first; `/jadwal`, `/jadwal besok`,
`/jadwal minggu` answer in the pet chat and Telegram.

## Natural-language capture (queue step 03)

The small local model only extracts words; our code does the rest, and
nothing is saved without a confirmation. `src/lib/captureCore.ts` (pure,
tested) holds the pipeline:

1. **Cheap gate** (`mayBeTask`): only text with a trigger word (ingetin,
   remind me, tambah, catat, jangan lupa, besok, jam, deadline, …) or a
   clock time goes to the model. Everything else is plain chat, unslowed.
2. **Model** (`askJson` in `ollama.ts`, through the existing `ollama_chat`
   command): temperature 0, `format` = a JSON schema, 20 s timeout, model
   from `ollama_model`. It returns `{ intent, title, datePhrase?,
   timePhrase?, priority?, list?, course? }`.
3. **Validation**: exactly that shape, known keys and enums only, length
   caps; anything else counts as a failure.
4. **Dates**: the phrases must appear in the user's own words, and are
   resolved by `todoParse` against today. The model never computes a date.
   A reminder without a time becomes a todo.
5. **Fallback**: on timeout, invalid JSON or Ollama off, text that is plainly
   an instruction ("ingetin …", "catat …") goes through the deterministic
   parser; anything else is chat.

Confirmation: the pet shows "Add todo “bayar kos” · tomorrow 07:00?" with
Add / Edit / Cancel (Edit opens Todos with quick-add prefilled via
`todos:prefill`). Telegram replies with a preview and inline Confirm /
Cancel buttons; Rust passes button presses (`callback_query`) through only
from the paired private chat and only with data Nox sets (`cap:yes:<n>`);
`telegram_send_buttons` / `telegram_answer_callback` are the two new
commands. Previews expire after 15 minutes.

"Suggest steps" in a todo's details asks the model for 3-6 steps (JSON
array, validated), shown as a checklist with Add selected / Add all /
Dismiss; none is saved on its own. Setting `ai_capture_enabled` (migration
0008, default on) in Settings → Features.

Evaluation: `src/lib/capture.fixtures.json` (33 phrases, id + en, typos);
`capture.test.ts` runs them with a mocked model; `npm run eval:capture`
(`vitest.eval.config.ts`, `capture.eval.ts`) runs them against the real
local Ollama and prints accuracy per intent.
