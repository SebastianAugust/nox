import { locale, t } from "../../lib/i18n";
import { shiftDay, type HabitLogMap } from "../../lib/streaks";
import { Footprint, type FootprintState } from "../../components/deco/Deco";

/**
 * The last seven days as footprints, oldest on the left. With `habitId` it
 * shows that habit; without, a day counts once any habit was done.
 */
export default function WeekFootprints({
  logs,
  today,
  habitId,
}: {
  logs: HabitLogMap;
  today: string;
  habitId?: number;
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = shiftDay(today, i - 6);
    const [y, m, d] = date.split("-").map(Number);
    const local = new Date(y, m - 1, d);
    const flags = logs[date] ?? {};
    const done = habitId === undefined ? Object.values(flags).some(Boolean) : !!flags[habitId];
    const state: FootprintState = done ? "done" : date === today ? "today" : "missed";
    return {
      date,
      initial: local.toLocaleDateString(locale(), { weekday: "narrow" }),
      name: local.toLocaleDateString(locale(), { weekday: "long" }),
      state,
      isToday: date === today,
    };
  });

  return (
    <div className="week" role="list" aria-label={t("habits.week")}>
      {days.map((d) => (
        <div key={d.date} className="week__day" role="listitem">
          <span className={`week__initial${d.isToday ? " week__initial--today" : ""}`} aria-hidden="true">
            {d.initial}
          </span>
          <Footprint state={d.state} label={`${d.name}: ${t(`habits.state.${d.state}`)}`} />
        </div>
      ))}
    </div>
  );
}
