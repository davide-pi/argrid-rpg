// Tactical (RPG) overlays drawn on the reconstructed grid: areas of effect
// (emanation / burst / line / cone) and movement rings. Shapes are defined in
// GRID coordinates (cells) and mapped to the image through a grid→image
// homography, so they stay correct under perspective. One cell = 1.5 m = 5 ft.

import type { Line2 } from './grid-detector';
import { intersect, invert3x3 } from './geometry';

export type Unit = 'q' | 'm' | 'ft';
export type AreaType = 'emanazione' | 'esplosione' | 'linea' | 'cono';

export interface AreaOverlay {
  kind: 'area';
  type: AreaType;
  cell: [number, number]; // selected cell (emanation, line origin)
  corner: [number, number]; // selected intersection/node (burst, cone origin)
  sizeCells: number;
  angleDeg: number;
  creatureCells: number; // emanation origin block size (1..4)
}
export interface MoveOverlay {
  kind: 'move';
  cell: [number, number];
  speedCells: number;
  moves: number;
  creatureCells: number; // moving creature block size (1..4)
  group?: 'ally' | 'enemy'; // the moving piece's side (drives obstacles + threat shown)
}
export type Overlay = AreaOverlay | MoveOverlay;

/** Fixed-mode size presets (in cells) per area type, from the PF2e templates. */
export const FIXED_SIZES: Record<AreaType, number[]> = {
  emanazione: [1, 2],
  esplosione: [1, 2, 3, 4, 6],
  cono: [3, 6, 12],
  linea: [6, 12],
};

/** Creature sizes and the square block (in cells) each occupies. Minuscola,
 * Piccola and Media all take one cell, so they're grouped into a single option. */
export const CREATURE_SIZES: Array<{ label: string; cells: number }> = [
  { label: 'Media o inferiore', cells: 1 },
  { label: 'Grande', cells: 2 },
  { label: 'Enorme', cells: 3 },
  { label: 'Mastodontica', cells: 4 },
];

/** One grid cell in real-world units (Pathfinder 2e: 5 ft = 1.5 m). */
export const CELL_METERS = 1.5;
export const CELL_FEET = 5;

/** Convert a size in the chosen unit to grid cells (1 cell = 1.5 m = 5 ft). */
export function unitToCells(size: number, unit: Unit): number {
  if (unit === 'm') return size / CELL_METERS;
  if (unit === 'ft') return size / CELL_FEET;
  return size;
}

type V2 = [number, number];
type Mat9 = number[];

