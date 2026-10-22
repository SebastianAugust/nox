import { useState } from "react";
import { t } from "../../lib/i18n";
import { habitStreak, type HabitLogMap } from "../../lib/streaks";
import { ChunkyButton, IconButton } from "../../components/ui/controls";
import WeekFootprints from "./WeekFootprints";

export type HabitRow = { id: number; name: string; completed: number };

/**
 * One habit as a card: today's toggle, its streak and best, and the last
 * seven days. Delete asks first; right-click opens the same confirm.
 */
export default function HabitItem({
  habit,
  logs,
  today,
  onToggle,
  onDelete,
}: {
  habit: HabitRow;
  logs: HabitLogMap;
  today: string;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const done = habit.completed === 1;
  const { current, best } = habitStreak(logs, habit.id, today);

  return (
    <article
      className="card habit-card"
      aria-label={habit.name}
      onContextMenu={(e) => {
        e.preventDefault();
        setConfirming(true);
      }}
      onMouseLeave={() => setConfirming(false)}
    >
      <div className="habit-card__row">
        <button
          type="button"
          aria-pressed={done}
          className={`habit-toggle habit-toggle--grow${done ? " habit-toggle--done" : ""}`}
          onClick={onToggle}
        >
          <span className="habit-toggle__box" aria-hidden="true">
            {done && <i className="ti ti-check" />}
          </span>
          <span className="habit-toggle__name">{habit.name}</span>
        </button>
        {confirming ? (
          <ChunkyButton size="sm" variant="danger" onClick={onDelete} autoFocus onBlur={() => setConfirming(false)}>
            {t("habits.confirmDelete")}
          </ChunkyButton>
        ) : (
          <IconButton label={t("habits.delete")} onClick={() => setConfirming(true)} className="icon-btn--danger">
            <i className="ti ti-trash" aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <div className="habit-card__stats">
        <span>
          <span className="pixel habit-card__num">{current}</span> {t("habits.streak")}
        </span>
        <span>
          <span className="pixel habit-card__num">{best}</span> {t("habits.best")}
        </span>
      </div>
      <WeekFootprints logs={logs} today={today} habitId={habit.id} />
    </article>
  );
}
