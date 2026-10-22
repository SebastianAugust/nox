import { useEffect, useState } from "react";
import { getSettings } from "../../lib/db";
import { t } from "../../lib/i18n";
import { card, rowBorder, sectionLabel } from "../../styles/shared";

export type Service = {
  name: string;
  initial: string;
  color: string;
  tokenKey?: string; // settings key; connected when its value is non-empty
  noToken?: boolean; // Weather: no token needed, just enable
};

export const INTEGRATIONS: Service[] = [
  { name: "Notion", initial: "N", color: "#fff", tokenKey: "notion_token" },
  { name: "Google Calendar", initial: "G", color: "#4285f4", tokenKey: "gcal_token" },
  { name: "Spotify", initial: "S", color: "#1db954", tokenKey: "spotify_token" },
  { name: "Weather (Open-Meteo)", initial: "W", color: "#38bdf8", noToken: true },
];

export default function PageIntegrations() {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    getSettings(["notion_token", "gcal_token", "spotify_token"])
      .then(setTokens)
      .catch(console.error);
  }, []);

  const isConnected = (s: Service) =>
    !!s.tokenKey && !!tokens[s.tokenKey]?.trim();

  const showPlaceholder = () =>
    setNote(t("int.comingSoon"));

  return (
    <>
      <div>
        <div style={sectionLabel}>{t("int.services")}</div>
        <div style={card}>
          {INTEGRATIONS.map((s, i) => {
            const connected = isConnected(s);
            return (
              <div
                key={s.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  ...rowBorder(i === INTEGRATIONS.length - 1),
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: connected
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(255,255,255,0.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    color: connected ? s.color : "rgba(255,255,255,0.3)",
                    flexShrink: 0,
                  }}
                >
                  {s.initial}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      color: connected ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {s.name}
                  </div>
                  {s.noToken && (
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>
                      {t("int.noToken")}
                    </div>
                  )}
                </div>

                {connected ? (
                  <span
                    style={{
                      fontSize: 11,
                      padding: "3px 9px",
                      borderRadius: 10,
                      background: "rgba(0,229,160,0.15)",
                      color: "#00e5a0",
                    }}
                  >
                    {t("int.on")}
                  </span>
                ) : (
                  <button
                    onClick={showPlaceholder}
                    style={{
                      fontSize: 11,
                      padding: "3px 10px",
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.06)",
                      border: "0.5px solid rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.4)",
                      cursor: "pointer",
                    }}
                  >
                    {t(s.noToken ? "int.enable" : "int.setup")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {note && (
        <div
          style={{
            background: "rgba(0,229,160,0.06)",
            border: "0.5px solid rgba(0,229,160,0.2)",
            borderRadius: 8,
            padding: "12px 16px",
            fontSize: 12,
            color: "rgba(255,255,255,0.6)",
          }}
        >
          {note}
        </div>
      )}
    </>
  );
}
