import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { asApiError, type ApiError } from "./api";
import { normalizeId } from "./notionMapping";
import { matchName } from "./todoLogic";
import { isTestDb, sqlDb } from "./todoRepo";

/**
 * Notion write-back, through an outbox. Only two operations exist: set the
 * Done checkbox of an assignment, and create an assignment page. Nothing is
 * written while `notion_write_enabled` is off.
 *
 * Every write is a row in `notion_outbox` first, so an offline or failed call
 * is retried on app start, after each sync and right after queueing, up to
 * MAX_ATTEMPTS times; then it stays `failed` with a Retry in Integrations.
 * A queued write is never dropped silently, and a failed Done is not
 * reverted locally.
 *
 * Creates are not idempotent in Notion, so once an attempt may have reached
 * Notion (timeout, dropped connection), the next attempt passes
 * `existingSince` and Rust looks for that page before creating another.
 */

export const MAX_ATTEMPTS = 5;

export type SetDonePayload = { page_id: string; done: boolean };
export type CreatePayload = {
  database_id: string;
  name: string;
  /** Notion date start: "2026-11-06" or "2026-11-06T18:30:00+07:00". */
  date_iso: string | null;
  /** Local due (for the mirrored row): "YYYY-MM-DD" or "YYYY-MM-DD HH:MM". */
  due_local: string | null;
  course_page_id: string | null;
  course_name: string | null;
  /** The todo this was sent from, which gets the new page id. */
  todo_id: number | null;
  /** Filled in once sent. */
  page_id?: string;
};

export type OutboxRow = {
  id: number;
  op: "set_done" | "create";
  payload: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  uncertain_since: string | null;
};

// ── Transport (the Rust commands; tests swap it) ──

export type Transport = {
  setDone(pageId: string, done: boolean): Promise<unknown>;
  create(p: CreatePayload, existingSince: string | null): Promise<{ pageId: string; existed: boolean }>;
};

const tauriTransport: Transport = {
  setDone: (pageId, done) => invoke("notion_set_done", { pageId, done }),
  create: (p, existingSince) =>
    invoke("notion_create_assignment", {
      databaseId: p.database_id,
      name: p.name,
      dateIso: p.date_iso,
      coursePageId: p.course_page_id,
      existingSince,
    }),
};
let transport = tauriTransport;
/** Tests only. */
export function useOutboxTransport(t: Transport | null) {
  transport = t ?? tauriTransport;
}

function announce() {
  if (isTestDb()) return;
  emit("notion:outbox").catch(() => {});
  emit("todos:changed").catch(() => {});
}

async function setting(key: string): Promise<string | null> {
  const db = await sqlDb();
  const rows = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = ?", [key]);
  return rows[0]?.value ?? null;
}

export async function writesEnabled(): Promise<boolean> {
  return (await setting("notion_write_enabled")) === "true";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local due date (+ time) as a Notion date start with the local offset. */
export function toNotionDate(date: string | null | undefined, time: string | null | undefined, ref = new Date()): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return date;
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const at = new Date(y, m - 1, d, h, mi);
  const off = -(Number.isNaN(at.getTime()) ? ref : at).getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${date}T${time}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// ── Queueing ──

export type QueueResult = "queued" | "off" | "notConfigured" | "linked" | "empty";

/**
 * Mark an assignment done (or not) in Notion. The local row changes at once
 * (optimistic); a pending write for the same page is updated, not doubled.
 */
export async function queueSetDone(pageId: string, done: boolean): Promise<QueueResult> {
  if (!(await writesEnabled())) return "off";
  const id = normalizeId(pageId);
  const db = await sqlDb();
  await db.execute("UPDATE notion_assignments SET status = ? WHERE notion_id = ? AND status != 'removed'", [
    done ? "done" : "pending",
    id,
  ]);
  const pending = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE op = 'set_done' AND status = 'pending'");
  const same = pending.find((r) => (JSON.parse(r.payload) as SetDonePayload).page_id === id);
  const payload = JSON.stringify({ page_id: id, done } satisfies SetDonePayload);
  if (same) await db.execute("UPDATE notion_outbox SET payload = ? WHERE id = ?", [payload, same.id]);
  else await db.execute("INSERT INTO notion_outbox (op, payload) VALUES ('set_done', ?)", [payload]);
  announce();
  return "queued";
}

/**
 * Create an assignment page. `course` is matched by name against the synced
 * courses; no match leaves the relation empty (`courseMatched` false). A
 * todo already linked to Notion, or already queued, cannot be sent twice.
 */
export async function queueCreate(input: {
  name: string;
  due_date?: string | null;
  due_time?: string | null;
  course?: string | null;
  todo_id?: number | null;
}): Promise<{ result: QueueResult; courseMatched: boolean; course: string | null }> {
  const none = { courseMatched: false, course: null };
  const name = input.name.trim();
  if (!name) return { result: "empty", ...none };
  if (!(await writesEnabled())) return { result: "off", ...none };
  const databaseId = (await setting("notion_assignments_db_id"))?.trim();
  if (!databaseId) return { result: "notConfigured", ...none };
  const db = await sqlDb();

  if (input.todo_id) {
    const [todo] = await db.select<{ source_notion_id: string | null }[]>("SELECT source_notion_id FROM todos WHERE id = ?", [
      input.todo_id,
    ]);
    const queued = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE op = 'create' AND status != 'sent'");
    const already = queued.some((r) => (JSON.parse(r.payload) as CreatePayload).todo_id === input.todo_id);
    if (todo?.source_notion_id || already) return { result: "linked", ...none };
  }

  const courses = await db.select<{ notion_id: string; name: string }[]>(
    "SELECT notion_id, name FROM notion_courses WHERE status != 'removed'",
  );
  const course = input.course?.trim() ? matchName(courses, input.course) : null;

  const payload: CreatePayload = {
    database_id: databaseId,
    name,
    date_iso: toNotionDate(input.due_date, input.due_time),
    due_local: input.due_date ? `${input.due_date}${input.due_time ? ` ${input.due_time}` : ""}` : null,
    course_page_id: course?.notion_id ?? null,
    course_name: course?.name ?? null,
    todo_id: input.todo_id ?? null,
  };
  await db.execute("INSERT INTO notion_outbox (op, payload) VALUES ('create', ?)", [JSON.stringify(payload)]);
  announce();
  return { result: "queued", courseMatched: !!course || !input.course?.trim(), course: course?.name ?? null };
}

// ── Sending ──

/** Errors after which a create might nevertheless have happened. */
const UNCERTAIN: ApiError["kind"][] = ["timeout", "offline", "badResponse", "http"];

/** Notion's created_time has minute precision: look from a minute earlier. */
function sinceIso(stamp: string): string {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() - 1);
  return d.toISOString().replace(".000Z", "Z");
}

