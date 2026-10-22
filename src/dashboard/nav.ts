import type { I18nKey } from "../lib/i18n";

export type Page =
  | "home"
  | "habits"
  | "pomodoro"
  | "todos"
  | "recap"
  | "integrations"
  | "settings";

// Single source of truth for the sidebar: its order is also what the 1-7
// number-key shortcuts select, so the two can never drift apart.
export const NAV_ITEMS = [
  { id: "home", icon: "ti-home", label: "nav.home" },
  { id: "habits", icon: "ti-checklist", label: "nav.habits" },
  { id: "pomodoro", icon: "ti-clock", label: "nav.pomodoro" },
  { id: "todos", icon: "ti-list-check", label: "nav.todos" },
  { id: "recap", icon: "ti-history", label: "nav.recap" },
  { id: "integrations", icon: "ti-plug", label: "nav.integrations" },
  { id: "settings", icon: "ti-settings", label: "nav.settings" },
] as const satisfies readonly { id: Page; icon: string; label: I18nKey }[];
