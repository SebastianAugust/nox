# Queue 01 — Notion write-back

Recommended: Opus, effort high. Run npm/tauri from Windows PowerShell, not WSL.

Context: Nox syncs Notion read-only (Phase 2). Bas wants Nox to write back to
his assignments database. It is his real coursework, so writes are opt-in,
narrow, never destructive, and always check for newer edits first.

Bas's assignments database (workspace page "cool-yeah", inline database
"assignments") has exactly these properties; map to them:
- `Name` (title), `Date` (date, may include time), `Done` (checkbox),
  `Courses` (relation to the Courses database), `Grade` and `Weight`
  (percent numbers), `Weighted Mark` (formula, read-only, never written).
The Courses database has `Course Name` (title), `Semester/Year` (select),
`Status` (status), `Final Mark`, `Assignments`, `Notes`.

DECISIONS (from Bas): writes allowed for Done, creating assignments, and
editing Name and Date of existing assignments. If the page changed in Notion
since the last sync, refresh it first and only then write. New assignments are
created only by an explicit action (button or command), never automatically.

## Rules
1. Read docs/ARCHITECTURE.md and the Notion code (src-tauri/src/notion.rs, the
   sync, the Integrations page, the commands module, the Todos page) first.
2. New numbered migration(s) only; check the latest number first.
3. Tokens stay in Rust/Credential Manager. Never log or return them.
4. i18n en + id. Plain copy, no game wording.
5. Do not git commit or push. Bas commits himself.
6. tsc, build, test, cargo check green. You cannot reach the real Notion API:
   test with mocked HTTP only and say so in the report.

## Scope
Allowed writes, nothing else:
- A. `Done` checkbox of an existing assignment.
- B. Create a page in the assignments database with `Name`, optional `Date`,
  optional `Courses` relation (matched by course name against synced courses;
  no match = leave empty and tell Bas).
- C. Update `Name` and/or `Date` of an existing assignment.
There must be NO code path that deletes, archives, moves or edits any other
property, page or database. `Grade`, `Weight`, `Weighted Mark` and the Courses
database are never written.

## Tasks
1. **Setting and gating.** `notion_write_enabled`, default false. Integrations
   page: a clear switch saying Nox will write to the assignments database, and
   that the Notion integration needs "Update content" and "Insert content"
   enabled at notion.so/my-integrations. Off = every write path returns
   "Notion writes are off" and does nothing.
2. **Rust commands** `notion_set_done`, `notion_create_assignment`,
   `notion_update_assignment(pageId, name?, dateIso?)`. Validate ids (32 hex),
   allow-list property names, reuse the shared rate limiter and error mapping.
   403/restricted resource -> "Your Notion integration has read-only access.
   Enable Update/Insert content for it, then retry." Creates use a client-side
   idempotency key so a retry never duplicates.
3. **Outbox.** Table `notion_outbox` (id, op, payload JSON, status
   pending/sent/failed, attempts, last_error, created_at, sent_at). All writes
   go through it: retried on start and after each sync, max 5 attempts, then
   `failed` with a visible Retry in Integrations. Never lose a queued write.
4. **Conflict rule.** Before any update (A or C), fetch the page's
   `last_edited_time`; if it is newer than the local `last_synced_at`, refresh
   that page into the local copy first, then apply the write on top of the fresh
   data. Never overwrite another property.
5. **Todos page integration.** With writes on, Notion rows in the Todos page
   become editable: checkbox (Done), and title/date in the details panel (the
   panel's read-only banner changes to "Synced with Notion"). Changes apply
   locally at once (optimistic) and are queued. A failed write is shown in
   Integrations and on the row, never silently reverted.
6. **Create from Nox.** "Send to Notion" on a todo (details panel) and
   `/tugas tambah <text>` (shared todo parser, `@course` selects the course).
   Store the returned page id as `source_notion_id` / mirror the row so sync
   does not duplicate it. A linked todo cannot be sent twice.
7. **Commands** (pet and Telegram, shared module): `/tugas selesai <n>`,
   `/tugas ubah <n> <new title>`, `/tugas tunda <n> <date>` (reschedule),
   `/tugas tambah <text>`. n comes from the `/tugas` list. All reply clearly
   when writes are off. Writes that change data show a one-line summary of what
   was done.
8. **Tests** (mocked HTTP): gating, 403 mapping, outbox retry and max attempts,
   idempotent create, no duplicate after sync, conflict refresh-then-write,
   id validation, property allow-list, command parsing.
9. Update docs/ARCHITECTURE.md.

## Out of scope
Delete/archive, notebooks database, creating courses, writing Grade/Weight,
any other database.

## Manual checklist for Bas (put it in the report)
1. In Notion enable Update/Insert content for the integration, then turn on
   "Notion writes" in Nox.
2. Mark an assignment done in Nox; it is checked in Notion within a minute.
3. Change an assignment's date in Nox; Notion shows the new date.
4. `/tugas tambah laporan test jumat @metpen` from Telegram creates one page with
   the right course; the next sync does not make a second copy.
5. Edit an assignment in Notion, then change it from Nox before the next sync:
   Nox refreshes first and does not overwrite your Notion edit.
6. Wi-Fi off, mark something done, Wi-Fi on: it syncs once, no duplicate.
7. With writes off nothing is ever written.
8. Delete the test page in Notion afterwards.
