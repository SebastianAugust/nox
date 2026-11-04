import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { deleteReminder, getReminders, type ReminderRow } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { Card, IconButton, Tag } from "../../components/ui/controls";

/**
 * Reminders set with /ingat or "Remind me" on a todo: what is coming, and
 * what came due today. Ones made from a todo say "linked todo".
 */
export default function Reminders() {
  const [reminders, setReminders] = useState<ReminderRow[]>([]);

  const load = useCallback(async () => {
    setReminders(await getReminders());
  }, []);

  useEffect(() => {
    load().catch(console.error);
    // "Remind me" and deleting a todo both announce a todo change.
    const unlisten = listen("todos:changed", () => void load().catch(console.error));
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  const handleDelete = async (id: number) => {
    await deleteReminder(id);
    await load();
  };

  const upcoming = reminders.filter((r) => r.status === "pending").length;

  return (
    <Card title={t("reminders.title")} meta={upcoming ? t("reminders.upcoming", { n: upcoming }) : undefined}>
      {reminders.length === 0 && <p className="empty-line">{t("reminders.empty")}</p>}
      <ul className="session-list">
        {reminders.map((r) => {
          const sent = r.status !== "pending";
          // remind_at is a UTC "YYYY-MM-DD HH:MM:SS" stamp.
          const when = new Date(r.remind_at.replace(" ", "T") + "Z").toLocaleString(locale(), {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <li key={r.id} className={`session-row reminder${sent ? " reminder--sent" : ""}`}>
              <i className={`ti ${sent ? "ti-bell-check" : "ti-bell"} reminder__icon`} aria-hidden="true" />
              <span className="session-row__text">{r.title}</span>
              {r.todo_id !== null && <span className="reminder__linked">{t("reminders.linked")}</span>}
              {sent && <Tag tone="neutral">{t("reminders.sent")}</Tag>}
              <span className="pixel session-row__time">{when}</span>
              <IconButton
                label={t("reminders.delete")}
                onClick={() => void handleDelete(r.id).catch(console.error)}
                className="icon-btn--danger"
              >
                <i className="ti ti-trash" aria-hidden="true" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
