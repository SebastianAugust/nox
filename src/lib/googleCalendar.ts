import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { asApiError, type ApiError } from "./api";
import { localDay } from "./calendarLogic";
import { isTestDb, sqlDb } from "./todoRepo";

/**
 * Google Calendar from the frontend's side. Rust holds every secret (client
 * id/secret, refresh token, access token) and does all HTTP; this module
 * keeps the local copy in `calendar_sources` / `calendar_events`.
 *
 * Sync (pet window, with the iCal feeds: start, every 30 minutes, "Sync
 * now"): the calendar list first (new calendars: the primary one on, others
 * off), then per enabled calendar `events.list` with singleEvents over
 * yesterday … +30 days. The sync token makes later runs incremental; a new
 * day, a re-enabled calendar or a 410 from Google means a full resync. A
 * failure keeps the last good events and records the error (stale mark).
 */

export const DAYS_BACK = 1;
export const DAYS_AHEAD = 30;

export type GoogleStatus = { hasClient: boolean; connected: boolean };
export type GCalendar = { id: string; name: string; color: string | null; primary: boolean; canWrite: boolean };
export type GEvent = {
  googleId: string;
  cancelled: boolean;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  htmlLink: string | null;
  updated: string | null;
};
export type SyncResult = { full: boolean; events: GEvent[]; nextSyncToken: string | null };
export type NewEvent = { title: string; start: string; end: string; allDay: boolean; location: string | null };

export type GoogleApi = {
  status(): Promise<GoogleStatus>;
  calendars(): Promise<GCalendar[]>;
  syncEvents(calendarId: string, syncToken: string | null, timeMin: string, timeMax: string): Promise<SyncResult>;
  createEvent(calendarId: string, event: NewEvent): Promise<GEvent>;
};

const tauriApi: GoogleApi = {
  status: () => invoke("google_status"),
  calendars: () => invoke("google_calendars"),
  syncEvents: (calendarId, syncToken, timeMin, timeMax) => invoke("google_sync_events", { calendarId, syncToken, timeMin, timeMax }),
  createEvent: (calendarId, event) => invoke("google_create_event", { calendarId, event }),
};
let api = tauriApi;
/** Tests only. */
export function useGoogleApi(a: GoogleApi | null) {
  api = a ?? tauriApi;
}

function announce() {
  if (isTestDb()) return;
  emit("calendar:status").catch(() => {});
}

export type CalendarSource = {
  calendar_id: string;
  name: string;
  color: string | null;
  enabled: number;
  is_primary: number;
  sync_token: string | null;
  window_day: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  events: number;
};

export async function getSources(): Promise<CalendarSource[]> {
  const db = await sqlDb();
  return db.select(
    `SELECT s.*, (SELECT COUNT(*) FROM calendar_events e WHERE e.source = 'google' AND e.calendar_id = s.calendar_id) AS events
     FROM calendar_sources s ORDER BY s.is_primary DESC, s.name`,
  );
}

export async function setSourceEnabled(calendarId: string, enabled: boolean): Promise<void> {
  const db = await sqlDb();
  // Re-enabled: start over with a full sync (the token may be stale).
  await db.execute("UPDATE calendar_sources SET enabled = ?, sync_token = NULL, window_day = NULL WHERE calendar_id = ?", [
    enabled ? 1 : 0,
    calendarId,
  ]);
  announce();
  if (enabled && !isTestDb()) emit("calendar:sync").catch(() => {});
}

/** Forget every Google calendar and its events (after Disconnect). */
export async function clearGoogle(): Promise<void> {
  const db = await sqlDb();
  await db.execute("DELETE FROM calendar_events WHERE source = 'google'");
  await db.execute("DELETE FROM calendar_sources");
  announce();
}

export async function googleStatus(): Promise<GoogleStatus> {
  return api.status();
}

/** Yesterday's start … 31 days later, as UTC RFC 3339. */
export function syncWindow(now: Date): { timeMin: string; timeMax: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DAYS_BACK);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + DAYS_AHEAD + 1);
  const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");
  return { timeMin: iso(from), timeMax: iso(to) };
}

async function storeCalendars(cals: GCalendar[]): Promise<void> {
  const db = await sqlDb();
  for (const c of cals) {
    await db.execute(
      `INSERT INTO calendar_sources (calendar_id, name, color, enabled, is_primary) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(calendar_id) DO UPDATE SET name = excluded.name, color = excluded.color, is_primary = excluded.is_primary`,
      [c.id, c.name.slice(0, 200), c.color, c.primary ? 1 : 0, c.primary ? 1 : 0],
    );
  }
  // Calendars Bas no longer sees go, with their events.
  const keep = new Set(cals.map((c) => c.id));
  for (const s of await getSources()) {
    if (keep.has(s.calendar_id)) continue;
    await db.execute("DELETE FROM calendar_events WHERE source = 'google' AND calendar_id = ?", [s.calendar_id]);
    await db.execute("DELETE FROM calendar_sources WHERE calendar_id = ?", [s.calendar_id]);
  }
}