async function mirrorCreated(p: CreatePayload, pageId: string) {
  const db = await sqlDb();
  const id = normalizeId(pageId);
  // The row the next sync will upsert, so the page shows at once and is
  // never added a second time.
  await db.execute(
    `INSERT OR IGNORE INTO notion_assignments (notion_id, name, due_date, course, course_notion_id, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [id, p.name, p.due_local, p.course_name, p.course_page_id ? normalizeId(p.course_page_id) : null],
  );
  if (p.todo_id) {
    try {
      await db.execute("UPDATE todos SET source_notion_id = ?, updated_at = datetime('now') WHERE id = ? AND source_notion_id IS NULL", [
        id,
        p.todo_id,
      ]);
    } catch {
      // Another todo already holds this page (unique index): leave both as they are.
    }
  }
}

let flushing: Promise<{ sent: number; failed: number }> | null = null;

/** Send every pending write, oldest first. One run at a time; never throws. */
export function flushOutbox(): Promise<{ sent: number; failed: number }> {
  flushing ??= (async () => {
    let sent = 0;
    let failed = 0;
    try {
      if (!(await writesEnabled())) return { sent, failed };
      const db = await sqlDb();
      const rows = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE status = 'pending' ORDER BY id");
      for (const row of rows) {
        try {
          if (row.op === "set_done") {
            const p = JSON.parse(row.payload) as SetDonePayload;
            await transport.setDone(p.page_id, p.done);
            await db.execute("UPDATE notion_outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?", [row.id]);
          } else {
            const p = JSON.parse(row.payload) as CreatePayload;
            const r = await transport.create(p, row.uncertain_since ? sinceIso(row.uncertain_since) : null);
            await mirrorCreated(p, r.pageId);
            await db.execute(
              "UPDATE notion_outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL, payload = ? WHERE id = ?",
              [JSON.stringify({ ...p, page_id: normalizeId(r.pageId) }), row.id],
            );
          }
          sent++;
        } catch (err) {
          const e = asApiError(err);
          if (e.kind === "writesOff") break; // switched off meanwhile: wait, do not count
          const attempts = row.attempts + 1;
          const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
          if (status === "failed") failed++;
          const uncertain = row.op === "create" && UNCERTAIN.includes(e.kind) && !row.uncertain_since;
          await db.execute(
            `UPDATE notion_outbox SET attempts = ?, status = ?, last_error = ?,
               uncertain_since = CASE WHEN ? THEN COALESCE(uncertain_since, created_at) ELSE uncertain_since END
             WHERE id = ?`,
            [attempts, status, JSON.stringify(e), uncertain ? 1 : 0, row.id],
          );
        }
      }
    } catch (err) {
      console.error(err);
    }
    if (sent || failed) announce();
    return { sent, failed };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Retry a failed write (Integrations): back to pending with fresh attempts. */
export async function retryOutbox(id: number): Promise<void> {
  const db = await sqlDb();
  await db.execute("UPDATE notion_outbox SET status = 'pending', attempts = 0 WHERE id = ? AND status = 'failed'", [id]);
  announce();
}

export async function outboxStatus(): Promise<{ pending: number; failed: (OutboxRow & { title: string })[] }> {
  const db = await sqlDb();
  const [pending] = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM notion_outbox WHERE status = 'pending'");
  const failed = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 20");
  const names = await db.select<{ notion_id: string; name: string }[]>("SELECT notion_id, name FROM notion_assignments");
  const byId = new Map(names.map((n) => [n.notion_id, n.name]));
  return {
    pending: pending?.n ?? 0,
    failed: failed.map((r) => {
      const p = JSON.parse(r.payload) as SetDonePayload & CreatePayload;
      return { ...r, title: r.op === "create" ? p.name : (byId.get(p.page_id) ?? p.page_id) };
    }),
  };
}
