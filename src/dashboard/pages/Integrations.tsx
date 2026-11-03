import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getSettings } from "../../lib/db";
import { getAssignmentCounts, setSetting } from "../../lib/db-helpers";
import { apiErrorText, secretExists } from "../../lib/api";
import { locale, t, type I18nKey } from "../../lib/i18n";
import { extractNotionId, type Field } from "../../lib/notionMapping";
import { MAP_KEYS, parseSyncError, type SyncError } from "../../lib/notionSync";
import { getWeather, weatherLine, type WeatherState } from "../../lib/weather";
import { PlaceSelect } from "../widgets/Places";
import { ChunkyButton, Tag, Toggle, type TagTone } from "../../components/ui/controls";
import { SettingRow, TextSetting } from "../widgets/SettingControls";
import { SecretField } from "../widgets/SecretField";

const PAIR_MINUTES = 10;

/** Settings for one card: values, a write-through save, and a reload. */
function useSettingValues(keys: string[], events: string[] = []) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  // The key and event lists are constant per card, so these run once.
  const reload = useCallback(() => {
    getSettings(keys).then(setValues).catch(console.error);
  }, []);
  useEffect(() => {
    reload();
    const unlisteners = ["settings:changed", ...events].map((e) => listen(e, reload));
    return () => {
      for (const u of unlisteners) u.then((off) => off()).catch(console.error);
    };
  }, [reload]);
  const save = async (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    try {
      await setSetting(key, value);
      await emit("settings:changed", { key });
    } catch (err) {
      console.error(err);
    }
  };
  return { values, save, reload };
}

function useSecretSaved(name: "notion_token" | "telegram_bot_token") {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const check = () => secretExists(name).then(setSaved).catch(() => setSaved(false));
    check();
    const unlisten = listen("secrets:changed", check);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [name]);
  return saved;
}

/** A UTC "YYYY-MM-DD HH:MM:SS" stamp in local words. */
function localTime(stamp: string): string {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return d.toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ServiceCard({
  icon,
  name,
  status,
  about,
  children,
}: {
  icon: string;
  name: string;
  status: { tone: TagTone; label: I18nKey };
  about: I18nKey;
  children?: ReactNode;
}) {
  return (
    <article className="card service" aria-label={`${name}: ${t(status.label)}`}>
      <div className="service__head">
        <span className="service__icon" aria-hidden="true">
          <i className={`ti ${icon}`} />
        </span>
        <h2 className="card__title card__title--sm service__name">{name}</h2>
        <Tag tone={status.tone}>{t(status.label)}</Tag>
      </div>
      <p className="muted">{t(about)}</p>
      {children && <div className="settings">{children}</div>}
    </article>
  );
}

// ── Notion ──

const FIELD_LABEL: Record<Field, I18nKey> = {
  title: "int.notion.map.title",
  due: "int.notion.map.due",
  course: "int.notion.map.course",
  status: "int.notion.map.status",
  done: "int.notion.map.done",
};

function syncErrorText(e: SyncError): string[] {
  if (e.kind === "notConfigured") return [];
  if (e.kind === "api") {
    return [`${t(`int.notion.which.${e.which}`)}: ${apiErrorText(e.error, "notion")}`];
  }
  return e.problems.map((p) =>
    t(`int.notion.err.${p.reason}`, {
      name: p.name ?? "",
      field: t(FIELD_LABEL[p.field]),
      expected: p.expected.join(" / "),
      available: p.available.join(", "),
    }),
  );
}

function NotionCard() {
  const keys = ["notion_assignments_db_id", "notion_courses_db_id", "notion_last_sync_at", "notion_last_error", ...Object.values(MAP_KEYS)];
  const { values, save } = useSettingValues(keys, ["notion:status"]);
  const tokenSaved = useSecretSaved("notion_token");
  const [counts, setCounts] = useState({ assignments: 0, courses: 0 });
  const [syncing, setSyncing] = useState(false);
  const [badId, setBadId] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      setSyncing(false);
      getAssignmentCounts().then(setCounts).catch(console.error);
    };
    refresh();
    const unlisten = listen("notion:status", refresh);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, []);

  // The pet window runs the sync and answers with "notion:status".
  const syncNow = () => {
    setSyncing(true);
    emit("notion:sync").catch(console.error);
    window.setTimeout(() => setSyncing(false), 90_000);
  };

  const saveDbId = (key: string, raw: string) => {
    if (!raw) {
      setBadId(null);
      return void save(key, "");
    }
    const id = extractNotionId(raw);
    if (!id) return setBadId(key);
    setBadId(null);
    void save(key, id).then(() => tokenSaved && syncNow());
  };

  if (!values) return null;
  const error = parseSyncError(values.notion_last_error);
  const problems = error ? syncErrorText(error) : [];
  const configured = tokenSaved && !!values.notion_assignments_db_id;
  const status =
    configured && problems.length > 0
      ? { tone: "warn" as const, label: "int.attention" as const }
      : configured && values.notion_last_sync_at
        ? { tone: "done" as const, label: "int.connected" as const }
        : { tone: "neutral" as const, label: "int.notConnected" as const };

  return (
    <ServiceCard icon="ti-notebook" name="Notion" status={status} about="int.notion">
      <SettingRow label={t("int.notion.token")} hint={t("int.notion.tokenHint")} htmlFor="int-notion-token">
        <SecretField id="int-notion-token" name="notion_token" />
      </SettingRow>
      {(["notion_assignments_db_id", "notion_courses_db_id"] as const).map((key) => (
        <SettingRow
          key={key}
          label={t(key === "notion_assignments_db_id" ? "int.notion.assignments" : "int.notion.courses")}
          hint={t(key === "notion_assignments_db_id" ? "int.notion.dbHint" : "int.notion.coursesHint")}
          htmlFor={`int-${key}`}
        >
          <div className="stack-end">
            <TextSetting
              id={`int-${key}`}
              value={values[key] ?? ""}
              allowEmpty
              describedBy={badId === key ? `int-${key}-err` : undefined}
              onSave={(v) => saveDbId(key, v)}
            />
            {badId === key && (
              <p id={`int-${key}-err`} className="field-error" role="alert">
                {t("int.notion.badId")}
              </p>
            )}
          </div>
        </SettingRow>
      ))}

      <details className="mapping">
        <summary className="mapping__summary">{t("int.notion.mapping")}</summary>
        <p className="muted">{t("int.notion.mappingHint")}</p>
        {(Object.keys(MAP_KEYS) as Field[]).map((field) => (
          <SettingRow key={field} label={t(FIELD_LABEL[field])} htmlFor={`int-map-${field}`}>
            <TextSetting
              id={`int-map-${field}`}
              value={values[MAP_KEYS[field]] ?? ""}
              allowEmpty
              placeholder={t("int.notion.auto")}
              onSave={(v) => void save(MAP_KEYS[field], v)}
            />
          </SettingRow>
        ))}
      </details>

      <div className="sync-row">
        <div className="sync-row__text">
          <span>
            {values.notion_last_sync_at
              ? t("int.notion.lastSync", { time: localTime(values.notion_last_sync_at) })
              : t("int.notion.never")}
          </span>
          <span className="muted">{t("int.notion.counts", { a: counts.assignments, c: counts.courses })}</span>
          {problems.map((p) => (
            <p key={p} className="field-error" role="alert">
              {p}
            </p>
          ))}
        </div>
        <ChunkyButton size="sm" disabled={!configured || syncing} onClick={syncNow}>
          {t(syncing ? "int.notion.syncing" : "int.notion.sync")}
        </ChunkyButton>
      </div>
    </ServiceCard>
  );
}

