-- Notion write-back (queue step 01): the outbox every write goes through,
-- and the switch that keeps writes off until Bas turns them on.

-- op: 'set_done' | 'create'. payload: JSON (page id + done, or the new
-- page's fields plus the todo it came from). status: pending | sent | failed.
-- Never deleted on failure: a failed row stays visible with Retry.
CREATE TABLE IF NOT EXISTS notion_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT,
  -- Set once an attempt may have reached Notion (a create that timed out):
  -- the next attempt first looks for the page instead of creating blindly.
  uncertain_since TEXT
);
CREATE INDEX IF NOT EXISTS notion_outbox_status ON notion_outbox (status);

INSERT OR IGNORE INTO settings (key, value) VALUES ('notion_write_enabled', 'false');
