-- Phase 2 amendments: saved places, course status, briefing default 07:30.

-- A1: the briefing default is now 07:30. Only the value 0003 seeded is moved:
-- it still says 07:00 and was last written together with the other 0003
-- defaults. A 07:00 Bas saved himself has a later updated_at and stays.
UPDATE settings SET value = '07:30', updated_at = datetime('now')
WHERE key = 'briefing_time' AND value = '07:00'
  AND updated_at <= (
    SELECT MIN(updated_at) FROM settings
    WHERE key IN ('briefing_enabled', 'nudges_enabled', 'notion_map_title', 'telegram_push_reminders')
  );
INSERT OR IGNORE INTO settings (key, value) VALUES ('briefing_time', '07:30');

-- A2: Notion's own course status ("In progress", "Passed", ...) and term.
-- notion_courses.status stays Nox's 'in_progress' | 'removed'.
ALTER TABLE notion_courses ADD COLUMN notion_status TEXT;

-- A3: saved places. Exactly one is active (setting active_place_id).
-- name = what Bas calls it ("Kampus"); label = the geocoded place.
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  label TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Carry the old single location over as the first place, so nothing is lost.
INSERT INTO places (name, label, latitude, longitude)
SELECT
  COALESCE(
    NULLIF(CASE WHEN instr(loc.value, ',') > 0 THEN trim(substr(loc.value, 1, instr(loc.value, ',') - 1))
                ELSE trim(loc.value) END, ''),
    NULLIF(place.value, ''),
    'Jatinangor'),
  NULLIF(place.value, ''),
  CAST(lat.value AS REAL),
  CAST(lon.value AS REAL)
FROM settings lat
JOIN settings lon ON lon.key = 'weather_lon' AND lon.value != ''
LEFT JOIN settings loc ON loc.key = 'weather_location'
LEFT JOIN settings place ON place.key = 'weather_place'
WHERE lat.key = 'weather_lat' AND lat.value != ''
  AND NOT EXISTS (SELECT 1 FROM places);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('active_place_id', COALESCE((SELECT CAST(MIN(id) AS TEXT) FROM places), '')),
  -- Detect now sends the public IP to a third party: off until Bas opts in.
  ('location_detect_enabled', 'false');
