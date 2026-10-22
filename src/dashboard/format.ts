import { todayLocal } from "../lib/db-helpers";
import { locale, t } from "../lib/i18n";

/** "today" / "tomorrow" / a short date, for due dates that are plain YYYY-MM-DD. */
export function formatDue(due: string): { text: string; color: string } {
  const date = due.slice(0, 10);
  const today = todayLocal();
  if (date < today) return { text: t("date.overdue"), color: "#f87171" };
  if (date === today) return { text: t("date.today"), color: "#f59e0b" };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  const tomorrowStr = `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(
    tomorrow.getDate(),
  )}`;
  if (date === tomorrowStr) return { text: t("date.tomorrow"), color: "#00e5a0" };

  const [y, m, d] = date.split("-").map(Number);
  return {
    text: new Date(y, m - 1, d).toLocaleDateString(locale(), {
      day: "numeric",
      month: "short",
    }),
    color: "rgba(255,255,255,0.15)",
  };
}
