import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import { createTodo, getTodo, useTodoDb } from "./todoRepo";
import {
  flushOutbox,
  MAX_ATTEMPTS,
  outboxStatus,
  queueCreate,
  queueSetDone,
  retryOutbox,
  toNotionDate,
  useOutboxTransport,
  type CreatePayload,
  type Transport,
} from "./notionOutbox";

const PAGE = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const NEW_PAGE = "99999999-8888-7777-6666-555555555555";
const DB = "aaaaaaaabbbbccccddddeeeeeeeeeeee";

let t: ReturnType<typeof openTestDb>;
let calls: string[];

/** A mocked Notion: records calls; `fail` makes the next N calls throw. */
function mockTransport(opts: { fail?: { kind: string }[]; existed?: boolean } = {}): Transport {
  const failures = [...(opts.fail ?? [])];
  return {
    async setDone(pageId, done) {
      calls.push(`done ${pageId} ${done}`);
      if (failures.length) throw failures.shift();
    },
    async create(p: CreatePayload, since) {
      calls.push(`create ${p.name} since=${since ?? "-"}`);
      if (failures.length) throw failures.shift();
      return { pageId: NEW_PAGE, existed: !!opts.existed };
    },
  };
}

const set = (key: string, value: string) =>
  t.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
const rows = (sql: string) => t.raw.prepare(sql).all() as Record<string, unknown>[];

beforeEach(() => {
  t = openTestDb();
  useTodoDb(t.db);
  calls = [];
  set("notion_assignments_db_id", DB);
  t.raw.exec(`
    INSERT INTO notion_assignments (notion_id, name, due_date, status) VALUES ('${PAGE}', 'Essay', '2026-11-06', 'pending');
    INSERT INTO notion_courses (notion_id, name) VALUES ('11111111-2222-3333-4444-555555555555', 'Metodologi Penelitian');
  `);
});
afterEach(() => {
  useTodoDb(null);
  useOutboxTransport(null);
});

describe("gating", () => {
  it("writes nothing while Notion writes are off (the default)", async () => {
    expect(rows("SELECT value FROM settings WHERE key = 'notion_write_enabled'")).toEqual([{ value: "false" }]);
    useOutboxTransport(mockTransport());
    expect(await queueSetDone(PAGE, true)).toBe("off");
    expect((await queueCreate({ name: "x" })).result).toBe("off");
    await flushOutbox();
    expect(calls).toEqual([]);
    expect(rows("SELECT * FROM notion_outbox")).toEqual([]);
    expect(rows("SELECT status FROM notion_assignments")).toEqual([{ status: "pending" }]);
  });

  it("holds queued writes (without counting) if writes are switched off later", async () => {
    set("notion_write_enabled", "true");
    await queueSetDone(PAGE, true);
    set("notion_write_enabled", "false");
    useOutboxTransport(mockTransport());
    await flushOutbox();
    expect(calls).toEqual([]);
    expect(rows("SELECT status, attempts FROM notion_outbox")).toEqual([{ status: "pending", attempts: 0 }]);
  });
});

describe("set done", () => {
  beforeEach(() => set("notion_write_enabled", "true"));

  it("updates the local row at once and sends one write", async () => {
    useOutboxTransport(mockTransport());
    expect(await queueSetDone(PAGE, true)).toBe("queued");
    expect(rows("SELECT status FROM notion_assignments")).toEqual([{ status: "done" }]);
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([`done ${PAGE} true`]);
    expect(rows("SELECT status FROM notion_outbox")).toEqual([{ status: "sent" }]);
  });

  it("does not double a write for the same page (undo before it went out)", async () => {
    await queueSetDone(PAGE, true);
    await queueSetDone(PAGE, false);
    expect(rows("SELECT payload FROM notion_outbox")).toEqual([{ payload: JSON.stringify({ page_id: PAGE, done: false }) }]);
  });

  it("retries up to the limit, then keeps it as failed (not reverted), and Retry resets it", async () => {
    useOutboxTransport(mockTransport({ fail: Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "offline" })) }));
    await queueSetDone(PAGE, true);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(await flushOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(await flushOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(rows("SELECT status, attempts FROM notion_outbox")).toEqual([{ status: "failed", attempts: MAX_ATTEMPTS }]);
    expect(rows("SELECT status FROM notion_assignments")).toEqual([{ status: "done" }]);
    const st = await outboxStatus();
    expect(st.failed.map((f) => [f.title, JSON.parse(f.last_error!).kind])).toEqual([["Essay", "offline"]]);

    await flushOutbox(); // failed rows are not retried on their own
    expect(calls.length).toBe(MAX_ATTEMPTS);
    await retryOutbox(st.failed[0].id);
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
  });
});

