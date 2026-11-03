import { invoke } from "@tauri-apps/api/core";
import { getDb } from "./db";
import { t, type I18nKey } from "./i18n";
import { getActivePlace } from "./places";

/**
 * Weather from Open-Meteo through Rust (`weather_fetch`) for the active saved
 * place (`places.ts`), cached in
 * `weather_cache` for 30 minutes. When a refresh fails the cached reading is
 * served and marked stale, so Home still shows something offline.
 */

export type Weather = {
  temperature: number;
  feelsLike: number;
  weatherCode: number;
  isDay: boolean;
  tempMax: number | null;
  tempMin: number | null;
  rainChanceToday: number | null;
  rainChanceSoon: number | null;
  sunrise: string | null;
  sunset: string | null;
  timezone: string | null;
};

export type Place = {
  name: string;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
};

export type WeatherState = {
  data: Weather;
  /** Epoch ms of the reading. */
  fetchedAt: number;
  /** True when this is an old reading because the refresh failed. */
  stale: boolean;
  place: string;
};

const TTL_MIN = 30;
// After a failed refresh, wait this long before trying that place again.
const RETRY_MS = 5 * 60 * 1000;
const failures = new Map<string, number>();

// ── Places ──

/** Label for a place: "Jatinangor, West Java". */
export function placeLabel(p: Place): string {
  return [p.name, p.admin1 ?? p.country].filter(Boolean).join(", ");
}

/**
 * The best geocoding match for "Jatinangor, Sumedang": the words after the
 * first comma are hints matched against the region names. Ties keep
 * Open-Meteo's order (largest population first).
 */
export function pickPlace(places: Place[], query: string): Place | null {
  const hints = query
    .split(",")
    .slice(1)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  let best: Place | null = null;
  let bestScore = -1;
  for (const p of places) {
    const regions = [p.admin1, p.admin2, p.admin3, p.country].filter(Boolean).join(" ").toLowerCase();
    const score = hints.filter((h) => regions.includes(h)).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

// ── Readings ──

type CacheRow = { forecast: string; cached_at: string; age_min: number };

async function readCache(key: string): Promise<CacheRow | null> {
  const db = await getDb();
  const rows = await db.select<CacheRow[]>(
    `SELECT forecast, cached_at, (julianday('now') - julianday(cached_at)) * 1440 AS age_min
     FROM weather_cache WHERE location = ? ORDER BY id DESC LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

async function writeCache(key: string, data: Weather): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM weather_cache WHERE location = ?", [key]);
  await db.execute(
    "INSERT INTO weather_cache (location, temperature, forecast, cached_at) VALUES (?, ?, ?, datetime('now'))",
    [key, data.temperature, JSON.stringify(data)],
  );
}

const stampToMs = (stamp: string) => Date.parse(stamp.replace(" ", "T") + "Z");

/**
 * The current weather for the active saved place: cached when fresh, else
 * fetched; on failure the last cached reading, marked stale. The cache key is
 * the place's lat/lon, so switching places fetches at once unless that place
 * has a fresh reading. Null when there is no reading and none can be fetched.
 */
export async function getWeather(opts: { force?: boolean } = {}): Promise<WeatherState | null> {
  const active = await getActivePlace();
  if (!active) return null;
  const lat = active.latitude;
  const lon = active.longitude;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const place = active.name;
  const lastFailure = failures.get(key) ?? 0;

  const cached = await readCache(key);
  const fromCache = (stale: boolean): WeatherState | null => {
    if (!cached) return null;
    try {
      return { data: JSON.parse(cached.forecast), fetchedAt: stampToMs(cached.cached_at), stale, place };
    } catch {
      return null;
    }
  };

  if (cached && cached.age_min < TTL_MIN && !opts.force) return fromCache(false);
  if (!opts.force && Date.now() - lastFailure < RETRY_MS) return fromCache(true);

  try {
    const data = await invoke<Weather>("weather_fetch", { latitude: lat, longitude: lon });
    await writeCache(key, data);
    failures.delete(key);
    return { data, fetchedAt: Date.now(), stale: false, place };
  } catch {
    failures.set(key, Date.now());
    return fromCache(true);
  }
}

// ── Wording ──

/** WMO weather code → plain words and a generic icon. */
export function weatherKind(code: number, isDay = true): { label: I18nKey; icon: string } {
  if (code === 0) return { label: "wx.clear", icon: isDay ? "ti-sun" : "ti-moon" };
  if (code <= 2) return { label: "wx.partly", icon: isDay ? "ti-sun-low" : "ti-cloud" };
  if (code === 3) return { label: "wx.cloudy", icon: "ti-cloud" };
  if (code === 45 || code === 48) return { label: "wx.fog", icon: "ti-cloud-fog" };
  if (code >= 51 && code <= 57) return { label: "wx.drizzle", icon: "ti-cloud-rain" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { label: "wx.rain", icon: "ti-cloud-rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "wx.snow", icon: "ti-snowflake" };
  if (code >= 95) return { label: "wx.storm", icon: "ti-cloud-storm" };
  return { label: "wx.cloudy", icon: "ti-cloud" };
}

/** Rain chance worth mentioning (percent). */
export const RAIN_WORTH_SAYING = 50;

/** One line for the briefing, /cuaca and Telegram. Mentions rain only when likely. */
export function weatherLine(w: WeatherState): string {
  const d = w.data;
  const parts = [
    t("wx.line", {
      place: w.place,
      what: t(weatherKind(d.weatherCode, d.isDay).label),
      temp: Math.round(d.temperature),
      feels: Math.round(d.feelsLike),
    }),
  ];
  if (d.tempMax !== null && d.tempMin !== null) {
    parts.push(t("wx.range", { min: Math.round(d.tempMin), max: Math.round(d.tempMax) }));
  }
  const rain = Math.max(d.rainChanceSoon ?? 0, d.rainChanceToday ?? 0);
  if (rain >= RAIN_WORTH_SAYING) parts.push(t("wx.rainLikely", { n: rain }));
  if (w.stale) parts.push(t("wx.stale"));
  return parts.join(" · ");
}
