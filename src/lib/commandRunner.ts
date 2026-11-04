import { emit } from "@tauri-apps/api/event";
import {
  addReminder,
  clearConversation,
  getOpenAssignments,
  getTodosFiltered,
  todayLocal,
  type AssignmentRow,
} from "./db-helpers";
import { completeTodo, createFromQuickAdd, openTodosForCommands } from "./todoRepo";
import { flushOutbox, queueCreate, queueSetDone, writesEnabled } from "./notionOutbox";
import { calendarStale, getEvents } from "./calendar";
import { eventsOn, localClock, localDay } from "./calendarLogic";
import { locale } from "./i18n";
import { findPlace, toUtcStamp, type Command, type CommandResult, type TaskItem } from "./commands";
import { getActivePlace, getPlaces, placeDetail, setActivePlace } from "./places";
import { urgency } from "./deadlines";
import { getPomodoroSnapshot, type PomCommand } from "./pomodoroEngine";
import { getWeather, weatherLine } from "./weather";

/**
 * Carries out a parsed command, for the pet chat and Telegram alike. Runs in
 * the pet window (it owns the pomodoro engine). Only the listed commands
 * exist: nothing here runs programs, reads files or reaches beyond Nox's own
 * database, timer and weather.
 */

export type Channel = "pet" | "telegram";

const TASKS_SHOWN = 10;
const TODOS_SHOWN = 15;

function toTask(a: AssignmentRow, n: number, now: Date): TaskItem {
  return {
    n,
    name: a.name,
    course: a.course,
    due_date: a.due_date,
    urgency: urgency(a.due_date, now),
    status: a.notion_status,
  };
}

/** The numbered lists /tugas and /todo list show; /tugas n, /tugas selesai n and /done n index them. */
const taskRows = (_now: Date) => getOpenAssignments(undefined, TASKS_SHOWN);
async function taskList(now: Date): Promise<TaskItem[]> {
  return (await taskRows(now)).map((a, i) => toTask(a, i + 1, now));
}

const todoList = () => openTodosForCommands(TODOS_SHOWN);

async function sendPomodoro(cmd: PomCommand) {
  await emit("pomodoro:cmd", cmd);
}

