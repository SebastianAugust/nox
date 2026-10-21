-- v1: the schema as it stood before migrations existed. Every statement is
-- idempotent, so on a database created by the old webview init this is a no-op.
-- Never edit this file once released: sqlx stores its checksum and refuses to
-- start if it changes. Schema changes go in a new numbered migration.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

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
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  remind_at TEXT NOT NULL,
  repeat TEXT DEFAULT 'none',
  status TEXT DEFAULT 'pending',
  todo_id INTEGER REFERENCES todos(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  frequency TEXT DEFAULT 'daily',
  target_time TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL REFERENCES habits(id),
  date TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  note TEXT,
  logged_at TEXT DEFAULT (datetime('now')),
  UNIQUE (habit_id, date)
);

CREATE TABLE IF NOT EXISTS pomodoro_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context TEXT DEFAULT 'general',
  duration_minutes INTEGER DEFAULT 25,
  break_minutes INTEGER DEFAULT 5,
  completed INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mood_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mood TEXT NOT NULL,
  energy INTEGER,
  note TEXT,
  logged_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weather_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL,
  temperature REAL,
  condition TEXT,
  humidity INTEGER,
  wind_speed REAL,
  forecast TEXT,
  cached_at TEXT DEFAULT (datetime('now'))
);

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
);

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
);

CREATE TABLE IF NOT EXISTS notion_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notion_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  semester TEXT,
  status TEXT DEFAULT 'in_progress',
  synced_at TEXT DEFAULT (datetime('now'))
);
-- Defaults for the settings the code reads. Existing rows are left alone.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('language', 'en'),
  ('pomodoro_duration', '25'),
  ('pomodoro_break', '5'),
  ('dnd_during_pomodoro', 'true'),
  ('body_checkin_enabled', 'true'),
  ('friction_starter_enabled', 'true'),
  ('recap_time', '22:00'),
  ('body_checkin_interval', '180'),
  ('ollama_model', 'llama3.2:3b'),
  ('user_name', 'Bas'),
  ('user_timezone', 'Asia/Jakarta'),
  ('user_location', 'Medan, North Sumatra, Indonesia');
