import { describe, expect, it } from "vitest";
import { generateBolt, seededRng, type Point } from "./bolt";

const BOUNDS = { width: 900, height: 260 };

const inside = (p: Point) => p.x >= 0 && p.x <= BOUNDS.width && p.y >= 0 && p.y <= BOUNDS.height;

describe("generateBolt", () => {
  it("is deterministic for a fixed seed", () => {
    expect(generateBolt(seededRng(42), BOUNDS)).toEqual(generateBolt(seededRng(42), BOUNDS));
    expect(generateBolt(seededRng(1), BOUNDS).main.d).not.toBe(generateBolt(seededRng(2), BOUNDS).main.d);
  });

  it("stays inside the bounds and has the expected shape", () => {
    for (let seed = 0; seed < 200; seed++) {
      const bolt = generateBolt(seededRng(seed), BOUNDS);
      const segments = bolt.main.points.length - 1;
      expect([32, 64]).toContain(segments);
      expect(bolt.main.d.match(/L/g)).toHaveLength(segments);
      expect(bolt.branches.length).toBeGreaterThanOrEqual(1);
      expect(bolt.branches.length).toBeLessThanOrEqual(3);

      expect(bolt.main.width).toBeGreaterThanOrEqual(1.5);
      expect(bolt.main.width).toBeLessThanOrEqual(2.5);
      for (const b of bolt.branches) {
        expect(b.points.length - 1).toBe(16);
        expect(b.width).toBeLessThan(bolt.main.width);
        expect(b.points.every(inside)).toBe(true);
      }
      expect(bolt.main.points.every(inside)).toBe(true);
      // Starts in the upper sky, ends lower down.
      expect(bolt.main.points[0].y).toBeLessThanOrEqual(BOUNDS.height * 0.2);
      expect(bolt.main.points[segments].y).toBeGreaterThanOrEqual(BOUNDS.height * 0.55);
    }
  });
});
