import { apiErrorText } from "./api";
import { applyProposal, confirmText, editInTodos } from "./capture";
import { eventAsTodo, proposalToDraft, type Proposal, type TaskProposal } from "./captureCore";
import { getEvents } from "./calendar";
import { localClock, overlapping } from "./calendarLogic";
import { describeDue } from "./commands";
import { draftAsText, eventTimes, type EventDraft } from "./eventParse";
import { createGoogleEvent, googleStatus } from "./googleCalendar";
import { t } from "./i18n";
import {
  cancelAction,
  claimAction,
  createAction,
  finishAction,
  getAction,
  type ActionSource,
} from "./pendingActions";

/**
 * The one confirmation flow for anything created from free text, in the pet
 * and in Telegram: a capture proposal (todo or reminder, step 03) or a
 * Google Calendar event. Offering stores a pending action and returns the
 * question; nothing is created until it is confirmed (once, before it
 * expires, from where it was offered).
 */

type Capture = Exclude<Proposal, { intent: "chat" }>;
type EventPayload = { draft: EventDraft };
type CapturePayload = { proposal: TaskProposal };

export type Offer = { id: number; text: string };

function whenText(d: EventDraft, now = new Date()): string {
  const words = { today: t("date.today"), tomorrow: t("date.tomorrow") };
  const day = describeDue(d.date, words, now);
  if (d.allDay) return `${day} · ${t("ev.allDay")}`;
  return `${day} ${d.start}–${d.end}${d.endDate !== d.date ? ` (${describeDue(d.endDate, words, now)})` : ""}`;
}

/** "Add event “rapat” · Fri 14:00–15:30 · sekre?" plus an overlap warning. */
export async function eventQuestion(d: EventDraft, now = new Date()): Promise<string> {
  const times = eventTimes(d);
  const lastDay = d.allDay ? d.date : d.endDate;
  const clash = overlapping(await getEvents(d.date, lastDay), times.startUtc, times.endUtc, d.allDay);
  const ask = t("ev.confirm", { title: d.title, when: whenText(d, now), place: d.location ? ` · ${d.location}` : "" });
  if (!clash.length) return ask;
  const list = clash
    .slice(0, 3)
    .map((e) => `${e.title} ${localClock(e.start)}–${localClock(e.end)}`)
    .join(", ");
  return `${ask}\n${t("ev.overlap", { list })}`;
}

export async function offerEvent(draft: EventDraft, source: ActionSource): Promise<Offer> {
  const text = await eventQuestion(draft);
  const id = await createAction("event", { draft } satisfies EventPayload, source);
  return { id, text };
}

/**
 * Offer what the local model understood. Todos and reminders as a capture;
 * an event as a Google Calendar event through the same path as `/event`;
 * and when Google is not connected, the event is offered as a todo instead
 * (with the reason). Always a question: nothing is created here.
 */
export async function offerCapture(proposal: Capture, source: ActionSource): Promise<Offer> {
  if (proposal.intent === "event") {
    const connected = (await googleStatus().catch(() => ({ connected: false }))).connected;
    if (connected) return offerEvent(proposalToDraft(proposal), source);
    const todo = eventAsTodo(proposal);
    const id = await createAction("capture", { proposal: todo } satisfies CapturePayload, source);
    return { id, text: `${t("cap.eventNoGoogle")} ${confirmText(todo)}` };
  }
  const id = await createAction("capture", { proposal } satisfies CapturePayload, source);
  return { id, text: confirmText(proposal) };
}

const REFUSED = { missing: "act.expired", expired: "act.expired", used: "act.used", otherSource: "act.otherSource" } as const;

/** Run a confirmed action once. Returns the reply to show. */
export async function confirmAction(id: number, source: ActionSource): Promise<string> {
  const claim = await claimAction(id, source);
  if (!claim.ok) return t(REFUSED[claim.reason]);
  const a = claim.action;
  try {
    let reply: string;
    if (a.kind === "event") {
      const { draft } = JSON.parse(a.payload) as EventPayload;
      const times = eventTimes(draft);
      const created = await createGoogleEvent({
        title: draft.title,
        start: times.start,
        end: times.end,
        allDay: draft.allDay,
        location: draft.location ?? null,
      });
      reply = created.htmlLink
        ? t("ev.created", { title: draft.title, link: created.htmlLink })
        : t("ev.createdNoLink", { title: draft.title });
    } else {
      reply = await applyProposal((JSON.parse(a.payload) as CapturePayload).proposal);
    }
    await finishAction(id, "done", reply);
    return reply;
  } catch (err) {
    const reply = a.kind === "event" ? t("ev.failed", { reason: apiErrorText(err, "google") }) : t("cmd.saveFailed");
    await finishAction(id, "failed", reply);
    return reply;
  }
}

export async function cancelOffer(id: number, source: ActionSource): Promise<string> {
  return t((await cancelAction(id, source)) ? "cap.cancelled" : "act.expired");
}

/**
 * "Edit" (pet only): drop the pending action and hand the text back. A
 * capture opens the Todos page prefilled; an event returns its /event line
 * for the chat input.
 */
export async function editOffer(id: number, source: ActionSource): Promise<{ prefill: string | null }> {
  const a = await getAction(id);
  if (!a || !(await cancelAction(id, source))) return { prefill: null };
  if (a.kind === "event") return { prefill: draftAsText((JSON.parse(a.payload) as EventPayload).draft) };
  await editInTodos((JSON.parse(a.payload) as CapturePayload).proposal);
  return { prefill: null };
}
