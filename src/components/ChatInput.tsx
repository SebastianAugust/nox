import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onClose: () => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, onClose, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setValue("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Typing "/" means a local command, not a question for the model — show
  // what is available, since the placeholder is hidden once text is present.
  const isCommand = value.startsWith("/");

  return (
    <div
      style={{
        width: "100%",
        background: "rgba(12, 16, 32, 0.88)",
        border: "0.5px solid rgba(255,255,255,0.15)",
        borderRadius: 12,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      {isCommand && (
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          {t("chat.commandHint")}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={t("chat.placeholder")}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "rgba(255,255,255,0.85)",
          fontSize: 11,
          fontFamily: "inherit",
          caretColor: "rgba(255,255,255,0.6)",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {value.trim() && (
        <button
          onClick={submit}
          disabled={disabled}
          title={t("chat.send")}
          style={{
            background: "rgba(255,255,255,0.1)",
            border: "0.5px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            color: "rgba(255,255,255,0.6)",
            fontSize: 10,
            lineHeight: 1,
            padding: "2px 6px",
            cursor: disabled ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          ↵
        </button>
      )}
      </div>
    </div>
  );
}