async function insertEvent(calendarId: string, e: GEvent): Promise<void> {
  const db = await sqlDb();
  await db.execute(
    `INSERT INTO calendar_events (feed_id, uid, start, end, all_day, title, location, source, calendar_id, google_id, status, updated_at, html_link)
     VALUES (0, ?, ?, ?, ?, ?, ?, 'google', ?, ?, 'confirmed', ?, ?)`,
    [e.googleId, e.start, e.end, e.allDay ? 1 : 0, e.title.slice(0, 300), e.location?.slice(0, 300) ?? null, calendarId, e.googleId, e.updated, e.htmlLink],
  );
}

async function applySync(calendarId: string, r: SyncResult, today: string): Promise<void> {
  const db = await sqlDb();
  if (r.full) {
    await db.execute("DELETE FROM calendar_events WHERE source = 'google' AND calendar_id = ?", [calendarId]);
    for (const e of r.events) if (!e.cancelled) await insertEvent(calendarId, e);
  } else {
    for (const e of r.events) {
      await db.execute("DELETE FROM calendar_events WHERE source = 'google' AND calendar_id = ? AND google_id = ?", [calendarId, e.googleId]);
      if (!e.cancelled) await insertEvent(calendarId, e);
    }
  }
  await db.execute(
    `UPDATE calendar_sources SET sync_token = ?, window_day = CASE WHEN ? THEN ? ELSE window_day END,
       last_synced_at = datetime('now'), last_error = NULL WHERE calendar_id = ?`,
    [r.nextSyncToken, r.full ? 1 : 0, today, calendarId],
  );
}

/** Sync every enabled Google calendar. Never throws; errors are stored. */
export async function syncGoogle(now = new Date()): Promise<{ connected: boolean; error: ApiError | null }> {
  const db = await sqlDb();
  let status: GoogleStatus;
  try {
    status = await api.status();
  } catch {
    return { connected: false, error: null };
  }
  if (!status.connected) return { connected: false, error: null };

  let error: ApiError | null = null;
  try {
    await storeCalendars(await api.calendars());
  } catch (err) {
    // Keep the calendars and events we have; mark them all as stale.
    error = asApiError(err);
    await db.execute("UPDATE calendar_sources SET last_error = ? WHERE enabled = 1", [JSON.stringify(error)]);
    announce();
    return { connected: true, error };
  }

  const today = localDay(now);
  const { timeMin, timeMax } = syncWindow(now);
  for (const s of (await getSources()).filter((x) => x.enabled)) {
    // A new day moves the window: start over with a full list.
    const token = s.window_day === today ? s.sync_token : null;
    try {
      await applySync(s.calendar_id, await api.syncEvents(s.calendar_id, token, timeMin, timeMax), today);
    } catch (err) {
      error = asApiError(err);
      await db.execute("UPDATE calendar_sources SET last_error = ? WHERE calendar_id = ?", [JSON.stringify(error), s.calendar_id]);
    }
  }
  announce();
  return { connected: true, error };
}

/** The calendar new events go to: the primary one. */
export async function targetCalendar(): Promise<string> {
  const db = await sqlDb();
  const [row] = await db.select<{ calendar_id: string }[]>("SELECT calendar_id FROM calendar_sources WHERE is_primary = 1");
  return row?.calendar_id ?? "primary";
}

/** Create the event in Google and in the local copy at once. */
export async function createGoogleEvent(event: NewEvent): Promise<GEvent> {
  const calendarId = await targetCalendar();
  const created = await api.createEvent(calendarId, event);
  // Shown at once (Home, /jadwal); the next sync brings the same id back.
  const db = await sqlDb();
  await db.execute("DELETE FROM calendar_events WHERE source = 'google' AND calendar_id = ? AND google_id = ?", [calendarId, created.googleId]);
  const [src] = await db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM calendar_sources WHERE calendar_id = ?", [calendarId]);
  if (src?.n) await insertEvent(calendarId, created);
  announce();
  return created;
}

// ── Connection (Integrations) ──

/** Store the OAuth client in Credential Manager (write-only). */
export function saveGoogleClient(clientId: string, clientSecret: string): Promise<void> {
  return invoke("google_set_client", { clientId, clientSecret });
}

/** Opens the browser; resolves after Google redirected back (or fails). */
export async function connectGoogle(): Promise<{ canCreate: boolean }> {
  const r = await invoke<{ canCreate: boolean }>("google_connect");
  if (!isTestDb()) emit("calendar:sync").catch(() => {});
  return r;
}

/** Revoke with Google, delete the token, and forget Google's calendars here. */
export async function disconnectGoogle(): Promise<{ revoked: boolean }> {
  const r = await invoke<{ revoked: boolean }>("google_disconnect");
  await clearGoogle();
  return r;
}

export async function removeGoogleClient(): Promise<void> {
  await invoke("google_clear_client");
  await clearGoogle();
}
