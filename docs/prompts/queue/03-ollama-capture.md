# Queue 03 — Natural-language capture and step suggestions (Ollama)

Recommended: Opus, effort high. Run npm/tauri from Windows PowerShell, not WSL.

Context: llama3.2:3b is small. Use it only to extract structure from free text
and to suggest steps. Dates, times and all facts are resolved by our own code.
Nothing the model produces is saved without Bas confirming it.

DEFAULTS CHOSEN (Bas can change): capture on by default; ALWAYS confirm before
creating (Bas's decision); 20 s timeout; model name configurable (default the
current one). Bas types free text to Nox often, so this is a high-priority
feature: make the confirmation flow fast and pleasant.
Hardware: Intel Core Ultra 7, 16 GB RAM, Intel Arc iGPU. Ollama runs on CPU by
default here; do not assume GPU acceleration.

## Rules
1. Read docs/ARCHITECTURE.md, the Ollama client (streaming, timeouts), the
   shared commands module, src/lib/todoParse.ts, the pet chat, the Telegram
   handler and the Todos details panel first.
2. Migration only if you need a new setting storage; check the latest number.
3. i18n en + id. Do not git commit or push.
4. tsc, build, test, cargo check green. Tests use a mocked Ollama; a separate
   manual eval script may call the real local Ollama.

## Tasks
1. **Intent extraction.** A function `extractIntent(text)` that asks Ollama
   (temperature 0, JSON output / schema, 20 s timeout) to return
   `{ intent: "todo" | "reminder" | "event" | "chat", title, datePhrase?,
   timePhrase?, endTimePhrase?, location?, priority?, list?, course? }`. Validate the result with a strict schema; on
   invalid JSON, timeout or error fall back to treating the text as chat (or to
   the deterministic parser when the text clearly looks like a command).
   The model never computes dates: pass its `datePhrase`/`timePhrase` through
   src/lib/todoParse.ts to resolve them against today's date and the
   timezone setting.
2. **Cheap gate first.** Only call the model when a deterministic check says
   the text may be a task or reminder (trigger words in en/id such as ingetin,
   remind me, tambah, catat, jangan lupa, besok, jam, deadline). Everything
   else goes straight to normal chat, so casual talk is not slowed down.
3. **Confirmation, never auto-create.** Reuse the `pending_actions` mechanism
   built in queue step 02 (pet card with Add, Edit, Cancel; Telegram inline
   keyboard Confirm / Cancel, paired chat only, 10 min expiry). Do not build a
   second mechanism. Kinds: todo, reminder, event. An `event` intent creates a
   Google Calendar event through step 02's create path (if Google is not
   connected, say so and offer to save it as a todo instead). Edit opens the
   Todos quick-add (or the event preview) prefilled. Nothing is ever created
   without a tap.
4. **Step suggestions.** In the Todos details panel a "Suggest steps" button:
   Ollama returns 3 to 6 short steps (JSON array). Show them as a checklist
   with Add selected / Add all / Dismiss. Never save automatically. Works
   offline from the model's point of view (local), with a clear error if
   Ollama is not running.
5. **Settings.** `ai_capture_enabled` (default on), `ollama_model`. Plain
   explanation that text is processed only by the local model.
6. **Evaluation.** A fixture file of at least 40 phrases (id and en, mixed
   register, with typos, including events like "rapat himatif jumat jam 2 di
   sekre") with the expected intent and fields, a unit test using a mocked
   model, and `npm run eval:capture [-- --model <name>]` that runs the fixtures
   against the real local Ollama and prints accuracy and median latency per
   intent, so Bas can compare the current 3B model with a 7B (e.g. one he pulls
   himself) on his CPU-only machine. Put the measured result
   (and the model name) in the report; do not claim accuracy you did not
   measure.
7. Update docs/ARCHITECTURE.md.

## Out of scope
Autonomous actions, deleting or bulk-editing, web access, long-term memory,
any model other than a local Ollama one.

## Manual checklist for Bas (put it in the report)
1. "ingetin besok jam 7 bayar kos" in the pet chat shows a confirmation card
   with the right date; Cancel creates nothing.
2. The same sentence from Telegram gives a preview with Confirm/Cancel.
3. A normal chat message ("lagi capek nih") is not slowed down and creates nothing.
4. Ollama stopped: chat degrades to a clear message, nothing crashes.
5. "Suggest steps" on a todo shows steps you can accept selectively.
6. Run `npm run eval:capture` with Ollama running and read the accuracy.
