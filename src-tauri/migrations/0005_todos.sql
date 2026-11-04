-- The full Todos page: lists, steps, priority, time, repeat, estimate,
-- course, Notion copies and focus sessions per todo. Non-destructive: only
-- new columns and tables, then a backfill of the rows that already exist.

-- ── Lists ──
-- A small fixed palette (color is a token id, see --list-* in tokens.css).
-- Exactly one row has is_default = 1; it cannot be deleted.
CREATE TABLE IF NOT EXISTS todo_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO todo_lists (name, color, sort_order, is_default)
SELECT 'Personal', 'amber', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM todo_lists WHERE is_default = 1);

-- ── Todos ──
ALTER TABLE todos ADD COLUMN due_time TEXT;               -- "HH:MM", local
ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;  -- 0 none … 3 high
ALTER TABLE todos ADD COLUMN list_id INTEGER REFERENCES todo_lists(id);
ALTER TABLE todos ADD COLUMN estimate_pomodoros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN repeat_rule TEXT;            -- daily | weekdays | weekly | monthly | every:N
ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN completed_at TEXT;           -- UTC stamp
ALTER TABLE todos ADD COLUMN course_name TEXT;
ALTER TABLE todos ADD COLUMN source_notion_id TEXT;       -- set when copied from a Notion assignment

-- Backfill. Dates become a bare local YYYY-MM-DD with the time split off.
UPDATE todos SET due_date = NULL WHERE trim(due_date) = '';
UPDATE todos
SET due_time = substr(due_date, 12, 5), due_date = substr(due_date, 1, 10)
WHERE length(due_date) >= 16 AND substr(due_date, 14, 1) = ':';
UPDATE todos SET due_date = substr(due_date, 1, 10) WHERE length(due_date) > 10;
UPDATE todos SET list_id = (SELECT id FROM todo_lists WHERE is_default = 1) WHERE list_id IS NULL;
UPDATE todos SET completed_at = COALESCE(updated_at, created_at) WHERE status = 'done' AND completed_at IS NULL;
UPDATE todos SET sort_order = id WHERE sort_order = 0;

-- One copy per Notion assignment, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS todos_source_notion ON todos (source_notion_id)
  WHERE source_notion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS todos_status_due ON todos (status, due_date);

-- ── Steps ──
CREATE TABLE IF NOT EXISTS todo_subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS todo_subtasks_todo ON todo_subtasks (todo_id);

-- foreign_keys is a per-connection pragma, so ON DELETE CASCADE alone is not
-- reliable here. The trigger always runs.
CREATE TRIGGER IF NOT EXISTS todo_subtasks_cascade AFTER DELETE ON todos
BEGIN
  DELETE FROM todo_subtasks WHERE todo_id = OLD.id;
END;

-- ── Focus sessions per todo ──
-- pomodoro_sessions.context is free text (an assignment name, "general"), so
-- it cannot carry an id; a real column can.
ALTER TABLE pomodoro_sessions ADD COLUMN todo_id INTEGER;
CREATE INDEX IF NOT EXISTS pomodoro_sessions_todo ON pomodoro_sessions (todo_id);

CREATE INDEX IF NOT EXISTS reminders_todo ON reminders (todo_id);

INSERT OR IGNORE INTO settings (key, value) VALUES ('todos_show_notion', 'true');