export async function runCommand(cmd: Command, channel: Channel, now = new Date()): Promise<CommandResult> {
  try {
    switch (cmd.kind) {
      case "tasks": {
        const items = await taskList(now);
        if (cmd.n === undefined) return { kind: "tasks", items };
        const item = items[cmd.n - 1];
        return item ? { kind: "taskDetail", item } : { kind: "taskMissing", n: cmd.n };
      }
      case "notionAdd": {
        const q = cmd.quick;
        const r = await queueCreate({ name: q.title, due_date: q.due_date, due_time: q.due_time, course: q.course });
        if (r.result === "off") return { kind: "notionOff" };
        if (r.result === "notConfigured") return { kind: "notionNotSetUp" };
        if (r.result !== "queued") return { kind: "failed" };
        void flushOutbox();
        return {
          kind: "notionQueued",
          title: q.title,
          course: r.course,
          courseMissing: q.course && !r.courseMatched ? q.course : null,
        };
      }
      case "notionDone": {
        if (!(await writesEnabled())) return { kind: "notionOff" };
        const item = (await taskRows(now))[cmd.n - 1];
        if (!item) return { kind: "taskMissing", n: cmd.n };
        await queueSetDone(item.notion_id, true);
        void flushOutbox();
        return { kind: "notionDoneQueued", name: item.name };
      }
      case "todoAdd": {
        // Same parser and fields as the Todos page; the write announces
        // "todos:changed", so the page shows it at once.
        const q = cmd.quick;
        const r = await createFromQuickAdd(q);
        return {
          kind: "todoAdded",
          title: q.title,
          due_date: q.due_date,
          due_time: q.due_time,
          priority: q.priority,
          list: q.list ? (r.listMatched ? r.list.name : q.list) : undefined,
          listMatched: r.listMatched,
        };
      }
      case "todoList": {
        const todos = await todoList();
        return {
          kind: "todoList",
          items: todos.map((t, i) => ({
            n: i + 1,
            title: t.title,
            due_date: t.due_date,
            due_time: t.due_time,
            priority: t.priority,
          })),
        };
      }
      case "done": {
        const todo = (await todoList())[cmd.n - 1];
        if (!todo) return { kind: "todoMissing", n: cmd.n };
        await completeTodo(todo.id); // a repeating todo spawns its next one
        return { kind: "todoDone", title: todo.title };
      }
      case "remind":
        await addReminder({ title: cmd.title, remind_at: toUtcStamp(cmd.at) });
        return { kind: "reminderSet", title: cmd.title, at: cmd.at };
      case "focus": {
        const snap = getPomodoroSnapshot();
        if (snap.phase !== "idle") return { kind: "focusBusy" };
        await sendPomodoro({ type: "start", minutes: cmd.minutes });
        return { kind: "focusStarted", minutes: cmd.minutes ?? Math.round(snap.focusSec / 60) };
      }
      case "stop": {
        if (getPomodoroSnapshot().phase === "idle") return { kind: "focusIdle" };
        await sendPomodoro({ type: "stop" });
        return { kind: "focusStopped" };
      }
      case "status": {
        const snap = getPomodoroSnapshot();
        const [todos, tasks] = await Promise.all([getTodosFiltered("pending", 500), taskList(now)]);
        const today = todayLocal();
        return {
          kind: "status",
          phase: snap.phase,
          minutesLeft: snap.endsAt ? Math.max(0, Math.ceil((snap.endsAt - now.getTime()) / 60000)) : 0,
          todosOpen: todos.length,
          overdue: todos.filter((t) => t.due_date && t.due_date.slice(0, 10) < today).length,
          next: tasks.find((t) => t.urgency.kind !== "overdue") ?? tasks[0] ?? null,
        };
      }
      case "weather": {
        const w = await getWeather();
        return { kind: "weather", line: w ? weatherLine(w) : null };
      }
      case "schedule": {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (cmd.range === "tomorrow" ? 1 : 0));
        const count = cmd.range === "week" ? 7 : 1;
        const days = Array.from({ length: count }, (_, i) => localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
        const [events, stale] = await Promise.all([getEvents(days[0], days[days.length - 1]), calendarStale()]);
        return {
          kind: "schedule",
          range: cmd.range,
          stale,
          days: days.map((day) => {
            const [y, m, d] = day.split("-").map(Number);
            return {
              label: new Date(y, m - 1, d).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "short" }),
              events: eventsOn(events, day).map((e) => ({
                time: e.all_day ? null : `${localClock(e.start)}–${localClock(e.end)}`,
                title: e.title,
                location: e.location,
              })),
            };
          }),
        };
      }
      case "place": {
        const active = await getActivePlace();
        const places = await getPlaces();
        if (!active) return { kind: "placeNone" };
        if (cmd.name === undefined) {
          return {
            kind: "placeShow",
            name: active.name,
            detail: placeDetail(active),
            others: places.filter((p) => p.id !== active.id).map((p) => p.name),
          };
        }
        const target = findPlace(places, cmd.name);
        if (!target) return { kind: "placeMissing", name: cmd.name, names: places.map((p) => p.name) };
        if (target.id !== active.id) await setActivePlace(target.id);
        const w = await getWeather();
        return { kind: "placeSwitched", name: target.name, line: w ? weatherLine(w) : null };
      }
      case "help":
        return { kind: "help", telegram: channel === "telegram" };
      case "clear":
      case "dashboard":
        // Pet-window things; over Telegram they do not exist.
        if (channel === "telegram") return { kind: "unknown", name: cmd.kind };
        if (cmd.kind === "clear") {
          await clearConversation();
          return { kind: "cleared" };
        }
        return { kind: "dashboard" };
      case "error":
        return { kind: "error", error: cmd.error };
      case "unknown":
        return { kind: "unknown", name: cmd.name };
    }
  } catch (err) {
    console.error(err);
    return { kind: "failed" };
  }
}
