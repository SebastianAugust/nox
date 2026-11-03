import { describe, expect, it } from "vitest";
import { findPlace, parseCommand, parseReminderTime, renderResult, type Translate } from "./commands";

// Wednesday 10 June 2026, 14:30 local time.
const NOW = new Date(2026, 5, 10, 14, 30);

// Echo translator: the key plus its params, so tests do not depend on copy.
const tr: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

describe("parseCommand", () => {
  it("leaves plain chat alone", () => {
    expect(parseCommand("hello nox", NOW)).toBeNull();
    expect(parseCommand("  what is /todo?", NOW)).toBeNull();
  });

  it("knows Indonesian names, English aliases and is case-insensitive", () => {
    expect(parseCommand("/tugas", NOW)).toEqual({ kind: "tasks" });
    expect(parseCommand("/TASKS", NOW)).toEqual({ kind: "tasks" });
    expect(parseCommand("/Cuaca", NOW)).toEqual({ kind: "weather" });
    expect(parseCommand("/weather", NOW)).toEqual({ kind: "weather" });
    expect(parseCommand("/bantu", NOW)).toEqual({ kind: "help" });
    expect(parseCommand("/help", NOW)).toEqual({ kind: "help" });
    expect(parseCommand("/start", NOW)).toEqual({ kind: "help" });
    expect(parseCommand("/stop", NOW)).toEqual({ kind: "stop" });
    expect(parseCommand("/status", NOW)).toEqual({ kind: "status" });
  });

  it("strips a Telegram @BotName suffix", () => {
    expect(parseCommand("/tugas@NoxBot 2", NOW)).toEqual({ kind: "tasks", n: 2 });
  });

  it("reads /tugas <n> and rejects a non-number", () => {
    expect(parseCommand("/tugas 3", NOW)).toEqual({ kind: "tasks", n: 3 });
    expect(parseCommand("/tugas abc", NOW)).toEqual({ kind: "error", error: "badNumber" });
    expect(parseCommand("/tugas 0", NOW)).toEqual({ kind: "error", error: "badNumber" });
  });

  it("adds and lists todos", () => {
    expect(parseCommand("/todo beli kopi besok", NOW)).toEqual({
      kind: "todoAdd",
      title: "beli kopi",
      due_date: "2026-06-11",
    });
    expect(parseCommand("/todo list", NOW)).toEqual({ kind: "todoList" });
    expect(parseCommand("/todo LIST", NOW)).toEqual({ kind: "todoList" });
    expect(parseCommand("/todo", NOW)).toEqual({ kind: "error", error: "todoEmpty" });
    expect(parseCommand("/todo besok", NOW)).toEqual({ kind: "todoAdd", title: "besok" });
  });

  it("reads /done <n>", () => {
    expect(parseCommand("/done 2", NOW)).toEqual({ kind: "done", n: 2 });
    expect(parseCommand("/done", NOW)).toEqual({ kind: "error", error: "badNumber" });
  });

  it("reads /fokus with and without minutes", () => {
    expect(parseCommand("/fokus", NOW)).toEqual({ kind: "focus" });
    expect(parseCommand("/fokus 5", NOW)).toEqual({ kind: "focus", minutes: 5 });
    expect(parseCommand("/focus 50m", NOW)).toEqual({ kind: "focus", minutes: 50 });
    expect(parseCommand("/fokus 999", NOW)).toEqual({ kind: "error", error: "badMinutes" });
  });

  it("answers an unknown command with its name", () => {
    expect(parseCommand("/rm -rf /", NOW)).toEqual({ kind: "unknown", name: "rm" });
  });

  it("supports the pet-only commands", () => {
    expect(parseCommand("/clear", NOW)).toEqual({ kind: "clear" });
    expect(parseCommand("/dashboard", NOW)).toEqual({ kind: "dashboard" });
  });
});

