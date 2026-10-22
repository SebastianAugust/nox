/**
 * Procedural lightning bolts for the night sky. Pure: everything random comes
 * from the `rng` passed in, so a fixed seed always gives the same bolt.
 *
 * Shape by midpoint displacement: split each segment in two and push the
 * midpoint sideways by a random amount proportional to the segment's length,
 * shrinking a little more at every level. A few thinner branches split off
 * the main channel at a shallow angle and stop short.
 */

export type Point = { x: number; y: number };
export type Bounds = { width: number; height: number };
export type Stroke = { points: Point[]; d: string; width: number };
export type Bolt = { main: Stroke; branches: Stroke[] };

/** Small, fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPREAD = 0.22; // sideways push as a share of the segment length
const DECAY = 0.85; // the push shrinks by this much per level, on top of the length halving

const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);

function clampTo(b: Bounds, p: Point): Point {
  return {
    x: Math.min(b.width, Math.max(0, p.x)),
    y: Math.min(b.height, Math.max(0, p.y)),
  };
}

/** Jagged polyline from a to b with 2^levels segments. */
function displace(rng: () => number, bounds: Bounds, a: Point, b: Point, levels: number): Point[] {
  let pts = [a, b];
  for (let level = 0; level < levels; level++) {
    const next: Point[] = [pts[0]];
    const amount = SPREAD * DECAY ** level;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1];
      const q = pts[i];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = (rng() * 2 - 1) * len * amount;
      next.push(
        clampTo(bounds, {
          x: (p.x + q.x) / 2 + (-dy / len) * off,
          y: (p.y + q.y) / 2 + (dx / len) * off,
        }),
        q,
      );
    }
    pts = next;
  }
  return pts;
}

export function toPath(points: Point[]): string {
  return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

const stroke = (points: Point[], width: number): Stroke => ({ points, d: toPath(points), width });

/**
 * A new bolt inside `bounds`: starts somewhere in the upper sky, ends lower
 * down (near the horizon or fading out mid-air), 32 or 64 main segments and
 * 1-3 branches.
 */
export function generateBolt(rng: () => number, bounds: Bounds): Bolt {
  const { width: w, height: h } = bounds;
  const start = { x: between(rng, 0.15, 0.85) * w, y: between(rng, 0.02, 0.2) * h };
  const end = clampTo(bounds, {
    x: start.x + between(rng, -0.3, 0.3) * w,
    y: between(rng, 0.55, 0.95) * h,
  });
  const levels = rng() < 0.5 ? 5 : 6;
  const main = displace(rng, bounds, start, end, levels);

  const mainAngle = Math.atan2(end.y - start.y, end.x - start.x);
  const mainLength = Math.hypot(end.x - start.x, end.y - start.y);
  const count = 1 + Math.floor(rng() * 3);
  const branches: Stroke[] = [];
  for (let i = 0; i < count; i++) {
    const from = main[Math.floor(between(rng, 0.2, 0.7) * (main.length - 1))];
    const side = rng() < 0.5 ? -1 : 1;
    const angle = mainAngle + side * between(rng, 0.35, 0.75);
    const length = mainLength * between(rng, 0.18, 0.38);
    const to = clampTo(bounds, {
      x: from.x + Math.cos(angle) * length,
      y: from.y + Math.sin(angle) * length,
    });
    branches.push(stroke(displace(rng, bounds, from, to, 4), between(rng, 0.75, 1.25)));
  }

  return { main: stroke(main, between(rng, 1.5, 2.5)), branches };
}
