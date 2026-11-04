import { Channel, invoke } from "@tauri-apps/api/core";
import { getSettings } from "./db";
import { t } from "./i18n";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const DEFAULT_MODEL = "llama3.2:3b";

/** Messages of context sent with each question (≈3 exchanges), kept short for speed. */
export const HISTORY_LIMIT = 6;
// A cold model load (Ollama unloads idle models) can take a while before the
// first token; after that, a long silence means it is stuck.
const FIRST_TOKEN_MS = 45000;
const SILENCE_MS = 15000;
const KEEP_ALIVE = "30m";

/**
 * Cut a reply that hit the token limit back to its last full sentence, so it
 * does not end mid-word. Left alone when there is no sentence end to cut at.
 */
export function trimToSentence(text: string): string {
  const ends = [...text.matchAll(/[.!?…]+["')\]]*(?=\s|$)/g)];
  const last = ends[ends.length - 1];
  return last ? text.slice(0, last.index + last[0].length) : text;
}

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
 * One structured answer from the local model: temperature 0, `format` set
 * to a JSON schema, a hard timeout. Resolves the parsed JSON content, or
 * rejects (Ollama off, model missing, timeout, not JSON). For capture and
 * step suggestions; the caller validates the shape.
 */
export async function askJson(system: string, user: string, schema: object, timeoutMs: number): Promise<unknown> {
  const s = await getSettings(["ollama_model"]).catch(() => ({}) as Record<string, string>);
  const requestId = nextRequestId++;
  const body = {
    model: s.ollama_model?.trim() || DEFAULT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    format: schema,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0, num_predict: 300 },
  };
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      invoke("ollama_cancel", { requestId }).catch(() => {});
      finish(() => reject(new Error("timeout")));
    }, timeoutMs);
    let text = "";
    const channel = new Channel<OllamaEvent>();
    channel.onmessage = (event) => {
      if (event.kind === "line") text += event.text;
      else if (event.kind === "httpError") finish(() => reject(new Error(`http ${event.status}`)));
      else if (event.kind === "unreachable") finish(() => reject(new Error("unreachable")));
      else
        finish(() => {
          try {
            const data = JSON.parse(text.trim());
            if (data.error) throw new Error(String(data.error));
            resolve(JSON.parse(data.message?.content ?? ""));
          } catch (err) {
            reject(err);
          }
        });
    };
    invoke("ollama_chat", { requestId, body, onEvent: channel }).catch((err) => finish(() => reject(err)));
  });
}

/**
 * One short reply with a hard deadline, or null (Ollama off, slow, cut off or
 * failing). Used for the briefing's friendly opener; callers always have a
 * static fallback, so nothing depends on the model.
 */
export function quickReply(prompt: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  return new Promise((resolve) => {
    void chat(
      prompt,
      [],
      controller,
      () => {},
      (reply, cutOff) => {
        clearTimeout(timer);
        resolve(expired || cutOff || !reply.trim() ? null : reply.trim());
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Stream a chat completion from Ollama.
 *
 * The HTTP request runs in Rust (`ollama_chat`), not in the webview: a release
 * build's page origin is http://tauri.localhost, which Ollama's default CORS
 * allow-list rejects. Rust streams the NDJSON lines back over a Channel.
 *
 * `message` is the new user turn; `history` is the prior conversation (trimmed
 * to the last few turns here). The caller owns `controller` so the UI can abort
 * (stop button). It also times out: FIRST_TOKEN_MS until the first token, then
 * SILENCE_MS between chunks.
 *
 * `onChunk` gets the reply so far. `onDone` gets the final reply on normal
 * completion, user-stop or a timeout after some text (`cutOff` true); a reply
 * that hit the token limit is trimmed to its last full sentence. `onError`
 * gets a bubble-safe message on failure, or a timeout before any text.
 * Exactly one of `onDone` / `onError` fires.
 */
export async function chat(
  message: string,
  history: ChatMessage[],
  controller: AbortController,
  onChunk: (textSoFar: string) => void,
  onDone: (reply: string, cutOff: boolean) => void,
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
    keep_alive: KEEP_ALIVE, // keep the model loaded between questions
    options: {
      num_predict: 80, // ≈2 sentences
      temperature: 0.7,
      top_p: 0.9,
      repeat_penalty: 1.1,
    },
  };

  return new Promise<void>((resolve) => {
    let finished = false;
    let reply = "";
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
    const expire = () => {
      timedOut = true;
      controller.abort();
    };
    let timeout = setTimeout(expire, FIRST_TOKEN_MS);
    // Any sign of life restarts the silence clock.
    const alive = () => {
      clearTimeout(timeout);
      timeout = setTimeout(expire, SILENCE_MS);
    };

    // A user stop finalizes normally so any partial text is kept; so does a
    // timeout once something arrived (marked as cut off). Only a timeout with
    // nothing to show is an error.
    const onAbort = () => {
      cancel();
      finish(() =>
        timedOut && !reply ? onError(t("ollama.timeout")) : onDone(reply, timedOut),
      );
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
      if (data.message?.content && !finished) {
        reply += data.message.content;
        onChunk(reply);
      }
      if (data.done) {
        const final = data.done_reason === "length" ? trimToSentence(reply) : reply;
        finish(() => onDone(final, false));
      }
    };

    const channel = new Channel<OllamaEvent>();
    channel.onmessage = (event) => {
      if (finished) return;
      switch (event.kind) {
        case "line":
          alive();
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
          finish(() => onDone(reply, false));
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
