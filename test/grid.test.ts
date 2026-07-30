// Synthetic sanity checks for the pure geometry in grid-detector.ts.
// Run with: node --test test/grid.test.ts   (Node >= 22 strips the types)
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildGrid,
  clipLineToRect,
  DEFAULT_PARAMS,
  type RawLine,
  type Line2,
} from '../src/grid-detector.ts';

const DEG = 180 / Math.PI;

// Detection/fill tests pin extension OFF so they assert the detected+filled
// lattice in isolation (extension is exercised by its own tests below).
const NO_EXTEND = { ...DEFAULT_PARAMS, extend: 'off' as const };

/**
 * Build the Hough (rho, thetaDeg) representation of an axis-aligned-then-rotated
 * grid. Two perpendicular families, `n` lines each, pitch `s`, rotated by
 * `rotDeg`, centred in a W x H image. `drop` removes some interior lines to
 * simulate occlusion.
 */
function syntheticGrid(opts: {
  W: number;
  H: number;
  s: number;
  n: number;
  rotDeg: number;
  drop?: number[]; // indices (in family A) to omit
}): RawLine[] {
  const { W, H, s, n, rotDeg, drop = [] } = opts;
  const cx = W / 2;
  const cy = H / 2;
  const lines: RawLine[] = [];

  const addFamily = (normalDeg: number, skip: number[]) => {
    const nx = Math.cos(normalDeg / DEG);
    const ny = Math.sin(normalDeg / DEG);
    for (let i = 0; i < n; i++) {
      if (skip.includes(i)) continue;
      // Line i sits at signed offset (i - (n-1)/2)*s from the centre, measured
      // along the family normal. rho = n·P for any point P on the line; use the
      // centre plus the offset along the normal.
      const off = (i - (n - 1) / 2) * s;
      const px = cx + nx * off;
      const py = cy + ny * off;
      // OpenCV convention: signed rho, theta (normal angle) in [0,180).
      const rho = px * nx + py * ny;
      const thetaDeg = ((normalDeg % 180) + 180) % 180;
      lines.push({ rho, thetaDeg });
    }
  };

  addFamily(rotDeg, drop); // family A normals
  addFamily((rotDeg + 90) % 180, []); // family B normals (perpendicular)
  return lines;
}

test('recovers a straight (unrotated) full grid', () => {
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 80, n: 8, rotDeg: 0 });
  const r = buildGrid(raw, 1, 1000, 1000, NO_EXTEND);
  assert.equal(r.familyA.length, 8, 'family A line count');
  assert.equal(r.familyB.length, 8, 'family B line count');
  assert.ok(Math.abs(r.info.spacingA - 80) < 1, `pitch A ~80, got ${r.info.spacingA}`);
});

test('recovers a rotated grid (any orientation)', () => {
  for (const rot of [12, 30, 47, 63, 88]) {
    const raw = syntheticGrid({ W: 1200, H: 900, s: 60, n: 9, rotDeg: rot });
    const r = buildGrid(raw, 1, 1200, 900, NO_EXTEND);
    assert.equal(r.familyA.length, 9, `rot ${rot}: family A count`);
    assert.equal(r.familyB.length, 9, `rot ${rot}: family B count`);
    assert.ok(
      Math.abs(r.info.spacingA - 60) < 1.5,
      `rot ${rot}: pitch A ~60 got ${r.info.spacingA}`,
    );
  }
});

test('fills occluded interior lines', () => {
  // Drop interior lines 3,4,5 from one family -> the fill must recreate them.
  // (Result family labels are by dominance, so assert order-independently.)
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 80, n: 8, rotDeg: 20, drop: [3, 4, 5] });
  const r = buildGrid(raw, 1, 1000, 1000, NO_EXTEND);
  assert.equal(r.familyA.length, 8, 'family A back to 8 lines');
  assert.equal(r.familyB.length, 8, 'family B back to 8 lines');
  const filledTotal =
    r.familyA.filter((l) => l.filled).length + r.familyB.filter((l) => l.filled).length;
  assert.equal(filledTotal, 3, 'exactly the 3 dropped lines are marked filled');
});

