import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getSettings } from "../../lib/db";
import { setSetting } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { card, emptyText, sectionLabel } from "../../styles/shared";
import { NAV_ITEMS } from "../nav";
import { EditableValue, SettingRow, Toggle } from "../widgets/SettingControls";

export const TEXT_SETTINGS = [
  { key: "user_name", label: "set.userName" },
  { key: "user_location", label: "set.location" },
  { key: "ollama_model", label: "set.model" },
  { key: "user_timezone", label: "set.timezone" },
] as const;

// Daily briefing (toggle + time) is hidden until it is wired in Phase 2, which
// seeds its settings in a new migration.
export const FEATURE_SETTINGS = [
  { key: "body_checkin_enabled", label: "set.checkin" },
  { key: "dnd_during_pomodoro", label: "set.dnd" },
  { key: "friction_starter_enabled", label: "set.friction" },
  { key: "autostart", label: "set.autostart" },
] as const;

export const TIME_SETTINGS = [
  { key: "recap_time", label: "set.recapTime", fallback: "22:00" },
] as const;

export const CHOICE_SETTINGS = [
  {
    key: "pomodoro_duration",
    label: "set.pomDuration",
    fallback: "25",
    options: ["15", "20", "25", "30", "45", "60"],
  },
  {
    key: "pomodoro_break",
    label: "set.breakDuration",
    fallback: "5",
    options: ["5", "10", "15", "20"],
  },
  {
    key: "body_checkin_interval",
    label: "set.checkinEvery",
    fallback: "180",
    options: ["60", "120", "180", "240", "360"],
  },
] as const;

export const ALL_SETTING_KEYS = [
  "language",
  ...TEXT_SETTINGS.map((s) => s.key),
  ...FEATURE_SETTINGS.map((s) => s.key),
  ...TIME_SETTINGS.map((s) => s.key),
  ...CHOICE_SETTINGS.map((s) => s.key),
];

export default function PageSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getSettings(ALL_SETTING_KEYS)
      .then((v) => {
        setValues(v);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Write through to SQLite, then mirror locally so the control stays in sync
  // even if the row did not exist yet.
  // Every write is announced, so the pet window (and the i18n cache in both
  // windows) pick it up without a restart.
  const save = async (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    try {
      await setSetting(key, value);
      await emit("settings:changed", { key });
    } catch (err) {
      console.error(err);
    }
  };

  if (!loaded) return <div style={emptyText}>{t("common.loading")}</div>;

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("set.general")}</div>
        <div style={card}>
          <SettingRow label={t("set.language")} last={false}>
            <select
              value={values.language ?? "en"}
              onChange={(e) => void save("language", e.target.value)}
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "0.5px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "rgba(255,255,255,0.7)",
                fontSize: 12,
                padding: "3px 6px",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </select>
          </SettingRow>

          {TEXT_SETTINGS.map((s, i) => (
            <SettingRow key={s.key} label={t(s.label)} last={i === TEXT_SETTINGS.length - 1}>
              <EditableValue
                value={values[s.key] ?? ""}
                onSave={(v) => void save(s.key, v)}
              />
            </SettingRow>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t("set.features")}</div>
        <div style={card}>
          {FEATURE_SETTINGS.map((s, i) => (
            <SettingRow
              key={s.key}
              label={t(s.label)}
              last={i === FEATURE_SETTINGS.length - 1}
            >
              <Toggle
                on={values[s.key] === "true"}
                onChange={(on) => void save(s.key, String(on))}
              />
            </SettingRow>
          ))}
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t("set.timing")}</div>
        <div style={card}>
          {TIME_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} last={false}>
              <input
                type="time"
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: "0.5px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  padding: "3px 6px",
                  outline: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  colorScheme: "dark",
                }}
              />
            </SettingRow>
          ))}

          {CHOICE_SETTINGS.map((s, i) => (
            <SettingRow
              key={s.key}
              label={t(s.label)}
              last={i === CHOICE_SETTINGS.length - 1}
            >
              <select
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
                style={{
                  background: "#0d0f14",
                  border: "0.5px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  color: "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  padding: "3px 6px",
                  outline: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {/* A value set elsewhere (or seeded) may not be in the list. */}
                {(s.options as readonly string[]).includes(values[s.key] || s.fallback)
                  ? null
                  : (
                      <option value={values[s.key]}>{t("set.minutes", { n: values[s.key] })}</option>
                    )}
                {s.options.map((v) => (
                  <option key={v} value={v}>
                    {t("set.minutes", { n: v })}
                  </option>
                ))}
              </select>
            </SettingRow>
          ))}
        </div>
      </div>

      <div style={{ ...emptyText, paddingTop: 0 }}>
        {t("set.shortcuts", { n: NAV_ITEMS.length })}
      </div>
    </>
  );
}
