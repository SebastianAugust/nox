import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getSettings } from "./db";
import { getSetting, setSetting } from "./db-helpers";
import { asApiError, secretExists } from "./api";
import { parseCommand, renderResult } from "./commands";
import { runCommand } from "./commandRunner";
import { t } from "./i18n";
import { chat, HISTORY_LIMIT, type ChatMessage } from "./ollama";
import { addPlace } from "./places";
import { applyProposal, captureEnabled, confirmText, propose } from "./capture";
import { mayBeTask, type Proposal } from "./captureCore";
import { getWeather, weatherLine } from "./weather";

/**
 * The Telegram side of Nox, run by the pet window: one long-polling loop
 * (Rust `telegram_poll` holds the token and only passes on messages from the
 * paired chat), plus pushes of reminders, the briefing and deadline nudges.
 *
 *   /commands  → the same parser and runner as the pet chat
 *   free text  → Ollama, with a typing indicator and a notice when slow
 *
 * Status for the dashboard: setting `telegram_status` ("ok" | "invalid" |
 * "offline" | ""), announced with "telegram:status".
 */

export type TelegramStatus = "ok" | "invalid" | "offline" | "";
export type PushKind = "reminders" | "briefing" | "nudges";

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const TYPING_EVERY_MS = 4_500;
const SLOW_NOTICE_MS = 20_000;

let status: TelegramStatus = "";
async function setStatus(next: TelegramStatus) {
  if (next === status) return;
  status = next;
  await setSetting("telegram_status", next).catch(console.error);
  await emit("telegram:status").catch(console.error);
}

async function send(text: string): Promise<void> {
  if (!text.trim()) return;
  await invoke("telegram_send", { text });
}

/**
 * Push a message to the phone if Telegram is set up, paired and this kind is
 * switched on. Never throws: Telegram is always an extra channel.
 */
export async function pushTelegram(kind: PushKind, text: string): Promise<void> {
  try {
    const s = await getSettings([`telegram_push_${kind}`, "telegram_chat_id"]);
    if (s[`telegram_push_${kind}`] === "false" || !s.telegram_chat_id) return;
    if (status === "invalid" || !(await secretExists("telegram_bot_token"))) return;
    await send(text);
  } catch (err) {
    console.error("telegram push failed", asApiError(err).kind);
  }
}

// Its own short memory, separate from the pet chat's.
let history: ChatMessage[] = [];

async function answerChat(text: string): Promise<void> {
  const typing = () => invoke("telegram_typing").catch(() => {});
  void typing();
  const typingTimer = setInterval(typing, TYPING_EVERY_MS);
  const slowTimer = setTimeout(() => void send(t("tg.slow")).catch(() => {}), SLOW_NOTICE_MS);
  const done = () => {
    clearInterval(typingTimer);
    clearTimeout(slowTimer);
  };

  await chat(
    text,
    history,
    new AbortController(),
    () => {},
    async (reply, cutOff) => {
      done();
      if (!reply) return void (await send(t("tg.noReply")).catch(console.error));
      history = [...history, { role: "user" as const, content: text }, { role: "assistant" as const, content: reply }].slice(
        -HISTORY_LIMIT,
      );
      await send(cutOff ? `${reply} ${t("ollama.cutOff")}` : reply).catch(console.error);
    },
    async (err) => {
      done();
      await send(err).catch(console.error);
    },
  );
}

type Incoming =
  | { kind: "text"; text: string }
  | { kind: "location"; latitude: number; longitude: number }
  | { kind: "callback"; id: string; data: string };

// Capture previews waiting for Confirm / Cancel (button data "cap:yes:<n>").
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const proposals = new Map<number, { p: Exclude<Proposal, { intent: "chat" }>; at: number }>();
let nextProposal = 1;

async function offerProposal(p: Exclude<Proposal, { intent: "chat" }>): Promise<void> {
  const id = nextProposal++;
  proposals.set(id, { p, at: Date.now() });
  await invoke("telegram_send_buttons", {
    text: confirmText(p),
    buttons: [
      { label: t("cap.confirm"), data: `cap:yes:${id}` },
      { label: t("todo.cancel"), data: `cap:no:${id}` },
    ],
  });
}

