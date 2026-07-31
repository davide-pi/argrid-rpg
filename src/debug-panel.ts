// Debug pipeline panel (graph + confidence/timing logs), stage-preview rendering, and the
// hidden triple-tap debug toggle + gallery-load affordance.
import { S } from './tactical-state';
import { debugBar, focusBadge, dbgBadge, btnLoadImage, fileInput, brand, video, view } from './dom';
import { clipLineToRect, type Line2, type GridResult, type StageLines, type ConfBreakdown } from './grid-detector';
import { draw } from './draw-loop';
import { runDetection, processImage, camera, setStatus } from './main';

// Debug-only focus indicator (next to the DBG chip): BLUE when the last detection ran with a
// tap-to-focus point (`lastFocusPoint` set), GREY otherwise. Shown/hidden together with dbgBadge.
export function updateFocusBadge() {
  focusBadge.hidden = !S.debug;
  focusBadge.classList.toggle('on', !!S.lastFocusPoint);
}

/** The currently selected pipeline node, or undefined. */
export function selectedStep() {
  return S.lastResult?.debugSteps?.find((s) => s.id === S.debugStepId);
}

/** Nodes drawn LIVE as line overlays over the photo (no snapshot image): the raw Hough of each
 * pipeline, plus its three line stages (split → merge → vanishing-point). */
export const LINE_NODES = new Set([
  'houghLum', 'splitLum', 'mergeLum', 'vpLum',
  'houghMorph', 'splitMorph', 'mergeMorph', 'vpMorph',
]);

/** Nodes drawn LIVE as CROSSING overlays (points coloured by perpendicularity), one per pipeline. */
export const PERP_NODES = new Set(['perpLum', 'perpMorph']);

/** All live-drawn nodes (line or crossing overlays) — no snapshot image, drawn over the photo. */
export const LIVE_NODES = new Set([...LINE_NODES, ...PERP_NODES]);

/** The line set(s) to draw for a live line-overlay node, with a colour per family and a base label.
 * Raw Hough is pre-split (one colour); the fit stages show family A vs B in two colours so the
 * split — and the fan getting filtered by the vanishing-point stage — is visible. */
export function stageLineData(r: GridResult, id: string): { groups: { lines: Line2[]; color: string }[]; base: string } | null {
  const colA = 'rgba(34, 211, 238, 0.9)'; // family A — cyan
  const colB = 'rgba(244, 114, 182, 0.9)'; // family B — pink
  if (id === 'houghLum') return { groups: [{ lines: r.debugRawLum ?? [], color: 'rgba(34, 211, 238, 0.85)' }], base: 'Hough Luminanza' };
  if (id === 'houghMorph') return { groups: [{ lines: r.debugRawMorph ?? [], color: 'rgba(167, 139, 250, 0.9)' }], base: 'Hough Morfologica' };
  const m = /^(split|merge|vp)(Lum|Morph)$/.exec(id);
  if (!m) return null;
  const stage = m[1] as 'split' | 'merge' | 'vp';
  const st = m[2] === 'Morph' ? r.debugStagesMorph : r.debugStagesLum;
  const [a, b] = stageAB(st, stage);
  const name = { split: 'Split famiglie', merge: 'Merge duplicati', vp: 'Punto di fuga (VP vincente)' }[stage];
  const pipe = m[2] === 'Morph' ? 'Morfologica' : 'Luminanza';
  return { groups: [{ lines: a, color: colA }, { lines: b, color: colB }], base: `${name} — ${pipe}` };
}

/** Pull the [A, B] line arrays for one fit stage out of a StageLines (empty when absent). */
export function stageAB(st: StageLines | undefined, stage: 'split' | 'merge' | 'vp'): [Line2[], Line2[]] {
  if (!st) return [[], []];
  if (stage === 'split') return [st.splitA, st.splitB];
  if (stage === 'merge') return [st.mergedA, st.mergedB];
  return [st.vpA, st.vpB];
}

/** True when a pipeline-stage preview (a node WITH an image, or a live line overlay — not the
 * overlay) is selected. Never while editing a manual grid (that view needs the photo + quad). */
