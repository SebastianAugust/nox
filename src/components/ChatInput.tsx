import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onClose: () => void;
  /** The input gained or lost focus (also when the window does). */
  onFocusChange?: (focused: boolean) => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, onClose, onFocusChange, disabled }: ChatInputProps) {
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
    <div data-hit className="chat">
      {isCommand && <div className="chat__hint">{t("chat.commandHint")}</div>}
      <div className="chat__pill">
        <label htmlFor="nox-chat" className="sr-only">
          {t("chat.label")}
        </label>
        <input
          id="nox-chat"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          disabled={disabled}
          placeholder={t("chat.placeholder")}
          spellCheck={false}
          className="chat__input"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label={t("chat.send")}
          title={t("chat.send")}
          className="chat__send"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
