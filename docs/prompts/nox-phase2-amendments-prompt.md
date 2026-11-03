# Nox — Phase 2 amendments (apply on top of what is already built)

**Run with: Opus, effort high.** Run `npm`/`tauri` from Windows PowerShell, not WSL.

`docs/prompts/nox-phase2-prompt.md` was updated **after** you started Phase 2. Do not redo Phase 2. First **inspect what already exists in the repo** (Rust commands, migrations, settings, `src/lib/commands.ts`, Integrations page, tests), compare it with the updated prompt, and apply **only the differences below**. If something below is already implemented, leave it and say so in the report.

## Rules (unchanged)
1. Secrets never reach the frontend, the DB, logs or git. HTTP only through Rust.
2. Schema changes = new numbered migrations. Never edit old ones.
3. Plain UI copy, no game wording. i18n `en` and `id` for every new string.
4. **Do not `git commit` or `git push`.** Bas commits himself. `npx tsc --noEmit`, `npm run build`, `npm test` and `cargo check` must be green at the end.

## Changes

### A1 — Briefing default time
Default `briefing_time` is **07:30** (was 07:00). Still editable in Settings. Only change the default for new/unset values; do not overwrite a value Bas already saved.

### A2 — Notion mapping for Bas's real setup
Bas's databases (a "student essentials" template):
- **assignments**: `Name` (title), `Date` (date, may include time), `Done` (checkbox), `Courses` (relation to courses), `Grade` / `Weight` (percent numbers), `Weighted Mark` (formula, ignore).
- **Courses**: `Course Name` (title), `Semester/Year` (select), `Status` (status: Not Started / In progress / Passed / Failed / Dropped), `Final Mark`.

Make the default property mapping match these names (keep the fallback-by-type logic). Then:
- Sync courses first; resolve the assignment's `Courses` relation (Notion page ids) by joining on page id so assignments store a real course name, never a raw id.
- A course is "current" when `Status` = `In progress`. The deadline radar and briefing use assignments that are not `Done` and belong to a current course (or have no course).
- Skip rows with empty `Name` or empty `Date` for the radar (the database has blank rows).
- An empty or old database is a normal state ("No upcoming deadlines"), never an error.
- The notebooks database is not synced.
Add/adjust unit tests for the mapping, the relation join and the "current course" filter. Add a migration only if columns are missing.

### A3 — Saved places and location switching
Replace any single fixed weather location with **saved places**:
- Settings keeps a list of places (name, lat, lon), seeded with "Jatinangor" (via Open-Meteo geocoding). Add a place by typing a name and picking a geocoding result (e.g. Kampus, Rumah). Exactly one place is **active**; weather, briefing and nudges use it. Migrate the existing location value (if any) into the first saved place so nothing is lost.
- Quick switch in Settings and on the Home weather chip.
- Weather refreshes immediately when the active place changes (respect the cache key by lat/lon).
- **Detect now** button: estimates location from the public IP (one HTTPS call from Rust, no key). Show the result labelled "approximate" and let Bas confirm before applying; never auto-switch. Gate it behind `location_detect_enabled` (default **off**, because it sends the IP to a third party). No continuous or background location tracking.

### A4 — New commands
In `src/lib/commands.ts` (with tests) add `/lokasi` (show the active place) and `/lokasi <name>` (switch to a saved place, case-insensitive, helpful message if not found). Include them in `/bantu`.

### A5 — Telegram location pin
When the **paired** chat sends a Telegram location message, Nox replies asking for a name, then saves it as a place, makes it active and refreshes the weather. Location messages from any other chat are ignored silently. If Telegram is not implemented yet, implement this together with it.

### A6 — Docs and checklist
Update `docs/ARCHITECTURE.md` for places, the new commands and the Notion join. Add these to the manual checklist in your final report:
1. Add a second place; switch from Home, `/lokasi <name>` and a phone pin; weather changes each time. "Detect now" only suggests.
2. With the real Notion data (few or old assignments), the radar shows "No upcoming deadlines" and nothing crashes; courses show names, not ids.
3. Briefing default shows 07:30 on a fresh settings state.

## Final reply must include
What was already done vs. newly changed (per item A1–A6), changed files (so Bas can commit in chunks), deviations, assumptions, and the checklist.
