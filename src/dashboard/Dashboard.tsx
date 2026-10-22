import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSetting } from "../lib/db-helpers";
import { locale, t, useLanguage } from "../lib/i18n";
import { useAppearance } from "../lib/theme";
import { NAV_ITEMS, type Page } from "./nav";
import PageHome from "./pages/Home";
import PageHabits from "./pages/Habits";
import PagePomodoro from "./pages/Focus";
import PageTodos from "./pages/Todos";
import PageRecap from "./pages/Recap";
import PageIntegrations from "./pages/Integrations";
import PageSettings from "./pages/Settings";

export function Dashboard() {
  const [page, setPage] = useState<Page>("home");
  const [userName, setUserName] = useState("");
  useLanguage(); // re-render every string when the language setting changes
  useAppearance();

  const handleClose = () => {
    invoke("close_dashboard").catch(console.error);
  };

  useEffect(() => {
    getSetting("user_name")
      .then((n) => setUserName(n ?? "Bas"))
      .catch(console.error);
  }, []);

  // Escape closes the window; 1-7 jump to a page. Both are ignored while a
  // field has focus, so typing a habit called "2 km run" still works and
  // Escape cancels the edit instead of closing the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        invoke("close_dashboard").catch(console.error);
        return;
      }
      const index = Number(e.key);
      if (Number.isInteger(index) && index >= 1 && index <= NAV_ITEMS.length) {
        setPage(NAV_ITEMS[index - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        background: "#0d0f14",
        display: "flex",
        flexDirection: "column",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
    >
      <TitleBar onClose={handleClose} userName={userName} />
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Sidebar page={page} onNavigate={setPage} />
        <Main page={page} />
      </div>
    </div>
  );
}

/** Round icon button used in the titlebar (minimize / close). */
function TitleBarButton({
  onClick,
  title,
  base,
  hover,
  color,
  children,
}: {
  onClick: () => void;
  title: string;
  base: string;
  hover: string;
  color: string;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        lineHeight: 1,
        cursor: "pointer",
        background: hovered ? hover : base,
        color,
      }}
    >
      {children}
    </button>
  );
}

function TitleBar({
  onClose,
  userName,
}: {
  onClose: () => void;
  userName: string;
}) {
  // `data-tauri-drag-region` makes this area drag the window (uses the same
  // start-dragging permission as the pet). Buttons have no such attribute, so
  // they stay clickable.
  return (
    <div
      data-tauri-drag-region=""
      style={{
        height: 38,
        background: "#080a0d",
        borderBottom: "0.5px solid rgba(255,255,255,0.06)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 14px",
        flexShrink: 0,
      }}
    >
      <span
        data-tauri-drag-region=""
        style={{ fontSize: 13, color: "rgba(255,255,255,0.3)" }}
      >
        {userName ? `Nox · ${userName}` : "Nox"}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <TitleBarButton
          onClick={() => getCurrentWindow().minimize().catch(console.error)}
          title={t("dash.minimize")}
          base="rgba(255,255,255,0.08)"
          hover="rgba(255,255,255,0.16)"
          color="rgba(255,255,255,0.5)"
        >
          –
        </TitleBarButton>
        <TitleBarButton
          onClick={onClose}
          title={t("dash.close")}
          base="rgba(239,68,68,0.15)"
          hover="rgba(239,68,68,0.3)"
          color="rgba(239,68,68,0.85)"
        >
          ×
        </TitleBarButton>
      </div>
    </div>
  );
}

function Sidebar({
  page,
  onNavigate,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
}) {
  const [tooltip, setTooltip] = useState<{ label: string; top: number } | null>(null);

  return (
    <div
      style={{
        width: 60,
        background: "#080a0d",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "16px 0",
        gap: 4,
        borderRight: "0.5px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
        position: "relative",
      }}
    >
      {/* Logo */}
      <div
        style={{
          width: 30,
          height: 30,
          background: "#00e5a0",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 12,
          color: "#080a0d",
          fontWeight: 700,
          fontSize: 16,
        }}
      >
        N
      </div>

      {NAV_ITEMS.map((item, i) => {
        const active = page === item.id;
        return (
          <div key={item.id} style={{ position: "relative" }}>
            {/* Accent bar marks the active page without squaring off the button. */}
            <div
              style={{
                position: "absolute",
                left: -9,
                top: "50%",
                transform: "translateY(-50%)",
                width: 2,
                height: 20,
                borderRadius: 1,
                background: active ? "#00e5a0" : "transparent",
              }}
            />
            <button
              onClick={() => onNavigate(item.id)}
              title={`${t(item.label)} (${i + 1})`}
              onMouseEnter={(e) =>
                setTooltip({
                  label: `${t(item.label)} · ${i + 1}`,
                  top: e.currentTarget.getBoundingClientRect().top + 21,
                })
              }
              onMouseLeave={() => setTooltip(null)}
              style={{
                width: 42,
                height: 42,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: active ? "rgba(255,255,255,0.07)" : "transparent",
                border: "none",
                color: active ? "#00e5a0" : "rgba(255,255,255,0.3)",
                fontSize: 18,
                cursor: "pointer",
              }}
            >
              <i className={`ti ${item.icon}`} aria-hidden="true" />
            </button>
          </div>
        );
      })}

      <div style={{ flex: 1 }} />

      {tooltip && (
        <div
          style={{
            position: "fixed",
            left: 66,
            top: tooltip.top,
            transform: "translateY(-50%)",
            background: "rgba(0,0,0,0.85)",
            border: "0.5px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.85)",
            padding: "3px 8px",
            borderRadius: 6,
            fontSize: 11,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          {tooltip.label}
        </div>
      )}
    </div>
  );
}

function Main({ page }: { page: Page }) {
  const title = t(`nav.${page}`);
  const sub =
    page === "home"
      ? new Date().toLocaleDateString(locale(), {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
      : t(`sub.${page}`);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "20px 24px 14px",
          borderBottom: "0.5px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,0.85)" }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>
            {sub}
          </div>
        </div>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#00e5a0" }} />
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {page === "home" && <PageHome />}
        {page === "habits" && <PageHabits />}
        {page === "pomodoro" && <PagePomodoro />}
        {page === "todos" && <PageTodos />}
        {page === "recap" && <PageRecap />}
        {page === "integrations" && <PageIntegrations />}
        {page === "settings" && <PageSettings />}
      </div>
    </div>
  );
}
