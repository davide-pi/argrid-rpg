// Pure-logic tests for the calibrated confidence + consensus fusion in grid-detector.ts.
// These need no OpenCV: familyQuality / gridConfidence / fuseGrids are pure functions, and
// buildGrid takes raw Hough lines directly. They pin the LOGIC (ordering, corroboration,
// harmonic pitch) — absolute thresholds are calibrated on real photos in the browser.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildGrid,
  familyQuality,
  gridConfidence,
  harmonicAspect,
  cellCountPlausibility,
  isGridReliable,
  DRAW_THRESHOLD,
  dedupeHoughLines,
  fuseGrids,
  betterPair,
  DEFAULT_PARAMS,
  MIN_GRID_CELLS,
  MAX_GRID_CELLS,
  MAX_CELL_ASPECT,
  type FamilyMetrics,
  type GridResult,
  type RawLine,
} from '../src/grid-detector.ts';

const DEG = 180 / Math.PI;
const NO_EXTEND = { ...DEFAULT_PARAMS, extend: 'off' as const };

// --- familyQuality -----------------------------------------------------------

test('familyQuality: a 0/1-line "family" is not a grid axis', () => {
  assert.equal(familyQuality({ count: 0, span: 0, fill: 0, inlier: 0 }), 0);
  assert.equal(familyQuality({ count: 1, span: 1, fill: 1, inlier: 1 }), 0, '1 line → 0 even if "perfect"');
});

test('familyQuality: a clean, complete axis saturates to 1', () => {
  assert.equal(familyQuality({ count: 8, span: 8, fill: 1, inlier: 1 }), 1);
});

test('familyQuality: monotonic in count, inlier and fill', () => {
  const base: FamilyMetrics = { count: 4, span: 5, fill: 0.6, inlier: 0.6 };
  const more = (p: Partial<FamilyMetrics>): number => familyQuality({ ...base, ...p });
  assert.ok(more({ count: 6 }) > familyQuality(base), 'more lines → higher');
  assert.ok(more({ inlier: 0.9 }) > familyQuality(base), 'more regular → higher');
  assert.ok(more({ fill: 0.9 }) > familyQuality(base), 'more complete → higher');
});

test('familyQuality: texture (many off-lattice lines → low inlier) scores low', () => {
  // Same line count as a real axis, but only a third sit on the lattice.
  assert.ok(familyQuality({ count: 6, span: 8, fill: 0.6, inlier: 0.3 }) < 0.5);
});

// --- gridConfidence ----------------------------------------------------------

test('gridConfidence: a degenerate (sub-pitch) fit is heavily penalised, not cliffed to 0', () => {
  const strong: FamilyMetrics = { count: 10, span: 10, fill: 1, inlier: 1 };
  const clean = gridConfidence(strong, strong, false);
  const degenerate = gridConfidence(strong, strong, true);
  assert.ok(degenerate < 0.2, `a degenerate fit is dragged low, got ${degenerate}`);
  assert.ok(degenerate < clean, 'a degenerate fit ranks below a clean one');
});

test('gridConfidence: both axes strong → high; one weak axis pulls it down (but NOT to 0)', () => {
  const strong: FamilyMetrics = { count: 10, span: 10, fill: 1, inlier: 1 };
  const weak: FamilyMetrics = { count: 2, span: 3, fill: 0.66, inlier: 0.6 };
  const both = gridConfidence(strong, strong, false);
  const lopsided = gridConfidence(strong, weak, false);
  assert.ok(both > 0.9, `two strong axes → high, got ${both}`);
  assert.ok(lopsided < both, 'a weak axis lowers confidence');
  assert.ok(lopsided > 0, 'a strong axis + a weak one is NOT zeroed — this is the anti-cliff fix');
});

