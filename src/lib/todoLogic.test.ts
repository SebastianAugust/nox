import { describe, expect, it } from "vitest";
import {
  addDays,
  buildList,
  compareItems,
  groupByDue,
  inView,
  isRepeatRule,
  matchesSearch,
  matchName,
  nextDue,
  resolveCourse,
  summary,
  viewCounts,
  type ListItem,
} from "./todoLogic";

const TODAY = "2026-11-03"; // a Tuesday

let n = 0;
const item = (over: Partial<ListItem> = {}): ListItem => {
  n++;
  return {
    key: `t:${n}`,
    kind: "todo",
    title: `todo ${n}`,
    notes: null,
    course: null,
    due_date: null,
    due_time: null,
    done: false,
    priority: 0,
    created_at: `2026-10-${String(n).padStart(2, "0")} 10:00:00`,
    sort_order: n,
    ...over,
  };
};

describe("views and counts", () => {
  const overdue = item({ due_date: "2026-11-01" });
  const today = item({ due_date: TODAY });
  const later = item({ due_date: "2026-11-07" });
  const inbox = item();
  const done = item({ due_date: "2026-11-01", done: true });
  const notion = item({ kind: "notion", due_date: "2026-11-05" });
  const all = [overdue, today, later, inbox, done, notion];

  it("puts overdue plus due today in Today, never done ones", () => {
    expect(all.filter((i) => inView(i, "today", TODAY))).toEqual([overdue, today]);
  });

  it("splits Upcoming, Inbox, Overdue and Done", () => {
    expect(all.filter((i) => inView(i, "upcoming", TODAY))).toEqual([later, notion]);
    expect(all.filter((i) => inView(i, "inbox", TODAY))).toEqual([inbox]);
    expect(all.filter((i) => inView(i, "overdue", TODAY))).toEqual([overdue]);
    expect(all.filter((i) => inView(i, "done", TODAY))).toEqual([done]);
  });

  it("counts match what each view lists", () => {
    expect(viewCounts(all, TODAY)).toEqual({ today: 2, upcoming: 2, inbox: 1, overdue: 1, done: 1, all: 6 });
  });

  it("summarises due today, overdue and open", () => {
    expect(summary(all, TODAY)).toEqual({ dueToday: 1, overdue: 1, open: 5 });
  });
});

describe("grouping by due date", () => {
  it("orders Overdue, Today, Tomorrow, later days, No date, Completed", () => {
    const items = [
      item({ due_date: "2026-11-08" }),
      item(),
      item({ due_date: "2026-11-04" }),
      item({ due_date: TODAY }),
      item({ due_date: "2026-10-30" }),
      item({ due_date: TODAY, done: true }),
    ];
    expect(groupByDue(items, "all", TODAY).map((g) => [g.kind, g.date])).toEqual([
      ["overdue", null],
      ["today", TODAY],
      ["tomorrow", "2026-11-04"],
      ["day", "2026-11-08"],
      ["none", null],
      ["done", null],
    ]);
  });

  it("puts everything in one Completed group in the Done view", () => {
    const items = [item({ done: true, due_date: TODAY }), item({ done: true })];
    expect(groupByDue(items, "done", TODAY).map((g) => [g.kind, g.items.length])).toEqual([["done", 2]]);
  });
});

describe("sorting", () => {
  it("sorts by due date, then time, then priority by default", () => {
    const a = item({ due_date: TODAY, due_time: "18:00" });
    const b = item({ due_date: TODAY, due_time: "09:00" });
    const c = item({ due_date: TODAY });
    const d = item({ due_date: TODAY, due_time: "09:00", priority: 3 });
    const e = item({ due_date: "2026-11-01" });
    const f = item();
    expect([a, b, c, d, e, f].sort(compareItems("due"))).toEqual([e, d, b, a, c, f]);
  });

  it("can sort by priority, title or newest", () => {
    const low = item({ priority: 1, title: "b" });
    const high = item({ priority: 3, title: "a" });
    expect([low, high].sort(compareItems("priority"))).toEqual([high, low]);
    expect([low, high].sort(compareItems("title"))).toEqual([high, low]);
    expect([low, high].sort(compareItems("created"))).toEqual([high, low]);
  });
});

