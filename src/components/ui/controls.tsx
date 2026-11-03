import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
  size?: "sm" | "md" | "lg";
};

/**
 * Primary: mint fill on a solid darker-mint edge that sinks when pressed.
 * Secondary: outline. Danger: for destructive confirms. Quiet: low-key fill.
 */
export function ChunkyButton({ variant = "primary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`chunky chunky--${variant} chunky--${size}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

/** A selectable pill (nav items, filters). */
export function Pill({
  selected,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={`pill${selected ? " pill--selected" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

export type TagTone = "overdue" | "personal" | "neutral" | "warn" | "done";

/** Small uppercase pixel tag. */
export function Tag({ tone = "neutral", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

/** A page card: optional heading row with a pixel meta on the right. */
export function Card({
  title,
  meta,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  /** Accessible name when there is no visible title. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-label={title ? undefined : label}>
      {(title || meta) && (
        <div className="card__head">
          {title && <h2 className="card__title">{title}</h2>}
          {meta && <span className="card__meta">{meta}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** One number in the summary row: big pixel value, short label beside it. */
export function StatCard({
  value,
  of,
  label,
  sub,
}: {
  value: ReactNode;
  of?: ReactNode;
  label: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat__value">
        {value}
        {of !== undefined && <span className="stat__of">/{of}</span>}
      </span>
      <span className="stat__label">
        {label}
        {sub && <span className="stat__sub">{sub}</span>}
      </span>
    </div>
  );
}

/** On/off switch with the switch role. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch${on ? " switch--on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch__knob" />
    </button>
  );
}

/** Round icon-only button (titlebar, row actions). Always needs a label. */
export function IconButton({
  label,
  children,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`icon-btn${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
