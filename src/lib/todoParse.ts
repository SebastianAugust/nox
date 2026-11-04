/**
 * Quick-add parsing for todos, shared by the Todos page, Home's add field,
 * the pet's /todo and Telegram. Pure: no imports, easy to test.
 *
 *   beli makan besok 18:30 !high #personal @robotika ~2p setiap minggu
 *
 * Symbol tokens work anywhere: !1-!3 / !low !med !high (also rendah, sedang,
 * tinggi), #list, @course, ~3p (focus sessions) or ~25m / ~1h (time).
 * Dates, times and repeats are read only from the END of the text, one
 * phrase at a time, so words that merely look like dates inside a sentence
 * ("today show plan", "beli 3 hari") never create a date.
 */

export type Priority = 0 | 1 | 2 | 3;
export type RepeatRule = "daily" | "weekdays" | "weekly" | "monthly" | `every:${number}`;

export type QuickAdd = {
  title: string;
  /** Local YYYY-MM-DD. */
  due_date?: string;
  /** Local HH:MM. */
  due_time?: string;
  priority: Priority;
  /** List name as typed after #; the caller matches it to a real list. */
  list?: string;
  /** Course as typed after @. */
  course?: string;
  /** Focus sessions (from ~3p, or ~minutes rounded up to whole sessions). */
  estimate?: number;
  /** When the estimate was given in minutes, the minutes. */
  estimateMinutes?: number;
  repeat?: RepeatRule;
};

/** Minutes in one focus session, for turning ~50m into 2 sessions. */
export const SESSION_MINUTES = 25;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const PRIORITY: Record<string, Priority> = {
  "1": 1,
  low: 1,
  rendah: 1,
  "2": 2,
  med: 2,
  medium: 2,
  sedang: 2,
  "3": 3,
  high: 3,
  tinggi: 3,
};

// getDay() numbers. Full names en + id, then three-letter abbreviations.
const WEEKDAYS: Record<string, number> = {
  sunday: 0, minggu: 0, ahad: 0, sun: 0,
  monday: 1, senin: 1, mon: 1,
  tuesday: 2, selasa: 2, tue: 2, tues: 2,
  wednesday: 3, rabu: 3, wed: 3,
  thursday: 4, kamis: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, jumat: 5, "jum'at": 5, fri: 5,
  saturday: 6, sabtu: 6, sat: 6,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace("'", "'?"))
  .join("|");

type Slot = "date" | "time" | "repeat";
type Rule = { slot: Slot; re: RegExp; read: (m: RegExpExecArray, now: Date) => string | null };

const atEnd = (body: string) => new RegExp(`(?:^|\\s)(?:${body})$`, "i");

function clock(h: number, m: number): string | null {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
}

const RULES: Rule[] = [
  // ── Repeats (before dates, so "setiap minggu" is not read as Sunday) ──
  { slot: "repeat", re: atEnd("(?:every|setiap|tiap)\\s+(\\d{1,3})\\s+(?:days?|hari)"), read: (m) => (+m[1] >= 1 ? `every:${+m[1]}` : null) },
  { slot: "repeat", re: atEnd("every\\s+weekdays?|weekdays|(?:setiap|tiap)\\s+hari\\s+kerja"), read: () => "weekdays" },
  { slot: "repeat", re: atEnd("every\\s+day|daily|(?:setiap|tiap)\\s+hari"), read: () => "daily" },
  { slot: "repeat", re: atEnd("every\\s+week|weekly|(?:setiap|tiap)\\s+minggu|seminggu\\s+sekali"), read: () => "weekly" },
  { slot: "repeat", re: atEnd("every\\s+month|monthly|(?:setiap|tiap)\\s+bulan|sebulan\\s+sekali"), read: () => "monthly" },

  // ── Times ("jam 18:30" before a bare "18:30", so "jam" is not left over) ──
  {
    slot: "time",
    re: atEnd("(?:jam|pukul)\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s+(pagi|siang|sore|malam))?"),
    read: (m) => {
      let h = +m[1];
      const part = m[3]?.toLowerCase();
      if ((part === "sore" || part === "malam") && h < 12) h += 12;
      if (part === "siang" && h < 11) h += 12;
      return clock(h, +(m[2] ?? 0));
    },
  },
  {
    slot: "time",
    re: atEnd("(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm)"),
    read: (m) => {
      const h = +m[1];
      if (h < 1 || h > 12) return null;
      return clock((h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0), +(m[2] ?? 0));
    },
  },
  { slot: "time", re: atEnd("(?:at\\s+)?(\\d{1,2}):(\\d{2})"), read: (m) => clock(+m[1], +m[2]) },

  // ── Dates ──
  { slot: "date", re: atEnd("today|hari\\s+ini"), read: (_m, now) => ymd(now) },
  { slot: "date", re: atEnd("tomorrow|besok"), read: (_m, now) => ymd(addDays(now, 1)) },
  { slot: "date", re: atEnd("lusa|day\\s+after\\s+tomorrow"), read: (_m, now) => ymd(addDays(now, 2)) },
  {
    slot: "date",
    re: atEnd("(?:in|dalam)\\s+(\\d{1,3})\\s+(?:days?|hari)|(\\d{1,3})\\s+hari\\s+lagi"),
    read: (m, now) => ymd(addDays(now, +(m[1] ?? m[2]))),
  },
  { slot: "date", re: atEnd("next\\s+week|in\\s+a\\s+week|minggu\\s+depan"), read: (_m, now) => ymd(addDays(now, 7)) },
  {
    slot: "date",
    re: atEnd(`(?:next\\s+)?(${WEEKDAY_RE})(?:\\s+depan)?`),
    read: (m, now) => {
      const target = WEEKDAYS[m[1].toLowerCase().replace("'", "")] ?? WEEKDAYS[m[1].toLowerCase()];
      if (target === undefined) return null;
      // The same weekday as today means next week's.
      const ahead = ((target - now.getDay() + 7) % 7) || 7;
      return ymd(addDays(now, ahead));
    },
  },
  {
    slot: "date",
    re: atEnd("(\\d{1,2})/(\\d{1,2})(?:/(\\d{2}|\\d{4}))?"),
    read: (m, now) => {
      const day = +m[1];
      const month = +m[2];
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      const year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear();
      let date = new Date(year, month - 1, day);
      if (date.getMonth() !== month - 1) return null; // 31/02
      // Without a year, a day already past means next year.
      if (!m[3] && ymd(date) < ymd(now)) date = new Date(year + 1, month - 1, day);
      return ymd(date);
    },
  },
];

