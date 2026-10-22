import { useCallback, useEffect, useState } from "react";
import { getTodayPomodoroSessions } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import Pomodoro from "../../components/Pomodoro";
import { card, emptyText, rowBorder, sectionLabel } from "../../styles/shared";

export default function PagePomodoro() {
  const [sessions, setSessions] = useState<
    Awaited<ReturnType<typeof getTodayPomodoroSessions>>
  >([]);

  const load = useCallback(() => {
    getTodayPomodoroSessions().then(setSessions).catch(console.error);
  }, []);

  useEffect(load, [load]);

  const formatClock = (stamp: string) =>
    new Date(stamp.replace(" ", "T") + "Z").toLocaleTimeString(locale(), {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <>
      <div style={{ ...card, padding: "26px 16px" }}>
        <Pomodoro onSnapshot={load} />
      </div>

      <div>
        <div style={sectionLabel}>{t("pom.todaySessions")}</div>
        <div style={card}>
          {sessions.length === 0 && (
            <div style={emptyText}>{t("pom.none")}</div>
          )}
          {sessions.map((s, i, arr) => (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                ...rowBorder(i === arr.length - 1),
              }}
            >
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: s.completed ? "#00e5a0" : "rgba(255,255,255,0.15)",
                }}
              />
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", flex: 1 }}>
                {t(s.completed ? "pom.completed" : "pom.stopped", { min: s.duration_minutes })}
              </span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                {formatClock(s.started_at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
