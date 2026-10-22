# Nox

A small desktop pet assistant for Windows. Nox (a Toothless sprite) sits in the
bottom-right corner of the screen, chats through a local Ollama model, and keeps
quick todos, reminders, habits, pomodoros, mood check-ins and a daily recap.
Everything runs and is stored locally; the only network call goes to Ollama on
`localhost:11434`.

## Architecture

- **Tauri v2** app with a tray icon and two windows built from one Vite + React + TypeScript bundle (`src/main.tsx` picks the view by window label).
- **`main`**: the transparent, always-on-top pet overlay (`src/App.tsx`). It owns all timers: reminders, check-ins, friction nudge, recap, and the pomodoro engine (`src/lib/pomodoroEngine.ts`).
- **`dashboard`**: a regular dark window (`src/dashboard/`: `Dashboard.tsx` shell, `pages/`, `widgets/`) for habits, todos, pomodoro, recap and settings. It is a view plus remote control. The pet is paused while it is open.
- Windows talk through Tauri events (`pomodoro:*`, `settings:changed`) and the shared SQLite database.
- **Rust**: `src-tauri/src/lib.rs` has the tray menu and dashboard open/close; `src-tauri/src/pet.rs` places the pet (saved position, kept on screen, default dock) and runs click-through, a cursor poll against the hit regions the page reports.
- **SQLite** through `tauri-plugin-sql`. The schema and default settings are numbered migrations in `src-tauri/migrations/`, run once by Rust at startup; queries live in `src/lib/db-helpers.ts`.
- **Chat**: `src/lib/ollama.ts` streams from Ollama, with a system prompt built from settings on every message.
- **UI strings**: `src/lib/i18n.ts` (English / Indonesian, chosen by the `language` setting).

## Prerequisites (Windows)

1. **Rust** with the MSVC toolchain: install from <https://rustup.rs> and pick the default `x86_64-pc-windows-msvc`.
2. **Visual Studio Build Tools** with the "Desktop development with C++" workload (includes the MSVC compiler and the **Windows SDK**).
3. **WebView2 Runtime**: preinstalled on Windows 11. Otherwise get the Evergreen runtime from Microsoft.
4. **Node.js** (LTS) with npm.
5. **Ollama** from <https://ollama.com>, then pull the default model:

   ```powershell
   ollama pull llama3.2:3b
   ```

   Ollama must be running whenever you chat with Nox. The model can be changed in Settings.

## Run

From **Windows PowerShell**:

```powershell
cd D:\nox
npm install
npm run tauri dev
```

Release build (installers end up in `src-tauri\target\release\bundle\`):

```powershell
npm run tauri build
```

Type checks and tests without starting the app:

```powershell
npx tsc --noEmit
npm test
cd src-tauri; cargo check
```

## Gotchas

- **WSL:** do not run npm or tauri from WSL against this folder, and never share one `node_modules` between WSL and Windows. npm installs platform-specific binaries (rollup, esbuild), so a Windows install breaks under Linux and the other way round. Use PowerShell.
- **`cargo` not found** right after installing Rust: open a new terminal, or add `%USERPROFILE%\.cargo\bin` to `PATH`.
- **git "dubious ownership"** on `D:\nox` (the drive was created by another Windows account): run `git config --global --add safe.directory D:/nox` once.
- **Port 1420** is fixed for the dev server (`strictPort`). Stop whatever else is using it.

## Data

The database is `nox.db` in the app config directory:

```
%APPDATA%\com.lenovo.nox\nox.db
```

It sits next to `nox.db-wal` / `nox.db-shm` (WAL mode). Delete all three to start fresh. The tables and default settings are recreated on the next launch.

### Schema changes

The schema is versioned with `tauri-plugin-sql` migrations (sqlx records them in
the `_sqlx_migrations` table). To change it:

1. Add `src-tauri/migrations/000N_<what>.sql` with the next number.
2. Register it in `migrations()` in `src-tauri/src/lib.rs`.

Never edit a migration that has already shipped: sqlx stores each one's
checksum and refuses to start when it changes. Foreign keys are not enforced
consistently (the pragma is per connection), so helpers delete dependent rows
themselves.

## Security notes

- **What is stored:** `nox.db` (see Data) holds your settings (name, location,
  timezone), todos, reminders, habits, mood check-ins, pomodoro sessions, day
  recaps and the chat history. It is plain, unencrypted SQLite readable by
  anything running as your Windows user. `/clear` deletes the chat history.
- **Network:** only Rust talks to the network, and only to Ollama on
  `localhost:11434`. The webviews have a strict CSP (`app.security.csp` in
  `tauri.conf.json`): no remote scripts, styles, images or connections. Dev
  mode uses `devCsp`, which additionally allows Vite's inline module script
  and HMR socket on `ws://localhost:1420`.
- **Permissions:** each window gets its own capability file in
  `src-tauri/capabilities/` (`pet.json`, `dashboard.json`) with only what it
  uses.
- **Tokens (Phase 2):** API tokens (Notion etc.) will go to the Windows
  Credential Manager, never into `nox.db` or a settings file.

## Slash commands (pet chat)

| Command | Does |
|---|---|
| `/todo <task> [today \| tomorrow \| 25/12]` | Quick-capture a todo (also accepts `hari ini`, `besok`) |
| `/remind <thing> at 09:00` | Reminder at a time (also `jam 09:00`, `besok jam 09:00`) |
| `/clear` | Forget the chat history (it is kept across restarts otherwise) |
| `/dashboard` | Open the dashboard |
| `/help` | List the commands |
