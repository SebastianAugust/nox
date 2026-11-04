import { memo } from "react";
import { t } from "../../lib/i18n";
import type { ListItem } from "../../lib/todoLogic";
import type { TodoRecord } from "../../lib/todoRepo";
import { dueChip, PRIORITY_LABEL } from "./format";

/**
 * One row. The box on the left completes the todo (or, in select mode,
 * picks it); the rest is one button that opens the details panel. Space on
 * that button completes, Enter opens (handled by the page).
 */
export const TodoRow = memo(function TodoRow({
  item,
  record,
  today,
  open,
  selectMode,
  picked,
  onToggle,
  onOpen,
  onPick,
  notionWritable,
}: {
  item: ListItem;
  record: TodoRecord | null;
  today: string;
  open: boolean;
  selectMode: boolean;
  picked: boolean;
  onToggle: (key: string) => void;
  onOpen: (key: string) => void;
  onPick: (key: string) => void;
  /** With "Notion writes" on, a Notion row can be ticked (Done in Notion). */
  notionWritable?: boolean;
}) {
  const notion = item.kind === "notion";
  const due = item.due_date ? dueChip(item.due_date, item.due_time, today) : null;
  const overdue = !item.done && due?.tone === "overdue";
  const boxChecked = selectMode ? picked : item.done;
  const boxLabel = selectMode
    ? t("todo.row.select", { title: item.title })
    : t(item.done ? "todo.row.undone" : "todo.row.done", { title: item.title });

  return (
    <li
      className={`trow${open ? " trow--open" : ""}${overdue ? " trow--overdue" : ""}${item.done ? " trow--done" : ""}${
        selectMode && picked ? " trow--picked" : ""
      }`}
    >
      {/* Notion rows are read-only unless Notion writes are on; never picked. */}
      {notion && (!notionWritable || selectMode) ? (
        <span className="tbox tbox--none" aria-hidden="true" />
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={boxChecked}
          aria-label={boxLabel}
          className={`tbox${boxChecked ? " tbox--on" : ""}${selectMode ? " tbox--select" : ""}`}
          onClick={() => (selectMode && !notion ? onPick(item.key) : onToggle(item.key))}
        >
          <i className="ti ti-check" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="trow__main"
        data-row={item.key}
        aria-expanded={open}
        aria-controls={open ? "todo-details" : undefined}
        onClick={() => onOpen(item.key)}
      >
        <span className="trow__title-line">
          <span className="trow__title">{item.title}</span>
          {notion && <span className="badge-notion">NOTION</span>}
        </span>
        <span className="trow__meta">
          {due && <span className={`tchip tchip--${item.done ? "later" : due.tone}`}>{due.text}</span>}
          {item.priority > 0 && (
            <span className={`tchip tchip--pri tchip--pri${item.priority}`}>
              <i className="ti ti-flag" aria-hidden="true" />
              {t(PRIORITY_LABEL[item.priority])}
            </span>
          )}
          {record?.list_name && (
            <span className="tmeta">
              <span className={`list-dot list-${record.list_color ?? "slate"}`} aria-hidden="true" />
              {record.list_name}
            </span>
          )}
          {item.course && <span className="tmeta">· {item.course}</span>}
          {record && record.steps_total > 0 && (
            <span className="tmeta tmeta--strong">
              · {t("todo.row.steps", { done: record.steps_done, total: record.steps_total })}
            </span>
          )}
          {record?.repeat_rule && (
            <span className="tmeta tmeta--strong">
              · <i className="ti ti-repeat" aria-hidden="true" /> {t("todo.row.repeats")}
            </span>
          )}
          {record && record.estimate_pomodoros > 0 && (
            <span className="tmeta tmeta--focus">
              · {t("todo.row.focus", { done: record.focus_done, total: record.estimate_pomodoros })}
            </span>
          )}
          {record?.next_reminder_at && (
            <span className="tmeta tmeta--bell">
              <i className="ti ti-bell" aria-hidden="true" />
              {t("todo.row.reminder")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
});
