# Queue 01: Notion write-back (levels 1 and 2)

Status: **done**. Gate green: `tsc`, `build`, `npm test` (141), `cargo check`; `cargo test` 17.

## What was built

- **Switch** `notion_write_enabled` (default `false`, migration 0006) on Integrations → Notion, with
  the capability note (Update content + Insert content at notion.so/my-integrations). While off,
  every write path returns "Notion writes are off" and nothing is sent. Rust checks the setting
  itself too, so no frontend bug can bypass it.
- **Rust commands** (`src-tauri/src/notion.rs`):
  - `notion_set_done(pageId, done)` reads the page first, checks that Done is really a checkbox,
    then PATCHes a body with that one key. If it is already in that state, nothing is written.
  - `notion_create_assignment(databaseId, name, dateIso?, coursePageId?, existingSince?)` posts a
    page with only title, date and course relation.
  - Both validate ids (32 hex digits) and dates, and take property names only from the mapping
    settings (an allow-list of four). They share the rate limiter and error mapping. A 403 on a
    write becomes `readOnly` ("enable Update/Insert content").
- **Outbox** `notion_outbox` (`src/lib/notionOutbox.ts`):
  - Every write is queued first. The pet window sends pending rows after each sync (so on start)
    and when `notion:outbox` says one was queued.
  - Max 5 attempts, then `failed`, listed with Retry on Integrations. While writes are off, rows
    are held without counting attempts. A pending Done for the same page is updated, not doubled.
  - Creates are protected client-side: after an uncertain attempt (timeout, offline, bad response,
    5xx), the retry first looks for a page with that title created since then.
- **Done from the Todos page:** Notion rows get a working checkbox when writes are on. The change
  is optimistic, with Undo, and a failure is shown on Integrations rather than reverted.
- **Create from Nox:**
  - "Send to Notion" in a todo's details. A linked or already queued todo cannot be sent twice.
  - `/tugas tambah <text>` uses the shared todo parser; `@course` is matched by name against
    synced courses, and no match leaves the relation empty and says so.
  - A sent create is mirrored into `notion_assignments` and set as the todo's
    `source_notion_id`, so the next sync does not duplicate it.
- **`/tugas selesai <n>`** (n from the `/tugas` list), in the pet chat and Telegram.
- **Conflict rule:** the page is always re-read right before a Done write (stronger than "only if
  older"), and only the Done checkbox is ever sent.

## Files changed or added

- `src-tauri/migrations/0006_notion_outbox.sql` (new)
- `src-tauri/src/notion.rs` (write commands, mock-HTTP tests)
- `src-tauri/src/http.rs` (`WritesOff`, `ReadOnly`)
- `src-tauri/src/lib.rs` (migration 6, two commands, migration test now runs every migration)
- `src/lib/notionOutbox.ts`, `src/lib/notionOutbox.test.ts` (new)
- `src/lib/notionSync.ts` (send the outbox after each sync and on `notion:outbox`)
- `src/lib/todoRepo.ts` (exports its connection, `sqlDb`/`isTestDb`, for the outbox)
- `src/lib/commands.ts`, `src/lib/commandRunner.ts`, `src/lib/commandParser.test.ts`
- `src/lib/api.ts`, `src/lib/i18n.ts`
- `src/dashboard/pages/Integrations.tsx` (switch, outbox status, Retry)
- `src/dashboard/pages/Todos.tsx`, `src/dashboard/todos/TodoRow.tsx`, `src/dashboard/todos/DetailsPanel.tsx`
- `docs/ARCHITECTURE.md`

`i18n.ts`, `Todos.tsx`, `commands.ts`, `commandRunner.ts`, `lib.rs` and `ARCHITECTURE.md` also
hold the still-uncommitted Todos page work from before this queue.

## Migrations

`0006_notion_outbox.sql`

## Deviations

- The course is matched **by name in TypeScript** against `notion_courses`, and Rust gets the
  course page id (`coursePageId`), not a name. Rust stays free of database lookups; the matching is
  still by name, as asked.
- **The conflict rule always refreshes** before writing Done, rather than comparing timestamps
  first. The page read also confirms that the Done property is a checkbox.
- **The refreshed page is not merged back** into the local row beyond its Done state. Other changes
  made in Notion arrive with the next sync.
- **The idempotency key is the outbox row itself** (its `uncertain_since`), not a key sent to
  Notion. Notion has no idempotency header, and writing a key into a page property would violate
  the allow-list.

## Not tested live

Nothing reached the real Notion API. The Rust write paths ran against a local mock HTTP server:

- the request bodies (only allowed keys)
- the 403 mapping
- the read-before-write and nothing-written-when-already-done
- a retried create finding the earlier page

The outbox ran on real SQLite with a mocked transport: gating, max attempts, Retry, the uncertain
retry, the mirror and no duplicate after sync. Notion's real `created_time` filter behaviour and the
exact 403 body for a missing capability are untested.

## Manual checklist for Bas

1. In Notion, enable Update/Insert content for the integration, then turn on "Notion writes" in Nox.
2. Mark a Notion assignment done in Nox; it is checked in Notion within a minute.
3. `/tugas tambah laporan test jumat @metpen` from Telegram creates one page with the right course;
   running sync does not create a second copy.
4. Turn Wi-Fi off, mark something done, turn Wi-Fi on; it syncs without a duplicate.
5. With writes off, nothing is ever written.
6. Delete the test page in Notion afterwards.
