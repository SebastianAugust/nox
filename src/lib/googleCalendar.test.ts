import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "./testSqlite";
import { useTodoDb } from "./todoRepo";
import { calendarStale, getEvents, hasCalendarSource, syncCalendars } from "./calendar";
import {
  clearGoogle,
  getSources,
  setSourceEnabled,
  syncGoogle,
  syncWindow,
  useGoogleApi,
  type GCalendar,
  type GEvent,
  type GoogleApi,
  type NewEvent,
  type SyncResult,
} from "./googleCalendar";
import {
  ACTION_TTL_MS,
  buttonData,
  cancelAction,
  claimAction,
  createAction,
  expireActions,
  getAction,
  parseButton,
} from "./pendingActions";
import { cancelOffer, confirmAction, eventQuestion, offerEvent } from "./confirmations";
import { parseEventText, type EventDraft } from "./eventParse";

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const at = (day: number, h: number, m = 0) => stamp(new Date(2026, 10, day, h, m));
// Wednesday 4 November 2026, 10:00 local.
const NOW = new Date(2026, 10, 4, 10, 0);

let t: ReturnType<typeof openTestDb>;
let calls: string[];

const gev = (id: string, title: string, start: string, end: string, over: Partial<GEvent> = {}): GEvent => ({
  googleId: id,
  cancelled: false,
  title,
  start,
  end,
  allDay: false,
  location: null,
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  updated: null,
  ...over,
});

/** A fake Google: calendars, and per call a queued answer for events.list. */
function fakeGoogle(opts: { connected?: boolean; calendars?: GCalendar[]; sync?: (SyncResult | Error)[]; failCalendars?: boolean } = {}) {
  const sync = [...(opts.sync ?? [])];
  const created: NewEvent[] = [];
  const api: GoogleApi = {
    async status() {
      return { hasClient: true, connected: opts.connected ?? true };
    },
    async calendars() {
      calls.push("calendars");
      if (opts.failCalendars) throw { kind: "offline" };
      return (
        opts.calendars ?? [
          { id: "me@gmail.com", name: "Bas", color: "#4285f4", primary: true, canWrite: true },
          { id: "id.indonesian#holiday@group.v.calendar.google.com", name: "Libur", color: null, primary: false, canWrite: false },
        ]
      );
    },
    async syncEvents(calendarId, syncToken) {
      calls.push(`sync ${calendarId} token=${syncToken ?? "-"}`);
      const next = sync.shift();
      if (!next || next instanceof Error) throw { kind: "offline" };
      return next;
    },
    async createEvent(calendarId, event) {
      calls.push(`create ${calendarId} ${event.title}`);
      created.push(event);
      return gev("new1", event.title, at(6, 14), at(6, 15, 30));
    },
  };
  useGoogleApi(api);
  return { created };
}

beforeEach(() => {
  t = openTestDb();
  useTodoDb(t.db);
  calls = [];
});
afterEach(() => {
  useTodoDb(null);
  useGoogleApi(null);
});

