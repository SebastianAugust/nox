import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import { useTodoDb } from "./todoRepo";
import {
  eventAsTodo,
  extractIntent,
  mayBeTask,
  proposalToDraft,
  validateExtraction,
  type EventProposal,
  type ModelCall,
} from "./captureCore";
import { confirmAction, offerCapture } from "./confirmations";
import { getAction } from "./pendingActions";
import { useGoogleApi, type GoogleApi, type NewEvent } from "./googleCalendar";

// Wednesday 4 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 4, 10, 0);
const model = (answer: unknown): ModelCall => async () => answer;

describe("event intent: schema and resolution", () => {
  it("accepts the event fields and nothing else", () => {
    expect(
      validateExtraction({ intent: "event", title: "rapat", datePhrase: "jumat", timePhrase: "jam 2", endTimePhrase: "jam 4", location: "sekre" }),
    ).toEqual({ intent: "event", title: "rapat", datePhrase: "jumat", timePhrase: "jam 2", endTimePhrase: "jam 4", location: "sekre" });
    expect(validateExtraction({ intent: "event", title: "rapat", attendees: ["x"] })).toBeNull();
    expect(validateExtraction({ intent: "meeting", title: "rapat" })).toBeNull();
    expect(validateExtraction({ intent: "event", title: "rapat", location: "x".repeat(101) })).toBeNull();
    expect(validateExtraction({ intent: "event" })).toBeNull();
    expect(validateExtraction('{"intent":"event","title":"rapat"')).toBeNull();
  });

  it("reads 'jam 2' of an event as 14:00 and uses only words Bas wrote", async () => {
    const p = await extractIntent(
      "rapat himatif jumat jam 2 di sekre",
      model({ intent: "event", title: "rapat himatif", datePhrase: "jumat", timePhrase: "jam 2", location: "sekre" }),
      NOW,
    );
    expect(p).toEqual({ intent: "event", title: "rapat himatif", due_date: "2026-11-06", due_time: "14:00", location: "sekre", source: "model" });

    // An invented day, end or place is dropped, never used.
    const invented = await extractIntent(
      "rapat himatif jam 2",
      model({ intent: "event", title: "rapat himatif", datePhrase: "2026-11-06", timePhrase: "jam 2", endTimePhrase: "jam 3", location: "sekre" }),
      NOW,
    );
    // No day written: today, since 14:00 is still ahead at 10:00 (not tomorrow for "02:00").
    expect(invented).toEqual({ intent: "event", title: "rapat himatif", due_date: "2026-11-04", due_time: "14:00", source: "model" });
  });

  it("keeps an explicit morning and a reminder's own reading", async () => {
    const morning = await extractIntent("rapat besok jam 2 pagi", model({ intent: "event", title: "rapat", datePhrase: "besok", timePhrase: "jam 2 pagi" }), NOW);
    expect(morning).toMatchObject({ due_time: "02:00" });
    const reminder = await extractIntent("ingetin besok jam 5 bangun", model({ intent: "reminder", title: "bangun", datePhrase: "besok", timePhrase: "jam 5" }), NOW);
    expect(reminder).toMatchObject({ intent: "reminder", due_time: "05:00" });
  });

  it("falls back to chat when the model fails on an event-like message", async () => {
    const failing: ModelCall = async () => {
      throw new Error("timeout");
    };
    expect(await extractIntent("rapat himatif jumat jam 2 di sekre", failing, NOW)).toEqual({ intent: "chat" });
    expect(await extractIntent("rapat himatif jumat jam 2 di sekre", model("not json"), NOW)).toEqual({ intent: "chat" });
  });

  it("turns a proposal into the same draft /event uses", () => {
    const p: EventProposal = { intent: "event", title: "rapat", due_date: "2026-11-06", due_time: "14:00", location: "sekre", source: "model" };
    expect(proposalToDraft(p, NOW)).toEqual({
      title: "rapat",
      date: "2026-11-06",
      allDay: false,
      start: "14:00",
      end: "15:00",
      endDate: "2026-11-06",
      location: "sekre",
    });
    expect(proposalToDraft({ intent: "event", title: "dies natalis", source: "model" }, NOW)).toEqual({
      title: "dies natalis",
      date: "2026-11-04",
      allDay: true,
      endDate: "2026-11-05",
    });
    expect(eventAsTodo(p)).toEqual({ intent: "todo", title: "rapat (sekre)", priority: 0, source: "parser", due_date: "2026-11-06", due_time: "14:00" });
  });
});

describe("cheap gate with event words", () => {
  it("lets event messages through and keeps casual talk off the model", () => {
    for (const s of ["rapat himatif jumat", "meeting with the team", "kelas pengganti kamis", "ada acara di aula", "jadwal sidang", "nobar di aula jumat"]) {
      expect(mayBeTask(s), s).toBe(true);
    }
    for (const s of ["lagi capek nih", "aku lagi di kos", "tadi rapatnya lama banget di sekre", "makasih ya"]) {
      expect(mayBeTask(s), s).toBe(false);
    }
  });
});

describe("event confirmation through pending actions", () => {
  let t: ReturnType<typeof openTestDb>;
  let created: NewEvent[];
  const proposal: EventProposal = { intent: "event", title: "rapat himatif", due_date: "2026-11-06", due_time: "14:00", location: "sekre", source: "model" };

  const google = (connected: boolean): GoogleApi => ({
    async status() {
      return { hasClient: true, connected };
    },
    async calendars() {
      return [];
    },
    async syncEvents() {
      return { full: true, events: [], nextSyncToken: null };
    },
    async createEvent(_id, e) {
      created.push(e);
      return { googleId: "n1", cancelled: false, title: e.title, start: "", end: "", allDay: false, location: null, htmlLink: "https://www.google.com/calendar/event?eid=n1", updated: null };
    },
  });

  beforeEach(() => {
    t = openTestDb();
    useTodoDb(t.db);
    created = [];
  });
  afterEach(() => {
    useTodoDb(null);
    useGoogleApi(null);
  });

  it("with Google connected: an event action, created only after Confirm, once", async () => {
    useGoogleApi(google(true));
    const offer = await offerCapture(proposal, "telegram");
    expect((await getAction(offer.id))?.kind).toBe("event");
    expect(created).toEqual([]);
    expect(await confirmAction(offer.id, "telegram")).toContain("https://www.google.com/calendar/event?eid=n1");
    await confirmAction(offer.id, "telegram");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "rapat himatif", location: "sekre", allDay: false });
  });

  it("without Google: says so and offers a todo instead; nothing goes to Google", async () => {
    useGoogleApi(google(false));
    const offer = await offerCapture(proposal, "pet");
    expect(offer.text).toContain("Google Calendar is not connected");
    const a = await getAction(offer.id);
    expect(a?.kind).toBe("capture");
    expect(JSON.parse(a!.payload).proposal).toMatchObject({ intent: "todo", title: "rapat himatif (sekre)", due_date: "2026-11-06" });
    await confirmAction(offer.id, "pet");
    expect(created).toEqual([]);
    expect(t.raw.prepare("SELECT title, due_date, due_time FROM todos").all()).toEqual([
      { title: "rapat himatif (sekre)", due_date: "2026-11-06", due_time: "14:00" },
    ]);
  });
});