/** Solve a small linear system A·x = b by Gaussian elimination (null if singular). */
function gaussSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Least-squares homography (h33=1) from ≥4 point correspondences. */
export function solveHomography(src: V2[], dst: V2[]): Mat9 | null {
  const n = src.length;
  if (n < 4) return null;
  // Normal equations for the 8 unknowns.
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb: number[] = new Array(8).fill(0);
  const addRow = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const [X, Y] = src[i];
    const [u, v] = dst[i];
    addRow([X, Y, 1, 0, 0, 0, -X * u, -Y * u], u);
    addRow([0, 0, 0, X, Y, 1, -X * v, -Y * v], v);
  }
  const h = gaussSolve(AtA, Atb);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H: Mat9, x: number, y: number): V2 {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export interface GridMap {
  toImage(a: number, b: number): V2;
  toGrid(x: number, y: number): V2;
}

/** Build the grid↔image mapping from the reconstructed lines (their nodes). */
export function makeGridMap(familyA: Line2[], familyB: Line2[]): GridMap | null {
  const src: V2[] = [];
  const dst: V2[] = [];
  for (let i = 0; i < familyA.length; i++) {
    for (let j = 0; j < familyB.length; j++) {
      const p = intersect(familyA[i], familyB[j]);
      if (p) {
        src.push([i, j]);
        dst.push([p.x, p.y]);
      }
    }
  }
  if (src.length < 4) return null;
  const H = solveHomography(src, dst);
  if (!H) return null;
  const Hinv = invert3x3(H);
  if (!Hinv) return null;
  return {
    toImage: (a: number, b: number) => applyH(H, a, b),
    toGrid: (x: number, y: number) => applyH(Hinv, x, y),
  };
}

/** Movement-ring colour per band (1..5): a high-contrast teal→amber→orange→pink→
 * violet ramp that clamps at the 5th colour (it does NOT cycle) and deliberately
 * avoids ally-green / enemy-red so a ring never reads as a token or a threat. */
export function ringColor(moveIndex: number): string {
  // One colour per movement band (1..5). High-contrast ramp teal → amber → orange →
  // magenta → violet: bands read apart at a glance, and it avoids the pure ally-green
  // / enemy-red so it never looks like a token or a threat.
  const cols = ['#2dd4bf', '#fbbf24', '#f97316', '#ec4899', '#8b5cf6'];
  return cols[Math.min(cols.length, Math.max(1, moveIndex)) - 1];
}

/**
 * Pathfinder 2e grid distance (in cells) between two cells. Diagonals alternate
 * 1 / 2: every odd diagonal costs 1, every even diagonal costs 2. So a straight
 * diagonal of d steps costs d + floor(d/2) → 1, 3, 4, 6, 7, 9, …
 */
export function pf2eDist(oi: number, oj: number, ci: number, cj: number): number {
  return blockDist(oi, oj, 1, ci, cj);
}

/** Grid-space direction for an angle (0 = up along -j, clockwise). */
const dirFromAngle = (deg: number): V2 => {
  const t = (deg * Math.PI) / 180;
  return [Math.sin(t), -Math.cos(t)];
};
export const gridDir = dirFromAngle;

/** The angle (deg, 0 = up, clockwise) of a grid-space displacement (di,dj). */
export function angleOfGridDir(di: number, dj: number): number {
  return (((Math.atan2(di, -dj) * 180) / Math.PI) % 360 + 360) % 360;
}

/** Snap an angle to one of the 8 grid directions as an integer step (dx,dy),
 * each component in {-1,0,1}. Used by cones, which are only orthogonal or
 * diagonal on the grid. */
export function coneDir(deg: number): [number, number] {
  const t = (Math.round(deg / 45) * 45 * Math.PI) / 180;
  return [Math.round(Math.sin(t)), Math.round(-Math.cos(t))];
}

/** PF2e distance (alternating diagonals) from a w×w block to a cell (0 inside). */
export function blockDist(oi: number, oj: number, w: number, i: number, j: number): number {
  const gx = Math.max(oi - i, i - (oi + w - 1), 0);
  const gy = Math.max(oj - j, j - (oj + w - 1), 0);
  return Math.max(gx, gy) + Math.floor(Math.min(gx, gy) / 2);
}

/** Cells threatened by a creature whose w×w block starts at (bi,bj): everything
 * within its reach — `w` cells by the alternating-diagonal rule (Medium 1, Large
 * 2, Huge 3, Gargantuan 4) — except its own space. */
export function threatCells(
  bi: number,
  bj: number,
  w: number,
  na: number,
  nb: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const ww = Math.max(1, w);
  for (let i = 0; i <= na - 2; i++)
    for (let j = 0; j <= nb - 2; j++) {
      const d = blockDist(bi, bj, ww, i, j);
      if (d >= 1 && d <= ww) out.push([i, j]);
    }
  return out;
}

/** PF2e distance from a grid CORNER (node) at (ci,cj) to cell (i,j): the four
 * cells that touch the corner are at distance 1, the diagonal ones at 3, … */
export function burstDist(ci: number, cj: number, i: number, j: number): number {
  const h = i >= ci ? i - ci + 1 : ci - i;
  const v = j >= cj ? j - cj + 1 : cj - j;
  return Math.max(h, v) + Math.floor(Math.min(h, v) / 2);
}

/**
 * The PF2e line orientations (deg, [0,360)). The book draws the SAME four slopes
 * for every length — a shorter line is just the same staircase truncated — and
 * fixed mode snaps to only those (reflected into every octant), not to every
 * possible corner. Confirmed by rendering each staircase:
 *   - straight (0°),
 *   - a shallow 1:3 step (~18.4°): 6q → [3,3], 12q → [3,3,3,2],
 *   - a steep 1:2 step (~26.6°): 6q → [2,2,1], 12q → [2,2,2,2,2],
 *   - the 45° diagonal.
 * `sizeCells` is kept for the call sites but no longer changes the set.
 */
export function lineAngles(_sizeCells?: number): number[] {
  const deg = (r: number) => (r * 180) / Math.PI;
  const octant = [0, deg(Math.atan(1 / 3)), deg(Math.atan(1 / 2)), 45]; // 0, ~18.4, ~26.6, 45
  const all = new Set<number>();
  const add = (x: number) => all.add(Math.round((((x % 360) + 360) % 360) * 1000) / 1000);
  for (let q = 0; q < 360; q += 90)
    for (const phi of octant) {
      add(q + phi);
      add(q - phi);
    }
  return [...all].sort((x, y) => x - y);
}

/** The set of fixed orientations shown on the angle ring for an area type:
 * lines snap to their length-dependent corners, cones to the 8 grid directions,
 * everything else has no orientation. */
export function fixedAngles(type: AreaType, sizeCells: number): number[] {
  if (type === 'linea') return lineAngles(sizeCells);
  if (type === 'cono') return [0, 45, 90, 135, 180, 225, 270, 315];
  return [];
}

/** Snap an angle to the nearest orientation in `angles` (degrees, wrapping). */
export function snapToAngles(deg: number, angles: number[]): number {
  if (angles.length === 0) return ((deg % 360) + 360) % 360;
  const d = ((deg % 360) + 360) % 360;
  let best = angles[0];
  let bestErr = Infinity;
  for (const a of angles) {
    const e = Math.min(Math.abs(a - d), 360 - Math.abs(a - d));
    if (e < bestErr) {
      bestErr = e;
      best = a;
    }
  }
  return best;
}

export function snapLineAngle(deg: number, sizeCells = 6): number {
  return snapToAngles(deg, lineAngles(sizeCells));
}

/** Top-left cell of the w×w block occupied by a creature whose "centre" is the
 * top-right corner of the selected cell (i,j). Odd sizes centre on the cell,
 * even sizes on the intersection (the top-right corner). */
export function creatureBlock(i: number, j: number, w: number): [number, number] {
  if (w % 2 === 1) return [i - (w - 1) / 2, j - (w - 1) / 2];
  return [i + 1 - w / 2, j - w / 2];
}

/** Ordered cells a segment passes through (its "supercover"), by dense sampling. */
function supercover(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const steps = Math.max(1, Math.ceil(len / 0.05));
  const ex = (dx / len) * 1e-4;
  const ey = (dy / len) * 1e-4;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const ci = Math.floor(x0 + dx * t + ex);
    const cj = Math.floor(y0 + dy * t + ey);
    const k = `${ci},${cj}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([ci, cj]);
    }
  }
  return out;
}

/** Cells of a line of length R (cells) that starts at the selected cell and runs
 * along the angle. The staircase is generated from the cell corner OPPOSITE to
 * the direction (a lattice point → the clean, regular book staircase, and the
 * selected cell is its first cell). Length is counted in Pathfinder 2e feet:
 * each cell costs 1, but a diagonal step alternates 1 / 2 — so a straight 6q line
 * is 6 cells while a 45° 6q line is only 4. */
function lineCells(oi: number, oj: number, angleDeg: number, R: number): Array<[number, number]> {
  const dir = dirFromAngle(angleDeg);
  const cx = dir[0] >= -1e-9 ? oi : oi + 1; // corner behind the direction
  const cy = dir[1] >= -1e-9 ? oj : oj + 1;
  const far = (R + 2) * 3;
  const raw = supercover(cx, cy, cx + dir[0] * far, cy + dir[1] * far);
  const out: Array<[number, number]> = [];
  let cost = 0;
  let diagCount = 0;
  let prev: [number, number] | null = null;
  for (const [ci, cj] of raw) {
    if (prev) {
      const di = Math.abs(ci - prev[0]);
      const dj = Math.abs(cj - prev[1]);
      if (di >= 1 && dj >= 1) {
        diagCount++;
        cost += diagCount % 2 === 1 ? 1 : 2;
      } else {
        cost += 1;
      }
    }
    if (cost >= R) break; // origin has cost 0; keep cells with cost < R
    out.push([ci, cj]);
    prev = [ci, cj];
  }
  return out;
}

/** True when (i,j) is a valid CELL of an na×nb node grid (cells run 0..n-2). */
function inGridCell(na: number, nb: number, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i <= na - 2 && j <= nb - 2;
}

/** A creature's block width in cells (≥1, integer). */
const creatureWidth = (cells: number): number => Math.max(1, cells | 0);

/** Cells (i,j) affected by an area, using the Pathfinder 2e templates. */
export function areaCells(area: AreaOverlay, na: number, nb: number): Array<[number, number]> {
  const R = area.sizeCells;
  const [oi, oj] = area.cell;
  const out: Array<[number, number]> = [];
  const within = (i: number, j: number) => inGridCell(na, nb, i, j);

  if (area.type === 'emanazione') {
    // From the creature's block, using the PF2e alternating-diagonal distance
    // (NOT plain Chebyshev): R=1 → 3×3, R=2 → 5×5 with the four corners cut
    // (they are 3 away by the diagonal rule), etc. — matching the book template.
    const w = creatureWidth(area.creatureCells);
    const [bi, bj] = creatureBlock(oi, oj, w);
    for (let i = 0; i <= na - 2; i++)
      for (let j = 0; j <= nb - 2; j++) if (blockDist(bi, bj, w, i, j) <= R) out.push([i, j]);
  } else if (area.type === 'esplosione') {
    // From the SELECTED intersection; diagonals cost extra.
    const [ci, cj] = area.corner;
    for (let i = 0; i <= na - 2; i++)
      for (let j = 0; j <= nb - 2; j++) if (burstDist(ci, cj, i, j) <= R) out.push([i, j]);
  } else if (area.type === 'cono') {
    // A cone is a 90° sector of the burst radiating from the SELECTED INTERSECTION
    // (a fixed grid corner, `area.corner`) — rotating only turns the sector, the
    // origin stays put. The angle snaps to one of the 8 grid orientations
    // (`coneDir`); orthogonal cones widen 2,4,6,8…, diagonal ones are one burst
    // quadrant → a right-triangle staircase.
    const [ddx, ddy] = coneDir(area.angleDeg);
    const orthogonal = ddx === 0 || ddy === 0;
    const [ci, cj] = area.corner;
    for (let i = 0; i <= na - 2; i++)
      for (let j = 0; j <= nb - 2; j++) {
        if (burstDist(ci, cj, i, j) > R) continue;
        // Signed corner→cell distances (±1 nearest the corner, never 0).
        const shx = i >= ci ? i - ci + 1 : i - ci;
        const svy = j >= cj ? j - cj + 1 : j - cj;
        const inSector = orthogonal
          ? shx * ddx + svy * ddy >= 1 && Math.abs(shx * -ddy + svy * ddx) <= shx * ddx + svy * ddy
          : shx * ddx >= 1 && svy * ddy >= 1;
        if (inSector) out.push([i, j]);
      }
  } else {
    // linea: starts FROM the selected cell, R cells long (PF2e diagonal cost).
    for (const [i, j] of lineCells(oi, oj, area.angleDeg, R)) if (within(i, j)) out.push([i, j]);
  }
  return out;
}

/** Obstacles for movement: cells you can't enter/pass (enemies) and cells you
 * can't stop on (any occupied square). */
export interface MoveObstacles {
  impassable?: Set<string>; // "i,j" of cells that block movement (enemy tokens)
  occupied?: Set<string>; // "i,j" of cells you may pass but not end on
}

const skey = (i: number, j: number, p: number) => `${i},${j},${p}`;
const ORTHO: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Binary min-heap ordered by `less` (pops a before b iff `less(a, b)`). One
 * implementation shared by both Dijkstra searches below. */
function makeMinHeap<T>(less: (a: T, b: T) => boolean) {
  const heap: T[] = [];
  return {
    get size(): number {
      return heap.length;
    },
    push(v: T): void {
      heap.push(v);
      let n = heap.length - 1;
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (!less(heap[n], heap[p])) break;
        [heap[p], heap[n]] = [heap[n], heap[p]];
        n = p;
      }
    },
    pop(): T {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let n = 0;
        for (;;) {
          const l = 2 * n + 1;
          const r = l + 1;
          let m = n;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n], heap[m]];
          n = m;
        }
      }
      return top;
    },
  };
}

/**
 * Dijkstra over (cell, parity) states with the PF2e alternating-diagonal rule.
 * A diagonal's cost (1 or 2) depends on how many diagonals were taken so far, so
 * the state carries parity = diagonals-mod-2; `diagCost(parity)` gives the cost of
 * a diagonal step at that parity (and it flips parity). Impassable cells are never
 * entered. Sources are `(i,j,parity)` at cost 0. Returns per-state cost + predecessors.
 */
function dijkstraStates(
  na: number,
  nb: number,
  obs: MoveObstacles,
  sources: Array<[number, number, number]>,
  diagCost: (parity: number) => number,
): { cost: Map<string, number>; prev: Map<string, string[]> } {
  const inGrid = (i: number, j: number) => inGridCell(na, nb, i, j);
  const impassable = obs.impassable ?? new Set<string>();
  const cost = new Map<string, number>();
  const prev = new Map<string, string[]>();
  const heap = makeMinHeap<[number, string]>((a, b) => a[0] < b[0]);
  for (const [i, j, p] of sources)
    if (inGrid(i, j) && !impassable.has(`${i},${j}`)) {
      const k = skey(i, j, p);
      if ((cost.get(k) ?? Infinity) > 0) {
        cost.set(k, 0);
        heap.push([0, k]);
      }
    }
  while (heap.size) {
    const [c, k] = heap.pop();
    if (c > (cost.get(k) ?? Infinity)) continue;
    const [is, js, ps] = k.split(',');
    const i = +is;
    const j = +js;
    const p = +ps;
    const relax = (ni: number, nj: number, np: number, step: number) => {
      if (!inGrid(ni, nj) || impassable.has(`${ni},${nj}`)) return;
      const nk = skey(ni, nj, np);
      const nc = c + step;
      const old = cost.get(nk) ?? Infinity;
      if (nc < old) {
        cost.set(nk, nc);
        prev.set(nk, [k]);
        heap.push([nc, nk]);
      } else if (nc === old) {
        (prev.get(nk) ?? prev.set(nk, []).get(nk)!).push(k);
      }
    };
    for (const [dx, dy] of ORTHO) relax(i + dx, j + dy, p, 1);
    for (const [dx, dy] of DIAG) relax(i + dx, j + dy, 1 - p, diagCost(p));
  }
  return { cost, prev };
}

/**
 * Shortest movement cost from the creature's block over every cell (forward
 * search). Returns per-state cost + predecessors (to reconstruct every shortest
 * path) + the set of source cells.
 */
function moveSearch(
  mv: MoveOverlay,
  na: number,
  nb: number,
  obs: MoveObstacles,
): { cost: Map<string, number>; prev: Map<string, string[]>; source: Set<string> } {
  const w = creatureWidth(mv.creatureCells);
  const [bi, bj] = creatureBlock(mv.cell[0], mv.cell[1], w);
  const sources: Array<[number, number, number]> = [];
  const source = new Set<string>();
  for (let i = bi; i < bi + w; i++)
    for (let j = bj; j < bj + w; j++) {
      sources.push([i, j, 0]);
      source.add(`${i},${j}`);
    }
  const { cost, prev } = dijkstraStates(na, nb, obs, sources, (p) => (p === 0 ? 1 : 2));
  return { cost, prev, source };
}

/** Min movement cost to each cell (over both parities). */
function cellCosts(search: { cost: Map<string, number> }): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, c] of search.cost) {
    const cut = k.lastIndexOf(',');
    const cell = k.slice(0, cut);
    const cur = out.get(cell);
    if (cur === undefined || c < cur) out.set(cell, c);
  }
  return out;
}

/** Cells reachable by a movement, tagged by which move (1..moves) reaches them.
 * Enemy squares block the path; you can't end on an occupied square. */
export function moveCells(
  mv: MoveOverlay,
  na: number,
  nb: number,
  obs: MoveObstacles = {},
): Array<{ i: number; j: number; move: number }> {
  const out: Array<{ i: number; j: number; move: number }> = [];
  if (mv.speedCells <= 0) return out;
  const search = moveSearch(mv, na, nb, obs);
  const occupied = obs.occupied ?? new Set<string>();
  for (const [cell, c] of cellCosts(search)) {
    if (c === 0 || search.source.has(cell) || occupied.has(cell)) continue;
    const move = Math.ceil(c / mv.speedCells);
    if (move >= 1 && move <= mv.moves) {
      const [i, j] = cell.split(',').map(Number);
      out.push({ i, j, move });
    }
  }
  return out;
}

/** Best (minimum-cost) end-states for `target` over both parities, within budget.
 * Returns the min cost and every tying state key (ordered parity 0 then 1). */
function bestBudgetedEnds(
  search: { cost: Map<string, number> },
  ti: number,
  tj: number,
  budget: number,
): { best: number; ends: string[] } {
  let best = Infinity;
  const ends: string[] = [];
  for (const p of [0, 1]) {
    const c = search.cost.get(skey(ti, tj, p));
    if (c === undefined || c > budget) continue;
    if (c < best) {
      best = c;
      ends.length = 0;
    }
    if (c === best) ends.push(skey(ti, tj, p));
  }
  return { best, ends };
}

/**
 * The MOST DIRECT routes from the creature to `target`: every cell on a minimum-cost
 * path (the predecessor DAG, so all equally-shortest routes — no superfluous detours),
 * plus that minimum cost. `null` if the target is unreachable within the move budget.
 */
export function shortestRoutes(
  mv: MoveOverlay,
  na: number,
  nb: number,
  target: [number, number],
  obs: MoveObstacles = {},
): { cells: Array<[number, number]>; cost: number } | null {
  if (mv.speedCells <= 0) return null;
  const search = moveSearch(mv, na, nb, obs);
  const [ti, tj] = target;
  const budget = mv.speedCells * Math.max(1, mv.moves);
  const { best, ends } = bestBudgetedEnds(search, ti, tj, budget);
  if (!ends.length) return null;
  // Walk the predecessor DAG back to the sources, collecting cells.
  const cells = new Set<string>();
  const seen = new Set<string>();
  const stack = [...ends];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    cells.add(k.slice(0, k.lastIndexOf(',')));
    for (const p of search.prev.get(k) ?? []) stack.push(p);
  }
  return { cells: [...cells].map((c) => c.split(',').map(Number) as [number, number]), cost: best };
}

/**
 * ONE representative shortest route to `target`: an ordered list of cells from a
 * source to the target (a single branch of the shortest-path DAG), plus its cost.
 * `null` if the target is unreachable within the move budget. To keep the line
 * clean it prefers a predecessor that continues in the same direction (least
 * zig-zag) over an arbitrary one.
 */
export function shortestRoute(
  mv: MoveOverlay,
  na: number,
  nb: number,
  target: [number, number],
  obs: MoveObstacles = {},
): { cells: Array<[number, number]>; cost: number } | null {
  if (mv.speedCells <= 0) return null;
  const search = moveSearch(mv, na, nb, obs);
  const [ti, tj] = target;
  const budget = mv.speedCells * Math.max(1, mv.moves);
  const { best, ends } = bestBudgetedEnds(search, ti, tj, budget);
  if (!ends.length) return null;
  const bestKey = ends[0];
  const cellOf = (k: string): [number, number] => {
    const [i, j] = k.slice(0, k.lastIndexOf(',')).split(',').map(Number);
    return [i, j];
  };
  const cells: [number, number][] = [];
  const guard = new Set<string>();
  let k: string | undefined = bestKey;
  let lastDir: [number, number] | null = null; // backward step direction (cur → prev cell)
  while (k && !guard.has(k)) {
    guard.add(k);
    const cur = cellOf(k);
    cells.push(cur);
    const preds = search.prev.get(k);
    if (!preds || preds.length === 0) break; // reached a source
    // Prefer the predecessor that keeps the same backward direction (straighter line).
    let chosen = preds[0];
    if (lastDir) {
      for (const pk of preds) {
        const pc = cellOf(pk);
        const d: [number, number] = [pc[0] - cur[0], pc[1] - cur[1]];
        if (Math.sign(d[0]) === lastDir[0] && Math.sign(d[1]) === lastDir[1]) {
          chosen = pk;
          break;
        }
      }
    }
    const pc = cellOf(chosen);
    lastDir = [Math.sign(pc[0] - cur[0]), Math.sign(pc[1] - cur[1])];
    k = chosen;
  }
  cells.reverse(); // source → target
  return { cells, cost: best };
}

/** Cells on some shortest path from the creature to `target` (empty if unreachable). */
export function movePaths(
  mv: MoveOverlay,
  na: number,
  nb: number,
  target: [number, number],
  obs: MoveObstacles = {},
): Array<[number, number]> {
  return shortestRoutes(mv, na, nb, target, obs)?.cells ?? [];
}

export interface ParetoRoute {
  cells: [number, number][]; // ordered source → target
  cost: number; // movement cost (cells, alternating diagonal)
  threats: number; // number of DISTINCT threatening creatures the route touches
  move: number; // movements needed = ceil(cost / speed)
}

const popcount = (x: number): number => {
  let c = 0;
  for (let v = x; v; v &= v - 1) c++;
  return c;
};

/**
 * The (cost ↔ threats) Pareto frontier of routes to `target`, as the user asked:
 * the FASTEST route first (fewest movements; ties → fewest threats), then each
 * route that spends +1 movement to be threatened by FEWER creatures, until 0
 * threats or the movement cap.
 *
 * THREATS ARE COUNTED PER DISTINCT CREATURE, once each: passing through several
 * cells of the same creature's reach counts 1, and a creature counts if the route
 * is EVER in its reach (including the start square you move out of). So the metric
 * is a SET of creatures, tracked as a bitmask. Because the count depends on WHICH
 * creatures were already met, the search state is (cell, parity, mask); each state
 * keeps its non-dominated (cost, mask⊆) labels (subset-domination). `threatAreas`
 * = one cell-set per opposite creature. Empty if the target is unreachable.
 */
export function movePareto(
  mv: MoveOverlay,
  na: number,
  nb: number,
  target: [number, number],
  maxMoves: number,
  threatAreas: Array<Set<string>>,
  obs: MoveObstacles = {},
): ParetoRoute[] {
  const speed = mv.speedCells;
  if (speed <= 0) return [];
  const maxM = Math.max(1, Math.min(mv.moves, Math.max(1, maxMoves)));
  const budget = maxM * speed;
  const w = creatureWidth(mv.creatureCells);
  const [bi, bj] = creatureBlock(mv.cell[0], mv.cell[1], w);
  const inGrid = (i: number, j: number) => inGridCell(na, nb, i, j);
  const impassable = obs.impassable ?? new Set<string>();
  const [ti, tj] = target;

  // Bitmask of the creatures threatening each cell (≤ 30 creatures fit a JS int).
  const creatures = threatAreas.slice(0, 30);
  const cellMask = new Map<string, number>();
  creatures.forEach((area, c) => {
    const bit = 1 << c;
    for (const cell of area) cellMask.set(cell, (cellMask.get(cell) ?? 0) | bit);
  });
  const maskOf = (i: number, j: number) => cellMask.get(`${i},${j}`) ?? 0;

  interface Label {
    i: number;
    j: number;
    p: number;
    cost: number;
    mask: number; // creatures touched so far
    prev: Label | null;
  }
  const labels = new Map<string, Label[]>(); // (cell,parity) → non-dominated labels
  // Dijkstra order: by cost, then by fewest creatures.
  const less = (a: Label, b: Label) =>
    a.cost < b.cost || (a.cost === b.cost && popcount(a.mask) < popcount(b.mask));
  const heap = makeMinHeap<Label>(less);
  // A label (cost, mask) is dominated by (c, m) when c ≤ cost AND m ⊆ mask: cheaper
  // and having met a SUBSET of creatures can only end with ≤ cost and ≤ creatures.
  const addLabel = (l: Label): boolean => {
    const k = skey(l.i, l.j, l.p);
    let arr = labels.get(k);
    if (!arr) {
      arr = [];
      labels.set(k, arr);
    }
    for (const e of arr) if (e.cost <= l.cost && (e.mask & l.mask) === e.mask) return false;
    for (let x = arr.length - 1; x >= 0; x--)
      if (l.cost <= arr[x].cost && (l.mask & arr[x].mask) === l.mask) arr.splice(x, 1);
    arr.push(l);
    return true;
  };

  // The mover's whole block is present at the start → it already touches every
  // creature threatening any of its cells.
  let startMask = 0;
  for (let i = bi; i < bi + w; i++)
    for (let j = bj; j < bj + w; j++) if (inGrid(i, j)) startMask |= maskOf(i, j);
  for (let i = bi; i < bi + w; i++)
    for (let j = bj; j < bj + w; j++)
      if (inGrid(i, j) && !impassable.has(`${i},${j}`)) {
        const l: Label = { i, j, p: 0, cost: 0, mask: startMask, prev: null };
        if (addLabel(l)) heap.push(l);
      }

  const diagCost = (p: number) => (p === 0 ? 1 : 2);
  while (heap.size) {
    const cur = heap.pop();
    const arr = labels.get(skey(cur.i, cur.j, cur.p));
    if (!arr || !arr.includes(cur)) continue; // stale (was dominated since)
    const relax = (ni: number, nj: number, np: number, step: number) => {
      if (!inGrid(ni, nj) || impassable.has(`${ni},${nj}`)) return;
      const cost = cur.cost + step;
      if (cost > budget) return;
      const mask = cur.mask | maskOf(ni, nj);
      const l: Label = { i: ni, j: nj, p: np, cost, mask, prev: cur };
      if (addLabel(l)) heap.push(l);
    };
    for (const [dx, dy] of ORTHO) relax(cur.i + dx, cur.j + dy, cur.p, 1);
    for (const [dx, dy] of DIAG) relax(cur.i + dx, cur.j + dy, 1 - cur.p, diagCost(cur.p));
  }

  const tLabels: Label[] = [];
  for (const p of [0, 1]) {
    const arr = labels.get(skey(ti, tj, p));
    if (arr) tLabels.push(...arr);
  }
  if (!tLabels.length) return [];

  const reconstruct = (l: Label): [number, number][] => {
    const out: [number, number][] = [];
    let cur: Label | null = l;
    while (cur) {
      out.push([cur.i, cur.j]);
      cur = cur.prev; // cost strictly decreases along prev → no cycles
    }
    return out.reverse();
  };

  const minCost = Math.min(...tLabels.map((l) => l.cost));
  const m0 = Math.max(1, Math.ceil(minCost / speed));
  const routes: ParetoRoute[] = [];
  let prevThreats = Infinity;
  for (let m = m0; m <= maxM; m++) {
    const cap = m * speed;
    // Fewest creatures reachable within m movements (ties → cheaper cost).
    let best: Label | null = null;
    let bestT = Infinity;
    for (const l of tLabels) {
      if (l.cost > cap) continue;
      const t = popcount(l.mask);
      if (!best || t < bestT || (t === bestT && l.cost < best.cost)) {
        best = l;
        bestT = t;
      }
    }
    if (!best) continue;
    if (m === m0 || bestT < prevThreats) {
      routes.push({
        cells: reconstruct(best),
        cost: best.cost,
        threats: bestT,
        move: Math.max(1, Math.ceil(best.cost / speed)),
      });
      prevThreats = bestT;
      if (bestT === 0) break;
    }
  }
  return routes;
}