async function handleCallback(id: string, data: string): Promise<void> {
  const m = /^cap:(yes|no):(d+)$/.exec(data);
  await invoke("telegram_answer_callback", { callbackId: id, text: null }).catch(() => {});
  if (!m) return;
  const key = Number(m[2]);
  const entry = proposals.get(key);
  proposals.delete(key);
  if (!entry || Date.now() - entry.at > PROPOSAL_TTL_MS) return send(t("cap.expired"));
  if (m[1] === "no") return send(t("cap.cancelled"));
  await send(await applyProposal(entry.p));
}

// A location pin waiting for its name. Only the paired chat reaches here
// (Rust drops everything else), so this is always Bas's own pin.
const PIN_TTL_MS = 10 * 60 * 1000;
let pendingPin: { latitude: number; longitude: number; at: number } | null = null;

async function savePin(name: string): Promise<void> {
  const pin = pendingPin!;
  pendingPin = null;
  const place = await addPlace({ name, latitude: pin.latitude, longitude: pin.longitude });
  const w = await getWeather();
  await send([t("tg.pinSaved", { name: place.name }), w ? weatherLine(w) : null].filter(Boolean).join("\n"));
}

async function handleMessage(msg: Incoming): Promise<void> {
  if (msg.kind === "callback") return handleCallback(msg.id, msg.data);
  if (msg.kind === "location") {
    pendingPin = { latitude: msg.latitude, longitude: msg.longitude, at: Date.now() };
    return send(t("tg.pinAsk"));
  }
  const text = msg.text;
  const cmd = parseCommand(text);
  if (!cmd) {
    // The first plain message after a pin is its name.
    if (pendingPin && Date.now() - pendingPin.at < PIN_TTL_MS && text.trim()) return savePin(text);
    // Maybe a task: preview with Confirm / Cancel; nothing is created before Confirm.
    if (mayBeTask(text) && (await captureEnabled())) {
      void invoke("telegram_typing").catch(() => {});
      const p = await propose(text).catch(() => ({ intent: "chat" }) as Proposal);
      if (p.intent !== "chat") return offerProposal(p);
    }
    return answerChat(text);
  }
  const result = await runCommand(cmd, "telegram");
  await send(renderResult(result, t));
}

// One loop per window lifetime. React's dev double-mount stops and restarts
// quickly; a second concurrent getUpdates would make Telegram answer 409.
let users = 0;
let looping = false;
let wake: (() => void) | null = null;

/** Resolves on the next secrets change (or stop), whichever comes first. */
function waitForChange(): Promise<void> {
  return new Promise((resolve) => {
    wake = resolve;
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

async function loop() {
  looping = true;
  let backoff = BACKOFF_START_MS;
  while (users > 0) {
    if (!(await secretExists("telegram_bot_token").catch(() => false))) {
      await setStatus("");
      await waitForChange();
      continue;
    }
    try {
      const offset = Number(await getSetting("telegram_offset")) || 0;
      const r = await invoke<{ nextOffset: number; messages: Incoming[]; paired: boolean }>("telegram_poll", {
        offset,
      });
      await setStatus("ok");
      backoff = BACKOFF_START_MS;
      if (r.paired) await send(t("tg.paired")).catch(console.error);
      // Handled in order. The offset is stored after each batch, so nothing
      // is processed twice, also across restarts.
      for (const msg of r.messages) {
        await handleMessage(msg).catch(console.error);
      }
      if (r.nextOffset !== offset) await setSetting("telegram_offset", String(r.nextOffset));
    } catch (err) {
      const e = asApiError(err);
      if (e.kind === "unauthorized" || e.kind === "noToken") {
        // Wrong token: stop until a new one is saved, no crash loop.
        await setStatus(e.kind === "unauthorized" ? "invalid" : "");
        await waitForChange();
        continue;
      }
      await setStatus("offline");
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
  looping = false;
}

/** Start Telegram in the pet window. Returns a stop function. */
export function startTelegram(): () => void {
  users++;
  status = "";
  if (!looping) void loop();
  const unlisten = listen<{ name?: string }>("secrets:changed", ({ payload }) => {
    if (payload?.name === "telegram_bot_token") {
      status = "";
      wake?.();
    }
  });
  return () => {
    users--;
    wake?.();
    unlisten.then((off) => off()).catch(console.error);
  };
}
