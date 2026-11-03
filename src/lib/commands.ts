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

// "besok"/"tomorrow" and "hari ini"/"today" — Nox is used in both languages.
const TOMORROW = /\s+(besok|tomorrow)$/i;
const TODAY = /\s+(hari\s+ini|today)$/i;
const DAY_MONTH = /\s+(\d{1,2})\/(\d{1,2})$/;

export type ParsedTodo = { title: string; due_date?: string };

/**
 * `/todo <title>` with an optional trailing date:
 *   "... besok" · "... hari ini" · "... 25/12"
 * A DD/MM that has already passed this year is read as next year.
 */
export function parseTodoArgs(content: string, now = new Date()): ParsedTodo {
  const text = content.trim();

  const tomorrow = TOMORROW.exec(text);
  if (tomorrow) {
    return {
      title: text.slice(0, tomorrow.index).trim(),
      due_date: localDate(addDays(now, 1)),
    };
  }

  const today = TODAY.exec(text);
  if (today) {
    return { title: text.slice(0, today.index).trim(), due_date: localDate(now) };
  }

  const dm = DAY_MONTH.exec(text);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    // Reject nonsense like 45/13 and let it stay part of the title.
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let date = new Date(now.getFullYear(), month - 1, day);
      // Guard against overflow (31/02 would roll into March).
      if (date.getMonth() === month - 1) {
        if (localDate(date) < localDate(now)) {
          date = new Date(now.getFullYear() + 1, month - 1, day);
        }
        return { title: text.slice(0, dm.index).trim(), due_date: localDate(date) };
      }
    }
  }

  return { title: text };
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
  | "badMinutes";

export type Command =
  | { kind: "tasks"; n?: number }
  | { kind: "todoAdd"; title: string; due_date?: string }
  | { kind: "todoList" }
  | { kind: "done"; n: number }
  | { kind: "remind"; title: string; at: Date }
  | { kind: "focus"; minutes?: number }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "weather" }
  | { kind: "place"; name?: string }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "dashboard" }
  | { kind: "error"; error: CommandError }
  | { kind: "unknown"; name: string };

// Indonesian name first, English aliases after. Telegram's menu sends /start.
type Bare = "stop" | "status" | "weather" | "help" | "clear" | "dashboard";
const ALIASES: Record<string, Bare | "tasks" | "todo" | "done" | "remindAny" | "focus" | "place"> = {
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
      const n = positive(arg);
      return n ? { kind: "tasks", n } : { kind: "error", error: "badNumber" };
    }
    case "todo": {
      if (!arg) return { kind: "error", error: "todoEmpty" };
      if (/^(list|daftar|ls)$/i.test(arg)) return { kind: "todoList" };
      const { title, due_date } = parseTodoArgs(arg, now);
      if (!title) return { kind: "error", error: "todoOnlyDate" };
      return due_date ? { kind: "todoAdd", title, due_date } : { kind: "todoAdd", title };
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
  | { kind: "todoAdded"; title: string; due_date?: string }
  | { kind: "todoList"; items: { n: number; title: string; due_date: string | null }[] }
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
    case "taskMissing":
      return tr("cmd.tasks.missing", { n: r.n });
    case "todoAdded":
      return r.due_date
        ? tr("cmd.todo.addedDue", {
            title: r.title,
            due: describeDue(r.due_date, { today: tr("date.today"), tomorrow: tr("date.tomorrow") }, now),
          })
        : tr("cmd.todo.added", { title: r.title });
    case "todoList":
      return r.items.length
        ? [
            tr("cmd.todo.listHead"),
            ...r.items.map(
              (i) =>
                `${i.n}. ${i.title}${
                  i.due_date
                    ? ` · ${describeDue(i.due_date, { today: tr("date.today"), tomorrow: tr("date.tomorrow") }, now)}`
                    : ""
                }`,
            ),
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
