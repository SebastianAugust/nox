import { describe, expect, it } from "vitest";
import { daysBetween, pickSuggestion, type HomeTodo } from "./homeMessage";
import { habitStreak, shiftDay } from "./streaks";

const TODAY = "2026-10-22";
const todo = (id: number, due: string | null, status = "pending"): HomeTodo => ({
  id,
  title: `t${id}`,
  due_date: due,
  status,
});
const never = () => false;

describe("pickSuggestion", () => {
  it("leads with the oldest overdue todo", () => {
    const s = pickSuggestion({
      todos: [todo(1, "2026-10-21"), todo(2, "2026-10-19"), todo(3, TODAY)],
      today: TODAY,
      habitsLeft: 2,
      isSnoozed: never,
    });
    expect(s).toMatchObject({ kind: "overdue", todo: { id: 2 }, days: 3 });
  });

  it("falls through snoozed and done items in priority order", () => {
    const todos = [todo(1, "2026-10-20"), todo(2, TODAY), todo(3, "2026-10-01", "done")];
    expect(
      pickSuggestion({ todos, today: TODAY, habitsLeft: 1, isSnoozed: (k) => k === "overdue:1" }),
    ).toMatchObject({ kind: "today", todo: { id: 2 } });
    expect(
      pickSuggestion({ todos, today: TODAY, habitsLeft: 1, isSnoozed: (k) => k !== "habits" }),
    ).toMatchObject({ kind: "habits", count: 1 });
    expect(pickSuggestion({ todos: [], today: TODAY, habitsLeft: 0, isSnoozed: never }).kind).toBe("idle");
  });

  it("ignores undated todos", () => {
    expect(pickSuggestion({ todos: [todo(1, null)], today: TODAY, habitsLeft: 0, isSnoozed: never }).kind).toBe("idle");
  });
});

describe("dates and streaks", () => {
  it("counts days across a month end", () => {
    expect(daysBetween("2026-09-29", "2026-10-02")).toBe(3);
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("finds current and best runs per habit", () => {
    const logs = {
      "2026-10-15": { 1: true },
      "2026-10-16": { 1: true },
      "2026-10-17": { 1: true },
      "2026-10-20": { 1: true, 2: true },
      "2026-10-21": { 1: true, 2: false },
    };
    expect(habitStreak(logs, 1, TODAY)).toEqual({ current: 2, best: 3 });
    expect(habitStreak(logs, 2, TODAY)).toEqual({ current: 0, best: 1 });
    expect(habitStreak(logs, 3, TODAY)).toEqual({ current: 0, best: 0 });
  });
});
