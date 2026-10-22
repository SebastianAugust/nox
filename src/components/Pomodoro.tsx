import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getTodayPomodoroSessions } from "../lib/db-helpers";
import { t } from "../lib/i18n";
import type { PomCommand, PomPhase, PomSnapshot } from "../lib/pomodoroEngine";

const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const TICK_MS = 250;

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export type PomodoroView = {
  phase: PomPhase;
  /** Seconds left in the current phase (the full focus length while idle). */
  seconds: number;
  /** Length of the current phase, so focus and break both start full. */
  total: number;
  focusMinutes: number;
  sessionsToday: number;
  send: (type: PomCommand["type"]) => void;
};

/**
 * Pure view + remote control. The timer itself runs in the pet window
 * (lib/pomodoroEngine.ts); this follows its latest snapshot and sends
 * commands, so switching pages or closing the dashboard never touches a
 * running session.
 */
export function usePomodoro(onSnapshot?: (s: PomSnapshot) => void): PomodoroView {
  const [snap, setSnap] = useState<PomSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sessionsToday, setSessionsToday] = useState(0);

  const snapCb = useRef(onSnapshot);
  snapCb.current = onSnapshot;

  const refreshSessions = useCallback(async () => {
    const rows = await getTodayPomodoroSessions();
    setSessionsToday(rows.filter((r) => r.completed === 1).length);
  }, []);

  // Subscribe first, then ask the pet for the current state, so the reply
  // cannot arrive before we are listening.
  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<PomSnapshot>("pomodoro:state", ({ payload }) => {
      setSnap(payload);
      setNow(Date.now());
      snapCb.current?.(payload);
      refreshSessions().catch(console.error);
    });
    unlisten
      .then(() => (cancelled ? undefined : emit("pomodoro:request")))
      .catch(console.error);
    refreshSessions().catch(console.error);
    return () => {
      cancelled = true;
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [refreshSessions]);

  const phase: PomPhase = snap?.phase ?? "idle";

  // Only the display ticks here; the deadline lives in the pet window.
  useEffect(() => {
    if (phase === "idle") return;
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [phase]);

  const focusSec = snap?.focusSec ?? DEFAULT_WORK_MINUTES * 60;
  const breakSec = snap?.breakSec ?? DEFAULT_BREAK_MINUTES * 60;
  const seconds = snap?.endsAt != null ? Math.max(0, Math.ceil((snap.endsAt - now) / 1000)) : focusSec;

  const send = useCallback(
    (type: PomCommand["type"]) => emit("pomodoro:cmd", { type } satisfies PomCommand).catch(console.error),
    [],
  );

  return {
    phase,
    seconds,
    total: phase === "break" ? breakSec : focusSec,
    focusMinutes: Math.round(focusSec / 60),
    sessionsToday,
    send,
  };
}

/** Status word under the timer: Ready / Focusing / Break. */
export function phaseLabel(phase: PomPhase): string {
  return t(phase === "focus" ? "pom.ringFocus" : phase === "break" ? "pom.ringBreak" : "pom.ringReady");
}

/**
 * Round countdown. The ring drains as the phase runs down; it is lightning
 * blue with a soft glow while running and a quiet line color when idle.
 */
export function FocusRing({
  seconds,
  total,
  phase,
  size = "md",
  showLabel = size === "lg",
}: {
  seconds: number;
  total: number;
  phase: PomPhase;
  size?: "md" | "lg";
  showLabel?: boolean;
}) {
  const box = size === "lg" ? 232 : 108;
  const stroke = size === "lg" ? 10 : 6;
  const radius = (box - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const running = phase !== "idle";
  const progress = running && total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 1;

  return (
    <div
      className={`timer-ring timer-ring--${size}${running ? " timer-ring--running" : ""}`}
      role="timer"
      aria-label={`${phaseLabel(phase)} ${formatTime(seconds)}`}
    >
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
        <circle className="timer-ring__track" cx={box / 2} cy={box / 2} r={radius} strokeWidth={stroke} />
        <circle
          className="timer-ring__progress"
          cx={box / 2}
          cy={box / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <div className="timer-ring__center" aria-hidden="true">
        <span className="timer-ring__time">{formatTime(seconds)}</span>
        {showLabel && <span className="timer-ring__label">{phaseLabel(phase)}</span>}
      </div>
    </div>
  );
}

type Props = {
  /** Fires on every state snapshot, so callers can refresh their session list. */
  onSnapshot?: (s: PomSnapshot) => void;
};

/** The Focus page's timer block: ring with wings, session count, controls. */
export function Pomodoro({ onSnapshot }: Props) {
  const pom = usePomodoro(onSnapshot);
  const { phase } = pom;

  const label = t(phase === "idle" ? "pom.ready" : phase === "focus" ? "pom.focusTime" : "pom.breakTime");

  return (
    <div className="pomodoro">
      <FocusRing seconds={pom.seconds} total={pom.total} phase={phase} size="lg" />
      <div className="pomodoro__status">
        {label} · {t(pom.sessionsToday === 1 ? "pom.session" : "pom.sessions", { count: pom.sessionsToday })}
      </div>
      <div className="pomodoro__controls">
        {phase === "idle" ? (
          <button type="button" className="chunky chunky--primary chunky--lg" onClick={() => pom.send("start")}>
            {t("pom.start")}
          </button>
        ) : (
          <button
            type="button"
            className="chunky chunky--secondary chunky--lg"
            onClick={() => pom.send(phase === "focus" ? "stop" : "skip")}
          >
            {t(phase === "focus" ? "pom.stop" : "pom.skip")}
          </button>
        )}
      </div>
    </div>
  );
}

export default Pomodoro;
