import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
  addSubtask,
  addTodoReminder,
  deleteSubtask,
  getSubtasks,
  getTodoReminders,
  moveSubtask,
  renameSubtask,
  setSubtaskDone,
  type Subtask,
  type TodoList,
  type TodoPatch,
  type TodoRecord,
  type TodoReminder,
} from "../../lib/todoRepo";
import type { AssignmentRow } from "../../lib/db-helpers";
import { suggestSteps } from "../../lib/capture";
import type { Priority } from "../../lib/todoParse";
import { ChunkyButton, IconButton } from "../../components/ui/controls";
import { dueChip, inputToStamp, PRIORITY_LABEL, stampLabel, stampToInput } from "./format";

const SAVE_DEBOUNCE_MS = 600;
const REPEATS = ["", "daily", "weekdays", "weekly", "monthly", "every"] as const;

type SaveState = "idle" | "saving" | "saved" | "error";

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton label={t("todo.details.close")} onClick={onClose} className="details__close">
      <i className="ti ti-x" aria-hidden="true" />
    </IconButton>
  );
}

/** The panel for one of Bas's todos. Every change saves itself. */
export function TodoDetails({
  todo,
  lists,
  courses,
  version,
  focusBusy,
  timeZone,
  onClose,
  onUpdate,
  onStartFocus,
  onDuplicate,
  canSendToNotion,
  onSendToNotion,
  onDelete,
}: {
  todo: TodoRecord;
  lists: TodoList[];
  courses: string[];
  /** Bumps whenever todos change anywhere, so steps and reminders reload. */
  version: number;
  focusBusy: boolean;
  timeZone?: string;
  onClose: () => void;
  onUpdate: (id: number, patch: TodoPatch) => Promise<boolean>;
  onStartFocus: () => void;
  onDuplicate: () => void;
  /** "Notion writes" is on and this todo is not linked to a page yet. */
  canSendToNotion?: boolean;
  onSendToNotion?: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes ?? "");
  const [course, setCourse] = useState(todo.course_name ?? "");
  const [steps, setSteps] = useState<Subtask[]>([]);
  const [reminders, setReminders] = useState<TodoReminder[]>([]);
  const [newStep, setNewStep] = useState("");
  const [save, setSave] = useState<SaveState>("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [remindAt, setRemindAt] = useState<string | null>(null);
  // Suggested steps from the local model: shown to pick from, never saved on their own.
  const [suggested, setSuggested] = useState<{ steps: string[]; picked: boolean[] } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(false);
  const timers = useRef<Record<string, { timer: number; patch: TodoPatch }>>({});
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  // A different todo, or the same one changed elsewhere: take its values,
  // except fields being typed in right now.
  useEffect(() => {
    const active = document.activeElement?.id;
    if (active !== "td-title") setTitle(todo.title);
    if (active !== "td-notes") setNotes(todo.notes ?? "");
    if (active !== "td-course") setCourse(todo.course_name ?? "");
  }, [todo.id, todo.title, todo.notes, todo.course_name]);

  useEffect(() => {
    setConfirmDelete(false);
    setRemindAt(null);
    setSuggested(null);
    setSuggestError(false);
    setSave("idle");
  }, [todo.id]);

  useEffect(() => {
    let live = true;
    Promise.all([getSubtasks(todo.id), getTodoReminders(todo.id)])
      .then(([s, r]) => {
        if (!live) return;
        setSteps(s);
        setReminders(r);
      })
      .catch(console.error);
    return () => {
      live = false;
    };
  }, [todo.id, version]);

  // Debounced saves still waiting go out (for this todo) when the panel
  // closes or switches to another todo; nothing typed is lost.
  useEffect(() => {
    const id = todo.id;
    const pending = timers.current;
    return () => {
      for (const [key, p] of Object.entries(pending)) {
        clearTimeout(p.timer);
        void onUpdateRef.current(id, p.patch);
        delete pending[key];
      }
    };
  }, [todo.id]);

  const commit = async (patch: TodoPatch) => {
    setSave("saving");
    const ok = await onUpdate(todo.id, patch);
    setSave(ok ? "saved" : "error");
  };
  const debounced = (key: string, patch: TodoPatch) => {
    clearTimeout(timers.current[key]?.timer);
    setSave("saving");
    timers.current[key] = {
      patch,
      timer: window.setTimeout(() => {
        delete timers.current[key];
        void commit(patch);
      }, SAVE_DEBOUNCE_MS),
    };
  };
  const flush = (key: string, patch: TodoPatch) => {
    clearTimeout(timers.current[key]?.timer);
    delete timers.current[key];
    void commit(patch);
  };

  const stepAction = async (fn: () => Promise<unknown>) => {
    setSave("saving");
    try {
      await fn();
      setSteps(await getSubtasks(todo.id));
      setSave("saved");
    } catch (err) {
      console.error(err);
      setSave("error");
    }
  };

  const repeatKind = !todo.repeat_rule ? "" : todo.repeat_rule.startsWith("every:") ? "every" : todo.repeat_rule;
  const everyN = todo.repeat_rule?.startsWith("every:") ? Number(todo.repeat_rule.slice(6)) : 2;
  const stepsDone = steps.filter((s) => s.done).length;
  const pending = reminders.filter((r) => r.status === "pending");

  const defaultRemind = () => {
    // 30 minutes before a timed due, else in an hour.
    if (todo.due_date && todo.due_time) {
      const at = new Date(`${todo.due_date}T${todo.due_time}`);
      at.setMinutes(at.getMinutes() - 30);
      if (at.getTime() > Date.now()) return stampToInput(at.toISOString().slice(0, 19).replace("T", " "));
    }
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    return stampToInput(soon.toISOString().slice(0, 19).replace("T", " "));
  };

  const askSteps = async () => {
    setSuggesting(true);
    setSuggestError(false);
    try {
      const list = await suggestSteps(todo.title, todo.notes);
      setSuggested({ steps: list, picked: list.map(() => true) });
    } catch {
      setSuggestError(true);
    } finally {
      setSuggesting(false);
    }
  };

  const addSuggested = async (all: boolean) => {
    if (!suggested) return;
    const chosen = suggested.steps.filter((_, i) => all || suggested.picked[i]);
    setSuggested(null);
    await stepAction(async () => {
      for (const title of chosen) await addSubtask(todo.id, title);
    });
  };

  const saveReminder = async () => {
    const stamp = remindAt ? inputToStamp(remindAt) : null;
    if (!stamp) return;
    await stepAction(async () => {
      await addTodoReminder(todo.id, todo.title, stamp);
      setReminders(await getTodoReminders(todo.id));
    });
    setRemindAt(null);
  };

  return (
    <aside id="todo-details" className="details" aria-label={t("todo.details.label")}>
      <div className="details__head">
        <label htmlFor="td-title" className="sr-only">
          {t("todo.details.title")}
        </label>
        <textarea
          id="td-title"
          className="details__title"
          rows={1}
          value={title}
          maxLength={300}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim()) debounced("title", { title: e.target.value });
          }}
          onBlur={() => (title.trim() ? flush("title", { title }) : setTitle(todo.title))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <CloseButton onClose={onClose} />
      </div>

      <div className="details__field">
        <span className="details__label" id="td-due-label">
          {t("todo.details.due")}
        </span>
        <div className="details__pair" role="group" aria-labelledby="td-due-label">
          <input
            type="date"
            className="field details__input"
            aria-label={t("todo.details.date")}
            value={todo.due_date ?? ""}
            onChange={(e) => void commit({ due_date: e.target.value || null })}
          />
          <input
            type="time"
            className="field details__input details__input--time"
            aria-label={t("todo.details.time")}
            value={todo.due_time ?? ""}
            disabled={!todo.due_date}
            onChange={(e) => void commit({ due_time: e.target.value || null })}
          />
          {todo.due_date && (
            <IconButton label={t("todo.details.clearDue")} onClick={() => void commit({ due_date: null, due_time: null })}>
              <i className="ti ti-x" aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>

      <div className="details__field">
        <span className="details__label" id="td-pri-label">
          {t("todo.details.priority")}
        </span>
        <div className="segmented" role="radiogroup" aria-labelledby="td-pri-label">
          {([0, 1, 2, 3] as Priority[]).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={todo.priority === p}
              className={`segmented__opt segmented__opt--pri${p}${todo.priority === p ? " segmented__opt--on" : ""}`}
              onClick={() => void commit({ priority: p })}
            >
              {t(PRIORITY_LABEL[p])}
            </button>
          ))}
        </div>
      </div>

      <div className="details__row">
        <div className="details__field">
          <label className="details__label" htmlFor="td-list">
            {t("todo.details.list")}
          </label>
          <select
            id="td-list"
            className="field field--select details__input"
            value={todo.list_id ?? ""}
            onChange={(e) => void commit({ list_id: Number(e.target.value) })}
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="details__field">
          <label className="details__label" htmlFor="td-course">
            {t("todo.details.course")}
          </label>
          <input
            id="td-course"
            className="field details__input"
            list="td-courses"
            value={course}
            placeholder={t("todo.details.none")}
            onChange={(e) => {
              setCourse(e.target.value);
              debounced("course", { course_name: e.target.value });
            }}
            onBlur={() => flush("course", { course_name: course })}
          />
          <datalist id="td-courses">
            {courses.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="details__row">
        <div className="details__field">
          <label className="details__label" htmlFor="td-repeat">
            {t("todo.details.repeat")}
          </label>
          <div className="details__pair">
            <select
              id="td-repeat"
              className="field field--select details__input"
              value={repeatKind}
              onChange={(e) => {
                const v = e.target.value;
                void commit({ repeat_rule: v === "" ? null : v === "every" ? `every:${everyN}` : v });
              }}
            >
              {REPEATS.map((r) => (
                <option key={r} value={r}>
                  {t(r === "" ? "todo.repeat.none" : r === "every" ? "todo.repeat.everyNPick" : `todo.repeat.${r}`)}
                </option>
              ))}
            </select>
            {repeatKind === "every" && (
              <input
                type="number"
                min={1}
                max={365}
                className="field details__input details__input--num"
                aria-label={t("todo.repeat.days")}
                value={everyN}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(365, Number(e.target.value) || 1));
                  void commit({ repeat_rule: `every:${n}` });
                }}
              />
            )}
          </div>
        </div>
        <div className="details__field">
          <span className="details__label">{t("todo.details.reminder")}</span>
          <span className="details__value">
            {pending.length ? stampLabel(pending[0].remind_at, timeZone) : t("todo.details.reminderOff")}
          </span>
        </div>
      </div>

      <div className="details__field">
        <label className="details__label" htmlFor="td-notes">
          {t("todo.details.notes")}
        </label>
        <textarea
          id="td-notes"
          className="field details__notes"
          rows={3}
          value={notes}
          placeholder={t("todo.details.notesEmpty")}
          onChange={(e) => {
            setNotes(e.target.value);
            debounced("notes", { notes: e.target.value });
          }}
          onBlur={() => flush("notes", { notes })}
        />
      </div>

      <div className="details__field">
        <div className="details__label-row">
          <span className="details__label" id="td-steps-label">
            {t("todo.details.steps")}
          </span>
          <span className="details__label">
            {steps.length ? t("todo.details.stepsOf", { done: stepsDone, total: steps.length }) : t("todo.details.none")}
          </span>
        </div>
        {steps.length > 0 && (
          <div
            className="steps-bar"
            role="progressbar"
            aria-labelledby="td-steps-label"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={stepsDone}
          >
            <span style={{ inlineSize: `${(stepsDone / steps.length) * 100}%` }} />
          </div>
        )}
        <ul className="steps" aria-labelledby="td-steps-label">
          {steps.map((s, i) => (
            <li key={s.id} className={`step${s.done ? " step--done" : ""}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={!!s.done}
                aria-label={s.title}
                className={`tbox tbox--sm${s.done ? " tbox--on" : ""}`}
                onClick={() => void stepAction(() => setSubtaskDone(s.id, !s.done))}
              >
                <i className="ti ti-check" aria-hidden="true" />
              </button>
              <input
                className="step__title"
                aria-label={t("todo.details.stepName")}
                defaultValue={s.title}
                onBlur={(e) => e.target.value.trim() !== s.title && void stepAction(() => renameSubtask(s.id, e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <IconButton label={t("todo.details.stepUp")} disabled={i === 0} onClick={() => void stepAction(() => moveSubtask(s.id, -1))}>
                <i className="ti ti-chevron-up" aria-hidden="true" />
              </IconButton>
              <IconButton
                label={t("todo.details.stepDown")}
                disabled={i === steps.length - 1}
                onClick={() => void stepAction(() => moveSubtask(s.id, 1))}
              >
                <i className="ti ti-chevron-down" aria-hidden="true" />
              </IconButton>
              <IconButton label={t("todo.details.stepDelete")} className="icon-btn--danger" onClick={() => void stepAction(() => deleteSubtask(s.id))}>
                <i className="ti ti-trash" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
        <form
          className="step-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newStep.trim()) return;
            void stepAction(() => addSubtask(todo.id, newStep)).then(() => setNewStep(""));
          }}
        >
          <i className="ti ti-plus" aria-hidden="true" />
          <label htmlFor="td-new-step" className="sr-only">
            {t("todo.details.addStep")}
          </label>
          <input
            id="td-new-step"
            className="step-add__input"
            placeholder={t("todo.details.addStep")}
            value={newStep}
            onChange={(e) => setNewStep(e.target.value)}
          />
        </form>
        {!suggested && (
          <button type="button" className="link-btn suggest-btn" disabled={suggesting} onClick={() => void askSteps()}>
            <i className="ti ti-list-check" aria-hidden="true" /> {t(suggesting ? "cap.suggesting" : "cap.suggest")}
          </button>
        )}
        {suggestError && (
          <p className="field-error" role="alert">
            {t("cap.suggestFailed")}
          </p>
        )}
        {suggested && (
          <div className="suggested" role="group" aria-label={t("cap.suggested")}>
            <span className="details__label">{t("cap.suggested")}</span>
            <ul className="steps">
              {suggested.steps.map((step, i) => (
                <li key={step} className="step">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={suggested.picked[i]}
                    aria-label={step}
                    className={`tbox tbox--sm${suggested.picked[i] ? " tbox--on" : ""}`}
                    onClick={() =>
                      setSuggested((cur) => cur && { ...cur, picked: cur.picked.map((v, k) => (k === i ? !v : v)) })
                    }
                  >
                    <i className="ti ti-check" aria-hidden="true" />
                  </button>
                  <span className="step__title">{step}</span>
                </li>
              ))}
            </ul>
            <div className="details__pair">
              <ChunkyButton size="sm" disabled={!suggested.picked.some(Boolean)} onClick={() => void addSuggested(false)}>
                {t("cap.addSelected")}
              </ChunkyButton>
              <ChunkyButton size="sm" variant="secondary" onClick={() => void addSuggested(true)}>
                {t("cap.addAll")}
              </ChunkyButton>
              <ChunkyButton size="sm" variant="quiet" onClick={() => setSuggested(null)}>
                {t("cap.dismiss")}
              </ChunkyButton>
            </div>
          </div>
        )}
      </div>

      <div className="focus-row">
        <span className="details__label">{t("todo.details.focus")}</span>
        <span className="focus-row__dots" aria-hidden="true">
          {Array.from({ length: todo.estimate_pomodoros }, (_, i) => (
            <span key={i} className={`focus-dot${i < todo.focus_done ? " focus-dot--done" : ""}`} />
          ))}
        </span>
        <span className="focus-row__text">
          {todo.estimate_pomodoros
            ? t("todo.details.sessionsOf", { done: todo.focus_done, total: todo.estimate_pomodoros })
            : todo.focus_done
              ? t("todo.details.sessionsDone", { n: todo.focus_done })
              : t("todo.details.noEstimate")}
        </span>
        <span className="focus-row__stepper">
          <IconButton
            label={t("todo.details.estimateLess")}
            disabled={todo.estimate_pomodoros <= 0}
            onClick={() => void commit({ estimate_pomodoros: todo.estimate_pomodoros - 1 })}
          >
            <span aria-hidden="true">−</span>
          </IconButton>
          <IconButton
            label={t("todo.details.estimateMore")}
            disabled={todo.estimate_pomodoros >= 20}
            onClick={() => void commit({ estimate_pomodoros: todo.estimate_pomodoros + 1 })}
          >
            <span aria-hidden="true">+</span>
          </IconButton>
        </span>
      </div>

      <div className="details__actions">
        <ChunkyButton className="details__primary" disabled={focusBusy || todo.status === "done"} onClick={onStartFocus}>
          <i className="ti ti-player-play" aria-hidden="true" /> {t("todo.details.startFocus")}
        </ChunkyButton>
        <ChunkyButton variant="secondary" onClick={() => setRemindAt(remindAt === null ? defaultRemind() : null)} aria-expanded={remindAt !== null}>
          {t("todo.details.remindMe")}
        </ChunkyButton>
      </div>
      {focusBusy && <p className="muted">{t("todo.details.focusBusy")}</p>}

      {remindAt !== null && (
        <form
          className="details__remind"
          onSubmit={(e) => {
            e.preventDefault();
            void saveReminder();
          }}
        >
          <label htmlFor="td-remind-at" className="details__label">
            {t("todo.details.remindAt")}
          </label>
          <div className="details__pair">
            <input
              id="td-remind-at"
              type="datetime-local"
              className="field details__input"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
            />
            <ChunkyButton type="submit" size="sm">
              {t("todo.details.remindSave")}
            </ChunkyButton>
          </div>
        </form>
      )}

      <div className="details__foot">
        <span className={`saved saved--${save}`} role="status">
          {save !== "idle" && <span className="saved__dot" aria-hidden="true" />}
          {save === "saving" ? t("todo.details.saving") : save === "saved" ? t("todo.details.saved") : save === "error" ? t("todo.details.saveFailed") : ""}
        </span>
        <span className="details__links">
          {canSendToNotion && (
            <button type="button" className="link-btn" onClick={onSendToNotion}>
              {t("todo.details.sendNotion")}
            </button>
          )}
          <button type="button" className="link-btn" onClick={onDuplicate}>
            {t("todo.details.duplicate")}
          </button>
          {confirmDelete ? (
            <>
              <button type="button" className="link-btn link-btn--danger" onClick={onDelete}>
                {t("todo.details.deleteConfirm")}
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirmDelete(false)}>
                {t("todo.cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirmDelete(true)}>
              {t("todo.details.delete")}
            </button>
          )}
        </span>
      </div>
    </aside>
  );
}

/** The panel for a Notion assignment: read-only, with "Add to my todos". */
export function NotionDetails({
  assignment,
  copiedId,
  today,
  onClose,
  onCopy,
  onOpenCopy,
}: {
  assignment: AssignmentRow;
  copiedId: number | null;
  today: string;
  onClose: () => void;
  onCopy: () => void;
  onOpenCopy: (id: number) => void;
}) {
  const date = assignment.due_date.slice(0, 10);
  const time = assignment.due_date.length >= 16 ? assignment.due_date.slice(11, 16) : null;
  return (
    <aside id="todo-details" className="details" aria-label={t("todo.details.label")}>
      <div className="details__head">
        <h2 className="details__heading">{assignment.name}</h2>
        <CloseButton onClose={onClose} />
      </div>
      <p className="details__notion">
        <span className="badge-notion">NOTION</span>
        {t("todo.notion.readOnly")}
      </p>
      <div className="details__row">
        <div className="details__field">
          <span className="details__label">{t("todo.details.due")}</span>
          <span className="details__value">{dueChip(date, time, today).text}</span>
        </div>
        <div className="details__field">
          <span className="details__label">{t("todo.details.course")}</span>
          <span className="details__value">{assignment.course ?? t("todo.details.none")}</span>
        </div>
      </div>
      {assignment.notion_status && (
        <div className="details__field">
          <span className="details__label">{t("todo.notion.status")}</span>
          <span className="details__value">{assignment.notion_status}</span>
        </div>
      )}
      <div className="details__actions">
        {copiedId ? (
          <ChunkyButton variant="secondary" className="details__primary" onClick={() => onOpenCopy(copiedId)}>
            {t("todo.notion.openCopy")}
          </ChunkyButton>
        ) : (
          <ChunkyButton className="details__primary" onClick={onCopy}>
            {t("todo.notion.add")}
          </ChunkyButton>
        )}
      </div>
    </aside>
  );
}
