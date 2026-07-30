// Pure-logic tests for the two image-consultation cores added for the faint/perspective bottleneck:
//   - profilePitch:          rectified-plane projection-profile pitch (Metodo #1), autocorrelation.
//   - intersectionConsensus: corner-channel grid verification (Metodo #2).
// Both are pure (no OpenCV): the CV wiring that builds the profile / detects corners is measured in
// the browser on the corpus. These pin the ALGORITHM (recovers pitch/phase, avoids sub-pitch, rejects
// texture) — absolute thresholds stay calibrated on real photos.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  profilePitch,
  PROFILE_MIN_STRENGTH,
  intersectionConsensus,
  lineCoverage,
  type Line2,
} from '../src/grid-detector.ts';

// Deterministic LCG so "noise" tests are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Synthesize a 1-D projection profile: Gaussian bumps of unit height at offset = anchor0 + k·P,
// over [0, N·binSize), plus optional uniform noise. binSize = 1, minOffset = 0.
function combProfile(N: number, P: number, anchor0: number, sigma: number, noise = 0, seed = 1): number[] {
  const rand = rng(seed);
  const prof = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const off = i + 0.5;
    // nearest lattice node
    const k = Math.round((off - anchor0) / P);
    const node = anchor0 + k * P;
    const d = off - node;
    prof[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    if (noise > 0) prof[i] += noise * rand();
  }
  return prof;
}

function anchorDiff(a: number, b: number, P: number): number {
  let d = ((a - b) % P + P) % P;
  if (d > P / 2) d -= P;
  return d;
}

// --- profilePitch ------------------------------------------------------------

test('profilePitch: recovers pitch and phase of a clean comb', () => {
  const P = 20;
  const anchor0 = 7;
  const prof = combProfile(400, P, anchor0, 1.5);
  const r = profilePitch(prof, 1, 0, /*seed*/ P);
  assert.ok(Math.abs(r.pitch - P) < 0.5, `pitch ${r.pitch} ≈ ${P}`);
  assert.ok(Math.abs(anchorDiff(r.anchor, anchor0, P)) < 1.5, `anchor ${r.anchor} ≈ ${anchor0}`);
  assert.ok(r.strength > PROFILE_MIN_STRENGTH, `strength ${r.strength} high`);
});

test('profilePitch: recovers the fundamental from an OFF seed (climbs from a sub-pitch seed)', () => {
  const P = 24;
  const prof = combProfile(480, P, 5, 1.5);
  // seed = 0.6·P (a sub-pitch guess): the window still brackets the true pitch.
  const r = profilePitch(prof, 1, 0, 0.6 * P);
  assert.ok(Math.abs(r.pitch - P) < 1.0, `pitch ${r.pitch} ≈ ${P} despite low seed`);
});

test('profilePitch: does NOT lock onto half-pitch (no line at P/2)', () => {
  const P = 30;
  const prof = combProfile(450, P, 10, 1.5);
  const r = profilePitch(prof, 1, 0, P);
  assert.ok(r.pitch > 0.75 * P, `pitch ${r.pitch} not a sub-multiple of ${P}`);
});

test('profilePitch: flat / noise-only profile is rejected as non-periodic', () => {
  const rand = rng(42);
  const noise = Array.from({ length: 400 }, () => rand());
  const r = profilePitch(noise, 1, 0, 20);
  assert.ok(r.strength < PROFILE_MIN_STRENGTH, `noise strength ${r.strength} below accept`);
});

test('profilePitch: survives a noisy but genuinely periodic profile', () => {
  const P = 18;
  const prof = combProfile(360, P, 3, 1.2, /*noise*/ 0.35, /*seed*/ 7);
  const r = profilePitch(prof, 1, 0, P);
  assert.ok(Math.abs(r.pitch - P) < 1.0, `pitch ${r.pitch} ≈ ${P} under noise`);
  assert.ok(r.strength > PROFILE_MIN_STRENGTH, `strength ${r.strength} still periodic`);
});

test('profilePitch: degenerate inputs return no pitch', () => {
  assert.equal(profilePitch([], 1, 0, 10).pitch, 0);
  assert.equal(profilePitch([1, 2], 1, 0, 10).pitch, 0);
  assert.equal(profilePitch([1, 2, 3, 4], 0, 0, 10).pitch, 0, 'binSize 0');
  assert.equal(profilePitch([1, 2, 3, 4], 1, 0, 0).pitch, 0, 'seed 0');
});

// --- intersectionConsensus ---------------------------------------------------

// Axis-aligned vertical lines at x = xs (nx=1,ny=0,d=x) and horizontal at y = ys (nx=0,ny=1,d=y).
const vlines = (xs: number[]): Line2[] => xs.map((x) => ({ nx: 1, ny: 0, d: x }));
const hlines = (ys: number[]): Line2[] => ys.map((y) => ({ nx: 0, ny: 1, d: y }));

