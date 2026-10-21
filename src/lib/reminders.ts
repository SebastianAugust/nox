import { getPendingReminders, markReminderSent } from "./db-helpers";

const POLL_MS = 30 * 1000;

/**
 * Deliver reminders whose time has come.
 *
 * `getPendingReminders()` already filters on `remind_at <= datetime('now')`,
 * so this just drains the queue. Each one is marked sent immediately, which
 * both stops it repeating and means a reminder missed while the app was closed
 * still surfaces once at the next launch.
 *
 * Returns a stop function; call it on unmount.
 */
export function startReminderPoller(
  onDue: (titles: string[]) => void,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const due = await getPendingReminders();
    if (due.length === 0) return;

    for (const r of due) await markReminderSent(r.id);
    if (!stopped) onDue(due.map((r) => r.title as string));
  };

  void tick().catch(console.error);
  const handle = setInterval(() => void tick().catch(console.error), POLL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