export function debugStepActive(): boolean {
  if (!S.debug || S.manualActive) return false;
  const s = selectedStep();
  return !!(s && (s.image || LIVE_NODES.has(s.id)) && s.id !== 'overlay');
}

/** Blit the selected pipeline-stage preview onto the view canvas (scaled up from the
 * downscaled snapshot), with the stage name labelled top-left. */
export function drawDebugStep() {
  const r = S.lastResult!;
  const step = selectedStep();
  if (!step) return;
  view.width = r.width;
  view.height = r.height;
  const ctx = view.getContext('2d')!;
  let labelText: string;
  const perp = PERP_NODES.has(step.id)
    ? step.id === 'perpMorph'
      ? r.debugPerpMorph
      : r.debugPerpLum
    : null;
  const lineData = LINE_NODES.has(step.id) ? stageLineData(r, step.id) : null;
  if (perp) {
    // The SELECTION step (not a post-fit score): perpendicularity is computed for EVERY VP hypothesis
    // and PICKS the winner. Here we draw the winning grid's crossings coloured by perpendicularity
    // AFTER rectification (green = right angle, red = sheared), sized by foreground weight (bigger =
    // nearer the viewer, more trusted). The label reports how many VP hypotheses it judged.
    ctx.drawImage(S.lastCapture!, 0, 0, r.width, r.height);
    const wMax = perp.crossings.reduce((m, c) => Math.max(m, c.weight), 0) || 1;
    const rBase = Math.max(3, r.width / 160);
    for (const c of perp.crossings) {
      const g = Math.round(200 * c.perp); // perp 1 → green, 0 → red
      const rd = Math.round(220 * (1 - c.perp));
      const rad = rBase * (0.5 + 0.9 * Math.sqrt(c.weight / wMax));
      ctx.beginPath();
      ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rd}, ${g}, 40, 0.8)`;
      ctx.fill();
    }
    const pipe = step.id === 'perpMorph' ? 'Morfologica' : 'Luminanza';
    const hyp = perp.hypotheses != null ? ` · ha scelto tra ${perp.hypotheses} ipotesi VP` : '';
    labelText = `Perpendicolarità · SELEZIONE — ${pipe} — ${Math.round(perp.score * 100)}% (${perp.crossings.length} incroci${hyp})`;
  } else if (lineData) {
    // Live line overlay over the photo — raw Hough, or a fit stage (split → merge → vanishing-point),
    // each family in its own colour so you can watch the lines get whittled down stage by stage.
    ctx.drawImage(S.lastCapture!, 0, 0, r.width, r.height);
    ctx.lineWidth = Math.max(1, r.width / 480);
    const counts: number[] = [];
    for (const g of lineData.groups) {
      ctx.strokeStyle = g.color;
      for (const l of g.lines) {
        const seg = clipLineToRect(l, r.width, r.height);
        if (!seg) continue;
        ctx.beginPath();
        ctx.moveTo(seg[0][0], seg[0][1]);
        ctx.lineTo(seg[1][0], seg[1][1]);
        ctx.stroke();
      }
      counts.push(g.lines.length);
    }
    // "8 + 6 linee" for a two-family stage, "14 linee" for the pre-split raw Hough.
    labelText = `${lineData.base} — ${counts.join(' + ')} linee`;
  } else {
    if (!step.image) return;
    if (!S.debugStepCanvas) S.debugStepCanvas = document.createElement('canvas');
    S.debugStepCanvas.width = step.image.width;
    S.debugStepCanvas.height = step.image.height;
    S.debugStepCanvas.getContext('2d')!.putImageData(step.image, 0, 0);
    ctx.imageSmoothingEnabled = false; // show the pipeline pixels, not a blurred upscale
    ctx.drawImage(S.debugStepCanvas, 0, 0, r.width, r.height);
    ctx.imageSmoothingEnabled = true;
    labelText = step.label + (step.used ? '' : ' — non usato');
  }
  const fs = Math.max(16, Math.round(r.width / 40));
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const pad = fs * 0.5;
  ctx.fillStyle = 'rgba(10,14,19,0.72)';
  ctx.fillRect(pad, pad, ctx.measureText(labelText).width + pad * 2, fs + pad);
  ctx.fillStyle = '#eaf1fb';
  ctx.textBaseline = 'top';
  ctx.fillText(labelText, pad * 2, pad * 1.5);
}

// --- Debug pipeline graph (nodes + arrows) ------------------------------
// Fixed layout (col, row) per node id. Single root 'foto' on the left. Row 0 = the colour-edge
// extraction ('chroma'), which is OR'd INTO the luminance edges (it has no Hough of its own). Row 1
// = the luminance main line, ending in its Hough node ('houghLum'), then the FIT stages
// ('splitLum' → 'mergeLum' → 'vpLum' → 'perpLum': split into two directions, per-family duplicate
// merge, vanishing-point concurrency, foreground-weighted perpendicularity/squareness). Rows 2/3 =
// the morphological fallback, forked into a horizontal (row 2) and vertical (row 3) line extractor
// that rejoin into 'morph'/'houghMorph' + its own fit stages ('splitMorph'…'perpMorph'). Both
// pipelines converge into the final grid ('overlay') on the right, rebuilt from the winner's fit.
export const GRAPH_LAYOUT: Record<string, [number, number]> = {
  foto: [0, 1.5],
  chroma: [1, 0],
  gray: [1, 1],
  clahe: [2, 1],
  blur: [3, 1],
  canny: [4, 1],
  edges: [5, 1],
  clean: [6, 1],
  oriented: [7, 1],
  houghLum: [8, 1],
  splitLum: [9, 1],
  mergeLum: [10, 1],
  vpLum: [11, 1],
  perpLum: [12, 1],
  mridgeh: [2, 2],
  mbinh: [3, 2],
  mridgev: [2, 3],
  mbinv: [3, 3],
  morph: [4, 2.5],
  houghMorph: [8, 2.5],
  splitMorph: [9, 2.5],
  mergeMorph: [10, 2.5],
  vpMorph: [11, 2.5],
  perpMorph: [12, 2.5],
  overlay: [13, 1.5],
};

export const GN_W = 62;

export const GN_H = 32;

export const GN_CGAP = 30;

export const GN_RGAP = 34;

export const gnX = (col: number) => col * (GN_W + GN_CGAP);

export const gnY = (row: number) => row * (GN_H + GN_RGAP);

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** Highlight the currently-selected node in place (no rebuild → scroll is preserved). */
export function markSelectedNode() {
  for (const el of Array.from(debugBar.querySelectorAll('.debug-node'))) {
    el.classList.toggle('on', (el as HTMLElement).dataset.id === S.debugStepId);
  }
}

/** Build the debug pipeline graph from lastResult.debugSteps. Hidden unless debug is
 * on, a result is shown, and we're not editing a manual grid. Three visual states per
 * node: USED (on the winning path, highlighted), executed-but-not-used (normal), and
 * not executed (deactivated). Arrows follow the same three states. */
export function rebuildDebugBar() {
  // Keep the on-map focus indicator (next to the DBG chip) in sync — its colour tracks whether
  // the last detection used a focus point, independent of whether the pipeline panel is shown.
  updateFocusBadge();
  const steps = S.lastResult?.debugSteps ?? [];
  const show = S.debug && S.showingResult && !S.manualActive && steps.length > 0;
  debugBar.hidden = !show;
  if (!show) return;
  if (!steps.some((s) => s.id === S.debugStepId)) S.debugStepId = 'overlay';
  const byId = new Map(steps.map((s) => [s.id, s]));
  const layout = GRAPH_LAYOUT;

  let maxCol = 0;
  let maxRow = 0;
  for (const s of steps) {
    const p = layout[s.id];
    if (!p) continue;
    maxCol = Math.max(maxCol, p[0]);
    maxRow = Math.max(maxRow, p[1]);
  }
  const W = gnX(maxCol) + GN_W;
  const H = gnY(maxRow) + GN_H;

  debugBar.classList.toggle('collapsed', S.debugCollapsed);
  debugBar.textContent = '';

  // Header: title + (timing-log toggle) + collapse toggle.
  const head = document.createElement('div');
  head.className = 'debug-head';
  head.innerHTML = '<span class="debug-title">Pipeline</span>';
  const actions = document.createElement('div');
  actions.className = 'debug-head-actions';
  // Timing log (scroll-text): shown only when the result carries timings.
  if (S.lastResult?.debugTimings) {
    const logBtn = document.createElement('button');
    logBtn.type = 'button';
    logBtn.className = 'debug-collapse' + (S.debugLogOpen ? ' on' : '');
    logBtn.setAttribute('aria-label', 'Mostra i tempi di elaborazione');
    logBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>';
    logBtn.addEventListener('click', () => {
      S.debugLogOpen = !S.debugLogOpen;
      rebuildDebugBar();
    });
    actions.appendChild(logBtn);
  }
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'debug-collapse';
  collapse.setAttribute('aria-label', 'Riduci o espandi la pipeline');
  collapse.innerHTML =
    '<svg class="chev" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  collapse.addEventListener('click', () => {
    S.debugCollapsed = !S.debugCollapsed;
    debugBar.classList.toggle('collapsed', S.debugCollapsed);
  });
  actions.appendChild(collapse);
  head.appendChild(actions);
  debugBar.appendChild(head);

  const pct = (c: number) => Math.round(c * 100);
  const chip = (cls: string, name: string, conf: number) => {
    const el = document.createElement('div');
    el.className = 'pstat ' + cls;
    el.innerHTML =
      `<span class="pstat-top"><span class="pstat-name">${name}</span>` +
      `<span class="pstat-val">${pct(conf)}%</span></span>` +
      `<span class="pstat-bar"><span class="pstat-fill" style="width:${pct(conf)}%"></span></span>`;
    return el;
  };

  // "Why wasn't the grid drawn?" — the detector synthesized a grid but the gate rejected it.
  // Stays visible even when collapsed since it's the key diagnostic. Null when a grid was
  // drawn / nothing was detected.
  if (!S.gridReliable && S.gridRejectReason) {
    const banner = document.createElement('div');
    banner.className = 'debug-reason';
    banner.textContent = S.gridRejectReason;
    debugBar.appendChild(banner);
  }

  // View selector: the timing-log button switches the body between GRAPH view (pipeline graph +
  // confidence strip, log OFF) and LOG view (the timing log, log ON) — never both at once. The
  // header + rejection banner stay in either view.
  // Confidence strip: each independent fit's quality + the final decision. Sits under
  // the head; hidden when the bar is collapsed (like the graph) or in the log view.
  const pipes = S.lastResult?.debugPipelines ?? [];
  if (pipes.length && !S.debugLogOpen) {
    const stats = document.createElement('div');
    stats.className = 'debug-stats';
    for (const p of pipes) stats.appendChild(chip(p.chosen ? 'chosen' : '', p.label, p.confidence));
    // Option B: how much the two independent fits agree (a cross-check, not a fit's own
    // quality) — shown only when comparable. Styled dashed to read as a meta-metric.
    const agree = S.lastResult?.debugAgreement;
    if (agree != null) stats.appendChild(chip('pstat-agree', 'Accordo', agree));
    // Final decision: the chosen fit's confidence (already lifted/cut by the agreement);
    // the reliability gate (grid drawn vs not) is conveyed by the chip's colour.
    stats.appendChild(chip('pstat-final ' + (S.gridReliable ? 'ok' : 'bad'), 'Finale', S.lastResult?.info.confidence ?? 0));
    debugBar.appendChild(stats);
  }

  // Scrollable graph body — GRAPH view only (log OFF). The LOG view below replaces it.
  if (!S.debugLogOpen) {
  const scroll = document.createElement('div');
  scroll.className = 'debug-scroll';
  const graph = document.createElement('div');
  graph.className = 'debug-graph';
  graph.style.width = W + 'px';
  graph.style.height = H + 'px';

  // Connector LINES (no arrowheads — cleaner), behind the nodes. Same-row links are a
  // straight horizontal; branch/merge links run horizontally along the SOURCE row, then
  // a rounded right-angle turn rises into the target near its own column — so a line
  // never cuts diagonally across a block.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'debug-arrows');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  const elbow = (sx: number, sy: number, ex: number, ey: number): string => {
    if (sy === ey) return `M ${sx} ${sy} L ${ex} ${ey}`;
    const turnX = ex - 14; // rise just before the target
    const r = 7;
    const dir = ey > sy ? 1 : -1;
    return (
      `M ${sx} ${sy} L ${turnX - r} ${sy}` +
      ` Q ${turnX} ${sy} ${turnX} ${sy + dir * r}` +
      ` L ${turnX} ${ey - dir * r}` +
      ` Q ${turnX} ${ey} ${turnX + r} ${ey}` +
      ` L ${ex} ${ey}`
    );
  };
  for (const s of steps) {
    const p = layout[s.id];
    if (!p) continue;
    const tx = gnX(p[0]);
    const ty = gnY(p[1]) + GN_H / 2;
    for (const inId of s.inputs) {
      const ip = layout[inId];
      if (!ip) continue;
      const inp = byId.get(inId);
      const sx = gnX(ip[0]) + GN_W;
      const sy = gnY(ip[1]) + GN_H / 2;
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', elbow(sx, sy, tx, ty));
      const bothUsed = !!(s.used && inp?.used);
      const bothExec = s.executed && !!inp?.executed;
      path.setAttribute('class', bothUsed ? 'arrow used' : bothExec ? 'arrow' : 'arrow off');
      svg.appendChild(path);
    }
  }
  graph.appendChild(svg);

  // One-line description per FIT step, appended to the node tooltip so the graph reads truthfully:
  // the winning path is a hypothesise-and-verify search, NOT a linear pipeline — Fuga shows the
  // WINNING vanishing point among the multi-VP candidates, and Perp is the SELECTION step that judged
  // every VP hypothesis (not a score tacked on after Fuga).
  const NODE_DESC: Record<string, string> = {
    splitLum: 'linee divise nelle due direzioni',
    mergeLum: 'duplicati fusi per famiglia (tiene il supporto)',
    vpLum: 'VP VINCENTE fra i candidati multi-VP',
    perpLum: 'SELEZIONE per perpendicolarità: giudica ogni ipotesi VP e sceglie la griglia più quadrata',
    splitMorph: 'linee divise nelle due direzioni',
    mergeMorph: 'duplicati fusi per famiglia (tiene il supporto)',
    vpMorph: 'VP VINCENTE fra i candidati multi-VP',
    perpMorph: 'SELEZIONE per perpendicolarità: giudica ogni ipotesi VP e sceglie la griglia più quadrata',
  };

  // Nodes.
  for (const s of steps) {
    const p = layout[s.id];
    if (!p) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = s.id;
    b.disabled = !s.executed; // a skipped stage is shown (with its arrows) but not clickable
    b.className =
      'debug-node' +
      (s.id === S.debugStepId ? ' on' : '') +
      (!s.executed ? ' off' : s.used ? ' used' : '') +
      (s.image || LIVE_NODES.has(s.id) ? '' : ' no-img'); // live-overlay nodes drawn on the photo
    b.style.left = gnX(p[0]) + 'px';
    b.style.top = gnY(p[1]) + 'px';
    b.textContent = s.label;
    const desc = NODE_DESC[s.id];
    const suffix = !s.executed ? ' — non eseguito' : s.used ? '' : ' — non usato';
    b.title = s.label + (desc ? ' — ' + desc : '') + suffix;
    b.addEventListener('click', () => {
      S.debugStepId = s.id;
      markSelectedNode(); // update selection in place — do NOT rebuild (keeps scroll)
      draw();
    });
    graph.appendChild(b);
  }

  scroll.appendChild(graph);
  debugBar.appendChild(scroll);
  } // end GRAPH view (!debugLogOpen)

  // LOG view (toggled by the scroll-text button) — TWO tabs sharing one scroll panel:
  //   • Tempi      — where the pipeline spent its time (per-node timings, grouped + totalled).
  //   • Confidenza — WHY each candidate got its confidence (the real sub-scores feeding
  //                  gridConfidence). Needed because a correct grid can still score poorly on one
  //                  path (e.g. luminance), and the breakdown shows exactly which term dragged it.
  if (S.debugLogOpen && !S.debugCollapsed) {
    // Tab selector.
    const tabs = document.createElement('div');
    tabs.className = 'debug-log-tabs';
    const mkTab = (id: 'tempi' | 'conf', label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'debug-log-tab' + (S.debugLogTab === id ? ' on' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        S.debugLogTab = id;
        rebuildDebugBar();
      });
      return b;
    };
    tabs.appendChild(mkTab('tempi', 'Tempi'));
    tabs.appendChild(mkTab('conf', 'Confidenza'));
    debugBar.appendChild(tabs);

    const log = document.createElement('div');
    log.className = 'debug-log';
    log.innerHTML = S.debugLogTab === 'tempi' ? renderTimingLog() : renderConfidenceLog();
    debugBar.appendChild(log);
  }
}

// --- LOG view: Tempi tab ---------------------------------------------------
// ONE row per pipeline NODE, grouped by pipeline (luminance / colour / morphology) with a per-group
// subtotal + grand total. Rows flagged `breakdown` decompose the row above them (the morphology's
// extraction), so they're shown but NOT summed into the totals (they'd double-count).
export function renderTimingLog(): string {
  const timings = S.lastResult?.debugTimings;
  if (!timings) return '<div class="debug-log-row indent"><span class="debug-log-k">Nessun dato di timing</span></div>';
  const ms = (v: number) => `${Math.round(v)} ms`;
  type Row = { key: string; label: string; breakdown?: boolean };
  const groups: { title: string; items: Row[] }[] = [
    {
      title: 'Luminanza',
      items: [
        { key: 'gray', label: 'Grigio' },
        { key: 'clahe', label: 'Contrasto' },
        { key: 'blur', label: 'Sfocatura' },
        { key: 'canny', label: 'Canny' },
        { key: 'edges', label: 'Bordi uniti' },
        { key: 'clean', label: 'Pulizia texture' },
        { key: 'fft', label: 'Prior FFT' },
        { key: 'oriented', label: 'Orientati' },
        { key: 'houghMain', label: 'Hough' },
      ],
    },
    // Colour edges are extracted then OR'd into the luminance edges (no separate Hough).
    { title: 'Colore', items: [{ key: 'chroma', label: 'Estrazione' }] },
    {
      title: 'Morfologia',
      items: [
        { key: 'mridgeh', label: 'Cresta H', breakdown: true },
        { key: 'mridgev', label: 'Cresta V', breakdown: true },
        { key: 'mbinh', label: 'Linee H', breakdown: true },
        { key: 'mbinv', label: 'Linee V', breakdown: true },
        { key: 'morphEnhance', label: 'Estrazione (tot.)' },
        { key: 'morphHough', label: 'Hough' },
      ],
    },
  ];
  let html = '';
  let total = 0;
  for (const g of groups) {
    const present = g.items.filter((r) => timings[r.key] != null);
    const hasAngles = g.title === 'Morfologia' && timings.morphAngles != null;
    if (!present.length && !hasAngles) continue;
    // Subtotal / total exclude the breakdown rows (they decompose 'Estrazione (tot.)').
    const sub = present.reduce((s, r) => s + (r.breakdown ? 0 : timings[r.key] ?? 0), 0);
    total += sub;
    html +=
      `<div class="debug-log-row debug-log-group"><span class="debug-log-k">${g.title}</span>` +
      `<span class="debug-log-v">${ms(sub)}</span></div>`;
    for (const r of present) {
      html +=
        `<div class="debug-log-row indent${r.breakdown ? ' breakdown' : ''}">` +
        `<span class="debug-log-k">${r.breakdown ? '· ' : ''}${r.label}</span>` +
        `<span class="debug-log-v">${ms(timings[r.key])}</span></div>`;
    }
    if (hasAngles) {
      html += `<div class="debug-log-row indent"><span class="debug-log-k">Angoli provati</span><span class="debug-log-v">${timings.morphAngles}</span></div>`;
    }
  }
  html += `<div class="debug-log-row debug-log-total"><span class="debug-log-k">Totale misurato</span><span class="debug-log-v">${ms(total)}</span></div>`;
  return html;
}

// --- LOG view: Confidenza tab ----------------------------------------------
// Explains, in plain Italian, WHY each candidate (Luminanza / Morfologica) got its confidence.
// It leads with a one-line verdict naming the LIMITING factor — so a good grid that reads low (e.g.
// one axis found few lines) is understandable at a glance — then shows the multiplication that
// builds the score (qualità × quadratura = interna, lifted by cross-method agreement into the
// final), then the per-axis evidence as a drill-down table. All numbers come straight from
// GridResult.info.confBreakdown (gridConfidence's own inputs) — never re-derived by eye. Pure.
export function renderConfidenceLog(): string {
  const pipes = S.lastResult?.debugPipelines ?? [];
  if (!pipes.length) return '<div class="debug-log-row indent"><span class="debug-log-k">Nessun candidato</span></div>';
  const pct = (v: number) => (isFinite(v) ? Math.round(v * 100) : 0) + '%';
  const agree = S.lastResult?.debugAgreement; // cross-method (main↔morph) agreement, or null
  const row = (k: string, v: string, cls = '') =>
    `<div class="debug-log-row indent${cls ? ' ' + cls : ''}"><span class="debug-log-k">${k}</span><span class="debug-log-v">${v}</span></div>`;

  let html = '';
  for (const p of pipes) {
    const chosenCls = p.chosen ? ' chosen' : '';
    html +=
      `<div class="debug-log-row debug-log-group${chosenCls}"><span class="debug-log-k">${p.label}${p.chosen ? ' ★' : ''}</span>` +
      `<span class="debug-log-v">${pct(p.confidence)}</span></div>`;
    const bd = p.breakdown;
    if (!bd) {
      html += row('Dettaglio non disponibile', '—');
      continue;
    }

    // 1) Headline verdict: the single factor that most limits the score (or, when strong, carries it).
    const strong = bd.internal >= 0.55;
    const strongShape = bd.squareness >= 0.85 && bd.perp >= 0.85;
    const verdict = strong
      ? '✓ Griglia solida' + (strongShape ? ', celle quadrate e perpendicolari' : '')
      : '⚠ Punto debole: ' + confWeakness(bd);
    html += `<div class="debug-log-row indent conf-why${strong ? '' : ' warn'}"><span class="debug-log-k">${verdict}</span></div>`;

    // This fit is the WINNER of a hypothesise-and-verify search: perpendicularity judged N
    // (VP × rectifica) hypotheses and picked it. Surface it so the log matches the graph — the fit
    // is NOT a linear pipeline, the perpendicularity is the arbiter that chose the vanishing point.
    const perpDbg = p.id === 'morph' ? S.lastResult?.debugPerpMorph : S.lastResult?.debugPerpLum;
    if (perpDbg?.hypotheses != null)
      html += row('Selezione: la perpendicolarità ha scelto fra', `${perpDbg.hypotheses} ipotesi VP`, 'conf-mid');

    // 2) How the internal confidence is built: qualità × proporzioni × perpendicolarità = interna,
    //    poi + accordo = finale.
    html += row('Qualità delle direzioni', pct(bd.pair));
    if (bd.degenerate) {
      html += row('Penalità «griglia degenere»', '× 0.1');
      html += row('Confidenza interna', `${pct(bd.pair)} × 0.1 = ${pct(bd.internal)}`, 'conf-mid');
    } else {
      html += row('Celle quadrate (proporzioni)', pct(bd.squareness));
      html += row('Perpendicolarità (giudice · primo piano)', pct(bd.perp));
      html += row(
        'Confidenza interna',
        `${pct(bd.pair)} × ${pct(bd.squareness)} × ${pct(bd.perp)} = ${pct(bd.internal)}`,
        'conf-mid',
      );
    }
    html += row('Accordo tra i due metodi', agree != null ? pct(agree) : '—');
    html += row('Confidenza finale', pct(p.confidence), 'conf-final');

    // 3) Drill-down: the per-axis evidence that produced each direction's quality. The weaker axis
    //    (the one that drives «Qualità delle direzioni» down) is flagged with ⚠.
    const weakA = bd.qA <= bd.qB;
    html +=
      '<table class="conf-table"><tbody>' +
      '<tr class="conf-h"><td>direzione</td><td>linee</td><td>allineam.</td><td>riempim.</td><td>celle</td><td>qualità</td></tr>' +
      `<tr><td>Asse 1</td><td>${bd.countA}</td><td>${pct(bd.inlierA)}</td><td>${pct(bd.fillA)}</td><td>${bd.spanA}</td><td>${pct(bd.qA)}${weakA ? ' ⚠' : ''}</td></tr>` +
      `<tr><td>Asse 2</td><td>${bd.countB}</td><td>${pct(bd.inlierB)}</td><td>${pct(bd.fillB)}</td><td>${bd.spanB}</td><td>${pct(bd.qB)}${weakA ? '' : ' ⚠'}</td></tr>` +
      '</tbody></table>';
  }
  return html;
}

/** Names, in plain Italian, the single factor most limiting a candidate's internal confidence, so
 * the "Confidenza" verdict can explain a low score. Mirrors gridConfidenceBreakdown exactly:
 * internal = pair · squareness · perp · (degenerate ? 0.1). The three multiplicative factors are the
 * weaker axis's quality (≈pair), squareness (proportions) and perpendicularity (shear); the smallest
 * limits the score most. `pair` is driven by the WEAKER axis, quality = evidence(#linee) ·
 * (0.6·allineamento + 0.4·riempimento). */
export function confWeakness(bd: ConfBreakdown): string {
  if (bd.degenerate) return 'passo dimezzato (linee troppo fitte, griglia «degenere»)';
  const weakA = bd.qA <= bd.qB;
  const wq = weakA ? bd.qA : bd.qB;
  const axisN = weakA ? 1 : 2;
  const count = weakA ? bd.countA : bd.countB;
  const inlier = weakA ? bd.inlierA : bd.inlierB;
  const fill = weakA ? bd.fillA : bd.fillB;
  // internal = wq(≈pair) · squareness · perp — blame whichever factor is smallest.
  const minF = Math.min(wq, bd.squareness, bd.perp);
  if (minF === bd.perp) return `celle sghembe / poco perpendicolari (${Math.round(bd.perp * 100)}%)`;
  if (minF === bd.squareness) {
    const ar = isFinite(bd.harmonicAspect) && bd.harmonicAspect > 0 ? `${bd.harmonicAspect.toFixed(1)}:1` : 'estremo';
    return `celle poco quadrate (aspetto ${ar})`;
  }
  // Inside the weaker axis: too few lines (evidence), or lines irregular / grid incomplete (quality)?
  const evidence = Math.max(0, Math.min(1, (count - 1) / 6));
  const quality = 0.6 * inlier + 0.4 * fill;
  if (evidence <= quality) return `asse ${axisN}: poche linee rilevate (${count})`;
  return inlier <= fill
    ? `asse ${axisN}: linee poco allineate (${Math.round(inlier * 100)}%)`
    : `asse ${axisN}: griglia poco riempita (${Math.round(fill * 100)}%)`;
}

export function initDebug() {
// Debug has no on-screen switch: triple-tap the logo (within 600ms) toggles it on/off.
// Debug diagnostics (stage previews, timings, confidence breakdown) are computed ONLY in debug mode
// to keep normal captures lean, so ENTERING debug re-runs detection on the current photo to produce
// them (recompute-on-demand, rather than paying the cost on every shot).
let brandTaps: number[] = [];
brand.addEventListener('click', () => {
  const now = Date.now();
  brandTaps = brandTaps.filter((t) => now - t < 600);
  brandTaps.push(now);
  if (brandTaps.length >= 3) {
    brandTaps = [];
    S.debug = !S.debug;
    btnLoadImage.hidden = !S.debug; // the gallery-load button is a debug affordance
    dbgBadge.hidden = !S.debug; // DBG chip next to the version replaces the old status text
    updateFocusBadge(); // focus indicator shows/hides with the DBG chip
    // Entering debug on a photo whose result lacks the debug data → recompute it once, on demand.
    if (S.debug && S.lastCapture && S.showingResult && !S.lastResult?.debugSteps) {
      runDetection();
    } else {
      draw(); // repaint (edge/line overlay appears/disappears with debug)
      rebuildDebugBar(); // show/hide the pipeline panel
    }
  }
});
// Debug-only: pick a saved photo from the gallery and analyse it like a capture.
btnLoadImage.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = ''; // let the same file be picked again
  if (!file || !S.debug) return; // debug-only, even if debug was toggled off mid-pick
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    if (camera.isRunning) camera.stop();
    video.hidden = true;
    processImage(c);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Immagine non valida');
  };
  img.src = url;
});
}
