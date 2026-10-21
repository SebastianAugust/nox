import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSettings } from "./lib/db";
import {
  addHabit,
  addTodo,
  getSetting,
  deleteHabit,
  deleteReminder,
  deleteTodo,
  getHabitLogsSince,
  getHabitStreaks,
  getRecentRecaps,
  getReminders,
  getTodosFiltered,
  getTodayHabitLogs,
  getTodayPomodoroSessions,
  getTodayStats,
  getUpcoming,
  logHabit,
  setSetting,
  setTodoStatus,
  todayLocal,
  type ReminderRow,
  type TodayStats,
  type TodoFilter,
} from "./lib/db-helpers";
import Pomodoro from "./components/Pomodoro";
import { locale, t, useLanguage, type I18nKey } from "./lib/i18n";

type Page =
  | "home"
  | "habits"
  | "pomodoro"
  | "todos"
  | "recap"
  | "integrations"
  | "settings";

// Single source of truth for the sidebar: its order is also what the 1-7
// number-key shortcuts select, so the two can never drift apart.
const NAV_ITEMS = [
  { id: "home", icon: "ti-home", label: "nav.home" },
  { id: "habits", icon: "ti-checklist", label: "nav.habits" },
  { id: "pomodoro", icon: "ti-clock", label: "nav.pomodoro" },
  { id: "todos", icon: "ti-list-check", label: "nav.todos" },
  { id: "recap", icon: "ti-history", label: "nav.recap" },
  { id: "integrations", icon: "ti-plug", label: "nav.integrations" },
  { id: "settings", icon: "ti-settings", label: "nav.settings" },
] as const satisfies readonly { id: Page; icon: string; label: I18nKey }[];

// Shared style fragments
const sectionLabel = {
  fontSize: 12,
  color: "rgba(255,255,255,0.25)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  marginBottom: 8,
};
const card = {
  background: "rgba(255,255,255,0.03)",
  border: "0.5px solid rgba(255,255,255,0.07)",
  borderRadius: 10,
  padding: "12px 16px",
};
const statCard = {
  background: "rgba(255,255,255,0.03)",
  border: "0.5px solid rgba(255,255,255,0.07)",
  borderRadius: 8,
  padding: 14,
};
const rowBorder = (last: boolean) => ({
  borderBottom: last ? "none" : "0.5px solid rgba(255,255,255,0.04)",
});
const emptyText = {
  fontSize: 12,
  color: "rgba(255,255,255,0.25)",
  padding: "6px 0",
};

export function Dashboard() {
  const [page, setPage] = useState<Page>("home");
  const [userName, setUserName] = useState("");
  useLanguage(); // re-render every string when the language setting changes

  const handleClose = () => {
    invoke("close_dashboard").catch(console.error);
  };

  useEffect(() => {
    getSetting("user_name")
      .then((n) => setUserName(n ?? "Bas"))
      .catch(console.error);
  }, []);

  // Escape closes the window; 1-7 jump to a page. Both are ignored while a
  // field has focus, so typing a habit called "2 km run" still works and
  // Escape cancels the edit instead of closing the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        invoke("close_dashboard").catch(console.error);
        return;
      }
      const index = Number(e.key);
      if (Number.isInteger(index) && index >= 1 && index <= NAV_ITEMS.length) {
        setPage(NAV_ITEMS[index - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: "#0d0f14",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
    >
      <TitleBar onClose={handleClose} userName={userName} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Sidebar page={page} onNavigate={setPage} />
        <Main page={page} />
      </div>
    </div>
  );
}

/** Round icon button used in the titlebar (minimize / close). */
function TitleBarButton({
  onClick,
  title,
  base,
  hover,
  color,
  children,
}: {
  onClick: () => void;
  title: string;
  base: string;
  hover: string;
  color: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        lineHeight: 1,
        cursor: "pointer",
        background: hovered ? hover : base,
        color,
      }}
    >
      {children}
    </button>
  );
}

