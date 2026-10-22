import { useCallback, useEffect, useState } from "react";
import { addHabit, deleteHabit, getHabitStreaks, getTodayHabitLogs, logHabit } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { card, emptyText, sectionLabel, statCard } from "../../styles/shared";
import HabitItem, { type HabitRow } from "../widgets/HabitItem";
import HabitWeeklyView from "../widgets/HabitWeeklyView";

export default function PageHabits() {
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [streaks, setStreaks] = useState({ current: 0, best: 0 });
  const [newHabit, setNewHabit] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [rows, s] = await Promise.all([getTodayHabitLogs(), getHabitStreaks()]);
    setHabits(rows as HabitRow[]);
    setStreaks(s);
  }, []);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const handleToggle = async (habit: HabitRow) => {
    // Optimistic: the checkbox should never lag behind the click.
    setHabits((prev) =>
      prev.map((h) => (h.id === habit.id ? { ...h, completed: h.completed ? 0 : 1 } : h)),
    );
    try {
      await logHabit(habit.id, !habit.completed);
      await load();
    } catch (err) {
      console.error(err);
      await load(); // put the real state back
    }
  };

  const handleAdd = async () => {
    const name = newHabit.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    await addHabit(name);
    setNewHabit("");
    setAdding(false);
    await load();
  };

  const handleDelete = async (habit: HabitRow) => {
    await deleteHabit(habit.id);
    await load();
  };

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("habits.today")}</div>
        <div style={card}>
          {habits.length === 0 && !adding && (
            <div style={emptyText}>{t("habits.empty")}</div>
          )}
          {habits.map((h, i) => (
            <HabitItem
              key={h.id}
              habit={h}
              last={i === habits.length - 1 && !adding}
              onToggle={() => handleToggle(h)}
              onDelete={() => handleDelete(h)}
            />
          ))}

          {adding && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  flexShrink: 0,
                  border: "0.5px solid rgba(255,255,255,0.15)",
                }}
              />
              <input
                autoFocus
                value={newHabit}
                onChange={(e) => setNewHabit(e.target.value)}
                onBlur={() => void handleAdd().catch(console.error)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd().catch(console.error);
                  if (e.key === "Escape") {
                    setNewHabit("");
                    setAdding(false);
                  }
                }}
                placeholder={t("habits.new")}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "rgba(255,255,255,0.8)",
                  fontSize: 13,
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 500, color: "#00e5a0", marginBottom: 3 }}>
            {streaks.current}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{t("habits.streak")}</div>
        </div>
        <div style={statCard}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: "rgba(255,255,255,0.85)",
              marginBottom: 3,
            }}
          >
            {streaks.best}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{t("habits.best")}</div>
        </div>
      </div>

      <HabitWeeklyView habits={habits} />

      <button
        onClick={() => setAdding(true)}
        style={{
          width: "100%",
          fontSize: 13,
          padding: 10,
          borderRadius: 8,
          background: "rgba(255,255,255,0.04)",
          border: "0.5px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.4)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {t("habits.add")}
      </button>
    </>
  );
}
