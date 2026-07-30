// Phase 3 (periodicPitch A/B flag) — pure-geometry tests. No OpenCV: combPitch is a pure function,
// and buildGrid takes raw Hough lines directly, so a synthetic PERSPECTIVE grid (world square grid →
// homography → (rho,thetaDeg) lines) exercises the rectify-stability + comb fit fully in CI.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildGrid, combPitch, DEFAULT_PARAMS, type RawLine } from '../src/grid-detector.ts';

const DEG = 180 / Math.PI;
const CURE = { ...DEFAULT_PARAMS, periodicPitch: true, extend: 'off' as const };

// --- combPitch (Phase 3b): the fill-weighted comb kills the sub-pitch ---------------------------

test('combPitch: prefers the fundamental over the sub-pitch (duplicates present)', () => {
  // A clean pitch-100 lattice plus two near-duplicate lines. The bare comb |S| is EQUAL at p=50
  // (every point still lands on the ×2-finer lattice), so a naive argmax would return 50 — the
  // sub-pitch bug. The fillRatio weight demotes 50 (half its slots empty) → p*≈100.
  const offsets = [0, 0.5, 100, 100.5, 200, 300, 400];
  const { pitch } = combPitch(offsets, 100);
  assert.ok(Math.abs(pitch - 100) < 2, `p*≈100, not the sub-pitch — got ${pitch}`);
});

test('combPitch: a missing interior line (harmonic) still picks the fundamental', () => {
  // {0,100,200,300}: |S| is equal at 100 and 50; fillRatio (1.0 vs ~0.57) breaks the tie for 100.
  const { pitch } = combPitch([0, 100, 200, 300], 100);
  assert.ok(Math.abs(pitch - 100) < 2, `harmonic → fundamental 100, got ${pitch}`);
});

test('combPitch: robust to 40% occlusion (does not over-coarsen)', () => {
  // 7-line lattice with 3 lines dropped (~43% gone). The surviving lines still pin pitch≈100 — the
  // comb must neither lock a sub-pitch nor coarsen up to 200/300 (where |S| collapses).
  const { pitch } = combPitch([0, 100, 300, 600], 100);
  assert.ok(Math.abs(pitch - 100) < 3, `occluded lattice still ≈100, got ${pitch}`);
});

test('combPitch: recovers the phase (anchor) of a shifted lattice', () => {
  // Lattice shifted by +37 → the anchor a* = (φ/2π)·p* (mod p*) must come back to ≈37.
  const { anchor, pitch } = combPitch([37, 137, 237, 337], 100);
  assert.ok(Math.abs(pitch - 100) < 2, `pitch ≈100, got ${pitch}`);
  assert.ok(Math.abs(anchor - 37) < 2, `anchor ≈37 (mod pitch), got ${anchor}`);
});

test('combPitch: climbs UP from a sub-pitch seed to the fundamental', () => {
  // Seeded at the sub-pitch 50, the search window [25,110] still reaches 100 and the fill weight
  // pulls the answer up — this is the exact recovery the perspective smear needs.
  const { pitch } = combPitch([0, 100, 200, 300, 400], 50);
  assert.ok(Math.abs(pitch - 100) < 3, `climbs from seed 50 to ≈100, got ${pitch}`);
});

test('combPitch: a broadband (non-periodic) set has a low peakRatio', () => {
  // Irregular offsets → no sharp periodic peak → peakRatio near 1 (a real grid is ≫1).
  const noisy = [0, 17, 39, 46, 88, 133, 140, 205];
  const grid = [0, 100, 200, 300, 400, 500, 600];
  assert.ok(combPitch(grid, 100).peakRatio > combPitch(noisy, 40).peakRatio, 'grid peak sharper than noise');
});

// --- synthetic PERSPECTIVE grid (Phase 3a/3c) ---------------------------------------------------

// 3x3 (row-major) * column vector.
function matVec(m: number[], v: number[]): number[] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// Inverse-transpose of a 3x3 (lines map as l' = H^{-T}·l when points map x' = H·x).
function invTranspose3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
  const s = 1 / det;
  const inv = [A * s, D * s, G * s, B * s, E * s, Hh * s, C * s, F * s, I * s];
  return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
}

// Image line [a,b,c] (a·x+b·y+c=0) → Hough (rho, thetaDeg∈[0,180)), matching toLine2's convention.
function lineToRaw(a: number, b: number, c: number): RawLine {
  const norm = Math.hypot(a, b) || 1;
  const nx = a / norm, ny = b / norm, d = -c / norm;
  const thetaDeg = (((Math.atan2(ny, nx) * DEG) % 180) + 180) % 180;
  const dot = Math.cos(thetaDeg / DEG) * nx + Math.sin(thetaDeg / DEG) * ny; // ±1
  return { rho: d * dot, thetaDeg };
}

