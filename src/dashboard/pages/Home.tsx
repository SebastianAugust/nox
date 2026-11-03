import { useCallback, useEffect, useState } from "react";
import {
  getHabitLogsSince,
  getHabitStreaks,
  getOpenAssignments,
  getSetting,
  getTodayHabitLogs,
  getTodayStats,
  getTodosFiltered,
  getUpcoming,
  logHabit,
  setTodoStatus,
  todayLocal,
  type AssignmentRow,
  type TodayStats,
} from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { urgency } from "../../lib/deadlines";
import { urgencyText } from "../../lib/commands";
import { getWeather, weatherKind, type WeatherState } from "../../lib/weather";
import { listen } from "@tauri-apps/api/event";
import { PlaceSelect } from "../widgets/Places";
import type { Appearance } from "../../lib/theme";
import { pickSuggestion, type Suggestion } from "../../lib/homeMessage";
import { habitStreak, shiftDay, type HabitLogMap } from "../../lib/streaks";
import Pet from "../../components/Pet";
import { DAILY_FOCUS_GOAL, FocusRing, usePomodoro } from "../../components/Pomodoro";
import DialogBox from "../../components/ui/DialogBox";
import { Card, ChunkyButton, StatCard, Tag } from "../../components/ui/controls";
import { StreakEgg, Wings } from "../../components/deco/Deco";
import PageHeader from "../PageHeader";
import { fillRich } from "../format";
import TodoItem, { type TodoRow } from "../widgets/TodoItem";
import AddTodo from "../widgets/AddTodo";
import WeekFootprints from "../widgets/WeekFootprints";
import type { HabitRow } from "../widgets/HabitItem";

const SNOOZE_MS = 60 * 60 * 1000;
const STREAK_WINDOW_DAYS = 365; // per-habit "best" looks back this far

// "Later" puts a suggestion off for an hour. In memory only: it survives page
// switches and hiding the dashboard, not a restart.
const snoozedUntil = new Map<string, number>();
const isSnoozed = (key: string) => (snoozedUntil.get(key) ?? 0) > Date.now();

type Upcoming = Awaited<ReturnType<typeof getUpcoming>>[number];

type HomeData = {
  name: string;
  todos: TodoRow[];
  stats: TodayStats;
  habits: HabitRow[];
  streaks: { current: number; best: number };
  logs: HabitLogMap;
  upcoming: Upcoming[];
  assignments: AssignmentRow[];
  notionSetUp: boolean;
};

async function loadHome(): Promise<HomeData> {
  const [name, todos, stats, habits, streaks, logs, upcoming, assignments, notionDb] = await Promise.all([
    getSetting("user_name"),
    getTodosFiltered("pending", 500),
    getTodayStats(),
    getTodayHabitLogs(),
    getHabitStreaks(),
    getHabitLogsSince(STREAK_WINDOW_DAYS),
    getUpcoming(30),
    getOpenAssignments(7, 30),
    getSetting("notion_assignments_db_id"),
  ]);
  return {
    name: name?.trim() || "Bas",
    todos,
    stats,
    habits: habits as HabitRow[],
    streaks,
    logs,
    upcoming,
    assignments,
    notionSetUp: !!notionDb,
  };
}

function greetingKey(hour: number) {
  if (hour >= 5 && hour < 12) return "home.greet.morning";
  if (hour >= 12 && hour < 18) return "home.greet.afternoon";
  if (hour >= 18 && hour < 22) return "home.greet.evening";
  return "home.greet.night";
}

