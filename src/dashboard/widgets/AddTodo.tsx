import { useState } from "react";
import { addTodo, todayLocal } from "../../lib/db-helpers";
import { parseTodoArgs } from "../../lib/commands";
import { t } from "../../lib/i18n";

/**
 * Inline "Add a todo" field. Uses the pet's /todo parser, so "... besok",
 * "... today" and "... 25/12" set the due date. `defaultDue` applies when
 * none was typed (Home's Today card passes today, so the new row shows up
 * where it was added).
 */
export default function AddTodo({ onAdded, defaultDue }: { onAdded: () => void; defaultDue?: "today" }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const submit = async () => {
    const text = value.trim();
    if (!text || busy) return;
    const { title, due_date } = parseTodoArgs(text);
    if (!title) return;
    setBusy(true);
    try {
      await addTodo({
        title,
        due_date: due_date ?? (defaultDue === "today" ? todayLocal() : undefined),
        context: "personal",
      });
      setValue("");
      setError(false);
      onAdded();
    } catch (err) {
      console.error(err);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-todo-wrap">
      <div className="add-todo">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="add-todo__plus">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <label htmlFor="add-todo" className="sr-only">
          {t("todos.addLabel")}
        </label>
        <input
          id="add-todo"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") setValue("");
          }}
          placeholder={t("todos.addPlaceholder")}
          className="add-todo__input"
          aria-invalid={error || undefined}
          aria-describedby={error ? "add-todo-error" : undefined}
        />
      </div>
      {error && (
        <p id="add-todo-error" className="field-error" role="alert">
          {t("cmd.saveFailed")}
        </p>
      )}
    </div>
  );
}
