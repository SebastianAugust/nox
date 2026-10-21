# Nox — Audit Report
_Date: 2026-10-21 · Audited commit/state: **no git** (project is not a git repository; newest source edit `src/Dashboard.tsx` mtime 2026-09-21, `src-tauri/src/lib.rs` mtime 2026-07-03)_

**Method.** Every source file (4,852 lines across `src/` and `src-tauri/src/`) was read in full. `tsc --noEmit` was run. `cargo check` could not be run (see §2 Build health). The app was **not** launched, so anything that depends on runtime behaviour (window focus, tray, CORS, DPI) is labelled **UNVERIFIED**. "Done" means I traced the code path end to end.

---

## 1. TL;DR

- **Roughly a third of the original plan exists.** Of the 44 checklist items: 11 done, 12 partial, 2 broken/suspect, 19 not started. The built part is the *shell + a local productivity core*: pet window, tray, Ollama chat, `/todo` `/remind`, todos, habits, pomodoro, mood check-in, friction nudge, daily recap. Everything that touches the outside world is absent: **no Notion, Google Calendar, Spotify, weather, clipboard, screenshot, app tracking, notification digest, autostart, updater, onboarding, tool use**.
- **11 of 20 SQLite tables are created and never touched** (`conversations`, `clipboard_history`, `pattern_data`, `app_usage`, `notification_history`, `weather_cache`, `spotify_history`, `context_mode_logs`, `screenshot_index`, `goals`, `notion_courses`). 8 are fully used; `notion_assignments` is read but can never contain rows.
- **Settings page lies in 4 places.** Language, Timezone, "DND saat pomodoro" and "Daily briefing" (toggle + time) are editable and saved but no code reads them. The Ollama system prompt hardcodes name, city and timezone and ignores the `user_*` settings (`src/lib/ollama.ts:29-53`).
- **Biggest correctness risks:** (1) the Pomodoro timer lives inside a conditionally rendered page, so *navigating away from the Pomodoro tab destroys a running timer* and leaves the pet stuck in "Focus mode" (`Dashboard.tsx:414`, `Pomodoro.tsx:200`); (2) reminders are marked "sent" before they are shown, and are shown only in the pet window, which is hidden whenever the dashboard is open or the user chose "Hide" (`reminders.ts:25-26`, `lib.rs:71`); (3) dashboard window-close paths other than the Esc/× button are unhandled (`lib.rs`, no `on_window_event`).
- **Build health is good where it could be checked:** `tsc --noEmit` exits 0 with strict + noUnused*; zero `@ts-ignore`; the only `any` uses are 8 narrow ones. `cargo check` not run (no Rust toolchain in WSL).
- **No version control, no tests, no README beyond the Tauri template, no CI.** A fresh clone would not know that Ollama is required.
- **The "Windows Service" architecture from the original plan does not exist** and the current design (single Tauri process + tray) makes it largely unnecessary. Needs an explicit drop/keep decision (§11).
- **Pet is real art now:** Toothless sprite integrated, 6 expression states done with CSS eyelids + body transforms. 6 of ~16 planned animations exist, and none are sprite-sheet animations (single static PNG).

---

## 2. Architecture snapshot

One Vite bundle, two Tauri windows, picked by window label in `src/main.tsx:9`. No Rust business logic: Rust only does window/tray management. All data logic is TypeScript talking to SQLite through `tauri-plugin-sql`.

```
                    ┌───────────────────── Rust (src-tauri/src/lib.rs, 162 lines) ─────────────────────┐
                    │ tray: left-click toggle pet · menu: Open Dashboard / Show / Hide / Quit         │
                    │ commands: resize_window ✔ · close_dashboard ✔ · hide_window ✘ · show_window ✘  │
                    │ plugins: opener (unused), sql(sqlite)                                           │
                    └───────────────┬──────────────────────────────────────────┬──────────────────────┘
                                    │ invoke                                   │ invoke
        ┌───────────────────────────▼───────────┐                ┌─────────────▼────────────────────┐
        │ window "main"  160x200 transparent    │   Tauri event   │ window "dashboard" 720x600       │
        │ always-on-top, no taskbar             │◄───"pomodoro-──│ dark, undecorated, hidden at boot │
        │ App.tsx (426)                         │     state"      │ Dashboard.tsx (1864)              │
        │  ├ Pet / Bubble / ChatInput /         │                 │  ├ PageHome / Habits / Pomodoro   │
        │  │ CheckinPrompt                      │                 │  │ / Todos / Recap / Integrations │
        │  ├ schedulers: checkin(30m) friction  │                 │  │ / Settings                     │
        │  │ (5m) recap(60s) reminders(30s)     │                 │  └ components/Pomodoro.tsx        │
        │  │ sleep tick(60s)                    │                 └─────────────┬────────────────────┘
        │  └ lib/ollama.ts ──fetch──► http://localhost:11434 (Ollama)             │
        └───────────────────────┬───────────────────────────────────────────────┘
                                │  both windows open their own connection
                        ┌───────▼───────────────────────────────────────┐
                        │ SQLite "nox.db" (lib/db.ts: 20 tables, seeds) │
                        │ helpers: lib/db-helpers.ts (514 lines)        │
                        └───────────────────────────────────────────────┘
```

**Cross-window sync** is the shared SQLite file plus exactly one Tauri event (`pomodoro-state`, dashboard to pet, `Dashboard.tsx:877` / `App.tsx:189`). There is no push from pet to dashboard and no settings propagation.

### 2.1 File map (Step 1)

| File | Lines | Purpose |
|---|---:|---|
| `src-tauri/src/main.rs` | 6 | Entry, calls `nox_lib::run()` |
| `src-tauri/src/lib.rs` | 162 | Window docking/resize, tray, dashboard open/close, 4 commands |
| `src/main.tsx` | 14 | Picks `<App/>` or `<Dashboard/>` by window label, StrictMode on |
| `src/App.tsx` | 426 | Pet window: state machine, schedulers, slash commands, chat flow, drag |
| `src/Dashboard.tsx` | **1864** | Entire dashboard: shell, 7 pages, all settings widgets, all styles |
| `src/components/Pet.tsx` | 93 | Toothless sprite + eyelid overlays |
| `src/components/Bubble.tsx` | 76 | Speech bubble (glass) with stop button |
| `src/components/ChatInput.tsx` | 104 | Single-line input, `/` hint |
| `src/components/CheckinPrompt.tsx` | 77 | Mood buttons (uses emoji) |
| `src/components/Pomodoro.tsx` | 280 | Timer, ring, session save |
| `src/lib/db.ts` | 317 | DB open, `getSettings`, schema for 20 tables, 19 seeded settings |
| `src/lib/db-helpers.ts` | 514 | All queries (todos, habits, reminders, recap, pomodoro, mood, stats, dead clipboard/notion helpers) |
| `src/lib/ollama.ts` | 194 | Prompt builder + streaming client |
| `src/lib/commands.ts` | 134 | Pure parsers for `/todo` and `/remind` |
| `src/lib/reminders.ts` | 36 | 30 s poll that drains due reminders |
| `src/lib/recap.ts` | 119 | Once-a-day recap scheduler + tally |
| `src/lib/checkin.ts` | 57 | Mood list + check-in scheduler |
| `src/lib/friction.ts` | 52 | Idle nudge |
| `src/index.css` / `src/App.css` | 210 / 116 | Pet animations + Tailwind import / **unused Tauri template CSS** |