function readSymbol(token: string, out: QuickAdd): boolean {
  let m = /^!([a-z0-9]+)$/i.exec(token);
  if (m && PRIORITY[m[1].toLowerCase()] !== undefined) {
    out.priority = PRIORITY[m[1].toLowerCase()];
    return true;
  }
  m = /^#(\p{L}[\p{L}\p{N}_-]*)$/u.exec(token);
  if (m) {
    out.list = m[1];
    return true;
  }
  m = /^@(\p{L}[\p{L}\p{N}_.-]*)$/u.exec(token);
  if (m) {
    out.course = m[1].replace(/[._-]+$/, "");
    return true;
  }
  m = /^~(\d{1,3})(p|s|x|pomo|sesi)?$/i.exec(token);
  if (m && +m[1] > 0) {
    out.estimate = Math.min(+m[1], 20);
    delete out.estimateMinutes;
    return true;
  }
  m = /^~(\d{1,3})(m|min|mnt|menit|h|j|jam)$/i.exec(token);
  if (m && +m[1] > 0) {
    const minutes = /^(h|j|jam)$/i.test(m[2]) ? +m[1] * 60 : +m[1];
    out.estimateMinutes = minutes;
    out.estimate = Math.min(Math.ceil(minutes / SESSION_MINUTES), 20);
    return true;
  }
  return false;
}

export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  const out: QuickAdd = { title: "", priority: 0 };
  const words = input.trim().split(/\s+/).filter(Boolean);
  let rest = words.filter((w) => !readSymbol(w, out)).join(" ");

  const filled = new Set<Slot>();
  for (let guard = 0; guard < 6; guard++) {
    let matched = false;
    for (const rule of RULES) {
      if (filled.has(rule.slot)) continue;
      const m = rule.re.exec(rest);
      if (!m) continue;
      const value = rule.read(m, now);
      if (value === null) continue;
      if (rule.slot === "date") out.due_date = value;
      else if (rule.slot === "time") out.due_time = value;
      else out.repeat = value as RepeatRule;
      filled.add(rule.slot);
      rest = rest.slice(0, m.index).trimEnd();
      matched = true;
      break;
    }
    if (!matched) break;
  }

  // A time with no day is today, or tomorrow once it has passed.
  if (out.due_time && !out.due_date) {
    const [h, m] = out.due_time.split(":").map(Number);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    out.due_date = ymd(at.getTime() > now.getTime() ? now : addDays(now, 1));
  }

  out.title = rest.replace(/\s+/g, " ").trim();
  return out;
}

/** Whether the text had anything besides a title (for "Nox understood"). */
export function hasExtras(q: QuickAdd): boolean {
  return !!(q.due_date || q.due_time || q.priority || q.list || q.course || q.estimate || q.repeat);
}
