import { getSettings } from "./db";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const OLLAMA_URL = "http://localhost:11434/api/chat";
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
 * Stream a chat completion from Ollama.
 *
 * `message` is the new user turn; `history` is the prior conversation (trimmed
 * to the last few turns here). The caller owns `controller` so the UI can abort
 * (stop button); a 15s timeout also aborts it. Results are delivered via
 * callbacks — `onDone` on normal completion or user-stop, `onError` with a
 * bubble-safe message on failure/timeout.
 */
export async function chat(
  message: string,
  history: ChatMessage[],
  controller: AbortController,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): Promise<void> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    onError("Taking too long... try a shorter question.");
  }, TIMEOUT_MS);

  const settings = await readPromptSettings();
  const model = settings.model;

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
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
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      clearTimeout(timeout);
      onError(
        /model/i.test(body)
          ? `Model not loaded. Run \`ollama pull ${model}\`.`
          : "Something went wrong. Try again.",
      );
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeout);
      onError("Something went wrong. Try again.");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Ollama emits newline-delimited JSON; keep the trailing partial line.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let data: any;
        try {
          data = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (data.error) {
          clearTimeout(timeout);
              onError(
            /model/i.test(String(data.error))
              ? `Model not loaded. Run \`ollama pull ${model}\`.`
              : "Something went wrong. Try again.",
          );
          return;
        }
        if (data.message?.content) onChunk(data.message.content);
        if (data.done) {
          clearTimeout(timeout);
          onDone();
          return;
        }
      }
    }

    clearTimeout(timeout);
    onDone();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      // Timeout already reported via onError; a user-triggered stop finalizes
      // normally so any partial text is kept.
      if (!timedOut) onDone();
      return;
    }
    // fetch() rejects on connection refused / network failure.
    onError("Can't reach Ollama. Is it running?");
  }
}