### 2.2 Dependencies (flagging unused)

| Dependency | Used? | Notes |
|---|---|---|
| `react`, `react-dom` 19 | yes | |
| `@tauri-apps/api` | yes | `invoke`, `listen`, `emit`, `getCurrentWindow` |
| `@tauri-apps/plugin-sql` | yes | only DB access path |
| `@tabler/icons-webfont` | yes, wasteful | whole webfont for ~6 icons (`ti-home`, `ti-check`, `ti-trash`, ...) |
| `@tauri-apps/plugin-opener` + Rust `tauri-plugin-opener` + capability `opener:default` | **no** | Never called from JS; remove all three |
| `tailwindcss`, `@tailwindcss/vite` | **no** | `@import "tailwindcss"` at `index.css:1`, but no utility class is used anywhere (every component is inline-styled). It still injects Preflight. |
| `serde`, `serde_json` (Rust) | no direct use | No `#[derive]` in `lib.rs`; transitively required anyway |
| Missing but implied by plan | | `tauri-plugin-autostart`, `-notification`, `-updater`, `-clipboard-manager`, `-http`, `-global-shortcut`, keyring crate |

### 2.3 Tauri config summary

- **Windows:** `main` 160x200, undecorated, transparent, alwaysOnTop, skipTaskbar, non-resizable, `shadow:false`. `dashboard` 720x600, undecorated, opaque, **not** skipTaskbar, hidden, non-resizable, centered. Both webviews are created at boot (a hidden window still loads its page, so two webviews are resident all the time).
- **CSP:** `app.security.csp = null` (no CSP).
- **Bundle:** `active:true`, `targets:"all"`, icons present. Metadata is still template: `description "A Tauri App"`, `authors ["you"]`, identifier `com.lenovo.nox`.
- **Capability `default.json`** (applies to both windows): `core:default`, `core:window:allow-start-dragging`, `core:window:allow-minimize`, `opener:default`, `sql:default`, `sql:allow-execute`. No `http`, `fs`, `shell`, `notification`. `core:window:allow-minimize` is only needed by the dashboard but granted to both.

### 2.4 Build health (Step 2)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0, no output** (strict, `noUnusedLocals`, `noUnusedParameters`). Ran under WSL; works because tsc is pure JS. |
| `cargo check` | **Not run.** `cargo` is not installed in WSL (`~/.cargo` absent). The existing `src-tauri/target/debug` (libnox_lib.rlib, 21 Sep) was built from Windows. Tauri resolved to 2.11.5 in `Cargo.lock`. |
| `@ts-ignore` / `@ts-expect-error` | none in `src/`; one `@ts-expect-error` in `vite.config.ts:6` (template, for `process`) |
| `any` | `Promise<any[]>` return types in `db-helpers.ts` ( on `getTodos`, `getPendingReminders`, `getHabits`, `getTodayHabitLogs`, `getClipboardHistory`, `getUpcomingAssignments`; `cacheNotionAssignments(any[])`; `one(..., args: any[])` at `db-helpers.ts:451`), `recap.ts:71`, `ollama.ts:156,183`. Low impact; `getPendingReminders` and `getTodayHabitLogs` are live code paths returning `any[]`. |
| Swallowed errors | Rust: 11x `let _ =` on window ops (`lib.rs:21,32,33,39,57,61,71-74,85,86,127,143`), silent by design. TS: no `catch(() => {})`; everything ends in `.catch(console.error)` (see §7 E-5, errors are never shown to the user). `ollama.ts:123` `.catch(() => "")` is fine. |
| Rust `unwrap`/`expect` | `lib.rs:114` `default_window_icon().unwrap()` (safe while an icon is bundled), `lib.rs:161` standard `expect` on `run()`. No other panics. |

---

## 3. Feature status matrix

Legend: ✅ done (traced end to end) · 🟡 partial · ❌ not started · ⚠️ broken/suspect