test('gridConfidence: low perpendicularity (sheared cells) penalises; perp=1 is a no-op', () => {
  const strong: FamilyMetrics = { count: 10, span: 10, fill: 1, inlier: 1 };
  const square = gridConfidence(strong, strong, false, 1, 1); // perpendicular → default behaviour
  const noPerp = gridConfidence(strong, strong, false, 1); // perp defaults to 1 (backward-compatible)
  const sheared = gridConfidence(strong, strong, false, 1, 0.5); // rhombus: equal pitches, but skewed
  assert.equal(square, noPerp, 'perp defaults to 1 → identical to the pre-perp behaviour');
  assert.ok(sheared < square, 'a sheared (low-perpendicularity) fit scores lower than a square one');
  assert.ok(Math.abs(sheared - square * 0.5) < 1e-9, 'perp enters as a linear multiplicative factor');
});

// --- dedupeHoughLines --------------------------------------------------------

test('dedupeHoughLines: collapses a cluster of near-duplicate detections to one', () => {
  // One real line detected 4 times (jittered), plus a second, well-separated line.
  const raw: RawLine[] = [
    { rho: 200, thetaDeg: 90 },
    { rho: 201.2, thetaDeg: 90.5 },
    { rho: 199, thetaDeg: 89.6 },
    { rho: 200.5, thetaDeg: 90 },
    { rho: 320, thetaDeg: 90 },
  ];
  const out = dedupeHoughLines(raw, 4, 2);
  assert.equal(out.length, 2, 'the 4-hit cluster collapses to 1, plus the distinct line');
  assert.equal(out[0].rho, 200, 'keeps the FIRST (strongest, vote-descending) of the cluster');
});

test('dedupeHoughLines: keeps distinct grid lines a full cell apart', () => {
  const raw: RawLine[] = [];
  for (let i = 0; i < 8; i++) raw.push({ rho: 100 + i * 60, thetaDeg: 0 });
  assert.equal(dedupeHoughLines(raw, 4, 2).length, 8, 'no real grid line is merged away');
});

test('dedupeHoughLines: same line across the 0/180° wrap collapses (sign-aware ρ)', () => {
  // θ≈0.5 with ρ=+100 and θ≈179.5 with ρ=−100 are the SAME vertical line.
  const raw: RawLine[] = [
    { rho: 100, thetaDeg: 0.5 },
    { rho: -100, thetaDeg: 179.5 },
  ];
  assert.equal(dedupeHoughLines(raw, 4, 3).length, 1, 'the wrap twin is recognised as a duplicate');
});

test('dedupeHoughLines: different orientations are never merged', () => {
  const raw: RawLine[] = [
    { rho: 200, thetaDeg: 0 },
    { rho: 200, thetaDeg: 90 },
  ];
  assert.equal(dedupeHoughLines(raw, 4, 2).length, 2, 'perpendicular lines stay separate');
});

// --- size plausibility -------------------------------------------------------

test('cellCountPlausibility: full inside [MIN,MAX], zero far outside', () => {
  assert.equal(cellCountPlausibility(12), 1, 'a mid-size grid is fully plausible');
  assert.equal(cellCountPlausibility(MIN_GRID_CELLS), 1);
  assert.equal(cellCountPlausibility(MAX_GRID_CELLS), 1);
  assert.equal(cellCountPlausibility(2), 0, 'a 2×2 is not a tactical grid');
  assert.equal(cellCountPlausibility(60), 0, 'a 60×60 texture lock is not a grid');
  assert.ok(cellCountPlausibility(4) > 0 && cellCountPlausibility(4) < 1, 'just below MIN ramps');
  assert.ok(cellCountPlausibility(30) > 0 && cellCountPlausibility(30) < 1, 'just above MAX ramps');
});

test('gridConfidence: an elongated (non-square) cell drags confidence down, not to 0', () => {
  // The 4th arg is the cell ASPECT (pitch ratio). A square cell (≈1) is fully grid-like; a
  // very rectangular cell (a mis-estimated pitch) is penalised via the soft squareness term,
  // but the HARD reject is the draw gate's job — confidence must not cliff here.
  const strong: FamilyMetrics = { count: 10, span: 10, fill: 1, inlier: 1 };
  const square = gridConfidence(strong, strong, false, 1);
  const elongated = gridConfidence(strong, strong, false, MAX_CELL_ASPECT);
  assert.ok(square > 0.9, `a square cell keeps it high, got ${square}`);
  assert.ok(elongated < square, 'a rectangular cell lowers confidence');
  assert.ok(elongated > 0, 'an elongated cell is penalised, not zeroed');
});

