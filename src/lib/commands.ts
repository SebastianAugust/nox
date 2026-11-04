/**
 * The rigid slash-command layer, shared by the pet chat and Telegram.
 *
 * Pure: only type imports, so it stays testable. `parseCommand` turns text
 * into a Command; `commandRunner.ts` carries it out and returns a
 * CommandResult; `renderResult` turns that into plain text. Anything starting
 * with "/" is a command and never reaches Ollama.
 *
 * The two date formatters below mirror `todayLocal()` / `utcStamp()` in
 * db-helpers. Everything the user types is in *their* local time. Dates land
 * in date columns as local YYYY-MM-DD; reminder timestamps are converted to
 * UTC, because reminders are polled with `remind_at <= datetime('now')`.
 */

import type { I18nKey } from "./i18n";
import type { Urgency } from "./deadlines";
import { parseQuickAdd, type Priority, type QuickAdd } from "./todoParse";
import { parseEventText, type EventDraft } from "./eventParse";

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date's local calendar day as YYYY-MM-DD. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A Date as a UTC "YYYY-MM-DD HH:MM:SS" stamp, comparable to datetime('now'). */
export function toUtcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}


export type ParsedRemind = {
  title: string;
  /** UTC stamp for the reminders table; absent when no time was given. */
  remind_at?: string;
  /** The time as HH:MM, for reading it back to the user. */
  clock?: string;
  /** True when the reminder lands on tomorrow's date. */
  tomorrow?: boolean;
};

const REMIND_AT =
  /^(.*?)\s+(?:(besok|tomorrow|hari\s+ini|today)\s+)?(?:jam|pukul|at)\s+(\d{1,2})[:.](\d{2})$/i;

/**
 * `/remind <title> jam HH:MM`, optionally prefixed with besok/hari ini.
 * With no day given, a time that has already passed means tomorrow.
 * Returns just a title when nothing time-like is found — the caller then
 * falls back to saving a plain todo.
 */
export function parseRemindArgs(content: string, now = new Date()): ParsedRemind {
  const text = content.trim();
  const m = REMIND_AT.exec(text);
  if (!m) return { title: text };

  const [, rawTitle, dayWord, rawHour, rawMinute] = m;
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (hour > 23 || minute > 59) return { title: text };

  const title = rawTitle.trim();
  if (!title) return { title: text };

  const isTomorrow = dayWord && /besok|tomorrow/i.test(dayWord);
  let target = new Date(now);
  if (isTomorrow) target = addDays(now, 1);
  target.setHours(hour, minute, 0, 0);

  // No day word and the time is already behind us → they mean tomorrow.
  if (!dayWord && target.getTime() <= now.getTime()) {
    target = addDays(target, 1);
  }

  return {
    title,
    remind_at: toUtcStamp(target),
    clock: `${pad(hour)}:${pad(minute)}`,
    tomorrow: localDate(target) !== localDate(now),
  };
}

/**
 * How to read a due date back to the user: the given words for today and
 * tomorrow (the caller passes them in its language), otherwise "25/12".
 */
export function describeDue(
  due: string,
  words: { today: string; tomorrow: string },
  now = new Date(),
): string {
  const today = localDate(now);
  if (due === today) return words.today;
  if (due === localDate(addDays(now, 1))) return words.tomorrow;
  const [, m, d] = due.slice(0, 10).split("-");
  return `${Number(d)}/${Number(m)}`;
}

// ── Command parsing ──────────────────────────────────────────────────────────

export type CommandError =
  | "todoEmpty"
  | "todoOnlyDate"
  | "remindEmpty"
  | "remindNoTime"
  | "badNumber"
  | "badMinutes"
  | "notionAddEmpty"
  | "notionEditEmpty"
  | "notionMoveDate"
  | "eventEmpty"
  | "eventNoTitle"
  | "scheduleArg";

export type Command =
  | { kind: "tasks"; n?: number }
  /** Notion write-back (only with "Notion writes" on). */
  | { kind: "notionAdd"; quick: QuickAdd }
  | { kind: "notionDone"; n: number }
  | { kind: "notionEdit"; n: number; title: string }
  | { kind: "notionMove"; n: number; due_date: string; due_time?: string }
  /** A Google Calendar event, created only after a confirmation. */
  | { kind: "event"; draft: EventDraft }
  /** Parsed by the same quick-add parser as the Todos page. */
  | { kind: "todoAdd"; quick: QuickAdd }
  | { kind: "todoList" }
  | { kind: "done"; n: number }
  | { kind: "remind"; title: string; at: Date }
  | { kind: "focus"; minutes?: number }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "weather" }
  | { kind: "place"; name?: string }
  | { kind: "schedule"; range: "today" | "tomorrow" | "week" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "dashboard" }
  | { kind: "error"; error: CommandError }
  | { kind: "unknown"; name: string };

