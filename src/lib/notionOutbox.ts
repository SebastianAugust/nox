import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { asApiError, type ApiError } from "./api";
import { mapAssignment, normalizeId, resolveMapping, schemaOf, type MappedAssignment, type NotionRow } from "./notionMapping";
import { matchName } from "./todoLogic";
import { isTestDb, sqlDb } from "./todoRepo";

/**
 * Notion write-back, through an outbox. Only three operations exist: set the
 * Done checkbox of an assignment, create an assignment page, and change the
 * title and/or date of an assignment. Nothing is written while
 * `notion_write_enabled` is off.
 *
 * Every write is a row in `notion_outbox` first, so an offline or failed call
 * is retried on app start, after each sync and right after queueing, up to
 * MAX_ATTEMPTS times; then it stays `failed` with a Retry in Integrations.
 * A queued write is never dropped silently, and a failed write is not
 * reverted locally.
 *
 * Conflict rule (Done and updates): each queued write remembers when the
 * local copy was synced (`synced_at`). Rust reads the page first; if it was
 * edited in Notion since then, nothing is written and the fresh page comes
 * back. The local copy is refreshed from it, and then the write is sent on
 * top of the fresh data. For a title or date that was itself changed in
 * Notion meanwhile, Notion's value wins: the write stops as `conflict`
 * (visible, with Retry to apply Nox's value anyway).
 *
 * Creates are not idempotent in Notion, so once an attempt may have reached
 * Notion (timeout, dropped connection), the next attempt passes
 * `existingSince` and Rust looks for that page before creating another.
 */

export const MAX_ATTEMPTS = 5;
/** No known sync time: treat the page as changed (refresh first). */
const EPOCH = "1970-01-01T00:00:00Z";

export type SetDonePayload = { page_id: string; done: boolean; synced_at?: string | null };
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
/** Title and/or date of an existing assignment; null = unchanged. */
export type UpdatePayload = {
  page_id: string;
  name: string | null;
  date_iso: string | null;
  due_local: string | null;
  /** The local values when the first edit was made: what Bas saw. */
  base_name: string;
  base_due: string | null;
  /** The local copy's sync time when the first edit was made. */
  synced_at: string | null;
  /** Retry after a conflict: apply Nox's values over Notion's. */
  force?: boolean;
};

export type OutboxOp = "set_done" | "create" | "update";

export type OutboxRow = {
  id: number;
  op: OutboxOp;
  payload: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  uncertain_since: string | null;
};

/** What Rust's update commands return. */
export type WriteResult = { stale: boolean; written: boolean; row: NotionRow };

/** An outbox error: an API error, or a title/date also changed in Notion. */
export type OutboxError = ApiError | { kind: "conflict"; fields: ("name" | "date")[] };

// ── Transport (the Rust commands; tests swap it) ──

export type Transport = {
  setDone(pageId: string, done: boolean, syncedAt: string | null): Promise<WriteResult | void>;
  create(p: CreatePayload, existingSince: string | null): Promise<{ pageId: string; existed: boolean }>;
  update(p: UpdatePayload, syncedAt: string | null): Promise<WriteResult>;
};

