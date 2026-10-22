-- Appearance settings for the Night Lair redesign. INSERT OR IGNORE, so a
-- value the user already changed is never reset.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ui_bolt_color', 'electric'),
  ('ui_animations', 'true'),
  ('ui_lightning', 'true');
