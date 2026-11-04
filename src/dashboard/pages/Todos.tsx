import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getSettings } from "../../lib/db";
import { getOpenAssignments, setSetting, todayLocal, type AssignmentRow } from "../../lib/db-helpers";
import { t, type I18nKey } from "../../lib/i18n";
import type { Appearance } from "../../lib/theme";
import { buildList, inView, summary, viewCounts, VIEWS, SORTS, type ListItem, type SortKey, type View } from "../../lib/todoLogic";
import type { Priority, QuickAdd as Parsed } from "../../lib/todoParse";
import {
  bulkComplete,
  bulkDelete,
  bulkMoveToList,
  bulkSetDue,
  bulkSetPriority,
  completeTodo,
  copiedNotionIds,
  copyFromNotion,
  courseNames,
  createFromQuickAdd,
  deleteTodo,
  duplicateTodo,
  getLists,
  listTodos,
  reopenTodo,
  seedDemoTodos,
  updateTodo,
  type TodoList,
  type TodoPatch,
  type TodoRecord,
} from "../../lib/todoRepo";
import { failedWrites, queueCreate, queueSetDone, queueUpdate, type OutboxError } from "../../lib/notionOutbox";
import { MoonStars } from "../../components/deco/Deco";
import { usePomodoro } from "../../components/Pomodoro";
import { ChunkyButton, Toggle } from "../../components/ui/controls";
import PageHeader from "../PageHeader";
import Reminders from "../widgets/Reminders";
import { BulkBar } from "../todos/BulkBar";
import { NotionDetails, TodoDetails } from "../todos/DetailsPanel";
import { groupTitle } from "../todos/format";
import { QuickAdd } from "../todos/QuickAdd";
import { TodoRow } from "../todos/TodoRow";
import { ToastStack, useToasts } from "../todos/Toasts";

// Dev builds only: generate a long list to check scrolling and filtering.
if (import.meta.env.DEV) {
  (window as unknown as { __noxSeedTodos?: (n: number) => Promise<void> }).__noxSeedTodos = (n: number) => seedDemoTodos(n);
}

const VIEW_LABEL: Record<View, I18nKey> = {
  today: "todo.view.today",
  upcoming: "todo.view.upcoming",
  inbox: "todo.view.inbox",
  overdue: "todo.view.overdue",
  done: "todo.view.done",
  all: "todo.view.all",
};
const VIEW_EMPTY: Record<View, I18nKey> = {
  today: "todo.empty.today",
  upcoming: "todo.empty.upcoming",
  inbox: "todo.empty.inbox",
  overdue: "todo.empty.overdue",
  done: "todo.empty.done",
  all: "todo.empty.all",
};
const SORT_LABEL: Record<SortKey, I18nKey> = {
  due: "todo.sort.due",
  priority: "todo.sort.priority",
  title: "todo.sort.title",
  created: "todo.sort.created",
};

type Data = {
  todos: TodoRecord[];
  lists: TodoList[];
  courses: string[];
  notion: AssignmentRow[];
  copied: Map<string, number>;
  notionSetUp: boolean;
  showNotion: boolean;
  /** "Notion writes" is on: Notion rows can be ticked, todos sent. */
  notionWrite: boolean;
  /** Failed Done/title/date writes by Notion page id (shown on the row). */
  notionFailed: Map<string, OutboxError>;
  timeZone?: string;
};

async function load(): Promise<Data> {
  const s = await getSettings(["notion_assignments_db_id", "todos_show_notion", "user_timezone", "notion_write_enabled"]);
  const notionSetUp = !!s.notion_assignments_db_id;
  const [todos, lists, courses, notion, copied, notionFailed] = await Promise.all([
    listTodos(),
    getLists(),
    courseNames(),
    notionSetUp ? getOpenAssignments(undefined, 300) : Promise.resolve([]),
    copiedNotionIds(),
    notionSetUp ? failedWrites() : Promise.resolve(new Map<string, OutboxError>()),
  ]);
  return {
    todos,
    lists,
    courses,
    notion,
    copied,
    notionSetUp,
    showNotion: s.todos_show_notion !== "false",
    notionWrite: notionSetUp && s.notion_write_enabled === "true",
    notionFailed,
    timeZone: s.user_timezone?.trim() || undefined,
  };
}

