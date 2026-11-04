import { sqlDb } from "./todoRepo";

/**
 * Actions that create data from free text wait for Bas's confirmation here
 * (table `pending_actions`): a capture proposal (step 03) or a new calendar
 * event. The pet shows a card (Add / Edit / Cancel), Telegram an inline
 * keyboard (Confirm / Cancel, button data `pa:yes:<id>` / `pa:no:<id>`).
 *
 * Rules: an action expires 10 minutes after it was offered; it can be
 * confirmed only once (claimed atomically) and only from where it was
 * offered (pet or Telegram).
 */

export const ACTION_TTL_MS = 10 * 60 * 1000;

export type ActionKind = "capture" | "event";
export type ActionSource = "pet" | "telegram";
export type ActionStatus = "pending" | "running" | "done" | "cancelled" | "expired" | "failed";

export type PendingAction = {
  id: number;
  kind: ActionKind;
  payload: string;
  source: ActionSource;
  status: ActionStatus;
  created_at: string;
  expires_at: string;
  result: string | null;
};

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

export async function createAction(kind: ActionKind, payload: unknown, source: ActionSource, now = new Date()): Promise<number> {
  const db = await sqlDb();
  await expireActions(now);
  const r = await db.execute("INSERT INTO pending_actions (kind, payload, source, expires_at) VALUES (?, ?, ?, ?)", [
    kind,
    JSON.stringify(payload),
    source,
    stamp(new Date(now.getTime() + ACTION_TTL_MS)),
  ]);
  return Number(r.lastInsertId);
}

export async function getAction(id: number): Promise<PendingAction | null> {
  const db = await sqlDb();
  const [row] = await db.select<PendingAction[]>("SELECT * FROM pending_actions WHERE id = ?", [id]);
  return row ?? null;
}

export type Claim = { ok: true; action: PendingAction } | { ok: false; reason: "missing" | "expired" | "used" | "otherSource" };

/**
 * Take the action to run it: pending, not expired, offered on this source.
 * Atomic, so a double tap (or Confirm in two places) runs it once.
 */
export async function claimAction(id: number, source: ActionSource, now = new Date()): Promise<Claim> {
  const db = await sqlDb();
  const action = await getAction(id);
  if (!action) return { ok: false, reason: "missing" };
  if (action.source !== source) return { ok: false, reason: "otherSource" };
  const r = await db.execute(
    "UPDATE pending_actions SET status = 'running' WHERE id = ? AND status = 'pending' AND expires_at > ?",
    [id, stamp(now)],
  );
  if (r.rowsAffected === 1) return { ok: true, action: { ...action, status: "running" } };
  await expireActions(now);
  const after = await getAction(id);
  return { ok: false, reason: after?.status === "expired" ? "expired" : "used" };
}

export async function finishAction(id: number, status: "done" | "failed", result: string | null): Promise<void> {
  const db = await sqlDb();
  await db.execute("UPDATE pending_actions SET status = ?, result = ? WHERE id = ?", [status, result, id]);
}

/** Cancel a pending action; false when it was no longer pending. */
export async function cancelAction(id: number, source: ActionSource): Promise<boolean> {
  const db = await sqlDb();
  const r = await db.execute("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND source = ?", [
    id,
    source,
  ]);
  return r.rowsAffected === 1;
}

/** Mark every overdue pending action expired. */
export async function expireActions(now = new Date()): Promise<void> {
  const db = await sqlDb();
  await db.execute("UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [stamp(now)]);
}

/** Telegram button data for an action. */
export const buttonData = (id: number, yes: boolean) => `pa:${yes ? "yes" : "no"}:${id}`;

/** Read button data back; null for anything else (also old `cap:` buttons). */
export function parseButton(data: string): { id: number; yes: boolean } | null {
  const m = /^pa:(yes|no):(\d{1,9})$/.exec(data);
  return m ? { id: Number(m[2]), yes: m[1] === "yes" } : null;
}
