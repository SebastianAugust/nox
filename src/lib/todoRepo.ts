import { emit } from "@tauri-apps/api/event";
import { getDb } from "./db";
import { isRepeatRule, matchName, nextDue, resolveCourse } from "./todoLogic";
import type { Priority, QuickAdd } from "./todoParse";

/**
 * Every todo read and write (lists, steps, bulk actions, Notion copies,
 * linked reminders). The schema is migration 0005. Each write announces
 * "todos:changed" so both windows refresh at once (/todo from the pet or
 * Telegram shows up on the page right away).
 *
 * Tests swap the connection for an in-memory SQLite with `useTodoDb`.
 */

// ── Connection ──

export type SqlDb = {
  select<T>(sql: string, args?: unknown[]): Promise<T>;
  execute(sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
};

let override: SqlDb | null = null;
/** Tests only: route every query to this connection (null restores the app's). */
export function useTodoDb(db: SqlDb | null) {
  override = db;
}
const conn = (): Promise<SqlDb> => (override ? Promise.resolve(override) : (getDb() as unknown as Promise<SqlDb>));
/** The connection todoRepo uses (or the test one), for modules that share its tables. */
export const sqlDb = conn;
/** True while tests run on their own connection (no event bus then). */
export const isTestDb = () => override !== null;

function changed() {
  if (override) return; // tests have no event bus
  emit("todos:changed").catch(() => {});
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The machine's local calendar day (what due dates are written in). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Types ──

export const LIST_COLORS = ["mint", "sky", "amber", "violet", "rose", "slate"] as const;
export type ListColor = (typeof LIST_COLORS)[number];
/** A fixed-size set: the default list plus a few. */
export const MAX_LISTS = 8;

export type TodoList = { id: number; name: string; color: ListColor; sort_order: number; is_default: number };

export type Todo = {
  id: number;
  title: string;
  notes: string | null;
  /** Local YYYY-MM-DD. */
  due_date: string | null;
  /** Local HH:MM. */
  due_time: string | null;
  priority: Priority;
  list_id: number | null;
  estimate_pomodoros: number;
  repeat_rule: string | null;
  sort_order: number;
  status: "pending" | "done";
  completed_at: string | null;
  course_name: string | null;
  source_notion_id: string | null;
  created_at: string;
  updated_at: string;
  context: string | null;
};

/** A todo with what its row shows: list, steps, focus sessions, reminder. */
export type TodoRecord = Todo & {
  list_name: string | null;
  list_color: ListColor | null;
  steps_total: number;
  steps_done: number;
  focus_done: number;
  /** UTC stamp of the next pending linked reminder. */
  next_reminder_at: string | null;
};

export type Subtask = { id: number; todo_id: number; title: string; done: number; sort_order: number };

/** The fields a todo can be edited by. */
export type TodoPatch = Partial<
  Pick<
    Todo,
    | "title"
    | "notes"
    | "due_date"
    | "due_time"
    | "priority"
    | "list_id"
    | "estimate_pomodoros"
    | "repeat_rule"
    | "course_name"
  >
>;

export type NewTodo = TodoPatch & { title: string; source_notion_id?: string | null; context?: string };

const EDITABLE: (keyof TodoPatch)[] = [
  "title",
  "notes",
  "due_date",
  "due_time",
  "priority",
  "list_id",
  "estimate_pomodoros",
  "repeat_rule",
  "course_name",
];

const MAX_TITLE = 300;
const MAX_NOTES = 5000;

/** Keep values inside what the columns mean. */
function clean(patch: TodoPatch): TodoPatch {
  const out: TodoPatch = { ...patch };
  if (out.title !== undefined) out.title = out.title.trim().slice(0, MAX_TITLE);
  if (out.notes !== undefined) out.notes = out.notes?.slice(0, MAX_NOTES) || null;
  if (out.due_date !== undefined) out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(out.due_date ?? "") ? out.due_date : null;
  if (out.due_time !== undefined) out.due_time = /^\d{2}:\d{2}$/.test(out.due_time ?? "") ? out.due_time : null;
  // A time means nothing without a day.
  if (out.due_date === null) out.due_time = null;
  if (out.priority !== undefined) out.priority = Math.max(0, Math.min(3, Math.round(out.priority))) as Priority;
  if (out.estimate_pomodoros !== undefined) out.estimate_pomodoros = Math.max(0, Math.min(20, Math.round(out.estimate_pomodoros)));
  if (out.repeat_rule !== undefined) out.repeat_rule = isRepeatRule(out.repeat_rule) ? out.repeat_rule : null;
  if (out.course_name !== undefined) out.course_name = out.course_name?.trim().slice(0, 120) || null;
  return out;
}

// ── Lists ──

export async function getLists(): Promise<TodoList[]> {
  const db = await conn();
  return db.select("SELECT id, name, color, sort_order, is_default FROM todo_lists ORDER BY is_default DESC, sort_order, id");
}

export async function getDefaultList(): Promise<TodoList> {
  const lists = await getLists();
  return lists.find((l) => l.is_default) ?? lists[0];
}

const okColor = (c: string): ListColor => ((LIST_COLORS as readonly string[]).includes(c) ? (c as ListColor) : "slate");

/** Add a list. Null when the set is full or the name is empty or taken. */
export async function createList(name: string, color: string): Promise<number | null> {
  const n = name.trim().replace(/^#/, "").slice(0, 40);
  const lists = await getLists();
  if (!n || lists.length >= MAX_LISTS || lists.some((l) => l.name.toLowerCase() === n.toLowerCase())) return null;
  const db = await conn();
  const r = await db.execute("INSERT INTO todo_lists (name, color, sort_order) VALUES (?, ?, ?)", [
    n,
    okColor(color),
    Math.max(0, ...lists.map((l) => l.sort_order)) + 1,
  ]);
  changed();
  return r.lastInsertId ?? null;
}

export async function renameList(id: number, name: string): Promise<boolean> {
  const n = name.trim().replace(/^#/, "").slice(0, 40);
  const lists = await getLists();
  if (!n || lists.some((l) => l.id !== id && l.name.toLowerCase() === n.toLowerCase())) return false;
  const db = await conn();
  await db.execute("UPDATE todo_lists SET name = ? WHERE id = ?", [n, id]);
  changed();
  return true;
}

export async function recolorList(id: number, color: string): Promise<void> {
  const db = await conn();
  await db.execute("UPDATE todo_lists SET color = ? WHERE id = ?", [okColor(color), id]);
  changed();
}

/** Delete a list; its todos move to the default list. The default stays. */
export async function deleteList(id: number): Promise<boolean> {
  const def = await getDefaultList();
  if (!def || def.id === id) return false;
  const db = await conn();
  await db.execute("UPDATE todos SET list_id = ? WHERE list_id = ?", [def.id, id]);
  await db.execute("DELETE FROM todo_lists WHERE id = ? AND is_default = 0", [id]);
  changed();
  return true;
}

// ── Reading todos ──

const RECORD = `
  SELECT t.id, t.title, t.notes, t.due_date, t.due_time, t.priority, t.list_id,
         t.estimate_pomodoros, t.repeat_rule, t.sort_order, t.status, t.completed_at,
         t.course_name, t.source_notion_id, t.created_at, t.updated_at, t.context,
         l.name AS list_name, l.color AS list_color,
         (SELECT COUNT(*) FROM todo_subtasks s WHERE s.todo_id = t.id) AS steps_total,
         (SELECT COUNT(*) FROM todo_subtasks s WHERE s.todo_id = t.id AND s.done = 1) AS steps_done,
         (SELECT COUNT(*) FROM pomodoro_sessions p WHERE p.todo_id = t.id AND p.completed = 1) AS focus_done,
         (SELECT MIN(r.remind_at) FROM reminders r WHERE r.todo_id = t.id AND r.status = 'pending') AS next_reminder_at
  FROM todos t LEFT JOIN todo_lists l ON l.id = t.list_id`;

/** Done todos older than the latest this many are not loaded into the page. */
export const DONE_LOADED = 300;

/** Every open todo plus the most recently finished ones. */
export async function listTodos(doneLimit = DONE_LOADED): Promise<TodoRecord[]> {
  const db = await conn();
  const [open, done] = await Promise.all([
    db.select<TodoRecord[]>(`${RECORD} WHERE t.status != 'done'`),
    db.select<TodoRecord[]>(`${RECORD} WHERE t.status = 'done' ORDER BY t.completed_at DESC, t.id DESC LIMIT ?`, [doneLimit]),
  ]);
  return [...open, ...done];
}

export async function getTodo(id: number): Promise<TodoRecord | null> {
  const db = await conn();
  const rows = await db.select<TodoRecord[]>(`${RECORD} WHERE t.id = ?`, [id]);
  return rows[0] ?? null;
}

/** Open todos in the order /todo list and /done number them. */
export async function openTodosForCommands(limit: number): Promise<Todo[]> {
  const db = await conn();
  return db.select(
    `SELECT * FROM todos WHERE status != 'done'
     ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, priority DESC, sort_order, id LIMIT ?`,
    [limit],
  );
}

// ── Writing todos ──

async function nextSortOrder(db: SqlDb): Promise<number> {
  const rows = await db.select<{ n: number | null }[]>("SELECT MAX(sort_order) AS n FROM todos");
  return (rows[0]?.n ?? 0) + 1;
}

export async function createTodo(input: NewTodo): Promise<number> {
  const c = clean(input);
  if (!c.title) throw new Error("A todo needs a title");
  const db = await conn();
  const listId = c.list_id ?? (await getDefaultList())?.id ?? null;
  const r = await db.execute(
    `INSERT INTO todos (title, notes, due_date, due_time, priority, list_id, estimate_pomodoros,
                        repeat_rule, sort_order, course_name, source_notion_id, context, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      c.title,
      c.notes ?? null,
      c.due_date ?? null,
      c.due_date ? (c.due_time ?? null) : null,
      c.priority ?? 0,
      listId,
      c.estimate_pomodoros ?? 0,
      c.repeat_rule ?? null,
      await nextSortOrder(db),
      c.course_name ?? null,
      input.source_notion_id ?? null,
      input.context ?? "personal",
    ],
  );
  changed();
  return r.lastInsertId ?? 0;
}

/** Synced Notion course names, for resolving @course. */
export async function courseNames(): Promise<string[]> {
  const db = await conn();
  const rows = await db.select<{ name: string }[]>(
    "SELECT name FROM notion_courses WHERE status != 'removed' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

/**
 * Turn parsed quick-add text into a todo: #list matched to a real list
 * (unknown names go to the default list), @course to a synced course name.
 */
export async function createFromQuickAdd(
  q: QuickAdd,
  opts: { defaultDue?: string } = {},
): Promise<{ id: number; list: TodoList; listMatched: boolean; course: string | null }> {
  const [lists, courses] = await Promise.all([getLists(), courseNames()]);
  const matched = matchName(lists, q.list);
  const list = matched ?? lists.find((l) => l.is_default) ?? lists[0];
  const course = resolveCourse(q.course, courses);
  const id = await createTodo({
    title: q.title,
    due_date: q.due_date ?? opts.defaultDue ?? null,
    due_time: q.due_time ?? null,
    priority: q.priority,
    list_id: list?.id ?? null,
    estimate_pomodoros: q.estimate ?? 0,
    repeat_rule: q.repeat ?? null,
    course_name: course,
  });
  return { id, list, listMatched: !q.list || !!matched, course };
}

export async function updateTodo(id: number, patch: TodoPatch): Promise<void> {
  const c = clean(patch);
  if (c.title === "") delete c.title; // never blank a title by accident
  const keys = EDITABLE.filter((k) => k in c);
  if (keys.length === 0) return;
  const db = await conn();
  await db.execute(
    `UPDATE todos SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    [...keys.map((k) => c[k] ?? null), id],
  );
  changed();
}

async function copySteps(db: SqlDb, from: number, to: number) {
  await db.execute(
    `INSERT INTO todo_subtasks (todo_id, title, done, sort_order)
     SELECT ?, title, 0, sort_order FROM todo_subtasks WHERE todo_id = ? ORDER BY sort_order, id`,
    [to, from],
  );
}

/** A fresh copy (steps unticked). For repeats it carries the next due date. */
async function cloneTodo(db: SqlDb, t: Todo, due: string | null): Promise<number> {
  const r = await db.execute(
    `INSERT INTO todos (title, notes, due_date, due_time, priority, list_id, estimate_pomodoros,
                        repeat_rule, sort_order, course_name, context, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      t.title,
      t.notes,
      due,
      due ? t.due_time : null,
      t.priority,
      t.list_id,
      t.estimate_pomodoros,
      t.repeat_rule,
      await nextSortOrder(db),
      t.course_name,
      t.context ?? "personal",
    ],
  );
  const id = r.lastInsertId ?? 0;
  await copySteps(db, t.id, id);
  return id;
}

async function rawTodo(db: SqlDb, id: number): Promise<Todo | null> {
  const rows = await db.select<Todo[]>("SELECT * FROM todos WHERE id = ?", [id]);
  return rows[0] ?? null;
}

/**
 * Mark done. A repeating todo spawns its next occurrence; its id comes back
 * so Undo can take it away again.
 */
export async function completeTodo(id: number, today = localToday()): Promise<{ spawnedId: number | null }> {
  const db = await conn();
  const t = await rawTodo(db, id);
  if (!t || t.status === "done") return { spawnedId: null };
  await db.execute(
    "UPDATE todos SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [id],
  );
  let spawnedId: number | null = null;
  if (isRepeatRule(t.repeat_rule)) spawnedId = await cloneTodo(db, t, nextDue(t.due_date, t.repeat_rule, today));
  changed();
  return { spawnedId };
}

/** Back to open (Undo, or unticking). Removes the occurrence a completion spawned. */
export async function reopenTodo(id: number, spawnedId?: number | null): Promise<void> {
  const db = await conn();
  await db.execute(
    "UPDATE todos SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
    [id],
  );
  if (spawnedId) await db.execute("DELETE FROM todos WHERE id = ? AND status = 'pending'", [spawnedId]);
  changed();
}

export async function duplicateTodo(id: number): Promise<number | null> {
  const db = await conn();
  const t = await rawTodo(db, id);
  if (!t) return null;
  const copy = await cloneTodo(db, t, t.due_date);
  changed();
  return copy;
}

/**
 * Delete for good. Steps go with it (trigger); linked reminders are kept but
 * unlinked, and focus sessions stay in the history.
 */
export async function deleteTodo(id: number): Promise<void> {
  const db = await conn();
  await db.execute("UPDATE reminders SET todo_id = NULL WHERE todo_id = ?", [id]);
  await db.execute("UPDATE pomodoro_sessions SET todo_id = NULL WHERE todo_id = ?", [id]);
  await db.execute("DELETE FROM todos WHERE id = ?", [id]);
  changed();
}

// ── Bulk ──

export async function bulkComplete(ids: number[], today = localToday()): Promise<{ id: number; spawnedId: number | null }[]> {
  const out = [];
  for (const id of ids) out.push({ id, ...(await completeTodo(id, today)) });
  return out;
}

async function bulkUpdate(ids: number[], patch: TodoPatch) {
  for (const id of ids) await updateTodo(id, patch);
}

export const bulkSetDue = (ids: number[], due: string | null) =>
  bulkUpdate(ids, due ? { due_date: due } : { due_date: null, due_time: null });
export const bulkSetPriority = (ids: number[], priority: Priority) => bulkUpdate(ids, { priority });
export const bulkMoveToList = (ids: number[], listId: number) => bulkUpdate(ids, { list_id: listId });

export async function bulkDelete(ids: number[]): Promise<void> {
  for (const id of ids) await deleteTodo(id);
}

// ── Steps ──

export async function getSubtasks(todoId: number): Promise<Subtask[]> {
  const db = await conn();
  return db.select("SELECT * FROM todo_subtasks WHERE todo_id = ? ORDER BY sort_order, id", [todoId]);
}

export async function addSubtask(todoId: number, title: string): Promise<number | null> {
  const tt = title.trim().slice(0, 200);
  if (!tt) return null;
  const db = await conn();
  const rows = await db.select<{ n: number | null }[]>("SELECT MAX(sort_order) AS n FROM todo_subtasks WHERE todo_id = ?", [todoId]);
  const r = await db.execute("INSERT INTO todo_subtasks (todo_id, title, sort_order) VALUES (?, ?, ?)", [
    todoId,
    tt,
    (rows[0]?.n ?? 0) + 1,
  ]);
  changed();
  return r.lastInsertId ?? null;
}

export async function setSubtaskDone(id: number, done: boolean): Promise<void> {
  const db = await conn();
  await db.execute("UPDATE todo_subtasks SET done = ? WHERE id = ?", [done ? 1 : 0, id]);
  changed();
}

export async function renameSubtask(id: number, title: string): Promise<void> {
  const tt = title.trim().slice(0, 200);
  if (!tt) return;
  const db = await conn();
  await db.execute("UPDATE todo_subtasks SET title = ? WHERE id = ?", [tt, id]);
  changed();
}

export async function deleteSubtask(id: number): Promise<void> {
  const db = await conn();
  await db.execute("DELETE FROM todo_subtasks WHERE id = ?", [id]);
  changed();
}

/** Move a step up (-1) or down (1) among its siblings. */
export async function moveSubtask(id: number, direction: -1 | 1): Promise<void> {
  const db = await conn();
  const [me] = await db.select<Subtask[]>("SELECT * FROM todo_subtasks WHERE id = ?", [id]);
  if (!me) return;
  const steps = await getSubtasks(me.todo_id);
  const i = steps.findIndex((s) => s.id === id);
  const other = steps[i + direction];
  if (!other) return;
  // Renumber so equal sort_orders cannot make the swap a no-op.
  const order = steps.map((s) => s.id);
  [order[i], order[i + direction]] = [order[i + direction], order[i]];
  for (let k = 0; k < order.length; k++) {
    await db.execute("UPDATE todo_subtasks SET sort_order = ? WHERE id = ?", [k + 1, order[k]]);
  }
  changed();
}

// ── Notion copies ──

/** Notion assignments already copied into todos (their notion ids). */
export async function copiedNotionIds(): Promise<Map<string, number>> {
  const db = await conn();
  const rows = await db.select<{ id: number; source_notion_id: string }[]>(
    "SELECT id, source_notion_id FROM todos WHERE source_notion_id IS NOT NULL",
  );
  return new Map(rows.map((r) => [r.source_notion_id, r.id]));
}

/**
 * "Add to my todos" for a Notion assignment. Copies once: a second call
 * returns the existing copy (the unique index on source_notion_id backs
 * this up even if two windows race). Notion itself is never written to.
 */
export async function copyFromNotion(a: {
  notion_id: string;
  name: string;
  due_date: string | null;
  course: string | null;
}): Promise<{ id: number; created: boolean }> {
  const existing = (await copiedNotionIds()).get(a.notion_id);
  if (existing) return { id: existing, created: false };
  try {
    const id = await createTodo({
      title: a.name,
      due_date: a.due_date?.slice(0, 10) ?? null,
      due_time: a.due_date && a.due_date.length >= 16 ? a.due_date.slice(11, 16) : null,
      course_name: a.course,
      source_notion_id: a.notion_id,
    });
    return { id, created: true };
  } catch (err) {
    const again = (await copiedNotionIds()).get(a.notion_id);
    if (again) return { id: again, created: false };
    throw err;
  }
}

// ── Linked reminders ──

export type TodoReminder = { id: number; remind_at: string; status: string };

/** "Remind me": a row in the reminders table linked to the todo. */
export async function addTodoReminder(todoId: number, title: string, remindAtUtc: string): Promise<number> {
  const db = await conn();
  const r = await db.execute("INSERT INTO reminders (title, remind_at, todo_id) VALUES (?, ?, ?)", [
    title.slice(0, MAX_TITLE),
    remindAtUtc,
    todoId,
  ]);
  changed();
  return r.lastInsertId ?? 0;
}

export async function getTodoReminders(todoId: number): Promise<TodoReminder[]> {
  const db = await conn();
  return db.select("SELECT id, remind_at, status FROM reminders WHERE todo_id = ? ORDER BY remind_at", [todoId]);
}

// ── Dev only ──

/**
 * Generate `n` todos for checking that a long list stays smooth. Not in the
 * UI; in a dev build it is reachable as `window.__noxSeedTodos(500)`.
 */
export async function seedDemoTodos(n: number, today = localToday()): Promise<void> {
  const lists = await getLists();
  const words = ["laporan", "baca", "beli", "kirim", "revisi", "rapat", "cuci", "bayar", "email", "latihan"];
  const things = ["jurnal", "makan", "proposal", "desain", "kos", "baju", "dosen", "modul", "slide", "kabel"];
  for (let i = 0; i < n; i++) {
    const offset = (i % 21) - 6;
    await createTodo({
      title: `${words[i % words.length]} ${things[(i * 7) % things.length]} ${i + 1}`,
      due_date: i % 5 === 0 ? null : nextDueOffset(today, offset),
      due_time: i % 3 === 0 ? `${pad(8 + (i % 12))}:00` : null,
      priority: (i % 4) as Priority,
      list_id: lists[i % lists.length]?.id ?? null,
      estimate_pomodoros: i % 4,
    });
  }
}

function nextDueOffset(today: string, offset: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(y, m - 1, d + offset);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