/**
 * A world-space SQUARE grid (n×n lines, pitch `s`) photographed under a perspective homography
 * `x = scaleImg·X/den + cx`, `y = scaleImg·Y/den + cy`, `den = kx·X + k·Y + 1`. Returns the two
 * families' image lines as (rho,thetaDeg) — feed straight to buildGrid. `k`/`kx` set perspective
 * strength (0 = fronto-parallel); larger pushes the horizon toward the grid.
 */
function syntheticPerspectiveGrid(opts: {
  n: number;
  s: number;
  k: number;
  kx?: number;
  scaleImg: number;
  cx: number;
  cy: number;
}): RawLine[] {
  const { n, s, k, kx = 0, scaleImg, cx, cy } = opts;
  const H = [
    scaleImg + cx * kx, cx * k, cx,
    cy * kx, scaleImg + cy * k, cy,
    kx, k, 1,
  ];
  const Hit = invTranspose3(H);
  const out: RawLine[] = [];
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const c = (i - half) * s;
    const la = matVec(Hit, [1, 0, -c]); // world vertical X=c
    out.push(lineToRaw(la[0], la[1], la[2]));
    const lb = matVec(Hit, [0, 1, -c]); // world horizontal Y=c
    out.push(lineToRaw(lb[0], lb[1], lb[2]));
  }
  return out;
}

test('perspective (far horizon): the rectify is trusted and the pitch is correct', () => {
  // Clear one-point perspective, horizon well beyond the grid → the rectify is trusted (small κ),
  // the comb fits a clean pitch: no degenerate collapse, both families come back in full, and the
  // recovered image pitch (~80 at the grid centre) is correct.
  const raw = syntheticPerspectiveGrid({ n: 7, s: 1, k: 0.05, scaleImg: 80, cx: 500, cy: 500 });
  const r = buildGrid(raw, 1, 1000, 1000, CURE);
  assert.equal(r.info.degenerate, false, 'a real perspective grid is not degenerate');
  assert.ok(r.info.detectedA >= 6 && r.info.detectedB >= 6, `both families recovered, got ${r.info.detectedA}×${r.info.detectedB}`);
  assert.ok(r.info.confidence > 0.4, `confidence clears the draw bar, got ${r.info.confidence}`);
  assert.ok(Math.abs(r.info.spacingA - 80) < 10 && Math.abs(r.info.spacingB - 80) < 10, `pitch ≈80, got ${r.info.spacingA.toFixed(1)}×${r.info.spacingB.toFixed(1)}`);
});

test('strong perspective: the cure recovers where the baseline collapses (anti-collapse)', () => {
  // Strong two-point perspective drives the estimated horizon toward the grid band, smearing the
  // rectified offsets. WITHOUT the cure the fit collapses to a ~2×2 sub-pitch (the root-cause bug).
  // WITH the cure the κ gate falls back to identity and the comb recovers a real lattice: not
  // degenerate, and strictly more lines than the collapsed baseline.
  const raw = syntheticPerspectiveGrid({ n: 11, s: 1, k: 0.2, kx: 0.1, scaleImg: 80, cx: 500, cy: 500 });
  const on = buildGrid(raw, 1, 1000, 1000, CURE);
  const off = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, periodicPitch: false, extend: 'off' });
  assert.equal(on.info.degenerate, false, 'the cure must not collapse to a sub-pitch');
  assert.ok(on.info.detectedA >= 6 && on.info.detectedB >= 6, `a full lattice is recovered, got ${on.info.detectedA}×${on.info.detectedB}`);
  assert.ok(on.info.spacingA > 0 && on.info.spacingB > 0, 'a positive pitch is recovered on both axes');
  assert.ok(
    on.info.detectedA + on.info.detectedB > off.info.detectedA + off.info.detectedB,
    `the cure recovers more lines than the collapsing baseline (${on.info.detectedA}+${on.info.detectedB} vs ${off.info.detectedA}+${off.info.detectedB})`,
  );
});

test('periodicPitch OFF leaves a fronto-parallel fit unchanged', () => {
  // Anti-regression: with the flag OFF the cure is inert — same result as the default path.
  const raw = syntheticPerspectiveGrid({ n: 8, s: 1, k: 0, scaleImg: 90, cx: 500, cy: 500 });
  const off = buildGrid(raw, 1, 1000, 1000, { ...DEFAULT_PARAMS, extend: 'off' });
  const on = buildGrid(raw, 1, 1000, 1000, CURE);
  // A fronto-parallel grid has no perspective, so the cure changes nothing observable here.
  assert.equal(on.info.detectedA, off.info.detectedA, 'same family-A count');
  assert.equal(on.info.detectedB, off.info.detectedB, 'same family-B count');
  assert.ok(Math.abs(on.info.spacingA - off.info.spacingA) < 1e-6, 'same pitch A');
});
