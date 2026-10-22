import { useState } from "react";
import { t } from "../../lib/i18n";
import { rowBorder } from "../../styles/shared";

export function SettingRow({
  label,
  last,
  children,
}: {
  label: string;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 0",
        minHeight: 34,
        ...rowBorder(last),
      }}
    >
      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{label}</span>
      {children}
    </div>
  );
}

/** Click the value to edit it; Enter or blur commits, Escape cancels. */
export function EditableValue({
  value,
  numeric,
  onSave,
}: {
  value: string;
  numeric?: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    if (numeric && !/^\d+$/.test(next)) return;
    onSave(next);
  };

  if (!editing) {
    return (
      <span
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title={t("set.clickToEdit")}
        style={{
          fontSize: 13,
          color: "rgba(255,255,255,0.3)",
          cursor: "pointer",
          borderBottom: "0.5px dashed rgba(255,255,255,0.12)",
        }}
      >
        {value || "—"}
      </span>
    );
  }

  return (
    <input
      autoFocus
      value={draft}
      inputMode={numeric ? "numeric" : "text"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      style={{
        width: 150,
        textAlign: "right",
        background: "rgba(255,255,255,0.06)",
        border: "0.5px solid rgba(255,255,255,0.12)",
        borderRadius: 6,
        outline: "none",
        color: "rgba(255,255,255,0.85)",
        fontSize: 13,
        padding: "3px 6px",
        fontFamily: "inherit",
      }}
    />
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        background: on ? "#00e5a0" : "rgba(255,255,255,0.1)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.2s",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 14,
          height: 14,
          background: "white",
          borderRadius: "50%",
          top: 2,
          transition: "0.2s",
          ...(on ? { right: 2 } : { left: 2 }),
        }}
      />
    </div>
  );
}
