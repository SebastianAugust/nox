import { getSetting, getOpenAssignments, getSentNudges, markNudgeSent, type AssignmentRow } from "./db-helpers";
import { dueNudges, type Nudge } from "./deadlines";
import { t } from "./i18n";

/**
 * Deadline nudges at 3 days, 1 day and 3 hours before an assignment is due.
 * Each (assignment, threshold) is recorded in `nudges_sent` before it goes
 * out, so it is never repeated, not even after a restart. Delivery (held
 * during focus) and the Telegram copy are up to the caller.
 */

const POLL_MS = 5 * 60 * 1000;
const LOOKAHEAD_DAYS = 4;

export type NudgeMessage = { text: string; focusContext: string };

type Item = AssignmentRow & { id: string };

function line(n: Nudge<Item>): string {
  const course = n.item.course ? ` (${n.item.course})` : "";
  return t(`nudge.${n.threshold}`, { name: `${n.item.name}${course}` });
}

/** Check once; returns the message to deliver, or null. */
export async function checkNudges(now = new Date()): Promise<NudgeMessage | null> {
  if ((await getSetting("nudges_enabled")) === "false") return null;
  const items: Item[] = (await getOpenAssignments(LOOKAHEAD_DAYS, 200)).map((a) => ({ ...a, id: a.notion_id }));
  const nudges = dueNudges(items, await getSentNudges(items.map((i) => i.id)), now);
  if (nudges.length === 0) return null;

  for (const n of nudges) await markNudgeSent(n.item.id, n.threshold);
  const text =
    nudges.length === 1
      ? `${line(nudges[0])} ${t("nudge.offer")}`
      : [t("nudge.many"), ...nudges.map((n) => `• ${line(n)}`)].join("\n");
  return { text, focusContext: nudges[0].item.name };
}

/** Start checking in the pet window. Returns a stop function and a "check now". */
export function startNudgeScheduler(onNudge: (m: NudgeMessage) => void): { stop: () => void; check: () => void } {
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  const check = () => {
    chain = chain
      .then(async () => {
        if (stopped) return;
        const m = await checkNudges();
        // Already recorded as sent, so it must go out even if stopped meanwhile.
        if (m) onNudge(m);
      })
      .catch(console.error);
  };
  check();
  const timer = setInterval(check, POLL_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    check,
  };
}