describe("search", () => {
  it("covers title, notes and course, ignoring case and accents", () => {
    const x = item({ title: "Laporan robotik", notes: "servo kaki 3", course: "Robótica" });
    expect(matchesSearch(x, "LAPORAN")).toBe(true);
    expect(matchesSearch(x, "servo")).toBe(true);
    expect(matchesSearch(x, "robotica")).toBe(true);
    expect(matchesSearch(x, "laporan servo")).toBe(true);
    expect(matchesSearch(x, "jarkom")).toBe(false);
    expect(matchesSearch(x, "  ")).toBe(true);
  });

  it("runs view, search and sort together", () => {
    const a = item({ title: "beli makan", due_date: TODAY });
    const b = item({ title: "beli kabel", due_date: "2026-11-01" });
    const c = item({ title: "cuci baju", due_date: TODAY });
    const { visible, groups } = buildList([a, b, c], { view: "today", query: "beli", sort: "due", today: TODAY });
    expect(visible).toEqual([b, a]);
    expect(groups.map((g) => g.kind)).toEqual(["overdue", "today"]);
  });
});

describe("repeat", () => {
  it("steps daily, weekly, every N days and weekdays", () => {
    expect(nextDue(TODAY, "daily", TODAY)).toBe("2026-11-04");
    expect(nextDue(TODAY, "weekly", TODAY)).toBe("2026-11-10");
    expect(nextDue(TODAY, "every:3", TODAY)).toBe("2026-11-06");
    expect(nextDue("2026-11-06", "weekdays", "2026-11-06")).toBe("2026-11-09"); // Fri → Mon
  });

  it("keeps the day of the month, clamping short months", () => {
    expect(nextDue("2026-01-31", "monthly", "2026-01-31")).toBe("2026-02-28");
    expect(nextDue("2026-11-15", "monthly", "2026-11-15")).toBe("2026-12-15");
  });

  it("never spawns an overdue occurrence when finished late", () => {
    expect(nextDue("2026-10-20", "weekly", TODAY)).toBe("2026-11-10");
    expect(nextDue("2026-10-01", "daily", TODAY)).toBe("2026-11-04");
  });

  it("starts from today when there was no due date", () => {
    expect(nextDue(null, "weekly", TODAY)).toBe(addDays(TODAY, 7));
  });

  it("knows which rules are valid", () => {
    expect(["daily", "weekdays", "weekly", "monthly", "every:2"].every(isRepeatRule)).toBe(true);
    expect(["", "yearly", "every:0", "every:x", null].some(isRepeatRule)).toBe(false);
  });
});

describe("matching #list and @course", () => {
  const lists = [
    { id: 1, name: "Personal" },
    { id: 2, name: "Kuliah" },
    { id: 3, name: "Kulineran" },
  ];

  it("matches a list ignoring case, or by a unique start", () => {
    expect(matchName(lists, "personal")?.id).toBe(1);
    expect(matchName(lists, "KULIAH")?.id).toBe(2);
    expect(matchName(lists, "kul")).toBeNull();
    expect(matchName(lists, "pers")?.id).toBe(1);
    expect(matchName(lists, "magang")).toBeNull();
  });

  it("resolves a course to a synced name, else keeps what was typed", () => {
    const courses = ["Robotika Dasar", "Jaringan Komputer", "Metodologi Penelitian"];
    expect(resolveCourse("robotika", courses)).toBe("Robotika Dasar");
    expect(resolveCourse("komputer", courses)).toBe("Jaringan Komputer");
    expect(resolveCourse("Etprof", courses)).toBe("Etprof");
    expect(resolveCourse(undefined, courses)).toBeNull();
  });
});
