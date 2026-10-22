/**
 * Small decorative shapes. All generic SVG/CSS, all token-colored, and all
 * hidden from assistive tech unless they carry information (Footprint).
 */

/** The logo mark: two mint slit-pupil eyes that blink now and then. */
export function SlitEyes() {
  return (
    <span className="slit-eyes" aria-hidden="true">
      <span className="slit-eye" />
      <span className="slit-eye" />
    </span>
  );
}

/** Three scratches across an overdue card. Sits behind the row's content. */
export function ClawMarks() {
  return (
    <svg className="claw-marks" width="90" height="70" viewBox="0 0 90 70" aria-hidden="true">
      <path d="M20 4c10 18 14 38 12 62M42 0c10 20 12 42 8 68M64 6c8 16 10 34 6 56" />
    </svg>
  );
}

export type FootprintState = "done" | "today" | "missed";

/** One day of a habit: filled mint when done, mint outline today, dim when missed. */
export function Footprint({ state, label }: { state: FootprintState; label: string }) {
  return (
    <svg className={`footprint footprint--${state}`} viewBox="0 0 22 22" role="img" aria-label={label}>
      <ellipse cx="11" cy="15" rx="5" ry="4.5" />
      <ellipse cx="5" cy="8" rx="2" ry="3" />
      <ellipse cx="11" cy="5" rx="2" ry="3" />
      <ellipse cx="17" cy="8" rx="2" ry="3" />
    </svg>
  );
}

/** The egg next to the habit streak. Purely visual. */
export function StreakEgg({ size = 44 }: { size?: number }) {
  return (
    <svg
      className="streak-egg"
      width={size}
      height={(size * 54) / 44}
      viewBox="0 0 44 54"
      aria-hidden="true"
    >
      <path className="streak-egg__shell" d="M22 2C11 2 3 20 3 33a19 19 0 0 0 38 0C41 20 33 2 22 2z" />
      <path className="streak-egg__crack" d="M8 30l6-4 5 5 6-6 5 5 6-4" />
      <circle className="streak-egg__spot" cx="16" cy="40" r="3" />
      <circle className="streak-egg__spot" cx="28" cy="16" r="2.5" />
    </svg>
  );
}

const WING = "M34 14C24 14 14 8 2 2c4 8 6 14 4 22 8-6 16-8 28-10z";

/** Two wings flanking whatever sits in the middle (the focus timer). */
export function Wings({ children, size = "md" }: { children: React.ReactNode; size?: "md" | "lg" }) {
  return (
    <div className={`wings wings--${size}`}>
      <svg className="wing wing--left" viewBox="0 0 36 28" aria-hidden="true">
        <path d={WING} />
      </svg>
      {children}
      <svg className="wing wing--right" viewBox="0 0 36 28" aria-hidden="true">
        <path d={WING} />
      </svg>
    </div>
  );
}

/** Crescent moon with two stars, for empty states. */
export function MoonStars() {
  return (
    <svg className="moon-stars" width="72" height="56" viewBox="0 0 72 56" aria-hidden="true">
      <path className="moon-stars__moon" d="M40 8a20 20 0 1 0 18 28A16 16 0 0 1 40 8z" />
      <rect className="moon-stars__star" x="10" y="12" width="3" height="3" />
      <rect className="moon-stars__star moon-stars__star--bolt" x="62" y="10" width="3" height="3" />
      <rect className="moon-stars__star" x="16" y="44" width="2" height="2" />
    </svg>
  );
}