// Indonesian name first, English aliases after. Telegram's menu sends /start.
type Bare = "stop" | "status" | "weather" | "help" | "clear" | "dashboard";
type WithArg = "tasks" | "todo" | "done" | "remindAny" | "focus" | "place" | "schedule" | "event";
const ALIASES: Record<string, Bare | WithArg> = {
  tugas: "tasks",
  tasks: "tasks",
  assignments: "tasks",
  todo: "todo",
  done: "done",
  selesai: "done",
  ingat: "remindAny",
  remind: "remindAny",
  reminder: "remindAny",
  fokus: "focus",
  focus: "focus",
  stop: "stop",
  berhenti: "stop",
  status: "status",
  cuaca: "weather",
  weather: "weather",
  lokasi: "place",
  jadwal: "schedule",
  schedule: "schedule",
  agenda: "schedule",
  event: "event",
  acara: "event",
  location: "place",
  tempat: "place",
  place: "place",
  bantu: "help",
  help: "help",
  start: "help",
  clear: "clear",
  dashboard: "dashboard",
};

const MAX_FOCUS_MIN = 180;
const MAX_RELATIVE_MIN = 7 * 24 * 60;

function positive(text: string): number | null {
  if (!/^\d{1,4}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/**
 * A reminder time at the start of `/ingat`: "10m", "2h" (also "10 menit",
 * "2 jam"), "18:30", "besok 08:00". Returns the moment and the rest as the
 * title, or null when the text does not start with a time.
 */
export function parseReminderTime(text: string, now = new Date()): { at: Date; title: string } | null {
  const rel = /^(\d{1,5})\s*(m|min|mins|mnt|menit|h|hr|hrs|hour|hours|j|jam)\s+(.+)$/i.exec(text);
  if (rel) {
    const amount = Number(rel[1]);
    const minutes = /^(h|hr|hrs|hour|hours|j|jam)$/i.test(rel[2]) ? amount * 60 : amount;
    if (minutes < 1 || minutes > MAX_RELATIVE_MIN) return null;
    return { at: new Date(now.getTime() + minutes * 60_000), title: rel[3].trim() };
  }
  const clock = /^(?:(besok|tomorrow)\s+)?(\d{1,2})[:.](\d{2})\s+(.+)$/i.exec(text);
  if (clock) {
    const [, day, h, m, title] = clock;
    if (+h > 23 || +m > 59) return null;
    let at = new Date(now);
    if (day) at = addDays(now, 1);
    at.setHours(+h, +m, 0, 0);
    // No day word and already past today: they mean tomorrow.
    if (!day && at.getTime() <= now.getTime()) at = addDays(at, 1);
    return { at, title: title.trim() };
  }
  return null;
}

/**
 * Only a date (and maybe a time), for `/tugas tunda`: "2026-11-20",
 * "2026-11-20 23:59", or anything the todo parser reads as a date with no
 * words left over ("jumat", "besok 08:00", "20 nov"). Null otherwise.
 */
export function parseDueOnly(text: string, now = new Date()): { due_date: string; due_time?: string } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2})[:.](\d{2}))?$/.exec(text);
  if (iso) {
    const [, y, mo, d, h, mi] = iso;
    const date = new Date(+y, +mo - 1, +d);
    if (date.getMonth() !== +mo - 1 || date.getDate() !== +d) return null;
    if (h === undefined) return { due_date: `${y}-${mo}-${d}` };
    if (+h > 23 || +mi > 59) return null;
    return { due_date: `${y}-${mo}-${d}`, due_time: `${pad(+h)}:${mi}` };
  }
  const q = parseQuickAdd(text, now);
  if (!q.due_date || q.title.trim()) return null;
  return q.due_time ? { due_date: q.due_date, due_time: q.due_time } : { due_date: q.due_date };
}

/**
 * Parse one line. Returns null when it is not a command (does not start
 * with "/"), so the caller sends it to the chat model instead.
 */