describe("Google sync", () => {
  it("does nothing until connected", async () => {
    fakeGoogle({ connected: false });
    expect(await syncGoogle(NOW)).toEqual({ connected: false, error: null });
    expect(calls).toEqual([]);
  });

  it("turns the primary calendar on by default, others off, and stores a full window", async () => {
    fakeGoogle({ sync: [{ full: true, events: [gev("a", "Prak Jarkom", at(4, 13), at(4, 15))], nextSyncToken: "s1" }] });
    await syncGoogle(NOW);
    expect((await getSources()).map((s) => [s.name, s.enabled, s.is_primary])).toEqual([
      ["Bas", 1, 1],
      ["Libur", 0, 0],
    ]);
    expect(calls).toEqual(["calendars", "sync me@gmail.com token=-"]);
    expect((await getEvents("2026-11-04", "2026-11-04")).map((e) => e.title)).toEqual(["Prak Jarkom"]);
    expect(await hasCalendarSource()).toBe(true);
  });

  it("is incremental the same day, removes cancelled events, and resyncs fully on a new day", async () => {
    fakeGoogle({
      sync: [
        { full: true, events: [gev("a", "A", at(4, 13), at(4, 14)), gev("b", "B", at(4, 16), at(4, 17))], nextSyncToken: "s1" },
        { full: false, events: [gev("a", "", "", "", { cancelled: true }), gev("c", "C", at(5, 8), at(5, 9))], nextSyncToken: "s2" },
        { full: true, events: [gev("c", "C", at(5, 8), at(5, 9))], nextSyncToken: "s3" },
      ],
    });
    await syncGoogle(NOW);
    await syncGoogle(new Date(2026, 10, 4, 10, 30));
    expect(calls).toContain("sync me@gmail.com token=s1");
    expect((await getEvents("2026-11-04", "2026-11-05")).map((e) => e.title)).toEqual(["B", "C"]);
    // Next day: no token, so the window moves along.
    await syncGoogle(new Date(2026, 10, 5, 7, 0));
    expect(calls[calls.length - 1]).toBe("sync me@gmail.com token=-");
    expect((await getSources())[0].sync_token).toBe("s3");
  });

  it("keeps the last good events when a sync fails, and marks them stale", async () => {
    fakeGoogle({ sync: [{ full: true, events: [gev("a", "A", at(4, 13), at(4, 14))], nextSyncToken: "s1" }, new Error("x")] });
    await syncGoogle(NOW);
    await syncGoogle(NOW);
    expect((await getEvents("2026-11-04", "2026-11-04")).length).toBe(1);
    expect(await calendarStale()).toBe(true);
    // Offline before the calendar list: also kept, also stale.
    fakeGoogle({ failCalendars: true });
    expect((await syncGoogle(NOW)).error).toEqual({ kind: "offline" });
    expect((await getEvents("2026-11-04", "2026-11-04")).length).toBe(1);
  });

  it("shows Google next to iCal feeds, hides disabled calendars, and Disconnect clears them", async () => {
    fakeGoogle({ sync: [{ full: true, events: [gev("a", "Google A", at(4, 13), at(4, 14))], nextSyncToken: "s1" }] });
    await syncGoogle(NOW);
    t.raw.exec("INSERT INTO calendar_feeds (name) VALUES ('Kampus')");
    await syncCalendars(async () => [{ uid: "k", start: at(4, 8), end: at(4, 9), all_day: 0, title: "Kampus 8", location: null }]);
    expect((await getEvents("2026-11-04", "2026-11-04")).map((e) => e.title)).toEqual(["Kampus 8", "Google A"]);
    await setSourceEnabled("me@gmail.com", false);
    expect((await getEvents("2026-11-04", "2026-11-04")).map((e) => e.title)).toEqual(["Kampus 8"]);
    expect((await getSources())[0]).toMatchObject({ sync_token: null, window_day: null });
    await clearGoogle();
    expect(await getSources()).toEqual([]);
    expect((await getEvents("2026-11-04", "2026-11-04")).map((e) => e.title)).toEqual(["Kampus 8"]);
  });

  it("asks Google for yesterday to +30 days", () => {
    const w = syncWindow(NOW);
    expect(new Date(w.timeMin).getTime()).toBe(new Date(2026, 10, 3).getTime());
    expect(new Date(w.timeMax).getTime()).toBe(new Date(2026, 11, 5).getTime());
  });
});

