import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSetting,
  getTodayPomodoroSessions,
  savePomodoroSession,
  utcStamp,
} from "../lib/db-helpers";

export type PomState = "idle" | "working" | "break";

const DEFAULT_WORK_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;
const TICK_MS = 250;

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Circular countdown. The ring drains as the phase runs down; `total` is the
 * length of the *current* phase, so work and break both start from a full ring.
 */
function ProgressRing({
  seconds,
  total,
  state,
}: {
  seconds: number;
  total: number;
  state: PomState;
}) {
  const RADIUS = 54;
  const circumference = 2 * Math.PI * RADIUS;
  const progress = total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0;
  const color =
    state === "working" ? "#00e5a0" : state === "break" ? "#60a5fa" : "rgba(255,255,255,0.12)";

  return (
    <div style={{ position: "relative", width: 140, height: 140, margin: "0 auto 14px" }}>
      <svg width="140" height="140" style={{ transform: "rotate(-90deg)", display: "block" }}>
        <circle
          cx="70"
          cy="70"
          r={RADIUS}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="6"
        />
        <circle
          cx="70"
          cy="70"
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round"
          style={{
            // Only ease between ticks while running; a reset should snap.
            transition:
              state === "idle"
                ? "stroke 0.3s ease"
                : "stroke-dashoffset 0.3s linear, stroke 0.3s ease",
          }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 28,
            fontWeight: 500,
            fontVariantNumeric: "tabular-nums",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          {formatTime(seconds)}
        </div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
          {state === "working" ? "focus" : state === "break" ? "break" : "ready"}
        </div>
      </div>
    </div>
  );
}

type Props = {
  onStateChange?: (s: PomState) => void;
  /** Fires after a session row is written, so callers can refresh their stats. */
  onSessionSaved?: () => void;
};

export function Pomodoro({ onStateChange, onSessionSaved }: Props) {
  const [state, setState] = useState<PomState>("idle");
  const [durations, setDurations] = useState({
    work: DEFAULT_WORK_MINUTES,
    break: DEFAULT_BREAK_MINUTES,
  });
  const [seconds, setSeconds] = useState(DEFAULT_WORK_MINUTES * 60);
  const [sessionsToday, setSessionsToday] = useState(0);

  // The timer runs off a wall-clock deadline rather than counting ticks, so a
  // throttled/suspended background window cannot make it drift.
  const endsAtRef = useRef(0);
  const startedAtRef = useRef("");
  const finishedRef = useRef(false);
  const emittedRef = useRef<PomState | null>(null);

  // Parent callbacks live in a ref: an inline arrow prop gets a new identity on
  // every render, and these must not restart the timer or re-emit the phase.
  const savedCb = useRef(onSessionSaved);
  const stateCb = useRef(onStateChange);
  savedCb.current = onSessionSaved;
  stateCb.current = onStateChange;

  const refreshSessions = useCallback(async () => {
    const rows = await getTodayPomodoroSessions();
    setSessionsToday(rows.filter((r) => r.completed === 1).length);
  }, []);

  // Durations are user settings; today's count comes from the DB so it is
  // right even after a restart mid-day.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [work, brk] = await Promise.all([
        getSetting("pomodoro_duration"),
        getSetting("pomodoro_break"),
      ]);
      if (cancelled) return;
      const next = {
        work: Number(work) || DEFAULT_WORK_MINUTES,
        break: Number(brk) || DEFAULT_BREAK_MINUTES,
      };
      setDurations(next);
      setSeconds((prev) => (endsAtRef.current === 0 ? next.work * 60 : prev));
      await refreshSessions();
    })().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  // Announce each phase change exactly once.
  useEffect(() => {
    if (emittedRef.current === state) return;
    emittedRef.current = state;
    stateCb.current?.(state);
  }, [state]);

  // One interval per phase. On reaching the deadline it runs the transition
  // exactly once (finishedRef), outside of any state updater — updaters run
  // twice under StrictMode and must stay free of side effects.
  useEffect(() => {
    if (state === "idle") {
      setSeconds(durations.work * 60);
      return;
    }

    finishedRef.current = false;

    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((endsAtRef.current - Date.now()) / 1000),
      );
      setSeconds(remaining);
      if (remaining > 0 || finishedRef.current) return;
      finishedRef.current = true;

      if (state === "working") {
        savePomodoroSession({
          duration_minutes: durations.work,
          break_minutes: durations.break,
          completed: true,
          started_at: startedAtRef.current,
        })
          .then(refreshSessions)
          .then(() => savedCb.current?.())
          .catch(console.error);
        endsAtRef.current = Date.now() + durations.break * 60000;
        setState("break");
      } else {
        setState("idle");
      }
    };

    tick();
    const handle = setInterval(tick, TICK_MS);
    return () => clearInterval(handle);
  }, [state, durations, refreshSessions]);

  const start = () => {
    startedAtRef.current = utcStamp();
    endsAtRef.current = Date.now() + durations.work * 60000;
    setSeconds(durations.work * 60);
    setState("working");
  };

  const stop = () => {
    // Only a work phase that is cut short is worth recording as abandoned.
    if (state === "working") {
      const elapsedMinutes = Math.round(
        (durations.work * 60 - seconds) / 60,
      );
      savePomodoroSession({
        duration_minutes: elapsedMinutes,
        break_minutes: durations.break,
        completed: false,
        started_at: startedAtRef.current,
      })
        .then(() => savedCb.current?.())
        .catch(console.error);
    }
    endsAtRef.current = 0;
    setState("idle");
  };

  const label =
    state === "idle" ? "Ready" : state === "working" ? "Focus time" : "Break time";

  return (
    <div style={{ textAlign: "center" }}>
      <ProgressRing
        seconds={seconds}
        total={(state === "break" ? durations.break : durations.work) * 60}
        state={state}
      />
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 16 }}>
        {label} · {sessionsToday} session{sessionsToday === 1 ? "" : "s"} today
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {state === "idle" ? (
          <button
            onClick={start}
            style={{
              padding: "7px 20px",
              borderRadius: 8,
              background: "#00e5a0",
              border: "none",
              color: "#080a0d",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Start
          </button>
        ) : (
          <button
            onClick={stop}
            style={{
              padding: "7px 20px",
              borderRadius: 8,
              background: "rgba(239,68,68,0.15)",
              border: "0.5px solid rgba(239,68,68,0.3)",
              color: "#f87171",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {state === "working" ? "Stop" : "Skip break"}
          </button>
        )}
      </div>
    </div>
  );
}

export default Pomodoro;
