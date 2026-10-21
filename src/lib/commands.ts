/**
 * Parsing for the pet window's slash commands.
 *
 * Deliberately free of imports so it stays pure and testable: the two date
 * formatters below mirror `todayLocal()` / `utcStamp()` in db-helpers.
 *
 * Everything the user types is in *their* local time. Dates land in date
 * columns as local YYYY-MM-DD; reminder timestamps are converted to UTC,
 * because reminders are polled with `remind_at <= datetime('now')`.
 */

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
  const [, m, d] = due.split("-");
  return `${Number(d)}/${Number(m)}`;
}
