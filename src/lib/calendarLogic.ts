/**
 * Calendar rules, pure (no imports) so they are testable: which events fall
 * on a local day, their order, the now/next marker, and which event nudges
 * are due. Timed events are stored in UTC ("YYYY-MM-DD HH:MM:SS"), all-day
 * ones as dates with an exclusive end.
 */

export type CalendarEvent = {
  id: number;
  feed_id: number;
  uid: string;
  start: string;
  end: string;
  all_day: number;
  title: string;
  location: string | null;
  /** "ics" (a feed) or "google". */
  source?: string;
  calendar_id?: string | null;
  google_id?: string | null;
  html_link?: string | null;
};

const pad = (n: number) => String(n).padStart(2, "0");

export const utcToDate = (stamp: string) => new Date(stamp.replace(" ", "T") + "Z");

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local HH:MM of a UTC stamp. */
export function localClock(stamp: string): string {
  const d = utcToDate(stamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** UTC stamps bounding a local calendar day: [start, next day's start). */
export function dayBoundsUtc(day: string): [string, string] {
  const [y, m, d] = day.split("-").map(Number);
  const stamp = (x: Date) => x.toISOString().slice(0, 19).replace("T", " ");
  return [stamp(new Date(y, m - 1, d)), stamp(new Date(y, m - 1, d + 1))];
}

/** Does the event touch this local day? */
export function onDay(e: CalendarEvent, day: string): boolean {
  if (e.all_day) return e.start <= day && e.end > day;
  const [from, to] = dayBoundsUtc(day);
  // Starts that day, or is still running into it from the night before.
  return (e.start >= from && e.start < to) || (e.start < from && e.end > from);
}

/** All-day first, then by start time, then title. */
export function sortDay(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => b.all_day - a.all_day || (a.start < b.start ? -1 : a.start > b.start ? 1 : a.title.localeCompare(b.title)));
}

export function eventsOn(events: CalendarEvent[], day: string): CalendarEvent[] {
  return sortDay(events.filter((e) => onDay(e, day)));
}

/**
 * The marker for today's list: the event running now, else the next one to
 * start. All-day events never get it.
 */
export function nowNext(events: CalendarEvent[], now: Date): { id: number; kind: "now" | "next" } | null {
  const t = now.getTime();
  const timed = events.filter((e) => !e.all_day);
  const running = timed.find((e) => utcToDate(e.start).getTime() <= t && utcToDate(e.end).getTime() > t);
  if (running) return { id: running.id, kind: "now" };
  const next = timed.find((e) => utcToDate(e.start).getTime() > t);
  return next ? { id: next.id, kind: "next" } : null;
}

export const nudgeKey = (e: CalendarEvent) => `${e.feed_id}|${e.uid}|${e.start}`;

/**
 * Timed events starting within `minutes` from now that have no nudge yet.
 * `minutes` 0 turns nudges off. Already-started events get none.
 */
export function dueEventNudges(events: CalendarEvent[], sent: Set<string>, now: Date, minutes: number): CalendarEvent[] {
  if (!(minutes > 0)) return [];
  const t = now.getTime();
  const until = t + minutes * 60_000;
  return sortDay(
    events.filter((e) => {
      if (e.all_day) return false;
      const s = utcToDate(e.start).getTime();
      return s > t && s <= until && !sent.has(nudgeKey(e));
    }),
  );
}

/**
 * Timed events that overlap [startUtc, endUtc) (UTC stamps). A new all-day
 * event (dates) overlaps the timed events on those days. Existing all-day
 * events never count: they rarely block time.
 */
export function overlapping(events: CalendarEvent[], startUtc: string, endUtc: string, allDay = false): CalendarEvent[] {
  if (allDay) {
    const days: string[] = [];
    for (let d = startUtc; d < endUtc; ) {
      days.push(d);
      const [y, m, dd] = d.split("-").map(Number);
      d = localDay(new Date(y, m - 1, dd + 1));
    }
    return sortDay(events.filter((e) => !e.all_day && days.some((day) => onDay(e, day))));
  }
  return sortDay(events.filter((e) => !e.all_day && e.start < endUtc && e.end > startUtc));
}