test('does not fill when disabled', () => {
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 80, n: 8, rotDeg: 0, drop: [3, 4, 5] });
  const r = buildGrid(raw, 1, 1000, 1000, { ...NO_EXTEND, fillGrid: false });
  const counts = [r.familyA.length, r.familyB.length].sort((a, b) => a - b);
  assert.deepEqual(counts, [5, 8], 'no interpolation -> 5 detected + 8 detected');
});

test('respects downscale factor for pitch reported in original coords', () => {
  // scale 0.5 means working coords are half size; reported spacing is /scale.
  const raw = syntheticGrid({ W: 500, H: 500, s: 40, n: 6, rotDeg: 0 });
  const r = buildGrid(raw, 0.5, 1000, 1000, NO_EXTEND);
  assert.ok(Math.abs(r.info.spacingA - 80) < 2, `pitch scaled to 80, got ${r.info.spacingA}`);
});

test('clipLineToRect returns a full-width segment for a horizontal line', () => {
  const line: Line2 = { nx: 0, ny: 1, d: 250 }; // y = 250
  const seg = clipLineToRect(line, 1000, 500)!;
  assert.ok(seg, 'segment exists');
  const xs = [seg[0][0], seg[1][0]].sort((a, b) => a - b);
  const ys = [seg[0][1], seg[1][1]];
  assert.deepEqual(xs, [0, 1000]);
  assert.ok(ys.every((y) => Math.abs(y - 250) < 1e-6), 'y stays at 250');
});

test('clipLineToRect handles a rotated line crossing the rectangle', () => {
  const a = 30 / DEG;
  const line: Line2 = { nx: Math.cos(a), ny: Math.sin(a), d: 300 };
  const seg = clipLineToRect(line, 800, 600);
  assert.ok(seg, 'rotated line crosses the rect');
  // Both endpoints must satisfy the line equation.
  for (const [x, y] of seg!) {
    assert.ok(Math.abs(line.nx * x + line.ny * y - line.d) < 1e-3);
  }
});

test('rejects spurious lines that are not part of the regular grid', () => {
  const raw: RawLine[] = [];
  // Real grid: 11 verticals + 11 horizontals, each with 3 Hough votes (strong).
  for (let i = 0; i <= 10; i++) {
    for (const j of [-0.5, 0, 0.5]) {
      raw.push({ rho: 100 + i * 70 + j, thetaDeg: 0 }); // vertical
      raw.push({ rho: 100 + i * 55 + j, thetaDeg: 90 }); // horizontal
    }
  }
  // Spurious (single weak vote): squeezed between cells, isolated beyond the
  // grid, and an off-axis diagonal.
  raw.push({ rho: 125, thetaDeg: 0 });
  raw.push({ rho: 980, thetaDeg: 0 });
  raw.push({ rho: 400, thetaDeg: 45 });

  const r = buildGrid(raw, 1, 1000, 750, NO_EXTEND);
  const det = (fam: Line2[]) => fam.filter((l) => !l.filled).length;
  const counts = [det(r.familyA), det(r.familyB)].sort((a, b) => a - b);
  assert.deepEqual(counts, [11, 11], 'keeps 11+11 real lines, drops the spurious');
});

