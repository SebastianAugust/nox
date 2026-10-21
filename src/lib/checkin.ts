import { getSetting, hoursSinceLastMood, saveMoodLog } from "./db-helpers";
import type { I18nKey } from "./i18n";

// How often we re-evaluate whether a check-in is due. The interval between
// check-ins themselves comes from the `body_checkin_interval` setting.
const POLL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_INTERVAL_MINUTES = 180;

export type Mood = { key: string; labelKey: I18nKey; emoji: string; energy: number };

/** The options offered in the check-in bubble, lowest energy last. */
export const MOODS: Mood[] = [
  { key: "good", labelKey: "mood.good", emoji: "😊", energy: 5 },
  { key: "ok", labelKey: "mood.ok", emoji: "😐", energy: 3 },
  { key: "tired", labelKey: "mood.tired", emoji: "😔", energy: 1 },
  { key: "hungry", labelKey: "mood.hungry", emoji: "🍽", energy: 2 },
];

/**
 * Ask how the body is doing every few hours. Fires `onCheckin` once now if one
 * is already overdue, then keeps polling.
 *
 * Returns a stop function; call it on unmount so React's dev double-invoke (or
 * a reload) cannot leave a second interval running.
 */
export function startCheckinScheduler(onCheckin: () => void): () => void {
  let stopped = false;

  const tick = () => {
    checkIfDue(() => {
      if (!stopped) onCheckin();
    }).catch(console.error);
  };

  tick();
  const handle = setInterval(tick, POLL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

async function checkIfDue(onCheckin: () => void): Promise<void> {
  if ((await getSetting("body_checkin_enabled")) === "false") return;

  const intervalHours =
    (Number(await getSetting("body_checkin_interval")) ||
      DEFAULT_INTERVAL_MINUTES) / 60;

  const hoursAgo = await hoursSinceLastMood();
  // Never logged before, or the interval has elapsed.
  if (hoursAgo === null || hoursAgo >= intervalHours) onCheckin();
}

export async function saveCheckin(mood: string, energy: number): Promise<void> {
  await saveMoodLog(mood, energy);
}
