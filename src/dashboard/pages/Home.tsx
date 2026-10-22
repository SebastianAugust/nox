import { useEffect, useState } from "react";
import { getTodayStats, getUpcoming, type TodayStats } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { card, emptyText, rowBorder, sectionLabel, statCard } from "../../styles/shared";
import type { Appearance } from "../../lib/theme";
import { formatDue } from "../format";
import PageHeader from "../PageHeader";

export default function PageHome({ appearance }: { appearance: Appearance }) {
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [upcoming, setUpcoming] = useState<
    { title: string; due_date: string; source: string }[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s, u] = await Promise.all([getTodayStats(), getUpcoming(5)]);
      if (cancelled) return;
      setStats(s);
      setUpcoming(u);
    })().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  const tiles = [
    { val: String(stats?.tasks ?? 0), label: t("home.tasksToday") },
    { val: String(stats?.pomodoros ?? 0), label: t("home.pomodoros") },
    {
      val: `${stats?.habitsDone ?? 0}/${stats?.habitsTotal ?? 0}`,
      label: t("home.habitsDone"),
      accent: true,
    },
    {
      val: String(stats?.deadlines ?? 0),
      label: t(stats?.deadlines === 1 ? "home.deadlineToday" : "home.deadlinesToday"),
    },
  ];

  return (
    <>
      <PageHeader appearance={appearance} hero>
        <h1 className="page-title">{t("nav.home")}</h1>
      </PageHeader>
      <main className="dash-main">
      {/* Pet preview */}
      <div
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "0.5px solid rgba(255,255,255,0.07)",
          borderRadius: 12,
          padding: "16px 18px",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        {/* Pet blob */}
        <div
          style={{
            width: 52,
            height: 52,
            background: "#1a1030",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <svg width="34" height="34" viewBox="0 0 32 32">
            <ellipse cx="16" cy="20" rx="9" ry="8" fill="#1a1030" />
            <ellipse cx="16" cy="16" rx="7" ry="7" fill="#2a1a4a" />
            <circle cx="12.5" cy="15" r="2.5" fill="#00e5a0" />
            <circle cx="19.5" cy="15" r="2.5" fill="#00e5a0" />
            <circle cx="13" cy="15" r="1.2" fill="#080a0d" />
            <circle cx="20" cy="15" r="1.2" fill="#080a0d" />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "rgba(255,255,255,0.8)",
              marginBottom: 2,
            }}
          >
            {t("home.petState")}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            {t("home.paused")}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>{t("home.pausedTag")}</div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {tiles.map((s, i) => (
          <div key={i} style={statCard}>
            <div
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: s.accent ? "#00e5a0" : "rgba(255,255,255,0.85)",
                marginBottom: 3,
              }}
            >
              {s.val}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Upcoming */}
      <div>
        <div style={sectionLabel}>{t("home.upcoming")}</div>
        <div style={card}>
          {upcoming.length === 0 && (
            <div style={emptyText}>{t("home.nothing")}</div>
          )}
          {upcoming.map((item, i, arr) => {
            const due = formatDue(item.due_date);
            return (
              <div
                key={`${item.source}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  ...rowBorder(i === arr.length - 1),
                }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: due.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", flex: 1 }}>
                  {item.title}
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>
                  {due.text}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      </main>
    </>
  );
}
