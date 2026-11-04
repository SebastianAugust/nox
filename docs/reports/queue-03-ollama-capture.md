# Queue 03: Natural-language capture and step suggestions (Ollama)

Status: **done**. Gate green: `tsc`, `build`, `npm test` (193), `cargo check`; `cargo test` 25.

## What was built

- **`extractIntent`** (`src/lib/captureCore.ts`, pure):
  - A cheap gate first: only text with a trigger word (en/id) or a clock time goes to the model.
  - Then the local model, at temperature 0 with a JSON-schema `format` and a 20 s timeout, model
    from `ollama_model`.
  - Strict validation: exact keys, enums, length caps.
  - Date and time **phrases must be words the user wrote** and are resolved by `todoParse`; the
    model never computes a date.
  - Fallback on timeout, invalid JSON or Ollama off: plain instructions ("ingetin …", "catat …")
    go through the deterministic parser, everything else is chat.
- **Pet chat:** a confirmation card ("Add todo “bayar kos” · tomorrow 07:00?") with Add / Edit /
  Cancel. Edit opens Todos with quick-add prefilled (`todos:prefill`). Nothing is created before Add.
- **Telegram:** a preview with inline Confirm / Cancel buttons.
  - Rust now accepts `callback_query`, but only from the paired private chat and only with button
    data Nox itself sets (`cap:yes|no:<n>`).
  - New commands `telegram_send_buttons` and `telegram_answer_callback`. Previews expire after
    15 minutes.
- **Suggest steps** in the Todos details panel: 3-6 steps from the model (validated), shown as a
  checklist with Add selected / Add all / Dismiss. Never saved automatically, and a clear message
  when Ollama is not running.
- **Settings:** `ai_capture_enabled` (default on, migration 0008) in Settings → Features, with the
  local-only explanation. `ollama_model` was already in Settings → General.
- **Evaluation:**
  - `src/lib/capture.fixtures.json` holds 33 phrases (id/en, casual, typos), each with the expected
    result and an ideal model answer.
  - `capture.test.ts` runs all of them through the pipeline with a mocked model.
  - `npm run eval:capture` runs them against the real local Ollama and prints accuracy per intent.

## Measured accuracy

**Not measured.** Ollama is running on this machine (`localhost:11434` answers), but **no model is
installed** (`/api/tags` returns an empty list). `npm run eval:capture` reported:

```
Model "llama3.2:3b" is not installed in Ollama. Run: ollama pull llama3.2:3b
```

I did not pull the model (a large download nobody asked for). No accuracy is claimed. Run
`ollama pull llama3.2:3b`, then `npm run eval:capture`, and the per-intent numbers print in the
terminal.

## Files changed or added

- `src/lib/captureCore.ts`, `src/lib/capture.ts`, `src/lib/capture.test.ts`, `src/lib/capture.eval.ts`, `src/lib/capture.fixtures.json` (new)
- `vitest.eval.config.ts` (new), `package.json` (`eval:capture` script)
- `src/lib/ollama.ts` (`askJson`)
- `src/App.tsx` (confirmation card), `src/lib/telegram.ts` (preview + buttons)
- `src-tauri/src/telegram.rs` (callback queries, 2 commands, test), `src-tauri/src/lib.rs`
- `src-tauri/migrations/0008_ai_capture.sql` (new)
- `src/dashboard/Dashboard.tsx`, `src/dashboard/pages/Todos.tsx`, `src/dashboard/todos/QuickAdd.tsx` (prefill)
- `src/dashboard/todos/DetailsPanel.tsx` (Suggest steps), `src/dashboard/pages/Settings.tsx`
- `src/lib/i18n.ts`, `src/styles/dashboard.css`, `docs/ARCHITECTURE.md`

## Migrations

`0008_ai_capture.sql`

## Deviations

- **"Resolve against the timezone setting":** dates are resolved by `todoParse` on the PC's clock,
  as everywhere else in the app.
- **A model "reminder" without a time becomes a todo,** since a reminder needs a moment to fire.
- **Fallback is narrow:** when the model fails, only clear instructions (starting with ingetin,
  remind me, catat, tambah, jangan lupa, todo, add) go to the parser; other gated text is treated
  as chat, as asked.
- **Gated chat is slower:** text that passes the gate but the model calls chat costs one model call
  before the normal reply. Only gated text pays this.

## Not tested live

No real model call was made. The whole pipeline ran with a mocked model; the Telegram button flow
was tested in Rust for parsing/allow-listing only. Untested live: real llama3.2:3b extraction
quality and latency, Ollama's `format` schema enforcement with that model, the Telegram inline
buttons on a phone, and Edit opening the dashboard with quick-add filled.

## Manual checklist for Bas

1. "ingetin besok jam 7 bayar kos" in the pet chat shows a confirmation card with the right date;
   Cancel creates nothing.
2. The same sentence from Telegram gives a preview with Confirm/Cancel.
3. A normal chat message ("lagi capek nih") is not slowed down and creates nothing.
4. Ollama stopped: chat degrades to a clear message, nothing crashes.
5. "Suggest steps" on a todo shows steps you can accept selectively.
6. Run `npm run eval:capture` with Ollama running (and the model pulled) and read the accuracy.
