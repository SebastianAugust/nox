import { describe, expect, it } from "vitest";
import { parseClock, renderBriefing, shouldShowBriefing, zonedNow, type Translate } from "./briefing";

const tr: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);
const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m); // 3 Nov 2026, local

describe("briefing schedule", () => {
  const base = { time: "07:00", enabled: true, lastDate: "2026-11-02" };

  it("is not due before the set time", () => {
    expect(shouldShowBriefing({ ...base, now: at(6, 59) })).toEqual({ due: false, date: "2026-11-03" });
  });

  it("is due at the set time", () => {
    expect(shouldShowBriefing({ ...base, now: at(7, 0) }).due).toBe(true);
  });

  it("replays once on a late start (app opened after the time)", () => {
    expect(shouldShowBriefing({ ...base, now: at(9, 30) }).due).toBe(true);
  });

  it("does not repeat once today's date is stored", () => {
    expect(shouldShowBriefing({ ...base, now: at(9, 30), lastDate: "2026-11-03" }).due).toBe(false);
  });

  it("does nothing when switched off", () => {
    expect(shouldShowBriefing({ ...base, now: at(9, 30), enabled: false }).due).toBe(false);
  });

  it("is due again the next day", () => {
    const next = new Date(2026, 10, 4, 7, 5);
    expect(shouldShowBriefing({ ...base, now: next, lastDate: "2026-11-03" })).toEqual({
      due: true,
      date: "2026-11-04",
    });
  });

  it("uses the timezone setting for the day and the time", () => {
    // 00:30 UTC on 3 Nov is 07:30 in Jakarta (UTC+7), 3 Nov.
    const now = new Date(Date.UTC(2026, 10, 3, 0, 30));
    expect(zonedNow(now, "Asia/Jakarta")).toEqual({ date: "2026-11-03", minutes: 7 * 60 + 30 });
    // 23:30 UTC on 2 Nov is already 06:30 on 3 Nov in Jakarta: not yet due.
    const early = new Date(Date.UTC(2026, 10, 2, 23, 30));
    expect(shouldShowBriefing({ ...base, now: early, timeZone: "Asia/Jakarta" })).toEqual({
      due: false,
      date: "2026-11-03",
    });
  });

  it("falls back to the machine clock for an unknown zone", () => {
    expect(zonedNow(at(8, 15), "Not/AZone")).toEqual({ date: "2026-11-03", minutes: 8 * 60 + 15 });
  });

  it("reads clock strings, defaulting to 07:30", () => {
    expect(parseClock("06:45")).toBe(405);
    expect(parseClock("bad")).toBe(450);
    expect(parseClock(null)).toBe(450);
  });

  it("with no saved time, is due from 07:30", () => {
    const unset = { enabled: true, lastDate: null, time: null };
    expect(shouldShowBriefing({ ...unset, now: at(7, 29) }).due).toBe(false);
    expect(shouldShowBriefing({ ...unset, now: at(7, 30) }).due).toBe(true);
  });
});

describe("renderBriefing", () => {
  it("lists only non-empty sections, after the opener and date", () => {
    const text = renderBriefing(
      {
        dateLabel: "Tuesday, 3 November",
        weather: "Rain likely",
        events: [],
        deadlinesToday: [{ title: "Essay", detail: "Ethics" }],
        overdue: [],
        todosToday: [],
        habitsLeft: ["Read"],
        remindersToday: [],
      },
      "Morning!",
      tr,
    );
    expect(text.split("\n")).toEqual([
      "Morning!",
      "Tuesday, 3 November",
      "Rain likely",
      "",
      "brief.deadlines",
      "• Essay (Ethics)",
      "brief.habits",
      "• Read",
    ]);
  });

  it("says the day is clear when there is nothing", () => {
    const text = renderBriefing(
      { dateLabel: "d", weather: null, events: [], deadlinesToday: [], overdue: [], todosToday: [], habitsLeft: [], remindersToday: [] },
      "Hi",
      tr,
    );
    expect(text).toBe("Hi\nd\n\nbrief.clear");
  });
});
