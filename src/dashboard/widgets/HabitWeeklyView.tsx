import { useEffect, useState } from "react";
import { getHabitLogsSince, todayLocal } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { card, sectionLabel } from "../../styles/shared";
import type { HabitRow } from "./HabitItem";

/** 7-day completion grid, oldest day on the left. */
export default function HabitWeeklyView({ habits }: { habits: HabitRow[] }) {
  const [logs, setLogs] = useState<Record<string, Record<number, boolean>>>({});

  useEffect(() => {
    getHabitLogsSince(7).then(setLogs).catch(console.error);
  }, [habits]);

  const today = todayLocal();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      label: d.toLocaleDateString(locale(), { weekday: "short" }).slice(0, 2),
    };
  });

  if (habits.length === 0) return null;

  return (
    <div>
      <div style={sectionLabel}>{t("habits.week")}</div>
      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ width: "40%", padding: "0 0 6px" }} />
              {days.map((d) => (
                <th
                  key={d.date}
                  style={{
                    fontSize: 9,
                    color:
                      d.date === today ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.3)",
                    fontWeight: 400,
                    textAlign: "center",
                    padding: "0 0 6px",
                  }}
                >
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {habits.map((habit) => (
              <tr key={habit.id}>
                <td
                  title={habit.name}
                  style={{
                    fontSize: 11,
                    color: "rgba(255,255,255,0.5)",
                    padding: "3px 6px 3px 0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 0,
                  }}
                >
                  {habit.name}
                </td>
                {days.map((d) => {
                  const done = logs[d.date]?.[habit.id];
                  const isToday = d.date === today;
                  return (
                    <td key={d.date} style={{ textAlign: "center", padding: "3px 4px" }}>
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          margin: "0 auto",
                          background: done
                            ? "#00e5a0"
                            : isToday
                              ? "rgba(255,255,255,0.08)"
                              : "rgba(255,255,255,0.03)",
                          border: done ? "none" : "0.5px solid rgba(255,255,255,0.08)",
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