// ── Weather ──

function WeatherCard() {
  const [weather, setWeather] = useState<WeatherState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback((force = false) => {
    setBusy(true);
    getWeather({ force })
      .then(setWeather)
      .catch(console.error)
      .finally(() => setBusy(false));
  }, []);
  // Fetch again when the active place changes (any window, /lokasi, a pin).
  useEffect(() => {
    refresh();
    const unlisten = listen("settings:changed", () => refresh());
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [refresh]);

  const status = weather
    ? weather.stale
      ? { tone: "warn" as const, label: "int.attention" as const }
      : { tone: "done" as const, label: "int.connected" as const }
    : { tone: "neutral" as const, label: "int.notConnected" as const };

  return (
    <ServiceCard icon="ti-cloud-rain" name="Open-Meteo" status={status} about="int.weather">
      <SettingRow label={t("int.weather.active")} hint={t("int.weather.activeHint")} htmlFor="int-weather-place">
        <PlaceSelect id="int-weather-place" />
      </SettingRow>
      <div className="sync-row">
        <div className="sync-row__text">
          <span>{weather ? weatherLine(weather) : t("int.weather.none")}</span>
          {weather && (
            <span className="muted">
              {t("int.weather.asOf", {
                time: new Date(weather.fetchedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }),
              })}
            </span>
          )}
        </div>
        <ChunkyButton size="sm" variant="secondary" disabled={busy} onClick={() => refresh(true)}>
          {t("int.weather.refresh")}
        </ChunkyButton>
      </div>
    </ServiceCard>
  );
}

// ── Telegram ──

const PUSH_TOGGLES = [
  { key: "telegram_push_reminders", label: "int.tg.pushReminders" },
  { key: "telegram_push_briefing", label: "int.tg.pushBriefing" },
  { key: "telegram_push_nudges", label: "int.tg.pushNudges" },
] as const;

