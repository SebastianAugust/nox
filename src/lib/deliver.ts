import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSetting } from "./db-helpers";
import { getPomodoroSnapshot, subscribePomodoro } from "./pomodoroEngine";

/**
 * The one gate every scheduler goes through instead of writing the bubble
 * directly, so nothing lands on a hidden pet, interrupts a streamed reply or
 * breaks a focus session.
 *
 *   reminder   never held: bubble + toast when the pet can show it, otherwise
 *              (hidden, streaming, in a pomodoro) a toast only
 *   checkin,   held in a queue while blocked, then shown oldest first, one at
 *   friction,  a time; check-ins and idle nudges older than STALE_MS are
 *   recap,     dropped. A queued deadline nudge is merged with a newer one,
 *   briefing,  never replaced, since each was already recorded as sent.
 *   nudge
 *   system     shown when the pet is free, otherwise dropped (pomodoro
 *              phase messages are system, so a focus session does not block it)
 *
 * Blocked = pomodoro focus (if `dnd_during_pomodoro`), a streaming reply, the
 * chat input focused, or the pet window hidden.
 */

export type DeliveryKind = "reminder" | "checkin" | "friction" | "recap" | "briefing" | "nudge" | "system";

export type Delivery = {
  kind: DeliveryKind;
  text: string;
  /** For a deadline nudge: what "Start focus" should focus on. */
  focusContext?: string;
};

type Queued = Delivery & { at: number };

const STALE_MS = 2 * 60 * 60 * 1000;
// Quiet time after any delivered bubble before the next queued one, so one
// message is not overwritten before it can be read.
const GAP_MS = 20 * 1000;
const STALE_KINDS: DeliveryKind[] = ["checkin", "friction"];

let present: ((item: Delivery) => void) | null = null;
let streaming = false;
let chatFocused = false;
let dnd = true;
let lastShownAt = 0;
let queue: Queued[] = [];
let flushTimer: number | null = null;

function pomodoroBlocks(): boolean {
  return dnd && getPomodoroSnapshot().phase === "focus";
}

async function petVisible(): Promise<boolean> {
  return getCurrentWindow().isVisible().catch(() => true);
}

/** Whether a bubble would get in the way right now. */
async function blocked(pomodoro = true): Promise<boolean> {
  return streaming || chatFocused || (pomodoro && pomodoroBlocks()) || !(await petVisible());
}

/** A Windows toast. Resolves false if it could not be dispatched. */
async function toast(text: string): Promise<boolean> {
  try {
    // The plugin's notify command directly: sendNotification() swallows errors.
    await invoke("plugin:notification|notify", { options: { title: "Nox", body: text } });
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function show(item: Delivery) {
  if (!present) return false;
  present(item);
  lastShownAt = Date.now();
  return true;
}

/**
 * Deliver one message. Resolves true once it reached the user (bubble shown or
 * toast dispatched); false if it was queued, dropped or failed.
 */
export async function deliver(item: Delivery): Promise<boolean> {
  if (item.kind === "reminder") {
    // A reminder may overwrite another bubble, but never a streamed reply.
    const bubble = !streaming && !pomodoroBlocks() && (await petVisible()) && show(item);
    const toasted = await toast(item.text);
    return bubble || toasted;
  }

  if (item.kind === "system") {
    return !(await blocked(false)) && show(item);
  }

  // One pending entry per kind: a later check-in replaces the queued one;
  // deadline nudges add up instead.
  const prev = queue.find((q) => q.kind === item.kind);
  const next =
    item.kind === "nudge" && prev
      ? { ...item, text: `${prev.text}\n${item.text}`, focusContext: prev.focusContext ?? item.focusContext }
      : item;
  queue = queue.filter((q) => q.kind !== item.kind);
  queue.push({ ...next, at: Date.now() });
  scheduleFlush(0);
  return false;
}

function scheduleFlush(delay: number) {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush().catch(console.error);
  }, delay);
}

async function flush() {
  const now = Date.now();
  queue = queue.filter((q) => !STALE_KINDS.includes(q.kind) || now - q.at < STALE_MS);
  if (queue.length === 0 || (await blocked())) return;

  const wait = lastShownAt + GAP_MS - Date.now();
  if (wait > 0) return scheduleFlush(wait);

  const next = queue.shift()!;
  show(next);
  if (queue.length > 0) scheduleFlush(GAP_MS);
}

/** Something that might have been blocking changed; try the queue again. */
export function deliveryStateChanged(state: { streaming?: boolean; chatFocused?: boolean }) {
  if (state.streaming !== undefined) streaming = state.streaming;
  if (state.chatFocused !== undefined) chatFocused = state.chatFocused;
  scheduleFlush(0);
}

/**
 * Start delivery in the pet window. `onPresent` renders an item as a bubble.
 * Returns a stop function.
 */
export function startDelivery(onPresent: (item: Delivery) => void): () => void {
  present = onPresent;

  const readDnd = () =>
    getSetting("dnd_during_pomodoro")
      .then((v) => {
        dnd = v !== "false";
        scheduleFlush(0);
      })
      .catch(console.error);
  void readDnd();

  const unlisteners = [
    listen("settings:changed", () => void readDnd()),
    // Rust emits this whenever it shows the pet (tray, dashboard closed).
    listen("pet:shown", () => scheduleFlush(0)),
  ];
  const unsubscribe = subscribePomodoro(() => scheduleFlush(0));

  return () => {
    present = null;
    unsubscribe();
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    for (const u of unlisteners) u.then((off) => off()).catch(console.error);
  };
}
