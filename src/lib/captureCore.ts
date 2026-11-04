/**
 * Natural-language capture, the pure part: a cheap gate, the prompt and JSON
 * schema for the local model, strict validation of what it returns, and the
 * conversion to a proposal. Imports only other pure code, so the unit tests
 * and the `npm run eval:capture` script use exactly this.
 *
 * The model only extracts words. Dates and times are never computed by it:
 * its `datePhrase` / `timePhrase` must appear in the user's own text, and are
 * resolved by todoParse against today's date. Nothing is saved from here;
 * the caller shows a confirmation first.
 */

import { parseQuickAdd, type Priority, type QuickAdd } from "./todoParse";
import type { EventDraft } from "./eventParse";

export type Intent = "todo" | "reminder" | "event" | "chat";

/** What the model is asked to return. */
export type Extraction = {
  intent: Intent;
  title?: string;
  datePhrase?: string;
  timePhrase?: string;
  /** Events: the words about when it ends ("15:30", "jam 4"). */
  endTimePhrase?: string;
  /** Events: the place, as written ("sekre", "aula"). */
  location?: string;
  priority?: "low" | "medium" | "high";
  list?: string;
  course?: string;
};

export type Proposal =
  | {
      intent: "todo" | "reminder";
      title: string;
      due_date?: string;
      due_time?: string;
      priority: Priority;
      list?: string;
      course?: string;
      /** Where it came from: the model, or the deterministic parser. */
      source: "model" | "parser";
    }
  | {
      /** A calendar event (Google Calendar, after a confirmation). */
      intent: "event";
      title: string;
      due_date?: string;
      /** Start, local HH:MM; none = all-day. */
      due_time?: string;
      end_time?: string;
      location?: string;
      source: "model";
    }
  | { intent: "chat" };

/** A todo or reminder proposal (what `applyProposal` creates). */
export type TaskProposal = Extract<Proposal, { intent: "todo" | "reminder" }>;
export type EventProposal = Extract<Proposal, { intent: "event" }>;

// ── The cheap gate ──

// Words that make a task or reminder possible (en + id, casual spellings).
const TRIGGERS = [
  "ingetin", "ingatin", "ingatkan", "ingetkan", "inget", "ingat", "remind", "reminder", "jangan lupa", "jgn lupa",
  "tambah", "tambahin", "catat", "catet", "todo", "to do", "tugas", "deadline", "tenggat", "dikumpul", "kumpul",
  "besok", "lusa", "nanti", "malam ini", "pagi ini", "tomorrow", "tonight", "today", "hari ini", "minggu depan",
  "next week", "jam", "pukul", "harus", "must", "need to", "don't forget", "dont forget", "add",
  // Events (en + id).
  "rapat", "meeting", "kelas", "class", "acara", "event", "jadwal", "schedule", "kuliah", "seminar", "webinar",
  "janjian", "appointment", "kumpul-kumpul",
];
const TRIGGER_RE = new RegExp(`(?:^|[^\\p{L}])(?:${TRIGGERS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?=$|[^\\p{L}])`, "iu");
const CLOCK_RE = /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b/i;
// "di <place>" / "at <place>" is an event hint only next to a day word:
// "di sekre jumat" is, "lagi di kos" alone is not (casual talk stays fast).
const PLACE_RE = /(?:^|\s)(?:di|at)\s+\p{L}/iu;
const DAY_RE =
  /(?:^|[^\p{L}])(?:senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})(?=$|[^\p{L}])/iu;

/** Only text that may be a task or event goes to the model; casual talk skips it. */
export function mayBeTask(text: string): boolean {
  const s = text.trim();
  if (s.length < 3 || s.length > 500 || s.startsWith("/")) return false;
  return TRIGGER_RE.test(s) || CLOCK_RE.test(s) || (PLACE_RE.test(s) && DAY_RE.test(s));
}

// Text that is plainly an instruction to note something down.
const COMMANDISH = /^(?:tolong\s+)?(ingetin|ingatin|ingatkan|ingetkan|remind me( to)?|catat|catet|tambah(?:in)?|jangan lupa|todo:?|add)\b[\s,:]*/i;

