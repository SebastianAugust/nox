import { useEffect, useId, useRef, useState } from "react";
import { generateBolt, type Bolt, type Point } from "../../lib/bolt";

/**
 * Occasional lightning behind the clouds. Each strike is a fresh procedural
 * bolt (or, about half the time, only a glow inside a cloud) with a real
 * lightning rhythm: flash, quick dim, often a second flash, then a fade.
 *
 * Photosensitivity: a strike has at most two flashes and strikes are at least
 * 15 s apart, so there are never more than 3 flashes in any second. The sky
 * glow stays at or below 0.12 opacity; nothing flashes full-screen white.
 * The parent only mounts this when motion is allowed and the window is active.
 */

const MIN_GAP_MS = 15_000;
const MAX_GAP_MS = 45_000;
const SKY_FLASH_MAX = 0.12;
const SHEET_FLASH_MAX = 0.12;

type Strike = { id: number; bolt: Bolt | null; at: Point; double: boolean };

// [time ms, opacity] — flash on, quick dim (~60 ms), second flash (~100 ms
// later), then a ~500 ms fade. Under one second either way.
const DOUBLE: [number, number][] = [[0, 0], [20, 0.9], [80, 0.25], [180, 0.8], [700, 0]];
const SINGLE: [number, number][] = [[0, 0], [20, 0.9], [90, 0.55], [560, 0]];

function keyframes(curve: [number, number][], scale: number): Keyframe[] {
  const total = curve[curve.length - 1][0];
  return curve.map(([ms, o]) => ({ offset: ms / total, opacity: (o / 0.9) * scale }));
}

const duration = (curve: [number, number][]) => curve[curve.length - 1][0];

export default function Lightning() {
  const boxRef = useRef<HTMLDivElement>(null);
  const boltRef = useRef<SVGGElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const [strike, setStrike] = useState<Strike | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const uid = useId().replace(/:/g, "");

  // Schedule strikes. Every timer is cleared on unmount, which is also how
  // the parent pauses lightning (it unmounts this when hidden or unfocused).
  useEffect(() => {
    let timer: number | undefined;
    let n = 0;
    const next = () => {
      timer = window.setTimeout(fire, MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
    };
    const fire = () => {
      const box = boxRef.current;
      if (!box) return next();
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (width < 40 || height < 40) return next();
      setSize({ width, height });

      const sheet = Math.random() < 0.5;
      const bolt = sheet ? null : generateBolt(Math.random, { width, height });
      const at = bolt
        ? bolt.main.points[Math.floor(bolt.main.points.length / 3)]
        : { x: (0.15 + Math.random() * 0.7) * width, y: (0.15 + Math.random() * 0.3) * height };
      const double = Math.random() < 0.6;
      setStrike({ id: ++n, bolt, at, double });
      timer = window.setTimeout(() => {
        setStrike(null);
        next();
      }, duration(double ? DOUBLE : SINGLE) + 50);
    };
    next();
    return () => clearTimeout(timer);
  }, []);

  // Play the strike once its elements are in the DOM.
  useEffect(() => {
    if (!strike) return;
    const curve = strike.double ? DOUBLE : SINGLE;
    const timing = { duration: duration(curve), fill: "forwards" as const };
    const anims = [
      flashRef.current?.animate(keyframes(curve, strike.bolt ? SKY_FLASH_MAX : SHEET_FLASH_MAX), timing),
      boltRef.current?.animate(keyframes(curve, 0.9), timing),
    ];
    return () => anims.forEach((a) => a?.cancel());
  }, [strike]);

  const glow = strike?.bolt
    ? `radial-gradient(circle at ${strike.at.x}px ${strike.at.y}px, var(--bolt) 0%, transparent 55%)`
    : strike
      ? `radial-gradient(ellipse 170px 60px at ${strike.at.x}px ${strike.at.y}px, var(--bolt-core) 0%, var(--bolt) 40%, transparent 100%)`
      : "none";

  return (
    <>
      <div ref={boxRef} className="lightning-layer" aria-hidden="true">
        {strike?.bolt && (
          <svg
            key={strike.id}
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            className="lightning-svg"
          >
            <defs>
              <filter id={`${uid}-blur`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" />
              </filter>
              {strike.bolt.branches.map((b, i) => {
                const a = b.points[0];
                const z = b.points[b.points.length - 1];
                return (
                  <linearGradient
                    key={i}
                    id={`${uid}-fade-${i}`}
                    gradientUnits="userSpaceOnUse"
                    x1={a.x}
                    y1={a.y}
                    x2={z.x}
                    y2={z.y}
                  >
                    <stop offset="0" className="bolt-stop" />
                    <stop offset="1" className="bolt-stop bolt-stop--end" />
                  </linearGradient>
                );
              })}
            </defs>
            <g ref={boltRef} className="bolt" opacity="0">
              <g filter={`url(#${uid}-blur)`} className="bolt-glow">
                <path d={strike.bolt.main.d} strokeWidth={8} />
                {strike.bolt.branches.map((b, i) => (
                  <path key={i} d={b.d} strokeWidth={4} />
                ))}
              </g>
              <path className="bolt-core" d={strike.bolt.main.d} strokeWidth={strike.bolt.main.width} />
              {strike.bolt.branches.map((b, i) => (
                <path key={i} d={b.d} strokeWidth={b.width} stroke={`url(#${uid}-fade-${i})`} className="bolt-branch" />
              ))}
            </g>
          </svg>
        )}
      </div>
      <div ref={flashRef} className="lightning-flash" style={{ background: glow }} aria-hidden="true" />
    </>
  );
}