test('intersectionConsensus: a true grid scores ~1 when crossings sit on corners', () => {
  const xs = [100, 200, 300];
  const ys = [100, 200, 300];
  const corners: { x: number; y: number }[] = [];
  for (const x of xs) for (const y of ys) corners.push({ x, y });
  const r = intersectionConsensus(vlines(xs), hlines(ys), corners, 1000, 1000, 8);
  assert.equal(r.total, 9);
  assert.equal(r.matched, 9);
  assert.equal(r.score, 1);
});

test('intersectionConsensus: periodic texture (no real crossings) scores ~0', () => {
  const xs = [100, 200, 300];
  const ys = [100, 200, 300];
  // Corners scattered OFF every crossing.
  const corners = [{ x: 150, y: 150 }, { x: 250, y: 250 }, { x: 50, y: 350 }];
  const r = intersectionConsensus(vlines(xs), hlines(ys), corners, 1000, 1000, 8);
  assert.equal(r.total, 9);
  assert.equal(r.matched, 0);
  assert.equal(r.score, 0);
});

test('intersectionConsensus: filled/extended lines carry no evidence', () => {
  const xs = vlines([100, 200, 300]);
  xs[1].filled = true; // middle column is interpolated, not detected
  const ys = hlines([100, 200, 300]);
  ys[2].extended = true; // last row is extrapolated
  const corners = [
    { x: 100, y: 100 }, { x: 300, y: 100 },
    { x: 100, y: 200 }, { x: 300, y: 200 },
  ];
  const r = intersectionConsensus(xs, ys, corners, 1000, 1000, 8);
  // Only detected × detected = {100,300} × {100,200} = 4 crossings, all on corners.
  assert.equal(r.total, 4);
  assert.equal(r.matched, 4);
});

test('intersectionConsensus: crossings outside the frame are not counted', () => {
  const xs = vlines([100, 900]);
  const ys = hlines([100, 900]);
  const corners = [{ x: 100, y: 100 }];
  const r = intersectionConsensus(xs, ys, corners, 500, 500, 8);
  // Only (100,100) is inside a 500×500 frame.
  assert.equal(r.total, 1);
  assert.equal(r.matched, 1);
});

test('intersectionConsensus: fewer than 2 lines per family → no score', () => {
  const r = intersectionConsensus(vlines([100]), hlines([100, 200]), [{ x: 100, y: 100 }], 500, 500, 8);
  assert.equal(r.score, 0);
  assert.equal(r.total, 0);
});

// --- lineCoverage (P1: image-support / line coverage) ------------------------

test('lineCoverage: lines with an edge under their whole length score ~1', () => {
  const xs = vlines([100, 200, 300]);
  // Fake edge map: an edge sits exactly under each predicted line offset.
  const near = (x: number) => xs.some((l) => Math.abs(x - l.d) <= 2);
  const r = lineCoverage(xs, 1000, 1000, near, 5);
  assert.ok(r.total > 0, 'samples were taken');
  assert.ok(r.score > 0.95, `score ${r.score} ≈ 1 when the image supports every line`);
});

test('lineCoverage: predicted lines with NO edge under them score ~0', () => {
  const r = lineCoverage(vlines([100, 200, 300]), 1000, 1000, () => false, 5);
  assert.equal(r.score, 0);
  assert.equal(r.covered, 0);
  assert.ok(r.total > 0, 'lines were still sampled');
});

test('lineCoverage: filled/extended lines carry no evidence (ignored)', () => {
  const xs = vlines([100, 200, 300, 400]);
  xs[1].filled = true; // interpolated interior line
  xs[3].extended = true; // extrapolated border line
  // Edges exist ONLY under the two DETECTED lines (100, 300). If the filled/extended lines were
  // (wrongly) sampled they'd contribute frac 0 and drag the median to 0.5 — so score 1 proves they're excluded.
  const near = (x: number) => Math.abs(x - 100) <= 2 || Math.abs(x - 300) <= 2;
  const r = lineCoverage(xs, 1000, 1000, near, 5);
  assert.equal(r.score, 1, `only detected lines counted → score ${r.score}`);
});

test('lineCoverage: fewer than 2 detected lines → zero', () => {
  const xs = vlines([100, 200, 300]);
  xs[0].filled = true;
  xs[2].extended = true; // only one detected line remains
  const r = lineCoverage(xs, 1000, 1000, () => true, 5);
  assert.equal(r.score, 0);
  assert.equal(r.total, 0);
});

test('lineCoverage: the median is robust to a single unsupported line', () => {
  // 5 detected lines; the one at x=500 has no edge under it, the other four are fully supported.
  const xs = vlines([100, 200, 300, 400, 500]);
  const near = (x: number) => x < 450;
  const r = lineCoverage(xs, 1000, 1000, near, 5);
  assert.equal(r.score, 1, `median ignores the one bad line → score ${r.score}`);
  assert.ok(r.covered < r.total, 'global tally still records the unsupported samples');
});
