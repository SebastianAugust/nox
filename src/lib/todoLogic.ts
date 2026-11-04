/**
 * The Todos page's rules, kept pure (no imports beyond types) so they are
 * testable: which view an item belongs to, view counts, grouping by due
 * date, sorting, search, the next occurrence of a repeating todo, and
 * matching #list / @course to real names.
 *
 * Dates are local "YYYY-MM-DD" strings and times "HH:MM"; they compare as
 * strings, so no timezone maths happens here.
 */

import type { Priority, RepeatRule } from "./todoParse";

export type View = "today" | "upcoming" | "inbox" | "overdue" | "done" | "all";
export const VIEWS: View[] = ["today", "upcoming", "inbox", "overdue", "done", "all"];

export type SortKey = "due" | "priority" | "title" | "created";
export const SORTS: SortKey[] = ["due", "priority", "title", "created"];

/** What the list shows: one of Bas's todos or a read-only Notion assignment. */
export type ListItem = {
  /** "t:<id>" or "n:<notion id>". */
  key: string;
  kind: "todo" | "notion";
  title: string;
  notes: string | null;
  course: string | null;
  due_date: string | null;
  due_time: string | null;
  done: boolean;
  priority: Priority;
  created_at: string;
  sort_order: number;
};

// ── Dates ──

const pad = (n: number) => String(n).padStart(2, "0");

function parseDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const toDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + n);
  return toDay(d);
}

