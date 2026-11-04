import { forwardRef, useEffect, useMemo, useState } from "react";
import { t } from "../../lib/i18n";
import { matchName, resolveCourse } from "../../lib/todoLogic";
import { parseQuickAdd, type QuickAdd as Parsed } from "../../lib/todoParse";
import type { TodoList } from "../../lib/todoRepo";
import { ChunkyButton } from "../../components/ui/controls";
import { dueChip, PRIORITY_LABEL, repeatLabel } from "./format";

type Chip = { kind: string; text: string; className?: string };

/**
 * The dashed add bar with a live "Nox understood" row: the same parser the
 * pet's /todo uses. Enter adds; Shift+Enter adds and keeps the cursor here
 * for the next one.
 */
export const QuickAdd = forwardRef<
  HTMLInputElement,
  {
    lists: TodoList[];
    courses: string[];
    today: string;
    onAdd: (q: Parsed) => Promise<boolean>;
    prefill?: { text: string; n: number } | null;
  }
>(function QuickAdd({ lists, courses, today, onAdd, prefill }, ref) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseQuickAdd(value), [value]);

  // Filled in from elsewhere (capture "Edit"); Bas checks it and presses Enter.
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    document.getElementById("todo-quick-add")?.focus();
    // Only a new request (n) refills; typing afterwards is not overwritten.
  }, [prefill?.n]);

  const chips = useMemo<Chip[]>(() => {
    if (!value.trim()) return [];
    const out: Chip[] = [{ kind: t("todo.chip.title"), text: parsed.title || "—" }];
    if (parsed.due_date) {
      const due = dueChip(parsed.due_date, parsed.due_time ?? null, today);
      out.push({ kind: t("todo.chip.due"), text: due.text, className: `qchip--${due.tone}` });
    }
    if (parsed.priority) {
      out.push({ kind: t("todo.chip.priority"), text: t(PRIORITY_LABEL[parsed.priority]), className: `qchip--pri${parsed.priority}` });
    }
    const list = matchName(lists, parsed.list) ?? lists.find((l) => l.is_default);
    if (parsed.list && !matchName(lists, parsed.list)) {
      out.push({ kind: t("todo.chip.list"), text: t("todo.chip.noList", { list: parsed.list, fallback: list?.name ?? "" }), className: "qchip--warn" });
    } else if (list) {
      out.push({ kind: t("todo.chip.list"), text: list.name, className: `qchip--list list-${list.color}` });
    }
    if (parsed.course) out.push({ kind: t("todo.chip.course"), text: resolveCourse(parsed.course, courses) ?? parsed.course });
    if (parsed.estimate) {
      out.push({
        kind: t("todo.chip.estimate"),
        text: parsed.estimateMinutes
          ? t("todo.chip.minutes", { min: parsed.estimateMinutes, n: parsed.estimate })
          : t("todo.chip.sessions", { n: parsed.estimate }),
        className: "qchip--bolt",
      });
    }
    if (parsed.repeat) out.push({ kind: t("todo.chip.repeat"), text: repeatLabel(parsed.repeat) });
    return out;
  }, [parsed, value, lists, courses, today]);

  const submit = async (keepFocus: boolean, input?: HTMLInputElement) => {
    if (busy || !parsed.title) return;
    setBusy(true);
    const ok = await onAdd(parsed);
    setBusy(false);
    if (!ok) return;
    setValue("");
    if (keepFocus) input?.focus();
    else input?.blur();
  };

  return (
    <div className="quick-add">
      <div className="quick-add__row">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="add-todo__plus">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <label htmlFor="todo-quick-add" className="sr-only">
          {t("todos.addLabel")}
        </label>
        <input
          ref={ref}
          id="todo-quick-add"
          className="quick-add__input"
          value={value}
          placeholder={t("todo.add.placeholder")}
          autoComplete="off"
          aria-describedby="todo-quick-add-understood todo-quick-add-hint"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(e.shiftKey, e.currentTarget);
            } else if (e.key === "Escape" && value) {
              e.stopPropagation();
              setValue("");
            }
          }}
        />
        <ChunkyButton
          size="sm"
          disabled={busy || !parsed.title}
          onClick={(e) => void submit(false, e.currentTarget.parentElement?.querySelector("input") ?? undefined)}
        >
          {t("todo.add.button")}
        </ChunkyButton>
      </div>
      <div id="todo-quick-add-understood" className="quick-add__chips" aria-live="polite">
        <span className="quick-add__label">{t("todo.add.understood")}</span>
        {chips.length === 0 ? (
          <span className="quick-add__empty">{t("todo.add.understoodEmpty")}</span>
        ) : (
          chips.map((c) => (
            <span key={c.kind} className={`qchip${c.className ? ` ${c.className}` : ""}`}>
              <span className="qchip__kind">{c.kind}</span>
              {c.text}
            </span>
          ))
        )}
      </div>
      <p id="todo-quick-add-hint" className="quick-add__hint">
        {t("todo.add.hint")}
      </p>
    </div>
  );
});
