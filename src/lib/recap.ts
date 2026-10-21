import { getDb } from "./db";
import { getSetting, saveDailyRecap, todayLocal } from "./db-helpers";
import { t } from "./i18n";

const POLL_MS = 60 * 1000; // check the clock every minute
const DEFAULT_RECAP_TIME = "22:00";

export type Recap = {
  date: string;
  summary: string;
  todos_completed: number;
  todos_total: number;
  pomodoro_sessions: number;
  habits_completed: number;
  habits_total: number;
};

/**
 * Fire the day's recap once, at or after the configured time.
 *
 * "At or after" rather than "exactly at 22:00" so a laptop that was asleep (or
 * an app started at 22:30) still gets its recap. The daily_recaps row for the
 * date is the once-per-day guard, so it cannot fire twice.
 *
 * Returns a stop function; call it on unmount.
 */
export function startRecapScheduler(
  onRecap: (recap: Recap) => void,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    const [hour, minute] = ((await getSetting("recap_time")) ?? DEFAULT_RECAP_TIME)
      .split(":")
      .map(Number);
    const now = new Date();
    if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) {
      return;
    }

    const today = todayLocal();
    if (await hasRecap(today)) return;

    const recap = await generateRecap();
    if (!stopped) onRecap(recap);
  };

  void tick().catch(console.error);
  const handle = setInterval(() => void tick().catch(console.error), POLL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

async function hasRecap(date: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM daily_recaps WHERE date = ?",
    [date],
  );
  return (rows[0]?.count ?? 0) > 0;
}

/** Tally the day and persist it. Safe to call by hand (e.g. a "recap now" button). */
export async function generateRecap(): Promise<Recap> {
  const db = await getDb();
  const today = todayLocal();
  const one = async (sql: string, args: any[] = []) => {
    const rows = await db.select<{ count: number }[]>(sql, args);
    return rows[0]?.count ?? 0;
  };

  const [todosDone, todosTotal, pomodoros, habitsDone, habitsTotal] =
    await Promise.all([
      one(
        `SELECT COUNT(*) as count FROM todos
         WHERE status = 'done' AND DATE(updated_at, 'localtime') = ?`,
        [today],
      ),
      // Everything that was on the plate today: opened today, or still open
      // with today's due date.
      one(
        `SELECT COUNT(*) as count FROM todos
         WHERE DATE(created_at, 'localtime') = ?
            OR (status != 'done' AND DATE(due_date) = ?)`,
        [today, today],
      ),
      one(
        `SELECT COUNT(*) as count FROM pomodoro_sessions
         WHERE DATE(started_at, 'localtime') = ? AND completed = 1`,
        [today],
      ),
      one(
        `SELECT COUNT(*) as count FROM habit_logs hl
         JOIN habits h ON h.id = hl.habit_id AND h.active = 1
         WHERE hl.date = ? AND hl.completed = 1`,
        [today],
      ),
      one("SELECT COUNT(*) as count FROM habits WHERE active = 1"),
    ]);

  const summary = t("recap.summary", {
    done: todosDone,
    total: todosTotal,
    pomodoros,
    habitsDone,
    habitsTotal,
  });

  const recap: Recap = {
    date: today,
    summary,
    todos_completed: todosDone,
    todos_total: todosTotal,
    pomodoro_sessions: pomodoros,
    habits_completed: habitsDone,
    habits_total: habitsTotal,
  };

  await saveDailyRecap(recap);
  return recap;
}
