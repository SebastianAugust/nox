-- Calendar feeds (queue step 02), read-only. The feed URL is a secret and is
-- NOT stored here: it lives in Credential Manager as calendar_feed_<id>.

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,   -- UTC stamp of the last good fetch
  last_error TEXT,       -- JSON ApiError of the last failed fetch, or NULL
  created_at TEXT DEFAULT (datetime('now'))
);

-- Occurrences in the sync window (yesterday to +30 days), replaced per feed
-- on every good fetch. Timed: UTC "YYYY-MM-DD HH:MM:SS"; all-day: dates,
-- end exclusive.
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL,
  uid TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  location TEXT
);
CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events (start);
CREATE INDEX IF NOT EXISTS calendar_events_feed ON calendar_events (feed_id);

CREATE TRIGGER IF NOT EXISTS calendar_feeds_cascade AFTER DELETE ON calendar_feeds
BEGIN
  DELETE FROM calendar_events WHERE feed_id = OLD.id;
END;

-- One row per event nudge sent ("feed|uid|start"), so a restart never repeats one.
CREATE TABLE IF NOT EXISTS calendar_nudges_sent (
  event_key TEXT PRIMARY KEY,
  sent_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('calendar_nudge_minutes', '15');
