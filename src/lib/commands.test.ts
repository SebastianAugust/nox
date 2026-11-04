import { describe, expect, it } from "vitest";
import { describeDue, parseRemindArgs } from "./commands";

// Wednesday 10 June 2026, 14:30 local time.
const NOW = new Date(2026, 5, 10, 14, 30);

// /todo parsing lives in todoParse.ts (see todoParse.test.ts).

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
