import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSettings } from "./db";

/**
 * Appearance settings, applied to both windows. The lightning blue is the one
 * user-selectable color: it lands on :root as --bolt / --bolt-glow, and every
 * blue thing in the UI reads those two variables. Re-applied whenever the
 * dashboard broadcasts "settings:changed".
 */

// The colors themselves live in tokens.css as --bolt-<id>.
export const BOLT_PRESETS = [
  { id: "electric", label: "set.bolt.electric" },
  { id: "cyan", label: "set.bolt.cyan" },
  { id: "cobalt", label: "set.bolt.cobalt" },
  { id: "ice", label: "set.bolt.ice" },
] as const;

export type BoltId = (typeof BOLT_PRESETS)[number]["id"];

export type Appearance = { bolt: BoltId; animations: boolean; lightning: boolean };

const DEFAULTS: Appearance = { bolt: "electric", animations: true, lightning: true };

let current: Appearance = DEFAULTS;
const listeners = new Set<(a: Appearance) => void>();

function apply(a: Appearance) {
  const root = document.documentElement;
  // Set on <html>, the same element as :root, so --bolt-glow and the other
  // tokens derived from --bolt recompute with it.
  root.style.setProperty("--bolt", `var(--bolt-${a.bolt})`);
  root.dataset.animations = a.animations ? "on" : "off";
}

async function load(): Promise<void> {
  const v = await getSettings(["ui_bolt_color", "ui_animations", "ui_lightning"]);
  const bolt = BOLT_PRESETS.some((p) => p.id === v.ui_bolt_color)
    ? (v.ui_bolt_color as BoltId)
    : DEFAULTS.bolt;
  current = {
    bolt,
    // Missing rows (before the migration ran) mean "on".
    animations: v.ui_animations !== "false",
    lightning: v.ui_lightning !== "false",
  };
  apply(current);
  listeners.forEach((fn) => fn(current));
}

/**
 * Follow the appearance settings. Use once at each window's root; children
 * that need the flags (the night sky) read them from the returned value.
 */
export function useAppearance(): Appearance {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    load().catch(console.error);
    const unlisten = listen("settings:changed", () => {
      load().catch(console.error);
    });
    return () => {
      listeners.delete(setValue);
      unlisten.then((off) => off()).catch(console.error);
    };
  }, []);
  return value;
}
