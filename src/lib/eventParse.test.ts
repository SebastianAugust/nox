import { describe, expect, it } from "vitest";
import { draftAsText, eventTimes, parseEventText } from "./eventParse";
import { parseCommand } from "./commands";
import { overlapping, type CalendarEvent } from "./calendarLogic";

// Wednesday 4 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 4, 10, 0);

describe("/event text", () => {
  it("reads a title, a day, a time range and a place", () => {
    expect(parseEventText("rapat himatif jumat 14:00-15:30 di sekre", NOW)).toEqual({
      ok: true,
      draft: { title: "rapat himatif", date: "2026-11-06", allDay: false, start: "14:00", end: "15:30", endDate: "2026-11-06", location: "sekre" },
    });
  });

  it("reads a duration, and defaults to one hour", () => {
    expect(parseEventText("rapat tes jumat 14:00 ~1h", NOW)).toMatchObject({ ok: true, draft: { start: "14:00", end: "15:00" } });
    expect(parseEventText("rapat tes jumat 14:00 ~90m", NOW)).toMatchObject({ ok: true, draft: { end: "15:30" } });
    expect(parseEventText("rapat tes jumat 14:00 ~1.5jam", NOW)).toMatchObject({ ok: true, draft: { end: "15:30" } });
    expect(parseEventText("rapat tes jumat 14:00", NOW)).toMatchObject({ ok: true, draft: { end: "15:00" } });
  });

  it("takes a place in the middle, and 'at <time>' is a time, not a place", () => {
    expect(parseEventText("rapat di sekre jumat 14:00-15:30", NOW)).toMatchObject({
      ok: true,
      draft: { title: "rapat", location: "sekre", date: "2026-11-06", start: "14:00", end: "15:30" },
    });
    expect(parseEventText("kuliah umum besok at aula 09:00", NOW)).toMatchObject({
      ok: true,
      draft: { title: "kuliah umum", location: "aula", date: "2026-11-05", start: "09:00" },
    });
    const r = parseEventText("meeting friday at 14:00", NOW);
    expect(r).toMatchObject({ ok: true, draft: { title: "meeting", date: "2026-11-06", start: "14:00" } });
    expect(r.ok && r.draft.location).toBeUndefined();
  });

  it("is all-day without a time, today without a date", () => {
    expect(parseEventText("libur nasional 20/11", NOW)).toEqual({
      ok: true,
      draft: { title: "libur nasional", date: "2026-11-20", allDay: true, endDate: "2026-11-21" },
    });
    expect(parseEventText("hari olahraga", NOW)).toMatchObject({ ok: true, draft: { date: "2026-11-04", allDay: true } });
  });

  it("runs past midnight when the end is earlier than the start", () => {
    expect(parseEventText("malam keakraban sabtu 22:00-02:00", NOW)).toMatchObject({
      ok: true,
      draft: { date: "2026-11-07", endDate: "2026-11-08", start: "22:00", end: "02:00" },
    });
  });

  it("needs a title", () => {
    expect(parseEventText("", NOW)).toEqual({ ok: false, error: "eventEmpty" });
    expect(parseEventText("jumat 14:00-15:00", NOW)).toEqual({ ok: false, error: "eventNoTitle" });
    expect(parseCommand("/event", NOW)).toEqual({ kind: "error", error: "eventEmpty" });
    expect(parseCommand("/event besok 10:00", NOW)).toEqual({ kind: "error", error: "eventNoTitle" });
    expect(parseCommand("/acara rapat besok 10:00", NOW)).toMatchObject({ kind: "event", draft: { title: "rapat" } });
  });

  it("gives Google local times with the offset, and reads its own Edit text back", () => {
    const r = parseEventText("rapat himatif jumat 14:00-15:30 di sekre", NOW);
    if (!r.ok) throw new Error("parse");
    const times = eventTimes(r.draft);
    expect(times.start).toMatch(/^2026-11-06T14:00:00[+-]\d{2}:\d{2}$/);
    expect(times.end).toMatch(/^2026-11-06T15:30:00[+-]\d{2}:\d{2}$/);
    expect(new Date(times.startUtc.replace(" ", "T") + "Z").getTime()).toBe(new Date(2026, 10, 6, 14, 0).getTime());
    const again = parseCommand(draftAsText(r.draft), NOW);
    expect(again).toEqual({ kind: "event", draft: r.draft });
    const allDay = parseEventText("libur 20/11", NOW);
    if (!allDay.ok) throw new Error("parse");
    expect(eventTimes(allDay.draft)).toMatchObject({ start: "2026-11-20", end: "2026-11-21" });
  });
});

describe("overlap warning", () => {
  const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  const at = (h: number, m = 0, day = 6) => stamp(new Date(2026, 10, day, h, m));
  let n = 0;
  const ev = (start: string, end: string, all_day = 0): CalendarEvent => ({
    id: ++n,
    feed_id: 0,
    uid: `g${n}`,
    start,
    end,
    all_day,
    title: `e${n}`,
    location: null,
  });

  it("finds timed events that overlap, not ones that only touch, and ignores all-day ones", () => {
    const a = ev(at(13), at(14, 30));
    const touching = ev(at(15, 30), at(16));
    const before = ev(at(12), at(14));
    const allDay = ev("2026-11-06", "2026-11-07", 1);
    expect(overlapping([a, touching, before, allDay], at(14), at(15, 30)).map((e) => e.id)).toEqual([a.id]);
  });

  it("a new all-day event lists that day's timed events", () => {
    const sameDay = ev(at(9), at(10));
    const otherDay = ev(at(9, 0, 7), at(10, 0, 7));
    expect(overlapping([sameDay, otherDay], "2026-11-06", "2026-11-07", true).map((e) => e.id)).toEqual([sameDay.id]);
  });
});