describe("create", () => {
  beforeEach(() => set("notion_write_enabled", "true"));

  it("matches the course by name and mirrors the new page so a sync does not duplicate it", async () => {
    useOutboxTransport(mockTransport());
    const todo = await createTodo({ title: "laporan test", due_date: "2026-11-06" });
    const q = await queueCreate({ name: "laporan test", due_date: "2026-11-06", course: "metodologi", todo_id: todo });
    expect(q).toEqual({ result: "queued", courseMatched: true, course: "Metodologi Penelitian" });
    await flushOutbox();
    expect(calls).toEqual(["create laporan test since=-"]);
    expect((await getTodo(todo))?.source_notion_id).toBe(NEW_PAGE);
    expect(rows(`SELECT name, course, status FROM notion_assignments WHERE notion_id = '${NEW_PAGE}'`)).toEqual([
      { name: "laporan test", course: "Metodologi Penelitian", status: "pending" },
    ]);
    // What the sync does with the page it now finds in Notion: an upsert by id.
    t.raw.exec(`INSERT INTO notion_assignments (notion_id, name, status) VALUES ('${NEW_PAGE}', 'laporan test', 'pending')
                ON CONFLICT(notion_id) DO UPDATE SET name = excluded.name`);
    expect(rows("SELECT COUNT(*) AS n FROM notion_assignments WHERE name = 'laporan test'")).toEqual([{ n: 1 }]);
  });

  it("leaves the course empty and says so when no synced course matches", async () => {
    const q = await queueCreate({ name: "x", course: "astronomi" });
    expect(q).toMatchObject({ result: "queued", courseMatched: false });
    const [row] = rows("SELECT payload FROM notion_outbox");
    expect(JSON.parse(row.payload as string)).toMatchObject({ course_page_id: null });
  });

  it("refuses to send a linked or already queued todo twice", async () => {
    const todo = await createTodo({ title: "x" });
    expect((await queueCreate({ name: "x", todo_id: todo })).result).toBe("queued");
    expect((await queueCreate({ name: "x", todo_id: todo })).result).toBe("linked");
    const linked = await createTodo({ title: "y", source_notion_id: PAGE });
    expect((await queueCreate({ name: "y", todo_id: linked })).result).toBe("linked");
  });

  it("after an uncertain attempt, the retry looks for the page instead of creating blindly", async () => {
    useOutboxTransport(mockTransport({ fail: [{ kind: "timeout" }], existed: true }));
    await queueCreate({ name: "x" });
    await flushOutbox();
    expect(calls).toEqual(["create x since=-"]);
    expect(rows("SELECT uncertain_since IS NOT NULL AS u FROM notion_outbox")).toEqual([{ u: 1 }]);
    await flushOutbox();
    expect(calls[1]).toMatch(/^create x since=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(rows("SELECT status FROM notion_outbox")).toEqual([{ status: "sent" }]);
    expect(rows(`SELECT COUNT(*) AS n FROM notion_assignments WHERE notion_id = '${NEW_PAGE}'`)).toEqual([{ n: 1 }]);
  });

  it("a plain refusal (403) is not treated as uncertain", async () => {
    useOutboxTransport(mockTransport({ fail: [{ kind: "readOnly" }] }));
    await queueCreate({ name: "x" });
    await flushOutbox();
    expect(rows("SELECT uncertain_since, attempts, last_error FROM notion_outbox")).toEqual([
      { uncertain_since: null, attempts: 1, last_error: '{"kind":"readOnly"}' },
    ]);
  });

  it("needs a title and a configured database", async () => {
    expect((await queueCreate({ name: "  " })).result).toBe("empty");
    set("notion_assignments_db_id", "");
    expect((await queueCreate({ name: "x" })).result).toBe("notConfigured");
  });
});

describe("dates for Notion", () => {
  it("keeps a bare date and adds the local offset to a timed one", () => {
    expect(toNotionDate("2026-11-06", null)).toBe("2026-11-06");
    expect(toNotionDate("2026-11-06", "18:30")).toMatch(/^2026-11-06T18:30:00[+-]\d{2}:\d{2}$/);
    expect(toNotionDate("soon", "18:30")).toBeNull();
  });
});
