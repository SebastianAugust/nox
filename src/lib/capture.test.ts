import { describe, expect, it } from "vitest";
import fixtures from "./capture.fixtures.json";
import {
  extractIntent,
  fallbackProposal,
  mayBeTask,
  proposalAsQuickAdd,
  validateExtraction,
  validateSteps,
  type ModelCall,
  type Proposal,
} from "./captureCore";
import { parseQuickAdd } from "./todoParse";

// Wednesday 4 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 4, 10, 0);
const pad = (n: number) => String(n).padStart(2, "0");
const day = (offset: number) => {
  const d = new Date(2026, 10, 4 + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dueOf = (due: string | null | undefined) =>
  due === undefined || due === null ? undefined : due === "today" ? day(0) : due === "tomorrow" ? day(1) : due.startsWith("+") ? day(Number(due.slice(1))) : due;

type Case = {
  text: string;
  expect: {
    intent: string;
    title?: string;
    due?: string | null;
    time?: string;
    end?: string;
    location?: string;
    priority?: number;
    list?: string;
    course?: string;
  };
  mock: object;
};
const cases = (fixtures as { cases: Case[] }).cases;

describe("capture fixtures with a mocked model", () => {
  it("has at least 40 phrases in both languages, events included", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.filter((c) => c.expect.intent === "event").length).toBeGreaterThanOrEqual(8);
  });

  for (const c of cases) {
    it(c.text, async () => {
      let called = false;
      const ask: ModelCall = async () => {
        called = true;
        return c.mock;
      };
      const p = await extractIntent(c.text, ask, NOW);
      if (c.expect.intent === "chat") {
        expect(p).toEqual({ intent: "chat" });
        return;
      }
      expect(called).toBe(true);
      expect(p).toMatchObject({ intent: c.expect.intent, title: c.expect.title });
      if (p.intent === "event") {
        expect(p.due_date).toBe(dueOf(c.expect.due));
        expect(p.due_time).toBe(c.expect.time);
        expect(p.end_time).toBe(c.expect.end);
        expect(p.location).toBe(c.expect.location);
        return;
      }
      const proposal = p as Extract<Proposal, { intent: "todo" | "reminder" }>;
      expect(proposal.due_date).toBe(dueOf(c.expect.due));
      expect(proposal.due_time).toBe(c.expect.time);
      if (c.expect.priority !== undefined) expect(proposal.priority).toBe(c.expect.priority);
      if (c.expect.list) expect(proposal.list).toBe(c.expect.list);
      if (c.expect.course) expect(proposal.course).toBe(c.expect.course);
    });
  }
});

describe("the cheap gate", () => {
  it("lets possible tasks through and keeps casual talk away from the model", () => {
    expect(mayBeTask("ingetin besok jam 7 bayar kos")).toBe(true);
    expect(mayBeTask("remind me to call mom")).toBe(true);
    expect(mayBeTask("meeting 18:30")).toBe(true);
    expect(mayBeTask("lagi capek nih")).toBe(false);
    expect(mayBeTask("haha")).toBe(false);
    expect(mayBeTask("/todo x")).toBe(false); // commands never reach capture
  });

  it("does not call the model for casual talk", async () => {
    let called = false;
    await extractIntent("lagi capek nih", async () => ((called = true), { intent: "chat" }), NOW);
    expect(called).toBe(false);
  });
});

describe("validation and fallbacks", () => {
  it("rejects anything but the exact shape", () => {
    expect(validateExtraction({ intent: "todo", title: "x" })).toEqual({ intent: "todo", title: "x" });
    expect(validateExtraction('{"intent":"chat"}')).toEqual({ intent: "chat" });
    expect(validateExtraction("not json")).toBeNull();
    expect(validateExtraction({ intent: "delete_everything" })).toBeNull();
    expect(validateExtraction({ intent: "todo" })).toBeNull(); // no title
    expect(validateExtraction({ intent: "todo", title: "x", due: "2026-11-05" })).toBeNull(); // unknown key
    expect(validateExtraction({ intent: "todo", title: "x", priority: "urgent" })).toBeNull();
    expect(validateExtraction({ intent: "todo", title: "x".repeat(500) })).toBeNull();
  });

  it("falls back to the parser for plain instructions when the model fails", async () => {
    const timeout: ModelCall = async () => {
      throw new Error("timeout");
    };
    expect(await extractIntent("ingetin besok jam 7 bayar kos", timeout, NOW)).toEqual({
      intent: "reminder",
      title: "bayar kos",
      due_date: day(1),
      due_time: "07:00",
      priority: 0,
      list: undefined,
      course: undefined,
      source: "parser",
    });
    expect(await extractIntent("besok aku ujian, deg degan", timeout, NOW)).toEqual({ intent: "chat" });
    expect(await extractIntent("tambah beli galon", async () => "{broken", NOW)).toMatchObject({ intent: "todo", title: "beli galon" });
  });

  it("the parser fallback handles a leading time too", () => {
    expect(fallbackProposal("remind me jam 6 sore makan", NOW)).toMatchObject({ intent: "reminder", due_time: "18:00", title: "makan" });
  });
});

describe("Edit and step suggestions", () => {
  it("turns a proposal into quick-add text the parser reads back the same", () => {
    const p: Proposal = { intent: "todo", title: "bayar kos", due_date: day(1), due_time: "07:00", priority: 3, list: "personal", source: "model" };
    const back = parseQuickAdd(proposalAsQuickAdd(p), NOW);
    expect(back).toMatchObject({ title: "bayar kos", due_date: day(1), due_time: "07:00", priority: 3, list: "personal" });
  });

  it("keeps 3 to 6 clean, distinct steps", () => {
    expect(validateSteps({ steps: ["1. Baca modul", "- Kerjakan soal", "Kumpulkan", "kumpulkan"] })).toEqual(["Baca modul", "Kerjakan soal", "Kumpulkan"]);
    expect(validateSteps({ steps: ["a", "b"] })).toBeNull();
    expect(validateSteps("nope")).toBeNull();
    expect(validateSteps({ steps: ["1", "2", "3", "4", "5", "6", "7"] })?.length).toBe(6);
  });
});
