// Pure-geometry checks for the tactical overlay math (homography + PF2e areas).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  unitToCells,
  solveHomography,
  applyH,
  makeGridMap,
  pf2eDist,
  burstDist,
  areaCells,
  moveCells,
  movePaths,
  movePareto,
  shortestRoutes,
  shortestRoute,
  snapLineAngle,
  lineAngles,
  fixedAngles,
  threatCells,
  type AreaOverlay,
  type MoveOverlay,
} from '../src/overlays.ts';
import type { Line2 } from '../src/grid-detector.ts';

test('unit conversion: 1 cell = 1.5 m = 5 ft', () => {
  assert.equal(unitToCells(3, 'q'), 3);
  assert.ok(Math.abs(unitToCells(3, 'm') - 2) < 1e-9);
  assert.ok(Math.abs(unitToCells(15, 'ft') - 3) < 1e-9);
});

test('solveHomography recovers an identity map', () => {
  const pts: [number, number][] = [[0, 0], [10, 0], [10, 8], [0, 8], [5, 4]];
  const H = solveHomography(pts, pts)!;
  for (const [x, y] of pts) {
    const [u, v] = applyH(H, x, y);
    assert.ok(Math.abs(u - x) < 1e-6 && Math.abs(v - y) < 1e-6);
  }
});

function flatGrid(nI: number, nJ: number): { A: Line2[]; B: Line2[] } {
  const A: Line2[] = [];
  const B: Line2[] = [];
  for (let i = 0; i < nI; i++) A.push({ nx: 1, ny: 0, d: 100 + i * 70 });
  for (let j = 0; j < nJ; j++) B.push({ nx: 0, ny: 1, d: 80 + j * 60 });
  return { A, B };
}

test('grid<->image mapping round-trips on a flat grid', () => {
  const { A, B } = flatGrid(6, 5);
  const gm = makeGridMap(A, B)!;
  for (const [i, j] of [[0, 0], [3, 2], [5, 4]] as [number, number][]) {
    const [x, y] = gm.toImage(i, j);
    assert.ok(Math.abs(x - (100 + i * 70)) < 1e-3 && Math.abs(y - (80 + j * 60)) < 1e-3);
    const [a, b] = gm.toGrid(x, y);
    assert.ok(Math.abs(a - i) < 1e-3 && Math.abs(b - j) < 1e-3);
  }
});

test('PF2e diagonal distance: 1,3,4,6,7,9…', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((k) => pf2eDist(0, 0, k, k)), [1, 3, 4, 6, 7, 9]);
});

const area = (o: Partial<AreaOverlay>): AreaOverlay => ({
  kind: 'area',
  type: 'emanazione',
  cell: [5, 5],
  corner: [5, 5],
  sizeCells: 1,
  angleDeg: 0,
  creatureCells: 1,
  ...o,
});

test('emanation uses alternating diagonals: R=1 → 3×3, R=2 → 5×5 with cut corners', () => {
  assert.equal(areaCells(area({ type: 'emanazione', sizeCells: 1 }), 20, 20).length, 9);
  // R=2 is a 5×5 minus its four corners (they cost 3 by the diagonal rule) = 21.
  assert.equal(areaCells(area({ type: 'emanazione', sizeCells: 2 }), 20, 20).length, 21);
  // Large creature (2×2) with a 5-ft (R=1) emanation → 4×4 (corners are 1 away).
  assert.equal(
    areaCells(area({ type: 'emanazione', sizeCells: 1, creatureCells: 2 }), 20, 20).length,
    16,
  );
  // Large creature (2×2) with a 10-ft (R=2) emanation → 6×6 minus corners = 32.
  assert.equal(
    areaCells(area({ type: 'emanazione', sizeCells: 2, creatureCells: 2 }), 20, 20).length,
    32,
  );
});

