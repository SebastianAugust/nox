# Queue 04 — Automatic backup of nox.db

Recommended: Sonnet, effort medium. Run npm/tauri from Windows PowerShell, not WSL.

Context: all of Nox's data lives in one SQLite file (nox.db in the app data
folder). Secrets are NOT in it (Credential Manager). Bas wants automatic
backups so a bad migration or a deleted file cannot lose his todos.

DEFAULTS CHOSEN (Bas can change): daily backup at the first start of each day,
keep the last 14, default folder suggestion = Google Drive (Bas prefers it), plus a backup before any
pending migration runs.

## Rules
1. Read docs/ARCHITECTURE.md, the DB init and migration code (Rust and
   src/lib/db.ts) and the Settings page first.
2. Do not git commit or push. i18n en + id. Plain copy.
3. tsc, build, test, cargo check green. Never touch the live database file
   directly while it is open: use SQLite's own `VACUUM INTO`.

## Tasks
0. **Default folder detection.** At first run, look for a Google Drive for
   desktop folder (e.g. `G:\My Drive`, `%USERPROFILE%\Google Drive`, or other
   drive-letter "My Drive" folders) and OneDrive; offer what is found as
   `<found>\NoxBackups` and let Bas pick or type another. Nothing is chosen
   silently. Fallback when none exists: `Documents\NoxBackups`. Note in the UI
   that Drive syncs the folder itself (Nox does not upload anything).
1. **Backup function in Rust.** `backup_now(folder?)` runs `VACUUM INTO` to
   `nox-YYYYMMDD-HHMM.db` in the backup folder (create it if missing), then
   opens the copy and runs `PRAGMA integrity_check`; if it is not `ok`, delete the
   copy and report an error. Returns file name, size and time.
2. **Retention.** Keep the newest N backups (setting `backup_keep`, default 14),
   delete older `nox-*.db` files in that folder only (never anything else).
3. **Schedule.** `backup_enabled` (default on). Run on the first app start of
   each day (store `last_backup_date`) and in the background, never blocking
   startup. Also run a backup before applying a pending migration; if that
   backup fails, show an error and do not apply the migration silently.
4. **Settings UI.** Section "Backup": on/off, folder (text path with
   validation, plus a folder picker if the dialog plugin is already in the
   project; add it only if needed), keep count, "Back up now", last backup time
   and result, "Open backup folder". No in-app restore (risky): document the
   manual restore steps in the Settings text and in docs/ARCHITECTURE.md
   (close Nox, copy a backup over nox.db).
5. **Failure handling.** A failed backup shows a small, non-blocking warning in
   Settings and the Home page once per day, never spams.
6. **Tests.** Retention logic with temp dirs, folder validation, that only
   `nox-*.db` files are ever deleted, and backup-before-migration ordering.

## Out of scope
Cloud upload, encryption, in-app restore, backing up secrets.

## Manual checklist for Bas (put it in the report)
1. "Back up now" creates a file in the backup folder; open it with a SQLite
   viewer and see the todos.
2. Create 16 backups (change the date or use the button); only the newest 14 remain.
3. Point the folder at an invalid path: clear error, no crash.
4. Restart the app twice the same day: only one automatic backup.
