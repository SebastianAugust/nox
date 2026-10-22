import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, useLanguage } from "../lib/i18n";
import { useAppearance } from "../lib/theme";
import { SlitEyes } from "../components/deco/Deco";
import { NAV_ITEMS, type Page } from "./nav";
import PageHeader from "./PageHeader";
import PageHome from "./pages/Home";
import PageHabits from "./pages/Habits";
import PagePomodoro from "./pages/Focus";
import PageTodos from "./pages/Todos";
import PageRecap from "./pages/Recap";
import PageIntegrations from "./pages/Integrations";
import PageSettings from "./pages/Settings";

export function Dashboard() {
  const [page, setPage] = useState<Page>("home");
  const [scrolled, setScrolled] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  useLanguage(); // re-render every string when the language setting changes
  const appearance = useAppearance();

  // A new page starts at the top, under a see-through bar.
  useEffect(() => setScrolled(false), [page]);

  // The bar floats over the page, so headers pad by its real height (it
  // grows when the nav wraps onto a second row).
  useEffect(() => {
    const shell = shellRef.current;
    const bar = shell?.querySelector<HTMLElement>(".topbar");
    if (!shell || !bar) return;
    const observer = new ResizeObserver(() => shell.style.setProperty("--topbar-h", `${bar.offsetHeight}px`));
    observer.observe(bar);
    return () => observer.disconnect();
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
    <div className="dash" ref={shellRef}>
      <TopBar page={page} onNavigate={setPage} solid={scrolled} />
      <div
        key={page}
        className="dash__scroll"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
      >
        {page === "home" ? (
          <PageHome appearance={appearance} />
        ) : (
          <>
            <PageHeader appearance={appearance}>
              <h1 className="page-title">{t(`nav.${page}`)}</h1>
              <p className="page-sub">{t(`sub.${page}`)}</p>
            </PageHeader>
            <main className="dash-main">
              {page === "habits" && <PageHabits />}
              {page === "pomodoro" && <PagePomodoro />}
              {page === "todos" && <PageTodos />}
              {page === "recap" && <PageRecap />}
              {page === "integrations" && <PageIntegrations />}
              {page === "settings" && <PageSettings />}
            </main>
          </>
        )}
      </div>
    </div>
  );
}

function TopBar({
  page,
  onNavigate,
  solid,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  solid: boolean;
}) {
  // `data-tauri-drag-region` makes the bar drag the window. Only the bar and
  // the logo carry it, so every button stays clickable.
  return (
    <div data-tauri-drag-region="" className={`topbar${solid ? " topbar--solid" : ""}`}>
      <div data-tauri-drag-region="" className="topbar__logo">
        <SlitEyes />
        <span data-tauri-drag-region="" className="topbar__name">
          nox
        </span>
      </div>

      <nav aria-label={t("dash.nav")} className="topbar__nav">
        <div className="nav-pills">
          {NAV_ITEMS.map((item, i) => {
            const active = page === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
                title={`${t(item.label)} (${i + 1})`}
                className={`pill${active ? " pill--selected" : ""}`}
              >
                {t(item.label)}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="topbar__actions">
        <button
          type="button"
          onClick={() => getCurrentWindow().minimize().catch(console.error)}
          aria-label={t("dash.minimize")}
          title={t("dash.minimize")}
          className="round-btn"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6h8" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => invoke("close_dashboard").catch(console.error)}
          aria-label={t("dash.close")}
          title={`${t("dash.close")} (Esc)`}
          className="round-btn round-btn--close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
