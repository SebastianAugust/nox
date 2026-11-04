import { locale, t, type I18nKey } from "../../lib/i18n";
import { addDays, dayDiff, type Group } from "../../lib/todoLogic";
import type { Priority } from "../../lib/todoParse";
import type { ListColor } from "../../lib/todoRepo";

/** "Fri 6 Nov" in the user's language. Dates are calendar days, so UTC. */
export function dayLabel(day: string, long = false): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale(), {
    timeZone: "UTC",
    weekday: long ? "long" : "short",
    day: "numeric",
    month: "short",
  });
}

export type DueTone = "overdue" | "today" | "tomorrow" | "later";

/** The due chip on a row: "2 days overdue", "Today 18:30", "Fri 6 Nov". */
export function dueChip(date: string, time: string | null, today: string): { tone: DueTone; text: string } {
  const at = time ? ` ${time}` : "";
  const diff = dayDiff(today, date);
  if (diff < 0) {
    const n = -diff;
    return { tone: "overdue", text: t(n === 1 ? "todo.due.overdueOne" : "todo.due.overdue", { n }) };
  }
  if (diff === 0) return { tone: "today", text: `${t("todo.due.today")}${at}` };
  if (diff === 1) return { tone: "tomorrow", text: `${t("todo.due.tomorrow")}${at}` };
  return { tone: "later", text: `${dayLabel(date)}${at}` };
}

export function groupTitle(g: Group, today: string): string {
  switch (g.kind) {
    case "overdue":
      return t("todo.group.overdue");
    case "today":
      return `${t("todo.group.today")} · ${dayLabel(today)}`;
    case "tomorrow":
      return `${t("todo.group.tomorrow")} · ${dayLabel(addDays(today, 1))}`;
    case "day":
      return dayLabel(g.date!, true);
    case "none":
      return t("todo.group.none");
    case "done":
      return t("todo.group.done");
  }
}

export const PRIORITY_LABEL: Record<Priority, I18nKey> = {
  0: "pri.0",
  1: "pri.1",
  2: "pri.2",
  3: "pri.3",
};

export const LIST_COLOR_LABEL: Record<ListColor, I18nKey> = {
  mint: "list.color.mint",
  sky: "list.color.sky",
  amber: "list.color.amber",
  violet: "list.color.violet",
  rose: "list.color.rose",
  slate: "list.color.slate",
};

/** "Every week", "Every 3 days", or "No repeat". */
export function repeatLabel(rule: string | null): string {
  if (!rule) return t("todo.repeat.none");
  if (rule.startsWith("every:")) return t("todo.repeat.everyN", { n: Number(rule.slice(6)) });
  return t(`todo.repeat.${rule as "daily" | "weekdays" | "weekly" | "monthly"}`);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A UTC "YYYY-MM-DD HH:MM:SS" stamp as a local datetime-local value. */
export function stampToInput(stamp: string): string {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) as a UTC stamp for the reminders table. */
export function inputToStamp(value: string): string | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace("T", " ");
}

/** A UTC stamp for display: "Tue 18:00" in the user's language and timezone. */
export function stampLabel(stamp: string, timeZone?: string): string {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return d.toLocaleString(locale(), { ...opts, timeZone });
  } catch {
    return d.toLocaleString(locale(), opts);
  }
}
