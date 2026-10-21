import { t } from "../lib/i18n";

type BubbleProps = {
  text: string;
  isStreaming?: boolean;
  onStop?: () => void;
};

const BUBBLE_BG = "rgba(12, 16, 32, 0.88)";

export default function Bubble({ text, isStreaming, onStop }: BubbleProps) {
  return (
    // Wrapper is not clipped, so the pointer + stop button sit outside the
    // scrolling text box (overflow:auto would otherwise clip them).
    <div style={{ position: "relative", width: "100%" }}>
      {isStreaming && (
        <button
          onClick={onStop}
          title={t("pet.stop")}
          style={{
            position: "absolute",
            top: 5,
            right: 7,
            fontSize: 9,
            lineHeight: 1,
            color: "rgba(255,255,255,0.4)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
            zIndex: 1,
          }}
        >
          ✕
        </button>
      )}

      {/* Glass text box: grows with content, scrolls at maxHeight. */}
      <div
        title={text}
        style={{
          background: BUBBLE_BG,
          border: "0.5px solid rgba(255,255,255,0.15)",
          borderRadius: 12,
          padding: "7px 11px",
          color: "rgba(255,255,255,0.88)",
          fontSize: 11,
          lineHeight: 1.5,
          width: "100%",
          maxHeight: 100,
          overflowY: "auto",
          overflowX: "hidden",
          wordBreak: "break-word",
          whiteSpace: "pre-wrap",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
      >
        {text}
      </div>

      {/* Triangle pointer aimed at the pet. */}
      <div
        style={{
          position: "absolute",
          bottom: -5,
          left: "50%",
          transform: "translateX(-50%)",
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: `5px solid ${BUBBLE_BG}`,
        }}
      />
    </div>
  );
}