test('burst from a corner: R=1 → 2×2, R=2 → cross(12); diagonal counts 3', () => {
  assert.equal(burstDist(5, 5, 5, 5), 1); // cell touching the corner
  assert.equal(burstDist(5, 5, 6, 6), 3); // diagonal-out cell costs 3
  assert.equal(areaCells(area({ type: 'esplosione', sizeCells: 1 }), 20, 20).length, 4);
  assert.equal(areaCells(area({ type: 'esplosione', sizeCells: 2 }), 20, 20).length, 12);
});

test('diagonal cone = a burst quadrant (right-triangle staircase)', () => {
  const cells = areaCells(area({ type: 'cono', sizeCells: 3, angleDeg: 45 }), 20, 20);
  assert.equal(cells.length, 6); // 1+2+3
  const set = new Set(cells.map(([i, j]) => `${i},${j}`));
  assert.ok(set.has('7,4'), 'reaches ahead');
  assert.ok(!set.has('4,6'), 'nothing behind');
});

test('even orthogonal cone widens 2,4,6,8 (matches the 30-ft template)', () => {
  // From intersection [8,8], pointing up (angle 0). R=6 → 2,4,6,8,6,2.
  const c6 = areaCells(area({ type: 'cono', sizeCells: 6, angleDeg: 0, corner: [8, 8] }), 40, 40);
  assert.equal(c6.length, 28);
  const width = (jj: number) => c6.filter(([, j]) => j === jj).length;
  assert.deepEqual([7, 6, 5, 4, 3, 2].map(width), [2, 4, 6, 8, 6, 2]);
  assert.ok(!c6.some(([, j]) => j >= 8), 'nothing behind the origin');
});

test('cone radiates from the fixed chosen intersection at any angle', () => {
  // `cell` is deliberately bogus to prove the cone uses `corner` (the chosen
  // intersection) as its origin, and that rotating never moves that origin.
  const c = (ang: number) =>
    areaCells(area({ type: 'cono', sizeCells: 6, angleDeg: ang, corner: [10, 10], cell: [3, 3] }), 40, 40);
  const up = c(0);
  assert.ok(up.every(([, j]) => j <= 9), 'up cone stays above the corner row');
  assert.ok(up.some(([i, j]) => (i === 9 || i === 10) && j === 9), 'touches the corner');
  // Rotate to 90°: same origin corner, cone now points the other way.
  const right = c(90);
  assert.ok(right.every(([i]) => i >= 10), 'right cone stays past the corner column');
  assert.ok(right.some(([i, j]) => i === 10 && (j === 9 || j === 10)), 'still the same corner');
});

test('short orthogonal cone starts from the intersection (2,4,2)', () => {
  // A 15-ft orthogonal cone from the intersection is 2,4,2 (not the book's
  // cell-centred 1,3,3 — a deliberate simplification: cones start at a corner).
  const c3 = areaCells(area({ type: 'cono', sizeCells: 3, angleDeg: 0, corner: [8, 8] }), 40, 40);
  assert.equal(c3.length, 8);
  const width = (jj: number) => c3.filter(([, j]) => j === jj).length;
  assert.deepEqual([7, 6, 5].map(width), [2, 4, 2]);
});

test('line length counts PF2e diagonals (6q → 6 straight, 4 diagonal)', () => {
  // Straight line: exactly R cells from the origin cell.
  const straight = areaCells(area({ type: 'linea', cell: [15, 20], sizeCells: 6, angleDeg: 90 }), 60, 60);
  assert.equal(straight.length, 6, `straight ${straight.length}`);
  // 45° diagonal: alternating 1/2 cost → 1,3,4,6 → 4 cells for a 6q line.
  const diag = areaCells(area({ type: 'linea', cell: [15, 20], sizeCells: 6, angleDeg: 45 }), 60, 60);
  assert.equal(diag.length, 4, `diagonal ${diag.length}`);
  // The origin cell is included and the line is a connected 1-wide chain.
  const set = new Set(diag.map(([i, j]) => `${i},${j}`));
  assert.ok(set.has('15,20'), 'starts from the selected cell');
});