| # | Feature | Status | Evidence | Notes |
|---|---|:-:|---|---|
| 1 | Transparent always-on-top pet window, bottom-right | ✅ | `tauri.conf.json` window `main`; `lib.rs:15-28,96-98` | Docks to **primary** monitor, fixed 48 px bottom margin (not the real work area). Taskbar on another edge, auto-hide, or secondary monitor: UNVERIFIED. |
| 2 | Pet rendering + states (idle, thinking, happy, sleeping, excited, alert) | ✅ | `Pet.tsx:25-47`, `index.css:38-210`; every state is set somewhere in `App.tsx` (sleep at `:169-184`, alert `:123,135,157`, thinking `:190,355`, excited `:194,297`, happy `:146,253`) | It is a **sprite, not a blob**; expressions are eyelid overlays at hardcoded pixel offsets (`Pet.tsx:17-23`). No `prefers-reduced-motion` handling anywhere. Visual quality UNVERIFIED (not launched). |
| 3 | Speech bubble + chat input (dark glass UI) | ✅ | `Bubble.tsx`, `ChatInput.tsx`, `App.tsx:410-420` | Single-line input; bubble max-height 100 px scroll. |
| 4 | System tray (show / hide / quit / open dashboard) | ✅ | `lib.rs:100-150` | Left-click toggles pet; menu works by code reading. Runtime UNVERIFIED. `show` re-docks (see #6). |
| 5 | Click-through of transparent areas | ❌ | no `set_ignore_cursor_events` anywhere in `src-tauri/src` or `src` | The whole 160x200 (up to 160x320 when chat open) rectangle swallows mouse input, including empty space around the pet. |
| 6 | Window drag + position persistence | 🟡 | Drag: `App.tsx:224-243` (4 px threshold then `startDragging`). Persistence: none. `reveal_window` always re-docks (`lib.rs:34`); setting `pet_position` is seeded (`db.ts:299`) and never read | Drag works; position is lost on every restart **and** on every tray Show / left-click re-show. |
| 7 | Dashboard window (tray open, pet pauses, close restores) | 🟡 | `lib.rs:66-88`, `Dashboard.tsx:83-85,102-104` | Works for the Esc / × path. Bugs: `close_dashboard` always shows the pet even if the user had hidden it (`lib.rs:86`); native close (taskbar right-click close, Alt+F4) has no handler: UNVERIFIED but code has no `CloseRequested`/`on_window_event`, so the dashboard window would be destroyed, tray "Open Dashboard" silently stops working (`get_webview_window` returns `None`) and the pet stays hidden. The pet has no way to open the dashboard itself. |
| 8 | Autostart with Windows | ❌ | no autostart plugin in `Cargo.toml`/`package.json`/capabilities | |
| 9 | Windows Service architecture (original plan) | ❌ | nothing in repo | Current design is one user-session process + tray. See §10/§11. |
| 10 | Ollama streaming chat, timeout, error handling | ✅ | `ollama.ts:83-194`, wired at `App.tsx:345-391` | Streaming NDJSON parse is correct, stop button aborts and keeps partial text, down/missing-model/timeout give distinct bubble messages. Caveats: 15 s timeout is for the **whole response** (`:9,92`), so a cold model load can trip it; production-build CORS from `http://tauri.localhost` to Ollama is UNVERIFIED (§7 B-6). |
| 11 | System prompt with real-time date/time/location | 🟡 | `ollama.ts:27-72` | Date/time is real and correct (computed per request). Location, name and timezone are **hardcoded literals**, not the `user_location`/`user_name`/`user_timezone` settings. |
| 12 | Conversation history (memory vs persisted) | 🟡 | `App.tsx:38,374-380` (React state, last 6 messages); table `conversations` never written | In-memory only; lost on restart. |
| 13 | Language switching EN/ID | ⚠️ | `Dashboard.tsx:1619-1637` saves `language`; nothing reads it (grep) | "Setting that lies". The model replies in Indonesian only because the prompt says to mirror the user (`ollama.ts:61`). UI strings are an unplanned EN/ID mix (see §6). |
| 14 | Tool use (Notion / Calendar via natural language) | ❌ | | Chat is text-in/text-out only. |
| 15 | Slash commands `/todo`, `/remind`, `/help` | 🟡 | `App.tsx:277-343`, `commands.ts` | `/todo` ✅ (with besok/hari ini/DD-MM parsing), `/help` ✅, `/remind` creates a row correctly but delivery is unreliable (#17). Unknown commands handled. |
| 16 | Todo list (quick capture + dashboard page) | ✅ | `/todo` → `addTodo`; `Dashboard.tsx:940-1213` add/toggle/delete/filter | No edit, no per-todo context (always `personal`, `App.tsx:295`). Delete has no confirm. |
| 17 | Reminders (scheduler that fires) | 🟡 | `reminders.ts:15-36`, `App.tsx:153-165` | A scheduler **does** exist (30 s poll in the pet window). It only shows a bubble: no OS notification, no sound, `repeat` column unused, no UI to list/cancel reminders, and delivery is lost when the pet window is hidden (B-2). |
| 18 | Habit tracker (CRUD, streaks, weekly view) | ✅ | `Dashboard.tsx:601-862,1313-1404`, `db-helpers.ts:145-202,311-365` | Add / toggle / soft-delete (confirm step), current+best streak, 7-day grid. No rename UI (`renameHabit` is dead). Streak = days with **any** habit ticked, not per-habit. |
| 19 | Pomodoro (timer, ring, save, pet sync, DND) | ⚠️ | `Pomodoro.tsx`, `Dashboard.tsx:864-930`, `App.tsx:188-204` | Timer is deadline-based (good), ring, session rows and pet sync are real. **Timer is destroyed on page navigation** (B-1). **DND is a setting only** (`dnd_during_pomodoro` read nowhere; there is no notification channel to suppress). |
| 20 | Body check-in | ✅ | `checkin.ts`, `App.tsx:119-127,245-263`, `CheckinPrompt.tsx` | Writes `mood_logs`; interval from setting. No history view. Uses emoji (violates the no-emoji rule). Dismissing is not recorded so it re-asks every 30 min (B-13). |
| 21 | Friction starter | ✅ | `friction.ts`, `App.tsx:129-139` | Simple idle nudge (30 min, 08-22h). Does not count dashboard activity. |
| 22 | End-of-day recap + recap history page | ✅ | `recap.ts`, `Dashboard.tsx:1216-1310`, `App.tsx:141-150` | Template string summary (no LLM). `mood` column never populated. Skipped for a day if the app was not running after `recap_time`. |
| 23 | Daily briefing | ❌ | `daily_briefing_enabled/time` seeded (`db.ts:303-304`) and editable (`Dashboard.tsx:1548,1555`); **no code consumes them** | Settings that lie. |
| 24 | Deadline radar | 🟡 | `getTodayStats().deadlines`, `getUpcoming()` (`db-helpers.ts:448-514`), `Dashboard.tsx:449-597` | A "deadlines today" count and a 5-item upcoming list over todos/reminders. No warning/escalation, and the `notion_assignments` half of the query is always empty. |
| 25 | Smart context (class hours) | ❌ | | |
| 26 | Context switcher (kuliah / org / freelance) | ❌ | `todos.context` column exists; `context_mode_logs` unused | |
| 27 | HR org reminder | ❌ | | |
| 28 | Distraction blocker / app usage tracking | ❌ | `app_usage` table only | Needs Rust active-window code; none exists. |
| 29 | Weekly pattern learner | ❌ | `pattern_data` table only | |
| 30 | Clipboard manager | ❌ | `addClipboardEntry`/`getClipboardHistory` exist in `db-helpers.ts:204-231` but are never called; no listener, no UI, no clipboard plugin | Dead code. |
| 31 | Screenshot + ask | ❌ | `screenshot_index` only | Also needs a vision model; `llama3.2:3b` is text-only. |
| 32 | Notification digest | ❌ | `notification_history` only | |
| 33 | Goal tracker | ❌ | `goals` table only | |
| 34 | Notion (token, read, write, cache sync) | ❌ | `cacheNotionAssignments` / `getUpcomingAssignments` exist, never called; no token input, no fetch | Webview `fetch` to `api.notion.com` would be blocked by CORS; needs Rust or `tauri-plugin-http`. |
| 35 | Google Calendar | ❌ | `gcal_token` key name only | |
| 36 | Spotify | ❌ | `spotify_history` table, `spotify_token` key name only | |
| 37 | Weather (Open-Meteo) | ❌ | `weather_cache` table only; "enable" button is a placeholder | |
| 38 | Integrations page: real status or hardcoded? | 🟡 | `Dashboard.tsx:1406-1539` | "on" is genuinely derived from a non-empty token setting (`getSettings` at `:1426`). But nothing can *write* a token, "setup" shows "Coming soon" (`:1435`), and Weather has no state at all. Effectively a static list. |
| 39 | Toothless sprite integrated | ✅ | `Pet.tsx:1`, `assets/toothless.png` | 439 KB PNG displayed at 96x96. Dashboard Home still shows an old blob SVG (`Dashboard.tsx:509-516`). |
| 40 | Animation coverage vs planned list | 🟡 | `Pet.tsx` states | Have: idle(blink), thinking, happy, sleeping, excited, alert (6). Missing: walk, working, eating, listening, rain, night (partly = sleeping at night), vibing, stretching, fly in/out. All motion is CSS on one still image; no sprite sheet. |
| 41 | SQLite: 20 tables | 🟡 | §4 | 8 fully used, 1 read-only/empty, 11 untouched. |
| 42 | Settings table | 🟡 | §5 | 9 of 19 seeded keys are read; 6 editable-but-ignored. |
| 43 | Auto-updater, onboarding, installer config | 🟡 | | Updater ❌, onboarding ❌. Bundle config exists (`active`, `targets:"all"`, icons) but metadata is template and no signing/installer options set. No production build was exercised here. |
| 44 | Token / secret storage | ❌ | `Dashboard.tsx:1415-1417,1426` | Not implemented. The only design in code is "tokens are rows in the `settings` table", i.e. **plaintext SQLite**. No keyring/Credential Manager code or crate. |

**Tally:** ✅ 11 · 🟡 12 · ⚠️ 2 · ❌ 19.

---

## 4. SQLite usage table

All 20 tables are created in `initTables` (`db.ts:31-317`) on every launch. "Written/Read" = traced to a live (reachable) call site.

| Table | Created | Written | Read | Notes |
|---|:-:|:-:|:-:|---|
| `settings` | yes | yes (`setSetting`, seeds) | yes | |
| `todos` | yes | yes (`addTodo`, `setTodoStatus`, `deleteTodo`) | yes | `notion_id`, `synced_at` columns unused; `context` always `personal`. `getTodos`/`completeTodo` dead. |
| `reminders` | yes | yes (`addReminder` via `/remind`; `markReminderSent`) | yes (poller, `getUpcoming`) | `body`, `repeat`, `todo_id` never set. No UI to view/cancel. |
| `habits` | yes | yes | yes | `description`, `frequency`, `target_time` unused. `getHabits`/`renameHabit` dead. |
| `habit_logs` | yes | yes | yes | UNIQUE(habit_id,date) makes the upsert correct. |
| `pomodoro_sessions` | yes | yes | yes | `context`, `ended_at` semantic: `ended_at` defaults to now. |
| `daily_recaps` | yes | yes | yes | `mood` always NULL. |
| `mood_logs` | yes | yes | partial | Only `hoursSinceLastMood` reads it. No history UI; recap does not use it. |
| `notion_assignments` | yes | **no** (only dead `cacheNotionAssignments`) | yes (stats + upcoming) | Reads always return 0 rows. |
| `conversations` | yes | **no** | no | Chat history is React state only. |
| `clipboard_history` | yes | no (dead helper) | no (dead helper) | |
| `pattern_data` | yes | no | no | |
| `app_usage` | yes | no | no | |
| `notification_history` | yes | no | no | |
| `weather_cache` | yes | no | no | |
| `spotify_history` | yes | no | no | |
| `context_mode_logs` | yes | no | no | |
| `screenshot_index` | yes | no | no | |
| `goals` | yes | no | no | |
| `notion_courses` | yes | no | no | |

**Schema management:** `CREATE TABLE IF NOT EXISTS` only. There is no `PRAGMA user_version`, no migration list, no `ALTER`. The `tauri-plugin-sql` built-in migrations (`Builder::add_migrations`) are not used. Any column change after a user's first run requires manual handling. **No indexes** besides PK/UNIQUE; irrelevant at current volume. **Concurrency:** the `PRAGMA foreign_keys=ON` (`db.ts:33`) applies to one pooled connection only (UNVERIFIED how many connections the plugin's pool opens; PRAGMA is per-connection in SQLite). Both windows call `getDb()` independently, so both run `initTables` at first launch (see B-14).

---

## 5. Settings audit

"Read by code" = a live call site reads the value. Seeded list is `db.ts:295-316`.

| Key | Seeded | Read by code | Editable in UI | Verdict |
|---|:-:|---|:-:|---|
| `language` | yes | **no** | yes (`Dashboard.tsx:1619`) | **Lies** |
| `theme` | yes | no | no | Dead seed |
| `pet_position` | yes | no | no | Dead seed |
| `pomodoro_duration` | yes | `Pomodoro.tsx:137` (on mount only) | yes | OK |
| `pomodoro_break` | yes | `Pomodoro.tsx:138` | yes | OK |
| `dnd_during_pomodoro` | yes | **no** | yes (toggle `:1550`) | **Lies** |
| `daily_briefing_time` | yes | **no** | yes (`:1555`) | **Lies** |
| `daily_briefing_enabled` | yes | **no** | yes (`:1548`) | **Lies** |
| `body_checkin_enabled` | yes | `checkin.ts:49` | yes | OK, live every poll |
| `friction_starter_enabled` | yes | `friction.ts:30` | yes | OK |
| `recap_time` | yes | `recap.ts:34` | yes | OK |
| `body_checkin_interval` | yes | `checkin.ts:52` | yes | OK |
| `notification_digest_interval` | yes | no | no | Dead seed |
| `ollama_model` | yes | `ollama.ts:18` | yes (`:1543`) | **Partially lies**: cached in a module variable, so a change made in the dashboard window is ignored by the pet window until restart (B-7) |
| `user_name` | yes | `App.tsx:132,144,254`, `Dashboard.tsx:88` | yes | Used in bubbles, **not** in the system prompt (`ollama.ts:48,53` hardcode "Bas") |
| `user_timezone` | yes | **no** | yes (`:1544`) | **Lies**; prompt hardcodes `Asia/Jakarta` (`ollama.ts:30,39,44`) |
| `user_location` | yes | **no** | no | Prompt hardcodes "Medan" (`ollama.ts:52`) |
| `notion_sync_interval` | yes | no | no | Dead seed |
| `clipboard_max_items` | yes | only in dead `addClipboardEntry` | no | Dead |
| `notion_token`, `gcal_token`, `spotify_token` | **no** | `Dashboard.tsx:1426` (presence check) | **no** | Nothing can set them |

---

## 6. Hardcoded / fake data findings

No fake sample records ("Laporan TBA", "Meeting HR", fake stats) were found; a search for `laporan|TBA|meeting hr|sample|lorem|dummy|mock|fake` hit nothing. The stat tiles are real queries. What exists is static UI that implies state, plus user-specific literals:

- `src/Dashboard.tsx:497-517` Home "pet preview": a hand-drawn blob SVG, not the Toothless sprite.
- `src/Dashboard.tsx:527,530,533` hardcoded "Nox · idle", "Paused while dashboard is open", "paused". Not wired to any state.
- `src/Dashboard.tsx:1414-1419` `INTEGRATIONS` is a static list; `:1482` Weather "no token needed, just enable" with an "enable" button that only shows the placeholder.
- `src/Dashboard.tsx:1434-1435,1503` placeholder note **"Coming soon — integration will be set up here."**
- `src/lib/ollama.ts:48,52,53` "Bas's screen", "Medan, North Sumatra", "Bas (Sebastian)"; `:29,39,44,51` `Asia/Jakarta`/WIB; `:68` example reply in Indonesian.
- `src/App.tsx:132,144,254` and `Dashboard.tsx:89` fall back to the literal `"Bas"`.
- `src/lib/db.ts:311-313` seeds `Bas` / `Asia/Jakarta` / `Medan` (fine for a personal build, wrong for a distributable one).
- `src/Dashboard.tsx:360-365,354,441,1268` Indonesian subtitles/locale (`"Kebiasaan harian"`, `"Fokus tanpa gangguan"`, `"Semua tugas"`, `id-ID`) regardless of the `language` setting; `:437` "besok" next to English "today"/"overdue" at `:428-429`; `:1550` "DND saat pomodoro". Language is mixed per string rather than chosen.
- `src/App.tsx:23` default bubble "Hey! I'm Nox."; `src/App.tsx:321` and `Dashboard.tsx:1190` use the magic string `notes === "reminder"` as a flag for "reminder saved as a todo".
- `src/lib/checkin.ts:15-18` **emoji** in the mood list (rendered at `CheckinPrompt.tsx:70`). Violates the no-emoji rule in your global design rules; replace with icons.
- `index.html` / `Cargo.toml` / `tauri.conf.json`: template metadata ("A Tauri App", authors "you", favicon `/vite.svg`). `README.md` is the untouched Tauri template. `src/App.css` is the unused template stylesheet; `src/assets/react.svg`, `public/*.svg` unused.
- TODO/FIXME/HACK comments: **none**.

---

## 7. Bugs & risks

Severity is my judgement. "UNVERIFIED" = reasoned from code and platform behaviour, not observed at runtime. Fixes are described only; nothing was applied.

| ID | Sev | Area | Description | Evidence | Suggested fix (not applied) |
|---|:-:|---|---|---|---|
| B-1 | **High** | Pomodoro | Timer state lives in `<Pomodoro/>`, which is mounted only while `page === "pomodoro"`. Switching tab (or pressing 1-7) unmounts it: interval cleared, running session discarded without a row, and because it never emits `idle` the pet stays in "Focus mode / thinking" indefinitely. | `Dashboard.tsx:414`; `Pomodoro.tsx:164-201` (cleanup clears interval; no unmount emit/save); `App.tsx:190-193` | Own the timer above the page switch (Dashboard root) or in the pet window / Rust; emit `idle` on teardown; save abandoned session. |
| B-2 | **High** | Reminders | Reminder rows are marked `sent` *before* the UI shows them, and the only UI is the pet bubble. The pet window is hidden while the dashboard is open (`open_dashboard`) and when the user picks "Hide". A reminder due then is consumed and never seen. Opening the chat also resets the bubble (`App.tsx:106`), wiping a displayed reminder. No OS notification channel exists. | `reminders.ts:22-26`; `lib.rs:71`; `App.tsx:99-108,153-165` | Mark sent only after display is acknowledged; fire an OS notification (notification plugin); persist missed reminders for the next show. |
| B-3 | Med-High | Window lifecycle | Dashboard has `decorations:false` but is **not** `skipTaskbar`, so it can be closed natively. No `CloseRequested`/`on_window_event` handler: window would be destroyed; `open_dashboard`/`close_dashboard` use `if let (Some, Some)` so they then silently do nothing and the pet stays hidden. **UNVERIFIED** (not run). | `lib.rs:66-88` (no window-event hook), `tauri.conf.json` dashboard `skipTaskbar:false` | Intercept `CloseRequested`, `prevent_close()` and hide instead. |
| B-4 | Med | Window lifecycle | `close_dashboard` unconditionally shows the pet, overriding a user's tray "Hide". | `lib.rs:86` | Remember pet visibility before hiding and restore that. |
| B-5 | Med | Ollama | One 15 s timer covers the *entire* response, started before the request. A cold model load (Ollama unloads idle models after ~5 min) plus generation can exceed it; the partial answer is discarded and replaced by "Taking too long". No `keep_alive`. | `ollama.ts:9,92-96,98-101`; `App.tsx:384-388` | Time out on first token only (longer for the first), pass `keep_alive`, keep partial text on timeout. |
| B-6 | Med | Ollama / prod | Chat uses webview `fetch` to `http://localhost:11434`. In a **production** Windows build the page origin is `http://tauri.localhost`; Ollama's default CORS allow-list (localhost/127.0.0.1/0.0.0.0, `tauri://*`, ...) probably does not include it. Dev (`http://localhost:1420`) is allowed, so this would first appear in the installer build. **UNVERIFIED.** | `ollama.ts:5`; `tauri.conf.json` `csp:null`, no http plugin | Smoke-test a release build; if blocked, proxy through a Rust command or `tauri-plugin-http`. |
| B-7 | Med | Settings | `ollama_model` is cached in a module variable and only refreshed after an error, so editing the model in the dashboard does nothing for the already-running pet window. The comment claims otherwise. | `ollama.ts:11-23,125,164` | Read the setting per request (it is one indexed lookup) or listen for a settings event. |
| B-8 | Med | Settings | Four editable controls persist values nobody reads (language, timezone, DND, daily briefing toggle+time). | §5 | Wire them, or hide them until the feature exists. |
| B-9 | Med | Chat prompt | System prompt ignores `user_name`, `user_location`, `user_timezone`. | `ollama.ts:29-53` | Build from settings. |
| B-10 | Med | Window | Dragged position never saved; every tray Show / left-click re-docks to the corner. | `lib.rs:31-35`; no persistence code | Save `outer_position` on move; restore with off-screen clamp to current monitors. |
| B-11 | Med | Window | No click-through: the transparent area blocks the apps behind it. | no `set_ignore_cursor_events` | Toggle ignore-cursor from pointer-over-pet hit test (needs a Rust command + cursor events). |
| B-12 | Med | UX | Check-in / friction / recap / reminder bubbles are pushed into the pet window even when it is hidden, and the check-in handler overwrites an in-flight streamed reply (does not check `isStreaming`). | `App.tsx:119-165` | Gate scheduler callbacks on window visibility and on `isStreaming`; queue instead. |
| B-13 | Low-Med | Check-in | Dismissing the prompt records nothing, so the same poll asks again within 30 min regardless of `body_checkin_interval`. | `App.tsx:265-270`, `checkin.ts:6,53-54` | Record a snooze timestamp. |
| B-14 | Med | DB init | No schema versioning. Both windows run `initTables` independently on first launch (dashboard runs a query on mount at `Dashboard.tsx:88`), so concurrent `CREATE TABLE` + seed + `PRAGMA` can hit `SQLITE_BUSY` on a fresh database. **UNVERIFIED.** `PRAGMA foreign_keys=ON` is per-connection (see §4). | `db.ts:5-10,31-34`; `main.tsx` | Run schema setup once in Rust via plugin migrations (`user_version`), not from each webview. |
| B-15 | Low | SQL | Double-quoted string literals `datetime("now")` in SQL. SQLite treats `"now"` as a string only through the legacy DQS fallback; it works today but is deprecated and fails if compiled with `SQLITE_DQS=0`. Other statements use single quotes. | `db-helpers.ts:32,107,135` | Use `'now'`. |
| B-16 | Low | Dates | `getUpcomingAssignments` compares against UTC `date('now')` (the UTC+7 bug class) and interpolates `${days}`. Dead code today. | `db-helpers.ts:295-304` | Fix or delete before Notion lands. |
| B-17 | Low | Recap | Recap only fires if the app is running after `recap_time` that day; never backfills a missed day; counts frozen at generation time; `mood` never filled although `mood_logs` exists. | `recap.ts:34-48,109-117` | Backfill on launch; read last mood. |
| B-18 | Low | Upcoming | `getUpcoming` has no lower date bound: old overdue items fill all 5 slots. | `db-helpers.ts:497-513` | Cap overdue or sort overdue separately. |
| B-19 | Low | Dev only | React StrictMode double-mount: first reminder poller instance can mark rows `sent` then drop the callback because `stopped` was set during the `await`. | `reminders.ts:21-26`, `main.tsx:11` | Re-check `stopped` before marking sent. |
| B-20 | Low | Window | Resize grows upward from the bottom edge with no clamp, so a pet dragged near the top can grow off-screen; docking uses primary monitor size only and ignores monitor origin/work area. | `lib.rs:15-23,50-63` | Clamp to `current_monitor()` bounds. |
| B-21 | Low | Friction | Dashboard activity is not counted as interaction, and it nudges during an active pomodoro. | `friction.ts:12-14,35-46` | Reset on dashboard focus; skip when pomodoro active. |
| B-22 | Low | Accessibility | Checkbox/toggle are `div`s with `onClick` and no role/tabindex (`Dashboard.tsx:791-814,1833-1862`); delete buttons use `visibility:hidden` so keyboard users can never reach them (`:854,1206`); icon-only sidebar buttons rely on `title`; secondary text is `rgba(255,255,255,.25-.3)` on `#0d0f14`, roughly 2.0-2.6:1 (fails 4.5:1); no `prefers-reduced-motion`. | as cited | Use `<button>`/`<input type=checkbox>`, show controls on focus, raise text alpha, add reduced-motion media query. |
| B-23 | Low | Errors | Every failure is `console.error` only; the user sees nothing (e.g. a failed settings write at `Dashboard.tsx:1607-1609` leaves the control showing the new value). | `Dashboard.tsx:631-641`, `:1603-1610` | Surface errors in a toast/inline row. |
| B-24 | Low | Ollama | Any error body containing the word "model" is reported as "Model not loaded. Run `ollama pull`", which is misleading for e.g. out-of-memory. | `ollama.ts:127,166` | Match the specific Ollama "not found" text. |
| B-25 | **Med (process)** | Project | **No version control**, no backups, no CI, no tests. | `git status` fails | `git init` first. |

---

## 8. Security & privacy findings

**Good**
- The only network call is `fetch("http://localhost:11434/api/chat")` (`ollama.ts:5,101`). Nothing else leaves the machine. No analytics, no remote fonts or scripts (`index.html` has none; icons are an npm-bundled webfont).
- SQL is parameterised everywhere user input is involved (`db.ts:21-27`, all helpers). The two interpolated fragments are a constant `ORDER BY` (`db-helpers.ts:82`) and an unused numeric `${days}` (`:300`).
- No `dangerouslySetInnerHTML`, `eval` or `innerHTML` anywhere; bubble text is rendered as text.
- No conversation, clipboard or todo content is logged. The only `console.log` is the literal "Nox DB ready" (`App.tsx:52`).

**Concerns**
1. **CSP is `null`** (`tauri.conf.json` `app.security.csp`). Combined with `sql:default` + `sql:allow-execute` granted to every window, any script injection becomes arbitrary SQL against the user's database. Low likelihood now (no remote content, no HTML injection), but it should be a real CSP (`default-src 'self'; connect-src ipc: http://ipc.localhost http://localhost:11434; style-src 'self' 'unsafe-inline'`).
2. **Capability is over-broad:** one capability for both windows; `opener:default` is granted but unused; `core:window:allow-minimize` is granted to the pet. `http:default` is *not* present, so there is no outbound HTTP scope to tighten yet, but when Notion/Calendar arrive they will need one, scoped to explicit hosts.
3. **Planned token storage is plaintext.** The only mechanism in the code is `settings.notion_token` / `gcal_token` / `spotify_token` (`Dashboard.tsx:1415-1426`), which means OAuth/API secrets in an unencrypted SQLite file under the app data directory (the same file backups and sync tools will copy). Use Windows Credential Manager (keyring crate via a Rust command) and keep only a "connected" flag in `settings`.
4. **The database is unencrypted** and contains mood logs, todos and habits. Acceptable for a local personal tool; worth stating before any sync or sharing feature.
5. **Ollama trust:** the app assumes whatever answers on `localhost:11434` is Ollama. Fine for single-user.
6. **Future-risk items** (none implemented): clipboard history and screenshot OCR will store passwords/secrets verbatim in `clipboard_history`/`screenshot_index`; add exclusion rules and a purge control before building them.

---

## 9. Code quality & tech debt

- **`src/Dashboard.tsx` is 1,864 lines** (38% of the codebase): shell, titlebar, sidebar, seven pages, a settings framework and four widgets in one file. Split into `src/dashboard/{Shell,pages/*,widgets/*}.tsx`. The Integrations and Settings pages are the first candidates because they are about to grow.
- **Inline styles everywhere, no theme.** The same `rgba(255,255,255,0.0x)` literals and the accent `#00e5a0` are repeated hundreds of times; there is no token layer or CSS variables despite your design rules requiring one. The shared fragments at `Dashboard.tsx:51-77` are a start. The glass panel style is copy-pasted into `Bubble.tsx:7`, `ChatInput.tsx:44-55`, `CheckinPrompt.tsx:11-21`. Tailwind is installed but unused (§2.2).
- **Duplicated logic:** local-date formatting is re-implemented in five places (`db-helpers.ts:12,354`, `commands.ts:13`, `Dashboard.tsx:434,1326`); `HISTORY_LIMIT = 6` exists twice (`App.tsx:19`, `ollama.ts:8`); the `one(sql,args)` count helper is duplicated (`db-helpers.ts:451`, `recap.ts:71`); the same "today's habit completions" `JOIN` SQL is duplicated between `getTodayStats` and `generateRecap`.
- **Dead code:** `getTodos`, `completeTodo`, `getHabits`, `renameHabit`, `addClipboardEntry`, `getClipboardHistory`, `getUpcomingAssignments`, `cacheNotionAssignments`; Rust commands `hide_window` and `show_window` are registered but never invoked from JS (`lib.rs:37-45,154-159`); `App.css`, `react.svg`, `public/*.svg`.
- **Hardcoded constants coupled across languages:** `WIN_W/WIN_H` in `lib.rs:8-9` must match `tauri.conf.json`; the eyelid offsets in `Pet.tsx:17-23` are tied to a specific PNG.
- **Magic strings as flags:** `notes === "reminder"`; status strings `'pending'/'done'/'sent'` unchecked.
- **Asset weight:** `toothless.png` is 439 KB for a 96 px render; resize to 2x of display size or ship a spritesheet.
- **Folder structure:** `Dashboard.tsx` sits at `src/` root while `App.tsx`'s parts live in `components/`; `lib/` mixes DB access, schedulers and parsers. A `features/{pet,dashboard}` + `data/` split would fit what is already there.
- **Tests: none.** No test runner in `package.json`. Highest value per hour: (1) `commands.ts` (already pure, its header says "stays testable"); (2) `getHabitStreaks` day-run logic; (3) the recap/checkin time gates; (4) the Ollama NDJSON stream parser with a fake `ReadableStream`; (5) an SQL smoke test of `initTables` + each helper against an in-memory SQLite.
- **Positives worth keeping** (stated once, for calibration): scheduler functions return stop callbacks; Pomodoro uses wall-clock deadlines; one local-date helper plus UTC-stamp helper are documented; timezone-sensitive SQL consistently uses `'localtime'`.

### 9.1 Date / timer / sync checklist (Step 5)

- **`toISOString().split('T')[0]` as "today":** **none.** The two `toISOString()` uses (`db-helpers.ts:16`, `commands.ts:21`) produce full UTC *timestamps* for timestamp columns, which is correct. Local calendar days use `todayLocal()`/`localDate()`. The only UTC-day leak is the dead `getUpcomingAssignments` (B-16).
- **Intervals/timeouts, all with cleanup:** App sleep tick 60 s (`App.tsx:182`), checkin 30 min (`checkin.ts:35`), friction 5 min (`friction.ts:46`), recap 60 s (`recap.ts:50`), reminders 30 s (`reminders.ts:30`), Pomodoro 250 ms while running (`Pomodoro.tsx:199`). All return a clearing function, so StrictMode double-registration is handled (modulo B-19). `ollama.ts` timeout cleared on every exit path. `revertTimer`/`flashTimer` refs are cleared on use but **not on unmount** of `App` (harmless: App never unmounts). **No cursor polling exists**; idle cost is two cheap SQLite lookups per minute plus one per 30 s. Pomodoro's 250 ms tick re-renders its component 4x/s while running (acceptable).
- **Cross-window:** one-way event dashboard to pet; everything else via DB. No pet to dashboard push, so the dashboard shows stale data if left open (mostly moot as the pet is hidden then). Settings changes do not propagate (B-7).
- **Rust:** only 4 commands, all registered; no panics except the benign `unwrap`. Multi-monitor/DPI: scale factor is applied correctly in docking and resize, but only the primary monitor is considered and saved positions don't exist (B-10, B-20).
- **Ollama failure modes:** down gives "Can't reach Ollama. Is it running?"; missing model gives the `ollama pull` hint; slow gives timeout message (B-5). **Prompt growth is bounded**: last 6 messages (`ollama.ts:109`), `num_predict: 80` so replies can end mid-sentence.

---

## 10. Gap vs. original plan

The original planning document was not in the repo, so "plan" below is the 44-item checklist in the audit brief.

**Planned, does not exist:** Windows Service architecture; autostart; click-through; position persistence; tool use; daily briefing trigger; DND behaviour; smart context; context switcher; HR org reminder; app-usage/distraction tracking; weekly pattern learner; clipboard manager; screenshot-and-ask; notification digest; goal tracker; Notion, Google Calendar, Spotify, weather; token storage; updater; onboarding; 10 of 16 planned animations; real README.

**Exists, not in the checklist:** nothing substantial. Minor unplanned extras: keyboard shortcuts in the dashboard (1-7, Esc), a 7-day habit grid, streak counters, a sleeping-at-night behaviour, Indonesian date parsing in `/todo` (`besok`, `hari ini`, `DD/MM`), `/remind ... jam HH:MM`.

**Exists but structurally ahead of the code:** 11 database tables and 7 settings seeds for features that have no implementation. They are harmless but they make the schema look more complete than the product is.

**Architecture drift:** the plan implied a background Windows Service; reality is a user-session Tauri app where all scheduling runs *in the pet's webview*. That is the root of B-2 and B-12: if the pet window is hidden or the app is closed, nothing runs. Whether that is acceptable is the central design decision (§11 Q1).

---

## 11. Open questions for Bas

1. **Where should scheduling live?** Reminders, recap, check-ins and the future daily briefing all run in the pet's webview timers today, so they stop when the pet is hidden or the app is closed. Move them to Rust (reliable, can fire OS notifications, enables autostart-and-forget), or accept "only while the pet is visible"?
2. **Windows Service: still wanted?** The current design needs none of it; a service cannot show UI or read the user's clipboard/active window anyway. Drop it from the plan?
3. **Reminders and OS notifications:** is a bubble enough, or should they also fire a Windows toast (needs `tauri-plugin-notification`)? Should missed reminders replay on next launch?
4. **What should "DND during pomodoro" actually suppress?** Check-ins/friction/recap bubbles only, or also Windows notifications (needs Focus Assist integration)?
5. **Where do Notion/Google/Spotify secrets live?** Windows Credential Manager via Rust (recommended) or accept plaintext in SQLite for v1? And do API calls go through Rust or `tauri-plugin-http`?
6. **Is Nox personal or distributable?** "Bas", Medan, `Asia/Jakarta` are hardcoded. If distributable: needs onboarding, settings-driven prompt, a real README, installer metadata, updater. If personal: strip the unused settings UI and stop pretending it is generic.
7. **The 11 unused tables:** keep as a roadmap, or drop them and add tables when each feature is built (with real migrations)?
8. **Language setting:** should it switch UI strings, the model's reply language, or both? Today neither is wired and the UI mixes EN/ID per string.
9. **Pomodoro home:** keep it in the dashboard (then lift it above the page switch) or run it in the pet/Rust so it survives dashboard closure and drives the pet directly?
10. **Design rules:** your global rules call for a token layer, no emoji and WCAG contrast. Should the dashboard be migrated to CSS variables/tokens now, or after the feature work?
11. **Is Ollama a hard prerequisite?** Should Nox detect it, offer to install/pull the model, or bundle instructions only?

---

## 12. Proposed priority order (a PROPOSAL, for discussion)

Effort: S = under half a day, M = 1-3 days, L = a week or more.

### Now (stop the bleeding; none adds features)
| Item | Effort | Why |
|---|:-:|---|
| `git init`, first commit, `.gitignore` check | S | No history or backup at all (B-25). |
| Fix Pomodoro lifetime (B-1) and decide what DND means | S | Currently loses a running session on tab change and strands the pet state. |
| Reminder delivery: mark sent only after shown; handle hidden pet; add OS notification (B-2) | M | The headline feature that "exists" can silently drop its output. |
| Dashboard close handling and restore-previous-visibility (B-3, B-4) | S | Possible dead tray item / stuck hidden pet. |
| Remove or wire the lying settings; prompt reads name/location/timezone/model per request (B-7, B-8, B-9) | S | Trust: UI must not promise what code ignores. |
| Build and smoke-test a **release** bundle on Windows, including Ollama CORS (B-6) | S | Everything so far was only verified in dev; this is the biggest unknown. |
| Real README: prerequisites (Rust+MSVC+WebView2, Node, `ollama pull llama3.2:3b`), WSL caveat | S | A fresh clone cannot start (§Environment). |

### Next (foundations that unblock the rest)
| Item | Effort | Why |
|---|:-:|---|
| Schema migrations via plugin (`user_version`), single init point (B-14) | M | Required before any table gets a new column. |
| Window polish: persist position with monitor clamp, click-through, work-area docking (B-10, B-11, B-20) | M | Largest visible gap in the "desktop pet" feel. |
| Autostart plugin | S | One crate + capability. |
| Persist conversations; first-token timeout + `keep_alive` (B-5) | S | Cheap and makes chat feel reliable. |
| Daily briefing scheduler (setting already exists) | M | Completes an advertised setting. |
| Split `Dashboard.tsx`, introduce token/CSS-variable layer, drop Tailwind or use it, remove emoji | M | Makes everything after this cheaper; satisfies design rules. |
| Test harness + tests for `commands.ts`, streaks, time gates, stream parser | S | Pure code already written for testability. |
| Decide secrets storage (Q5) and CSP/capability tightening | M | Must precede any integration. |

### Later (new capability)
| Item | Effort | Why |
|---|:-:|---|
| Notion read + cache sync (uses existing `notion_assignments`) | L | First real integration; feeds deadline radar. |
| Google Calendar, weather (Open-Meteo, no token), Spotify "vibing" | M each | Weather is the cheapest win (no auth). |
| Tool use / natural-language actions | L | Needs a model stronger than 3B or a rigid intent layer. |
| Clipboard history, notification digest, app-usage tracking | M-L | Need Rust listeners and a privacy/exclusion design (§8.6). |
| Screenshot + ask | L | Needs a vision-capable local model. |
| Remaining animations / sprite sheet; updater; onboarding | M-L | Polish and distribution. |
| Windows Service | n/a | Recommend dropping (Q2). |

---

## Appendix: environment notes (Step 8)

- **WSL/Windows `node_modules` mismatch.** `node_modules` was installed from Windows: `.bin` contains `.cmd`/`.ps1` shims and `node_modules/@rollup` has only `rollup-win32-x64-gnu` / `-msvc`, with no Linux binaries. Under WSL only pure-JS tools work (`tsc` ran fine); `vite`/`esbuild`/`tauri` would fail. Run dev/build from Windows (PowerShell), not WSL, or reinstall separately per OS (do not share one `node_modules`).
- **No Rust in WSL** (`cargo` not found), so `cargo check` was impossible here. `src-tauri/target/debug` was built on Windows (`libnox_lib.rlib` 380 MB, dated 21 Sep).
- **Windows build prerequisites a fresh clone needs, none documented:** Rust (MSVC toolchain), Visual Studio Build Tools with the Windows SDK, WebView2 runtime, Node, and a running Ollama with `llama3.2:3b` pulled.
- **Dev server is fixed to port 1420** (`vite.config.ts` `strictPort: true`); a stray process on 1420 breaks `tauri dev`.
- **`README.md`** exists but is the unmodified Tauri template (no setup, no Ollama requirement, no architecture).
- **`.gitignore`** exists but the directory is not a repository. `src-tauri/gen/schemas` is listed as ignored but present on disk (harmless).
- **Two webviews run permanently** (dashboard is created hidden), costing memory for a window that is usually closed; consider creating it lazily.
