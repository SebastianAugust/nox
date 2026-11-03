/**
 * Deadline maths for Notion assignments: which ones count, how urgent a due
 * date is, and which nudges (3 days, 1 day, 3 hours before) are due now.
 * Pure (imports only other pure code), so it is easy to test.
 *
 * Due dates are stored as local "YYYY-MM-DD" (no time: due at the end of
 * that day) or local "YYYY-MM-DD HH:MM".
 */

import { isCurrentCourse } from "./notionMapping";

/** Overdue items older than this drop off the radar and the briefing. */
export const OVERDUE_WINDOW_DAYS = 30;

export type AssignmentCandidate = {
  name: string;
  due_date: string | null;
  /** Set when the assignment links to a course. */
  course_notion_id: string | null;
  /** Whether that course is in the synced courses table. */
  course_known: boolean;
  /** Notion's status of that course ("In progress", "Passed", ...). */
  course_status: string | null;
};

/**
 * Whether an open assignment belongs on the radar, in the briefing and in
 * nudges: it has a name and a date (the template has blank rows), it is not
 * long overdue, and its course is current ("In progress") or it has none. A
 * link to a course that is not synced counts as no course.
 */
export function isRelevantAssignment(a: AssignmentCandidate, now: Date): boolean {
  if (!a.name.trim() || !a.due_date) return false;
  const due = parseDue(a.due_date);
  if (!due) return false;
  if (now.getTime() - due.getTime() > OVERDUE_WINDOW_DAYS * 24 * HOUR) return false;
  if (!a.course_notion_id || !a.course_known) return true;
  return isCurrentCourse(a.course_status);
}

export type Threshold = "3d" | "1d" | "3h";

const HOUR = 60 * 60 * 1000;

/** Largest first; a nudge is sent for the most urgent one crossed. */
export const THRESHOLDS: { id: Threshold; ms: number }[] = [
  { id: "3d", ms: 72 * HOUR },
  { id: "1d", ms: 24 * HOUR },
  { id: "3h", ms: 3 * HOUR },
];

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The moment something is due, in local time. A bare date means 23:59. */
export function parseDue(due: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(due);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = h
    ? new Date(+y, +mo - 1, +d, +h, +mi)
    : new Date(+y, +mo - 1, +d, 23, 59);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whether the due string carries a time of day. */
export const hasTime = (due: string) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(due);

export type Urgency =
  | { kind: "overdue"; days: number }
  | { kind: "today" }
  | { kind: "tomorrow" }
  | { kind: "days"; days: number };

/** Calendar-day urgency of a due date relative to `now`. */
export function urgency(due: string, now: Date): Urgency {
  const at = parseDue(due);
  const dayDiff = (() => {
    const [y, m, d] = due.slice(0, 10).split("-").map(Number);
    const [ty, tm, td] = localDay(now).split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / (24 * HOUR));
  })();
  // Due earlier today at a set time is already overdue.
  if (dayDiff < 0 || (at && at.getTime() < now.getTime())) {
    return { kind: "overdue", days: Math.max(0, -dayDiff) };
  }
  if (dayDiff === 0) return { kind: "today" };
  if (dayDiff === 1) return { kind: "tomorrow" };
  return { kind: "days", days: dayDiff };
}

export type NudgeItem = { id: string; name: string; course: string | null; due_date: string };

export type Nudge<T extends NudgeItem = NudgeItem> = { item: T; threshold: Threshold };

/** The key a sent nudge is stored under (nudges_sent primary key). */
export const nudgeKey = (id: string, threshold: Threshold) => `${id}|${threshold}`;

/**
 * Nudges to send now. For each assignment still ahead of its due time, take
 * the most urgent threshold already crossed; send it unless that exact
 * (assignment, threshold) pair was sent before. So starting the app late
 * never replays the older, larger thresholds, and a restart never repeats one.
 */
export function dueNudges<T extends NudgeItem>(items: T[], sent: Set<string>, now: Date): Nudge<T>[] {
  const out: Nudge<T>[] = [];
  for (const item of items) {
    const due = parseDue(item.due_date);
    if (!due) continue;
    const left = due.getTime() - now.getTime();
    if (left <= 0) continue; // overdue: the radar shows it, no nudge
    const crossed = THRESHOLDS.filter((t) => left <= t.ms);
    const mostUrgent = crossed[crossed.length - 1];
    if (!mostUrgent || sent.has(nudgeKey(item.id, mostUrgent.id))) continue;
    out.push({ item, threshold: mostUrgent.id });
  }
  return out.sort((a, b) => a.item.due_date.localeCompare(b.item.due_date));
}
