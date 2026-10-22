import { useCallback, useEffect, useState } from "react";
import { deleteReminder, getReminders, type ReminderRow } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { card, emptyText, rowBorder, sectionLabel } from "../../styles/shared";

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
