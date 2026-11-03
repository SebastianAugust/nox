-- Phase 2: Notion sync, deadline nudges, weather, briefing, Telegram.
-- Tokens are NOT stored here; they live in Windows Credential Manager.

-- notion_assignments.status is now Nox's own state: 'pending' | 'done' |
-- 'removed' (gone or archived upstream; rows are never hard-deleted).
-- notion_status keeps Notion's raw status text for display.
ALTER TABLE notion_assignments ADD COLUMN notion_status TEXT;
ALTER TABLE notion_assignments ADD COLUMN course_notion_id TEXT;
ALTER TABLE notion_assignments ADD COLUMN last_synced_at TEXT;
-- notion_courses.status: 'in_progress' | 'removed'.
ALTER TABLE notion_courses ADD COLUMN last_synced_at TEXT;

-- One row per (assignment, threshold) nudge already sent, so a nudge never
-- repeats, not even after a restart.
CREATE TABLE IF NOT EXISTS nudges_sent (
  assignment_id TEXT NOT NULL,
  threshold TEXT NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, threshold)
);

-- weather_cache keeps one row per place: location = "lat,lon", forecast =
-- the JSON from the weather_fetch command, cached_at = UTC fetch time.
CREATE INDEX IF NOT EXISTS weather_cache_location ON weather_cache (location);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('briefing_enabled', 'true'),
  ('briefing_time', '07:00'),
  ('last_briefing_date', ''),
  ('nudges_enabled', 'true'),
  ('weather_location', 'Jatinangor, Sumedang'),
  ('weather_lat', ''),
  ('weather_lon', ''),
  ('weather_place', ''),
  ('notion_assignments_db_id', ''),
  ('notion_courses_db_id', ''),
  ('notion_map_title', ''),
  ('notion_map_due', ''),
  ('notion_map_course', ''),
  ('notion_map_status', ''),
  ('notion_map_done', ''),
  ('telegram_chat_id', ''),
  ('telegram_offset', '0'),
  ('telegram_push_reminders', 'true'),
  ('telegram_push_briefing', 'true'),
  ('telegram_push_nudges', 'true');
