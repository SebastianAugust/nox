# Queue 04: Automatic backup of nox.db

Status: **done**. Gate green: `tsc`, `build`, `npm test` (203), `cargo check`; `cargo test` 31.

This step was interrupted by a laptop crash after `backup.rs`, the migration and the command
registration were written. It was resumed and finished in a second session (2026-11-04).

## Crash recovery

- `src-tauri/migrations/0009_backup.sql` was **408 NUL bytes** (the write never reached disk).
  Rewritten. Every other file touched on 2026-11-04 was scanned for NUL bytes: all clean.
- `cargo check` was **red**: the `setup` closure in `lib.rs` borrowed `held`, which it may
  outlive (E0373). Fixed with a `daily_backup` bool and a `move` closure.
- `backup.rs` itself was complete and correct. One existing test failed on Windows only: it
  created `NOX-20261101-0900.db` next to `nox-20261101-0900.db`, which on a case-insensitive file
  system is the same file. The test now uses a name that does not collide; the code was right.

## What was built

- **Backup in Rust** (`src-tauri/src/backup.rs`):
  - `backup_now(folder?)` runs `VACUUM INTO` to `nox-YYYYMMDD-HHMM.db` (`-2`, `-3`… when the
    minute repeats) and creates the folder if needed. It then opens the copy read-only and runs
    `PRAGMA integrity_check`; a copy that is not `ok` is deleted and reported. It returns the file
    name, size, time and how many old backups were removed.
  - The live file is never copied directly.
- **Retention:** `backup_keep` (default 14, 1-365). It deletes only files named exactly
  `nox-YYYYMMDD-HHMM[-n].db` in that folder. Folders and other files (`nox.db`, `*.bak`,
  `my-nox-…`) are never touched.
- **Schedule:**
  - `backup_enabled` (default on). Runs at the first start of each day (`last_backup_date`) in the
    background, so startup never waits on it.
  - **Before pending migrations:** `run()` checks `_sqlx_migrations` before the SQL plugin opens
    the database, and makes a backup if a migration is pending. If that backup fails, no migrations
    are registered (nothing is applied silently), the app runs on the old schema, and Home and
    Settings show why (`backup_hold`).
- **Task 0, folder detection:** `backup_detect_folders` looks for Google Drive for desktop and
  OneDrive:
  - Google Drive: `X:\My Drive` or `X:\Drive Saya` on any drive letter, `%USERPROFILE%\My Drive`,
    `%USERPROFILE%\Google Drive`.
  - OneDrive: `%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`,
    `%USERPROFILE%\OneDrive`.

  Each is offered as `<found>\NoxBackups`. **Nothing is chosen silently**: an empty
  `backup_folder` means "not chosen yet" and uses `Documents\NoxBackups`, and the UI says so. Home
  shows a one-time offer ("Use Google Drive" / "Use OneDrive" / "Not now"). Settings always lists
  what was found, and Bas can also type any path. The UI notes that Drive or OneDrive syncs the
  folder and Nox uploads nothing. On this laptop, detection finds `G:\My Drive` and
  `C:\Users\Sebastian\OneDrive`.
- **Folder validation:** the path must be absolute, on a drive that exists, use no `<>"|?*` or
  control characters, be at most 240 characters, not be a file, and not be inside Nox's own data
  folder.
- **Settings → Backup:** on/off, folder (text path with validation and an inline error), found
  folders as one-click choices, keep count (1-365, validated), "Back up now", last backup time and
  result, "Open backup folder" (Explorer), and the manual restore steps. No folder picker: the
  dialog plugin is not in the project, and a validated text path plus the detected folders was
  enough, so it was not added.
- **Failure handling:** a small, non-blocking notice on Home and at the top of Settings → Backup.
  "Hide for today" hides it until the next day (`backup_warn_dismissed`), and a later successful
  backup clears it. Migrations held back at startup are always shown, because the app is running
  on the old database until that is fixed.
- **i18n:** all strings in en and id.
- **Docs:** a "Backups" section in `docs/ARCHITECTURE.md` with the manual restore steps, plus the
  `backup:status` event in the events table.

## Files changed or added in this step

- `src-tauri/src/backup.rs` (new)
- `src-tauri/migrations/0009_backup.sql` (new)
- `src-tauri/src/lib.rs` (`mod backup`, migration 9, pre-migration check in `run()`, daily
  backup in `setup`, `backup_*` commands)
- `src/lib/backupLogic.ts` (new, pure), `src/lib/backup.ts` (new), `src/lib/backup.test.ts` (new)
- `src/dashboard/widgets/BackupSettings.tsx` (new), `src/dashboard/widgets/BackupNotice.tsx` (new)
- `src/dashboard/pages/Settings.tsx` (Backup card), `src/dashboard/pages/Home.tsx` (notice)
- `src/lib/i18n.ts` (`backup.*`), `src/styles/dashboard.css` (Backup section)
- `docs/ARCHITECTURE.md`

`src-tauri/src/db.rs` shows a 02:59 timestamp from the crashed session, but `git diff` shows no
content change in it (`with_pool` is reused as it was).

## Migrations added

- **0009** `backup settings`: `backup_enabled` = `true`, `backup_folder` = `''`, `backup_keep` = `14`.

## Tests

- Rust (`backup.rs`):
  - Retention with temp dirs: 16 backups leave the newest 14, and other files and a folder with a
    backup-like name survive.
  - Exact name matching.
  - Folder validation, including a relative path, bad characters, Nox's own data folder, a file,
    and a missing drive letter.
  - Folder detection with a mocked environment, including OneDrive found twice but offered once.
  - Backup-before-migration ordering: with a migration pending, a checked copy containing the todo
    exists before `Apply` is returned. With nothing pending, no backup is made.
  - A failing backup returns `Hold`, and a fresh install does nothing.
- Migration test in `lib.rs` runs 0001-0009 on a fresh database.
- TypeScript (`backup.test.ts`, 10 tests): settings defaults and clamping, error parsing, keep
  validation, the once-a-day warning (dismiss, next day, success, off, held), and the first-run
  offer rules.

## Deviations

- No folder picker (see above).
- `backup_folder` empty means "not chosen yet" and uses the Documents fallback, so automatic and
  pre-migration backups still work before Bas picks a folder. The folder is never set to Drive
  without a click.
- The restore steps also say to delete `nox.db-wal` / `nox.db-shm`. Nox runs SQLite in WAL mode,
  and a leftover WAL from the old database must not be applied to the restored file.
- Besides the "first start of the day" rule, the daily backup also respects `backup_enabled`. The
  pre-migration backup is skipped when backups are switched off: Bas chose that by switching them
  off.

## Not tested live

- The app was not launched (no `tauri dev`), so the Settings and Home UI, Explorer opening, and the
  real startup order were checked only by types, build and unit tests.
- Writing a backup into the real `G:\My Drive` (Drive for desktop streaming) was not tried.
- The pre-migration path was not tested on Bas's real `nox.db`. The next app start will run it for
  migration 0009 itself, which is the first live test.

## Manual checklist for Bas

1. "Back up now" creates a file in the backup folder. Open it with a SQLite viewer and check that
   the todos are there.
2. Create 16 backups (change the date, or use the button); only the newest 14 remain.
3. Point the folder at an invalid path (e.g. `Q:\nope` or `relative\path`): you get a clear error
   and no crash.
4. Restart the app twice on the same day: only one automatic backup.
5. Extra: the first start after this change should show the Google Drive / OneDrive offer on Home,
   and a `nox-…db` from the pre-migration backup (migration 0009) should already exist in
   `Documents\NoxBackups`.
