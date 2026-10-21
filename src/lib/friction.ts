import { getSetting } from "./db-helpers";

const POLL_MS = 5 * 60 * 1000; // re-check every 5 minutes
const IDLE_MINUTES = 30;
const WAKING_START_HOUR = 8;
const WAKING_END_HOUR = 22;

let lastInteraction = Date.now();

/**
 * Mark the user as present. Called whenever they touch Nox (click, send a
 * message, answer a check-in) so the idle clock restarts.
 */
export function recordInteraction(): void {
  lastInteraction = Date.now();
}

export function minutesSinceInteraction(): number {
  return (Date.now() - lastInteraction) / 60000;
}

/**
 * Nudge the user when they have gone quiet for a long stretch during waking
 * hours — the "what are you actually working on?" prompt that breaks a stall.
 *
 * Returns a stop function; call it on unmount.
 */
export function startFrictionDetector(onTrigger: () => void): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    if ((await getSetting("friction_starter_enabled")) === "false") return;

    const hour = new Date().getHours();
    if (hour < WAKING_START_HOUR || hour >= WAKING_END_HOUR) return;

    if (minutesSinceInteraction() >= IDLE_MINUTES) {
      // Reset first so a user who ignores the nudge is not asked again on the
      // very next poll.
      recordInteraction();
      if (!stopped) onTrigger();
    }
  };

  const handle = setInterval(() => void tick().catch(console.error), POLL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
