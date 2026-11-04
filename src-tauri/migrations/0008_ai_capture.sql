-- Natural-language capture (queue step 03): on by default. Text is only
-- read by the local Ollama model, and nothing is created without a confirm.
INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_capture_enabled', 'true');
