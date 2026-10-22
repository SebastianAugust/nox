import { useCallback, useEffect, useState } from "react";
import { deleteTodo, getTodosFiltered, setTodoStatus, type TodoFilter } from "../../lib/db-helpers";
import { t, type I18nKey } from "../../lib/i18n";
import { MoonStars } from "../../components/deco/Deco";
import { Pill } from "../../components/ui/controls";
import AddTodo from "../widgets/AddTodo";
import Reminders from "../widgets/Reminders";
import TodoItem, { type TodoRow } from "../widgets/TodoItem";

const FILTERS: { id: TodoFilter; label: I18nKey }[] = [
  { id: "pending", label: "todos.active" },
  { id: "done", label: "todos.done" },
  { id: "all", label: "todos.all" },
];

export default function PageTodos() {
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("pending");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setTodos(await getTodosFiltered(filter));
    setLoaded(true);
  }, [filter]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

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
      <AddTodo onAdded={() => void load().catch(console.error)} />

      <section className="card" aria-labelledby="todos-title">
        <div className="card__head">
          <h2 id="todos-title" className="card__title">
            {t("nav.todos")}
          </h2>
          <div className="filters" role="group" aria-label={t("todos.filter")}>
            {FILTERS.map((f) => (
              <Pill key={f.id} selected={filter === f.id} onClick={() => setFilter(f.id)}>
                {t(f.label)}
              </Pill>
            ))}
          </div>
        </div>

        {loaded && todos.length === 0 && (
          <div className="empty-state empty-state--inline">
            <MoonStars />
            <p>{t(filter === "pending" ? "todos.emptyActive" : filter === "done" ? "todos.emptyDone" : "todos.empty")}</p>
          </div>
        )}

        <div className="todo-list">
          {todos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onToggle={() => void handleToggle(todo).catch(console.error)}
              onDelete={() => void handleDelete(todo).catch(console.error)}
            />
          ))}
        </div>
      </section>

      <Reminders />
    </>
  );
}
