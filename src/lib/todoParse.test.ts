import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "./todoParse";

// Tuesday 3 November 2026, 14:30 local time.
const NOW = new Date(2026, 10, 3, 14, 30);
const p = (s: string) => parseQuickAdd(s, NOW);

describe("parseQuickAdd: the checklist example", () => {
  it("reads everything in 'beli makan besok 18:30 !high #personal ~2p'", () => {
    expect(p("beli makan besok 18:30 !high #personal ~2p")).toEqual({
      title: "beli makan",
      due_date: "2026-11-04",
      due_time: "18:30",
      priority: 3,
      list: "personal",
      estimate: 2,
    });
  });

  it("reads the mockup example with a course", () => {
    expect(p("laporan robotik besok 18:30 !high #kuliah @robotika ~3p")).toMatchObject({
      title: "laporan robotik",
      due_date: "2026-11-04",
      due_time: "18:30",
      priority: 3,
      list: "kuliah",
      course: "robotika",
      estimate: 3,
    });
  });
});

describe("plain sentences stay plain", () => {
  it("adds no date to an ordinary sentence", () => {
    expect(p("call mom about the weekend plans")).toEqual({ title: "call mom about the weekend plans", priority: 0 });
  });

  it("ignores date-like words that are not at the end", () => {
    expect(p("today show plan")).toEqual({ title: "today show plan", priority: 0 });
    expect(p("besok aku pergi ke pasar")).toEqual({ title: "besok aku pergi ke pasar", priority: 0 });
    expect(p("beli 3 hari")).toEqual({ title: "beli 3 hari", priority: 0 });
    expect(p("buy 2 apples")).toEqual({ title: "buy 2 apples", priority: 0 });
    expect(p("money for rent")).toEqual({ title: "money for rent", priority: 0 });
    expect(p("fix issue #42")).toEqual({ title: "fix issue #42", priority: 0 });
    expect(p("mail dion@kampus.ac.id")).toEqual({ title: "mail dion@kampus.ac.id", priority: 0 });
    expect(p("update to v1.20")).toEqual({ title: "update to v1.20", priority: 0 });
    expect(p("score 45/13")).toEqual({ title: "score 45/13", priority: 0 });
  });
});

describe("dates", () => {
  it("reads today, tomorrow and lusa in both languages", () => {
    expect(p("a today").due_date).toBe("2026-11-03");
    expect(p("a hari ini").due_date).toBe("2026-11-03");
    expect(p("a tomorrow").due_date).toBe("2026-11-04");
    expect(p("a besok").due_date).toBe("2026-11-04");
    expect(p("a lusa").due_date).toBe("2026-11-05");
  });

  it("reads weekdays as the next one, same weekday meaning next week", () => {
    expect(p("kirim proposal jumat").due_date).toBe("2026-11-06");
    expect(p("kirim proposal fri").due_date).toBe("2026-11-06");
    expect(p("kirim proposal Jum'at").due_date).toBe("2026-11-06");
    expect(p("rapat senin").due_date).toBe("2026-11-09");
    expect(p("x selasa").due_date).toBe("2026-11-10"); // today is Tuesday
  });

  it("reads 25/12, rolling a past day into next year, and rejects nonsense", () => {
    expect(p("party 25/12").due_date).toBe("2026-12-25");
    expect(p("taxes 1/3").due_date).toBe("2027-03-01");
    expect(p("taxes 1/3/2026").due_date).toBe("2026-03-01");
    expect(p("item 31/02")).toEqual({ title: "item 31/02", priority: 0 });
  });

  it("reads in 3 days and its Indonesian forms", () => {
    expect(p("a in 3 days").due_date).toBe("2026-11-06");
    expect(p("a dalam 3 hari").due_date).toBe("2026-11-06");
    expect(p("a 3 hari lagi").due_date).toBe("2026-11-06");
    expect(p("a minggu depan").due_date).toBe("2026-11-10");
  });
});

describe("times", () => {
  it("reads 18:30, 6pm, jam 18 and jam 6 sore", () => {
    expect(p("a besok 18:30").due_time).toBe("18:30");
    expect(p("a besok 6pm").due_time).toBe("18:00");
    expect(p("a besok 6:15 pm").due_time).toBe("18:15");
    expect(p("a besok 12am").due_time).toBe("00:00");
    expect(p("a besok jam 18")).toMatchObject({ title: "a", due_time: "18:00" });
    expect(p("a besok jam 18.30")).toMatchObject({ title: "a", due_time: "18:30" });
    expect(p("a jam 6 sore besok")).toMatchObject({ title: "a", due_time: "18:00", due_date: "2026-11-04" });
    expect(p("a pukul 1 siang besok").due_time).toBe("13:00");
  });

  it("puts a time without a day on today, or tomorrow once it has passed", () => {
    expect(p("a 18:30")).toMatchObject({ due_date: "2026-11-03", due_time: "18:30" });
    expect(p("a 09:00")).toMatchObject({ due_date: "2026-11-04", due_time: "09:00" });
  });

  it("rejects impossible times", () => {
    expect(p("a 25:00")).toEqual({ title: "a 25:00", priority: 0 });
  });
});

describe("symbols", () => {
  it("reads every priority spelling", () => {
    expect(["!1", "!low", "!rendah"].map((s) => p(`a ${s}`).priority)).toEqual([1, 1, 1]);
    expect(["!2", "!med", "!medium", "!sedang"].map((s) => p(`a ${s}`).priority)).toEqual([2, 2, 2, 2]);
    expect(["!3", "!high", "!tinggi"].map((s) => p(`a ${s}`).priority)).toEqual([3, 3, 3]);
    expect(p("wow!").title).toBe("wow!");
  });

  it("reads symbols anywhere, even before the title", () => {
    expect(p("#kuliah !2 baca jurnal @metpen besok")).toMatchObject({
      title: "baca jurnal",
      list: "kuliah",
      priority: 2,
      course: "metpen",
      due_date: "2026-11-04",
    });
  });

  it("reads estimates as sessions or minutes", () => {
    expect(p("a ~3p")).toMatchObject({ estimate: 3 });
    expect(p("a ~3")).toMatchObject({ estimate: 3 });
    expect(p("a ~25m")).toMatchObject({ estimate: 1, estimateMinutes: 25 });
    expect(p("a ~60m")).toMatchObject({ estimate: 3, estimateMinutes: 60 });
    expect(p("a ~1h")).toMatchObject({ estimate: 3, estimateMinutes: 60 });
  });
});

describe("repeats", () => {
  it("reads every day/week/month and setiap hari/minggu", () => {
    expect(p("minum air every day").repeat).toBe("daily");
    expect(p("minum air setiap hari").repeat).toBe("daily");
    expect(p("bayar kos setiap minggu !high")).toMatchObject({ title: "bayar kos", repeat: "weekly", priority: 3 });
    expect(p("x every week").repeat).toBe("weekly");
    expect(p("x every month").repeat).toBe("monthly");
    expect(p("x tiap bulan").repeat).toBe("monthly");
    expect(p("x every weekday").repeat).toBe("weekdays");
    expect(p("x setiap hari kerja").repeat).toBe("weekdays");
    expect(p("x every 3 days").repeat).toBe("every:3");
    expect(p("x setiap 2 hari").repeat).toBe("every:2");
  });

  it("combines a repeat with a date and time in any order at the end", () => {
    expect(p("standup senin 09:00 every week")).toMatchObject({
      title: "standup",
      due_date: "2026-11-09",
      due_time: "09:00",
      repeat: "weekly",
    });
  });
});

it("leaves an empty title when there is only a date", () => {
  expect(p("besok").title).toBe("");
});
