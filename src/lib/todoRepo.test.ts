import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import {
  addSubtask,
  addTodoReminder,
  bulkComplete,
  bulkDelete,
  bulkMoveToList,
  bulkSetDue,
  bulkSetPriority,
  completeTodo,
  copiedNotionIds,
  copyFromNotion,
  createFromQuickAdd,
  createList,
  createTodo,
  deleteList,
  deleteTodo,
  duplicateTodo,
  getDefaultList,
  getLists,
  getSubtasks,
  getTodo,
  listTodos,
  moveSubtask,
  renameList,
  reopenTodo,
  setSubtaskDone,
  updateTodo,
  useTodoDb,
} from "./todoRepo";
import { parseQuickAdd } from "./todoParse";

const TODAY = "2026-11-03";
let t: ReturnType<typeof openTestDb>;

beforeEach(() => {
  t = openTestDb();
  useTodoDb(t.db);
});
afterEach(() => useTodoDb(null));

const count = (sql: string) => (t.raw.prepare(sql).get() as { n: number }).n;

describe("migration 0005 backfill", () => {
  it("keeps existing todos and fills the new columns", () => {
    const old = openTestDb(4);
    old.raw.exec(`
      INSERT INTO todos (title, due_date, status, updated_at) VALUES
        ('plain', NULL, 'pending', '2026-10-01 10:00:00'),
        ('dated', '2026-11-05', 'pending', '2026-10-01 10:00:00'),
        ('timed', '2026-11-05 18:30', 'pending', '2026-10-01 10:00:00'),
        ('blank date', '', 'pending', '2026-10-01 10:00:00'),
        ('finished', '2026-10-30', 'done', '2026-10-31 09:00:00');
    `);
    old.migrate(5, 5);
    const rows = old.raw
      .prepare("SELECT title, due_date, due_time, list_id, priority, completed_at, sort_order FROM todos ORDER BY id")
      .all();
    const def = old.raw.prepare("SELECT id, name FROM todo_lists WHERE is_default = 1").get() as { id: number; name: string };
    expect(def.name).toBe("Personal");
    expect(rows).toEqual([
      { title: "plain", due_date: null, due_time: null, list_id: def.id, priority: 0, completed_at: null, sort_order: 1 },
      { title: "dated", due_date: "2026-11-05", due_time: null, list_id: def.id, priority: 0, completed_at: null, sort_order: 2 },
      { title: "timed", due_date: "2026-11-05", due_time: "18:30", list_id: def.id, priority: 0, completed_at: null, sort_order: 3 },
      { title: "blank date", due_date: null, due_time: null, list_id: def.id, priority: 0, completed_at: null, sort_order: 4 },
      {
        title: "finished",
        due_date: "2026-10-30",
        due_time: null,
        list_id: def.id,
        priority: 0,
        completed_at: "2026-10-31 09:00:00",
        sort_order: 5,
      },
    ]);
  });
});

describe("create and update", () => {
  it("creates a todo in the default list with its fields", async () => {
    const id = await createTodo({ title: "  laporan  ", due_date: TODAY, due_time: "18:30", priority: 3, estimate_pomodoros: 2 });
    const todo = await getTodo(id);
    expect(todo).toMatchObject({
      title: "laporan",
      due_date: TODAY,
      due_time: "18:30",
      priority: 3,
      estimate_pomodoros: 2,
      status: "pending",
      list_name: "Personal",
      steps_total: 0,
      focus_done: 0,
      next_reminder_at: null,
    });
  });

  it("refuses an empty title and cleans bad values", async () => {
    await expect(createTodo({ title: "   " })).rejects.toThrow();
    const id = await createTodo({ title: "x", due_date: "soon", due_time: "18:30", priority: 9 as never, repeat_rule: "yearly" });
    expect(await getTodo(id)).toMatchObject({ due_date: null, due_time: null, priority: 3, repeat_rule: null });
  });

  it("updates only editable fields, and clearing the date clears the time", async () => {
    const id = await createTodo({ title: "x", due_date: TODAY, due_time: "09:00" });
    await updateTodo(id, { notes: "bring laptop", course_name: "Jarkom", priority: 2 });
    await updateTodo(id, { due_date: null });
    await updateTodo(id, { title: "" }); // ignored, not blanked
    expect(await getTodo(id)).toMatchObject({
      title: "x",
      notes: "bring laptop",
      course_name: "Jarkom",
      priority: 2,
      due_date: null,
      due_time: null,
    });
  });

  it("creates from quick add, matching #list and @course", async () => {
    const kuliah = await createList("Kuliah", "sky");
    t.raw.exec("INSERT INTO notion_courses (notion_id, name) VALUES ('c1', 'Robotika Dasar')");
    const q = parseQuickAdd("laporan besok 18:30 !high #kuliah @robotika ~3p", new Date(2026, 10, 3, 9));
    const r = await createFromQuickAdd(q);
    expect(r.listMatched).toBe(true);
    expect(await getTodo(r.id)).toMatchObject({
      title: "laporan",
      due_date: "2026-11-04",
      due_time: "18:30",
      priority: 3,
      list_id: kuliah,
      course_name: "Robotika Dasar",
      estimate_pomodoros: 3,
    });
    const unknown = await createFromQuickAdd(parseQuickAdd("x #magang"));
    expect(unknown.listMatched).toBe(false);
    expect(unknown.list.name).toBe("Personal");
  });
});