test('fixed mode snaps a line to the 4 book slopes (same for every length)', () => {
  const D = (r: number) => (r * 180) / Math.PI;
  const octant = [0, D(Math.atan(1 / 3)), D(Math.atan(1 / 2)), 45].map((a) => Math.round(a * 100) / 100);
  // Exactly four orientations per octant (0..45), independent of length: a shorter
  // line is the same staircase truncated (6q [2,2,1] ⊂ 12q [2,2,2,2,2]).
  assert.deepEqual(lineAngles(6).filter((a) => a <= 45).map((a) => Math.round(a * 100) / 100), octant);
  assert.deepEqual(lineAngles(12).filter((a) => a <= 45).map((a) => Math.round(a * 100) / 100), octant);
  // Shallow is 1:3 (~18.4°), steep is 1:2 (~26.6°) — for both lengths.
  assert.ok(Math.abs(snapLineAngle(20, 6) - D(Math.atan(1 / 3))) < 0.1);
  assert.ok(Math.abs(snapLineAngle(29, 6) - D(Math.atan(1 / 2))) < 0.1);
  assert.ok(Math.abs(snapLineAngle(29, 12) - D(Math.atan(1 / 2))) < 0.1);
  // Nothing snaps to the in-between corners any more (e.g. no ~9.5°/~31° rung).
  assert.ok(!lineAngles(6).some((a) => Math.abs(a - 9.46) < 0.5 || Math.abs(a - 30.96) < 0.5));
  assert.equal(snapLineAngle(2, 6), 0);
  assert.equal(snapLineAngle(44, 6), 45);
});

test('line staircases match the book (same shape, shorter for 6q)', () => {
  const runs = (size: number, slope: number) => {
    const o: AreaOverlay = {
      kind: 'area', type: 'linea', cell: [30, 30], corner: [30, 30],
      sizeCells: size, angleDeg: 90 - slope, creatureCells: 1,
    };
    const byRow = new Map<number, number>();
    for (const [, j] of areaCells(o, 90, 90)) byRow.set(j, (byRow.get(j) ?? 0) + 1);
    return [...byRow.keys()].sort((a, b) => Math.abs(a - 30) - Math.abs(b - 30)).map((r) => byRow.get(r)!);
  };
  const D = (r: number) => (r * 180) / Math.PI;
  assert.deepEqual(runs(6, D(Math.atan(1 / 3))), [3, 3]);
  assert.deepEqual(runs(12, D(Math.atan(1 / 3))), [3, 3, 3, 2]);
  assert.deepEqual(runs(6, D(Math.atan(1 / 2))), [2, 2, 1]);
  assert.deepEqual(runs(12, D(Math.atan(1 / 2))), [2, 2, 2, 2, 2]);
});

test('cone fixed angles are the 8 grid directions; emanation/burst have none', () => {
  assert.deepEqual(fixedAngles('cono', 6), [0, 45, 90, 135, 180, 225, 270, 315]);
  assert.deepEqual(fixedAngles('emanazione', 2), []);
  assert.deepEqual(fixedAngles('esplosione', 2), []);
});

test('threat area = the creature reach ring (alt-diagonal), own space excluded', () => {
  // Medium (1×1) at (5,5): reach 1 → the 8 surrounding cells.
  const t1 = threatCells(5, 5, 1, 20, 20);
  assert.equal(t1.length, 8);
  const s = new Set(t1.map(([i, j]) => `${i},${j}`));
  assert.ok(s.has('6,6') && s.has('4,4') && s.has('5,4'), 'diagonal + orthogonal neighbours');
  assert.ok(!s.has('5,5'), 'excludes its own cell');
  // Large (2×2) at (5,5): reach 2 → a bigger ring, still excluding the 2×2 block.
  const t2 = threatCells(5, 5, 2, 20, 20);
  assert.ok(t2.length > t1.length, 'larger creature threatens more');
  assert.ok(!t2.some(([i, j]) => i >= 5 && i <= 6 && j >= 5 && j <= 6), 'excludes its own block');
});

