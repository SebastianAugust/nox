import { emit, listen } from "@tauri-apps/api/event";
import { getSetting, savePomodoroSession, setSetting, utcStamp } from "./db-helpers";

/**
 * The pomodoro timer, owned by the pet window (the one window that is always
 * alive). The dashboard is only a view + remote control:
 *
 *   dashboard → pet   "pomodoro:cmd"      { type: "start" | "stop" | "skip" }
 *   dashboard → pet   "pomodoro:request"  (pet answers with a state snapshot)
 *   pet → everyone    "pomodoro:state"    PomSnapshot, on every change
 *
 * Time is deadline-based (wall clock). Viewers compute the remaining time from
 * `endsAt`, so nothing is broadcast per second.
 */

export type PomPhase = "idle" | "focus" | "break";

export type PomSnapshot = {
  phase: PomPhase;
  /** Epoch ms when the current phase started; null while idle. */
  startedAt: number | null;
  /** Epoch ms when the current phase ends; null while idle. */
  endsAt: number | null;
  focusSec: number;
  breakSec: number;
  context: string;
  /** The todo this session is for (Todos page "Start focus"), if any. */
  todoId?: number | null;
};

/**
 * `start` may carry a one-off focus length (`/fokus 5`) and a context (the
 * assignment a deadline nudge was about); both apply to that session only.
 */
export type PomCommand =
  | { type: "start"; minutes?: number; context?: string; todoId?: number }
  | { type: "stop" | "skip" };

const MAX_FOCUS_MIN = 180;

const DEFAULT_FOCUS_MIN = 25;
const DEFAULT_BREAK_MIN = 5;
const ACTIVE_KEY = "pomodoro_active";
const MIN_SAVED_MS = 60 * 1000; // an early stop shorter than this is not recorded

let snap: PomSnapshot = {
  phase: "idle",
  startedAt: null,
  endsAt: null,
  focusSec: DEFAULT_FOCUS_MIN * 60,
  breakSec: DEFAULT_BREAK_MIN * 60,
  context: "general",
};
let focusStartedAt: number | null = null; // the focus start, kept through the break
let restored = false;
let deadline: number | null = null;
const subscribers = new Set<(s: PomSnapshot) => void>();

// Every transition runs through this queue, so a deadline firing at the same
// moment as a "stop" cannot save the session twice.
let queue: Promise<void> = Promise.resolve();
function run(task: () => Promise<void> | void): Promise<void> {
  queue = queue.then(task).catch(console.error);
  return queue;
}

export function getPomodoroSnapshot(): PomSnapshot {
  return snap;
}

