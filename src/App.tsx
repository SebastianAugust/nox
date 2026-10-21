import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Pet, { type PetState } from "./components/Pet";
import Bubble from "./components/Bubble";
import ChatInput from "./components/ChatInput";
import CheckinPrompt from "./components/CheckinPrompt";
import { chat, type ChatMessage } from "./lib/ollama";
import { getDb } from "./lib/db";
import { addReminder, addTodo, getSetting } from "./lib/db-helpers";
import { describeDue, parseRemindArgs, parseTodoArgs } from "./lib/commands";
import { t, useLanguage } from "./lib/i18n";
import { saveCheckin, startCheckinScheduler, type Mood } from "./lib/checkin";
import { recordInteraction, startFrictionDetector } from "./lib/friction";
import { startRecapScheduler } from "./lib/recap";
import { startReminderPoller } from "./lib/reminders";
import {
  getPomodoroSnapshot,
  startPomodoroEngine,
  subscribePomodoro,
  type PomPhase,
} from "./lib/pomodoroEngine";

const HISTORY_LIMIT = 6;
const HEIGHT_OPEN = 320;
const HEIGHT_CHECKIN = 250;
const HEIGHT_CLOSED = 200;
const REVERT_MS = 10000; // how long an answer lingers before the bubble resets
const FLASH_MS = 4000; // how long a one-off expression (excited/happy) holds

// Nox dozes off at night once left alone for a while.
const SLEEP_AFTER_MINUTES = 10;
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 7;

