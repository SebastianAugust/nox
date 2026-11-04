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
import { flushOutbox, outboxStatus, retryOutbox, type OutboxRow } from "../../lib/notionOutbox";
import { addFeed, getFeeds, MAX_FEEDS, removeFeed, setFeedEnabled, type CalendarFeed } from "../../lib/calendar";
import {
  connectGoogle,
  disconnectGoogle,
  getSources,
  googleStatus,
  removeGoogleClient,
  saveGoogleClient,
  setSourceEnabled,
  type CalendarSource,
  type GoogleStatus,
} from "../../lib/googleCalendar";

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
      <NotionWrites configured={configured} />
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
        <GoogleCalendarCard />
        <CalendarsCard />
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

/**
 * The opt-in for Notion writes (Done checkbox, title and date, new assignments) and
 * what the outbox holds: pending writes, and failed ones with Retry.
 */
function NotionWrites({ configured }: { configured: boolean }) {
  const { values, save } = useSettingValues(["notion_write_enabled"], ["notion:outbox"]);
  const [status, setStatus] = useState<{ pending: number; failed: (OutboxRow & { title: string })[] }>({ pending: 0, failed: [] });

  useEffect(() => {
    const load = () => void outboxStatus().then(setStatus).catch(console.error);
    load();
    const unlisteners = ["notion:outbox", "notion:status", "todos:changed"].map((e) => listen(e, load));
    return () => {
      for (const u of unlisteners) u.then((off) => off()).catch(console.error);
    };
  }, []);

  if (!values) return null;
  const on = values.notion_write_enabled === "true";
  return (
    <>
      <SettingRow label={t("int.notion.write")} hint={t("int.notion.writeHint")}>
        <Toggle
          label={t("int.notion.write")}
          on={on}
          disabled={!configured && !on}
          onChange={(v) => void save("notion_write_enabled", String(v)).then(() => v && void flushOutbox())}
        />
      </SettingRow>
      {(status.pending > 0 || status.failed.length > 0) && (
        <div className="sync-row">
          <div className="sync-row__text">
            {status.pending > 0 && <span>{t(on ? "int.notion.outboxPending" : "int.notion.outboxHeld", { n: status.pending })}</span>}
            {status.failed.map((f) => (
              <p key={f.id} className="field-error" role="alert">
                {t(f.op === "create" ? "int.notion.failedCreate" : f.op === "update" ? "int.notion.failedUpdate" : "int.notion.failedDone", { title: f.title })}{" "}
                {f.last_error ? apiErrorText(JSON.parse(f.last_error), "notion") : ""}{" "}
                <button type="button" className="link-btn" onClick={() => void retryOutbox(f.id).then(() => flushOutbox())}>
                  {t("int.notion.retry")}
                </button>
              </p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── Google Calendar (OAuth; read + create events) ──

function GoogleCalendarCard() {
  const { values, save } = useSettingValues(["calendar_nudge_minutes", "google_can_create"]);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"client" | "connect" | "disconnect" | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(() => {
    googleStatus().then(setStatus).catch(() => setStatus({ hasClient: false, connected: false }));
    getSources().then(setSources).catch(console.error);
  }, []);
  useEffect(() => {
    load();
    const unlisten = listen("calendar:status", load);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  if (!values || !status) return null;
  const failing = sources.some((s) => s.enabled && s.last_error);
  const tag = !status.connected
    ? { tone: "neutral" as const, label: "int.notConnected" as const }
    : failing
      ? { tone: "warn" as const, label: "int.attention" as const }
      : { tone: "done" as const, label: "int.connected" as const };

  const saveClient = async () => {
    setBusy("client");
    setMessage(null);
    try {
      await saveGoogleClient(clientId, clientSecret);
      // Write-only: the fields empty and never show the values again.
      setClientId("");
      setClientSecret("");
      setMessage({ text: t("g.clientSaved"), error: false });
    } catch {
      setMessage({ text: t("g.badClient"), error: true });
    }
    setBusy(null);
    load();
  };

  const connect = async () => {
    setBusy("connect");
    setMessage(null);
    try {
      const r = await connectGoogle();
      await save("google_can_create", String(r.canCreate));
      setMessage({ text: t(r.canCreate ? "g.connected" : "g.cantCreate"), error: !r.canCreate });
    } catch (err) {
      setMessage({ text: t("g.connectFailed", { reason: apiErrorText(err, "google") }), error: true });
    }
    setBusy(null);
    load();
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setMessage(null);
    try {
      const r = await disconnectGoogle();
      setMessage({ text: t(r.revoked ? "g.disconnected" : "g.disconnectedOffline"), error: false });
    } catch (err) {
      setMessage({ text: apiErrorText(err, "google"), error: true });
    }
    setBusy(null);
    load();
  };

  return (
    <ServiceCard icon="ti-calendar" name={t("g.title")} status={tag} about="g.about">
      {!status.connected && (
        <>
          <p className="muted">{t("g.setupHint")}</p>
          <form
            className="feed-add"
            onSubmit={(e) => {
              e.preventDefault();
              void saveClient();
            }}
          >
            <label htmlFor="g-client-id" className="sr-only">
              {t("g.clientId")}
            </label>
            <input
              id="g-client-id"
              className="field"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.hasClient ? `${t("g.clientId")} · ${t("g.clientSaved")}` : t("g.clientId")}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <label htmlFor="g-client-secret" className="sr-only">
              {t("g.clientSecret")}
            </label>
            <input
              id="g-client-secret"
              type="password"
              className="field"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("g.clientSecret")}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <ChunkyButton type="submit" size="sm" variant="secondary" disabled={busy !== null || !clientId.trim() || !clientSecret.trim()}>
              {t("g.saveClient")}
            </ChunkyButton>
          </form>
          <p className="muted">{t("g.clientHint")}</p>
        </>
      )}

      <div className="sync-row">
        <span className="muted">{busy === "connect" ? t("g.connecting") : status.connected ? t("g.connected") : t("g.connectHint")}</span>
        {status.connected ? (
          <ChunkyButton size="sm" variant="secondary" disabled={busy !== null} onClick={() => void disconnect()}>
            {t("g.disconnect")}
          </ChunkyButton>
        ) : (
          <span className="lists__confirm">
            {status.hasClient && (
              <ChunkyButton size="sm" variant="quiet" disabled={busy !== null} onClick={() => void removeGoogleClient().then(load)}>
                {t("g.removeClient")}
              </ChunkyButton>
            )}
            <ChunkyButton size="sm" disabled={busy !== null || !status.hasClient} onClick={() => void connect()}>
              {t("g.connect")}
            </ChunkyButton>
          </span>
        )}
      </div>
      {status.connected && values.google_can_create === "false" && <p className="field-error">{t("g.cantCreate")}</p>}
      {message && (
        <p className={message.error ? "field-error" : "muted"} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}

      {status.connected && (
        <SettingRow label={t("g.calendars")} hint={t("g.calendarsHint")}>
          <span />
        </SettingRow>
      )}
      {status.connected &&
        (sources.length === 0 ? (
          <p className="muted">{t("g.noCalendars")}</p>
        ) : (
          <ul className="lists">
            {sources.map((s) => (
              <li key={s.calendar_id} className="feed">
                <div className="feed__text">
                  <span className="feed__name">
                    {s.color && <span className="g-dot" style={{ background: s.color }} aria-hidden="true" />}
                    {s.name}
                    {s.is_primary ? <span className="muted"> · {t("g.primary")}</span> : null}
                  </span>
                  {s.enabled ? (
                    <span className="muted">
                      {s.last_synced_at
                        ? t("g.lastSync", { time: localTime(s.last_synced_at), n: s.events })
                        : t("int.notion.never")}
                    </span>
                  ) : null}
                  {s.enabled && s.last_error ? (
                    <span className="field-error">
                      {t("g.failed")} {apiErrorText(JSON.parse(s.last_error), "google")}
                    </span>
                  ) : null}
                </div>
                <Toggle
                  label={t("g.calendarOn", { name: s.name })}
                  on={!!s.enabled}
                  onChange={(on) => void setSourceEnabled(s.calendar_id, on).then(load)}
                />
              </li>
            ))}
          </ul>
        ))}

      <SettingRow label={t("cal.nudge")} hint={t("cal.nudgeHint")} htmlFor="cal-nudge">
        <select
          id="cal-nudge"
          className="field field--select field--short"
          value={values.calendar_nudge_minutes ?? "60"}
          onChange={(e) => void save("calendar_nudge_minutes", e.target.value)}
        >
          {/* A value set elsewhere may not be in the list. */}
          {["0", "5", "10", "15", "30", "60", "120"].includes(values.calendar_nudge_minutes ?? "60") ? null : (
            <option value={values.calendar_nudge_minutes}>{t("set.minutes", { n: values.calendar_nudge_minutes ?? "" })}</option>
          )}
          {["0", "5", "10", "15", "30", "60", "120"].map((m) => (
            <option key={m} value={m}>
              {m === "0" ? t("cal.nudgeOff") : t("set.minutes", { n: m })}
            </option>
          ))}
        </select>
      </SettingRow>
      <div className="sync-row">
        <span className="muted">{t("cal.window")}</span>
        <ChunkyButton size="sm" disabled={!status.connected} onClick={() => emit("calendar:sync").catch(console.error)}>
          {t("int.notion.sync")}
        </ChunkyButton>
      </div>
    </ServiceCard>
  );
}

// ── Calendars (ICS feeds, read-only) ──

function CalendarsCard() {
  const [feeds, setFeeds] = useState<CalendarFeed[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = useCallback(() => void getFeeds().then(setFeeds).catch(console.error), []);
  useEffect(() => {
    load();
    const unlisten = listen("calendar:status", load);
    return () => {
      unlisten.then((off) => off()).catch(console.error);
    };
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    const r = await addFeed(name, url).catch(() => "invalid" as const);
    setBusy(false);
    if (r === "added") {
      setName("");
      setUrl(""); // the URL is in Credential Manager now; never shown again
      load();
    } else setError(t(r === "full" ? "cal.full" : "cal.badUrl", { n: MAX_FEEDS }));
  };

  const any = feeds.some((f) => f.enabled);
  const failing = feeds.some((f) => f.enabled && f.last_error);
  const status = failing
    ? { tone: "warn" as const, label: "int.attention" as const }
    : any
      ? { tone: "done" as const, label: "int.connected" as const }
      : { tone: "neutral" as const, label: "int.notConnected" as const };

  return (
    <ServiceCard icon="ti-calendar-event" name={t("cal.title")} status={status} about="cal.about">
      <ul className="lists">
        {feeds.map((f) => (
          <li key={f.id} className="feed">
            <div className="feed__text">
              <span className="feed__name">{f.name}</span>
              <span className="muted">
                {f.last_synced_at ? t("int.notion.lastSync", { time: localTime(f.last_synced_at) }) : t("int.notion.never")} ·{" "}
                {t("cal.count", { n: f.events })}
              </span>
              {f.last_error && (
                <span className="field-error">
                  {t("cal.failed")} {apiErrorText(JSON.parse(f.last_error), "weather")}
                </span>
              )}
            </div>
            <Toggle label={t("cal.enabled", { name: f.name })} on={!!f.enabled} onChange={(on) => void setFeedEnabled(f.id, on).then(load)} />
            {confirm === f.id ? (
              <span className="lists__confirm">
                <ChunkyButton size="sm" variant="danger" onClick={() => void removeFeed(f.id).then(() => (setConfirm(null), load()))}>
                  {t("cal.remove")}
                </ChunkyButton>
                <ChunkyButton size="sm" variant="secondary" onClick={() => setConfirm(null)}>
                  {t("todo.cancel")}
                </ChunkyButton>
              </span>
            ) : (
              <ChunkyButton size="sm" variant="secondary" onClick={() => setConfirm(f.id)}>
                {t("cal.remove")}
              </ChunkyButton>
            )}
          </li>
        ))}
      </ul>
      {feeds.length < MAX_FEEDS && (
        <form
          className="feed-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label htmlFor="cal-name" className="sr-only">
            {t("cal.name")}
          </label>
          <input id="cal-name" className="field field--short" placeholder={t("cal.name")} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="cal-url" className="sr-only">
            {t("cal.url")}
          </label>
          <input
            id="cal-url"
            type="password"
            className="field"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("cal.url")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <ChunkyButton type="submit" size="sm" disabled={busy || !name.trim() || !url.trim()}>
            {t("cal.add")}
          </ChunkyButton>
        </form>
      )}
      <p className="muted">{t("cal.urlHint")}</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="sync-row">
        <span className="muted">{t("cal.window")}</span>
        <ChunkyButton size="sm" disabled={!any} onClick={() => emit("calendar:sync").catch(console.error)}>
          {t("int.notion.sync")}
        </ChunkyButton>
      </div>
    </ServiceCard>
  );
}
