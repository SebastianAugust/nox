import { useCallback, useEffect, useState } from "react";
import { addTodo, deleteTodo, getTodosFiltered, setTodoStatus, type TodoFilter } from "../../lib/db-helpers";
import { t, type I18nKey } from "../../lib/i18n";
import { card, emptyText } from "../../styles/shared";
import Reminders from "../widgets/Reminders";
import TodoItem, { type TodoRow } from "../widgets/TodoItem";

export const FILTERS: { id: TodoFilter; label: I18nKey }[] = [
  { id: "pending", label: "todos.active" },
  { id: "done", label: "todos.done" },
  { id: "all", label: "todos.all" },
];

export default function PageTodos() {
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("pending");
  const [newTodo, setNewTodo] = useState("");
  const [newDate, setNewDate] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setTodos(await getTodosFiltered(filter));
  }, [filter]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const handleAdd = async () => {
    const title = newTodo.trim();
    if (!title) return;
    await addTodo({ title, due_date: newDate || undefined });
    setNewTodo("");
    setNewDate("");
    setAdding(false);
    await load();
  };

  const handleToggle = async (todo: TodoRow) => {
    await setTodoStatus(todo.id, todo.status === "done" ? "pending" : "done");
    await load();
  };

  const handleDelete = async (todo: TodoRow) => {
    await deleteTodo(todo.id);
    await load();
  };

  return (
    <>
      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 6 }}>
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                padding: "4px 12px",
                borderRadius: 20,
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
                background: active ? "rgba(0,229,160,0.15)" : "rgba(255,255,255,0.04)",
                border: active
                  ? "0.5px solid rgba(0,229,160,0.3)"
                  : "0.5px solid rgba(255,255,255,0.08)",
                color: active ? "#00e5a0" : "rgba(255,255,255,0.4)",
              }}
            >
              {t(f.label)}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div style={{ ...card, padding: "6px 14px" }}>
        {todos.length === 0 && (
          <div style={{ ...emptyText, textAlign: "center", padding: "18px 0" }}>
            {t(filter === "pending" ? "todos.emptyActive" : "todos.empty")}
          </div>
        )}
        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={() => void handleToggle(todo).catch(console.error)}
            onDelete={() => void handleDelete(todo).catch(console.error)}
          />
        ))}
      </div>

      {/* Add */}
      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            autoFocus
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd().catch(console.error);
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder={t("todos.placeholder")}
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "0.5px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "7px 10px",
              color: "rgba(255,255,255,0.85)",
              fontSize: 12,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.05)",
                border: "0.5px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                padding: "5px 10px",
                color: "rgba(255,255,255,0.5)",
                fontSize: 11,
                outline: "none",
                fontFamily: "inherit",
                colorScheme: "dark",
              }}
            />
            <button
              onClick={() => void handleAdd().catch(console.error)}
              style={{
                padding: "5px 16px",
                borderRadius: 8,
                background: "#00e5a0",
                border: "none",
                color: "#080a0d",
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("todos.addButton")}
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setNewTodo("");
                setNewDate("");
              }}
              style={{
                padding: "5px 12px",
                borderRadius: 8,
                background: "rgba(255,255,255,0.05)",
                border: "0.5px solid rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.4)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("todos.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{
            width: "100%",
            fontSize: 12,
            padding: 9,
            borderRadius: 8,
            background: "rgba(255,255,255,0.04)",
            border: "0.5px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.4)",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("todos.add")}
        </button>
      )}

      <Reminders />
    </>
  );
}
