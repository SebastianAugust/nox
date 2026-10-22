type Props = {
  children: React.ReactNode;
  /** Buttons under the message; omitted for plain replies. */
  actions?: React.ReactNode;
  /** Top-right slot inside the frame (the stop button while streaming). */
  corner?: React.ReactNode;
  size?: "md" | "sm";
  role?: string;
  className?: string;
};

/**
 * Nox's message frame: dark fill, light pixel border, a lightning-blue inner
 * line with a soft glow, the mint NOX name tag and a small "more" marker.
 * The wrapper's top padding makes room for the tag, so the tag is inside the
 * element's box (and inside the pet window's hit region).
 */
export default function DialogBox({ children, actions, corner, size = "md", role, className }: Props) {
  return (
    <div className={`dialog-wrap dialog-wrap--${size}${className ? ` ${className}` : ""}`} data-hit>
      <div className="dialog" role={role}>
        <span className="dialog__tag">NOX</span>
        {corner && <div className="dialog__corner">{corner}</div>}
        <div className="dialog__body">{children}</div>
        {actions && <div className="dialog__actions">{actions}</div>}
        <svg className="dialog__more" width="10" height="7" viewBox="0 0 10 7" aria-hidden="true">
          <path d="M0 0h10L5 7z" />
        </svg>
      </div>
    </div>
  );
}
