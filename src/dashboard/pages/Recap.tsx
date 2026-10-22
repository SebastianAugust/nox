import { useEffect, useState } from "react";
import { getRecentRecaps, getSetting } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { MoonStars } from "../../components/deco/Deco";
import { Tag } from "../../components/ui/controls";

type Recap = Awaited<ReturnType<typeof getRecentRecaps>>[number];

/** Day recaps, newest first. */
export default function PageRecap() {
  const [recaps, setRecaps] = useState<Recap[]>([]);
  const [recapTime, setRecapTime] = useState("22:00");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([getRecentRecaps(14), getSetting("recap_time")])
      .then(([r, time]) => {
        setRecaps(r);
        if (time) setRecapTime(time);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  if (!loaded) return <p className="empty-line">{t("common.loading")}</p>;

  if (recaps.length === 0) {
    return (
      <div className="empty-state">
        <MoonStars />
        <p>{t("recap.empty", { time: recapTime })}</p>
      </div>
    );
  }

  return (
    <div className="recap-list">
      {recaps.map((r) => {
        const [y, m, d] = r.date.split("-").map(Number);
        const date = new Date(y, m - 1, d);
        return (
          <article key={r.date} className="card recap" aria-label={date.toLocaleDateString(locale(), { dateStyle: "full" })}>
            <div className="recap__head">
              <span className="pixel recap__date">
                {date.toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" })}
              </span>
              {r.mood && <Tag tone="neutral">{r.mood}</Tag>}
            </div>
            {r.summary && <p className="recap__summary">{r.summary}</p>}
            <div className="chips">
              <Chip value={`${r.todos_completed}/${r.todos_total}`} label={t("recap.tasks")} done={r.todos_completed > 0} />
              <Chip value={String(r.pomodoro_sessions)} label={t("recap.pomodoros")} done={r.pomodoro_sessions > 0} />
              <Chip value={`${r.habits_completed}/${r.habits_total}`} label={t("recap.habits")} done={r.habits_completed > 0} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Chip({ value, label, done }: { value: string; label: string; done: boolean }) {
  return (
    <span className={`chip${done ? " chip--done" : ""}`}>
      <span className="pixel chip__value">{value}</span>
      {label}
    </span>
  );
}
