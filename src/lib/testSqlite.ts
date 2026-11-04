/**
 * Tests only: an in-memory SQLite (Node's built-in node:sqlite) shaped like
 * the app's plugin-sql connection, with the real migrations applied. Never
 * imported by app code.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDb } from "./todoRepo";

const MIGRATIONS = join(__dirname, "..", "..", "src-tauri", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
}

/** A fresh database with migrations up to and including `upTo` (e.g. 5). */
export function openTestDb(upTo = Infinity): { raw: DatabaseSync; db: SqlDb; migrate: (from: number, to: number) => void } {
  const raw = new DatabaseSync(":memory:");
  const migrate = (from: number, to: number) => {
    for (const f of migrationFiles()) {
      const n = Number(f.slice(0, 4));
      if (n >= from && n <= to) raw.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
  };
  migrate(1, upTo);

  const value = (v: unknown): SQLInputValue =>
    v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SQLInputValue);
  // plugin-sql accepts $1-style placeholders too; SQLite spells those ?1.
  const fix = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");

  const db: SqlDb = {
    async select<T>(sql: string, args: unknown[] = []) {
      return raw.prepare(fix(sql)).all(...args.map(value)) as T;
    },
    async execute(sql: string, args: unknown[] = []) {
      const r = raw.prepare(fix(sql)).run(...args.map(value));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
  return { raw, db, migrate };
}
