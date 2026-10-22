import { useCallback, useEffect, useState } from "react";
import { deleteReminder, getReminders, type ReminderRow } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { Card, IconButton, Tag } from "../../components/ui/controls";

/** Reminders set with /remind: what is coming, and what came due today. */
export default function Reminders() {
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
    <Card title={t("reminders.title")}>
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