export function parseCommand(input: string, now = new Date()): Command | null {
  const match = /^\/([^\s@]+)(?:@\S+)?\s*([\s\S]*)$/.exec(input.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  const arg = match[2].trim();
  const kind = ALIASES[name];

  switch (kind) {
    case undefined:
      return { kind: "unknown", name };
    case "tasks": {
      if (!arg) return { kind: "tasks" };
      // Notion write-back: /tugas tambah <text>, /tugas selesai <n>,
      // /tugas ubah <n> <title>, /tugas tunda <n> <date>.
      const sub = /^(tambah|add|selesai|done|ubah|edit|rename|tunda|move|reschedule)\b\s*([\s\S]*)$/i.exec(arg);
      if (sub) {
        const rest = sub[2].trim();
        if (/^(ubah|edit|rename)$/i.test(sub[1])) {
          const m = /^(\d{1,4})\s+([\s\S]+)$/.exec(rest);
          const n = m ? positive(m[1]) : null;
          const title = m?.[2].trim().slice(0, 2000);
          return n && title ? { kind: "notionEdit", n, title } : { kind: "error", error: "notionEditEmpty" };
        }
        if (/^(tunda|move|reschedule)$/i.test(sub[1])) {
          const m = /^(\d{1,4})\s+([\s\S]+)$/.exec(rest);
          const n = m ? positive(m[1]) : null;
          const due = m ? parseDueOnly(m[2].trim(), now) : null;
          return n && due ? { kind: "notionMove", n, ...due } : { kind: "error", error: "notionMoveDate" };
        }
        if (/^(tambah|add)$/i.test(sub[1])) {
          if (!rest) return { kind: "error", error: "notionAddEmpty" };
          const quick = parseQuickAdd(rest, now);
          return quick.title ? { kind: "notionAdd", quick } : { kind: "error", error: "todoOnlyDate" };
        }
        const done = positive(rest);
        return done ? { kind: "notionDone", n: done } : { kind: "error", error: "badNumber" };
      }
      const n = positive(arg);
      return n ? { kind: "tasks", n } : { kind: "error", error: "badNumber" };
    }
    case "todo": {
      if (!arg) return { kind: "error", error: "todoEmpty" };
      if (/^(list|daftar|ls)$/i.test(arg)) return { kind: "todoList" };
      const quick = parseQuickAdd(arg, now);
      if (!quick.title) return { kind: "error", error: "todoOnlyDate" };
      return { kind: "todoAdd", quick };
    }
    case "done": {
      const n = positive(arg);
      return n ? { kind: "done", n } : { kind: "error", error: "badNumber" };
    }
    case "remindAny": {
      if (!arg) return { kind: "error", error: "remindEmpty" };
      const first = parseReminderTime(arg, now);
      if (first?.title) return { kind: "remind", title: first.title, at: first.at };
      // The older "/remind <thing> at 09:00" form still works.
      const old = parseRemindArgs(arg, now);
      if (old.remind_at) {
        return { kind: "remind", title: old.title, at: new Date(old.remind_at.replace(" ", "T") + "Z") };
      }
      return { kind: "error", error: "remindNoTime" };
    }
    case "schedule": {
      if (!arg) return { kind: "schedule", range: "today" };
      if (/^(besok|tomorrow)$/i.test(arg)) return { kind: "schedule", range: "tomorrow" };
      if (/^(minggu|week|pekan|7)$/i.test(arg)) return { kind: "schedule", range: "week" };
      return { kind: "error", error: "scheduleArg" };
    }
    case "event": {
      const p = parseEventText(arg, now);
      return p.ok ? { kind: "event", draft: p.draft } : { kind: "error", error: p.error };
    }
    case "place":
      return arg ? { kind: "place", name: arg.slice(0, 40) } : { kind: "place" };
    case "focus": {
      if (!arg) return { kind: "focus" };
      const n = positive(arg.replace(/\s*(m|min|menit|mnt)$/i, ""));
      return n && n <= MAX_FOCUS_MIN ? { kind: "focus", minutes: n } : { kind: "error", error: "badMinutes" };
    }
    default:
      return { kind };
  }
}

// ── Results and their plain-text rendering ───────────────────────────────────

export type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

export type TaskItem = {
  n: number;
  name: string;
  course: string | null;
  due_date: string;
  urgency: Urgency;
  status?: string | null;
};

export type CommandResult =
  | { kind: "tasks"; items: TaskItem[] }
  | { kind: "taskDetail"; item: TaskItem }
  | { kind: "taskMissing"; n: number }
  | { kind: "notionQueued"; title: string; course: string | null; courseMissing: string | null }
  | { kind: "notionDoneQueued"; name: string }
  | { kind: "notionRenamed"; old: string; name: string }
  | { kind: "notionMoved"; name: string; due_date: string; due_time?: string }
  /** A question with Confirm / Cancel (pending action `actionId`). */
  | { kind: "confirm"; actionId: number; text: string }
  | { kind: "eventNoGoogle" }
  | { kind: "notionOff" }
  | { kind: "notionNotSetUp" }
  | { kind: "notionLinked" }
  | {
      kind: "todoAdded";
      title: string;
      due_date?: string;
      due_time?: string;
      priority?: Priority;
      /** The list it went to, and whether #name matched it. */
      list?: string;
      listMatched?: boolean;
    }
  | {
      kind: "todoList";
      items: { n: number; title: string; due_date: string | null; due_time?: string | null; priority?: Priority }[];
    }
  | { kind: "todoDone"; title: string }
  | { kind: "todoMissing"; n: number }
  | { kind: "reminderSet"; title: string; at: Date }
  | { kind: "focusStarted"; minutes: number }
  | { kind: "focusBusy" }
  | { kind: "focusStopped" }
  | { kind: "focusIdle" }
  | {
      kind: "status";
      phase: "idle" | "focus" | "break";
      minutesLeft: number;
      todosOpen: number;
      overdue: number;
      next: TaskItem | null;
    }
  | { kind: "weather"; line: string | null }
  | { kind: "placeShow"; name: string; detail: string; others: string[] }
  | { kind: "placeSwitched"; name: string; line: string | null }
  | { kind: "placeMissing"; name: string; names: string[] }
  | { kind: "placeNone" }
  | {
      kind: "schedule";
      range: "today" | "tomorrow" | "week";
      days: { label: string; events: { time: string | null; title: string; location: string | null }[] }[];
      stale: boolean;
    }
  | { kind: "help"; telegram: boolean }
  | { kind: "cleared" }
  | { kind: "dashboard" }
  | { kind: "error"; error: CommandError }
  | { kind: "unknown"; name: string }
  | { kind: "failed" };

/** "overdue 2d", "today", "tomorrow", "in 4 days". */
export function urgencyText(u: Urgency, tr: Translate): string {
  switch (u.kind) {
    case "overdue":
      return u.days > 0 ? tr("due.overdueDays", { n: u.days }) : tr("due.overdue");
    case "today":
      return tr("due.today");
    case "tomorrow":
      return tr("due.tomorrow");
    case "days":
      return tr("due.inDays", { n: u.days });
  }
}

const clockOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function taskLine(item: TaskItem, tr: Translate): string {
  const course = item.course ? ` · ${item.course}` : "";
  return `${item.n}. ${item.name}${course} · ${urgencyText(item.urgency, tr)}`;
}

/** Plain text for the pet bubble and Telegram. */
export function renderResult(r: CommandResult, tr: Translate, now = new Date()): string {
  switch (r.kind) {
    case "tasks":
      return r.items.length
        ? [tr("cmd.tasks.head"), ...r.items.map((i) => taskLine(i, tr)), tr("cmd.tasks.hint")].join("\n")
        : tr("cmd.tasks.none");
    case "taskDetail": {
      const i = r.item;
      const due = `${describeDue(i.due_date, { today: tr("date.today"), tomorrow: tr("date.tomorrow") }, now)}${
        i.due_date.length > 10 ? ` ${i.due_date.slice(11, 16)}` : ""
      }`;
      return [
        i.name,
        i.course ? tr("cmd.tasks.course", { course: i.course }) : null,
        tr("cmd.tasks.due", { due, urgency: urgencyText(i.urgency, tr) }),
        i.status ? tr("cmd.tasks.status", { status: i.status }) : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "notionQueued":
      return [
        tr("cmd.notion.queued", { title: r.title }),
        r.course ? tr("cmd.notion.course", { course: r.course }) : null,
        r.courseMissing ? tr("cmd.notion.noCourse", { course: r.courseMissing }) : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "notionDoneQueued":
      return tr("cmd.notion.doneQueued", { name: r.name });
    case "confirm":
      return r.text;
    case "eventNoGoogle":
      return tr("cmd.event.noGoogle");
    case "notionRenamed":
      return tr("cmd.notion.renamed", { old: r.old, name: r.name });
    case "notionMoved":
      return tr("cmd.notion.moved", {
        name: r.name,
        due: `${describeDue(r.due_date, { today: tr("date.today"), tomorrow: tr("date.tomorrow") }, now)}${
          r.due_time ? ` ${r.due_time}` : ""
        }`,
      });
    case "notionOff":
      return tr("cmd.notion.off");
    case "notionNotSetUp":
      return tr("cmd.notion.notSetUp");
    case "notionLinked":
      return tr("cmd.notion.linked");
    case "taskMissing":
      return tr("cmd.tasks.missing", { n: r.n });
    case "todoAdded": {
      const words = { today: tr("date.today"), tomorrow: tr("date.tomorrow") };
      const base = r.due_date
        ? tr("cmd.todo.addedDue", {
            title: r.title,
            due: `${describeDue(r.due_date, words, now)}${r.due_time ? ` ${r.due_time}` : ""}`,
          })
        : tr("cmd.todo.added", { title: r.title });
      const extra = [
        r.priority ? tr(`pri.${r.priority}`) : null,
        r.list ? (r.listMatched === false ? tr("cmd.todo.noList", { list: r.list }) : r.list) : null,
      ].filter(Boolean);
      return extra.length ? `${base} ${extra.join(" · ")}` : base;
    }
    case "todoList":
      return r.items.length
        ? [
            tr("cmd.todo.listHead"),
            ...r.items.map((i) => {
              const due = i.due_date
                ? ` · ${describeDue(i.due_date, { today: tr("date.today"), tomorrow: tr("date.tomorrow") }, now)}${
                    i.due_time ? ` ${i.due_time}` : ""
                  }`
                : "";
              return `${i.n}. ${i.title}${due}${i.priority ? ` · ${tr(`pri.${i.priority}`)}` : ""}`;
            }),
            tr("cmd.todo.listHint"),
          ].join("\n")
        : tr("cmd.todo.listEmpty");
    case "todoDone":
      return tr("cmd.done.ok", { title: r.title });
    case "todoMissing":
      return tr("cmd.done.missing", { n: r.n });
    case "reminderSet": {
      const tomorrow = localDate(r.at) !== localDate(now);
      const when = tomorrow ? tr("cmd.remind.tomorrowAt", { clock: clockOf(r.at) }) : clockOf(r.at);
      return tr("cmd.remind.set", { title: r.title, when });
    }
    case "focusStarted":
      return tr("cmd.focus.started", { min: r.minutes });
    case "focusBusy":
      return tr("cmd.focus.busy");
    case "focusStopped":
      return tr("cmd.stop.ok");
    case "focusIdle":
      return tr("cmd.stop.idle");
    case "status": {
      const focus =
        r.phase === "idle"
          ? tr("cmd.status.idle")
          : tr(r.phase === "focus" ? "cmd.status.focus" : "cmd.status.break", { min: r.minutesLeft });
      const lines = [focus, tr("cmd.status.todos", { n: r.todosOpen, overdue: r.overdue })];
      if (r.next) {
        lines.push(tr("cmd.status.next", { name: r.next.name, urgency: urgencyText(r.next.urgency, tr) }));
      }
      return lines.join("\n");
    }
    case "placeShow":
      return [
        tr("cmd.place.active", { name: r.name, detail: r.detail }),
        r.others.length ? tr("cmd.place.others", { names: r.others.join(", ") }) : tr("cmd.place.addHint"),
      ].join("\n");
    case "placeSwitched":
      return [tr("cmd.place.switched", { name: r.name }), r.line].filter(Boolean).join("\n");
    case "placeMissing":
      return tr("cmd.place.missing", { name: r.name, names: r.names.join(", ") || "-" });
    case "schedule": {
      const lines = [tr(`cmd.schedule.${r.range}`)];
      const withEvents = r.days.filter((d) => d.events.length);
      if (!withEvents.length) lines.push(tr("cmd.schedule.none"));
      for (const d of withEvents) {
        if (r.range === "week") lines.push(d.label);
        for (const e of d.events) {
          lines.push(`• ${e.time ?? tr("cmd.schedule.allDay")} ${e.title}${e.location ? ` (${e.location})` : ""}`);
        }
      }
      if (r.stale) lines.push(tr("cmd.schedule.stale"));
      return lines.join("\n");
    }
    case "placeNone":
      return tr("cmd.place.none");
    case "weather":
      return r.line ?? tr("cmd.weather.none");
    case "help":
      return tr(r.telegram ? "cmd.help.telegram" : "cmd.help");
    case "cleared":
      return tr("cmd.clear.done");
    case "dashboard":
      return "";
    case "error":
      return tr(`cmd.err.${r.error}`);
    case "unknown":
      return tr("cmd.unknown", { name: r.name });
    case "failed":
      return tr("cmd.saveFailed");
  }
}

/**
 * A saved place by name for `/lokasi <name>`: exact match ignoring case
 * first, then the only name that starts with it. Null when none or unclear.
 */
export function findPlace<T extends { name: string }>(places: T[], query: string): T | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = places.find((p) => p.name.trim().toLowerCase() === q);
  if (exact) return exact;
  const starts = places.filter((p) => p.name.trim().toLowerCase().startsWith(q));
  return starts.length === 1 ? starts[0] : null;
}