test('movement is blocked by enemy squares (excluded + detoured around)', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [5, 5], speedCells: 10, moves: 1, creatureCells: 1 };
  const wall = new Set(['6,4', '6,5', '6,6']);
  const blocked = new Set(moveCells(mv, 16, 16, { impassable: wall }).map((c) => `${c.i},${c.j}`));
  for (const e of wall) assert.ok(!blocked.has(e), `enemy square ${e} is not reachable`);
  assert.ok(blocked.has('7,5'), 'the cell past the wall is still reachable by going around');
});

test('same-side squares are passable (occupied) but opposite-side squares block', () => {
  // A full-height wall at column 6 — no way around it.
  const mv: MoveOverlay = { kind: 'move', cell: [2, 7], speedCells: 30, moves: 1, creatureCells: 1 };
  const wall = new Set(Array.from({ length: 15 }, (_, j) => `6,${j}`));
  // As opposite-side (impassable): nothing beyond the wall is reachable.
  const blocked = new Set(moveCells(mv, 16, 16, { impassable: wall }).map((c) => `${c.i},${c.j}`));
  assert.ok(!blocked.has('8,7'), 'a wall of enemies cannot be passed');
  // As same-side (occupied): you pass THROUGH to the far side, but can't stop on it.
  const through = new Set(moveCells(mv, 16, 16, { occupied: wall }).map((c) => `${c.i},${c.j}`));
  assert.ok(through.has('8,7'), 'you move through friendly squares to the far side');
  assert.ok(!through.has('6,7'), 'but you cannot stop on a friendly square');
});

test('shortestRoutes returns the direct routes + cost; dodging threat costs more', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [5, 5], speedCells: 10, moves: 1, creatureCells: 1 };
  const direct = shortestRoutes(mv, 16, 16, [8, 5]);
  assert.ok(direct, 'target reachable');
  assert.equal(direct!.cost, 3, 'three orthogonal steps');
  const set = new Set(direct!.cells.map(([i, j]) => `${i},${j}`));
  assert.ok(set.has('5,5') && set.has('8,5'), 'includes the start and target');
  assert.ok(!set.has('5,8'), 'no superfluous wide-arc cells');
  // A wall of threat on the straight line → the dodging route is longer (more cost).
  const threat = new Set(['6,5', '7,5']);
  const dodge = shortestRoutes(mv, 16, 16, [8, 5], { impassable: threat });
  assert.ok(dodge, 'a detour around the threat still reaches the target');
  assert.ok(dodge!.cost > direct!.cost, 'dodging the threat costs more than the direct route');
  // Unreachable within budget → null.
  assert.equal(shortestRoutes({ ...mv, speedCells: 1, moves: 1 }, 16, 16, [13, 13]), null);
});

test('shortestRoute returns ONE ordered, contiguous minimum route', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [5, 5], speedCells: 10, moves: 1, creatureCells: 1 };
  const r = shortestRoute(mv, 16, 16, [9, 5]);
  assert.ok(r, 'reachable');
  const cells = r!.cells;
  // starts on the creature block, ends on the target.
  assert.deepEqual(cells[cells.length - 1], [9, 5], 'ends at the target');
  assert.deepEqual(cells[0], [5, 5], 'starts at the source');
  // each step moves to an adjacent cell (Chebyshev distance 1) — a real contiguous path.
  for (let k = 1; k < cells.length; k++) {
    const dx = Math.abs(cells[k][0] - cells[k - 1][0]);
    const dy = Math.abs(cells[k][1] - cells[k - 1][1]);
    assert.ok(Math.max(dx, dy) === 1, `step ${k} is to an adjacent cell`);
  }
  // It is a SINGLE route, far narrower than the full DAG of all shortest routes.
  const all = shortestRoutes(mv, 16, 16, [9, 5])!.cells.length;
  assert.ok(cells.length <= all, 'one route is a subset of all routes');
  assert.equal(cells.length, r!.cost + 1, 'a 1-step-per-cell straight route here');
  assert.equal(shortestRoute({ ...mv, speedCells: 1, moves: 1 }, 16, 16, [13, 13]), null);
});