const todoKey = (id: number) => `t:${id}`;
const idOf = (key: string) => Number(key.slice(2));

function toItem(r: TodoRecord): ListItem {
  return {
    key: todoKey(r.id),
    kind: "todo",
    title: r.title,
    notes: r.notes,
    course: r.course_name,
    due_date: r.due_date,
    due_time: r.due_time,
    done: r.status === "done",
    priority: r.priority,
    created_at: r.created_at,
    sort_order: r.sort_order,
  };
}

function notionItem(a: AssignmentRow): ListItem {
  return {
    key: `n:${a.notion_id}`,
    kind: "notion",
    title: a.name,
    notes: null,
    course: a.course,
    due_date: a.due_date.slice(0, 10),
    due_time: a.due_date.length >= 16 ? a.due_date.slice(11, 16) : null,
    done: false,
    priority: 0,
    created_at: "",
    sort_order: 0,
  };
}

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName) || e.isContentEditable);
};

export default function PageTodos({
  appearance,
  prefill,
}: {
  appearance: Appearance;
  /** Text to put in quick-add (from the pet's capture "Edit"); `n` changes per request. */
  prefill?: { text: string; n: number } | null;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<View>("today");
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const [sort, setSort] = useState<SortKey>("due");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pom = usePomodoro();
  const { toasts, show, dismiss } = useToasts();
  const addRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const today = todayLocal();

  // ── Loading: now, and whenever todos change in any window ──
  const reloadTimer = useRef<number | undefined>(undefined);
  const reload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    // Bulk actions announce many changes; one reload covers them.
    reloadTimer.current = window.setTimeout(() => {
      load()
        .then((d) => {
          setData(d);
          setVersion((v) => v + 1);
        })
        .catch((err) => {
          console.error(err);
          show({ text: t("todo.toast.loadFailed"), tone: "error" });
        });
    }, 60);
  }, [show]);

  useEffect(() => {
    reload();
    const events = ["todos:changed", "notion:status", "notion:outbox", "settings:changed"].map((e) => listen(e, reload));
    window.addEventListener("focus", reload);
    return () => {
      clearTimeout(reloadTimer.current);
      window.removeEventListener("focus", reload);
      for (const u of events) u.then((off) => off()).catch(console.error);
    };
  }, [reload]);

  // A finished focus session changes a todo's session count.
  useEffect(reload, [pom.sessionsToday, reload]);

  // ── Derived lists ──
  const records = useMemo(() => new Map((data?.todos ?? []).map((r) => [todoKey(r.id), r])), [data]);
  const assignments = useMemo(() => new Map((data?.notion ?? []).map((a) => [`n:${a.notion_id}`, a])), [data]);
  const items = useMemo(() => {
    if (!data) return [];
    const mine = data.todos.map(toItem);
    // A Notion assignment already copied into todos shows once: as the copy.
    const theirs =
      data.notionSetUp && data.showNotion ? data.notion.filter((a) => !data.copied.has(a.notion_id)).map(notionItem) : [];
    return [...mine, ...theirs];
  }, [data]);
  const counts = useMemo(() => viewCounts(items, today), [items, today]);
  const head = useMemo(() => summary(items, today), [items, today]);
  const { visible, groups } = useMemo(() => buildList(items, { view, query: search, sort, today }), [items, view, search, sort, today]);

  // The open item may have gone (deleted elsewhere, Notion rows hidden).
  // Checked only when fresh data arrives, and not right after selecting a
  // row that is still on its way in (a duplicate, a Notion copy).
  const openRecord = selected ? records.get(selected) ?? null : null;
  const openAssignment = selected ? assignments.get(selected) ?? null : null;
  const selectedAt = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    selectedAt.current = Date.now();
  }, [selected]);
  useEffect(() => {
    const key = selectedRef.current;
    if (!key || Date.now() - selectedAt.current < 2000) return;
    if (!records.has(key) && !assignments.has(key)) setSelected(null);
  }, [records, assignments]);

  // ── Actions ──
  const fail = useCallback(
    (err: unknown) => {
      console.error(err);
      show({ text: t("todo.toast.failed"), tone: "error" });
    },
    [show],
  );

  const add = useCallback(
    async (q: Parsed) => {
      try {
        const r = await createFromQuickAdd(q);
        const item: ListItem = {
          key: todoKey(r.id),
          kind: "todo",
          title: q.title,
          notes: null,
          course: r.course,
          due_date: q.due_date ?? null,
          due_time: q.due_time ?? null,
          done: false,
          priority: q.priority,
          created_at: "",
          sort_order: 0,
        };
        if (!r.listMatched) {
          show({ text: t("todo.toast.noList", { list: q.list ?? "", fallback: r.list.name }), tone: "info" });
        } else if (!inView(item, view, today)) {
          const where = VIEWS.find((v) => v !== "all" && inView(item, v, today)) ?? "all";
          show({ text: t("todo.toast.addedElsewhere", { title: q.title, view: t(VIEW_LABEL[where]) }), tone: "info" });
        }
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [fail, show, view, today],
  );

  const toggle = useCallback(
    async (key: string) => {
      // A Notion row: queue the Done checkbox (shown done at once).
      const a = assignments.get(key);
      if (a) {
        try {
          const r = await queueSetDone(a.notion_id, true);
          if (r === "off") return show({ text: t("api.writesOff"), tone: "info" });
          show({
            text: t("todo.toast.notionDone", { title: a.name }),
            tone: "info",
            undo: () => void queueSetDone(a.notion_id, false).catch(fail),
          });
        } catch (err) {
          fail(err);
        }
        return;
      }
      const r = records.get(key);
      if (!r) return;
      try {
        if (r.status === "done") {
          await reopenTodo(r.id);
          return;
        }
        const { spawnedId } = await completeTodo(r.id);
        show({
          text: t(spawnedId ? "todo.toast.doneRepeat" : "todo.toast.done", { title: r.title }),
          tone: "info",
          undo: () => void reopenTodo(r.id, spawnedId).catch(fail),
        });
      } catch (err) {
        fail(err);
      }
    },
    [records, assignments, show, fail],
  );

  const openItem = useCallback((key: string) => setSelected(key), []);
  const pick = useCallback((key: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const update = useCallback(
    async (id: number, patch: TodoPatch) => {
      try {
        await updateTodo(id, patch);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [fail],
  );

  const sendToNotion = async (r: TodoRecord) => {
    try {
      const q = await queueCreate({
        name: r.title,
        due_date: r.due_date,
        due_time: r.due_time,
        course: r.course_name,
        todo_id: r.id,
      });
      const text =
        q.result === "queued"
          ? q.courseMatched
            ? t("todo.toast.notionSent", { title: r.title })
            : t("todo.toast.notionSentNoCourse", { title: r.title, course: r.course_name ?? "" })
          : q.result === "linked"
            ? t("cmd.notion.linked")
            : q.result === "off"
              ? t("api.writesOff")
              : t("cmd.notion.notSetUp");
      show({ text, tone: q.result === "queued" ? "info" : "error" });
    } catch (err) {
      fail(err);
    }
  };

  const startFocus = (r: TodoRecord) => {
    emit("pomodoro:cmd", { type: "start", context: r.title, todoId: r.id }).catch(fail);
    show({ text: t("todo.toast.focus", { title: r.title }), tone: "info" });
  };

  const exitSelect = () => {
    setSelectMode(false);
    setPicked(new Set());
  };
  const pickedIds = () => [...picked].filter((k) => k.startsWith("t:")).map(idOf);
  const bulk = async (fn: (ids: number[]) => Promise<unknown>, text: I18nKey) => {
    const ids = pickedIds();
    if (!ids.length) return;
    try {
      await fn(ids);
      show({ text: t(text, { n: ids.length }), tone: "info" });
      exitSelect();
    } catch (err) {
      fail(err);
    }
  };

  const setShowNotion = async (on: boolean) => {
    setData((d) => d && { ...d, showNotion: on });
    await setSetting("todos_show_notion", String(on)).catch(fail);
  };

  // ── Keyboard: N new, / search, arrows move, Esc closes ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target)) return; // never steal keys from a field
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        addRef.current?.focus();
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && (selected || selectMode)) {
        // Handled here, so the dashboard's Esc does not close the window.
        e.stopImmediatePropagation();
        e.preventDefault();
        if (selected) {
          const key = selected;
          setSelected(null);
          requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)?.focus());
        } else exitSelect();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
        if (!rows.length) return;
        e.preventDefault();
        const i = rows.indexOf(document.activeElement as HTMLElement);
        const next = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        rows[next].focus();
      }
    };
    // Capture, so this runs before the dashboard's own Escape handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Space on a focused row completes it (Enter opens, as a button click).
  const onListKey = (e: React.KeyboardEvent) => {
    const key = (e.target as HTMLElement).dataset.row;
    if (!key || e.key !== " ") return;
    e.preventDefault();
    if (selectMode) pick(key);
    else void toggle(key);
  };

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = VIEWS.indexOf(view);
    const next = VIEWS[(i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length];
    setView(next);
    document.getElementById(`todo-tab-${next}`)?.focus();
  };

  const visibleTodoKeys = visible.filter((i) => i.kind === "todo").map((i) => i.key);

  return (
    <>
      <PageHeader appearance={appearance}>
        <h1 className="page-title">{t("nav.todos")}</h1>
        <p className="page-sub">
          {data
            ? t("todo.summary", { today: head.dueToday, overdue: head.overdue, open: head.open })
            : t("common.loading")}
        </p>
      </PageHeader>

      <main className={`dash-main todos${selected ? " todos--panel" : ""}`}>
        <div className="todos__main">
          <QuickAdd ref={addRef} lists={data?.lists ?? []} courses={data?.courses ?? []} today={today} onAdd={add} prefill={prefill} />

          <section className="card todos__card" aria-labelledby="todo-view-title">
            <div className="todos__toolbar">
              <h2 id="todo-view-title" className="card__title todos__title">
                {t(VIEW_LABEL[view])}
              </h2>
              <div className="search">
                <i className="ti ti-search" aria-hidden="true" />
                <label htmlFor="todo-search" className="sr-only">
                  {t("todo.search")}
                </label>
                <input
                  ref={searchRef}
                  id="todo-search"
                  type="search"
                  className="search__input"
                  placeholder={t("todo.search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      if (query) setQuery("");
                      else e.currentTarget.blur();
                    }
                  }}
                />
                <kbd className="search__kbd" aria-hidden="true">
                  /
                </kbd>
              </div>
              <label className="sort">
                <span className="sr-only">{t("todo.sort.label")}</span>
                <select className="sort__select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  {SORTS.map((s) => (
                    <option key={s} value={s}>
                      {t("todo.sort.prefix", { by: t(SORT_LABEL[s]) })}
                    </option>
                  ))}
                </select>
              </label>
              <ChunkyButton
                size="sm"
                variant="secondary"
                className={selectMode ? "select-btn--on" : undefined}
                aria-pressed={selectMode}
                onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              >
                {t(selectMode ? "todo.cancel" : "todo.select")}
              </ChunkyButton>
            </div>

            <div className="todos__views">
              <div className="filters" role="tablist" aria-label={t("todo.views")} onKeyDown={onTabKey}>
                {VIEWS.map((v) => (
                  <button
                    key={v}
                    id={`todo-tab-${v}`}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    aria-controls="todo-list-panel"
                    tabIndex={view === v ? 0 : -1}
                    className={`pill view-tab${view === v ? " pill--selected" : ""}${v === "overdue" && counts.overdue > 0 ? " view-tab--alert" : ""}`}
                    onClick={() => setView(v)}
                  >
                    {t(VIEW_LABEL[v])}
                    <span className="view-tab__count">{counts[v]}</span>
                  </button>
                ))}
              </div>
              {data?.notionSetUp && (
                <span className="notion-switch">
                  <Toggle label={t("todo.notion.show")} on={data.showNotion} onChange={(on) => void setShowNotion(on)} />
                  <span aria-hidden="true">{t("todo.notion.show")}</span>
                </span>
              )}
            </div>

            {selectMode && data && (
              <BulkBar
                count={pickedIds().length}
                viewCount={visibleTodoKeys.length}
                lists={data.lists}
                today={today}
                onSelectAll={() => setPicked(new Set(visibleTodoKeys))}
                onComplete={() => void bulk((ids) => bulkComplete(ids), "todo.toast.bulkDone")}
                onSetDate={(d) => void bulk((ids) => bulkSetDue(ids, d), "todo.toast.bulkDate")}
                onPriority={(p: Priority) => void bulk((ids) => bulkSetPriority(ids, p), "todo.toast.bulkPriority")}
                onMove={(listId) => void bulk((ids) => bulkMoveToList(ids, listId), "todo.toast.bulkMove")}
                onDelete={() => void bulk(bulkDelete, "todo.toast.bulkDelete")}
                onCancel={exitSelect}
              />
            )}

            <div
              id="todo-list-panel"
              role="tabpanel"
              aria-labelledby={`todo-tab-${view}`}
              className="todos__list"
              ref={listRef}
              onKeyDown={onListKey}
            >
              {!data ? (
                <div className="skeleton-list" aria-busy="true" aria-label={t("common.loading")}>
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className="skeleton" />
                  ))}
                </div>
              ) : groups.length === 0 ? (
                <div className="empty-state empty-state--inline">
                  <MoonStars />
                  <p>{search.trim() ? t("todo.empty.search", { q: search.trim() }) : t(VIEW_EMPTY[view])}</p>
                </div>
              ) : (
                groups.map((g) => (
                  <section key={g.key} className="tgroup" aria-labelledby={`tgroup-${g.key}`}>
                    <h3 id={`tgroup-${g.key}`} className={`tgroup__title tgroup__title--${g.kind}`}>
                      {groupTitle(g, today)} <span className="tgroup__count">{g.items.length}</span>
                    </h3>
                    <ul className="tgroup__rows">
                      {g.items.map((item) => (
                        <TodoRow
                          key={item.key}
                          item={item}
                          record={records.get(item.key) ?? null}
                          today={today}
                          open={selected === item.key}
                          selectMode={selectMode}
                          picked={picked.has(item.key)}
                          onToggle={toggle}
                          onOpen={openItem}
                          onPick={pick}
                          notionWritable={data.notionWrite}
                          notionFailed={item.kind === "notion" && data.notionFailed.has(item.key.slice(2))}
                        />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
            <p className="todos__keys muted">{t("todo.keys")}</p>
          </section>

          <Reminders />
        </div>

        {openRecord && data && (
          <TodoDetails
            todo={openRecord}
            lists={data.lists}
            courses={data.courses}
            version={version}
            focusBusy={pom.phase !== "idle"}
            timeZone={data.timeZone}
            onClose={() => setSelected(null)}
            onUpdate={update}
            onStartFocus={() => startFocus(openRecord)}
            canSendToNotion={data.notionWrite && !openRecord.source_notion_id}
            onSendToNotion={() => void sendToNotion(openRecord)}
            onDuplicate={() =>
              void duplicateTodo(openRecord.id)
                .then((id) => {
                  if (id) setSelected(todoKey(id));
                  show({ text: t("todo.toast.duplicated", { title: openRecord.title }), tone: "info" });
                })
                .catch(fail)
            }
            onDelete={() =>
              void deleteTodo(openRecord.id)
                .then(() => {
                  setSelected(null);
                  show({ text: t("todo.toast.deleted", { title: openRecord.title }), tone: "info" });
                })
                .catch(fail)
            }
          />
        )}
        {openAssignment && data && (
          <NotionDetails
            assignment={openAssignment}
            copiedId={data.copied.get(openAssignment.notion_id) ?? null}
            today={today}
            writable={data.notionWrite}
            failure={data.notionFailed.get(openAssignment.notion_id) ?? null}
            onChange={(change) =>
              // Optimistic (the local row changes now) and queued; a failure
              // shows on the row and in Integrations, never reverted silently.
              void queueUpdate(openAssignment.notion_id, change)
                .then((r) => {
                  if (r === "off") return show({ text: t("api.writesOff"), tone: "info" });
                  if (r === "queued") {
                    show({ text: t("todo.toast.notionUpdated", { title: change.name ?? openAssignment.name }), tone: "info" });
                  }
                })
                .catch(fail)
            }
            onClose={() => setSelected(null)}
            onOpenCopy={(id) => setSelected(todoKey(id))}
            onCopy={() =>
              void copyFromNotion(openAssignment)
                .then(({ id, created }) => {
                  setSelected(todoKey(id));
                  show({ text: t(created ? "todo.toast.copied" : "todo.toast.copyExists", { title: openAssignment.name }), tone: "info" });
                })
                .catch(fail)
            }
          />
        )}
      </main>

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
