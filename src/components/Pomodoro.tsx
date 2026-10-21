import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getTodayPomodoroSessions } from "../lib/db-helpers";
import type { PomCommand, PomPhase, PomSnapshot } from "../lib/pomodoroEngine";

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
  state: PomPhase;
}) {
  const RADIUS = 54;
  const circumference = 2 * Math.PI * RADIUS;
  const progress = total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0;
  const color =
    state === "focus" ? "#00e5a0" : state === "break" ? "#60a5fa" : "rgba(255,255,255,0.12)";

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
          {state === "focus" ? "focus" : state === "break" ? "break" : "ready"}
        </div>
      </div>
    </div>
  );
}

type Props = {
  /** Fires on every state snapshot, so callers can refresh their session list. */
  onSnapshot?: (s: PomSnapshot) => void;
};

/**
 * Pure view + remote control. The timer itself runs in the pet window
 * (lib/pomodoroEngine.ts); this renders its latest snapshot and sends commands,
 * so switching pages or closing the dashboard never touches a running session.
 */
export function Pomodoro({ onSnapshot }: Props) {
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

  const state: PomPhase = snap?.phase ?? "idle";

  // Only the display ticks here; the deadline lives in the pet window.
  useEffect(() => {
    if (state === "idle") return;
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [state]);

  const focusSec = snap?.focusSec ?? DEFAULT_WORK_MINUTES * 60;
  const breakSec = snap?.breakSec ?? DEFAULT_BREAK_MINUTES * 60;
  const seconds =
    snap?.endsAt != null
      ? Math.max(0, Math.ceil((snap.endsAt - now) / 1000))
      : focusSec;

  const send = (type: PomCommand["type"]) =>
    emit("pomodoro:cmd", { type } satisfies PomCommand).catch(console.error);

  const label =
    state === "idle" ? "Ready" : state === "focus" ? "Focus time" : "Break time";

  return (
    <div style={{ textAlign: "center" }}>
      <ProgressRing
        seconds={seconds}
        total={state === "break" ? breakSec : focusSec}
        state={state}
      />
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginBottom: 16 }}>
        {label} · {sessionsToday} session{sessionsToday === 1 ? "" : "s"} today
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        {state === "idle" ? (
          <button
            onClick={() => send("start")}
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
            onClick={() => send(state === "focus" ? "stop" : "skip")}
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
            {state === "focus" ? "Stop" : "Skip break"}
          </button>
        )}
      </div>
    </div>
  );
}

export default Pomodoro;
