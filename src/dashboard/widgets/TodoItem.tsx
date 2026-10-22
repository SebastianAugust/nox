import { getTodosFiltered } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { ClawMarks } from "../../components/deco/Deco";
import { IconButton, Tag } from "../../components/ui/controls";
import { dueInfo } from "../format";

export type TodoRow = Awaited<ReturnType<typeof getTodosFiltered>>[number] & { context?: string };

/**
 * One todo. The whole row is the checkbox's label, so clicking the title
 * ticks it. Overdue rows are danger-styled with claw marks and a tag.
 */
export default function TodoItem({
  todo,
  onToggle,
  onDelete,
}: {
  todo: TodoRow;
  onToggle: () => void;
  onDelete?: () => void;
}) {
  const done = todo.status === "done";
  const due = todo.due_date ? dueInfo(todo.due_date) : null;
  const overdue = !done && due?.kind === "overdue";
  const id = `todo-${todo.id}`;

  return (
    <div className={`todo${overdue ? " todo--overdue" : ""}${done ? " todo--done" : ""}`}>
      {overdue && <ClawMarks />}
      <label htmlFor={id} className="todo__label">
        <input id={id} type="checkbox" className="check" checked={done} onChange={onToggle} />
        {overdue ? (
          <Tag tone="overdue">{t("tag.overdue")}</Tag>
        ) : todo.notes === "reminder" ? (
          <Tag tone="neutral">{t("tag.reminder")}</Tag>
        ) : (
          todo.context === "personal" && <Tag tone="personal">{t("tag.personal")}</Tag>
        )}
        <span className="todo__title">{todo.title}</span>
        {due && !done && <span className={`todo__due todo__due--${due.kind}`}>{due.text}</span>}
      </label>
      {onDelete && (
        <IconButton label={t("todos.delete")} onClick={onDelete} className="icon-btn--danger todo__delete">
          <i className="ti ti-trash" aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