describe("pending actions", () => {
  it("can be confirmed once, only where it was offered, and expires after 10 minutes", async () => {
    const id = await createAction("event", { x: 1 }, "telegram", NOW);
    expect(await claimAction(id, "pet", NOW)).toEqual({ ok: false, reason: "otherSource" });
    const first = await claimAction(id, "telegram", NOW);
    expect(first.ok).toBe(true);
    expect(await claimAction(id, "telegram", NOW)).toEqual({ ok: false, reason: "used" });

    const late = await createAction("event", {}, "pet", NOW);
    const after = new Date(NOW.getTime() + ACTION_TTL_MS + 1000);
    expect(await claimAction(late, "pet", after)).toEqual({ ok: false, reason: "expired" });
    expect((await getAction(late))?.status).toBe("expired");
    expect(await claimAction(999, "pet", NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("cancels only a pending one, and expires overdue ones in bulk", async () => {
    const id = await createAction("capture", {}, "pet", NOW);
    expect(await cancelAction(id, "telegram")).toBe(false);
    expect(await cancelAction(id, "pet")).toBe(true);
    expect(await cancelAction(id, "pet")).toBe(false);
    const old = await createAction("capture", {}, "pet", new Date(NOW.getTime() - ACTION_TTL_MS - 1));
    await expireActions(NOW);
    expect((await getAction(old))?.status).toBe("expired");
  });

  it("reads only its own button data", () => {
    expect(parseButton(buttonData(12, true))).toEqual({ id: 12, yes: true });
    expect(parseButton("pa:no:3")).toEqual({ id: 3, yes: false });
    for (const bad of ["cap:yes:1", "pa:maybe:1", "pa:yes:", "pa:yes:1:2", "pa:yes:abc"]) expect(parseButton(bad)).toBeNull();
  });
});

describe("/event confirmation", () => {
  const draft = (text: string): EventDraft => {
    const r = parseEventText(text, NOW);
    if (!r.ok) throw new Error(r.error);
    return r.draft;
  };

  beforeEach(async () => {
    fakeGoogle({ sync: [{ full: true, events: [gev("x", "Jarkom", at(6, 13), at(6, 14, 30))], nextSyncToken: "s1" }] });
    await syncGoogle(NOW);
    calls = [];
  });

  it("previews with an overlap warning and creates nothing before Confirm", async () => {
    const offer = await offerEvent(draft("rapat himatif jumat 14:00-15:30 di sekre"), "telegram");
    expect(offer.text).toContain("rapat himatif");
    expect(offer.text).toContain("sekre");
    expect(offer.text).toContain("Jarkom");
    expect(calls).toEqual([]);
    expect(await eventQuestion(draft("rapat jumat 16:00"), NOW)).not.toContain("Jarkom");
  });

  it("Confirm creates it once, stores it with its link; Cancel creates nothing", async () => {
    const g = fakeGoogle();
    const offer = await offerEvent(draft("rapat himatif jumat 14:00-15:30 di sekre"), "pet");
    const reply = await confirmAction(offer.id, "pet");
    expect(reply).toContain("https://www.google.com/calendar/event?eid=new1");
    expect(await confirmAction(offer.id, "pet")).toBe("That was already answered.");
    expect(calls.filter((c) => c.startsWith("create"))).toEqual(["create me@gmail.com rapat himatif"]);
    expect(g.created[0]).toMatchObject({ title: "rapat himatif", allDay: false, location: "sekre" });
    expect(g.created[0].start).toMatch(/^2026-11-06T14:00:00/);
    const stored = (await getEvents("2026-11-06", "2026-11-06")).find((e) => e.google_id === "new1");
    expect(stored?.html_link).toBe("https://www.google.com/calendar/event?eid=new1");
    expect((await getAction(offer.id))?.status).toBe("done");

    const other = await offerEvent(draft("rapat lain jumat 16:00"), "telegram");
    expect(await cancelOffer(other.id, "telegram")).toBe("Okay, nothing added.");
    expect(await confirmAction(other.id, "telegram")).toBe("That was already answered.");
    expect(calls.filter((c) => c.startsWith("create")).length).toBe(1);
  });

  it("an expired confirmation creates nothing", async () => {
    const offer = await offerEvent(draft("rapat jumat 16:00"), "telegram");
    t.raw.exec(`UPDATE pending_actions SET expires_at = '2000-01-01 00:00:00' WHERE id = ${offer.id}`);
    expect(await confirmAction(offer.id, "telegram")).toBe("That confirmation has expired. Send it again.");
    expect(calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });
});