export default function PageHome({ appearance }: { appearance: Appearance }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [weather, setWeather] = useState<WeatherState | null>(null);
  const [, setSnoozeTick] = useState(0);
  const pom = usePomodoro();

  // Cached data first; a failed refresh keeps showing the last reading (stale).
  const load = useCallback(() => {
    loadHome().then(setData).catch(console.error);
    getWeather().then(setWeather).catch(console.error);
  }, []);

  // Load now and whenever the window comes back, so Nox's message is fresh.
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    // A place switch (chip, Settings, /lokasi, a Telegram pin) shows at once.
    const unlisten = listen("settings:changed", () => getWeather().then(setWeather).catch(console.error));
    return () => {
      window.removeEventListener("focus", load);
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  // Completed sessions change the summary row.
  useEffect(load, [pom.sessionsToday, load]);

  if (!data) return <PageHeader appearance={appearance} hero>{null}</PageHeader>;

  const today = todayLocal();
  const dueNow = data.todos.filter((x) => x.due_date && x.due_date.slice(0, 10) <= today);
  const overdueCount = dueNow.filter((x) => x.due_date!.slice(0, 10) < today).length;
  const habitsLeft = data.habits.filter((h) => !h.completed).length;
  const suggestion = pickSuggestion({ todos: data.todos, today, habitsLeft, isSnoozed });

  const later = (s: Suggestion) => {
    snoozedUntil.set(s.key, Date.now() + SNOOZE_MS);
    setSnoozeTick((n) => n + 1);
  };

  const toggleTodo = async (todo: TodoRow) => {
    await setTodoStatus(todo.id, todo.status === "done" ? "pending" : "done");
    load();
  };

  const toggleHabit = async (habit: HabitRow) => {
    // Optimistic: the button should never lag behind the click.
    setData((d) =>
      d && { ...d, habits: d.habits.map((h) => (h.id === habit.id ? { ...h, completed: h.completed ? 0 : 1 } : h)) },
    );
    try {
      await logHabit(habit.id, !habit.completed);
    } finally {
      load();
    }
  };

  return (
    <>
      <PageHeader appearance={appearance} hero>
        <div className="hero">
          <div className="perch" aria-hidden="true">
            <div className="perch__pet nox-bob">
              <Pet state={pom.phase === "focus" ? "thinking" : "idle"} />
            </div>
            <div className="perch__rock" />
          </div>
          <div className="hero__text">
            <div className="hero__title-row">
              <h1 className="page-title">{t(greetingKey(new Date().getHours()), { name: data.name })}</h1>
              {weather && <WeatherChip weather={weather} />}
            </div>
            <DialogBox
              actions={
                suggestion.kind !== "idle" && (
                <SuggestionActions
                  suggestion={suggestion}
                  focusMinutes={pom.focusMinutes}
                  focusRunning={pom.phase !== "idle"}
                  onStart={() => pom.send("start")}
                  onLater={() => later(suggestion)}
                />
                )
              }
            >
              <p>
                <SuggestionText suggestion={suggestion} focusMinutes={pom.focusMinutes} />
              </p>
            </DialogBox>
          </div>
        </div>
      </PageHeader>

      <main className="dash-main">
        <div className="stats">
          <StatCard
            value={data.todos.length}
            label={t("home.todosOpen")}
            sub={overdueCount > 0 ? t("home.overdueCount", { n: overdueCount }) : undefined}
          />
          <StatCard value={pom.sessionsToday} of={DAILY_FOCUS_GOAL} label={t("home.focusSessions")} />
          <StatCard value={data.stats.habitsDone} of={data.stats.habitsTotal} label={t("home.habitsDone")} />
        </div>

        <div className="home-grid">
          <Card
            className="home-grid__lead"
            title={t("home.today")}
            meta={t("home.openCount", { n: dueNow.length })}
          >
            {dueNow.length === 0 && <p className="empty-line">{t("home.todayEmpty")}</p>}
            <div className="todo-list">
              {dueNow.map((todo) => (
                <TodoItem key={todo.id} todo={todo} onToggle={() => void toggleTodo(todo).catch(console.error)} />
              ))}
            </div>
            <AddTodo onAdded={load} defaultDue="today" />
          </Card>

          <div className="home-grid__side">
            <section className="card focus-card" aria-labelledby="home-focus">
              <Wings>
                <FocusRing seconds={pom.seconds} total={pom.total} phase={pom.phase} />
              </Wings>
              <div className="focus-card__text">
                <h2 id="home-focus" className="card__title card__title--sm">
                  {t("nav.pomodoro")}
                </h2>
                {pom.phase === "idle" ? (
                  <p className="muted">{t("home.focusOf", { n: pom.sessionsToday, goal: DAILY_FOCUS_GOAL })}</p>
                ) : (
                  <p className={pom.phase === "focus" ? "focusing" : "muted"}>
                    {t(pom.phase === "focus" ? "pom.ringFocus" : "pom.ringBreak")}
                  </p>
                )}
                <ChunkyButton
                  size="sm"
                  variant="quiet"
                  onClick={() => pom.send(pom.phase === "idle" ? "start" : pom.phase === "focus" ? "stop" : "skip")}
                >
                  {t(pom.phase === "idle" ? "pom.start" : pom.phase === "focus" ? "pom.stop" : "pom.skip")}
                </ChunkyButton>
              </div>
            </section>

            <section className="card habits-card" aria-labelledby="home-habits">
              <div className="habits-card__head">
                <StreakEgg />
                <div>
                  <h2 id="home-habits" className="card__title card__title--sm">
                    {t("nav.habits")}
                  </h2>
                  <p className="muted">
                    {t("habits.streakLine", { n: data.streaks.current, best: data.streaks.best })}
                  </p>
                </div>
              </div>
              {data.habits.length === 0 && <p className="empty-line">{t("habits.empty")}</p>}
              {data.habits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  aria-pressed={h.completed === 1}
                  className={`habit-toggle${h.completed ? " habit-toggle--done" : ""}`}
                  onClick={() => void toggleHabit(h).catch(console.error)}
                >
                  <span className="habit-toggle__box" aria-hidden="true">
                    {h.completed === 1 && <i className="ti ti-check" />}
                  </span>
                  <span className="habit-toggle__name">{h.name}</span>
                  <span className="habit-toggle__meta">
                    {t("habits.bestShort", { n: habitStreak(data.logs, h.id, today).best })}
                  </span>
                </button>
              ))}
              {data.habits.length > 0 && <WeekFootprints logs={data.logs} today={today} />}
            </section>
          </div>
        </div>

        <DeadlineRadar assignments={data.assignments} setUp={data.notionSetUp} />

        <NextDays upcoming={data.upcoming} today={today} />
      </main>
    </>
  );
}

