import { parseQuickAdd } from "./todoParse";

/**
 * `/event` text → an event draft, on top of the shared quick-add parser
 * (same date and time words as /todo). Pure, so it is easy to test.
 *
 *   rapat himatif jumat 14:00-15:30 di sekre
 *   rapat tes jumat 14:00 ~1h
 *   kuliah umum besok 09:00 at aula ~90m
 *   libur nasional 20/11            (no time: all-day)
 *
 * Added on top of quick-add: a time range "14:00-15:30", a duration "~1h" /
 * "~90m" / "~1.5j", and a place after "di" or "at". Default length 1 hour.
 * No date means today.
 */

export type EventDraft = {
  title: string;
  /** Local YYYY-MM-DD the event starts. */
  date: string;
  allDay: boolean;
  /** Local HH:MM (timed only). */
  start?: string;
  end?: string;
  /** Local YYYY-MM-DD the event ends (timed: may be the next day). */
  endDate: string;
  location?: string;
};

export type EventParse = { ok: true; draft: EventDraft } | { ok: false; error: "eventEmpty" | "eventNoTitle" };

export const DEFAULT_EVENT_MINUTES = 60;
const MAX_MINUTES = 24 * 60;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function clock(h: number, m: number): string | null {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
}

function addDay(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

/** "~1h", "~90m", "~1.5 jam" anywhere: minutes, and the text without it. */
function takeDuration(text: string): { minutes: number | null; rest: string } {
  const re = /(^|\s)~\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(h|hr|hrs|hour|hours|j|jam|m|min|mins|mnt|menit)(?=\s|$)/i;
  const m = re.exec(text);
  if (!m) return { minutes: null, rest: text };
  const n = Number(m[2].replace(",", "."));
  const minutes = Math.round(/^(h|hr|hrs|hour|hours|j|jam)$/i.test(m[3]) ? n * 60 : n);
  const rest = `${text.slice(0, m.index)}${m[1]}${text.slice(m.index + m[0].length)}`;
  return { minutes: minutes > 0 && minutes <= MAX_MINUTES ? minutes : null, rest };
}

/** "14:00-15:30" (also "14.00–15.30") anywhere: start/end, leaving "14:00". */
function takeRange(text: string): { start: string | null; end: string | null; rest: string } {
  const re = /(^|\s)(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})(?=\s|$)/;
  const m = re.exec(text);
  if (!m) return { start: null, end: null, rest: text };
  const start = clock(+m[2], +m[3]);
  const end = clock(+m[4], +m[5]);
  if (!start || !end) return { start: null, end: null, rest: text };
  return { start, end, rest: `${text.slice(0, m.index)}${m[1]}${start}${text.slice(m.index + m[0].length)}` };
}

/**
 * The last "di <place>" / "at <place>". Date and time words at the end of
 * the place ("di sekre jumat 14:00") go back to the main text. "at 14:00"
 * is a time, not a place.
 */
function takePlace(text: string, now: Date): { place: string | null; rest: string } {
  const re = /(^|\s)(?:di|at)\s+(.+)$/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    last = m;
    re.lastIndex = m.index + 1;
  }
  if (!last) return { place: null, rest: text };
  const candidate = last[2].trim();
  const q = parseQuickAdd(candidate, now);
  if (!q.title) return { place: null, rest: text };
  const words = candidate.split(/\s+/);
  const trailing = words.slice(q.title.split(" ").length).join(" ");
  const before = text.slice(0, last.index).trim();
  return { place: q.title, rest: [before, trailing].filter(Boolean).join(" ") };
}

export function parseEventText(input: string, now = new Date()): EventParse {
  let text = input.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "eventEmpty" };

  const duration = takeDuration(text);
  text = duration.rest.trim();
  const range = takeRange(text);
  text = range.rest.trim();
  const place = takePlace(text, now);
  text = place.rest.trim();

  const q = parseQuickAdd(text, now);
  const title = q.title.trim();
  if (!title) return { ok: false, error: "eventNoTitle" };
  const date = q.due_date ?? ymd(now);
  const location = place.place ?? undefined;

  if (!q.due_time) {
    return { ok: true, draft: { title, date, allDay: true, endDate: addDay(date, 1), ...(location ? { location } : {}) } };
  }

  const start = q.due_time;
  let end = range.start === start ? range.end : null;
  if (!end) {
    const [h, m] = start.split(":").map(Number);
    const total = h * 60 + m + (duration.minutes ?? DEFAULT_EVENT_MINUTES);
    end = clock(Math.floor(total / 60) % 24, total % 60)!;
  }
  // Ending at or before it starts: it runs past midnight.
  const endDate = end <= start ? addDay(date, 1) : date;
  return { ok: true, draft: { title, date, allDay: false, start, end, endDate, ...(location ? { location } : {}) } };
}

/** The draft as Google wants it (local offset), plus UTC stamps for overlap checks. */
export function eventTimes(d: EventDraft): { start: string; end: string; startUtc: string; endUtc: string } {
  if (d.allDay) return { start: d.date, end: d.endDate, startUtc: d.date, endUtc: d.endDate };
  const at = (day: string, time: string) => {
    const [y, m, dd] = day.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    return new Date(y, m - 1, dd, h, mi);
  };
  const rfc = (x: Date) => {
    const off = -x.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    return `${ymd(x)}T${pad(x.getHours())}:${pad(x.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  };
  const utc = (x: Date) => x.toISOString().slice(0, 19).replace("T", " ");
  const s = at(d.date, d.start!);
  const e = at(d.endDate, d.end!);
  return { start: rfc(s), end: rfc(e), startUtc: utc(s), endUtc: utc(e) };
}

/** Back to text for "Edit" (prefills /event in the pet chat). */
export function draftAsText(d: EventDraft): string {
  // d/m/yyyy: the date form the shared parser reads.
  const [y, m, day] = d.date.split("-").map(Number);
  const date = `${day}/${m}/${y}`;
  const when = d.allDay ? date : `${date} ${d.start}-${d.end}`;
  return `/event ${d.title} ${when}${d.location ? ` di ${d.location}` : ""}`.trim();
}
