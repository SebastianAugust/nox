# Queue 03 delta: event intent in natural-language capture

Status: **done**. Gate green: `tsc`, `build`, `npm test` (256), `cargo check`; `cargo test` 56.

## What was built

- **Intent `event`** in `extractIntent` (`src/lib/captureCore.ts`). The schema is now
  `{ intent: todo | reminder | event | chat, title, datePhrase?, timePhrase?, endTimePhrase?,
  location?, priority?, list?, course? }`.
  - Validation is still strict: exactly these keys, enums and length caps (location ≤ 100). The
    prompt explains the new fields.
  - **The model never computes a date or time.** It copies words. Phrases are kept only if Bas
    actually wrote them (also the place and the end), and they are resolved by `todoParse.ts`.
  - On a timeout, invalid JSON or an error, an event-like message falls back to chat (the
    deterministic fallback stays reserved for plain instructions, as before).
- **Two rules for events** (deterministic, in our code, tested):
  - A bare "jam 1" to "jam 6" (no pagi/siang/sore/malam, no am/pm) is read as the afternoon, so
    "rapat himatif jumat jam 2 di sekre" is Friday 14:00. "jam 2 pagi" stays 02:00, and a
    reminder "jam 5" keeps the parser's own reading.
  - With no day written, the event is today if that time is still ahead, otherwise tomorrow.
    This fixes a bug found by the tests: the parser had already moved the date to tomorrow
    because it read "jam 2" as 02:00.
- **Confirmation through `pending_actions` only.** There is no second mechanism.
  - The step 03 confirmation had already moved to pending actions in D2 (the in-memory Telegram
    map and the pet's React state were replaced); this delta only adds the event kind.
  - An event proposal becomes the same `EventDraft` as `/event` (`proposalToDraft`) and is
    offered through D2's `offerEvent`. Confirm creates it through D2's create path
    (`google_create_event`), once.
  - Pet card: Add / Edit / Cancel; Edit puts the `/event` line in the chat input. Telegram:
    inline Confirm / Cancel from the paired chat, expiring after 10 minutes.
  - Never auto-created.
- **Google not connected:** the reply says so ("That looks like an event, but Google Calendar is
  not connected … Save it as a todo instead?") and offers a todo. It has the same date and time,
  and the place in the title. Confirm creates the todo; nothing goes to Google.
- **Cheap gate:** new en/id triggers rapat, meeting, kelas, class, acara, event, jadwal,
  schedule, kuliah, seminar, webinar, janjian, appointment. "jam" was already there.
  "di <place>" / "at <place>" counts **only next to a weekday or a d/m date**, so "aku lagi di
  kos" or "tadi rapatnya lama banget di sekre" never reach the model.
- **Evaluation:**
  - The fixtures grew from 33 to **46 phrases**: 9 event, 17 todo, 10 reminder, 10 chat. They
    are id and en, mixed register, with typos ("rapt bem besok jam 4 sampe jam 6", "remnd me to
    take meds at 9pm", "tambahin tgas basdat buat jumat"), and include "rapat himatif jumat jam 2
    di sekre".
  - `npm run eval:capture [-- --model <name>] [-- --url <url>]` now goes through
    `scripts/eval-capture.mjs`, because vitest rejects unknown flags.
  - Per expected intent it prints intent accuracy, intent+fields accuracy (for events also the
    end and the place) and the **median latency** of the model calls.
  - The first call, which loads the model into RAM, is reported separately and is not in the
    medians. It also prints the timeouts, the CPU and the RAM.

## Measured result

**Not measured.** On this machine Ollama answers at `localhost:11434`, but no model is
installed (`/api/tags` → `{"models":[]}`). Both runs print, for example:

```
Model "llama3.2:3b" is not installed in Ollama (installed: none). Run: ollama pull llama3.2:3b
Model "qwen2.5:7b" is not installed in Ollama (installed: none). Run: ollama pull qwen2.5:7b
```

Nothing was pulled (a multi-GB download nobody asked for). There are no accuracy or latency
numbers here, for either model. To compare on your Core Ultra 7 (16 GB, CPU only):

```
ollama pull llama3.2:3b
npm run eval:capture
ollama pull qwen2.5:7b          (or any 7B you prefer)
npm run eval:capture -- --model qwen2.5:7b
```

A practical note, not a measurement: the app's capture timeout is 20 s. If the 7B's median gets
close to that on CPU, the eval shows it as timeouts, and in the app those messages fall back to
chat.

## Files changed or added in this delta

- `src/lib/captureCore.ts` (event intent, schema, prompt, gate, `proposalToDraft`,
  `eventAsTodo`, `TaskProposal` / `EventProposal`)
- `src/lib/capture.ts` (types narrowed to todo/reminder)
- `src/lib/confirmations.ts` (`offerCapture` handles events: Google → `offerEvent`, otherwise a
  todo)
- `src/lib/capture.fixtures.json` (46 phrases)
- `src/lib/capture.test.ts`, `src/lib/captureEvent.test.ts` (new)
- `src/lib/capture.eval.ts` (latency, events, hardware line)
- `scripts/eval-capture.mjs` (new), `package.json` (`eval:capture`)
- `src/lib/i18n.ts` (`cap.eventNoGoogle` en + id)
- `docs/ARCHITECTURE.md`

No Rust changes. **No migration** (no new setting).

## Tests (mocked Ollama)

- All 46 fixtures through the full pipeline with a mocked model, including the event date, time,
  end and place.
- Schema: event fields accepted; unknown keys, a wrong intent, an over-long location, a missing
  title and broken JSON rejected.
- "jam 2" → 14:00. An invented day, end or place is dropped. A time without a day gives today,
  not tomorrow. "jam 2 pagi" and a reminder's "jam 5" are unchanged.
- A timeout or invalid JSON on an event message gives chat.
- `proposalToDraft` defaults (1 hour, all-day, today) and `eventAsTodo`.
- Gate: event words pass, casual talk with "di …" does not.
- With Google connected: a pending `event` action; Confirm creates it once, through the fake
  Google.
- Without Google: the message says so, the action is a todo, Confirm creates the todo and nothing
  reaches Google.

## Deviations

- "di <place>" alone is not a trigger; it needs a weekday or date next to it, so casual talk
  stays fast (spec rule 2).
- The afternoon rule for "jam 1–6" is our own deterministic rule, not the model's.
- Edit on an event card opens the `/event` line in the pet chat (D2's event preview path), not
  the Todos quick-add.

## Not tested live

- No real Ollama run (no model installed), so no accuracy or latency numbers.
- No real Google Calendar (see the D2 report).
- The pet card and Telegram buttons for an event proposal were not tried in the running app.

## Manual checklist for Bas (from the spec, plus events)

1. "ingetin besok jam 7 bayar kos" in the pet chat shows a confirmation card with the right date;
   Cancel creates nothing.
2. The same sentence from Telegram gives a preview with Confirm/Cancel.
3. A normal chat message ("lagi capek nih") is not slowed down and creates nothing.
4. Ollama stopped: chat degrades to a clear message, nothing crashes.
5. "Suggest steps" on a todo shows steps you can accept selectively.
6. Run `npm run eval:capture` with Ollama running and read the accuracy.

Extra for this delta:

7. "rapat himatif jumat jam 2 di sekre" (pet and Telegram): a card for Friday 14:00–15:00 at
   sekre; Confirm creates it in Google Calendar with a link; Cancel creates nothing.
8. With Google disconnected, the same sentence says Google is not connected and offers a todo.
9. `npm run eval:capture -- --model <your 7B>` and compare accuracy and median latency with the
   3B.
