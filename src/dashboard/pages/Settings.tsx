import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getSettings } from "../../lib/db";
import { setSetting } from "../../lib/db-helpers";
import { t } from "../../lib/i18n";
import { BOLT_PRESETS } from "../../lib/theme";
import { useReducedMotion } from "../../components/deco/NightSky";
import { Card, Toggle } from "../../components/ui/controls";
import { NAV_ITEMS } from "../nav";
import { SettingRow, TextSetting } from "../widgets/SettingControls";
import { PlacesManager } from "../widgets/Places";
import { ListsManager } from "../widgets/ListsManager";

const TEXT_SETTINGS = [
  { key: "user_name", label: "set.userName" },
  { key: "user_location", label: "set.location" },
  { key: "ollama_model", label: "set.model" },
  { key: "user_timezone", label: "set.timezone" },
] as const;

// The morning briefing and deadline nudges are set on the Integrations page,
// next to the services they read from.
const FEATURE_SETTINGS = [
  { key: "body_checkin_enabled", label: "set.checkin" },
  { key: "dnd_during_pomodoro", label: "set.dnd" },
  { key: "friction_starter_enabled", label: "set.friction" },
  { key: "autostart", label: "set.autostart" },
  { key: "ai_capture_enabled", label: "set.capture", hint: "set.captureHint" },
] as const;

const TIME_SETTINGS = [
  { key: "recap_time", label: "set.recapTime", fallback: "22:00" },
] as const;

const CHOICE_SETTINGS = [
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

const ALL_SETTING_KEYS = [
  "language",
  "ui_bolt_color",
  "ui_animations",
  "ui_lightning",
  ...TEXT_SETTINGS.map((s) => s.key),
  ...FEATURE_SETTINGS.map((s) => s.key),
  ...TIME_SETTINGS.map((s) => s.key),
  ...CHOICE_SETTINGS.map((s) => s.key),
];

export default function PageSettings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    getSettings(ALL_SETTING_KEYS)
      .then((v) => {
        setValues(v);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Write through to SQLite, then mirror locally so the control stays in sync
  // even if the row did not exist yet. Every write is announced, so the pet
  // window (and the i18n and theme caches in both windows) pick it up
  // without a restart.
  const save = async (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    try {
      await setSetting(key, value);
      await emit("settings:changed", { key });
    } catch (err) {
      console.error(err);
    }
  };

  if (!loaded) return <p className="empty-line">{t("common.loading")}</p>;

  const animations = values.ui_animations !== "false";
  const bolt = values.ui_bolt_color ?? "electric";

  return (
    <>
      <Card title={t("set.general")}>
        <div className="settings">
          <SettingRow label={t("set.language")} htmlFor="set-language">
            <select
              id="set-language"
              className="field field--select"
              value={values.language ?? "en"}
              onChange={(e) => void save("language", e.target.value)}
            >
              <option value="en">English</option>
              <option value="id">Bahasa Indonesia</option>
            </select>
          </SettingRow>
          {TEXT_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} htmlFor={`set-${s.key}`}>
              <TextSetting id={`set-${s.key}`} value={values[s.key] ?? ""} onSave={(v) => void save(s.key, v)} />
            </SettingRow>
          ))}
        </div>
      </Card>

      <Card title={t("set.features")}>
        <div className="settings">
          {FEATURE_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} hint={"hint" in s ? t(s.hint) : undefined}>
              <Toggle
                label={t(s.label)}
                on={values[s.key] === "true"}
                onChange={(on) => void save(s.key, String(on))}
              />
            </SettingRow>
          ))}
          {TIME_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} htmlFor={`set-${s.key}`}>
              <input
                id={`set-${s.key}`}
                type="time"
                className="field field--short"
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
              />
            </SettingRow>
          ))}
          {CHOICE_SETTINGS.map((s) => (
            <SettingRow key={s.key} label={t(s.label)} htmlFor={`set-${s.key}`}>
              <select
                id={`set-${s.key}`}
                className="field field--select field--short"
                value={values[s.key] || s.fallback}
                onChange={(e) => void save(s.key, e.target.value)}
              >
                {/* A value set elsewhere (or seeded) may not be in the list. */}
                {(s.options as readonly string[]).includes(values[s.key] || s.fallback) ? null : (
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
      </Card>

      <Card title={t("lists.title")}>
        <ListsManager />
      </Card>

      <Card title={t("set.places")}>
        <p className="muted">{t("set.places.hint")}</p>
        <PlacesManager />
      </Card>

      <Card title={t("set.appearance")}>
        <div className="settings">
          <SettingRow label={t("set.bolt")} hint={t("set.boltHint")}>
            <div className="swatches" role="radiogroup" aria-label={t("set.bolt")}>
              {BOLT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={bolt === p.id}
                  className={`swatch${bolt === p.id ? " swatch--on" : ""}`}
                  onClick={() => void save("ui_bolt_color", p.id)}
                >
                  <span className={`swatch__dot swatch__dot--${p.id}`} aria-hidden="true">
                    {bolt === p.id && <i className="ti ti-check" />}
                  </span>
                  {t(p.label)}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow
            label={t("set.animations")}
            hint={reducedMotion ? t("set.reducedMotion") : t("set.animationsHint")}
          >
            <Toggle
              label={t("set.animations")}
              on={animations}
              onChange={(on) => void save("ui_animations", String(on))}
            />
          </SettingRow>
          <SettingRow label={t("set.lightning")} hint={animations ? undefined : t("set.lightningOff")}>
            <Toggle
              label={t("set.lightning")}
              on={animations && values.ui_lightning !== "false"}
              disabled={!animations}
              onChange={(on) => void save("ui_lightning", String(on))}
            />
          </SettingRow>
        </div>
      </Card>

      <p className="muted page-end">{t("set.shortcuts", { n: NAV_ITEMS.length })}</p>
    </>
  );
}