export function subscribePomodoro(fn: (s: PomSnapshot) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function publish(next: PomSnapshot) {
  snap = next;
  subscribers.forEach((fn) => fn(snap));
  emit("pomodoro:state", snap).catch(console.error);
  setSetting(ACTIVE_KEY, snap.phase === "idle" ? "" : JSON.stringify({ ...snap, focusStartedAt }))
    .catch(console.error);
  arm();
}

/**
 * One timeout aimed at the deadline rather than a polling interval: a hidden
 * window's timers get throttled, but a single un-chained timeout is only
 * delayed by about a second, where an interval can be pushed back much further.
 */
function arm() {
  if (deadline !== null) clearTimeout(deadline);
  deadline = null;
  if (snap.endsAt === null) return;
  deadline = window.setTimeout(
    () => void run(checkDeadline),
    Math.max(0, snap.endsAt - Date.now()),
  );
}

async function readDurations(): Promise<{ focusSec: number; breakSec: number }> {
  const [focus, brk] = await Promise.all([
    getSetting("pomodoro_duration"),
    getSetting("pomodoro_break"),
  ]);
  return {
    focusSec: (Number(focus) || DEFAULT_FOCUS_MIN) * 60,
    breakSec: (Number(brk) || DEFAULT_BREAK_MIN) * 60,
  };
}

function idle(durations = { focusSec: snap.focusSec, breakSec: snap.breakSec }) {
  focusStartedAt = null;
  publish({ ...snap, ...durations, phase: "idle", startedAt: null, endsAt: null });
}

async function saveSession(endedAt: number, completed: boolean) {
  if (focusStartedAt === null) return;
  const elapsed = endedAt - focusStartedAt;
  if (!completed && elapsed < MIN_SAVED_MS) return;
  await savePomodoroSession({
    context: snap.context,
    todo_id: snap.todoId ?? null,
    duration_minutes: completed ? snap.focusSec / 60 : Math.max(1, Math.round(elapsed / 60000)),
    break_minutes: snap.breakSec / 60,
    completed,
    started_at: utcStamp(new Date(focusStartedAt)),
    ended_at: utcStamp(new Date(endedAt)),
  });
}

async function checkDeadline() {
  if (snap.endsAt === null) return;
  if (Date.now() < snap.endsAt) return arm(); // woke early; aim again
  const endedAt = snap.endsAt;

  if (snap.phase === "focus") {
    await saveSession(endedAt, true);
    const now = Date.now();
    publish({ ...snap, phase: "break", startedAt: now, endsAt: now + snap.breakSec * 1000 });
  } else {
    idle();
  }
}

async function handle(cmd: PomCommand) {
  if (cmd.type === "start") {
    if (snap.phase !== "idle") return;
    // Durations are read now, so a settings change applies to the next session.
    const durations = await readDurations();
    const minutes = Math.round(Number(cmd.minutes));
    if (minutes >= 1 && minutes <= MAX_FOCUS_MIN) durations.focusSec = minutes * 60;
    const context = cmd.context?.trim().slice(0, 200) || "general";
    const now = Date.now();
    focusStartedAt = now;
    publish({
      ...snap,
      ...durations,
      context,
      todoId: Number.isInteger(cmd.todoId) && cmd.todoId! > 0 ? cmd.todoId : null,
      phase: "focus",
      startedAt: now,
      endsAt: now + durations.focusSec * 1000,
    });
  } else if (cmd.type === "stop") {
    if (snap.phase === "focus") await saveSession(Date.now(), false);
    if (snap.phase !== "idle") idle();
  } else if (cmd.type === "skip") {
    if (snap.phase === "break") idle();
  }
}

/** Bring back a session that was running when the pet window last closed. */
async function restore() {
  const raw = await getSetting(ACTIVE_KEY);
  const durations = await readDurations();
  let saved: (PomSnapshot & { focusStartedAt?: number | null }) | null = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }

  if (!saved || saved.phase === "idle" || saved.endsAt === null) {
    idle(durations);
    return;
  }

  snap = { ...saved };
  focusStartedAt = saved.focusStartedAt ?? (saved.phase === "focus" ? saved.startedAt : null);

  if (Date.now() < saved.endsAt) {
    publish(snap);
    return;
  }
  // It ran out while nobody was watching: finish it properly and go idle.
  if (saved.phase === "focus") await saveSession(saved.endsAt, true);
  idle(durations);
}

/**
 * Start the engine in the pet window. Returns a stop function. The state is
 * module-level, so React's dev double-mount re-attaches to the same session
 * instead of restoring it twice.
 */
export function startPomodoroEngine(): () => void {
  const unlisteners: Promise<() => void>[] = [
    listen<PomCommand>("pomodoro:cmd", ({ payload }) => void run(() => handle(payload))),
    listen("pomodoro:request", () =>
      void run(async () => {
        // While idle, pick up any duration change so the ring shows it.
        if (snap.phase === "idle") idle(await readDurations());
        else publish(snap);
      }),
    ),
  ];

  // Safety net: if the OS held our timeout back while hidden, catch up as soon
  // as the window is shown again.
  const onVisible = () => {
    if (!document.hidden) void run(checkDeadline);
  };
  document.addEventListener("visibilitychange", onVisible);

  if (!restored) {
    restored = true;
    void run(restore);
  } else {
    arm();
  }

  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    for (const u of unlisteners) u.then((off) => off()).catch(console.error);
  };
}

