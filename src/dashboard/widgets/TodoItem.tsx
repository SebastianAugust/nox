import { useState } from "react";
import { getTodosFiltered } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { rowBorder } from "../../styles/shared";
import { formatDue } from "../format";

export type TodoRow = Awaited<ReturnType<typeof getTodosFiltered>>[number];

/** One todo row; delete only appears on hover so the list stays quiet. */
export default function TodoItem({
  todo,
  last,
  onToggle,
  onDelete,
}: {
  todo: TodoRow;
  last: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const done = todo.status === "done";
  const due = todo.due_date ? formatDue(todo.due_date) : null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: "8px 0",
        ...rowBorder(last),
      }}
    >
      <div
        onClick={onToggle}
        title={t("todos.toggle")}
        style={{
          width: 15,
          height: 15,
          borderRadius: 4,
          flexShrink: 0,
          marginTop: 1,
          cursor: "pointer",
          background: done ? "#00e5a0" : "transparent",
          border: done ? "none" : "0.5px solid rgba(255,255,255,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done && (
          <i
            className="ti ti-check"
            style={{ fontSize: 10, color: "#080a0d" }}
            aria-hidden="true"
          />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          onClick={onToggle}
          style={{
            fontSize: 12,
            cursor: "pointer",
            color: done ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.75)",
            textDecoration: done ? "line-through" : "none",
            wordBreak: "break-word",
          }}
        >
          {todo.title}
        </div>
        {due && (
          <div style={{ fontSize: 10, color: due.color, marginTop: 2 }}>
            {todo.notes === "reminder" ? t("todos.reminder") : ""}
            {due.text}
          </div>
        )}
      </div>
      <button
        onClick={onDelete}
        title={t("todos.delete")}
        style={{
          background: "none",
          border: "none",
          color: "rgba(248,113,113,0.6)",
          fontSize: 12,
          cursor: "pointer",
          flexShrink: 0,
          padding: "0 2px",
          visibility: hovered ? "visible" : "hidden",
        }}
      >
        <i className="ti ti-trash" aria-hidden="true" />
      </button>
    </div>
  );
}
