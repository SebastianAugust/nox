import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import { createTodo, getTodo, useTodoDb } from "./todoRepo";
import {
  flushOutbox,
  MAX_ATTEMPTS,
  outboxStatus,
  queueCreate,
  queueSetDone,
  queueUpdate,
  applyOutboxOverlay,
  failedWrites,
  retryOutbox,
  toNotionDate,
  useOutboxTransport,
  type CreatePayload,
  type Transport,
  type UpdatePayload,
  type WriteResult,
} from "./notionOutbox";
import type { NotionRow } from "./notionMapping";

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
    async update() {
      throw new Error("not used here");
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
    expect(rows("SELECT payload FROM notion_outbox")).toEqual([{ payload: JSON.stringify({ page_id: PAGE, done: false, synced_at: null }) }]);
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

// ── Title/date updates, the conflict rule, merging ──

/**
 * A fake Notion page with state. Like Rust: a call with `syncedAt` reads the
 * page first and answers `stale` (writing nothing) when it was edited in the
 * sync's minute or later; otherwise it applies only title/date/done.
 */
function fakeNotion(start: { name: string; date: string; edited: string; done?: boolean }) {
  const page = { ...start, done: start.done ?? false };
  const fail: { kind: string }[] = [];
  const toRow = (): NotionRow => ({
    id: PAGE,
    archived: false,
    properties: {
      Name: { type: "title", title: [{ plain_text: page.name }] },
      Date: { type: "date", date: { start: page.date } },
      Done: { type: "checkbox", checkbox: page.done },
      Grade: { type: "number", number: 90 },
    },
  });
  const staleSince = (syncedAt: string | null) => {
    if (!syncedAt) return false;
    const s = new Date(syncedAt);
    s.setUTCSeconds(0, 0);
    return new Date(page.edited).getTime() >= s.getTime();
  };
  const transport: Transport = {
    async setDone(_id, done, syncedAt) {
      calls.push(`done ${done} synced=${syncedAt ?? "-"}`);
      if (fail.length) throw fail.shift();
      if (staleSince(syncedAt)) return { stale: true, written: false, row: toRow() };
      page.done = done;
      return { stale: false, written: true, row: toRow() };
    },
    async create() {
      throw new Error("not used here");
    },
    async update(p: UpdatePayload, syncedAt): Promise<WriteResult> {
      calls.push(`update ${JSON.stringify({ name: p.name, date: p.date_iso })} synced=${syncedAt ?? "-"}`);
      if (fail.length) throw fail.shift();
      if (staleSince(syncedAt)) return { stale: true, written: false, row: toRow() };
      if (p.name !== null) page.name = p.name;
      if (p.date_iso !== null) page.date = p.date_iso;
      return { stale: false, written: true, row: toRow() };
    },
  };
  return { page, fail, transport };
}

const SYNCED = "2026-11-04T10:00:30.000Z";
const local = () => rows(`SELECT name, due_date, status FROM notion_assignments WHERE notion_id = '${PAGE}'`)[0];

describe("update title and date", () => {
  beforeEach(() => {
    set("notion_write_enabled", "true");
    t.raw.exec(`UPDATE notion_assignments SET last_synced_at = '${SYNCED}'`);
  });

  it("is off while Notion writes are off, and needs something to change", async () => {
    set("notion_write_enabled", "false");
    expect(await queueUpdate(PAGE, { name: "x" })).toBe("off");
    set("notion_write_enabled", "true");
    expect(await queueUpdate(PAGE, { name: "  " })).toBe("empty");
    expect(await queueUpdate(PAGE, {})).toBe("empty");
    expect(await queueUpdate("99999999-0000-0000-0000-000000000000", { name: "x" })).toBe("missing");
    expect(rows("SELECT * FROM notion_outbox")).toEqual([]);
  });

  it("changes the local row at once and sends only the new title/date", async () => {
    const n = fakeNotion({ name: "Essay", date: "2026-11-06", edited: "2026-11-04T09:00:00.000Z" });
    useOutboxTransport(n.transport);
    expect(await queueUpdate(PAGE, { name: "Essay final", due_date: "2026-11-08" })).toBe("queued");
    expect(local()).toMatchObject({ name: "Essay final", due_date: "2026-11-08" });
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([`update {"name":"Essay final","date":"2026-11-08"} synced=${SYNCED}`]);
    expect(n.page).toMatchObject({ name: "Essay final", date: "2026-11-08" });
    expect(local()).toMatchObject({ name: "Essay final", due_date: "2026-11-08" });
  });

  it("merges updates for the same page instead of stacking them", async () => {
    await queueUpdate(PAGE, { name: "A" });
    await queueUpdate(PAGE, { due_date: "2026-11-09" });
    await queueUpdate(PAGE, { name: "B" });
    const out = rows("SELECT op, payload FROM notion_outbox");
    expect(out).toHaveLength(1);
    const p = JSON.parse(out[0].payload as string) as UpdatePayload;
    // Newest values win; the first edit's base and sync time stay.
    expect(p).toMatchObject({ name: "B", date_iso: "2026-11-09", base_name: "Essay", base_due: "2026-11-06", synced_at: SYNCED });
  });

  it("edited in Notion since the sync: refreshes the local copy first, then writes on top", async () => {
    // Bas changed the date in Notion after the sync; Nox changes the title.
    const n = fakeNotion({ name: "Essay", date: "2026-11-10", edited: "2026-11-04T10:05:00.000Z" });
    useOutboxTransport(n.transport);
    await queueUpdate(PAGE, { name: "Essay v2" });
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([
      `update {"name":"Essay v2","date":null} synced=${SYNCED}`, // read: stale, nothing written
      `update {"name":"Essay v2","date":null} synced=-`, // write on fresh data
    ]);
    // Notion's date edit survived; the title is Nox's.
    expect(n.page).toMatchObject({ name: "Essay v2", date: "2026-11-10" });
    expect(local()).toMatchObject({ name: "Essay v2", due_date: "2026-11-10" });
  });

  it("the same field changed in Notion is a conflict: Notion wins, shown, Retry applies Nox's value", async () => {
    const n = fakeNotion({ name: "Essay (Notion)", date: "2026-11-06", edited: "2026-11-04T10:05:00.000Z" });
    useOutboxTransport(n.transport);
    await queueUpdate(PAGE, { name: "Essay (Nox)" });
    expect(await flushOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(calls).toHaveLength(1); // nothing written
    expect(n.page.name).toBe("Essay (Notion)");
    expect(local()).toMatchObject({ name: "Essay (Notion)" });
    const [row] = rows("SELECT id, status, last_error FROM notion_outbox");
    expect(row).toMatchObject({ status: "failed", last_error: JSON.stringify({ kind: "conflict", fields: ["name"] }) });
    expect((await failedWrites()).get(PAGE)).toEqual({ kind: "conflict", fields: ["name"] });
    // A sync does not put Nox's value back over Notion's while it stands.
    t.raw.exec(`UPDATE notion_assignments SET name = 'Essay (Notion)'`);
    await applyOutboxOverlay();
    expect(local()).toMatchObject({ name: "Essay (Notion)" });

    await retryOutbox(row.id as number);
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(n.page.name).toBe("Essay (Nox)");
  });

  it("a 403 fails with the read-only error after the attempts, and is not reverted", async () => {
    const n = fakeNotion({ name: "Essay", date: "2026-11-06", edited: "2026-11-04T09:00:00.000Z" });
    n.fail.push(...Array.from({ length: MAX_ATTEMPTS }, () => ({ kind: "readOnly" })));
    useOutboxTransport(n.transport);
    await queueUpdate(PAGE, { due_date: "2026-11-20", due_time: "23:59" });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await flushOutbox();
    expect(rows("SELECT status, attempts, last_error FROM notion_outbox")).toEqual([
      { status: "failed", attempts: MAX_ATTEMPTS, last_error: '{"kind":"readOnly"}' },
    ]);
    expect(local()).toMatchObject({ due_date: "2026-11-20 23:59" });
    // A sync wrote Notion's old date: the overlay puts the unsaved edit back.
    t.raw.exec(`UPDATE notion_assignments SET due_date = '2026-11-06'`);
    await applyOutboxOverlay();
    expect(local()).toMatchObject({ due_date: "2026-11-20 23:59" });
    expect((await outboxStatus()).failed.map((f) => [f.op, f.title])).toEqual([["update", "Essay"]]);
  });
});

describe("Done follows the conflict rule", () => {
  beforeEach(() => {
    set("notion_write_enabled", "true");
    t.raw.exec(`UPDATE notion_assignments SET last_synced_at = '${SYNCED}'`);
  });

  it("refreshes first when the page changed in Notion, then writes Done", async () => {
    const n = fakeNotion({ name: "Essay renamed in Notion", date: "2026-11-06", edited: "2026-11-04T10:05:00.000Z" });
    useOutboxTransport(n.transport);
    await queueSetDone(PAGE, true);
    expect(await flushOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(calls).toEqual([`done true synced=${SYNCED}`, "done true synced=-"]);
    expect(n.page.done).toBe(true);
    expect(local()).toMatchObject({ name: "Essay renamed in Notion", status: "done" });
  });

  it("writes straight away when nothing changed since the sync", async () => {
    const n = fakeNotion({ name: "Essay", date: "2026-11-06", edited: "2026-11-04T09:00:00.000Z" });
    useOutboxTransport(n.transport);
    await queueSetDone(PAGE, true);
    await flushOutbox();
    expect(calls).toEqual([`done true synced=${SYNCED}`]);
  });
});