// --- buildGrid integration (still pure: raw Hough lines in) -------------------

function syntheticGrid(opts: { W: number; H: number; s: number; n: number; rotDeg: number }): RawLine[] {
  const { W, H, s, n, rotDeg } = opts;
  const cx = W / 2;
  const cy = H / 2;
  const out: RawLine[] = [];
  const add = (normalDeg: number) => {
    const nx = Math.cos(normalDeg / DEG);
    const ny = Math.sin(normalDeg / DEG);
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * s;
      const rho = (cx + nx * off) * nx + (cy + ny * off) * ny;
      out.push({ rho, thetaDeg: ((normalDeg % 180) + 180) % 180 });
    }
  };
  add(rotDeg);
  add((rotDeg + 90) % 180);
  return out;
}

test('buildGrid: a full clean grid reads as probably-a-grid', () => {
  const r = buildGrid(syntheticGrid({ W: 1000, H: 1000, s: 80, n: 10, rotDeg: 0 }), 1, 1000, 1000, NO_EXTEND);
  assert.equal(r.info.degenerate, false);
  assert.ok(r.info.confidence > 0.6, `full grid confidence high, got ${r.info.confidence}`);
});

test('buildGrid: a lopsided fit (one axis barely present) scores below a full grid', () => {
  const full = buildGrid(syntheticGrid({ W: 1000, H: 1000, s: 80, n: 10, rotDeg: 0 }), 1, 1000, 1000, NO_EXTEND);
  // 10 regular verticals but only 2 horizontals → the horizontal axis is weak evidence.
  const raw: RawLine[] = [];
  for (let i = 0; i < 10; i++) raw.push({ rho: 100 + i * 80, thetaDeg: 0 });
  raw.push({ rho: 300, thetaDeg: 90 }, { rho: 620, thetaDeg: 90 });
  const lop = buildGrid(raw, 1, 1000, 1000, NO_EXTEND);
  assert.ok(lop.info.confidence < full.info.confidence, 'lopsided < full');
});

// --- fuseGrids ---------------------------------------------------------------

// Minimal GridResult carrying only the fields fuseGrids / gridsAgree read.
function fakeGrid(o: {
  conf: number;
  detA: number;
  detB: number;
  pitchA: number;
  pitchB: number;
  angA?: number;
  angB?: number;
  cellsA?: number;
  cellsB?: number;
  spanA?: number;
  spanB?: number;
  degenerate?: boolean;
}): GridResult {
  return {
    width: 1000,
    height: 1000,
    familyA: [],
    familyB: [],
    rawLines: [],
    info: {
      rawCount: 0,
      aCount: o.detA,
      bCount: o.detB,
      angleADeg: o.angA ?? 0,
      angleBDeg: o.angB ?? 90,
      spacingA: o.pitchA,
      spacingB: o.pitchB,
      usedHough: 0,
      cannyHigh: 0,
      edgePixels: 0,
      detectedA: o.detA,
      detectedB: o.detB,
      confidence: o.conf,
      cellsA: o.cellsA ?? 12,
      cellsB: o.cellsB ?? 12,
      inlierA: 1,
      inlierB: 1,
      degenerate: o.degenerate ?? false,
      // The size tie-break (shapeOf) now reads `span` (detected extent) instead of the
      // frame-relative cell count; default it to cellsA/B so these shape-tie tests keep intent.
      spanA: o.spanA ?? o.cellsA ?? 12,
      spanB: o.spanB ?? o.cellsB ?? 12,
    },
  };
}