const tauriTransport: Transport = {
  setDone: (pageId, done, syncedAt) => invoke("notion_set_done", { pageId, done, syncedAt }),
  create: (p, existingSince) =>
    invoke("notion_create_assignment", {
      databaseId: p.database_id,
      name: p.name,
      dateIso: p.date_iso,
      coursePageId: p.course_page_id,
      existingSince,
    }),
  update: (p, syncedAt) =>
    invoke("notion_update_assignment", { pageId: p.page_id, name: p.name, dateIso: p.date_iso, syncedAt }),
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

type LocalAssignment = { name: string; due_date: string | null; last_synced_at: string | null };

async function localAssignment(id: string): Promise<LocalAssignment | null> {
  const db = await sqlDb();
  const [row] = await db.select<LocalAssignment[]>(
    "SELECT name, due_date, last_synced_at FROM notion_assignments WHERE notion_id = ? AND status != 'removed'",
    [id],
  );
  return row ?? null;
}

async function pendingFor<T extends { page_id: string }>(op: OutboxOp, id: string): Promise<(OutboxRow & { p: T }) | null> {
  const db = await sqlDb();
  const rows = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE op = ? AND status = 'pending'", [op]);
  for (const r of rows) {
    const p = JSON.parse(r.payload) as T;
    if (p.page_id === id) return { ...r, p };
  }
  return null;
}

// ── Queueing ──

export type QueueResult = "queued" | "off" | "notConfigured" | "linked" | "empty" | "missing";

/**
 * Mark an assignment done (or not) in Notion. The local row changes at once
 * (optimistic); a pending write for the same page is updated, not doubled.
 */
export async function queueSetDone(pageId: string, done: boolean): Promise<QueueResult> {
  if (!(await writesEnabled())) return "off";
  const id = normalizeId(pageId);
  const db = await sqlDb();
  const local = await localAssignment(id);
  await db.execute("UPDATE notion_assignments SET status = ? WHERE notion_id = ? AND status != 'removed'", [
    done ? "done" : "pending",
    id,
  ]);
  const same = await pendingFor<SetDonePayload>("set_done", id);
  // Merged: the first edit's sync time stays, so the conflict rule still sees it.
  const payload: SetDonePayload = { page_id: id, done, synced_at: same ? (same.p.synced_at ?? null) : (local?.last_synced_at ?? null) };
  if (same) await db.execute("UPDATE notion_outbox SET payload = ? WHERE id = ?", [JSON.stringify(payload), same.id]);
  else await db.execute("INSERT INTO notion_outbox (op, payload) VALUES ('set_done', ?)", [JSON.stringify(payload)]);
  announce();
  return "queued";
}

/**
 * Change an assignment's title and/or date in Notion (nothing else). The
 * local row changes at once; a pending update for the same page is merged
 * (the newest values win, the first edit's base and sync time stay).
 */
export async function queueUpdate(
  pageId: string,
  change: { name?: string | null; due_date?: string | null; due_time?: string | null },
): Promise<QueueResult> {
  if (!(await writesEnabled())) return "off";
  const id = normalizeId(pageId);
  const local = await localAssignment(id);
  if (!local) return "missing";
  const name = change.name?.trim() || null;
  const dateIso = change.due_date ? toNotionDate(change.due_date, change.due_time) : null;
  if (typeof change.name === "string" && !name) return "empty";
  if (!name && !dateIso) return "empty";
  const dueLocal = dateIso ? `${change.due_date}${change.due_time ? ` ${change.due_time}` : ""}` : null;

  const db = await sqlDb();
  await db.execute(
    "UPDATE notion_assignments SET name = COALESCE(?, name), due_date = COALESCE(?, due_date) WHERE notion_id = ?",
    [name, dueLocal, id],
  );
  const same = await pendingFor<UpdatePayload>("update", id);
  const payload: UpdatePayload = same
    ? {
        ...same.p,
        name: name ?? same.p.name,
        date_iso: dateIso ?? same.p.date_iso,
        due_local: dueLocal ?? same.p.due_local,
      }
    : {
        page_id: id,
        name,
        date_iso: dateIso,
        due_local: dueLocal,
        base_name: local.name,
        base_due: local.due_date,
        synced_at: local.last_synced_at,
      };
  if (same) await db.execute("UPDATE notion_outbox SET payload = ? WHERE id = ?", [JSON.stringify(payload), same.id]);
  else await db.execute("INSERT INTO notion_outbox (op, payload) VALUES ('update', ?)", [JSON.stringify(payload)]);
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

// ── Refreshing the local copy ──

const MAP_SETTINGS = {
  title: "notion_map_title",
  due: "notion_map_due",
  course: "notion_map_course",
  status: "notion_map_status",
  done: "notion_map_done",
} as const;

/**
 * Write one page as Notion has it into the local copy (as a sync would) and
 * mark it synced now. Returns the mapped values, or null when the page
 * cannot be mapped (then the local row is left as it is).
 */
export async function refreshLocal(row: NotionRow): Promise<MappedAssignment | null> {
  const db = await sqlDb();
  const config: Record<string, string> = {};
  for (const [field, key] of Object.entries(MAP_SETTINGS)) {
    const v = await setting(key);
    if (v) config[field] = v;
  }
  const mapping = resolveMapping(schemaOf([row]), config);
  if (!mapping.ok) return null;
  const courses = await db.select<{ notion_id: string; name: string }[]>("SELECT notion_id, name FROM notion_courses");
  const a = mapAssignment(row, mapping.mapping, new Map(courses.map((c) => [c.notion_id, c.name])));
  if (!a.name) return null;
  const status = a.archived ? "removed" : a.done ? "done" : "pending";
  await db.execute(
    `UPDATE notion_assignments SET name = ?, due_date = ?, course = ?, course_notion_id = ?, notion_status = ?,
       status = ?, synced_at = datetime('now'), last_synced_at = ?
     WHERE notion_id = ?`,
    [a.name, a.due_date, a.course, a.course_notion_id, a.notion_status, status, new Date().toISOString(), a.notion_id],
  );
  return a;
}

/**
 * After a sync: put local edits that are still queued or failed back on top
 * of what the sync wrote, so a write that has not reached Notion is never
 * reverted silently. A conflict is not re-applied (Notion's value stands
 * until Retry).
 */
export async function applyOutboxOverlay(): Promise<void> {
  const db = await sqlDb();
  const rows = await db.select<OutboxRow[]>(
    "SELECT * FROM notion_outbox WHERE op IN ('set_done', 'update') AND status IN ('pending', 'failed') ORDER BY id",
  );
  for (const r of rows) {
    if (r.status === "failed" && r.last_error && (JSON.parse(r.last_error) as OutboxError).kind === "conflict") continue;
    if (r.op === "set_done") {
      const p = JSON.parse(r.payload) as SetDonePayload;
      await db.execute("UPDATE notion_assignments SET status = ? WHERE notion_id = ? AND status != 'removed'", [
        p.done ? "done" : "pending",
        p.page_id,
      ]);
    } else {
      const p = JSON.parse(r.payload) as UpdatePayload;
      await db.execute(
        "UPDATE notion_assignments SET name = COALESCE(?, name), due_date = COALESCE(?, due_date) WHERE notion_id = ? AND status != 'removed'",
        [p.name, p.due_local, p.page_id],
      );
    }
  }
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

class Conflict extends Error {
  constructor(readonly fields: ("name" | "date")[]) {
    super("conflict");
  }
}

/** Done: refresh first when the page changed in Notion, then write. */
async function sendSetDone(p: SetDonePayload) {
  const r = await transport.setDone(p.page_id, p.done, p.synced_at ?? EPOCH);
  if (r?.stale) {
    await refreshLocal(r.row);
    const again = await transport.setDone(p.page_id, p.done, null);
    if (again) await refreshLocal(again.row);
  } else if (r) {
    await refreshLocal(r.row);
  }
}

/**
 * Title/date: refresh first when the page changed in Notion; a field that
 * Notion itself changed since Bas's edit is a conflict (Notion wins), the
 * rest is written on top of the fresh data.
 */
async function sendUpdate(p: UpdatePayload) {
  const first = await transport.update(p, p.force ? null : (p.synced_at ?? EPOCH));
  if (!first.stale) {
    await refreshLocal(first.row);
    return;
  }
  const fresh = await refreshLocal(first.row);
  if (fresh && !p.force) {
    const fields: ("name" | "date")[] = [];
    if (p.name !== null && fresh.name !== p.base_name && fresh.name !== p.name) fields.push("name");
    if (p.due_local !== null && fresh.due_date !== p.base_due && fresh.due_date !== p.due_local) fields.push("date");
    if (fields.length) throw new Conflict(fields);
  }
  const written = await transport.update(p, null);
  await refreshLocal(written.row);
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
            await sendSetDone(JSON.parse(row.payload) as SetDonePayload);
            await db.execute("UPDATE notion_outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?", [row.id]);
          } else if (row.op === "update") {
            await sendUpdate(JSON.parse(row.payload) as UpdatePayload);
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
          if (err instanceof Conflict) {
            // Not a transient error: retrying would hit it again. Shown at once.
            failed++;
            const e: OutboxError = { kind: "conflict", fields: err.fields };
            await db.execute("UPDATE notion_outbox SET attempts = attempts + 1, status = 'failed', last_error = ? WHERE id = ?", [
              JSON.stringify(e),
              row.id,
            ]);
            continue;
          }
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

/**
 * Retry a failed write (Integrations): back to pending with fresh attempts.
 * After a conflict, Retry means "use Nox's value anyway": the update is sent
 * over Notion's (still only title/date).
 */
export async function retryOutbox(id: number): Promise<void> {
  const db = await sqlDb();
  const [row] = await db.select<OutboxRow[]>("SELECT * FROM notion_outbox WHERE id = ? AND status = 'failed'", [id]);
  if (!row) return;
  let payload = row.payload;
  if (row.op === "update" && row.last_error && (JSON.parse(row.last_error) as OutboxError).kind === "conflict") {
    payload = JSON.stringify({ ...(JSON.parse(row.payload) as UpdatePayload), force: true });
  }
  await db.execute("UPDATE notion_outbox SET status = 'pending', attempts = 0, payload = ? WHERE id = ?", [payload, id]);
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

/** Failed Done/title/date writes by page id, for the rows on the Todos page. */
export async function failedWrites(): Promise<Map<string, OutboxError>> {
  const db = await sqlDb();
  const rows = await db.select<OutboxRow[]>(
    "SELECT * FROM notion_outbox WHERE status = 'failed' AND op IN ('set_done', 'update') ORDER BY id",
  );
  const out = new Map<string, OutboxError>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { page_id: string };
    out.set(p.page_id, r.last_error ? (JSON.parse(r.last_error) as OutboxError) : { kind: "badResponse" });
  }
  return out;
}
