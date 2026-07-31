// Board tokens (allies / enemies) + threat / flanking geometry. Pure logic reading the
// shared board state (S.tokens / S.gridDims); no drawing, no DOM.
import { S, type Token } from './tactical-state';
import { threatCells } from './overlays';

// --- Board tokens (allies / enemies) + threat ------------------------
export function tokenBlock(t: Token): { bi: number; bj: number; w: number } {
  const w = Math.max(1, t.w);
  const bi = Math.max(0, Math.min(t.i, S.gridDims.na - 1 - w));
  const bj = Math.max(0, Math.min(t.j, S.gridDims.nb - 1 - w));
  return { bi, bj, w };
}

export function tokenCovers(t: Token, i: number, j: number): boolean {
  const { bi, bj, w } = tokenBlock(t);
  return i >= bi && i < bi + w && j >= bj && j < bj + w;
}

/** Movement obstacles for a piece of `group`: you may pass through (but not stop
 * on) squares of your OWN side, and you cannot pass through the OPPOSITE side. */
export function tokenObstaclesFor(group: 'ally' | 'enemy'): { impassable: Set<string>; occupied: Set<string> } {
  const impassable = new Set<string>();
  const occupied = new Set<string>();
  for (const t of S.tokens) {
    const { bi, bj, w } = tokenBlock(t);
    for (let i = bi; i < bi + w; i++)
      for (let j = bj; j < bj + w; j++) {
        const k = `${i},${j}`;
        if (t.kind === group) occupied.add(k); // same side: pass, don't stop
        else impassable.add(k); // opposite side: blocks the path
      }
  }
  return { impassable, occupied };
}

/** Per-cell threat counts by side (how many enemy / ally reaches cover a cell). */
export function threatCountMaps(): { enemy: Map<string, number>; ally: Map<string, number> } {
  const enemy = new Map<string, number>();
  const ally = new Map<string, number>();
  const { na, nb } = S.gridDims;
  for (const t of S.tokens) {
    const { bi, bj, w } = tokenBlock(t);
    const m = t.kind === 'enemy' ? enemy : ally;
    for (const [i, j] of threatCells(bi, bj, w, na, nb)) {
      const k = `${i},${j}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  }
  return { enemy, ally };
}

// One threat-area (set of cells) per creature of the group OPPOSITE the mover —
// so the path preview can count DISTINCT creatures met, not cells.
export function oppThreatAreas(group: 'ally' | 'enemy'): Array<Set<string>> {
  const opp = group === 'ally' ? 'enemy' : 'ally';
  const { na, nb } = S.gridDims;
  const areas: Array<Set<string>> = [];
  for (const t of S.tokens) {
    if (t.kind !== opp) continue;
    const { bi, bj, w } = tokenBlock(t);
    const cells = threatCells(bi, bj, w, na, nb);
    if (cells.length) areas.push(new Set(cells.map(([i, j]) => `${i},${j}`)));
  }
  return areas;
}

// --- Flanking (Fase D) -----------------------------------------------
export function tokenCenter(t: Token): [number, number] {
  const { bi, bj, w } = tokenBlock(t);
  return [bi + w / 2, bj + w / 2];
}

export function threatensToken(att: Token, tgt: Token): boolean {
  const a = tokenBlock(att);
  const reach = new Set(
    threatCells(a.bi, a.bj, a.w, S.gridDims.na, S.gridDims.nb).map(([i, j]) => `${i},${j}`),
  );
  const b = tokenBlock(tgt);
  for (let i = b.bi; i < b.bi + b.w; i++)
    for (let j = b.bj; j < b.bj + b.w; j++) if (reach.has(`${i},${j}`)) return true;
  return false;
}

/** Does segment (ax,ay)-(bx,by) cross the rectangle [x0,x1]×[y0,y1]? (Liang-Barsky) */
export function segCrossesRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay) && t0 <= t1;
}

/** Enemies flanked: two allies that both threaten it and whose centre-to-centre
 * line crosses opposite sides/corners of its space (PF2e flanking). */
export function flankedEnemies(): Token[] {
  const allies = S.tokens.filter((t) => t.kind === 'ally');
  const out: Token[] = [];
  for (const e of S.tokens) {
    if (e.kind !== 'enemy') continue;
    const { bi, bj, w } = tokenBlock(e);
    const thr = allies.filter((a) => threatensToken(a, e));
    let flanked = false;
    for (let x = 0; x < thr.length && !flanked; x++)
      for (let y = x + 1; y < thr.length && !flanked; y++) {
        const [ax, ay] = tokenCenter(thr[x]);
        const [cx, cy] = tokenCenter(thr[y]);
        if (segCrossesRect(ax, ay, cx, cy, bi, bj, bi + w, bj + w)) flanked = true;
      }
    if (flanked) out.push(e);
  }
  return out;
}

/** The token whose block covers cell (i,j), or null. */
export function tokenAt(i: number, j: number): Token | null {
  return S.tokens.find((t) => tokenCovers(t, i, j)) ?? null;
}

/** The "selected cell" value that makes creatureBlock() reproduce a given block
 * top-left (the inverse of creatureBlock), so a movement's source lines up
 * exactly with the token's occupied squares. */
export function blockToCell(bi: number, bj: number, w: number): [number, number] {
  if (w % 2 === 1) return [bi + (w - 1) / 2, bj + (w - 1) / 2];
  return [bi + w / 2 - 1, bj + w / 2];
}