test('reconstructs the lattice, rejecting off-lattice lines at the grid angle', () => {
  // A "foreign object" can have edges PARALLEL to the grid — angle alone can't
  // reject them. The lattice reconstruction must drop lines that don't land on
  // a grid node even though they share the family orientation.
  const raw: RawLine[] = [];
  for (let i = 0; i < 10; i++) {
    for (const j of [-0.5, 0, 0.5]) {
      raw.push({ rho: 100 + i * 70 + j, thetaDeg: 0 }); // vertical grid line
      raw.push({ rho: 90 + i * 55 + j, thetaDeg: 90 }); // horizontal grid line
    }
  }
  // Off-lattice verticals at the SAME angle: one mid-cell, one near a node but
  // just off, both weakly supported (a foreign object's edges).
  raw.push({ rho: 345, thetaDeg: 0 }); // mid-cell between 310 and 380
  raw.push({ rho: 615, thetaDeg: 0 }); // just off the 590/660 nodes

  const r = buildGrid(raw, 1, 1000, 750, NO_EXTEND);
  const det = (fam: Line2[]) => fam.filter((l) => !l.filled).length;
  const counts = [det(r.familyA), det(r.familyB)].sort((a, b) => a - b);
  assert.deepEqual(counts, [10, 10], 'keeps the 10+10 lattice, drops both off-lattice lines');
});

test('frame extension tiles the grid beyond the detected extent', () => {
  // An identified grid must continue the lattice out to the image edges (extend like a manual one).
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 100, n: 8, rotDeg: 0 });
  const off = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'off' });
  const frame = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'frame' });

  assert.ok(frame.familyA.length > off.familyA.length, 'frame adds lines to family A');
  assert.ok(frame.familyB.length > off.familyB.length, 'frame adds lines to family B');
  // The extra lines are flagged as extended (so the UI can draw them faint)…
  const extra = frame.familyA.filter((l) => l.extended);
  assert.ok(extra.length > 0, 'extended lines are flagged');
  assert.ok(
    extra.every((l) => l.filled),
    'extended lines are also marked filled (drawn faint)',
  );
  // …every line still crosses the frame, and the pitch is preserved.
  for (const l of frame.familyA) {
    assert.ok(clipLineToRect(l, 1000, 1000), 'every family-A line crosses the frame');
  }
  assert.ok(Math.abs(frame.info.spacingA - 100) < 1.5, `pitch preserved, got ${frame.info.spacingA}`);
});

const framedExtended = (raw: RawLine[], W = 1000, H = 1000) => {
  const frame = buildGrid(raw, 1, W, H, { ...DEFAULT_PARAMS, extend: 'frame' });
  return frame.familyA.filter((l) => l.extended).length + frame.familyB.filter((l) => l.extended).length;
};

test('frame extension: a pure 2-line family is NOT tiled', () => {
  // Two spurious parallel edges (a table edge + a book edge) are not a confirmed periodic axis
  // (< MIN_FRAME_EVIDENCE), so they can't balloon into a full-frame fake grid.
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 80, n: 2, rotDeg: 0 });
  assert.equal(framedExtended(raw), 0, 'a 2-line family is not frame-tiled');
});

test('frame extension: a small identified grid still tiles the WHOLE frame (extend like manual)', () => {
  // Even a modest, low-coverage grid (6 lines spanning ~25% of the frame) is IDENTIFIED, so it must
  // extend to the whole screen — extension is tied to identification, not to how much it covers.
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 50, n: 6, rotDeg: 0 });
  assert.ok(framedExtended(raw) > 0, 'an identified grid tiles the frame regardless of coverage');
});

test('border extension adds only a couple of cells per side', () => {
  // A grid that spans most of the frame (so 'frame' tiling passes the coverage gate) but still
  // leaves a few cells of margin: 'border' must add at most ~2 per side, fewer than 'frame'.
  const raw = syntheticGrid({ W: 1000, H: 1000, s: 50, n: 15, rotDeg: 0 });
  const off = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'off' });
  const border = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'border' });
  const frame = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'frame' });

  const addedA = border.familyA.length - off.familyA.length;
  assert.ok(addedA > 0, 'border extends the grid');
  assert.ok(addedA <= 4, `border adds at most 2 per side, got ${addedA}`);
  assert.ok(
    border.familyA.length < frame.familyA.length,
    'border adds fewer lines than frame',
  );
  assert.ok(
    border.familyA.filter((l) => l.extended).length === addedA,
    'the added lines are exactly the extended ones',
  );
});
