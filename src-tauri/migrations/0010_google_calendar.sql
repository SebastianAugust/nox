-- Google Calendar (queue step 02, Google delta). iCal feeds stay as they are;
-- Google calendars are a second source in the same calendar_events table.
-- OAuth client id/secret and the refresh token live in Credential Manager,
-- never here.

-- Google calendars Bas can see. The primary one is enabled when first seen,
-- others start off. sync_token: Google's nextSyncToken for incremental sync;
-- window_day: the local day the last full sync's window was computed for
-- (a new day means a full resync, so the +30-day window moves along).
CREATE TABLE IF NOT EXISTS calendar_sources (
  calendar_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sync_token TEXT,
  window_day TEXT,
  last_synced_at TEXT,   -- UTC stamp of the last good sync
  last_error TEXT        -- JSON ApiError of the last failed sync, or NULL
);

-- Existing rows are iCal occurrences (source 'ics', feed_id set). Google
-- rows use source 'google', feed_id 0, calendar_id + google_id.
ALTER TABLE calendar_events ADD COLUMN source TEXT NOT NULL DEFAULT 'ics';
ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT;
ALTER TABLE calendar_events ADD COLUMN google_id TEXT;
ALTER TABLE calendar_events ADD COLUMN status TEXT;
ALTER TABLE calendar_events ADD COLUMN updated_at TEXT;
ALTER TABLE calendar_events ADD COLUMN html_link TEXT;
CREATE INDEX IF NOT EXISTS calendar_events_google ON calendar_events (calendar_id, google_id);

-- Actions that create data from free text wait here for Bas's confirmation
-- (pet card or Telegram buttons). kind: 'capture' | 'event'. status:
-- pending | running | done | cancelled | expired | failed. expires_at: UTC
-- "YYYY-MM-DD HH:MM:SS", 10 minutes after creation. result: the reply text
-- after it ran (for an event, it includes the link).
CREATE TABLE IF NOT EXISTS pending_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  result TEXT
);
CREATE INDEX IF NOT EXISTS pending_actions_status ON pending_actions (status);

-- Event nudges now default to 60 minutes. A value Bas chose himself (saved
-- after the 0007 default was seeded) is kept.
UPDATE settings SET value = '60', updated_at = datetime('now')
WHERE key = 'calendar_nudge_minutes' AND value = '15'
  AND updated_at <= (SELECT COALESCE(MIN(updated_at), datetime('now')) FROM settings WHERE key = 'ai_capture_enabled');
INSERT OR IGNORE INTO settings (key, value) VALUES ('calendar_nudge_minutes', '60');
