import { Channel, invoke } from "@tauri-apps/api/core";
import { getSettings } from "./db";
import { t } from "./i18n";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const DEFAULT_MODEL = "llama3.2:3b";

const HISTORY_LIMIT = 6; // keep last 6 messages (≈3 exchanges) for speed
const TIMEOUT_MS = 15000;

type PromptSettings = {
  model: string;
  name: string;
  location: string;
  timeZone: string | undefined;
  language: "en" | "id";
};

/**
 * Everything the prompt depends on comes from settings and is read on every
 * request, so a change in the dashboard applies to the very next message.
 */
async function readPromptSettings(): Promise<PromptSettings> {
  const s = await getSettings([
    "ollama_model",
    "user_name",
    "user_location",
    "user_timezone",
    "language",
  ]).catch((err) => {
    console.error(err);
    return {} as Record<string, string>;
  });

  // An unknown zone name would make Intl throw; fall back to the system zone.
  let timeZone: string | undefined = s.user_timezone?.trim() || undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    timeZone = undefined;
  }

  return {
    model: s.ollama_model?.trim() || DEFAULT_MODEL,
    name: s.user_name?.trim() || "there",
    location: s.user_location?.trim() || "unknown",
    timeZone,
    language: s.language === "id" ? "id" : "en",
  };
}

// Built fresh on every request so the model always sees the real current
// time/date in the user's timezone.
function getSystemPrompt({ name, location, timeZone, language }: PromptSettings): string {
  const now = new Date();
  const locale = language === "id" ? "id-ID" : "en-US";
  const dateTime = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(now);
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const zoneLabel = [timeZone, offset].filter(Boolean).join(", ");

  const languageRule =
    language === "id"
      ? "- Always reply in Indonesian, even when the user writes in English. Balas dalam Bahasa Indonesia."
      : "- Always reply in English, even when the user writes in Indonesian.";

  const examples =
    language === "id"
      ? `User: "jam berapa sekarang?" → "Sekarang jam ${clock}."
User: "hari apa sekarang?" → "Hari ini ${weekday}."
User: "hi" → "Hai. Ada apa?"
User: "jelasin fisika kuantum" → "Kepanjangan buat gelembung sekecil ini. Coba Google, ${name}."`
      : `User: "what time is it?" → "It's ${clock}."
User: "what day is it?" → "It's ${weekday}."
User: "hi" → "Hey. What's up?"
User: "explain quantum physics" → "Too long for a speech bubble. Google it, ${name}."`;

  return `You are Nox, a tiny desktop pet assistant living in the corner of ${name}'s screen.

CURRENT CONTEXT:
- Date and time: ${dateTime}${zoneLabel ? ` (${zoneLabel})` : ""}
- User location: ${location}
- User name: ${name}

STRICT RULES:
- Max 2 sentences per response. Never exceed this.
- Be casual, direct, slightly sarcastic but caring — like a close friend
- Use the current time/date above when asked about time — it is always accurate
- Never make up facts or information you don't have
- If you don't know something, say so in one sentence
${languageRule}
- You help with: tasks, reminders, schedules, quick questions
- Never start with "I" — vary your sentence starters
- No emojis
- Keep responses SHORT — you live in a tiny speech bubble

Examples of good responses:
${examples}`;
}

/**
 * Ollama answers a missing model with e.g. `model "x" not found, try pulling
 * it first`; only that deserves the "ollama pull" hint.
 */
function modelMissing(errorText: string): boolean {
  return /model/i.test(errorText) && /not found|pull/i.test(errorText);
}

/** What the Rust `ollama_chat` command streams back, one message at a time. */
type OllamaEvent =
  | { kind: "line"; text: string }
  | { kind: "httpError"; status: number; body: string }
  | { kind: "unreachable" }
  | { kind: "end" };

let nextRequestId = 1;

/**
 * Stream a chat completion from Ollama.
 *
 * The HTTP request runs in Rust (`ollama_chat`), not in the webview: a release
 * build's page origin is http://tauri.localhost, which Ollama's default CORS
 * allow-list rejects. Rust streams the NDJSON lines back over a Channel.
 *
 * `message` is the new user turn; `history` is the prior conversation (trimmed
 * to the last few turns here). The caller owns `controller` so the UI can abort
 * (stop button); a 15s timeout also aborts it. Results are delivered via
 * callbacks — `onDone` on normal completion or user-stop, `onError` with a
 * bubble-safe message on failure/timeout. Exactly one of them fires.
 */
export async function chat(
  message: string,
  history: ChatMessage[],
  controller: AbortController,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  const settings = await readPromptSettings();
  const model = settings.model;
  const requestId = nextRequestId++;
  const body = {
    model,
    messages: [
      { role: "system", content: getSystemPrompt(settings) },
      ...history.slice(-HISTORY_LIMIT),
      { role: "user", content: message },
    ],
    stream: true,
    options: {
      num_predict: 80, // ≈2 sentences
      temperature: 0.7,
      top_p: 0.9,
      repeat_penalty: 1.1,
    },
  };

  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (report: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      report();
      resolve();
    };
    const cancel = () =>
      invoke("ollama_cancel", { requestId }).catch(console.error);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_MS);

    // A user stop finalizes normally so any partial text is kept; a timeout
    // reports an error instead.
    const onAbort = () => {
      cancel();
      finish(timedOut ? () => onError(t("ollama.timeout")) : onDone);
    };
    controller.signal.addEventListener("abort", onAbort);

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let data: any;
      try {
        data = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (data.error) {
        cancel();
        finish(() =>
          onError(
            modelMissing(String(data.error))
              ? t("ollama.modelMissing", { model })
              : t("ollama.failed"),
          ),
        );
        return;
      }
      if (data.message?.content && !finished) onChunk(data.message.content);
      if (data.done) finish(onDone);
    };

    const channel = new Channel<OllamaEvent>();
    channel.onmessage = (event) => {
      if (finished) return;
      switch (event.kind) {
        case "line":
          handleLine(event.text);
          break;
        case "httpError":
          finish(() =>
            onError(
              modelMissing(event.body)
                ? t("ollama.modelMissing", { model })
                : t("ollama.error", { status: event.status }),
            ),
          );
          break;
        case "unreachable":
          finish(() => onError(t("ollama.unreachable")));
          break;
        case "end":
          finish(onDone);
          break;
      }
    };

    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    invoke("ollama_chat", { requestId, body, onEvent: channel }).catch((err) => {
      console.error(err);
      finish(() => onError(t("ollama.failed")));
    });
  });
}