test('fuseGrids: an independent second opinion lifts a corroborated fit', () => {
  const fine = fakeGrid({ conf: 0.6, detA: 14, detB: 14, pitchA: 40, pitchB: 40 });
  const same = fakeGrid({ conf: 0.55, detA: 12, detB: 12, pitchA: 40.5, pitchB: 39.5 });
  const res = fuseGrids([fine, same]);
  assert.ok(res.agreement != null && res.agreement > 0.7, `strong agreement, got ${res.agreement}`);
  assert.ok(res.confidence > 0.6, `corroboration lifts above internal 0.6, got ${res.confidence}`);
});

test('fuseGrids: harmonic sub-sampling agrees, and the FINER grid wins', () => {
  // A method that only caught every 4th line (coarse) still corroborates the full grid.
  const fine = fakeGrid({ conf: 0.55, detA: 16, detB: 16, pitchA: 40, pitchB: 40 });
  const coarse = fakeGrid({ conf: 0.5, detA: 4, detB: 4, pitchA: 160, pitchB: 160 });
  const res = fuseGrids([coarse, fine]);
  assert.equal(res.index, 1, 'the finer (complete) grid is chosen, not the sub-sampling');
  assert.ok(res.confidence > 0.55, 'the finer grid is lifted by the corroboration');
  // The coarse sub-sampling must NOT ride the fine grid's corroboration.
  assert.ok(res.confidences[0] <= 0.5 + 1e-9, 'coarse candidate is not boosted');
});

test('fuseGrids: genuinely different grids do not corroborate (no boost)', () => {
  const g1 = fakeGrid({ conf: 0.5, detA: 6, detB: 6, pitchA: 37, pitchB: 37, angA: 0, angB: 90 });
  const g2 = fakeGrid({ conf: 0.3, detA: 5, detB: 5, pitchA: 53, pitchB: 53, angA: 22, angB: 112 });
  const res = fuseGrids([g1, g2]);
  assert.equal(res.index, 0, 'the higher internal-quality fit wins');
  assert.equal(res.agreement, null, 'no corroboration');
  assert.ok(Math.abs(res.confidence - 0.5) < 1e-9, 'confidence unchanged without agreement');
});

test('fuseGrids: at tied ~0 confidence, a plausible shape beats garbage', () => {
  // The real failure: luminance emits a garbage 1×9 (conf 0), morphology a plausibly-sized
  // 13×8 (also conf 0 — too few detected lines). Garbage must NOT win just for being first.
  const garbage = fakeGrid({ conf: 0, detA: 2, detB: 2, pitchA: 400, pitchB: 40, cellsA: 1, cellsB: 9 });
  const plausible = fakeGrid({ conf: 0, detA: 2, detB: 2, pitchA: 60, pitchB: 60, cellsA: 13, cellsB: 8 });
  const res = fuseGrids([garbage, plausible]);
  assert.equal(res.index, 1, 'the grid-shaped candidate wins the tie, not the first/garbage one');
});

test('fuseGrids: a clearly higher confidence still wins over a better shape', () => {
  // A real confidence signal must not be overridden by a marginally-nicer shape.
  const strongOddish = fakeGrid({ conf: 0.7, detA: 8, detB: 8, pitchA: 60, pitchB: 60, cellsA: 6, cellsB: 24 });
  const weakSquare = fakeGrid({ conf: 0.2, detA: 3, detB: 3, pitchA: 60, pitchB: 60, cellsA: 12, cellsB: 12 });
  const res = fuseGrids([weakSquare, strongOddish]);
  assert.equal(res.index, 1, 'the clearly-more-confident fit wins despite a plainer shape');
});

test('fuseGrids: a degenerate candidate neither wins nor corroborates', () => {
  const good = fakeGrid({ conf: 0.55, detA: 8, detB: 8, pitchA: 60, pitchB: 60 });
  const deg = fakeGrid({ conf: 0, detA: 20, detB: 20, pitchA: 60, pitchB: 60, degenerate: true });
  const res = fuseGrids([deg, good]);
  assert.equal(res.index, 1, 'the real grid wins over the degenerate one');
  assert.ok(Math.abs(res.confidence - 0.55) < 1e-9, 'a degenerate fit gives no corroboration boost');
});

// --- harmonicAspect (a ×m sub-pitch must not read as a rectangular cell) ------

