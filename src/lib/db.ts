import Database from "@tauri-apps/plugin-sql";

let db: Promise<Database> | null = null;

/**
 * The shared connection. The schema is not created here: Rust runs the
 * numbered migrations in `src-tauri/migrations/` once at startup (the
 * database is preloaded in tauri.conf.json), before any window can query.
 */
export function getDb(): Promise<Database> {
  db ??= Database.load("sqlite:nox.db").then(async (conn) => {
    // Not schema: WAL is a property of the file and sticks once set, but it
    // cannot be switched inside a migration's transaction. A no-op afterwards.
    await conn.execute("PRAGMA journal_mode=WAL;");
    return conn;
  }).catch((err) => {
    db = null; // let the next call retry instead of caching the failure
    throw err;
  });
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