function TelegramCard() {
  const { values, save } = useSettingValues(
    ["telegram_chat_id", "telegram_status", ...PUSH_TOGGLES.map((p) => p.key)],
    ["telegram:status", "telegram:paired"],
  );
  const tokenSaved = useSecretSaved("telegram_bot_token");
  const [code, setCode] = useState<{ code: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const paired = !!values?.telegram_chat_id;
  useEffect(() => {
    if (paired) setCode(null);
  }, [paired]);

  if (!values) return null;
  const invalid = tokenSaved && values.telegram_status === "invalid";
  const offline = tokenSaved && values.telegram_status === "offline";
  const status = invalid
    ? { tone: "overdue" as const, label: "int.tg.invalid" as const }
    : tokenSaved && paired
      ? { tone: "done" as const, label: "int.connected" as const }
      : { tone: "neutral" as const, label: "int.notConnected" as const };

  const pair = async () => {
    try {
      const c = await invoke<string>("telegram_pairing_start");
      setCode({ code: c, until: Date.now() + PAIR_MINUTES * 60_000 });
      setNow(Date.now());
    } catch (err) {
      console.error(err);
    }
  };
  const minutesLeft = code ? Math.ceil((code.until - now) / 60_000) : 0;

  return (
    <ServiceCard icon="ti-send" name="Telegram" status={status} about="int.telegram">
      <SettingRow label={t("int.tg.token")} hint={t("int.tg.tokenHint")} htmlFor="int-tg-token">
        <SecretField id="int-tg-token" name="telegram_bot_token" />
      </SettingRow>
      {offline && <p className="muted">{t("int.tg.offline")}</p>}
      <SettingRow
        label={t("int.tg.pairing")}
        hint={
          code
            ? minutesLeft > 0
              ? t("int.tg.pairHow", { code: code.code, min: minutesLeft })
              : t("int.tg.pairExpired")
            : undefined
        }
      >
        <div className="secret__row">
          <Tag tone={paired ? "done" : "neutral"}>{t(paired ? "int.tg.paired" : "int.tg.notPaired")}</Tag>
          {code && minutesLeft > 0 && (
            <span className="pair-code" aria-label={code.code}>
              {code.code}
            </span>
          )}
          {paired ? (
            <ChunkyButton size="sm" variant="secondary" onClick={() => void save("telegram_chat_id", "")}>
              {t("int.tg.unpair")}
            </ChunkyButton>
          ) : (
            <ChunkyButton size="sm" disabled={!tokenSaved || invalid} onClick={() => void pair()}>
              {t("int.tg.pair")}
            </ChunkyButton>
          )}
        </div>
      </SettingRow>
      {PUSH_TOGGLES.map((p) => (
        <SettingRow key={p.key} label={t(p.label)}>
          <Toggle label={t(p.label)} on={values[p.key] !== "false"} onChange={(on) => void save(p.key, String(on))} />
        </SettingRow>
      ))}
    </ServiceCard>
  );
}

// ── Briefing and nudges ──

function BriefingCard() {
  const { values, save } = useSettingValues(["briefing_enabled", "briefing_time", "nudges_enabled"]);
  if (!values) return null;
  const on = values.briefing_enabled !== "false";
  return (
    <ServiceCard
      icon="ti-sunrise"
      name={t("int.brief.title")}
      status={on ? { tone: "done", label: "int.connected" } : { tone: "neutral", label: "int.notConnected" }}
      about="int.brief.hint"
    >
      <SettingRow label={t("int.brief.enabled")}>
        <Toggle label={t("int.brief.enabled")} on={on} onChange={(v) => void save("briefing_enabled", String(v))} />
      </SettingRow>
      <SettingRow label={t("int.brief.time")} htmlFor="int-brief-time">
        <input
          id="int-brief-time"
          type="time"
          className="field field--short"
          value={values.briefing_time || "07:30"}
          onChange={(e) => e.target.value && void save("briefing_time", e.target.value)}
        />
      </SettingRow>
      <SettingRow label={t("int.nudges")} hint={t("int.nudges.hint")}>
        <Toggle
          label={t("int.nudges")}
          on={values.nudges_enabled !== "false"}
          onChange={(v) => void save("nudges_enabled", String(v))}
        />
      </SettingRow>
    </ServiceCard>
  );
}

// ── Not built yet ──

const PLANNED: { name: string; icon: string; about: I18nKey }[] = [
  { name: "Google Calendar", icon: "ti-calendar-event", about: "int.calendar" },
  { name: "Spotify", icon: "ti-music", about: "int.music" },
];

export default function PageIntegrations() {
  return (
    <>
      <p className="muted page-lead">{t("int.lead")}</p>
      <div className="int-stack">
        <NotionCard />
        <BriefingCard />
        <TelegramCard />
        <WeatherCard />
      </div>
      <div className="service-grid">
        {PLANNED.map((s) => (
          <ServiceCard
            key={s.name}
            icon={s.icon}
            name={s.name}
            status={{ tone: "neutral", label: "int.planned" }}
            about={s.about}
          />
        ))}
      </div>
    </>
  );
}