describe("complete, undo and repeat", () => {
  it("completes and reopens (undo)", async () => {
    const id = await createTodo({ title: "x" });
    expect(await completeTodo(id, TODAY)).toEqual({ spawnedId: null });
    expect((await getTodo(id))?.status).toBe("done");
    expect((await getTodo(id))?.completed_at).not.toBeNull();
    await reopenTodo(id);
    expect(await getTodo(id)).toMatchObject({ status: "pending", completed_at: null });
  });

  it("spawns the next occurrence of a repeating todo, with fresh steps", async () => {
    const id = await createTodo({ title: "bayar kos", due_date: "2026-11-01", due_time: "10:00", repeat_rule: "weekly", priority: 2 });
    const step = await addSubtask(id, "transfer");
    await setSubtaskDone(step!, true);
    const { spawnedId } = await completeTodo(id, TODAY);
    expect(spawnedId).not.toBeNull();
    expect(await getTodo(spawnedId!)).toMatchObject({
      title: "bayar kos",
      status: "pending",
      due_date: "2026-11-08",
      due_time: "10:00",
      repeat_rule: "weekly",
      priority: 2,
      steps_total: 1,
      steps_done: 0,
    });
    // Completing twice does not spawn twice.
    expect(await completeTodo(id, TODAY)).toEqual({ spawnedId: null });
  });

  it("undo of a repeating completion removes the spawned occurrence", async () => {
    const id = await createTodo({ title: "standup", due_date: TODAY, repeat_rule: "daily" });
    const { spawnedId } = await completeTodo(id, TODAY);
    await reopenTodo(id, spawnedId);
    expect(await getTodo(spawnedId!)).toBeNull();
    expect((await listTodos()).map((x) => x.title)).toEqual(["standup"]);
  });
});

describe("steps", () => {
  it("adds, ticks, reorders and counts steps", async () => {
    const id = await createTodo({ title: "x" });
    const a = await addSubtask(id, "a");
    const b = await addSubtask(id, "b");
    await addSubtask(id, "c");
    expect(await addSubtask(id, "  ")).toBeNull();
    await setSubtaskDone(a!, true);
    await moveSubtask(b!, -1);
    expect((await getSubtasks(id)).map((s) => s.title)).toEqual(["b", "a", "c"]);
    expect(await getTodo(id)).toMatchObject({ steps_total: 3, steps_done: 1 });
  });

  it("cascades: deleting a todo deletes its steps", async () => {
    const id = await createTodo({ title: "x" });
    await addSubtask(id, "a");
    await addSubtask(id, "b");
    const other = await createTodo({ title: "y" });
    await addSubtask(other, "keep");
    await deleteTodo(id);
    expect(count("SELECT COUNT(*) AS n FROM todo_subtasks")).toBe(1);
  });

  it("deleting a todo keeps its reminders, unlinked", async () => {
    const id = await createTodo({ title: "x" });
    await addTodoReminder(id, "x", "2026-11-03 10:00:00");
    expect((await getTodo(id))?.next_reminder_at).toBe("2026-11-03 10:00:00");
    await deleteTodo(id);
    expect(t.raw.prepare("SELECT todo_id FROM reminders").all()).toEqual([{ todo_id: null }]);
  });

  it("duplicates a todo with its steps", async () => {
    const id = await createTodo({ title: "x", priority: 1 });
    await addSubtask(id, "a");
    const copy = await duplicateTodo(id);
    expect(await getTodo(copy!)).toMatchObject({ title: "x", priority: 1, steps_total: 1 });
  });
});

