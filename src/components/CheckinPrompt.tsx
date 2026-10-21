import { t } from "../lib/i18n";
import { MOODS, type Mood } from "../lib/checkin";

type Props = {
  onPick: (mood: Mood) => void;
  onDismiss: () => void;
};

/** The row of mood buttons shown when a body check-in is due. */
export default function CheckinPrompt({ onPick, onDismiss }: Props) {
  return (
    <div
      style={{
        width: "100%",
        background: "rgba(12, 16, 32, 0.88)",
        border: "0.5px solid rgba(255,255,255,0.15)",
        borderRadius: 12,
        padding: "7px 9px",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      {/* The question lives here rather than in the bubble, so the buttons are
          never left stranded when the bubble text reverts. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 10,
          color: "rgba(255,255,255,0.5)",
          marginBottom: 6,
        }}
      >
        <span>{t("checkin.question")}</span>
        <button
          onClick={onDismiss}
          title={t("checkin.notNow")}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.3)",
            fontSize: 10,
            cursor: "pointer",
            padding: 0,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {MOODS.map((m) => (
        <button
          key={m.key}
          onClick={() => onPick(m)}
          title={t(m.labelKey)}
          style={{
            flex: 1,
            minWidth: 0,
            background: "rgba(255,255,255,0.06)",
            border: "0.5px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            color: "rgba(255,255,255,0.7)",
            fontSize: 10,
            lineHeight: 1.3,
            padding: "5px 2px",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <div style={{ fontSize: 13 }}>{m.emoji}</div>
          {t(m.labelKey)}
        </button>
      ))}
      </div>
    </div>
  );
}
