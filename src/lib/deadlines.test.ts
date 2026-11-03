import { describe, expect, it } from "vitest";
import { dueNudges, isRelevantAssignment, nudgeKey, parseDue, urgency, type NudgeItem } from "./deadlines";

const NOW = new Date(2026, 10, 3, 12, 0); // Tue 3 Nov 2026, 12:00 local

const item = (id: string, due_date: string): NudgeItem => ({ id, name: id, course: null, due_date });

describe("parseDue", () => {
  it("reads a bare date as 23:59 and a date-time as given", () => {
    expect(parseDue("2026-11-05")).toEqual(new Date(2026, 10, 5, 23, 59));
    expect(parseDue("2026-11-05 08:30")).toEqual(new Date(2026, 10, 5, 8, 30));
    expect(parseDue("soon")).toBeNull();
  });
});

describe("urgency", () => {
  it("labels overdue, today, tomorrow and N days", () => {
    expect(urgency("2026-11-01", NOW)).toEqual({ kind: "overdue", days: 2 });
    expect(urgency("2026-11-03", NOW)).toEqual({ kind: "today" });
    expect(urgency("2026-11-03 09:00", NOW)).toEqual({ kind: "overdue", days: 0 });
    expect(urgency("2026-11-04 10:00", NOW)).toEqual({ kind: "tomorrow" });
    expect(urgency("2026-11-08", NOW)).toEqual({ kind: "days", days: 5 });
  });
});

describe("dueNudges", () => {
  it("sends the most urgent threshold crossed", () => {
    const items = [
      item("far", "2026-11-10"), // 7 days out: nothing yet
      item("threeDays", "2026-11-06 10:00"), // 70 h → 3d
      item("oneDay", "2026-11-04 08:00"), // 20 h → 1d (not 3d)
      item("soon", "2026-11-03 14:00"), // 2 h → 3h
      item("late", "2026-11-02"), // overdue → no nudge
    ];
    expect(dueNudges(items, new Set(), NOW).map((n) => [n.item.id, n.threshold])).toEqual([
      ["soon", "3h"],
      ["oneDay", "1d"],
      ["threeDays", "3d"],
    ]);
  });

  it("never repeats a nudge already recorded (e.g. after a restart)", () => {
    const items = [item("a", "2026-11-04 08:00")];
    const sent = new Set([nudgeKey("a", "1d")]);
    expect(dueNudges(items, sent, NOW)).toEqual([]);
  });

  it("moves on to the next threshold when it is crossed", () => {
    const items = [item("a", "2026-11-03 14:00")];
    const sent = new Set([nudgeKey("a", "3d"), nudgeKey("a", "1d")]);
    expect(dueNudges(items, sent, NOW)).toEqual([{ item: items[0], threshold: "3h" }]);
  });

  it("does not replay older thresholds on a late start", () => {
    // Nox was off for days; only the 3h nudge goes out, once.
    const items = [item("a", "2026-11-03 13:00")];
    const first = dueNudges(items, new Set(), NOW);
    expect(first.map((n) => n.threshold)).toEqual(["3h"]);
    const sent = new Set(first.map((n) => nudgeKey(n.item.id, n.threshold)));
    expect(dueNudges(items, sent, NOW)).toEqual([]);
  });

  it("skips rows without a readable due date", () => {
    expect(dueNudges([item("x", "")], new Set(), NOW)).toEqual([]);
  });
});

describe("isRelevantAssignment", () => {
  const base = { name: "Essay", due_date: "2026-11-05", course_notion_id: null, course_known: false, course_status: null };

  it("keeps a dated, named assignment without a course", () => {
    expect(isRelevantAssignment(base, NOW)).toBe(true);
  });

  it("skips the template's blank rows", () => {
    expect(isRelevantAssignment({ ...base, name: "  " }, NOW)).toBe(false);
    expect(isRelevantAssignment({ ...base, due_date: null }, NOW)).toBe(false);
    expect(isRelevantAssignment({ ...base, due_date: "" }, NOW)).toBe(false);
  });

  it("keeps assignments of a current course and drops finished courses", () => {
    const linked = { ...base, course_notion_id: "c1", course_known: true };
    expect(isRelevantAssignment({ ...linked, course_status: "In progress" }, NOW)).toBe(true);
    expect(isRelevantAssignment({ ...linked, course_status: "Passed" }, NOW)).toBe(false);
    expect(isRelevantAssignment({ ...linked, course_status: "Not Started" }, NOW)).toBe(false);
    // A link to a course that is not synced counts as no course.
    expect(isRelevantAssignment({ ...linked, course_known: false, course_status: null }, NOW)).toBe(true);
  });

  it("lets an old database fall quiet: long-overdue rows drop off", () => {
    expect(isRelevantAssignment({ ...base, due_date: "2026-10-20" }, NOW)).toBe(true);
    expect(isRelevantAssignment({ ...base, due_date: "2025-12-01" }, NOW)).toBe(false);
  });
});