/** The reading plus a quick switch between saved places. */
function WeatherChip({ weather }: { weather: WeatherState }) {
  const d = weather.data;
  const kind = weatherKind(d.weatherCode, d.isDay);
  const temp = Math.round(d.temperature);
  return (
    <span className={`weather-chip${weather.stale ? " weather-chip--stale" : ""}`}>
      <span
        className="weather-chip__reading"
        role="img"
        aria-label={t("home.weatherLabel", { what: t(kind.label), temp }) + (weather.stale ? ` (${t("home.weatherOld")})` : "")}
      >
        <i className={`ti ${kind.icon}`} aria-hidden="true" />
        <span className="weather-chip__temp">{temp}°</span>
        <span className="weather-chip__what">
          {t(kind.label)}
          {weather.stale && ` · ${t("home.weatherOld")}`}
        </span>
      </span>
      <PlaceSelect className="weather-chip__place" />
    </span>
  );
}

/** Notion assignments due in the next 7 days plus overdue, soonest first. */
function DeadlineRadar({ assignments, setUp }: { assignments: AssignmentRow[]; setUp: boolean }) {
  const now = new Date();
  return (
    <Card title={t("home.radar")} meta={t("home.radarMeta")}>
      {assignments.length === 0 ? (
        <p className="empty-line">{t(setUp ? "home.radarEmpty" : "home.radarSetup")}</p>
      ) : (
        <ul className="radar">
          {assignments.map((a) => {
            const u = urgency(a.due_date, now);
            const tone = u.kind === "overdue" ? "overdue" : u.kind === "today" || u.kind === "tomorrow" ? "warn" : "neutral";
            return (
              <li key={a.notion_id} className={`radar__row${u.kind === "overdue" ? " radar__row--overdue" : ""}`}>
                <Tag tone={tone}>{urgencyText(u, t)}</Tag>
                <span className="radar__name">{a.name}</span>
                {a.course && <span className="radar__course">{a.course}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function SuggestionText({ suggestion: s, focusMinutes }: { suggestion: Suggestion; focusMinutes: number }) {
  const title = (text: string) => <span className="text-danger">{text}</span>;
  switch (s.kind) {
    case "overdue":
      return (
        <>
          {fillRich(
            t(s.days === 1 ? "home.msg.overdueOne" : "home.msg.overdue"),
            { title: s.todo.title, n: s.days, min: focusMinutes },
            { title },
          )}
        </>
      );
    case "today":
      return (
        <>
          {fillRich(
            t("home.msg.today"),
            { title: s.todo.title, min: focusMinutes },
            { title: (text) => <strong>{text}</strong> },
          )}
        </>
      );
    case "habits":
      return <>{t(s.count === 1 ? "home.msg.habitsOne" : "home.msg.habits", { n: s.count })}</>;
    case "idle":
      return <>{t("home.msg.idle")}</>;
  }
}

function SuggestionActions({
  suggestion,
  focusMinutes,
  focusRunning,
  onStart,
  onLater,
}: {
  suggestion: Suggestion;
  focusMinutes: number;
  focusRunning: boolean;
  onStart: () => void;
  onLater: () => void;
}) {
  const offersFocus = (suggestion.kind === "overdue" || suggestion.kind === "today") && !focusRunning;
  return (
    <>
      {offersFocus && (
        <ChunkyButton onClick={onStart}>{t("home.startFocus", { min: focusMinutes })}</ChunkyButton>
      )}
      <ChunkyButton variant="secondary" onClick={onLater}>
        {t("pet.later")}
      </ChunkyButton>
    </>
  );
}

/** A dashed line of the coming week with what is due on each day. */
function NextDays({ upcoming, today }: { upcoming: Upcoming[]; today: string }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = shiftDay(today, i);
    const [y, m, d] = date.split("-").map(Number);
    const items = upcoming.filter((u) => (i === 0 ? u.due_date <= today : u.due_date === date));
    const overdue = i === 0 && items.some((u) => u.due_date < today);
    return {
      date,
      label: i === 0 ? t("home.todayShort") : new Date(y, m - 1, d).toLocaleDateString(locale(), { weekday: "short" }),
      items,
      overdue,
      soon: i <= 1,
    };
  });

  return (
    <Card title={t("home.next7")} meta={t("home.next7Meta")}>
      <div className="days">
        <div className="days__line" aria-hidden="true" />
        <ol className="days__list">
          {days.map((d) => (
            <li key={d.date} className="day">
              {d.overdue ? (
                <Tag tone="overdue">{t("tag.overdue")}</Tag>
              ) : (
                <span
                  className={`day__node${d.items.length ? (d.soon ? " day__node--soon" : " day__node--busy") : ""}`}
                  aria-hidden="true"
                />
              )}
              <span className={`day__label${d.items.length ? " day__label--busy" : ""}`}>{d.label}</span>
              {d.items.length > 0 && (
                <span
                  className={`day__item${d.overdue ? " day__item--overdue" : d.soon ? " day__item--soon" : ""}`}
                >
                  {d.items[0].title}
                  {d.items.length > 1 && ` +${d.items.length - 1}`}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
