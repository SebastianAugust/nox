import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { addReminder, getSetting } from "./db-helpers";
import { CAPTURE_TIMEOUT_MS, extractIntent, proposalAsQuickAdd, STEPS_SCHEMA, STEPS_SYSTEM, validateSteps, type Proposal } from "./captureCore";
import { toUtcStamp } from "./commands";
import { describeDue } from "./commands";
import { t } from "./i18n";
import { askJson } from "./ollama";
import { createFromQuickAdd } from "./todoRepo";

/**
 * Capture in the app: the local model reads a chat message that may be a
 * task, and Nox shows a confirmation. Nothing is created until Bas says Add
 * (pet) or Confirm (Telegram). Text never leaves the PC: only the local
 * Ollama sees it.
 */

export async function captureEnabled(): Promise<boolean> {
  return (await getSetting("ai_capture_enabled").catch(() => null)) !== "false";
}

/** A proposal for this message, or chat. */
export async function propose(text: string): Promise<Proposal> {
  if (!(await captureEnabled())) return { intent: "chat" };
  return extractIntent(text, askJson);
}

/** "Add todo “bayar kos” · tomorrow 07:00?" */
export function confirmText(p: Exclude<Proposal, { intent: "chat" }>): string {
  const when = p.due_date
    ? `${describeDue(p.due_date, { today: t("date.today"), tomorrow: t("date.tomorrow") })}${p.due_time ? ` ${p.due_time}` : ""}`
    : t("cap.noDate");
  return t(p.intent === "reminder" ? "cap.confirmReminder" : "cap.confirmTodo", { title: p.title, when });
}

/** Create what was confirmed. Returns the plain reply to show. */
export async function applyProposal(p: Exclude<Proposal, { intent: "chat" }>): Promise<string> {
  if (p.intent === "reminder" && p.due_date && p.due_time) {
    const [y, m, d] = p.due_date.split("-").map(Number);
    const [h, mi] = p.due_time.split(":").map(Number);
    await addReminder({ title: p.title, remind_at: toUtcStamp(new Date(y, m - 1, d, h, mi)) });
    return t("cap.addedReminder", { title: p.title });
  }
  await createFromQuickAdd({
    title: p.title,
    due_date: p.due_date,
    due_time: p.due_time,
    priority: p.priority,
    list: p.list,
    course: p.course,
  });
  return t("cap.addedTodo", { title: p.title });
}

/** "Edit": open the Todos page with quick-add prefilled. */
export async function editInTodos(p: Exclude<Proposal, { intent: "chat" }>): Promise<void> {
  await emit("todos:prefill", { text: proposalAsQuickAdd(p) });
  await invoke("show_dashboard");
}

/** 3-6 suggested steps for a todo, or throws with a plain reason. */
export async function suggestSteps(title: string, notes: string | null): Promise<string[]> {
  const user = notes?.trim() ? `${title}\n\n${notes.trim().slice(0, 1000)}` : title;
  const raw = await askJson(STEPS_SYSTEM, user, STEPS_SCHEMA, CAPTURE_TIMEOUT_MS);
  const steps = validateSteps(raw);
  if (!steps) throw new Error("unusable");
  return steps;
}
