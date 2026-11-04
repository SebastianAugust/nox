import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import { useTodoDb } from "./todoRepo";
import { calendarStale, getEvents, getFeeds, syncCalendars, takeEventNudges } from "./calendar";
import { dayBoundsUtc, dueEventNudges, eventsOn, nowNext, onDay, type CalendarEvent } from "./calendarLogic";

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
/** A UTC stamp for a local wall-clock time. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => stamp(new Date(y, mo - 1, d, h, mi));

let n = 0;
const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: ++n,
  feed_id: 1,
  uid: `e${n}`,
  start: local(2026, 11, 4, 8),
  end: local(2026, 11, 4, 10),
  all_day: 0,
  title: `event ${n}`,
  location: null,
  ...over,
});

describe("days, order and the now/next marker", () => {
  const allDay = ev({ all_day: 1, start: "2026-11-04", end: "2026-11-05", title: "Libur" });
  const morning = ev({ start: local(2026, 11, 4, 8), end: local(2026, 11, 4, 10) });
  const evening = ev({ start: local(2026, 11, 4, 19), end: local(2026, 11, 4, 20) });
  const tomorrow = ev({ start: local(2026, 11, 5, 8), end: local(2026, 11, 5, 9) });
  const overnight = ev({ start: local(2026, 11, 3, 23), end: local(2026, 11, 4, 1) });

  it("puts events on the local days they touch, all-day first", () => {
    expect(eventsOn([evening, tomorrow, morning, allDay, overnight], "2026-11-04").map((e) => e.id)).toEqual([
      allDay.id,
      overnight.id,
      morning.id,
      evening.id,
    ]);
    expect(onDay(allDay, "2026-11-05")).toBe(false); // end is exclusive
    expect(onDay(tomorrow, "2026-11-05")).toBe(true);
  });

  it("marks the running event as now, else the next one", () => {
    const today = [allDay, morning, evening];
    expect(nowNext(today, new Date(2026, 10, 4, 9))).toEqual({ id: morning.id, kind: "now" });
    expect(nowNext(today, new Date(2026, 10, 4, 12))).toEqual({ id: evening.id, kind: "next" });
    expect(nowNext(today, new Date(2026, 10, 4, 21))).toBeNull();
  });

  it("bounds a local day in UTC", () => {
    const [from, to] = dayBoundsUtc("2026-11-04");
    expect(from).toBe(local(2026, 11, 4, 0));
    expect(to).toBe(local(2026, 11, 5, 0));
  });
});

describe("event nudges", () => {
  const now = new Date(2026, 10, 4, 7, 50);
  const soon = ev({ start: local(2026, 11, 4, 8) }); // in 10 minutes
  const later = ev({ start: local(2026, 11, 4, 9) });
  const allDay = ev({ all_day: 1, start: "2026-11-04", end: "2026-11-05" });

  it("nudges events starting within the set minutes, never all-day ones", () => {
    expect(dueEventNudges([soon, later, allDay], new Set(), now, 15).map((e) => e.id)).toEqual([soon.id]);
    expect(dueEventNudges([soon], new Set(), now, 0)).toEqual([]); // 0 = off
  });

  it("does not nudge an event twice", () => {
    expect(dueEventNudges([soon], new Set([`1|${soon.uid}|${soon.start}`]), now, 15)).toEqual([]);
  });
});

describe("sync and storage", () => {
  let t: ReturnType<typeof openTestDb>;
  beforeEach(() => {
    t = openTestDb();
    useTodoDb(t.db);
    t.raw.exec("INSERT INTO calendar_feeds (name) VALUES ('Kampus')");
  });
  afterEach(() => useTodoDb(null));

  const good = async () => [
    { uid: "a", start: local(2026, 11, 4, 8), end: local(2026, 11, 4, 10), all_day: 0, title: "Prak Jarkom", location: "Lab 1" },
    { uid: "b", start: "2026-11-04", end: "2026-11-05", all_day: 1, title: "Libur", location: null },
  ];

  it("stores a good fetch and lists it by local day", async () => {
    await syncCalendars(good);
    expect((await getEvents("2026-11-04", "2026-11-04")).map((e) => e.title)).toEqual(["Libur", "Prak Jarkom"]);
    expect((await getFeeds())[0]).toMatchObject({ name: "Kampus", events: 2, last_error: null });
    expect(await calendarStale()).toBe(false);
  });

  it("keeps the last good events when a fetch fails, and marks them stale", async () => {
    await syncCalendars(good);
    await syncCalendars(async () => {
      throw { kind: "offline" };
    });
    expect((await getEvents("2026-11-04", "2026-11-04")).length).toBe(2);
    expect(await calendarStale()).toBe(true);
    expect(JSON.parse((await getFeeds())[0].last_error!)).toEqual({ kind: "offline" });
  });

  it("hides events of a disabled feed, and drops them with a removed feed", async () => {
    await syncCalendars(good);
    t.raw.exec("UPDATE calendar_feeds SET enabled = 0");
    expect(await getEvents("2026-11-04", "2026-11-04")).toEqual([]);
    t.raw.exec("DELETE FROM calendar_feeds");
    expect((t.raw.prepare("SELECT COUNT(*) AS n FROM calendar_events").get() as { n: number }).n).toBe(0);
  });

  it("records a nudge before returning it, so a restart never repeats it", async () => {
    await syncCalendars(good);
    const now = new Date(2026, 10, 4, 7, 50);
    expect((await takeEventNudges(now)).map((e) => e.title)).toEqual(["Prak Jarkom"]);
    expect(await takeEventNudges(now)).toEqual([]);
  });
});
