# Queue 01 delta: edit title and date of Notion assignments

Status: **done**. Gate green: `tsc`, `build`, `npm test` (214), `cargo check`; `cargo test` 39.

This delta covers only what the updated `01-notion-write.md` adds to the step 01 that was
already built (Done, create, outbox, `/tugas selesai`, `/tugas tambah`): write C (update Name and
Date), the conflict rule for every update, and the commands that use them.

## What was built

- **Rust command `notion_update_assignment(pageId, name?, dateIso?, syncedAt?)`**
  (`src-tauri/src/notion.rs`):
  - It always reads the page first. An archived page fails with `notFound`. The title and date
    properties (from the existing mapping allow-list) must have the `title` and `date` types, or
    nothing is written.
  - It PATCHes only the title and/or date, and only the ones that differ from Notion's value. It
    sends nothing when the values are already equal.
  - Validation and errors:
    - The id must be 32 hex digits; the name is non-empty and at most 2000 characters.
    - `dateIso` is checked with the same `valid_date` as create; `syncedAt` must be RFC 3339.
    - At least one of name and date is required.
    - `notion_write_enabled` is checked in Rust.
    - Errors go through the shared rate limiter and error mapping, and a 403 becomes `readOnly`.
  - No code path touches Grade, Weight, Weighted Mark, Done, Courses or anything else, and
    nothing is deleted or archived.
- **Conflict rule**, shared with Done (`read_for_update`):
  - With `syncedAt`, if Notion's `last_edited_time` is at or after the local sync time, nothing is
    written and the fresh page comes back as `{ stale: true }`. The sync time is rounded down to
    the minute, because that is Notion's precision.
  - The outbox then refreshes the local copy from that page (`refreshLocal`, same mapping as the
    sync) and calls again, so the write lands on the fresh data.
  - `notion_set_done` follows the same rule. It still always re-reads the page and checks the
    checkbox type.
  - Both commands now return `{ stale, written, row }`.
- **Outbox op `update`** (`src/lib/notionOutbox.ts`, `queueUpdate`):
  - It is optimistic: the local row changes at once.
  - An update for the same page while one is pending is **merged** (newest title/date; the first
    edit's base values and sync time stay), not stacked.
  - Max 5 attempts as before, then `failed` with Retry.
  - Done payloads now also carry `synced_at`.
- **Same field changed in both places:** if the very title or date Nox wants to change was also
  changed in Notion since Bas's edit, Notion's value is kept. The write becomes `failed` with
  "This was also changed in Notion…". Retry sends Nox's value anyway.
- **Never reverted silently:** after every sync, `applyOutboxOverlay` puts pending and failed
  (non-conflict) edits back over what the sync wrote. A failure shows on Integrations (with the
  error and Retry) and on the Todos row ("Not saved to Notion"), with the reason in the details
  panel.
- **Todos page:** with writes on, a Notion row's details panel has an editable title (saved on
  Enter or blur, Escape cancels) and date + time. The banner reads "Synced with Notion. Title and
  date changes are sent there." With writes off, it is read-only as before.
- **Commands** (shared `commands.ts` / `commandRunner.ts`, so both the pet chat and Telegram):
  - `/tugas ubah <n> <new title>` (also `edit`, `rename`)
  - `/tugas tunda <n> <date>` (also `move`, `reschedule`). The date is read by the todo parser
    ("jumat", "besok 08:00") or as `YYYY-MM-DD [HH:MM]`. Leftover words or an impossible date give
    a clear error.

  Replies: "Renaming “old” to “new” in Notion.", "Moving “x” to Fri 23:59 in Notion.", or "Notion
  writes are off…". The help lists both.
- **i18n** en + id for every new string. The Integrations write hint now names title and date
  changes and says nothing is deleted.

## Files changed in this delta

- `src-tauri/src/notion.rs` (update command, conflict rule, `set_done` result, tests)
- `src-tauri/src/lib.rs` (registers `notion_update_assignment`)
- `src/lib/notionOutbox.ts` (op `update`, `queueUpdate`, conflict handling, `refreshLocal`,
  `applyOutboxOverlay`, `failedWrites`, Retry with `force`)
