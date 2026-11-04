/**
 * Capture accuracy and speed against the REAL local Ollama:
 *
 *   npm run eval:capture                       (model from OLLAMA_MODEL, else llama3.2:3b)
 *   npm run eval:capture -- --model qwen2.5:7b
 *
 * Same prompt, schema and pipeline as the app. Prints, per expected intent:
 * intent accuracy, intent+fields accuracy, and the median latency of the
 * model calls (the first call, which loads the model into RAM, is measured
 * separately and left out of the medians). Does not fail on accuracy.
 * Phrases the cheap gate keeps from the model make no call (no latency).
 */
import { it } from "vitest";
import os from "node:os";
import fixtures from "./capture.fixtures.json";
import { extractIntent, type ModelCall, type Proposal } from "./captureCore";

const MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const URL = process.env.OLLAMA_URL || "http://localhost:11434";
const NOW = new Date(2026, 10, 4, 10, 0); // the date the fixtures assume

type Case = {
  text: string;
  expect: { intent: string; title?: string; due?: string | null; time?: string; end?: string; location?: string };
};

const pad = (n: number) => String(n).padStart(2, "0");
const day = (o: number) => {
  const d = new Date(2026, 10, 4 + o);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dueOf = (due?: string | null) =>
  due == null ? undefined : due === "today" ? day(0) : due === "tomorrow" ? day(1) : due.startsWith("+") ? day(Number(due.slice(1))) : due;

const call = async (system: string, user: string, schema: object, timeoutMs: number): Promise<unknown> => {
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

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = (ms: number | null) => (ms === null ? "   -  " : `${(ms / 1000).toFixed(1).padStart(5)}s`);

function fieldsOk(p: Proposal, e: Case["expect"]): boolean {
  if (p.intent !== e.intent) return false;
  if (p.intent === "chat") return true;
  const same = p.title.toLowerCase() === (e.title ?? "").toLowerCase() && p.due_date === dueOf(e.due) && p.due_time === e.time;
  if (p.intent !== "event") return same;
  return same && p.end_time === e.end && (p.location ?? "").toLowerCase() === (e.location ?? "").toLowerCase();
}

it(`capture accuracy with ${MODEL}`, async () => {
  try {
    const tags = await (await fetch(`${URL}/api/tags`)).json();
    if (!tags.models?.some((m: { name: string }) => m.name === MODEL || m.name.startsWith(`${MODEL}:`))) {
      const have = (tags.models ?? []).map((m: { name: string }) => m.name).join(", ") || "none";
      console.log(`\nModel "${MODEL}" is not installed in Ollama (installed: ${have}). Run: ollama pull ${MODEL}\n`);
      return;
    }
  } catch {
    console.log(`\nOllama is not reachable at ${URL}. Start it, then run this again.\n`);
    return;
  }

  // Load the model first, so its load time does not count as a phrase's latency.
  const t0 = performance.now();
  await call("Reply with JSON.", "hi", { type: "object" }, 10 * 60 * 1000).catch(() => null);
  const loadMs = performance.now() - t0;

  const stats: Record<string, { n: number; intent: number; full: number; ms: number[] }> = {};
  const misses: string[] = [];
  let timeouts = 0;
  for (const c of (fixtures as { cases: Case[] }).cases) {
    let ms: number | null = null;
    const ask: ModelCall = async (system, user, schema, timeoutMs) => {
      const start = performance.now();
      try {
        return await call(system, user, schema, timeoutMs);
      } catch (err) {
        if ((err as Error).name === "AbortError") timeouts++;
        throw err;
      } finally {
        ms = performance.now() - start;
      }
    };
    const p = await extractIntent(c.text, ask, NOW);
    const s = (stats[c.expect.intent] ??= { n: 0, intent: 0, full: 0, ms: [] });
    s.n++;
    if (ms !== null) s.ms.push(ms);
    if (p.intent === c.expect.intent) s.intent++;
    if (fieldsOk(p, c.expect)) s.full++;
    else misses.push(`  ${JSON.stringify(c.text)} → ${JSON.stringify(p)}`);
  }

  const all = Object.values(stats);
  const total = all.reduce((a, s) => ({ n: a.n + s.n, intent: a.intent + s.intent, full: a.full + s.full }), { n: 0, intent: 0, full: 0 });
  const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`.padStart(4);
  const cpu = os.cpus()[0]?.model?.trim() ?? "unknown CPU";
  console.log(`\nCapture eval · model ${MODEL} · ${total.n} phrases · ${cpu}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`);
  console.log(`  model load (first call): ${secs(loadMs)}   timeouts (20 s): ${timeouts}`);
  console.log("  intent     intent  +fields  median   (phrases, model calls)");
  for (const [intent, s] of Object.entries(stats)) {
    console.log(`  ${intent.padEnd(9)}  ${pct(s.intent, s.n)}    ${pct(s.full, s.n)}   ${secs(median(s.ms))}  (${s.n}, ${s.ms.length})`);
  }
  const allMs = all.flatMap((s) => s.ms);
  console.log(`  overall    ${pct(total.intent, total.n)}    ${pct(total.full, total.n)}   ${secs(median(allMs))}  (${total.n}, ${allMs.length})`);
  if (misses.length) console.log(`\nMisses (intent or fields):\n${misses.join("\n")}\n`);
});
