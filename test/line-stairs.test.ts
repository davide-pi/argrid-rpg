// The LINE template's staircase, checked as a shape rule rather than cell-by-cell.
//
// A line may only be drawn with the two book steps — a run of 3 cells (the 1:3 slope)
// or a run of 2 (the 1:2 slope) — plus the two degenerate cases (straight, and the 45°
// diagonal whose runs are 1). Runs are all the same length, the LAST one may be cut
// short when the length runs out (3-3-2, 3-3-1, 2-2-1 are fine), and consecutive runs
// must never overlap: two adjacent rows may not share a column.
//
//   [ ][ ][X][X]      [ ][X][X][ ]
//   [X][X][ ][ ]  OK  [X][X][ ][ ]  NOT OK (column 1 is in both rows)
//
// This has to hold for EVERY length — area sizes are free (1 q steps), not a preset
// list — so the check sweeps every fixed angle against every length.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { areaCells, lineAngles, type AreaOverlay } from '../src/overlays.ts';

const N = 61; // nodes per side → a 60×60 cell board, big enough for any length below
const O = 30; // origin cell, centred so no length ever clips on an edge

function lineOf(angleDeg: number, sizeCells: number): Array<[number, number]> {
  const area: AreaOverlay = {
    kind: 'area',
    type: 'linea',
    cell: [O, O],
    corner: [O, O],
    sizeCells,
    angleDeg,
    creatureCells: 1,
  };
  return areaCells(area, N, N);
}

/** The staircase's runs: the cells grouped by the row (or column) they sit in, ordered
 * along the line, each run given as [min, max] on the dominant axis. */
function runsOf(cells: Array<[number, number]>): { runs: Array<[number, number]>; across: number[] } {
  const di = Math.max(...cells.map((c) => c[0])) - Math.min(...cells.map((c) => c[0]));
  const dj = Math.max(...cells.map((c) => c[1])) - Math.min(...cells.map((c) => c[1]));
  const alongX = di >= dj; // dominant axis (45° is a tie → group by row, runs of 1)
  const groups = new Map<number, number[]>();
  for (const [i, j] of cells) {
    const across = alongX ? j : i;
    const along = alongX ? i : j;
    (groups.get(across) ?? groups.set(across, []).get(across)!).push(along);
  }
  // Order the rows the way the line walks them: the origin's row first.
  const originAcross = alongX ? O : O;
  const keys = [...groups.keys()].sort((a, b) => Math.abs(a - originAcross) - Math.abs(b - originAcross));
  return {
    runs: keys.map((k) => {
      const v = groups.get(k)!;
      return [Math.min(...v), Math.max(...v)] as [number, number];
    }),
    across: keys,
  };
}

function assertStaircase(angleDeg: number, sizeCells: number) {
  const cells = lineOf(angleDeg, sizeCells);
  const where = `angle ${angleDeg.toFixed(2)}°, ${sizeCells}q`;
  assert.ok(cells.length > 0, `${where}: the line covers no cell`);
  // No cell twice.
  assert.equal(new Set(cells.map((c) => c.join(','))).size, cells.length, `${where}: duplicate cells`);

  const { runs, across } = runsOf(cells);
  const len = (r: [number, number]) => r[1] - r[0] + 1;

  // Every row is a CONTIGUOUS run (no gaps inside a step).
  const total = runs.reduce((s, r) => s + len(r), 0);
  assert.equal(total, cells.length, `${where}: a step has a hole in it`);

  // Rows are walked one after the other, without skipping any.
  for (let k = 1; k < across.length; k++)
    assert.equal(Math.abs(across[k] - across[k - 1]), 1, `${where}: the staircase skips a row`);

  // A straight line is a single run of any length — nothing to step.
  if (runs.length === 1) return;

  // Otherwise only the two book steps (or the degenerate 1 of the 45° diagonal), and
  // the first run is a FULL step.
  const step = len(runs[0]);
  assert.ok([1, 2, 3].includes(step), `${where}: step of ${step} cells is not a book step`);

  for (let k = 1; k < runs.length; k++) {
    const l = len(runs[k]);
    const last = k === runs.length - 1;
    // Same step everywhere; only the LAST one may be cut short (3-3-2, 2-2-1, …).
    if (last) assert.ok(l <= step, `${where}: last step ${l} > ${step}`);
    else assert.equal(l, step, `${where}: step ${k} is ${l} cells, expected ${step}`);
    // …and steps never overlap: consecutive rows share no column.
    const prev = runs[k - 1];
    const cur = runs[k];
    const overlaps = cur[0] <= prev[1] && prev[0] <= cur[1];
    assert.ok(!overlaps, `${where}: steps ${k - 1} and ${k} overlap (${prev} / ${cur})`);
  }
}

test('line staircases use only the 2- and 3-cell steps, truncated but never overlapping', () => {
  for (const angle of lineAngles()) for (let R = 1; R <= 20; R++) assertStaircase(angle, R);
});

test('the book lengths keep their documented steps', () => {
  const D = (r: number) => (r * 180) / Math.PI;
  const stepsOf = (angle: number, R: number) =>
    runsOf(lineOf(angle, R)).runs.map((r) => r[1] - r[0] + 1);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 3)), 6), [3, 3]);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 3)), 12), [3, 3, 3, 2]);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 2)), 6), [2, 2, 1]);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 2)), 12), [2, 2, 2, 2, 2]);
  // A free (non-preset) length is just the same staircase cut short. Where it stops is
  // driven by the PF2e COST, so the second diagonal (which costs 2) eats two of the
  // length: 8q gets a third step, 7q does not.
  assert.deepEqual(stepsOf(D(Math.atan(1 / 3)), 8), [3, 3, 1]);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 3)), 7), [3, 3]);
  assert.deepEqual(stepsOf(D(Math.atan(1 / 2)), 4), [2, 2]);
  assert.deepEqual(stepsOf(0, 5), [5]);
  assert.deepEqual(stepsOf(45, 4), [1, 1, 1]); // the diagonal: runs of one, 1+1+2 = 4q
});
