/**
 * What Nox says on Home. Rule-based (no model call), in priority order:
 *   1. the oldest overdue todo
 *   2. something due today
 *   3. habits not done yet today
 *   4. a friendly idle line
 * A suggestion the user put off with "Later" is skipped until its snooze
 * runs out, so the next rule gets its turn. Pure: no imports, easy to test.
 */

export type HomeTodo = { id: number; title: string; due_date: string | null; status: string };

export type Suggestion =
  | { kind: "overdue"; key: string; todo: HomeTodo; days: number }
  | { kind: "today"; key: string; todo: HomeTodo }
  | { kind: "habits"; key: string; count: number }
  | { kind: "idle"; key: string };

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const utc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export function pickSuggestion(input: {
  todos: HomeTodo[];
  today: string;
  habitsLeft: number;
  isSnoozed: (key: string) => boolean;
}): Suggestion {
  const { todos, today, habitsLeft, isSnoozed } = input;
  const open = todos.filter((t) => t.status !== "done" && t.due_date);
  const byDue = (a: HomeTodo, b: HomeTodo) => (a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : a.id - b.id);

  const overdue = open.filter((t) => t.due_date!.slice(0, 10) < today).sort(byDue);
  for (const todo of overdue) {
    const key = `overdue:${todo.id}`;
    if (!isSnoozed(key)) return { kind: "overdue", key, todo, days: daysBetween(todo.due_date!, today) };
  }

  const dueToday = open.filter((t) => t.due_date!.slice(0, 10) === today).sort(byDue);
  for (const todo of dueToday) {
    const key = `today:${todo.id}`;
    if (!isSnoozed(key)) return { kind: "today", key, todo };
  }

  if (habitsLeft > 0 && !isSnoozed("habits")) return { kind: "habits", key: "habits", count: habitsLeft };

  return { kind: "idle", key: "idle" };
}