function TitleBar({
  onClose,
  userName,
}: {
  onClose: () => void;
  userName: string;
}) {
  // `data-tauri-drag-region` makes this area drag the window (uses the same
  // start-dragging permission as the pet). Buttons have no such attribute, so
  // they stay clickable.
  return (
    <div
      data-tauri-drag-region=""
      style={{
        height: 38,
        background: "#080a0d",
        borderBottom: "0.5px solid rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 14px",
        flexShrink: 0,
      }}
    >
      <span
        data-tauri-drag-region=""
        style={{ fontSize: 13, color: "rgba(255,255,255,0.3)" }}
      >
        {userName ? `Nox · ${userName}` : "Nox"}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <TitleBarButton
          onClick={() => getCurrentWindow().minimize().catch(console.error)}
          title={t("dash.minimize")}
          base="rgba(255,255,255,0.08)"
          hover="rgba(255,255,255,0.16)"
          color="rgba(255,255,255,0.5)"
        >
          –
        </TitleBarButton>
        <TitleBarButton
          onClick={onClose}
          title={t("dash.close")}
          base="rgba(239,68,68,0.15)"
          hover="rgba(239,68,68,0.3)"
          color="rgba(239,68,68,0.85)"
        >
          ×
        </TitleBarButton>
      </div>
    </div>
  );
}