test('movePareto trades movements for fewer THREATENING CREATURES (Pareto frontier)', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [2, 4], speedCells: 2, moves: 5, creatureCells: 1 };
  // Two short "walls" (creatures A, B) across the straight line (2,4)→(8,4); each is
  // short enough to walk around above/below.
  const A = new Set(['4,3', '4,4', '4,5']);
  const B = new Set(['6,3', '6,4', '6,5']);
  const routes = movePareto(mv, 16, 16, [8, 4], 5, [A, B]);
  assert.ok(routes.length >= 2, 'a fastest route + safer route(s)');
  for (let k = 1; k < routes.length; k++) {
    assert.ok(routes[k].move > routes[k - 1].move, 'movements strictly increase');
    assert.ok(routes[k].threats < routes[k - 1].threats, 'fewer creatures each step');
  }
  assert.equal(routes[0].threats, 2, 'the direct route is threatened by BOTH creatures');
  assert.equal(routes[routes.length - 1].threats, 0, 'a wide detour meets no creature');
  for (const r of routes) assert.deepEqual(r.cells[r.cells.length - 1], [8, 4], 'reaches the target');
  // No creatures → the single fastest route. Unreachable → empty.
  assert.equal(movePareto(mv, 16, 16, [8, 4], 5, []).length, 1);
  assert.deepEqual(movePareto({ ...mv, speedCells: 1, moves: 1 }, 16, 16, [13, 13], 5, [A, B]), []);
});

test('movePareto counts each creature ONCE, and the start square counts', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [2, 4], speedCells: 2, moves: 5, creatureCells: 1 };
  // ONE creature threatening the whole corridor: crossing its 5 cells still = 1.
  const corridor = new Set(['3,4', '4,4', '5,4', '6,4', '7,4']);
  const r = movePareto(mv, 16, 16, [8, 4], 5, [corridor]);
  assert.equal(r[0].threats, 1, 'many cells of one creature count as 1');
  assert.equal(r[r.length - 1].threats, 0, 'and a detour avoids it entirely');
  // The mover STARTS inside creature C → C counts on every route (you move out of it).
  const C = new Set(['1,4', '2,4', '3,4', '2,3', '2,5']);
  const rc = movePareto(mv, 16, 16, [8, 4], 5, [C]);
  assert.ok(rc.length >= 1 && rc.every((x) => x.threats >= 1), 'the start creature always counts');
});

test('movePaths returns the cells on a shortest path to the target', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [5, 5], speedCells: 10, moves: 1, creatureCells: 1 };
  const s = new Set(movePaths(mv, 16, 16, [8, 5]).map(([i, j]) => `${i},${j}`));
  assert.ok(s.has('5,5') && s.has('8,5'), 'includes the start and the target');
  // Out of budget → no path.
  assert.deepEqual(movePaths({ ...mv, speedCells: 1 }, 16, 16, [13, 13]), []);
});

test('movement bands by PF2e cost / speed (from the creature block)', () => {
  const mv: MoveOverlay = { kind: 'move', cell: [5, 5], speedCells: 1, moves: 3, creatureCells: 1 };
  const byCell = new Map(moveCells(mv, 16, 16).map((c) => [`${c.i},${c.j}`, c.move]));
  assert.equal(byCell.get('6,5'), 1);
  assert.equal(byCell.get('6,6'), 1); // diagonal cost 1
  assert.equal(byCell.get('7,7'), 3); // diagonal cost 4 → excluded; cost 3 at 2 diagonals
  assert.ok(!byCell.has('5,5'), 'origin excluded');
  assert.ok(!byCell.has('9,9'), 'cost 6 (>3 moves) excluded');
});