describe("reminder times", () => {
  it("reads 10m and 2h relative to now", () => {
    expect(parseReminderTime("10m tes", NOW)).toEqual({ at: new Date(2026, 5, 10, 14, 40), title: "tes" });
    expect(parseReminderTime("2h minum", NOW)?.at).toEqual(new Date(2026, 5, 10, 16, 30));
    expect(parseReminderTime("2 jam minum", NOW)?.at).toEqual(new Date(2026, 5, 10, 16, 30));
    expect(parseReminderTime("15 menit stretch", NOW)?.at).toEqual(new Date(2026, 5, 10, 14, 45));
  });

  it("reads a clock time today, or tomorrow once it has passed", () => {
    expect(parseReminderTime("18:30 masak", NOW)?.at).toEqual(new Date(2026, 5, 10, 18, 30));
    expect(parseReminderTime("09:00 standup", NOW)?.at).toEqual(new Date(2026, 5, 11, 9, 0));
  });

  it("reads besok HH:MM", () => {
    expect(parseReminderTime("besok 08:00 kuliah", NOW)).toEqual({
      at: new Date(2026, 5, 11, 8, 0),
      title: "kuliah",
    });
  });

  it("builds /ingat commands and keeps the old /remind form", () => {
    expect(parseCommand("/ingat 2m tes", NOW)).toEqual({
      kind: "remind",
      title: "tes",
      at: new Date(2026, 5, 10, 14, 32),
    });
    const old = parseCommand("/remind standup at 18:00", NOW);
    expect(old).toEqual({ kind: "remind", title: "standup", at: new Date(2026, 5, 10, 18, 0) });
    expect(parseCommand("/ingat makan nanti", NOW)).toEqual({ kind: "error", error: "remindNoTime" });
    expect(parseCommand("/ingat 25:00 x", NOW)).toEqual({ kind: "error", error: "remindNoTime" });
    expect(parseCommand("/ingat", NOW)).toEqual({ kind: "error", error: "remindEmpty" });
  });
});

describe("renderResult", () => {
  it("numbers the task list with course and urgency", () => {
    const text = renderResult(
      {
        kind: "tasks",
        items: [
          { n: 1, name: "Essay", course: "Ethics", due_date: "2026-06-09", urgency: { kind: "overdue", days: 1 } },
          { n: 2, name: "Lab", course: null, due_date: "2026-06-13", urgency: { kind: "days", days: 3 } },
        ],
      },
      tr,
      NOW,
    );
    expect(text.split("\n")).toEqual([
      "cmd.tasks.head",
      '1. Essay · Ethics · due.overdueDays {"n":1}',
      '2. Lab · due.inDays {"n":3}',
      "cmd.tasks.hint",
    ]);
  });

  it("says tomorrow for a reminder past midnight", () => {
    const text = renderResult({ kind: "reminderSet", title: "x", at: new Date(2026, 5, 11, 8, 0) }, tr, NOW);
    expect(text).toContain("cmd.remind.tomorrowAt");
  });

  it("gives unknown commands a short help hint", () => {
    expect(renderResult({ kind: "unknown", name: "foo" }, tr)).toBe('cmd.unknown {"name":"foo"}');
  });
});

describe("/lokasi", () => {
  it("shows the active place, or switches by name", () => {
    expect(parseCommand("/lokasi", NOW)).toEqual({ kind: "place" });
    expect(parseCommand("/lokasi Kampus", NOW)).toEqual({ kind: "place", name: "Kampus" });
    expect(parseCommand("/location rumah kos", NOW)).toEqual({ kind: "place", name: "rumah kos" });
  });

  it("finds a saved place ignoring case, then by a unique start", () => {
    const places = [
      { id: 1, name: "Jatinangor" },
      { id: 2, name: "Kampus" },
      { id: 3, name: "Kampus Dipatiukur" },
    ];
    expect(findPlace(places, "kampus")?.id).toBe(2);
    expect(findPlace(places, "JATI")?.id).toBe(1);
    expect(findPlace(places, "Kamp")).toBeNull(); // two candidates: unclear
    expect(findPlace(places, "Rumah")).toBeNull();
  });

  it("renders switching, a miss with the saved names, and the active place", () => {
    expect(renderResult({ kind: "placeSwitched", name: "Kampus", line: "rain" }, tr)).toBe(
      'cmd.place.switched {"name":"Kampus"}\nrain',
    );
    expect(renderResult({ kind: "placeMissing", name: "Rumah", names: ["Jatinangor", "Kampus"] }, tr)).toBe(
      'cmd.place.missing {"name":"Rumah","names":"Jatinangor, Kampus"}',
    );
    expect(
      renderResult({ kind: "placeShow", name: "Jatinangor", detail: "Jatinangor, West Java", others: [] }, tr).split("\n"),
    ).toEqual(['cmd.place.active {"name":"Jatinangor","detail":"Jatinangor, West Java"}', "cmd.place.addHint"]);
  });
});
