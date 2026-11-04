# Queue runner — run the Nox prompts in order

Recommended for the whole run: Opus, effort high. Run npm/tauri from Windows
PowerShell, not WSL.

You will work through the prompt files in this folder, one after another:

1. 01-notion-write.md
2. 02-ical-calendar.md
3. 03-ollama-capture.md
4. 04-backup.md
5. 05-notification-spike.md

Each file is a complete prompt with its own rules, tasks and checklist. Follow
each file exactly as if Bas had given it to you alone.

## Before you start
1. Read docs/ARCHITECTURE.md.
2. Confirm the full Todos page exists: Todos.tsx has view chips, a details
   panel and quick-add with a parser, and migrations exist for todo_lists and
   todo_subtasks. If it does not, STOP and tell Bas: the queue depends on it.
3. Run `npx tsc --noEmit`, `npm run build`, `npm test` and `cargo check` in
   src-tauri. If any is red before you begin, STOP and report; do not start on
   a broken base.
4. Create docs/reports/ and docs/prompts/queue/PROGRESS.md (a table with the
   five steps and status: pending, running, done, needs Bas, failed).

## Rules that apply to the whole run
1. **Do not `git commit` or `git push`, ever.** Bas commits himself. Leave
   everything uncommitted.
2. Never put a secret (token, feed URL, key) in code, logs, reports or chat.
3. Migrations: before each step check the highest existing migration number
   and continue from there; never edit an old migration.
4. You cannot reach Notion, Telegram, Open-Meteo, calendar feeds or a real
   Ollama from here unless a file says you can: test with mocks and fixtures,
   and say clearly in each report what was NOT tested live.
5. Do not add scope. If you find a bug outside a step, note it in that step's
   report instead of fixing it, unless it blocks the step.
6. If a file contradicts the repo (a path or name that does not exist),
   adapt to the real names and note the deviation.

## For each step, in order
1. Set its row in PROGRESS.md to `running`. Read the whole prompt file first.
2. Before you change anything, record `git status --short` so you can tell
   exactly which files this step touched.
3. Implement every task in the file.
4. Gate: `npx tsc --noEmit`, `npm run build`, `npm test`, and `cargo check` in
   src-tauri must be green. If one is red, fix it. After two failed attempts at
   the same error, STOP, set the row to `failed`, and report the error, what
   you tried and your best guess. Do not move on to the next step.
5. Write `docs/reports/queue-NN-<name>.md` containing: what was built, the
   exact list of files this step changed or added, migration numbers added,
   deviations, what was not tested live, and the manual checklist for Bas
   from the prompt file. Set the row to `done` (or `needs Bas` when the step
   itself says a manual action by Bas is required, as in 05).
6. **Default: STOP here and wait.** Tell Bas the step is done, summarise the
   report in five lines at most, and say he can commit this step's files and
   then reply `lanjut`. Only continue when he replies `lanjut`.
   If Bas's first message to you contained the word `auto`, do not wait:
   continue straight to the next step, but still stop on any failure.

## At the end
Write docs/reports/queue-summary.md: a table of all five steps with status, the
migrations added, every file touched per step (so Bas can commit in chunks),
every deviation, everything that still needs a live test by Bas, and the
recommended order for him to test. Then tell Bas in a short message.