function Sidebar({
  page,
  onNavigate,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
}) {
  const [tooltip, setTooltip] = useState<{ label: string; top: number } | null>(null);

  return (
    <div
      style={{
        width: 60,
        background: "#080a0d",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 0",
        gap: 4,
        borderRight: "0.5px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* Logo */}
      <div
        style={{
          width: 30,
          height: 30,
          background: "#00e5a0",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
          color: "#080a0d",
          fontWeight: 700,
          fontSize: 16,
        }}
      >
        N
      </div>

      {NAV_ITEMS.map((item, i) => {
        const active = page === item.id;
        return (
          <div key={item.id} style={{ position: "relative" }}>
            {/* Accent bar marks the active page without squaring off the button. */}
            <div
              style={{
                position: "absolute",
                left: -9,
                top: "50%",
                transform: "translateY(-50%)",
                width: 2,
                height: 20,
                borderRadius: 1,
                background: active ? "#00e5a0" : "transparent",
              }}
            />
            <button
              onClick={() => onNavigate(item.id)}
              title={`${t(item.label)} (${i + 1})`}
              onMouseEnter={(e) =>
                setTooltip({
                  label: `${t(item.label)} · ${i + 1}`,
                  top: e.currentTarget.getBoundingClientRect().top + 21,
                })
              }
              onMouseLeave={() => setTooltip(null)}
              style={{
                width: 42,
                height: 42,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: active ? "rgba(255,255,255,0.07)" : "transparent",
                border: "none",
                color: active ? "#00e5a0" : "rgba(255,255,255,0.3)",
                fontSize: 18,
                cursor: "pointer",
              }}
            >
              <i className={`ti ${item.icon}`} aria-hidden="true" />
            </button>
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: 66,
            top: tooltip.top,
            transform: "translateY(-50%)",
            background: "rgba(0,0,0,0.85)",
            border: "0.5px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.85)",
            padding: "3px 8px",
            borderRadius: 6,
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

function Main({ page }: { page: Page }) {
  const title = t(`nav.${page}`);
  const sub =
    page === "home"
      ? new Date().toLocaleDateString(locale(), {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
      : t(`sub.${page}`);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "20px 24px 14px",
          borderBottom: "0.5px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,0.85)" }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
            {sub}
          </div>
        </div>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#00e5a0" }} />
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {page === "home" && <PageHome />}
        {page === "habits" && <PageHabits />}
        {page === "pomodoro" && <PagePomodoro />}
        {page === "todos" && <PageTodos />}
        {page === "recap" && <PageRecap />}
        {page === "integrations" && <PageIntegrations />}
        {page === "settings" && <PageSettings />}
      </div>
    </div>
  );
}

/** "today" / "tomorrow" / a short date, for due dates that are plain YYYY-MM-DD. */
function formatDue(due: string): { text: string; color: string } {
  const date = due.slice(0, 10);
  const today = todayLocal();
  if (date < today) return { text: t("date.overdue"), color: "#f87171" };
  if (date === today) return { text: t("date.today"), color: "#f59e0b" };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  const tomorrowStr = `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(
    tomorrow.getDate(),
  )}`;
  if (date === tomorrowStr) return { text: t("date.tomorrow"), color: "#00e5a0" };

  const [y, m, d] = date.split("-").map(Number);
  return {
    text: new Date(y, m - 1, d).toLocaleDateString(locale(), {
      day: "numeric",
      month: "short",
    }),
    color: "rgba(255,255,255,0.15)",
  };
}

function PageHome() {
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [upcoming, setUpcoming] = useState<
    { title: string; due_date: string; source: string }[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, u] = await Promise.all([getTodayStats(), getUpcoming(5)]);
      if (cancelled) return;
      setStats(s);
      setUpcoming(u);
    })().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  const tiles = [
    { val: String(stats?.tasks ?? 0), label: t("home.tasksToday") },
    { val: String(stats?.pomodoros ?? 0), label: t("home.pomodoros") },
    {
      val: `${stats?.habitsDone ?? 0}/${stats?.habitsTotal ?? 0}`,
      label: t("home.habitsDone"),
      accent: true,
    },
    {
      val: String(stats?.deadlines ?? 0),
      label: t(stats?.deadlines === 1 ? "home.deadlineToday" : "home.deadlinesToday"),
    },
  ];

  return (
    <>
      {/* Pet preview */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "0.5px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          padding: "16px 18px",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {/* Pet blob */}
        <div
          style={{
            width: 52,
            height: 52,
            background: "#1a1030",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="34" height="34" viewBox="0 0 32 32">
            <ellipse cx="16" cy="20" rx="9" ry="8" fill="#1a1030" />
            <ellipse cx="16" cy="16" rx="7" ry="7" fill="#2a1a4a" />
            <circle cx="12.5" cy="15" r="2.5" fill="#00e5a0" />
            <circle cx="19.5" cy="15" r="2.5" fill="#00e5a0" />
            <circle cx="13" cy="15" r="1.2" fill="#080a0d" />
            <circle cx="20" cy="15" r="1.2" fill="#080a0d" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "rgba(255,255,255,0.8)",
              marginBottom: 2,
            }}
          >
            {t("home.petState")}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            {t("home.paused")}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>{t("home.pausedTag")}</div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {tiles.map((s, i) => (
          <div key={i} style={statCard}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: s.accent ? "#00e5a0" : "rgba(255,255,255,0.85)",
                marginBottom: 3,
              }}
            >
              {s.val}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Upcoming */}
      <div>
        <div style={sectionLabel}>{t("home.upcoming")}</div>
        <div style={card}>
          {upcoming.length === 0 && (
            <div style={emptyText}>{t("home.nothing")}</div>
          )}
          {upcoming.map((item, i, arr) => {
            const due = formatDue(item.due_date);
            return (
              <div
                key={`${item.source}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  ...rowBorder(i === arr.length - 1),
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: due.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", flex: 1 }}>
                  {item.title}
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                  {due.text}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

type HabitRow = { id: number; name: string; completed: number };

function PageHabits() {
  const [habits, setHabits] = useState<HabitRow[]>([]);
  const [streaks, setStreaks] = useState({ current: 0, best: 0 });
  const [newHabit, setNewHabit] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [rows, s] = await Promise.all([getTodayHabitLogs(), getHabitStreaks()]);
    setHabits(rows as HabitRow[]);
    setStreaks(s);
  }, []);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const handleToggle = async (habit: HabitRow) => {
    // Optimistic: the checkbox should never lag behind the click.
    setHabits((prev) =>
      prev.map((h) => (h.id === habit.id ? { ...h, completed: h.completed ? 0 : 1 } : h)),
    );
    try {
      await logHabit(habit.id, !habit.completed);
      await load();
    } catch (err) {
      console.error(err);
      await load(); // put the real state back
    }
  };

  const handleAdd = async () => {
    const name = newHabit.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    await addHabit(name);
    setNewHabit("");
    setAdding(false);
    await load();
  };

  const handleDelete = async (habit: HabitRow) => {
    await deleteHabit(habit.id);
    await load();
  };

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("habits.today")}</div>
        <div style={card}>
          {habits.length === 0 && !adding && (
            <div style={emptyText}>{t("habits.empty")}</div>
          )}
          {habits.map((h, i) => (
            <HabitItem
              key={h.id}
              habit={h}
              last={i === habits.length - 1 && !adding}
              onToggle={() => handleToggle(h)}
              onDelete={() => handleDelete(h)}
            />
          ))}

          {adding && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  flexShrink: 0,
                  border: "0.5px solid rgba(255,255,255,0.15)",
                }}
              />
              <input
                autoFocus
                value={newHabit}
                onChange={(e) => setNewHabit(e.target.value)}
                onBlur={() => void handleAdd().catch(console.error)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleAdd().catch(console.error);
                  if (e.key === "Escape") {
                    setNewHabit("");
                    setAdding(false);
                  }
                }}
                placeholder={t("habits.new")}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "rgba(255,255,255,0.8)",
                  fontSize: 13,
                  fontFamily: "inherit",
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={statCard}>
          <div style={{ fontSize: 22, fontWeight: 500, color: "#00e5a0", marginBottom: 3 }}>
            {streaks.current}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{t("habits.streak")}</div>
        </div>
        <div style={statCard}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: "rgba(255,255,255,0.85)",
              marginBottom: 3,
            }}
          >
            {streaks.best}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{t("habits.best")}</div>
        </div>
      </div>

      <HabitWeeklyView habits={habits} />

      <button
        onClick={() => setAdding(true)}
        style={{
          width: "100%",
          fontSize: 13,
          padding: 10,
          borderRadius: 8,
          background: "rgba(255,255,255,0.04)",
          border: "0.5px solid rgba(255,255,255,0.08)",
          color: "rgba(255,255,255,0.4)",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        {t("habits.add")}
      </button>
    </>
  );
}

/** One habit row. Delete appears on hover, and right-click also removes it. */
function HabitItem({
  habit,
  last,
  onToggle,
  onDelete,
}: {
  habit: HabitRow;
  last: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const done = habit.completed === 1;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setConfirming(false);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setConfirming(true);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 0",
        ...rowBorder(last),
      }}
    >
      <div
        onClick={onToggle}
        title={t("habits.toggle")}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          flexShrink: 0,
          cursor: "pointer",
          background: done ? "#00e5a0" : "transparent",
          border: done ? "none" : "0.5px solid rgba(255,255,255,0.15)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {done && (
          <i
            className="ti ti-check"
            style={{ fontSize: 11, color: "#080a0d" }}
            aria-hidden="true"
          />
        )}
      </div>
      <span
        onClick={onToggle}
        style={{
          fontSize: 13,
          flex: 1,
          cursor: "pointer",
          color: done ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)",
        }}
      >
        {habit.name}
      </span>

      {confirming ? (
        <button
          onClick={onDelete}
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 6,
            background: "rgba(239,68,68,0.15)",
            border: "0.5px solid rgba(239,68,68,0.3)",
            color: "#f87171",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {t("habits.confirmDelete")}
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          title={t("habits.delete")}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.3)",
            fontSize: 12,
            cursor: "pointer",
            padding: "0 2px",
            visibility: hovered ? "visible" : "hidden",
          }}
        >
          <i className="ti ti-trash" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function PagePomodoro() {
  const [sessions, setSessions] = useState<
    Awaited<ReturnType<typeof getTodayPomodoroSessions>>
  >([]);

  const load = useCallback(() => {
    getTodayPomodoroSessions().then(setSessions).catch(console.error);
  }, []);

  useEffect(load, [load]);

  const formatClock = (stamp: string) =>
    new Date(stamp.replace(" ", "T") + "Z").toLocaleTimeString(locale(), {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <>
      <div style={{ ...card, padding: "26px 16px" }}>
        <Pomodoro onSnapshot={load} />
      </div>

      <div>
        <div style={sectionLabel}>{t("pom.todaySessions")}</div>
        <div style={card}>
          {sessions.length === 0 && (
            <div style={emptyText}>{t("pom.none")}</div>
          )}
          {sessions.map((s, i, arr) => (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 0",
                ...rowBorder(i === arr.length - 1),
              }}
            >
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: s.completed ? "#00e5a0" : "rgba(255,255,255,0.15)",
                }}
              />
              <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", flex: 1 }}>
                {t(s.completed ? "pom.completed" : "pom.stopped", { min: s.duration_minutes })}
              </span>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                {formatClock(s.started_at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

type TodoRow = Awaited<ReturnType<typeof getTodosFiltered>>[number];

const FILTERS: { id: TodoFilter; label: I18nKey }[] = [
  { id: "pending", label: "todos.active" },
  { id: "done", label: "todos.done" },
  { id: "all", label: "todos.all" },
];

function PageTodos() {
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
        {todos.map((todo, i) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            last={i === todos.length - 1}
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

/** Reminders set with /remind: what is coming, and what came due today. */
function Reminders() {
  const [reminders, setReminders] = useState<ReminderRow[]>([]);

  const load = useCallback(async () => {
    setReminders(await getReminders());
  }, []);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const handleDelete = async (id: number) => {
    await deleteReminder(id);
    await load();
  };

  return (
    <div>
      <div style={sectionLabel}>{t("reminders.title")}</div>
      <div style={{ ...card, padding: "6px 14px" }}>
        {reminders.length === 0 && (
          <div style={{ ...emptyText, textAlign: "center", padding: "18px 0" }}>
            {t("reminders.empty")}
          </div>
        )}
        {reminders.map((r, i) => {
          const sent = r.status !== "pending";
          // remind_at is a UTC "YYYY-MM-DD HH:MM:SS" stamp.
          const when = new Date(r.remind_at.replace(" ", "T") + "Z").toLocaleString(locale(), {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <div
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 0",
                ...rowBorder(i === reminders.length - 1),
              }}
            >
              <i
                className={`ti ${sent ? "ti-bell-check" : "ti-bell"}`}
                aria-hidden="true"
                style={{ fontSize: 13, color: sent ? "rgba(255,255,255,0.3)" : "#00e5a0" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: sent ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.75)",
                    wordBreak: "break-word",
                  }}
                >
                  {r.title}
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                  {when}
                  {sent ? ` · ${t("reminders.sent")}` : ""}
                </div>
              </div>
              <button
                onClick={() => void handleDelete(r.id).catch(console.error)}
                title={t("reminders.delete")}
                aria-label={t("reminders.delete")}
                style={{
                  background: "none",
                  border: "none",
                  color: "rgba(248,113,113,0.6)",
                  fontSize: 12,
                  cursor: "pointer",
                  flexShrink: 0,
                  padding: "0 2px",
                }}
              >
                <i className="ti ti-trash" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One todo row; delete only appears on hover so the list stays quiet. */
function TodoItem({
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

/** Day recaps, newest first. */
function PageRecap() {
  const [recaps, setRecaps] = useState<Awaited<ReturnType<typeof getRecentRecaps>>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getRecentRecaps(14)
      .then((r) => {
        setRecaps(r);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  if (!loaded) return <div style={emptyText}>{t("common.loading")}</div>;

  if (recaps.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "40px 0",
          color: "rgba(255,255,255,0.2)",
          fontSize: 13,
        }}
      >
        {t("recap.empty")}
      </div>
    );
  }

  const tile = (value: string, label: string, color: string) => (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "6px 9px" }}>
      <div style={{ fontSize: 14, fontWeight: 500, color }}>{value}</div>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{label}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {recaps.map((r) => {
        const [y, m, d] = r.date.split("-").map(Number);
        return (
          <div key={r.date} style={{ ...card, padding: "12px 14px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.75)" }}>
                {new Date(y, m - 1, d).toLocaleDateString(locale(), {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                })}
              </div>
              {r.mood && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 20,
                    background: "rgba(0,229,160,0.1)",
                    color: "#00e5a0",
                  }}
                >
                  {r.mood}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {tile(
                `${r.todos_completed}/${r.todos_total}`,
                t("recap.tasks"),
                r.todos_completed > 0 ? "#00e5a0" : "rgba(255,255,255,0.5)",
              )}
              {tile(
                String(r.pomodoro_sessions),
                t("recap.pomodoros"),
                r.pomodoro_sessions > 0 ? "#60a5fa" : "rgba(255,255,255,0.5)",
              )}
              {tile(
                `${r.habits_completed}/${r.habits_total}`,
                t("recap.habits"),
                r.habits_completed > 0 ? "#a78bfa" : "rgba(255,255,255,0.5)",
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 7-day completion grid, oldest day on the left. */
function HabitWeeklyView({ habits }: { habits: HabitRow[] }) {
  const [logs, setLogs] = useState<Record<string, Record<number, boolean>>>({});

  useEffect(() => {
    getHabitLogsSince(7).then(setLogs).catch(console.error);
  }, [habits]);

  const today = todayLocal();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const p = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      label: d.toLocaleDateString(locale(), { weekday: "short" }).slice(0, 2),
    };
  });

  if (habits.length === 0) return null;

  return (
    <div>
      <div style={sectionLabel}>{t("habits.week")}</div>
      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th style={{ width: "40%", padding: "0 0 6px" }} />
              {days.map((d) => (
                <th
                  key={d.date}
                  style={{
                    fontSize: 9,
                    color:
                      d.date === today ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.3)",
                    fontWeight: 400,
                    textAlign: "center",
                    padding: "0 0 6px",
                  }}
                >
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {habits.map((habit) => (
              <tr key={habit.id}>
                <td
                  title={habit.name}
                  style={{
                    fontSize: 11,
                    color: "rgba(255,255,255,0.5)",
                    padding: "3px 6px 3px 0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 0,
                  }}
                >
                  {habit.name}
                </td>
                {days.map((d) => {
                  const done = logs[d.date]?.[habit.id];
                  const isToday = d.date === today;
                  return (
                    <td key={d.date} style={{ textAlign: "center", padding: "3px 4px" }}>
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          margin: "0 auto",
                          background: done
                            ? "#00e5a0"
                            : isToday
                              ? "rgba(255,255,255,0.08)"
                              : "rgba(255,255,255,0.03)",
                          border: done ? "none" : "0.5px solid rgba(255,255,255,0.08)",
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Service = {
  name: string;
  initial: string;
  color: string;
  tokenKey?: string; // settings key; connected when its value is non-empty
  noToken?: boolean; // Weather: no token needed, just enable
};

const INTEGRATIONS: Service[] = [
  { name: "Notion", initial: "N", color: "#fff", tokenKey: "notion_token" },
  { name: "Google Calendar", initial: "G", color: "#4285f4", tokenKey: "gcal_token" },
  { name: "Spotify", initial: "S", color: "#1db954", tokenKey: "spotify_token" },
  { name: "Weather (Open-Meteo)", initial: "W", color: "#38bdf8", noToken: true },
];

function PageIntegrations() {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    getSettings(["notion_token", "gcal_token", "spotify_token"])
      .then(setTokens)
      .catch(console.error);
  }, []);

  const isConnected = (s: Service) =>
    !!s.tokenKey && !!tokens[s.tokenKey]?.trim();

  const showPlaceholder = () =>
    setNote(t("int.comingSoon"));

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("int.services")}</div>
        <div style={card}>
          {INTEGRATIONS.map((s, i) => {
            const connected = isConnected(s);
            return (
              <div
                key={s.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  ...rowBorder(i === INTEGRATIONS.length - 1),
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: connected
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(255,255,255,0.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    color: connected ? s.color : "rgba(255,255,255,0.3)",
                    flexShrink: 0,
                  }}
                >
                  {s.initial}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: connected ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {s.name}
                  </div>
                  {s.noToken && (
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>
                      {t("int.noToken")}
                    </div>
                  )}
                </div>

                {connected ? (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "3px 9px",
                      borderRadius: 10,
                      background: "rgba(0,229,160,0.15)",
                      color: "#00e5a0",
                    }}
                  >
                    {t("int.on")}
                  </span>
                ) : (
                  <button
                    onClick={showPlaceholder}
                    style={{
                      fontSize: 11,
                      padding: "3px 10px",
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.06)",
                      border: "0.5px solid rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.4)",
                      cursor: "pointer",
                    }}
                  >
                    {t(s.noToken ? "int.enable" : "int.setup")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {note && (
        <div
          style={{
            background: "rgba(0,229,160,0.06)",
            border: "0.5px solid rgba(0,229,160,0.2)",
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 12,
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {note}
        </div>
      )}
    </>
  );
}

const TEXT_SETTINGS = [
  { key: "user_name", label: "set.userName" },
  { key: "user_location", label: "set.location" },
  { key: "ollama_model", label: "set.model" },
  { key: "user_timezone", label: "set.timezone" },
] as const;

// Daily briefing (toggle + time) is hidden until it is wired in Phase 2, which
// seeds its settings in a new migration.
const FEATURE_SETTINGS = [
  { key: "body_checkin_enabled", label: "set.checkin" },
  { key: "dnd_during_pomodoro", label: "set.dnd" },
  { key: "friction_starter_enabled", label: "set.friction" },
  { key: "autostart", label: "set.autostart" },
] as const;

const TIME_SETTINGS = [
  { key: "recap_time", label: "set.recapTime", fallback: "22:00" },
] as const;

const CHOICE_SETTINGS = [
  {
    key: "pomodoro_duration",
    label: "set.pomDuration",
    fallback: "25",
    options: ["15", "20", "25", "30", "45", "60"],
  },
  {
    key: "pomodoro_break",
    label: "set.breakDuration",
    fallback: "5",
    options: ["5", "10", "15", "20"],
  },
  {
    key: "body_checkin_interval",
    label: "set.checkinEvery",
    fallback: "180",
    options: ["60", "120", "180", "240", "360"],
  },
] as const;

const ALL_SETTING_KEYS = [
  "language",
  ...TEXT_SETTINGS.map((s) => s.key),
  ...FEATURE_SETTINGS.map((s) => s.key),
  ...TIME_SETTINGS.map((s) => s.key),
  ...CHOICE_SETTINGS.map((s) => s.key),
];

function PageSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getSettings(ALL_SETTING_KEYS)
      .then((v) => {
        setValues(v);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Write through to SQLite, then mirror locally so the control stays in sync
  // even if the row did not exist yet.
  // Every write is announced, so the pet window (and the i18n cache in both
  // windows) pick it up without a restart.
  const save = async (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    try {
      await setSetting(key, value);
      await emit("settings:changed", { key });
    } catch (err) {
      console.error(err);
    }
  };

  if (!loaded) return <div style={emptyText}>{t("common.loading")}</div>;

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("set.general")}</div>
        <div style={card}>
          <SettingRow label={t("set.language")} last={false}>
            <select
              value={values.language ?? "en"}
              onChange={(e) => void save("language", e.target.value)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "0.5px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "rgba(255,255,255,0.7)",
                fontSize: 12,
                padding: "3px 6px",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </select>
          </SettingRow>

          {TEXT_SETTINGS.map((s, i) => (
            <SettingRow key={s.key} label={t(s.label)} last={i === TEXT_SETTINGS.length - 1}>
              <EditableValue
                value={values[s.key] ?? ""}
                onSave={(v) => void save(s.key, v)}
              />
            </SettingRow>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t("set.features")}</div>
        <div style={card}>
          {FEATURE_SETTINGS.map((s, i) => (
            <SettingRow
              key={s.key}
              label={t(s.label)}
              last={i === FEATURE_SETTINGS.length - 1}
            >
              <Toggle
                on={values[s.key] === "true"}
                onChange={(on) => void save(s.key, String(on))}
              />
            </SettingRow>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t("set.timing")}</div>
        <div style={card}>
          {TIME_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} last={false}>
              <input
                type="time"
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "0.5px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  padding: "3px 6px",
                  outline: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  colorScheme: "dark",
                }}
              />
            </SettingRow>
          ))}

          {CHOICE_SETTINGS.map((s, i) => (
            <SettingRow
              key={s.key}
              label={t(s.label)}
              last={i === CHOICE_SETTINGS.length - 1}
            >
              <select
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
                style={{
                  background: "#0d0f14",
                  border: "0.5px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  padding: "3px 6px",
                  outline: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {/* A value set elsewhere (or seeded) may not be in the list. */}
                {(s.options as readonly string[]).includes(values[s.key] || s.fallback)
                  ? null
                  : (
                      <option value={values[s.key]}>{t("set.minutes", { n: values[s.key] })}</option>
                    )}
                {s.options.map((v) => (
                  <option key={v} value={v}>
                    {t("set.minutes", { n: v })}
                  </option>
                ))}
              </select>
            </SettingRow>
          ))}
        </div>
      </div>

      <div style={{ ...emptyText, paddingTop: 0 }}>
        {t("set.shortcuts", { n: NAV_ITEMS.length })}
      </div>
    </>
  );
}

function SettingRow({
  label,
  last,
  children,
}: {
  label: string;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        minHeight: 34,
        ...rowBorder(last),
      }}
    >
      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{label}</span>
      {children}
    </div>
  );
}

/** Click the value to edit it; Enter or blur commits, Escape cancels. */
function EditableValue({
  value,
  numeric,
  onSave,
}: {
  value: string;
  numeric?: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    if (numeric && !/^\d+$/.test(next)) return;
    onSave(next);
  };

  if (!editing) {
    return (
      <span
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title={t("set.clickToEdit")}
        style={{
          fontSize: 13,
          color: "rgba(255,255,255,0.3)",
          cursor: "pointer",
          borderBottom: "0.5px dashed rgba(255,255,255,0.12)",
        }}
      >
        {value || "—"}
      </span>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      inputMode={numeric ? "numeric" : "text"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: 150,
        textAlign: "right",
        background: "rgba(255,255,255,0.06)",
        border: "0.5px solid rgba(255,255,255,0.12)",
        borderRadius: 6,
        outline: "none",
        color: "rgba(255,255,255,0.85)",
        fontSize: 13,
        padding: "3px 6px",
        fontFamily: "inherit",
      }}
    />
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        background: on ? "#00e5a0" : "rgba(255,255,255,0.1)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.2s",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 14,
          height: 14,
          background: "white",
          borderRadius: "50%",
          top: 2,
          transition: "0.2s",
          ...(on ? { right: 2 } : { left: 2 }),
        }}
      />
    </div>
  );
}
