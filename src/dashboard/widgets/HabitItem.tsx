import { useState } from "react";
import { t } from "../../lib/i18n";
import { rowBorder } from "../../styles/shared";

export type HabitRow = { id: number; name: string; completed: number };

/** One habit row. Delete appears on hover, and right-click also removes it. */
export default function HabitItem({
  habit,
  last,
  onToggle,
  onDelete,
}: {
  habit: HabitRow;
  last: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const done = habit.completed === 1;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setConfirming(false);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setConfirming(true);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        ...rowBorder(last),
      }}
    >
      <div
        onClick={onToggle}
        title={t("habits.toggle")}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          flexShrink: 0,
          cursor: "pointer",
          background: done ? "#00e5a0" : "transparent",
          border: done ? "none" : "0.5px solid rgba(255,255,255,0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done && (
          <i
            className="ti ti-check"
            style={{ fontSize: 11, color: "#080a0d" }}
            aria-hidden="true"
          />
        )}
      </div>
      <span
        onClick={onToggle}
        style={{
          fontSize: 13,
          flex: 1,
          cursor: "pointer",
          color: done ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)",
        }}
      >
        {habit.name}
      </span>

      {confirming ? (
        <button
          onClick={onDelete}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 6,
            background: "rgba(239,68,68,0.15)",
            border: "0.5px solid rgba(239,68,68,0.3)",
            color: "#f87171",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("habits.confirmDelete")}
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          title={t("habits.delete")}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.3)",
            fontSize: 12,
            cursor: "pointer",
            padding: "0 2px",
            visibility: hovered ? "visible" : "hidden",
          }}
        >
          <i className="ti ti-trash" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