test('harmonicAspect: a ×m sub-pitch reads near-square; a real rectangle keeps its aspect', () => {
  assert.ok(Math.abs(harmonicAspect(3.25) - 3.25 / 3) < 1e-9, '3.25 ≈ ×3 sub-pitch → ~1.08');
  assert.ok(harmonicAspect(6) > 3, 'a genuinely elongated 6:1 cell is NOT "corrected"');
  assert.equal(harmonicAspect(1), 1, 'a square cell is unchanged');
});

test('gridConfidence: a harmonic sub-pitch is not punished as a rectangular cell (fixes #9)', () => {
  const s: FamilyMetrics = { count: 6, span: 6, fill: 1, inlier: 1 };
  const square = gridConfidence(s, s, false, 1);
  const harmonic = gridConfidence(s, s, false, 3.25); // a ×3 sub-pitch on one axis
  const rect = gridConfidence(s, s, false, 6); // a genuinely elongated cell
  assert.ok(harmonic > 0.9 * square, 'the ×3 harmonic reads ~square, not penalised');
  assert.ok(rect < harmonic, 'a genuinely elongated cell still scores lower');
});

// --- isGridReliable (the single draw decision) -------------------------------

test('isGridReliable: draws above DRAW_THRESHOLD, refuses below', () => {
  const draw = fakeGrid({ conf: DRAW_THRESHOLD + 0.1, detA: 6, detB: 6, pitchA: 60, pitchB: 60 });
  const weak = fakeGrid({ conf: DRAW_THRESHOLD - 0.1, detA: 6, detB: 6, pitchA: 60, pitchB: 60 });
  assert.equal(isGridReliable(draw.info), true);
  assert.equal(isGridReliable(weak.info), false, 'below the threshold → not drawn');
});

test('isGridReliable: hard guards override even a high score', () => {
  // A confirmed sub-pitch is never a grid, whatever the score.
  const deg = fakeGrid({ conf: 0.95, detA: 12, detB: 12, pitchA: 60, pitchB: 60, degenerate: true });
  assert.equal(isGridReliable(deg.info), false, 'degenerate → never drawn');
  // A single-line "axis" is a line, not a grid.
  const oneLine = fakeGrid({ conf: 0.95, detA: 12, detB: 1, pitchA: 60, pitchB: 60 });
  assert.equal(isGridReliable(oneLine.info), false, '< 2 lines on an axis → never drawn');
});

// --- betterPair (Fix 1: the H-vs-identity rectification choice) ---------------

test('betterPair: the higher-confidence pair wins, confidence dominates line count', () => {
  assert.equal(betterPair({ confidence: 0.4, minCount: 3 }, { confidence: 0.1, minCount: 9 }), true);
  assert.equal(betterPair({ confidence: 0.1, minCount: 9 }, { confidence: 0.4, minCount: 3 }), false);
});

test('betterPair: a collapsed H-fit (confidence 0) is replaced by a recovered identity fit', () => {
  // Symptom A: H smeared one family to ~2 lines → confidence 0; identity recovers the grid.
  const collapsed = { confidence: 0, minCount: 2 };
  const recovered = { confidence: 0.5, minCount: 9 };
  assert.equal(betterPair(recovered, collapsed), true, 'the recovered fit is kept');
});

test('betterPair: on a confidence tie the fuller grid (higher min count) wins', () => {
  assert.equal(betterPair({ confidence: 0.3, minCount: 10 }, { confidence: 0.3, minCount: 6 }), true);
  assert.equal(betterPair({ confidence: 0.3, minCount: 6 }, { confidence: 0.3, minCount: 10 }), false);
});

test('betterPair: a correct H-fit is NOT displaced by a weaker (smeared) identity fit', () => {
  // When the H-fit is clearly stronger (identity smeared the perspective grid → lower
  // confidence), identity does not displace it — the working case is preserved here.
  const hFit = { confidence: 0.7, minCount: 12 };
  const identitySmeared = { confidence: 0.2, minCount: 4 };
  assert.equal(betterPair(identitySmeared, hFit), false, 'the good H-fit stays');
});
