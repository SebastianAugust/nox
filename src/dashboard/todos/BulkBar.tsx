import { useState } from "react";
import { t } from "../../lib/i18n";
import type { Priority } from "../../lib/todoParse";
import type { TodoList } from "../../lib/todoRepo";
import { ChunkyButton } from "../../components/ui/controls";
import { PRIORITY_LABEL } from "./format";

type Panel = null | "date" | "priority" | "list" | "delete";

/** Select mode's action bar. Each action opens a small inline step. */
export function BulkBar({
  count,
  viewCount,
  lists,
  today,
  onSelectAll,
  onComplete,
  onSetDate,
  onPriority,
  onMove,
  onDelete,
  onCancel,
}: {
  count: number;
  viewCount: number;
  lists: TodoList[];
  today: string;
  onSelectAll: () => void;
  onComplete: () => void;
  onSetDate: (date: string | null) => void;
  onPriority: (p: Priority) => void;
  onMove: (listId: number) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [date, setDate] = useState(today);
  const none = count === 0;
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const done = (fn: () => void) => {
    fn();
    setPanel(null);
  };

  return (
    <div className="bulk" role="toolbar" aria-label={t("todo.bulk.label")}>
      <div className="bulk__row">
        <span className="bulk__count" aria-live="polite">
          {t("todo.bulk.selected", { n: count })}
        </span>
        <button type="button" className="link-btn" onClick={onSelectAll} disabled={viewCount === 0}>
          {t("todo.bulk.all", { n: viewCount })}
        </button>
        <span className="bulk__actions">
          <ChunkyButton size="sm" disabled={none} onClick={() => done(onComplete)}>
            {t("todo.bulk.complete")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" disabled={none} aria-expanded={panel === "date"} onClick={() => toggle("date")}>
            {t("todo.bulk.date")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" disabled={none} aria-expanded={panel === "priority"} onClick={() => toggle("priority")}>
            {t("todo.bulk.priority")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" disabled={none} aria-expanded={panel === "list"} onClick={() => toggle("list")}>
            {t("todo.bulk.move")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="danger" disabled={none} aria-expanded={panel === "delete"} onClick={() => toggle("delete")}>
            {t("todo.bulk.delete")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="quiet" onClick={onCancel}>
            {t("todo.cancel")}
          </ChunkyButton>
        </span>
      </div>

      {panel === "date" && (
        <form
          className="bulk__step"
          onSubmit={(e) => {
            e.preventDefault();
            done(() => onSetDate(date || null));
          }}
        >
          <label htmlFor="bulk-date" className="details__label">
            {t("todo.bulk.dateLabel")}
          </label>
          <input id="bulk-date" type="date" className="field field--short" value={date} onChange={(e) => setDate(e.target.value)} />
          <ChunkyButton type="submit" size="sm">
            {t("todo.bulk.apply")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" onClick={() => done(() => onSetDate(null))}>
            {t("todo.bulk.clearDate")}
          </ChunkyButton>
        </form>
      )}
      {panel === "priority" && (
        <div className="bulk__step" role="group" aria-label={t("todo.bulk.priority")}>
          {([3, 2, 1, 0] as Priority[]).map((p) => (
            <ChunkyButton key={p} size="sm" variant="secondary" className={`pri-btn pri-btn--${p}`} onClick={() => done(() => onPriority(p))}>
              {t(PRIORITY_LABEL[p])}
            </ChunkyButton>
          ))}
        </div>
      )}
      {panel === "list" && (
        <div className="bulk__step" role="group" aria-label={t("todo.bulk.move")}>
          {lists.map((l) => (
            <ChunkyButton key={l.id} size="sm" variant="secondary" onClick={() => done(() => onMove(l.id))}>
              <span className={`list-dot list-${l.color}`} aria-hidden="true" /> {l.name}
            </ChunkyButton>
          ))}
        </div>
      )}
      {panel === "delete" && (
        <div className="bulk__step" role="alert">
          <span>{t("todo.bulk.deleteAsk", { n: count })}</span>
          <ChunkyButton size="sm" variant="danger" onClick={() => done(onDelete)}>
            {t("todo.bulk.deleteYes")}
          </ChunkyButton>
          <ChunkyButton size="sm" variant="secondary" onClick={() => setPanel(null)}>
            {t("todo.cancel")}
          </ChunkyButton>
        </div>
      )}
    </div>
  );
}