// ── Model prompt and schema ──

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["todo", "reminder", "event", "chat"] },
    title: { type: "string" },
    datePhrase: { type: "string" },
    timePhrase: { type: "string" },
    endTimePhrase: { type: "string" },
    location: { type: "string" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    list: { type: "string" },
    course: { type: "string" },
  },
  required: ["intent"],
} as const;

export const EXTRACTION_SYSTEM = `You read one chat message and decide if it asks to note a task, set a reminder, or put an event in the calendar.
Reply with JSON only, matching the schema.
- intent: "reminder" when the user wants to be reminded at a time ("ingetin", "remind me", "jangan lupa ... jam ..."), "event" when it is something that happens at a time or place to put in the calendar (a meeting, class, "rapat", "kelas", "acara", "meeting with ..."), "todo" when it is something to do, "chat" for anything else (feelings, questions, small talk, stories about the past).
- title: the task or event itself, short, in the user's language, without the words about day, time or place and without "ingetin"/"remind me".
- datePhrase: copy the exact words about the day from the message ("besok", "jumat", "lusa", "25/12", "tomorrow"). Leave it out if there are none. Never compute or invent a date.
- timePhrase: copy the exact words about the (start) time ("jam 7", "18:30", "7pm", "jam 6 sore"). Leave it out if there are none.
- endTimePhrase: events only, the exact words about when it ends ("15:30", "jam 4"), from "14:00-15:30" or "sampai jam 4". Leave it out if there are none.
- location: events only, the place as written after "di" / "at" ("sekre", "aula", "lab 2"). Leave it out if there is none.
- priority: only if the message says it is urgent/important ("high") or not ("low").
- list / course: only if named with # or @.`;

// ── Validation ──

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Accept the model's JSON only if it has exactly the expected shape. */
export function validateExtraction(raw: unknown): Extraction | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const allowed = new Set(Object.keys(EXTRACTION_SCHEMA.properties));
  if (Object.keys(o).some((k) => !allowed.has(k))) return null;
  if (o.intent !== "todo" && o.intent !== "reminder" && o.intent !== "event" && o.intent !== "chat") return null;
  const out: Extraction = { intent: o.intent };
  const fields = [
    ["title", 200],
    ["datePhrase", 40],
    ["timePhrase", 40],
    ["endTimePhrase", 40],
    ["location", 100],
    ["list", 40],
    ["course", 80],
  ] as const;
  for (const [key, max] of fields) {
    if (o[key] === undefined || o[key] === null || o[key] === "") continue;
    if (!isStr(o[key], max)) return null;
    out[key] = (o[key] as string).trim();
  }
  if (o.priority !== undefined && o.priority !== null && o.priority !== "") {
    if (o.priority !== "low" && o.priority !== "medium" && o.priority !== "high") return null;
    out.priority = o.priority;
  }
  if (out.intent !== "chat" && !out.title) return null;
  return out;
}

// ── Turning it into a proposal ──

const PRIORITY: Record<string, Priority> = { low: 1, medium: 2, high: 3 };
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");

/** A phrase counts only if the user actually wrote it (no invented dates). */
function written(phrase: string | undefined, text: string): string | undefined {
  if (!phrase) return undefined;
  return fold(text).includes(fold(phrase)) ? phrase : undefined;
}

function resolveWhen(datePhrase: string | undefined, timePhrase: string | undefined, now: Date): Pick<QuickAdd, "due_date" | "due_time"> {
  const tail = [datePhrase, timePhrase].filter(Boolean).join(" ");
  if (!tail) return {};
  const q = parseQuickAdd(`x ${tail}`, now);
  // Only accept it when the parser used every word of the phrases.
  if (q.title !== "x") {
    const onlyDate = datePhrase ? parseQuickAdd(`x ${datePhrase}`, now) : null;
    return onlyDate?.title === "x" ? { due_date: onlyDate.due_date } : {};
  }
  return { due_date: q.due_date, due_time: q.due_time };
}

