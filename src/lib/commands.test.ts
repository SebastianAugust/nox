import { describe, expect, it } from "vitest";
import { describeDue, parseRemindArgs, parseTodoArgs } from "./commands";

// Wednesday 10 June 2026, 14:30 local time.
const NOW = new Date(2026, 5, 10, 14, 30);

describe("parseTodoArgs", () => {
  it("keeps a plain title", () => {
    expect(parseTodoArgs("buy milk", NOW)).toEqual({ title: "buy milk" });
  });

  it("reads tomorrow and today in both languages", () => {
    expect(parseTodoArgs("call mom besok", NOW)).toEqual({ title: "call mom", due_date: "2026-06-11" });
    expect(parseTodoArgs("call mom today", NOW)).toEqual({ title: "call mom", due_date: "2026-06-10" });
    expect(parseTodoArgs("call mom hari ini", NOW).due_date).toBe("2026-06-10");
  });

  it("rolls a past DD/MM into next year and rejects nonsense", () => {
    expect(parseTodoArgs("taxes 1/3", NOW).due_date).toBe("2027-03-01");
    expect(parseTodoArgs("party 25/12", NOW).due_date).toBe("2026-12-25");
    expect(parseTodoArgs("item 31/02", NOW)).toEqual({ title: "item 31/02" });
  });
});

describe("parseRemindArgs", () => {
  it("moves a passed time to tomorrow", () => {
    const r = parseRemindArgs("stretch jam 09:00", NOW);
    expect(r.title).toBe("stretch");
    expect(r.clock).toBe("09:00");
    expect(r.tomorrow).toBe(true);
  });

  it("falls back to a title without a time", () => {
    expect(parseRemindArgs("stretch later", NOW)).toEqual({ title: "stretch later" });
  });
});

describe("describeDue", () => {
  it("uses the given words for today and tomorrow", () => {
    const words = { today: "today", tomorrow: "tomorrow" };
    expect(describeDue("2026-06-10", words, NOW)).toBe("today");
    expect(describeDue("2026-06-11", words, NOW)).toBe("tomorrow");
    expect(describeDue("2026-07-04", words, NOW)).toBe("4/7");
  });
});
