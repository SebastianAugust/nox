# Nox — Proper Todos page

**Run with: Opus, effort high.** Run `npm`/`tauri` from Windows PowerShell, not WSL.
**Run this only after Phase 2 and its amendments are finished and committed**, because both touch migrations, `commands.ts` and the pet's `/todo` command.

Today the Todos page is just an input and a flat Active/Done list, plus a small Reminders card. Make it a proper task manager, in the Night Lair look (use existing tokens and the deco/UI components; no new art, plain copy, no game wording, no points/levels).

## Rules
1. Read `docs/ARCHITECTURE.md`, `docs/TOKENS.md` and the current Todos page/store/DB code first. Extend what exists; do not rewrite unrelated areas.
2. Schema changes = **new numbered migration(s)**, non-destructive, with backfill. Inspect the real current `todos`, `reminders` and `pomodoro_sessions` schema before deciding what to add; never edit old migrations.
3. All strings in i18n `en` and `id`. Dates and times respect the language and timezone settings.
4. **Do not `git commit` or `git push`.** Bas commits himself. `npx tsc --noEmit`, `npm run build`, `npm test`, `cargo check` must be green before you finish; work in the order below.
5. Keep it fast: a list of 500 todos must still scroll and filter smoothly (no per-row heavy work, memoize, virtualize only if needed).

## Data model (adapt to the existing schema)
Add what is missing to `todos`: `notes`, `due_date`, `due_time` (nullable), `priority` (0 none, 1 low, 2 medium, 3 high), `list_id`, `estimate_pomodoros` (nullable), `repeat_rule` (nullable, simple: daily / weekdays / weekly / monthly / every N days), `sort_order`, `completed_at`, `course_name` (nullable text, free or picked from synced Notion courses).
New tables: `todo_lists` (id, name, color from a small token palette, sort_order) with a built-in default list, and `todo_subtasks` (id, todo_id, title, done, sort_order). Subtasks cascade on delete.

## Tasks

### T1 — Migration and data layer
Migration, typed repository functions, and unit tests (create, update, complete, repeat spawn, subtask cascade, backfill of existing rows). Existing todos must keep working and show up in the new page.

### T2 — Layout
Three areas, responsive:
- **Left sidebar** (collapses to a top select under ~900 px): smart views **Today, Upcoming, Inbox (no date), Overdue, Done, All**, each with a count; then the user's **Lists** with colour dots and counts; "New list" button; rename/recolor/delete list (deleting moves its todos to the default list).
- **Main column:** quick-add bar, view title with a short summary ("3 due today, 1 overdue"), toolbar (search, sort, group-by), the list.
- **Right drawer** (slides over on narrow widths): todo details (T5). Esc closes it.
Keep the Reminders card, but move it into a collapsible section at the bottom of the main column or the sidebar, with the same behaviour as now.

### T3 — Quick add with natural parsing
One input; parse as the user types and show the parsed chips before submitting. Support (en + id):
- dates: `today/hari ini`, `tomorrow/besok`, `lusa`, weekdays (`fri`, `jumat`), `25/12`, `in 3 days`, `2 minggu lagi` (keep simple, no false positives);
- time: `18:30`, `6pm`, `jam 18`;
- `!1 !2 !3` or `!high !med !low`, `#listname`, `@coursename`, `~25m`/`~3p` for estimate, and `every day/weekday/week/month` / `setiap hari/minggu` for repeat.
Pure TS parser in `src/lib/todoParse.ts` with thorough tests (including words that merely look like dates). Enter adds; Shift+Enter adds and keeps the input focused for rapid entry. **The pet's `/todo` command must use the same parser.**

### T4 — The list
- Row: checkbox, title, priority indicator (colour plus a text/shape cue, not colour alone), due chip (overdue / today / tomorrow / date, with time when set), list dot, course tag, subtask progress (2/4), repeat icon, note icon, estimate and focus-session count.
- Group-by: none, due date, priority, list. Sort: manual (drag to reorder), due date, priority, created.
- Complete with a checkbox → short **Undo** toast (5 s). Completing a repeating todo creates the next occurrence; completed todos get `completed_at`.
- Multi-select (checkbox column or Shift/Ctrl click) with a bulk bar: complete, set date, set priority, move to list, delete (with confirm).
- Search (title, notes, course) and filters: priority, list, course, "has due date". Filter state survives view switches in-session.
- Keyboard: `N` focus quick-add, `/` focus search, `↑/↓` move, `Space` toggle done, `Enter` open drawer, `Delete` delete (confirm), `Esc` close. Show a "?" shortcut hint. Never hijack keys while typing in an input.
- Done view: grouped by completion day, "Clear completed older than 30 days" action.

### T5 — Details drawer
Edit title, notes (plain multi-line text), due date and time (with clear), priority, list, course, estimate, repeat rule, subtasks (add, check, reorder, delete), created/completed timestamps. Actions: **Start focus**, **Remind me** (creates a row in the existing reminders table with a time picker; show linked reminders), Duplicate, Delete. Autosave on blur or after a short debounce; show a subtle "Saved" state.

### T6 — Focus integration
"Start focus" launches the existing pomodoro through the existing events (`pomodoro:cmd` etc.), linked to the todo. Count completed focus sessions per todo (use `pomodoro_sessions` if it can hold a todo id, otherwise add the column in the migration) and show "2/4 sessions" against the estimate. Do not move pomodoro ownership out of the pet window.

### T7 — Reminders, deadline radar, pet
- A todo with a due date/time can optionally create its own reminder (toggle in the drawer); due-today and overdue todos feed the existing briefing and radar sources **if Phase 2 exists** (feature-detect; no hard dependency).
- Extend `/todo` and add `/todo done <n>` consistent with the parser (priority, list, date). Keep the shared commands module as the single source of truth.
- If synced Notion assignments exist, offer a toggle "Show assignments from Notion" in Today/Upcoming: shown read-only with a Notion badge and a "Add to my todos" action. Off by default. Skip this whole item if Notion sync is not present.

### T8 — Polish
Empty states per view (plain copy), loading skeleton, error toasts, `prefers-reduced-motion`, focus rings, ARIA roles for the list, drawer and toasts, tab order, contrast checks on the Night Lair tokens, light touch animations only (honour the `ui_animations` setting).

## Out of scope
Gamification, shared/collaborative lists, cloud sync, attachments, Google Calendar, drag-and-drop between windows, a Kanban board.

## Definition of done
All tasks done and **left uncommitted**; `tsc`, `build`, `test`, `cargo check` green; tests for the parser, repository, repeat logic, bulk actions and filters.

## Manual checklist for Bas (include in your final report)
1. Existing todos appear after the migration and nothing is lost; restart the app, data persists.
2. Quick-add: `beli makan besok 18:30 !2 #personal`, then an English one; chips preview correctly; a plain sentence with no date words adds no date.
3. Today / Upcoming / Overdue / Inbox counts match the list contents.
4. Complete then Undo; complete a repeating todo and see the next one created.
5. Subtasks, notes, estimate, list and course editable in the drawer and saved after restart.
6. Bulk: select 3 → set priority, move list, complete, delete.
7. Search and filters work; keyboard shortcuts work and do not fire while typing.
8. Start focus from a todo; the session count updates afterwards.
9. `/todo` from the pet uses the same parsing and the todo shows up on the page immediately.
10. 500 generated todos still scroll and filter smoothly (add a dev-only seed helper, not shipped in the UI).

## Final reply must include
Changed files per task (so Bas can commit in chunks), migration numbers added, deviations, assumptions, and the checklist.
