import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getDb } from "./db";
import { getSetting, setSetting } from "./db-helpers";
import { pickPlace, placeLabel, type Place } from "./weather";

/**
 * Saved places (Rumah, Kampus, ...). Exactly one is active (setting
 * `active_place_id`); weather and with it the briefing and /cuaca use it.
 * Seeded once with "Jatinangor" through Open-Meteo geocoding. Changing the
 * active place announces "settings:changed" so every window refreshes.
 */

export type SavedPlace = {
  id: number;
  name: string;
  label: string | null;
  latitude: number;
  longitude: number;
};

const SEED_QUERY = "Jatinangor, Sumedang";
const MAX_NAME = 40;

export async function getPlaces(): Promise<SavedPlace[]> {
  const db = await getDb();
  return db.select("SELECT id, name, label, latitude, longitude FROM places ORDER BY id ASC");
}

async function announce() {
  await emit("settings:changed", { key: "active_place_id" }).catch(console.error);
}

export async function setActivePlace(id: number): Promise<void> {
  await setSetting("active_place_id", String(id));
  await announce();
}

/** Save a place; it becomes active unless `activate` is false. */
export async function addPlace(
  p: { name: string; label?: string | null; latitude: number; longitude: number },
  activate = true,
): Promise<SavedPlace> {
  const name = p.name.trim().slice(0, MAX_NAME) || `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;
  const db = await getDb();
  const r = await db.execute("INSERT INTO places (name, label, latitude, longitude) VALUES (?, ?, ?, ?)", [
    name,
    p.label ?? null,
    p.latitude,
    p.longitude,
  ]);
  const saved = { id: r.lastInsertId ?? 0, name, label: p.label ?? null, latitude: p.latitude, longitude: p.longitude };
  if (activate) await setActivePlace(saved.id);
  else await announce();
  return saved;
}

/** Remove a place. The last one stays; removing the active one activates another. */
export async function deletePlace(id: number): Promise<void> {
  const places = await getPlaces();
  if (places.length <= 1) return;
  const db = await getDb();
  await db.execute("DELETE FROM places WHERE id = ?", [id]);
  if ((await getSetting("active_place_id")) === String(id)) {
    await setActivePlace(places.find((p) => p.id !== id)!.id);
  } else {
    await announce();
  }
}

/** Geocoding results for a search, best guess first. */
export async function searchPlaces(query: string): Promise<Place[]> {
  const name = query.split(",")[0].trim();
  if (!name) return [];
  const results = await invoke<Place[]>("weather_geocode", { name });
  const best = pickPlace(results, query);
  return best ? [best, ...results.filter((r) => r !== best)] : results;
}

let seeding: Promise<SavedPlace | null> | null = null;

/** First run: save "Jatinangor" (geocoded) as the active place. */
function seed(): Promise<SavedPlace | null> {
  seeding ??= (async () => {
    const query = (await getSetting("weather_location"))?.trim() || SEED_QUERY;
    const [best] = await searchPlaces(query);
    if (!best) return null;
    const db = await getDb();
    // Guarded, in case the other window seeded meanwhile.
    await db.execute(
      `INSERT INTO places (name, label, latitude, longitude)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM places)`,
      [query.split(",")[0].trim(), placeLabel(best), best.latitude, best.longitude],
    );
    const [first] = await getPlaces();
    if (first) await setSetting("active_place_id", String(first.id));
    return first ?? null;
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

/** The active place (seeding the first one if there is none), or null offline on first run. */
export async function getActivePlace(): Promise<SavedPlace | null> {
  const places = await getPlaces();
  if (places.length === 0) return seed().catch(() => null);
  const id = Number(await getSetting("active_place_id"));
  const active = places.find((p) => p.id === id);
  if (active) return active;
  await setSetting("active_place_id", String(places[0].id));
  return places[0];
}

/** What a place shows as: its name, plus the geocoded label or coordinates. */
export function placeDetail(p: SavedPlace): string {
  return p.label || `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;
}

export type Approximate = {
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
};

/** Ask Rust for an IP-based guess. Only a suggestion; the caller confirms. */
export function detectLocation(): Promise<Approximate> {
  return invoke<Approximate>("location_detect");
}
