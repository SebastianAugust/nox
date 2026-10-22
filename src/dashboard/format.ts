import { todayLocal } from "../lib/db-helpers";
import { daysBetween } from "../lib/homeMessage";
import { locale, t } from "../lib/i18n";
import { shiftDay } from "../lib/streaks";

export type DueKind = "overdue" | "today" | "tomorrow" | "later";

/** How a YYYY-MM-DD due date reads in a row: "2d late", "today", "25 Oct". */
export function dueInfo(due: string, today = todayLocal()): { kind: DueKind; days: number; text: string } {
  const date = due.slice(0, 10);
  const days = daysBetween(date, today);
  if (days > 0) return { kind: "overdue", days, text: t("date.late", { n: days }) };
  if (days === 0) return { kind: "today", days, text: t("date.today") };
  if (date === shiftDay(today, 1)) return { kind: "tomorrow", days, text: t("date.tomorrow") };
  const [y, m, d] = date.split("-").map(Number);
  return {
    kind: "later",
    days,
    text: new Date(y, m - 1, d).toLocaleDateString(locale(), { day: "numeric", month: "short" }),
  };
}

/**
 * Fill a translated template, wrapping the named params in `wrap` (used to
 * color a todo title inside Nox's message).
 */
export function fillRich(
  template: string,
  params: Record<string, string | number>,
  wrap: Record<string, (text: string) => React.ReactNode> = {},
): React.ReactNode[] {
  return template.split(/(\{\w+\})/).map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name || !(name in params)) return part;
    const value = String(params[name]);
    return wrap[name] ? wrap[name](value) : value;
  });
}
