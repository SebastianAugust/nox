import { useCallback, useEffect, useState } from "react";
import { getTodayPomodoroSessions } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import Pomodoro from "../../components/Pomodoro";
import { Card } from "../../components/ui/controls";

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
      <section className="card focus-stage" aria-label={t("nav.pomodoro")}>
        <Pomodoro onSnapshot={load} />
      </section>

      <Card title={t("pom.todaySessions")}>
        {sessions.length === 0 && <p className="empty-line">{t("pom.none")}</p>}
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className="session-row">
              <span
                className={`session-dot${s.completed ? " session-dot--done" : ""}`}
                aria-hidden="true"
              />
              <span className="session-row__text">
                {t(s.completed ? "pom.completed" : "pom.stopped", { min: s.duration_minutes })}
              </span>
              <span className="pixel session-row__time">{formatClock(s.started_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
