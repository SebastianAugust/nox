import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load("sqlite:nox.db");
  await initTables(db);
  return db;
}

/**
 * Read multiple settings at once. Returns a map of key → value for the keys
 * that exist in the settings table (missing keys are simply absent).
 */
export async function getSettings(
  keys: string[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const db = await getDb();
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.select<{ key: string; value: string }[]>(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    keys,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function initTables(db: Database) {
  await db.execute(`PRAGMA journal_mode=WAL;`);
  await db.execute(`PRAGMA foreign_keys=ON;`);

  // 1. Settings
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 2. To-do / quick capture
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      notes TEXT,
      due_date TEXT,
      status TEXT DEFAULT 'pending',
      context TEXT DEFAULT 'personal',
      notion_id TEXT,
      synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 3. Reminders
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      remind_at TEXT NOT NULL,
      repeat TEXT DEFAULT 'none',
      status TEXT DEFAULT 'pending',
      todo_id INTEGER REFERENCES todos(id),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 4. Habits
  await db.execute(`
    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      frequency TEXT DEFAULT 'daily',
      target_time TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 5. Habit history — UNIQUE(habit_id, date) so logHabit's upsert works.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL REFERENCES habits(id),
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      note TEXT,
      logged_at TEXT DEFAULT (datetime('now')),
      UNIQUE (habit_id, date)
    )
  `);

  // 6. Pomodoro sessions
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context TEXT DEFAULT 'general',
      duration_minutes INTEGER DEFAULT 25,
      break_minutes INTEGER DEFAULT 5,
      completed INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT
    )
  `);

  // 7. Conversation history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 8. Clipboard history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS clipboard_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      app_source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 9. Mood history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS mood_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mood TEXT NOT NULL,
      energy INTEGER,
      note TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 10. Pattern data
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pattern_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      context TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 11. App usage log
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      window_title TEXT,
      context TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_seconds INTEGER
    )
  `);

  // 12. Notification history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notification_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      title TEXT,
      body TEXT,
      summary TEXT,
      is_important INTEGER DEFAULT 0,
      read_at TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 13. Weather cache
  await db.execute(`
    CREATE TABLE IF NOT EXISTS weather_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      temperature REAL,
      condition TEXT,
      humidity INTEGER,
      wind_speed REAL,
      forecast TEXT,
      cached_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 14. Daily recap history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS daily_recaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      todos_completed INTEGER DEFAULT 0,
      todos_total INTEGER DEFAULT 0,
      pomodoro_sessions INTEGER DEFAULT 0,
      habits_completed INTEGER DEFAULT 0,
      habits_total INTEGER DEFAULT 0,
      summary TEXT,
      mood TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 15. Spotify history
  await db.execute(`
    CREATE TABLE IF NOT EXISTS spotify_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_name TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      context TEXT,
      mood TEXT,
      played_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 16. Context mode log
  await db.execute(`
    CREATE TABLE IF NOT EXISTS context_mode_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_minutes INTEGER
    )
  `);

  // 17. Screenshot index
  await db.execute(`
    CREATE TABLE IF NOT EXISTS screenshot_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT,
      ocr_text TEXT,
      nox_response TEXT,
      file_path TEXT,
      taken_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 18. Goal tracker
  await db.execute(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'weekly',
      target_value INTEGER,
      current_value INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      due_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )
  `);

  // 19. Notion cache - assignments
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notion_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notion_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      due_date TEXT,
      course TEXT,
      grade REAL,
      weight REAL,
      weighted_mark REAL,
      status TEXT DEFAULT 'pending',
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 20. Notion cache - courses
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notion_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notion_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      semester TEXT,
      status TEXT DEFAULT 'in_progress',
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Insert default settings. Keys that nothing reads are no longer seeded;
  // rows already in an existing database are left alone.
  await db.execute(`
    INSERT OR IGNORE INTO settings (key, value) VALUES
    ('language', 'en'),
    ('pomodoro_duration', '25'),
    ('pomodoro_break', '5'),
    ('dnd_during_pomodoro', 'true'),
    ('daily_briefing_time', '08:00'),
    ('daily_briefing_enabled', 'true'),
    ('body_checkin_enabled', 'true'),
    ('friction_starter_enabled', 'true'),
    ('recap_time', '22:00'),
    ('body_checkin_interval', '180'),
    ('ollama_model', 'llama3.2:3b'),
    ('user_name', 'Bas'),
    ('user_timezone', 'Asia/Jakarta'),
    ('user_location', 'Medan, North Sumatra, Indonesia')
  `);
}
