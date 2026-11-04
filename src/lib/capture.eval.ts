/**
 * Capture accuracy against the REAL local Ollama (`npm run eval:capture`).
 * Uses the same prompt, schema and pipeline as the app. Model: OLLAMA_MODEL,
 * else llama3.2:3b. Prints accuracy per intent; does not fail on accuracy.
 */
import { it } from "vitest";
import fixtures from "./capture.fixtures.json";
import { extractIntent, type ModelCall, type Proposal } from "./captureCore";

const MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const URL = process.env.OLLAMA_URL || "http://localhost:11434";
const NOW = new Date(2026, 10, 4, 10, 0); // the date the fixtures assume

type Case = {
  text: string;
  expect: { intent: string; title?: string; due?: string | null; time?: string };
};

const pad = (n: number) => String(n).padStart(2, "0");
const day = (o: number) => {
  const d = new Date(2026, 10, 4 + o);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dueOf = (due?: string | null) =>
  due == null ? undefined : due === "today" ? day(0) : due === "tomorrow" ? day(1) : due.startsWith("+") ? day(Number(due.slice(1))) : due;

const ask: ModelCall = async (system, user, schema, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${URL}/api/chat`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: schema,
        options: { temperature: 0, num_predict: 300 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    return JSON.parse(data.message.content);
  } finally {
    clearTimeout(timer);
  }
};

it(`capture accuracy with ${MODEL}`, async () => {
  try {
    const tags = await (await fetch(`${URL}/api/tags`)).json();
    if (!tags.models?.some((m: { name: string }) => m.name === MODEL || m.name.startsWith(`${MODEL}:`))) {
      console.log(`\nModel "${MODEL}" is not installed in Ollama. Run: ollama pull ${MODEL}\n`);
      return;
    }
  } catch {
    console.log(`\nOllama is not reachable at ${URL}. Start it, then run this again.\n`);
    return;
  }

  const stats: Record<string, { n: number; intent: number; full: number }> = {};
  const misses: string[] = [];
  for (const c of (fixtures as { cases: Case[] }).cases) {
    const p: Proposal = await extractIntent(c.text, ask, NOW);
    const s = (stats[c.expect.intent] ??= { n: 0, intent: 0, full: 0 });
    s.n++;
    const intentOk = p.intent === c.expect.intent;
    const fieldsOk =
      intentOk &&
      (p.intent === "chat" ||
        (p.title.toLowerCase() === (c.expect.title ?? "").toLowerCase() &&
          p.due_date === dueOf(c.expect.due) &&
          p.due_time === c.expect.time));
    if (intentOk) s.intent++;
    if (fieldsOk) s.full++;
    else misses.push(`  ${JSON.stringify(c.text)} → ${JSON.stringify(p)}`);
  }
  const total = Object.values(stats).reduce((a, s) => ({ n: a.n + s.n, intent: a.intent + s.intent, full: a.full + s.full }), { n: 0, intent: 0, full: 0 });
  const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
  console.log(`\nCapture eval · model ${MODEL} · ${total.n} phrases`);
  for (const [intent, s] of Object.entries(stats)) {
    console.log(`  ${intent.padEnd(9)} intent ${pct(s.intent, s.n).padStart(4)} · intent+fields ${pct(s.full, s.n).padStart(4)}  (${s.n})`);
  }
  console.log(`  overall   intent ${pct(total.intent, total.n).padStart(4)} · intent+fields ${pct(total.full, total.n).padStart(4)}`);
  if (misses.length) console.log(`\nMisses:\n${misses.join("\n")}\n`);
});
