import { useCallback, useEffect, useState } from "react";
import {
  addHabit,
  deleteHabit,
  getHabitLogsSince,
  getHabitStreaks,
  getTodayHabitLogs,
  logHabit,
  todayLocal,
} from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import type { HabitLogMap } from "../../lib/streaks";
import { MoonStars, StreakEgg } from "../../components/deco/Deco";
import HabitItem, { type HabitRow } from "../widgets/HabitItem";
import WeekFootprints from "../widgets/WeekFootprints";

const STREAK_WINDOW_DAYS = 365; // per-habit "best" looks back this far

export default function PageHabits() {
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [streaks, setStreaks] = useState({ current: 0, best: 0 });
  const [logs, setLogs] = useState<HabitLogMap>({});
  const [loaded, setLoaded] = useState(false);
  const [newHabit, setNewHabit] = useState("");

  const load = useCallback(async () => {
    const [rows, s, l] = await Promise.all([
      getTodayHabitLogs(),
      getHabitStreaks(),
      getHabitLogsSince(STREAK_WINDOW_DAYS),
    ]);
    setHabits(rows as HabitRow[]);
    setStreaks(s);
    setLogs(l);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const handleToggle = async (habit: HabitRow) => {
    // Optimistic: the toggle should never lag behind the click.
    setHabits((prev) =>
      prev.map((h) => (h.id === habit.id ? { ...h, completed: h.completed ? 0 : 1 } : h)),
    );
    try {
      await logHabit(habit.id, !habit.completed);
    } catch (err) {
      console.error(err);
    }
    await load(); // the real state, either way
  };

  const handleAdd = async () => {
    const name = newHabit.trim();
    if (!name) return;
    await addHabit(name);
    setNewHabit("");
    await load();
  };

  const handleDelete = async (habit: HabitRow) => {
    await deleteHabit(habit.id);
    await load();
  };

  const today = todayLocal();

  return (
    <>
      <section className="card habits-summary" aria-labelledby="habits-streak">
        <StreakEgg size={56} />
        <div className="habits-summary__text">
          <h2 id="habits-streak" className="card__title">
            {t("habits.streakLine", { n: streaks.current, best: streaks.best })}
          </h2>
          <p className="muted">{t("habits.streakHint")}</p>
        </div>
        {habits.length > 0 && (
          <div className="habits-summary__week">
            <WeekFootprints logs={logs} today={today} />
          </div>
        )}
      </section>

      {loaded && habits.length === 0 && (
        <div className="empty-state">
          <MoonStars />
          <p>{t("habits.empty")}</p>
        </div>
      )}

      <div className="habit-grid">
        {habits.map((h) => (
          <HabitItem
            key={h.id}
            habit={h}
            logs={logs}
            today={today}
            onToggle={() => void handleToggle(h).catch(console.error)}
            onDelete={() => void handleDelete(h).catch(console.error)}
          />
        ))}
      </div>

      <div className="add-todo">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="add-todo__plus">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <label htmlFor="add-habit" className="sr-only">
          {t("habits.addLabel")}
        </label>
        <input
          id="add-habit"
          value={newHabit}
          onChange={(e) => setNewHabit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd().catch(console.error);
            if (e.key === "Escape") setNewHabit("");
          }}
          placeholder={t("habits.new")}
          className="add-todo__input"
        />
      </div>
    </>
  );
}
