import { useEffect, useState } from "react";
import Lightning from "./Lightning";

/** True while this window is visible and focused: decoration only runs then. */
export function useWindowActive(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [active, setActive] = useState(read);
  useEffect(() => {
    const update = () => setActive(read());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return active;
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setReduced(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

// [left %, top %, size px, delay s, duration s, blue]
const STARS: [number, number, number, number, number, boolean][] = [
  [10, 12, 3, 0, 3.2, false],
  [24, 30, 2, 1.2, 4.1, false],
  [47, 9, 4, 0.4, 2.6, true],
  [58, 38, 2, 2, 3.7, false],
  [71, 16, 3, 0.8, 4.6, false],
  [36, 50, 2, 1.6, 3, false],
  [90, 54, 3, 2.4, 3.9, false],
  [83, 7, 2, 3.1, 4.4, true],
  [4, 44, 2, 0.6, 3.5, false],
];

// [left %, delay s, duration s, warm]
const EMBERS: [number, number, number, boolean][] = [
  [18, 0, 6, true],
  [34, 1.5, 7.5, false],
  [52, 3, 6.8, true],
  [68, 0.8, 8, false],
  [84, 4.2, 7, true],
];

type Props = {
  /** Clouds, shooting star, embers, lightning and twinkling. Off = still sky. */
  animated: boolean;
  lightning: boolean;
  compact?: boolean;
};

/**
 * The sky behind a page header: stars, crescent moon, drifting clouds, an
 * occasional shooting star, embers rising off the scaled horizon, and
 * lightning. Fills and clips to its positioned parent, behind its content.
 */
export default function NightSky({ animated, lightning, compact }: Props) {
  const active = useWindowActive();
  const reduced = useReducedMotion();
  const moving = animated && !reduced;

  return (
    <div
      className={`night-sky${compact ? " night-sky--compact" : ""}`}
      data-paused={active ? undefined : ""}
      aria-hidden="true"
    >
      {STARS.map(([left, top, size, delay, dur, blue], i) => (
        <span
          key={i}
          className={`sky-star nox-anim${blue ? " sky-star--bolt" : ""}`}
          style={{
            left: `${left}%`,
            top: `${top}%`,
            width: size,
            height: size,
            animationDelay: `${delay}s`,
            animationDuration: `${dur}s`,
          }}
        />
      ))}
      <span className="sky-moon nox-anim" />
      <span className="sky-moon-shadow" />

      {moving && lightning && active && <Lightning />}

      {moving && (
        <>
          <span className="sky-cloud sky-cloud--a nox-anim" />
          <span className="sky-cloud sky-cloud--b nox-anim" />
          {!compact && <span className="sky-cloud sky-cloud--c nox-anim" />}
          <span className="sky-shooting nox-anim" />
          {EMBERS.map(([left, delay, dur, warm], i) => (
            <span
              key={i}
              className={`sky-ember nox-anim${warm ? "" : " sky-ember--light"}`}
              style={{ left: `${left}%`, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
            />
          ))}
        </>
      )}
      <div className="sky-horizon" />
    </div>
  );
}
