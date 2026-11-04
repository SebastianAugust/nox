import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getDb, getSettings } from "./db";
import { setSetting } from "./db-helpers";
import { asApiError, secretExists, type ApiError } from "./api";
import { applyOutboxOverlay, flushOutbox } from "./notionOutbox";
import {
  mapAssignment,
  mapCourse,
  resolveMapping,
  schemaOf,
  type MappingProblem,
  type NotionRow,
} from "./notionMapping";

/**
 * Read-only Notion sync, run by the pet window (the one always-alive window):
 * on start, every 30 minutes, and when the dashboard asks ("notion:sync").
 *
 * Rows are upserted by `notion_id`. A row that disappeared upstream (deleted,
 * archived, or no longer in the database) is marked `removed`, one that is
 * completed upstream `done`; nothing is hard-deleted. A failed sync, offline
 * or not, changes nothing, so the last good data stays visible.
 *
 * Status for the dashboard lives in settings and is announced with
 * "notion:status": notion_last_sync_at (UTC), notion_last_error (JSON).
 */

const INTERVAL_MS = 30 * 60 * 1000;

export type SyncError =
  | { kind: "notConfigured" }
  | { kind: "api"; error: ApiError; which: "assignments" | "courses" }
  | { kind: "mapping"; problems: MappingProblem[] };

export const MAP_KEYS = {
  title: "notion_map_title",
  due: "notion_map_due",
  course: "notion_map_course",
  status: "notion_map_status",
  done: "notion_map_done",
} as const;

const SETTING_KEYS = ["notion_assignments_db_id", "notion_courses_db_id", ...Object.values(MAP_KEYS)];

class SyncFailure extends Error {
  constructor(readonly detail: SyncError) {
    super(detail.kind);
  }
}

async function fetchRows(dbId: string, which: "assignments" | "courses"): Promise<NotionRow[]> {
  try {
    return await invoke<NotionRow[]>("notion_query_database", { databaseId: dbId });
  } catch (err) {
    throw new SyncFailure({ kind: "api", error: asApiError(err), which });
  }
}

async function syncCourses(dbId: string, stamp: string): Promise<void> {
  const rows = await fetchRows(dbId, "courses");
  const db = await getDb();
  for (const row of rows) {
    const c = mapCourse(row);
    if (!c || row.archived) continue;
    await db.execute(
      `INSERT INTO notion_courses (notion_id, name, semester, notion_status, status, synced_at, last_synced_at)
       VALUES (?, ?, ?, ?, 'in_progress', datetime('now'), ?)
       ON CONFLICT(notion_id) DO UPDATE SET
         name = excluded.name, semester = excluded.semester, notion_status = excluded.notion_status,
         status = 'in_progress', synced_at = excluded.synced_at, last_synced_at = excluded.last_synced_at`,
      [c.notion_id, c.name, c.semester, c.status, stamp],
    );
  }
  await db.execute(
    "UPDATE notion_courses SET status = 'removed' WHERE last_synced_at IS NOT ? OR last_synced_at IS NULL",
    [stamp],
  );
}

async function courseNames(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ notion_id: string; name: string }[]>(
    "SELECT notion_id, name FROM notion_courses WHERE status != 'removed'",
  );
  return new Map(rows.map((r) => [r.notion_id, r.name]));
}

async function syncAssignments(dbId: string, stamp: string, config: Record<string, string>): Promise<void> {
  const rows = await fetchRows(dbId, "assignments");
  const db = await getDb();

  if (rows.length > 0) {
    const result = resolveMapping(schemaOf(rows), {
      title: config[MAP_KEYS.title],
      due: config[MAP_KEYS.due],
      course: config[MAP_KEYS.course],
      status: config[MAP_KEYS.status],
      done: config[MAP_KEYS.done],
    });
    if (!result.ok) throw new SyncFailure({ kind: "mapping", problems: result.problems });

    const names = await courseNames();
    for (const row of rows) {
      const a = mapAssignment(row, result.mapping, names);
      if (!a.name) continue;
      const status = a.archived ? "removed" : a.done ? "done" : "pending";
      await db.execute(
        `INSERT INTO notion_assignments
           (notion_id, name, due_date, course, course_notion_id, notion_status, status, synced_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(notion_id) DO UPDATE SET
           name = excluded.name, due_date = excluded.due_date, course = excluded.course,
           course_notion_id = excluded.course_notion_id, notion_status = excluded.notion_status,
           status = excluded.status, synced_at = excluded.synced_at,
           last_synced_at = excluded.last_synced_at`,
        [a.notion_id, a.name, a.due_date, a.course, a.course_notion_id, a.notion_status, status, stamp],
      );
    }
  }
  // Only reached after a complete fetch (and mapping): whatever was not in it
  // is gone upstream.
  await db.execute(
    "UPDATE notion_assignments SET status = 'removed' WHERE last_synced_at IS NOT ? OR last_synced_at IS NULL",
    [stamp],
  );
}

let running: Promise<void> | null = null;

/** Run one sync now (or join the one already running). Never throws. */
export function syncNotion(): Promise<void> {
  running ??= (async () => {
    let error: SyncError | null = null;
    try {
      const config = await getSettings(SETTING_KEYS);
      const assignmentsDb = config.notion_assignments_db_id?.trim();
      if (!assignmentsDb || !(await secretExists("notion_token"))) {
        throw new SyncFailure({ kind: "notConfigured" });
      }
      // A unique stamp for this run marks every row it saw.
      const stamp = new Date().toISOString();
      const coursesDb = config.notion_courses_db_id?.trim();
      if (coursesDb) await syncCourses(coursesDb, stamp);
      await syncAssignments(assignmentsDb, stamp, config);
      // Edits still on their way to Notion (or failed) stay visible locally.
      await applyOutboxOverlay();
      await setSetting("notion_last_sync_at", stamp.slice(0, 19).replace("T", " "));
    } catch (err) {
      error = err instanceof SyncFailure ? err.detail : { kind: "api", error: asApiError(err), which: "assignments" };
      if (!(err instanceof SyncFailure)) console.error(err);
    }
    await setSetting("notion_last_error", error ? JSON.stringify(error) : "").catch(console.error);
    await emit("notion:status").catch(console.error);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Read the stored error back (for the Integrations page). */
export function parseSyncError(raw: string | null | undefined): SyncError | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncError;
  } catch {
    return null;
  }
}

/**
 * Start syncing in the pet window. `onSynced` runs after every attempt (the
 * nudge check hooks in there). Returns a stop function.
 */
export function startNotionSync(onSynced: () => void): () => void {
  // Queued Notion writes go out after every sync (and so on app start).
  const run = () => void syncNotion().then(flushOutbox).then(onSynced);
  run();
  const timer = setInterval(run, INTERVAL_MS);
  const unlisteners = [
    listen("notion:sync", run),
    // A write was just queued (any window): send it now.
    listen("notion:outbox", () => void flushOutbox()),
    listen<{ name?: string }>("secrets:changed", ({ payload }) => {
      if (payload?.name === "notion_token") run();
    }),
  ];
  return () => {
    clearInterval(timer);
    for (const u of unlisteners) u.then((off) => off()).catch(console.error);
  };
}
