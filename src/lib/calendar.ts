import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { asApiError } from "./api";
import { dayBoundsUtc, dueEventNudges, nudgeKey, type CalendarEvent } from "./calendarLogic";
import { isTestDb, sqlDb } from "./todoRepo";

/**
 * Calendar feeds (ICS), read-only. The URL goes straight to Credential
 * Manager through Rust (`calendar_feed_set`); only an id and a name are kept
 * here. The pet window syncs on start, every 30 minutes and on "Sync now"
 * ("calendar:sync"); a failed fetch keeps the last good events and records
 * the error (shown as stale). Announces "calendar:status".
 */

export const MAX_FEEDS = 5;
const INTERVAL_MS = 30 * 60 * 1000;
const DAYS_BACK = 1;
const DAYS_AHEAD = 30;

export type CalendarFeed = {
  id: number;
  name: string;
  enabled: number;
  last_synced_at: string | null;
  last_error: string | null;
  events: number;
};

function announce() {
  if (isTestDb()) return;
  emit("calendar:status").catch(() => {});
}

export async function getFeeds(): Promise<CalendarFeed[]> {
  const db = await sqlDb();
  return db.select(
    `SELECT f.id, f.name, f.enabled, f.last_synced_at, f.last_error,
            (SELECT COUNT(*) FROM calendar_events e WHERE e.feed_id = f.id) AS events
     FROM calendar_feeds f ORDER BY f.id`,
  );
}

export type AddFeedResult = "added" | "full" | "invalid";

/** Add a feed; the URL is handed to Rust and never stored here. */
export async function addFeed(name: string, url: string): Promise<AddFeedResult> {
  const n = name.trim().slice(0, 60);
  if (!n || !url.trim()) return "invalid";
  if ((await getFeeds()).length >= MAX_FEEDS) return "full";
  const db = await sqlDb();
  const r = await db.execute("INSERT INTO calendar_feeds (name) VALUES (?)", [n]);
  const id = r.lastInsertId ?? 0;
  try {
    await invoke("calendar_feed_set", { feedId: id, url });
  } catch {
    await db.execute("DELETE FROM calendar_feeds WHERE id = ?", [id]);
    return "invalid";
  }
  announce();
  emit("calendar:sync").catch(() => {});
  return "added";
}

export async function removeFeed(id: number): Promise<void> {
  const db = await sqlDb();
  await db.execute("DELETE FROM calendar_feeds WHERE id = ?", [id]);
  await invoke("calendar_feed_delete", { feedId: id }).catch(console.error);
  announce();
}

export async function setFeedEnabled(id: number, enabled: boolean): Promise<void> {
  const db = await sqlDb();
  await db.execute("UPDATE calendar_feeds SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  announce();
  if (enabled) emit("calendar:sync").catch(() => {});
}

export type FetchFeed = (feedId: number, timeZone: string | null) => Promise<Omit<CalendarEvent, "id" | "feed_id">[]>;

const tauriFetch: FetchFeed = async (feedId, timeZone) => {
  const rows = await invoke<{ uid: string; start: string; end: string; allDay: boolean; title: string; location: string | null }[]>(
    "calendar_fetch",
    { feedId, daysBack: DAYS_BACK, daysAhead: DAYS_AHEAD, timeZone },
  );
  return rows.map((r) => ({ uid: r.uid, start: r.start, end: r.end, all_day: r.allDay ? 1 : 0, title: r.title, location: r.location }));
};

/** Fetch every enabled feed. A failure keeps that feed's last good events. */
export async function syncCalendars(fetchFeed: FetchFeed = tauriFetch): Promise<void> {
  const db = await sqlDb();
  const [tz] = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = 'user_timezone'");
  const feeds = (await getFeeds()).filter((f) => f.enabled);
  for (const f of feeds) {
    try {
      const events = await fetchFeed(f.id, tz?.value?.trim() || null);
      await db.execute("DELETE FROM calendar_events WHERE feed_id = ?", [f.id]);
      for (const e of events) {
        await db.execute(
          "INSERT INTO calendar_events (feed_id, uid, start, end, all_day, title, location) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [f.id, e.uid, e.start, e.end, e.all_day, e.title.slice(0, 300), e.location?.slice(0, 300) ?? null],
        );
      }
      await db.execute("UPDATE calendar_feeds SET last_synced_at = datetime('now'), last_error = NULL WHERE id = ?", [f.id]);
    } catch (err) {
      await db.execute("UPDATE calendar_feeds SET last_error = ? WHERE id = ?", [JSON.stringify(asApiError(err)), f.id]);
    }
  }
  announce();
}

/** Events of enabled feeds touching the local days [fromDay, toDay]. */
export async function getEvents(fromDay: string, toDay: string): Promise<CalendarEvent[]> {
  const db = await sqlDb();
  const [fromUtc] = dayBoundsUtc(fromDay);
  const [, toUtc] = dayBoundsUtc(toDay);
  return db.select(
    `SELECT e.* FROM calendar_events e JOIN calendar_feeds f ON f.id = e.feed_id AND f.enabled = 1
     WHERE (e.all_day = 1 AND e.start <= ? AND e.end > ?)
        OR (e.all_day = 0 AND e.start < ? AND e.end >= ?)
     ORDER BY e.all_day DESC, e.start`,
    [toDay, fromDay, toUtc, fromUtc],
  );
}

/** Some enabled feed failed its last fetch: what is shown may be old. */
export async function calendarStale(): Promise<boolean> {
  const db = await sqlDb();
  const [r] = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM calendar_feeds WHERE enabled = 1 AND last_error IS NOT NULL");
  return (r?.n ?? 0) > 0;
}

/** Event nudges due now; each is recorded before it is returned. */
export async function takeEventNudges(now = new Date()): Promise<CalendarEvent[]> {
  const db = await sqlDb();
  const [m] = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key = 'calendar_nudge_minutes'");
  const minutes = Number(m?.value ?? 15);
  if (!(minutes > 0)) return [];
  const today = new Date(now);
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const events = await getEvents(day(today), day(tomorrow));
  const sent = new Set((await db.select<{ event_key: string }[]>("SELECT event_key FROM calendar_nudges_sent")).map((r) => r.event_key));
  const due = dueEventNudges(events, sent, now, minutes);
  for (const e of due) await db.execute("INSERT OR IGNORE INTO calendar_nudges_sent (event_key) VALUES (?)", [nudgeKey(e)]);
  return due;
}

/** Start syncing (and nudging) in the pet window. Returns a stop function. */
export function startCalendar(onNudge: (events: CalendarEvent[]) => void): () => void {
  let stopped = false;
  const sync = () => void syncCalendars().catch(console.error);
  const nudge = () =>
    void takeEventNudges()
      .then((due) => {
        // Already recorded, so it must go out even if stopped meanwhile.
        if (due.length) onNudge(due);
      })
      .catch(console.error);
  sync();
  nudge();
  const syncTimer = setInterval(sync, INTERVAL_MS);
  const nudgeTimer = setInterval(() => !stopped && nudge(), 60 * 1000);
  const unlisten = listen("calendar:sync", sync);
  return () => {
    stopped = true;
    clearInterval(syncTimer);
    clearInterval(nudgeTimer);
    unlisten.then((off) => off()).catch(console.error);
  };
}
