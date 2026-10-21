import { getDb } from "./db";

// ── TIME ──
// SQLite stores timestamps in UTC (datetime('now')), but "today" means the
// user's calendar day. These two helpers are the only place that conversion
// lives: todayLocal() for date columns, utcStamp() for timestamp columns
// (same "YYYY-MM-DD HH:MM:SS" shape as datetime('now'), so DATE(col,
// 'localtime') works on it).
export function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function utcStamp(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ── SETTINGS ──
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const result = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return result[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    [key, value],
  );
}

// ── TODOS ──
export async function addTodo(todo: {
  title: string;
  notes?: string;
  due_date?: string;
  context?: string;
}): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO todos (title, notes, due_date, context) VALUES (?, ?, ?, ?)",
    [
      todo.title,
      todo.notes ?? null,
      todo.due_date ?? null,
      todo.context ?? "personal",
    ],
  );
  return result.lastInsertId ?? 0;
}

export type TodoFilter = "pending" | "done" | "all";

export async function getTodosFiltered(
  filter: TodoFilter,
  limit = 50,
): Promise<
  {
    id: number;
    title: string;
    notes: string | null;
    due_date: string | null;
    status: string;
    created_at: string;
  }[]
> {
  const db = await getDb();
  // Undated items sort last rather than first, which is what "soonest first"
  // should mean.
  const order = "ORDER BY due_date IS NULL, due_date ASC, created_at DESC LIMIT ?";
  if (filter === "all") {
    return db.select(`SELECT * FROM todos ${order}`, [limit]);
  }
  return db.select(`SELECT * FROM todos WHERE status = ? ${order}`, [filter, limit]);
}

export async function setTodoStatus(id: number, status: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE todos SET status = ?, updated_at = datetime('now') WHERE id = ?",
    [status, id],
  );
}

export async function deleteTodo(id: number): Promise<void> {
  const db = await getDb();
  // Detach any reminder first: reminders.todo_id is a FK and foreign_keys=ON.
  await db.execute("UPDATE reminders SET todo_id = NULL WHERE todo_id = ?", [id]);
  await db.execute("DELETE FROM todos WHERE id = ?", [id]);
}

// ── REMINDERS ──
export async function addReminder(reminder: {
  title: string;
  body?: string;
  remind_at: string;
  repeat?: string;
}): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO reminders (title, body, remind_at, repeat) VALUES (?, ?, ?, ?)",
    [
      reminder.title,
      reminder.body ?? null,
      reminder.remind_at,
      reminder.repeat ?? "none",
    ],
  );
  return result.lastInsertId ?? 0;
}

export async function getPendingReminders(): Promise<any[]> {
  const db = await getDb();
  return db.select(
    "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= datetime('now') ORDER BY remind_at ASC",
  );
}

/** Mark a reminder as delivered so it is not shown again. */
export async function markReminderSent(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE reminders SET status = 'sent' WHERE id = ?", [id]);
}

// ── HABITS ──
export async function addHabit(
  name: string,
  description?: string,
): Promise<number> {
  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO habits (name, description) VALUES (?, ?)",
    [name, description ?? null],
  );
  return result.lastInsertId ?? 0;
}

/**
 * Retire a habit. Soft delete (active = 0) so its history stays intact and
 * past recaps/streaks keep making sense.
 */
export async function deleteHabit(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE habits SET active = 0 WHERE id = ?", [id]);
}

export async function logHabit(
  habitId: number,
  completed: boolean,
  note?: string,
): Promise<void> {
  const db = await getDb();
  const today = todayLocal();
  await db.execute(
    "INSERT OR REPLACE INTO habit_logs (habit_id, date, completed, note) VALUES (?, ?, ?, ?)",
    [habitId, today, completed ? 1 : 0, note ?? null],
  );
}

export async function getTodayHabitLogs(): Promise<any[]> {
  const db = await getDb();
  const today = todayLocal();
  return db.select(
    `
    SELECT h.name, h.id, COALESCE(hl.completed, 0) as completed
    FROM habits h
    LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.date = ?
    WHERE h.active = 1
  `,
    [today],
  );
}

