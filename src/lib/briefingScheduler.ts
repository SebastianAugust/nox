import { getSettings } from "./db";
import {
  getOpenAssignments,
  getTodayHabitLogs,
  getTodayReminders,
  getTodosFiltered,
  setSetting,
  todayLocal,
} from "./db-helpers";
import { renderBriefing, shouldShowBriefing, type BriefingData } from "./briefing";
import { describeDue, urgencyText } from "./commands";
import { urgency } from "./deadlines";
import { locale, t } from "./i18n";
import { quickReply } from "./ollama";
import { getWeather, weatherLine } from "./weather";

/**
 * Fires the morning briefing once a day at `briefing_time` (local time in the
 * user's timezone setting). If Nox starts after that time and today's
 * briefing has not been shown, it comes once on startup. `last_briefing_date`
 * is written before anything is shown, so a restart never repeats it.
 */

const POLL_MS = 60 * 1000;
const OPENER_TIMEOUT_MS = 8000;

const clock = (stamp: string) => {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Gather the facts. Every list comes from the database, never the model. */
export async function gatherBriefing(now = new Date()): Promise<BriefingData> {
  const today = todayLocal();
  const [assignments, todos, habits, reminders, weather] = await Promise.all([
    getOpenAssignments(0, 100),
    getTodosFiltered("pending", 500),
    getTodayHabitLogs(),
    getTodayReminders(),
    getWeather().catch(() => null),
  ]);
  const words = { today: t("date.today"), tomorrow: t("date.tomorrow") };

  const deadlinesToday = assignments
    .filter((a) => a.due_date.slice(0, 10) === today && urgency(a.due_date, now).kind !== "overdue")
    .map((a) => ({ title: a.name, detail: [a.course, a.due_date.slice(11, 16)].filter(Boolean).join(" · ") || undefined }));
  const overdue = [
    ...assignments
      .filter((a) => urgency(a.due_date, now).kind === "overdue")
      .map((a) => ({ title: a.name, detail: urgencyText(urgency(a.due_date, now), t) })),
    ...todos
      .filter((x) => x.due_date && x.due_date.slice(0, 10) < today)
      .map((x) => ({ title: x.title, detail: describeDue(x.due_date!, words, now) })),
  ];
  const todosToday = todos.filter((x) => x.due_date?.slice(0, 10) === today).map((x) => ({ title: x.title }));

  return {
    dateLabel: now.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" }),
    weather: weather ? weatherLine(weather) : null,
    deadlinesToday,
    overdue,
    todosToday,
    habitsLeft: (habits as { name: string; completed: number }[]).filter((h) => !h.completed).map((h) => h.name),
    remindersToday: reminders.map((r) => ({ title: r.title, detail: clock(r.remind_at) })),
  };
}

/** The friendly first line: the model if it answers quickly, else a static one. */
async function opener(name: string): Promise<string> {
  const fallback = t("brief.opener", { name });
  const line = await quickReply(t("brief.openerPrompt", { name }), OPENER_TIMEOUT_MS);
  // One or two sentences only; anything longer is not an opener.
  return line && line.length <= 220 ? line : fallback;
}

export async function buildBriefingText(now = new Date()): Promise<string> {
  const s = await getSettings(["user_name"]);
  const [data, first] = await Promise.all([gatherBriefing(now), opener(s.user_name?.trim() || "Bas")]);
  return renderBriefing(data, first, t);
}

/** Start the scheduler in the pet window. Returns a stop function. */
// Shared by every scheduler instance (React's dev double-mount starts two).
let busy = false;

export function startBriefingScheduler(onBriefing: (text: string) => void): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const s = await getSettings(["briefing_enabled", "briefing_time", "last_briefing_date", "user_timezone"]);
      const { due, date } = shouldShowBriefing({
        now: new Date(),
        timeZone: s.user_timezone?.trim() || undefined,
        time: s.briefing_time ?? "07:30",
        enabled: s.briefing_enabled !== "false",
        lastDate: s.last_briefing_date ?? null,
      });
      if (!due) return;
      // Claim the day first: even a crash below cannot make it repeat.
      await setSetting("last_briefing_date", date);
      const text = await buildBriefingText();
      // The day is claimed, so it must go out even if stopped meanwhile.
      onBriefing(text);
    } finally {
      busy = false;
    }
  };

  void tick().catch(console.error);
  const timer = setInterval(() => void tick().catch(console.error), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
