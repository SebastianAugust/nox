import { useEffect, useState } from "react";
import { getRecentRecaps } from "../../lib/db-helpers";
import { locale, t } from "../../lib/i18n";
import { card, emptyText } from "../../styles/shared";

/** Day recaps, newest first. */
export default function PageRecap() {
  const [recaps, setRecaps] = useState<Awaited<ReturnType<typeof getRecentRecaps>>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getRecentRecaps(14)
      .then((r) => {
        setRecaps(r);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  if (!loaded) return <div style={emptyText}>{t("common.loading")}</div>;

  if (recaps.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "40px 0",
          color: "rgba(255,255,255,0.2)",
          fontSize: 13,
        }}
      >
        {t("recap.empty")}
      </div>
    );
  }

  const tile = (value: string, label: string, color: string) => (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 6, padding: "6px 9px" }}>
      <div style={{ fontSize: 14, fontWeight: 500, color }}>{value}</div>
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>{label}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {recaps.map((r) => {
        const [y, m, d] = r.date.split("-").map(Number);
        return (
          <div key={r.date} style={{ ...card, padding: "12px 14px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,0.75)" }}>
                {new Date(y, m - 1, d).toLocaleDateString(locale(), {
                  weekday: "long",
                  day: "numeric",
                  month: "short",
                })}
              </div>
              {r.mood && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 20,
                    background: "rgba(0,229,160,0.1)",
                    color: "#00e5a0",
                  }}
                >
                  {r.mood}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {tile(
                `${r.todos_completed}/${r.todos_total}`,
                t("recap.tasks"),
                r.todos_completed > 0 ? "#00e5a0" : "rgba(255,255,255,0.5)",
              )}
              {tile(
                String(r.pomodoro_sessions),
                t("recap.pomodoros"),
                r.pomodoro_sessions > 0 ? "#60a5fa" : "rgba(255,255,255,0.5)",
              )}
              {tile(
                `${r.habits_completed}/${r.habits_total}`,
                t("recap.habits"),
                r.habits_completed > 0 ? "#a78bfa" : "rgba(255,255,255,0.5)",
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