/** Whole days from `from` to `to`. */
export function dayDiff(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (day: string) => parseDay(day).getUTCDay();

function addMonth(day: string, anchorDay: number): string {
  const d = parseDay(day);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return toDay(new Date(Date.UTC(y, m, Math.min(anchorDay, last))));
}

function step(day: string, rule: RepeatRule, anchorDay: number): string {
  switch (rule) {
    case "daily":
      return addDays(day, 1);
    case "weekly":
      return addDays(day, 7);
    case "monthly":
      return addMonth(day, anchorDay);
    case "weekdays": {
      let next = addDays(day, 1);
      while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
      return next;
    }
    default: {
      const n = Number(rule.slice("every:".length));
      return addDays(day, n >= 1 ? Math.floor(n) : 1);
    }
  }
}

/** Is this a rule Nox understands? (Anything else is treated as no repeat.) */
export function isRepeatRule(v: string | null | undefined): v is RepeatRule {
  return !!v && (/^(daily|weekdays|weekly|monthly)$/.test(v) || /^every:[1-9]\d{0,2}$/.test(v));
}

/**
 * The due date of the next occurrence when a repeating todo is completed:
 * one step after its due date (or after today when it had none), moved on
 * until it lands after today, so finishing late never spawns an overdue one.
 * Monthly keeps the original day of the month where it can (31 → 30 → 31).
 */
export function nextDue(due: string | null, rule: RepeatRule, today: string): string {
  const base = due ?? today;
  const anchor = parseDay(base).getUTCDate();
  let next = step(base, rule, anchor);
  for (let i = 0; next <= today && i < 1000; i++) next = step(next, rule, anchor);
  return next;
}

// ── Views ──

export function inView(item: ListItem, view: View, today: string): boolean {
  const due = item.due_date;
  switch (view) {
    case "today":
      return !item.done && !!due && due <= today;
    case "upcoming":
      return !item.done && !!due && due > today;
    case "inbox":
      return !item.done && !due;
    case "overdue":
      return !item.done && !!due && due < today;
    case "done":
      return item.done;
    case "all":
      return true;
  }
}

export function viewCounts(items: ListItem[], today: string): Record<View, number> {
  const counts = { today: 0, upcoming: 0, inbox: 0, overdue: 0, done: 0, all: 0 };
  for (const item of items) for (const v of VIEWS) if (inView(item, v, today)) counts[v]++;
  return counts;
}

/** "3 due today · 1 overdue · 9 open in total" as numbers. */
export function summary(items: ListItem[], today: string) {
  let dueToday = 0;
  let overdue = 0;
  let open = 0;
  for (const i of items) {
    if (i.done) continue;
    open++;
    if (i.due_date === today) dueToday++;
    else if (i.due_date && i.due_date < today) overdue++;
  }
  return { dueToday, overdue, open };
}

// ── Search ──

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Title, notes and course, ignoring case and accents. Every word must match. */
export function matchesSearch(item: ListItem, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold([item.title, item.notes ?? "", item.course ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

// ── Sorting ──

const byDueThenTime = (a: ListItem, b: ListItem) => {
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  if (a.due_time !== b.due_time) {
    if (!a.due_time) return 1;
    if (!b.due_time) return -1;
    return a.due_time < b.due_time ? -1 : 1;
  }
  return 0;
};

const tieBreak = (a: ListItem, b: ListItem) =>
  a.sort_order - b.sort_order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export function compareItems(sort: SortKey): (a: ListItem, b: ListItem) => number {
  switch (sort) {
    case "due":
      return (a, b) => byDueThenTime(a, b) || b.priority - a.priority || tieBreak(a, b);
    case "priority":
      return (a, b) => b.priority - a.priority || byDueThenTime(a, b) || tieBreak(a, b);
    case "title":
      return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || tieBreak(a, b);
    case "created":
      return (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : tieBreak(a, b));
  }
}

// ── Grouping by due date ──

export type GroupKind = "overdue" | "today" | "tomorrow" | "day" | "none" | "done";
export type Group = { key: string; kind: GroupKind; date: string | null; items: ListItem[] };

/**
 * Overdue, Today, Tomorrow, then one group per later day, No date, and
 * Completed last. In the Done view everything is one Completed group. Items
 * keep the order they come in (sort first).
 */
export function groupByDue(items: ListItem[], view: View, today: string): Group[] {
  const groups = new Map<string, Group>();
  const put = (key: string, kind: GroupKind, date: string | null, item: ListItem) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, kind, date, items: [] }));
    g.items.push(item);
  };
  const tomorrow = addDays(today, 1);
  for (const item of items) {
    const d = item.due_date;
    if (view === "done" || item.done) put("done", "done", null, item);
    else if (!d) put("none", "none", null, item);
    else if (d < today) put("overdue", "overdue", null, item);
    else if (d === today) put(d, "today", d, item);
    else if (d === tomorrow) put(d, "tomorrow", d, item);
    else put(d, "day", d, item);
  }
  const rank = (g: Group) =>
    g.kind === "overdue" ? "0" : g.kind === "none" ? "8" : g.kind === "done" ? "9" : `1${g.date}`;
  return [...groups.values()].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

/** The whole pipeline: view, search, sort, group. */
export function buildList(
  items: ListItem[],
  opts: { view: View; query: string; sort: SortKey; today: string },
): { visible: ListItem[]; groups: Group[] } {
  const visible = items
    .filter((i) => inView(i, opts.view, opts.today) && matchesSearch(i, opts.query))
    .sort(compareItems(opts.sort));
  return { visible, groups: groupByDue(visible, opts.view, opts.today) };
}

// ── Matching #list and @course ──

/** A list by name, ignoring case; else the only one starting with it. */
export function matchName<T extends { name: string }>(items: T[], raw: string | undefined): T | null {
  const q = raw?.trim().toLowerCase();
  if (!q) return null;
  const exact = items.find((i) => i.name.toLowerCase() === q);
  if (exact) return exact;
  const starts = items.filter((i) => i.name.toLowerCase().startsWith(q));
  return starts.length === 1 ? starts[0] : null;
}

/**
 * A course for @robotika: a synced course name it matches (exact, the only
 * one starting with it, or the only one containing it), else what was typed.
 */
export function resolveCourse(raw: string | undefined, courses: string[]): string | null {
  const q = raw?.trim();
  if (!q) return null;
  const low = q.toLowerCase();
  const exact = courses.find((c) => c.toLowerCase() === low);
  if (exact) return exact;
  const starts = courses.filter((c) => c.toLowerCase().startsWith(low));
  if (starts.length === 1) return starts[0];
  const contains = courses.filter((c) => c.toLowerCase().includes(low));
  if (contains.length === 1) return contains[0];
  return q;
}