describe("bulk actions", () => {
  it("completes, re-dates, re-prioritises, moves and deletes several at once", async () => {
    const ids = [await createTodo({ title: "a" }), await createTodo({ title: "b", repeat_rule: "daily" }), await createTodo({ title: "c" })];
    const list = await createList("Kuliah", "sky");
    await bulkSetDue(ids, TODAY);
    await bulkSetPriority(ids, 3);
    await bulkMoveToList(ids, list!);
    let rows = await listTodos();
    expect(rows.every((r) => r.due_date === TODAY && r.priority === 3 && r.list_id === list)).toBe(true);

    const done = await bulkComplete(ids.slice(0, 2), TODAY);
    expect(done.filter((d) => d.spawnedId).length).toBe(1); // only "b" repeats
    rows = await listTodos();
    expect(rows.filter((r) => r.status === "done").map((r) => r.title).sort()).toEqual(["a", "b"]);

    await bulkSetDue([ids[2]], null);
    expect((await getTodo(ids[2]))?.due_date).toBeNull();

    await bulkDelete(ids);
    expect((await listTodos()).map((r) => r.title)).toEqual(["b"]); // the spawned occurrence
  });
});

describe("lists", () => {
  it("adds, renames and refuses duplicates; the set is small", async () => {
    const id = await createList("Kuliah", "sky");
    expect(await createList("kuliah", "rose")).toBeNull();
    expect(await renameList(id!, "Kampus")).toBe(true);
    expect(await renameList(id!, "personal")).toBe(false);
    for (let i = 0; i < 10; i++) await createList(`L${i}`, "slate");
    expect((await getLists()).length).toBe(8);
  });

  it("moves todos to the default list when their list is deleted", async () => {
    const list = await createList("Magang", "mint");
    const id = await createTodo({ title: "revisi", list_id: list! });
    expect(await deleteList(list!)).toBe(true);
    const def = await getDefaultList();
    expect((await getTodo(id))?.list_id).toBe(def.id);
    expect(await deleteList(def.id)).toBe(false);
  });
});

describe("Notion copies", () => {
  const a = { notion_id: "n-1", name: "Quiz Etprof", due_date: "2026-11-05 09:00", course: "Etprof" };

  it("copies an assignment once; a second click returns the same todo", async () => {
    const first = await copyFromNotion(a);
    const second = await copyFromNotion(a);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await getTodo(first.id)).toMatchObject({
      title: "Quiz Etprof",
      due_date: "2026-11-05",
      due_time: "09:00",
      course_name: "Etprof",
      source_notion_id: "n-1",
    });
    expect([...(await copiedNotionIds()).keys()]).toEqual(["n-1"]);
  });

  it("is backed by a unique index", async () => {
    await createTodo({ title: "a", source_notion_id: "n-2" });
    await expect(createTodo({ title: "b", source_notion_id: "n-2" })).rejects.toThrow();
  });

  it("duplicating a copy does not carry the Notion link", async () => {
    const { id } = await copyFromNotion(a);
    const copy = await duplicateTodo(id);
    expect((await getTodo(copy!))?.source_notion_id).toBeNull();
  });
});

describe("focus sessions per todo", () => {
  it("counts completed sessions linked to the todo", async () => {
    const id = await createTodo({ title: "x", estimate_pomodoros: 3 });
    t.raw.exec(`
      INSERT INTO pomodoro_sessions (started_at, completed, todo_id) VALUES
        ('2026-11-03 01:00:00', 1, ${id}), ('2026-11-03 02:00:00', 0, ${id}), ('2026-11-03 03:00:00', 1, NULL);
    `);
    expect((await getTodo(id))?.focus_done).toBe(1);
  });
});
