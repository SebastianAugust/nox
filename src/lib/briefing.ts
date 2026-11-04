/**
 * The morning briefing: when it is due, and how its facts read. Pure (only
 * type imports), so the timing rules are testable. The facts are always
 * gathered by code; an LLM may only write the friendly first line.
 */

import type { I18nKey } from "./i18n";

export type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Today's date and minutes since midnight in `timeZone` (the user's timezone
 * setting), falling back to the machine's clock when it is empty or unknown.
 */
export function zonedNow(now: Date, timeZone?: string): { date: string; minutes: number } {
  if (timeZone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(now)
          .map((p) => [p.type, p.value]),
      );
      return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
      };
    } catch {
      // Unknown zone name: use local time below.
    }
  }
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    minutes: now.getHours() * 60 + now.getMinutes(),
  };
}

export const DEFAULT_BRIEFING_TIME = "07:30";

/** "07:00" → 420; anything unreadable → the 07:30 default. */
export function parseClock(value: string | null | undefined): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  if (!m || +m[1] > 23 || +m[2] > 59) return 7 * 60 + 30;
  return +m[1] * 60 + +m[2];
}

/**
 * Due once per day, at or after the set time. "At or after" is what makes a
 * late start (PC off at 07:00, Nox opened at 09:30) show it once on startup;
 * `lastDate` (persisted as `last_briefing_date`) stops any repeat that day.
 */
export function shouldShowBriefing(input: {
  now: Date;
  timeZone?: string;
  time: string | null;
  enabled: boolean;
  lastDate: string | null;
}): { due: boolean; date: string } {
  const { date, minutes } = zonedNow(input.now, input.timeZone);
  const due = input.enabled && minutes >= parseClock(input.time) && input.lastDate !== date;
  return { due, date };
}

export type BriefingItem = { title: string; detail?: string };

export type BriefingData = {
  /** e.g. "Tuesday, 3 November", already in the user's language. */
  dateLabel: string;
  /** One rendered weather line, or null when no weather is known. */
  weather: string | null;
  /** Today's calendar events ("08:00–10:00" or "all day" as detail). */
  events: BriefingItem[];
  deadlinesToday: BriefingItem[];
  overdue: BriefingItem[];
  todosToday: BriefingItem[];
  habitsLeft: string[];
  remindersToday: BriefingItem[];
};

const MAX_PER_SECTION = 5;

function section(tr: Translate, heading: I18nKey, items: BriefingItem[]): string[] {
  if (!items.length) return [];
  const shown = items.slice(0, MAX_PER_SECTION).map((i) => `• ${i.title}${i.detail ? ` (${i.detail})` : ""}`);
  if (items.length > MAX_PER_SECTION) shown.push(`• ${tr("brief.more", { n: items.length - MAX_PER_SECTION })}`);
  return [tr(heading), ...shown];
}

/** The briefing as plain text: opener, date, weather, then the lists. */
export function renderBriefing(data: BriefingData, opener: string, tr: Translate): string {
  const lines = [opener, data.dateLabel];
  if (data.weather) lines.push(data.weather);
  const body = [
    ...section(tr, "brief.events", data.events),
    ...section(tr, "brief.deadlines", data.deadlinesToday),
    ...section(tr, "brief.overdue", data.overdue),
    ...section(tr, "brief.todos", data.todosToday),
    ...section(tr, "brief.reminders", data.remindersToday),
    ...section(tr, "brief.habits", data.habitsLeft.map((title) => ({ title }))),
  ];
  if (body.length === 0) body.push(tr("brief.clear"));
  return [...lines, "", ...body].join("\n");
}
