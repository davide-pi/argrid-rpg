// Pure projective geometry shared by the CV detector and the tactical overlays.
// Only a TYPE import (erased at build), so this stays a dependency-free leaf that
// neither the detector nor the rules layer couples to the other through.
import type { Line2 } from './grid-detector';

/** Intersection point of two lines in normal form nx·x+ny·y=d (null if parallel). */
export function intersect(a: Line2, b: Line2): { x: number; y: number } | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (a.d * b.ny - b.d * a.ny) / det,
    y: (a.nx * b.d - b.nx * a.d) / det,
  };
}

/** Inverse of a row-major 3×3 matrix (null if singular). Same expression order as
 * the detector's former private `inv3`, so results stay bit-identical on both the
 * detection and the overlay-homography paths. */
export function invert3x3(m: readonly number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const Hh = -(a * f - c * d);
  const I = a * e - b * d;
  const s = 1 / det;
  return [A * s, D * s, G * s, B * s, E * s, Hh * s, C * s, F * s, I * s];
}