function isNight(d = new Date()) {
  const h = d.getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/** The user's name from settings, for bubbles that address them. */
async function userName(): Promise<string> {
  return (await getSetting("user_name"))?.trim() || "Bas";
}

/** The resting face: focused while a pomodoro runs, otherwise idle. */
function ambientState(): PetState {
  return getPomodoroSnapshot().phase === "focus" ? "thinking" : "idle";
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  useLanguage(); // re-render every string when the language setting changes
  // null = the greeting, rendered at display time so it follows the language.
  const [bubbleText, setBubbleText] = useState<string | null>(null);
  const [petState, setPetState] = useState<PetState>("idle");
  const [chatOpen, setChatOpen] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const revertTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());

  // Open the local SQLite database once on startup (Rust already migrated it).
  useEffect(() => {
    getDb()
      .then(() => console.log("Nox DB ready"))
      .catch(console.error);
  }, []);

  const clearRevert = () => {
    if (revertTimerRef.current !== null) {
      clearTimeout(revertTimerRef.current);
      revertTimerRef.current = null;
    }
  };

  // After a reply is shown, let it linger then fall back to the greeting.
  const scheduleRevert = () => {
    clearRevert();
    revertTimerRef.current = window.setTimeout(() => {
      setBubbleText(null);
      revertTimerRef.current = null;
    }, REVERT_MS);
  };

  /** Show a one-off expression, then hand the face back to the ambient state. */
  const flashState = useCallback((state: PetState, ms = FLASH_MS) => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    setPetState(state);
    flashTimerRef.current = window.setTimeout(() => {
      setPetState(ambientState());
      flashTimerRef.current = null;
    }, ms);
  }, []);

  /** Any deliberate contact resets both the idle clock and the sleep clock. */
  const touch = useCallback(() => {
    recordInteraction();
    lastActivityRef.current = Date.now();
  }, []);

  // The window only needs to be tall enough for whatever is currently below
  // the bubble, so height follows the open panel rather than each caller.
  useEffect(() => {
    const height = chatOpen
      ? HEIGHT_OPEN
      : showCheckin
        ? HEIGHT_CHECKIN
        : HEIGHT_CLOSED;
    invoke("resize_window", { height }).catch(console.error);
  }, [chatOpen, showCheckin]);

  const setOpen = (open: boolean) => {
    setChatOpen(open);
    if (open) {
      // Opening the input starts a fresh question: reset the bubble.
      touch();
      clearRevert();
      setShowCheckin(false);
      setBubbleText(null);
    }
  };

  const toggleChat = () => {
    touch();
    setOpen(!chatOpen);
  };

  // ── Schedulers ────────────────────────────────────────────────────────────
  // Each start* returns its own stop function, so React's dev double-invoke
  // cannot leave a second timer running.

  useEffect(
    () =>
      startCheckinScheduler(() => {
        setBubbleText(t("pet.checkinAsk"));
        setPetState("alert");
        setShowCheckin(true);
      }),
    [],
  );

  useEffect(
    () =>
      startFrictionDetector(async () => {
        const name = await userName();
        // setOpen(true) resets the bubble, so the nudge is written after it.
        setOpen(true);
        setPetState("alert");
        setBubbleText(t("pet.friction", { name }));
      }),
    [],
  );

  useEffect(
    () =>
      startRecapScheduler(async (recap) => {
        const name = await userName();
        clearRevert();
        flashState("happy", 15000);
        setBubbleText(t("pet.recap", { summary: recap.summary, name }));
      }),
    [flashState],
  );

  // Reminders saved by /remind come back here when their time arrives.
  useEffect(
    () =>
      startReminderPoller((titles) => {
        clearRevert();
        flashState("alert", 20000);
        setBubbleText(
          t(titles.length === 1 ? "pet.reminder" : "pet.reminders", {
            titles: titles.join(" · "),
          }),
        );
      }),
    [flashState],
  );

  // Ambient face: when nothing is going on, doze off at night and wake up
  // otherwise. Busy states (thinking/alert/happy/excited) are left alone.
  useEffect(() => {
    const tick = () => {
      const idleMinutes = (Date.now() - lastActivityRef.current) / 60000;
      const shouldSleep = isNight() && idleMinutes >= SLEEP_AFTER_MINUTES;
      setPetState((prev) =>
        prev === "idle" || prev === "sleeping"
          ? shouldSleep
            ? "sleeping"
            : "idle"
          : prev,
      );
    };
    tick();
    const handle = setInterval(tick, 60 * 1000);
    return () => clearInterval(handle);
  }, []);

  // The pomodoro timer lives here, in the always-alive pet window; the
  // dashboard only sends commands and renders the state it broadcasts.
  useEffect(() => startPomodoroEngine(), []);

  // The pet's face and bubble follow the pomodoro phase. Every phase change
  // lands somewhere definite, so no path can leave it stuck in focus mode.
  useEffect(() => {
    let prev: PomPhase = getPomodoroSnapshot().phase;
    return subscribePomodoro(({ phase }) => {
      if (phase === prev) return;
      prev = phase;
      if (phase === "focus") {
        setPetState("thinking");
        setBubbleText(t("pet.focus"));
      } else if (phase === "break") {
        flashState("excited", 15000);
        setBubbleText(t("pet.break"));
      } else {
        setPetState("idle");
        setBubbleText(null);
      }
    });
  }, [flashState]);

  // Escape closes whatever is open. ChatInput handles its own Escape while
  // focused; this covers the case where focus sits elsewhere in the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (chatOpen) setChatOpen(false);
      else if (showCheckin) dismissCheckin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen, showCheckin]);

  // ── Interactions ──────────────────────────────────────────────────────────

  // Left-press on the pet: start a native window drag only once the cursor
  // actually moves past a small threshold. A press with no movement falls
  // through to the pet's onClick (toggleChat), so click and drag coexist.
  // startDragging() consumes the release, so no chat toggle fires after a drag.
  const handlePetMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    const startX = e.screenX;
    const startY = e.screenY;

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.screenX - startX) > 4 || Math.abs(ev.screenY - startY) > 4) {
        cleanup();
        getCurrentWindow().startDragging().catch(console.error);
      }
    };
    const onUp = () => cleanup();

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleCheckin = async (mood: Mood) => {
    touch();
    setShowCheckin(false);
    try {
      await saveCheckin(mood.key, mood.energy);
    } catch (err) {
      console.error(err);
    }
    flashState(mood.energy >= 4 ? "excited" : "happy");
    const name = await userName().catch(() => "Bas");
    setBubbleText(
      mood.key === "tired"
        ? t("pet.checkin.tired", { name })
        : mood.key === "hungry"
          ? t("pet.checkin.hungry")
          : t("pet.checkin.other"),
    );
    scheduleRevert();
  };

  const dismissCheckin = () => {
    touch();
    setShowCheckin(false);
    setPetState(ambientState());
    setBubbleText(null);
  };

  /**
   * Slash commands are handled locally and never reach Ollama — quick capture
   * should be instant and work with the model offline.
   * Returns true when the message was a command.
   */
  const handleCommand = async (text: string): Promise<boolean> => {
    const match = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
    if (!match) return false;
    const [, command, rest] = match;
    const arg = rest.trim();

    switch (command) {
      case "todo": {
        if (!arg) {
          setBubbleText(t("cmd.todo.empty"));
          break;
        }
        const { title, due_date } = parseTodoArgs(arg);
        if (!title) {
          setBubbleText(t("cmd.todo.onlyDate"));
          break;
        }
        try {
          await addTodo({ title, due_date, context: "personal" });
          flashState("excited");
          setBubbleText(
            due_date
              ? t("cmd.todo.addedDue", {
                  title,
                  due: describeDue(due_date, {
                    today: t("date.today"),
                    tomorrow: t("date.tomorrow"),
                  }),
                })
              : t("cmd.todo.added", { title }),
          );
        } catch (err) {
          console.error(err);
          setBubbleText(t("cmd.saveFailed"));
        }
        break;
      }
      case "remind": {
        if (!arg) {
          setBubbleText(t("cmd.remind.empty"));
          break;
        }
        const parsed = parseRemindArgs(arg);
        try {
          if (parsed.remind_at) {
            await addReminder({ title: parsed.title, remind_at: parsed.remind_at });
            flashState("excited");
            setBubbleText(
              t("cmd.remind.set", {
                title: parsed.title,
                when: parsed.tomorrow
                  ? t("cmd.remind.tomorrowAt", { clock: parsed.clock ?? "" })
                  : (parsed.clock ?? ""),
              }),
            );
          } else {
            // No time in there — keep it rather than lose it, as a todo.
            await addTodo({ title: parsed.title, notes: "reminder", context: "personal" });
            flashState("excited");
            setBubbleText(t("cmd.remind.asTodo", { title: parsed.title }));
          }
        } catch (err) {
          console.error(err);
          setBubbleText(t("cmd.saveFailed"));
        }
        break;
      }
      case "dashboard":
        // The pet hides itself while the dashboard is open.
        invoke("show_dashboard").catch(console.error);
        break;
      case "help":
        setBubbleText(t("cmd.help"));
        break;
      default:
        setBubbleText(t("cmd.unknown"));
    }

    setOpen(false);
    scheduleRevert();
    return true;
  };

  const handleSend = async (text: string) => {
    touch();
    clearRevert(); // a new reply is coming; cancel any pending reset

    if (await handleCommand(text)) return;

    const history = messages;
    const controller = new AbortController();
    controllerRef.current = controller;

    setPetState("thinking");
    setBubbleText(t("pet.thinking")); // shown until the first token arrives
    setIsStreaming(true);
    setOpen(false);

    let acc = "";
    await chat(
      text,
      history,
      controller,
      (chunk) => {
        acc += chunk;
        setBubbleText(acc);
      },
      () => {
        // onDone (normal completion or user-stop) — keep whatever streamed.
        setIsStreaming(false);
        setPetState(ambientState());
        if (acc) {
          setMessages((prev) =>
            [
              ...prev,
              { role: "user", content: text } as ChatMessage,
              { role: "assistant", content: acc } as ChatMessage,
            ].slice(-HISTORY_LIMIT),
          );
        }
        scheduleRevert(); // bubble returns to the greeting after a while
      },
      (err) => {
        setIsStreaming(false);
        setPetState(ambientState());
        setBubbleText(err);
        scheduleRevert();
      },
    );
  };

  const handleStop = () => controllerRef.current?.abort();

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 10px 8px",
        gap: 6,
        overflow: "hidden",
      }}
    >
      <Bubble text={bubbleText ?? t("pet.greeting")} isStreaming={isStreaming} onStop={handleStop} />
      {chatOpen && (
        <ChatInput
          onSend={handleSend}
          onClose={() => setOpen(false)}
          disabled={isStreaming}
        />
      )}
      {!chatOpen && showCheckin && (
        <CheckinPrompt onPick={handleCheckin} onDismiss={dismissCheckin} />
      )}
      <Pet state={petState} onClick={toggleChat} onMouseDown={handlePetMouseDown} />
    </div>
  );
}

export default App;
