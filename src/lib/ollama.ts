import { getSetting } from "./db-helpers";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const OLLAMA_URL = "http://localhost:11434/api/chat";
const DEFAULT_MODEL = "llama3.2:3b";

const HISTORY_LIMIT = 6; // keep last 6 messages (≈3 exchanges) for speed
const TIMEOUT_MS = 15000;

// The model is a user setting; cached after the first read so it costs nothing
// per message, and re-read on failure so a settings change takes effect.
let cachedModel: string | null = null;

async function getModel(): Promise<string> {
  if (cachedModel) return cachedModel;
  try {
    cachedModel = (await getSetting("ollama_model"))?.trim() || DEFAULT_MODEL;
  } catch {
    cachedModel = DEFAULT_MODEL;
  }
  return cachedModel;
}

// Built fresh on every request so the model always sees the real current
// time/date (in WIB) and the user's location.
function getSystemPrompt(): string {
  const now = new Date();
  const timeStr = now.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const clockStr = now.toLocaleTimeString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  });
  const weekdayEn = now.toLocaleDateString("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
  });

  return `You are Nox, a tiny desktop pet assistant living in the corner of Bas's screen.

CURRENT CONTEXT:
- Date and time: ${timeStr} WIB (Western Indonesia Time, UTC+7)
- User location: Medan, North Sumatra, Indonesia
- User name: Bas (Sebastian)

STRICT RULES:
- Max 2 sentences per response. Never exceed this.
- Be casual, direct, slightly sarcastic but caring — like a close friend
- Use the current time/date above when asked about time — it is always accurate
- Never make up facts or information you don't have
- If you don't know something, say so in one sentence
- Default language: English. If Bas writes in Indonesian, respond in Indonesian
- You help with: tasks, reminders, schedules, quick questions
- Never start with "I" — vary your sentence starters
- No emojis
- Keep responses SHORT — you live in a tiny speech bubble

Examples of good responses:
User: "jam berapa sekarang?" → "Sekarang ${clockStr} WIB."
User: "what day is it?" → "It's ${weekdayEn}."
User: "hi" → "Hey. What's up?"
User: "explain quantum physics" → "Too long for a speech bubble. Google it, Bas."`;
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

  const model = await getModel();

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: getSystemPrompt() },
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
      cachedModel = null;
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
          cachedModel = null;
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
