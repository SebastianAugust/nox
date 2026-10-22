/**
 * Per-habit streaks from the completion map getHabitLogsSince() returns
 * (date → habit id → done). Only as far back as the map goes, so callers ask
 * for enough days. Like getHabitStreaks(), the current run may end
 * yesterday: an untouched morning does not count as a broken streak.
 */

export type HabitLogMap = Record<string, Record<number, boolean>>;

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
};

export function habitStreak(logs: HabitLogMap, habitId: number, today: string): { current: number; best: number } {
  const days = Object.keys(logs)
    .filter((date) => logs[date][habitId])
    .map(dayNumber)
    .sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, best: 0 };

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }

  const set = new Set(days);
  const t = dayNumber(today);
  let cursor = set.has(t) ? t : set.has(t - 1) ? t - 1 : null;
  let current = 0;
  while (cursor !== null && set.has(cursor)) {
    current++;
    cursor--;
  }
  return { current, best };
}

/** Local YYYY-MM-DD for `offset` days from `base` (negative = past). */
export function shiftDay(base: string, offset: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const date = new Date(y, m - 1, d + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
