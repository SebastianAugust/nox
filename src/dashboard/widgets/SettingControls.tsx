import { useEffect, useState } from "react";

/** Label on the left, control on the right; wraps when space runs out. */
export function SettingRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  /** The control's id, when it is a form field the label should point at. */
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting">
      <div className="setting__text">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="setting__label">
            {label}
          </label>
        ) : (
          <span className="setting__label">{label}</span>
        )}
        {hint && <span className="setting__hint">{hint}</span>}
      </div>
      <div className="setting__control">{children}</div>
    </div>
  );
}

/**
 * A text setting as a real bordered field. Saves on Enter or when focus
 * leaves; Escape puts the saved value back. Empty input is not saved.
 */
export function TextSetting({
  id,
  value,
  onSave,
}: {
  id: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (!next) return setDraft(value);
    if (next !== value) onSave(next);
  };

  return (
    <input
      id={id}
      className="field"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