- `src/lib/notionOutbox.test.ts`
- `src/lib/notionSync.ts` (calls `applyOutboxOverlay` after a sync)
- `src/lib/api.ts` (error kind `conflict`)
- `src/lib/commands.ts` (`notionEdit`, `notionMove`, `parseDueOnly`, render)
- `src/lib/commandRunner.ts`
- `src/lib/commandParser.test.ts`
- `src/lib/i18n.ts`
- `src/dashboard/pages/Todos.tsx` (failed writes per row, edit handler)
- `src/dashboard/todos/DetailsPanel.tsx` (editable `NotionDetails`)
- `src/dashboard/todos/TodoRow.tsx` ("Not saved to Notion" chip)
- `src/dashboard/pages/Integrations.tsx` (label for a failed update)
- `docs/ARCHITECTURE.md`

All these files also hold earlier uncommitted work (the Todos page, steps 01-04), so commit them
together or review hunks.

## Migrations

**None.** `notion_outbox.op` is free TEXT and the payload is JSON, so `update` needed no schema
change. The highest migration is still 0009.

## Tests (mocked HTTP and real SQLite only)

- Rust, against a local mock HTTP server:
  - The update body holds only Name and Date (on a page that also has Grade, Weight, Weighted
    Mark, Done, Courses), and only the fields that differ. No PATCH is sent when nothing differs,
    including a date with `.000` milliseconds.
  - A page edited since the sync comes back stale with nothing written, for update and for Done.
    An older edit is written.
  - The minute rounding.
  - A 403 on PATCH becomes `readOnly`.
  - A date mapping that points at a non-date property is refused before any PATCH.
  - An archived page gives `notFound`.
  - `syncedAt` validation.
  - Id and date validation as before.
- TypeScript (fake Notion with state, real SQLite):
  - gating (off) and empty or missing input
  - an optimistic edit plus a single update
  - merging three edits into one row
  - refresh-then-write: Notion's date edit survives Nox's title change
  - same-field conflict: Notion wins, the row is failed and visible, a sync does not overlay it,
    and Retry applies Nox's value
  - 403 after 5 attempts: failed, not reverted, and the overlay restores the edit after a sync
  - Done: refresh-then-write, and a direct write when nothing changed
- Command parsing: `ubah` and `tunda` with the parser, ISO dates and errors; rendering; the
  writes-off reply.

## Deviations

- The Rust signature has an extra optional `syncedAt` (also on `notion_set_done`). The local
  `last_synced_at` lives in SQLite, which Rust does not read, so the frontend passes it in.
- The conflict check uses the sync time **from when Bas made the edit** (stored in the outbox
  payload), not the row's current `last_synced_at`. Otherwise a sync running between the edit and
  sending it would hide a Notion edit.
- Same-field conflicts keep Notion's value instead of overwriting it (manual checklist item 5:
  "does not overwrite your Notion edit"). Retry is the explicit way to apply Nox's value.
- The date can be changed but not cleared from Nox (the spec only asks for edit/reschedule).
  Changing the date also replaces any end date or time zone on Notion's date with just a start.
- `/tugas ubah` and `/tugas tunda` index the same `/tugas` list as `/tugas selesai` (open
  assignments with a date).

## Not tested live

Nothing reached the real Notion API. Untested against real Notion:

- the PATCH of a title and date
- the real `last_edited_time` precision
- the exact 403 body when Update content is missing
- whether a PATCH that sets only a date `start` keeps other date parts as expected

The Todos page editing UI was not run in the app (types and build only).

## Manual checklist for Bas (from the spec)

1. In Notion enable Update/Insert content for the integration, then turn on "Notion writes" in Nox.
2. Mark an assignment done in Nox; it is checked in Notion within a minute.
3. Change an assignment's date in Nox; Notion shows the new date.
4. `/tugas tambah laporan test jumat @metpen` from Telegram creates one page with the right course;
   the next sync does not make a second copy.
5. Edit an assignment in Notion, then change it from Nox before the next sync: Nox refreshes first
   and does not overwrite your Notion edit.
6. Wi-Fi off, mark something done, Wi-Fi on: it syncs once, no duplicate.
7. With writes off nothing is ever written.
8. Delete the test page in Notion afterwards.

Extra for this delta: `/tugas ubah 1 <new title>` and `/tugas tunda 1 besok 23:59` from the pet
chat and Telegram, then check the reply and Notion.
