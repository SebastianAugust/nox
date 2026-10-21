import { listen } from "@tauri-apps/api/event";
import { getPendingReminders, markRemindersSent } from "./db-helpers";

const POLL_MS = 30 * 1000;
// More due at once than this (typically after Nox was closed) are summed up
// in one message; the dashboard lists them.
const MAX_LISTED = 3;

/**
 * Deliver reminders whose time has come, including ones missed while Nox was
 * closed: every reminder past due and still `pending` is due.
 *
 * A reminder is marked sent only after `deliver` confirms it reached the user
 * (bubble shown or toast dispatched); otherwise it stays pending and is tried
 * again on the next poll, at startup, or when the pet is shown.
 *
 * Returns a stop function; call it on unmount.
 */
export function startReminderPoller(
  deliver: (titles: string[], grouped: boolean) => Promise<boolean>,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const due = await getPendingReminders();
    // Re-check after every await (B-19): a StrictMode remount stops this
    // instance mid-flight, and the new one will deliver these instead.
    if (stopped || due.length === 0) return;

    const titles = due.map((r) => r.title as string);
    const delivered = await deliver(titles, titles.length > MAX_LISTED);
    // Once it reached the user it must be recorded even if we were stopped
    // meanwhile, or the next instance would show it twice.
    if (delivered) await markRemindersSent(due.map((r) => r.id as number));
  };

  // Ticks never overlap, so a slow toast cannot let one reminder out twice.
  const run = () => {
    chain = chain.then(tick).catch(console.error);
  };

  run();
  const handle = setInterval(run, POLL_MS);
  // Replay on every show, so a reminder that could not get out is not left
  // waiting for the next poll.
  const unlisten = listen("pet:shown", run);

  return () => {
    stopped = true;
    clearInterval(handle);
    unlisten.then((off) => off()).catch(console.error);
  };
}

// Shared by every poller instance (StrictMode mounts two).
let chain: Promise<void> = Promise.resolve();