/**
 * A meeting at "jam 2" is at 14:00, not 02:00: for events, a bare "jam 1" to
 * "jam 6" (no pagi/siang/sore/malam, no am/pm) is read as the afternoon.
 * Only events: a reminder "jam 5" keeps the parser's own reading.
 */
function eventClock(phrase: string | undefined, time: string | undefined): string | undefined {
  if (!phrase || !time) return time;
  if (!/^(?:jam|pukul)\s+[1-6](?:[:.]\d{2})?$/i.test(phrase.trim())) return time;
  const [h, m] = time.split(":").map(Number);
  return h >= 1 && h <= 6 ? `${String(h + 12).padStart(2, "0")}:${String(m).padStart(2, "0")}` : time;
}

/** The end time of an event: a phrase the user wrote, read by the parser. */
function resolveEnd(phrase: string | undefined, now: Date): string | undefined {
  if (!phrase) return undefined;
  const q = parseQuickAdd(`x ${phrase.replace(/^(?:sampai|sampe|until|till|to|-)\s+/i, "")}`, now);
  return q.title === "x" ? eventClock(phrase.replace(/^(?:sampai|sampe|until|till|to|-)\s+/i, ""), q.due_time) : undefined;
}

function toEvent(e: Extraction, text: string, now: Date): EventProposal {
  const timePhrase = written(e.timePhrase, text);
  const datePhrase = written(e.datePhrase, text);
  const when = resolveWhen(datePhrase, timePhrase, now);
  const start = eventClock(timePhrase, when.due_time);
  // No day written: the parser picked today or tomorrow for its own reading
  // of the time ("jam 2" = 02:00, already past). Decide again with the event
  // time: today if it is still ahead, else tomorrow.
  if (start && !datePhrase) {
    const [h, m] = start.split(":").map(Number);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    when.due_date = ymd(at.getTime() > now.getTime() ? now : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  }
  let end = start ? resolveEnd(written(e.endTimePhrase, text), now) : undefined;
  // "jam 2 sampai jam 4": both afternoon. An end before the start is dropped
  // (default length) unless it is clearly the next morning.
  if (start && end && end <= start && Number(end.slice(0, 2)) >= 6) end = undefined;
  const out: EventProposal = { intent: "event", title: e.title!.replace(/\s+/g, " ").trim(), source: "model" };
  if (when.due_date) out.due_date = when.due_date;
  if (start) out.due_time = start;
  if (end) out.end_time = end;
  const place = written(e.location, text);
  if (place) out.location = place;
  return out;
}

/** The model's extraction, checked and resolved, as a proposal to confirm. */
export function toProposal(e: Extraction, text: string, now = new Date()): Proposal {
  if (e.intent === "chat" || !e.title) return { intent: "chat" };
  if (e.intent === "event") return toEvent(e, text, now);
  const when = resolveWhen(written(e.datePhrase, text), written(e.timePhrase, text), now);
  // A reminder needs a time; without one it is a todo.
  const intent = e.intent === "reminder" && !when.due_time ? "todo" : e.intent;
  const out: Proposal = {
    intent,
    title: e.title.replace(/\s+/g, " ").trim(),
    priority: e.priority ? PRIORITY[e.priority] : 0,
    source: "model",
    ...when,
  };
  if (e.list) out.list = e.list.replace(/^#/, "");
  if (e.course) out.course = e.course.replace(/^@/, "");
  return out;
}

/**
 * Without the model (timeout, invalid JSON, Ollama off): text that is
 * plainly an instruction ("ingetin besok jam 7 bayar kos") goes through the
 * deterministic parser; anything else is chat.
 */
export function fallbackProposal(text: string, now = new Date()): Proposal {
  const m = COMMANDISH.exec(text.trim());
  if (!m) return { intent: "chat" };
  const verb = m[1].toLowerCase();
  const rest = text.trim().slice(m[0].length);
  // "besok jam 7 bayar kos": the parser reads dates from the end, so move a
  // leading day/time phrase behind the title first.
  const lead = /^((?:hari ini|besok|lusa|today|tomorrow)(?:\s+(?:jam|pukul)\s+\d{1,2}(?:[:.]\d{2})?(?:\s+(?:pagi|siang|sore|malam))?)?|(?:jam|pukul)\s+\d{1,2}(?:[:.]\d{2})?(?:\s+(?:pagi|siang|sore|malam))?)\s+(.+)$/i.exec(rest);
  const q = parseQuickAdd(lead ? `${lead[2]} ${lead[1]}` : rest, now);
  if (!q.title) return { intent: "chat" };
  const reminder = /^(ingetin|ingatin|ingatkan|ingetkan|remind me|jangan lupa)/.test(verb) && !!q.due_time;
  return {
    intent: reminder ? "reminder" : "todo",
    title: q.title,
    due_date: q.due_date,
    due_time: q.due_time,
    priority: q.priority,
    list: q.list,
    course: q.course,
    source: "parser",
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * An event proposal as the event draft step 02 creates from (same path as
 * `/event`): today without a date, all-day without a time, 1 hour without
 * an end, past midnight when the end is earlier.
 */
export function proposalToDraft(p: EventProposal, now = new Date()): EventDraft {
  const date = p.due_date ?? ymd(now);
  const addDay = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return ymd(new Date(y, m - 1, d + 1));
  };
  const place = p.location ? { location: p.location } : {};
  if (!p.due_time) return { title: p.title, date, allDay: true, endDate: addDay(date), ...place };
  let end = p.end_time;
  if (!end) {
    const [h, m] = p.due_time.split(":").map(Number);
    const total = h * 60 + m + 60;
    end = `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
  }
  return { title: p.title, date, allDay: false, start: p.due_time, end, endDate: end <= p.due_time ? addDay(date) : date, ...place };
}

/** An event offered as a todo instead (Google Calendar not connected). */
export function eventAsTodo(p: EventProposal): TaskProposal {
  return {
    intent: "todo",
    title: p.location ? `${p.title} (${p.location})` : p.title,
    priority: 0,
    source: "parser",
    ...(p.due_date ? { due_date: p.due_date } : {}),
    ...(p.due_time ? { due_time: p.due_time } : {}),
  };
}

/** Quick-add text for "Edit": the parser reads it back the same way. */
export function proposalAsQuickAdd(p: Proposal): string {
  if (p.intent === "chat" || p.intent === "event") return "";
  const parts = [p.title];
  if (p.due_date) {
    const [, m, d] = p.due_date.split("-").map(Number);
    parts.push(`${d}/${m}`);
  }
  if (p.due_time) parts.push(p.due_time);
  if (p.priority) parts.push(["", "!low", "!med", "!high"][p.priority]);
  if (p.list) parts.push(`#${p.list}`);
  if (p.course) parts.push(`@${p.course}`);
  return parts.join(" ");
}

export type ModelCall = (system: string, user: string, schema: object, timeoutMs: number) => Promise<unknown>;

export const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The whole pipeline: gate → model → validate → resolve, with the fallbacks.
 * `ask` is the model call (Ollama in the app, a mock in tests).
 */
export async function extractIntent(text: string, ask: ModelCall, now = new Date()): Promise<Proposal> {
  if (!mayBeTask(text)) return { intent: "chat" };
  let raw: unknown;
  try {
    raw = await ask(EXTRACTION_SYSTEM, text, EXTRACTION_SCHEMA, CAPTURE_TIMEOUT_MS);
  } catch {
    return fallbackProposal(text, now);
  }
  const e = validateExtraction(raw);
  if (!e) return fallbackProposal(text, now);
  return toProposal(e, text, now);
}

// ── Step suggestions ──

export const STEPS_SCHEMA = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 } },
  required: ["steps"],
} as const;

export const STEPS_SYSTEM = `Suggest 3 to 6 short, concrete steps to get a task done.
Reply with JSON only: {"steps": ["...", "..."]}. Each step under 60 characters, in the same language as the task, no numbering.`;

/** 3-6 short, distinct steps, or null when the model's answer is unusable. */
export function validateSteps(raw: unknown): string[] | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const list = (v as { steps?: unknown })?.steps;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const steps = list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim().slice(0, 80))
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  if (steps.length < 3) return null;
  return steps.slice(0, 6);
}