// ── DAILY RECAP ──
export async function saveDailyRecap(recap: {
  date: string;
  todos_completed: number;
  todos_total: number;
  pomodoro_sessions: number;
  habits_completed: number;
  habits_total: number;
  summary: string;
  mood?: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `
    INSERT OR REPLACE INTO daily_recaps
    (date, todos_completed, todos_total, pomodoro_sessions, habits_completed, habits_total, summary, mood)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [
      recap.date,
      recap.todos_completed,
      recap.todos_total,
      recap.pomodoro_sessions,
      recap.habits_completed,
      recap.habits_total,
      recap.summary,
      recap.mood ?? null,
    ],
  );
}

export async function getRecentRecaps(limit = 14): Promise<
  {
    date: string;
    todos_completed: number;
    todos_total: number;
    pomodoro_sessions: number;
    habits_completed: number;
    habits_total: number;
    summary: string | null;
    mood: string | null;
  }[]
> {
  const db = await getDb();
  return db.select("SELECT * FROM daily_recaps ORDER BY date DESC LIMIT ?", [limit]);
}

/**
 * Day streaks over all habits: a day counts once at least one habit was ticked.
 * `current` runs back from today (or yesterday, so an untouched morning does
 * not look like a broken streak); `best` is the longest run ever.
 */
export async function getHabitStreaks(): Promise<{
  current: number;
  best: number;
}> {
  const db = await getDb();
  const rows = await db.select<{ date: string }[]>(
    "SELECT DISTINCT date FROM habit_logs WHERE completed = 1 ORDER BY date ASC",
  );
  if (rows.length === 0) return { current: 0, best: 0 };

  const dayNumber = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };
  const days = rows.map((r) => dayNumber(r.date));
  const daySet = new Set(days);

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }

  const today = dayNumber(todayLocal());
  let cursor = daySet.has(today) ? today : daySet.has(today - 1) ? today - 1 : null;
  let current = 0;
  while (cursor !== null && daySet.has(cursor)) {
    current++;
    cursor--;
  }

  return { current, best };
}

/** Completion flags for the last `days` days, keyed by date then habit id. */
export async function getHabitLogsSince(
  days: number,
): Promise<Record<string, Record<number, boolean>>> {
  const db = await getDb();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  const fromStr = `${from.getFullYear()}-${p(from.getMonth() + 1)}-${p(from.getDate())}`;

  const rows = await db.select<{ date: string; habit_id: number; completed: number }[]>(
    "SELECT date, habit_id, completed FROM habit_logs WHERE date >= ?",
    [fromStr],
  );
  const out: Record<string, Record<number, boolean>> = {};
  for (const r of rows) {
    (out[r.date] ??= {})[r.habit_id] = r.completed === 1;
  }
  return out;
}

// ── POMODORO ──
export async function savePomodoroSession(session: {
  context?: string;
  duration_minutes: number;
  break_minutes?: number;
  completed: boolean;
  started_at: string;
  ended_at?: string;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO pomodoro_sessions
     (context, duration_minutes, break_minutes, completed, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      session.context ?? "general",
      session.duration_minutes,
      session.break_minutes ?? 5,
      session.completed ? 1 : 0,
      session.started_at,
      session.ended_at ?? utcStamp(),
    ],
  );
}

export async function getTodayPomodoroSessions(): Promise<
  {
    id: number;
    context: string;
    duration_minutes: number;
    completed: number;
    started_at: string;
    ended_at: string | null;
  }[]
> {
  const db = await getDb();
  return db.select(
    `SELECT id, context, duration_minutes, completed, started_at, ended_at
     FROM pomodoro_sessions
     WHERE DATE(started_at, 'localtime') = ?
     ORDER BY started_at DESC`,
    [todayLocal()],
  );
}

// ── MOOD / CHECK-IN ──
export async function saveMoodLog(
  mood: string,
  energy: number,
  note?: string,
): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO mood_logs (mood, energy, note) VALUES (?, ?, ?)", [
    mood,
    energy,
    note ?? null,
  ]);
}

/**
 * Hours since the last mood log, or null if there has never been one.
 * Computed in SQL so the UTC-stored timestamp is never re-parsed as local time.
 */
export async function hoursSinceLastMood(): Promise<number | null> {
  const db = await getDb();
  const rows = await db.select<{ hours: number }[]>(
    "SELECT (julianday('now') - julianday(logged_at)) * 24 AS hours FROM mood_logs ORDER BY logged_at DESC LIMIT 1",
  );
  return rows[0]?.hours ?? null;
}

// ── DASHBOARD STATS ──
export type TodayStats = {
  tasks: number;
  pomodoros: number;
  habitsDone: number;
  habitsTotal: number;
  deadlines: number;
};

/** One round-trip's worth of counters for the overview page. */
export async function getTodayStats(): Promise<TodayStats> {
  const db = await getDb();
  const today = todayLocal();
  const one = async (sql: string, args: any[] = []) => {
    const rows = await db.select<{ count: number }[]>(sql, args);
    return rows[0]?.count ?? 0;
  };

  const [tasks, pomodoros, habitsTotal, habitsDone, todoDeadlines, assignmentDeadlines] =
    await Promise.all([
      // Open todos that are either due today or were captured today.
      one(
        `SELECT COUNT(*) as count FROM todos
         WHERE status != 'done'
           AND (DATE(due_date) = ? OR DATE(created_at, 'localtime') = ?)`,
        [today, today],
      ),
      one(
        `SELECT COUNT(*) as count FROM pomodoro_sessions
         WHERE DATE(started_at, 'localtime') = ? AND completed = 1`,
        [today],
      ),
      one("SELECT COUNT(*) as count FROM habits WHERE active = 1"),
      one(
        `SELECT COUNT(*) as count FROM habit_logs hl
         JOIN habits h ON h.id = hl.habit_id AND h.active = 1
         WHERE hl.date = ? AND hl.completed = 1`,
        [today],
      ),
      one(
        "SELECT COUNT(*) as count FROM todos WHERE status != 'done' AND DATE(due_date) = ?",
        [today],
      ),
      one(
        "SELECT COUNT(*) as count FROM notion_assignments WHERE status != 'done' AND DATE(due_date) = ?",
        [today],
      ),
    ]);

  return {
    tasks,
    pomodoros,
    habitsDone,
    habitsTotal,
    deadlines: todoDeadlines + assignmentDeadlines,
  };
}

const MAX_OVERDUE = 2;

/**
 * Next few dated items, todos, cached assignments and reminders merged by due
 * date. At most MAX_OVERDUE overdue items lead the list, so a pile of old ones
 * cannot push everything upcoming out of view.
 */
export async function getUpcoming(limit = 5): Promise<
  { title: string; due_date: string; source: string }[]
> {
  const db = await getDb();
  const items = `
    SELECT title, DATE(due_date) AS due_date, 'todo' AS source FROM todos
      WHERE status != 'done' AND due_date IS NOT NULL
    UNION ALL
    SELECT name AS title, DATE(due_date) AS due_date, 'assignment' AS source
      FROM notion_assignments WHERE status != 'done' AND due_date IS NOT NULL
    UNION ALL
    SELECT title, DATE(remind_at, 'localtime') AS due_date, 'reminder' AS source
      FROM reminders WHERE status = 'pending'`;
  type Row = { title: string; due_date: string; source: string };
  const today = todayLocal();
  const [overdue, upcoming] = await Promise.all([
    db.select<Row[]>(
      `SELECT * FROM (${items}) WHERE due_date < ? ORDER BY due_date DESC LIMIT ?`,
      [today, MAX_OVERDUE],
    ),
    db.select<Row[]>(
      `SELECT * FROM (${items}) WHERE due_date >= ? ORDER BY due_date ASC LIMIT ?`,
      [today, limit],
    ),
  ]);
  return [...overdue.reverse(), ...upcoming].slice(0, limit);
}
