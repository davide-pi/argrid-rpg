// Pinch / drag / wheel zoom+pan for the result canvas. Applies a CSS transform
// to the element (transform-origin at its top-left) so the analysed image can
// be inspected after rendering. Call reset() when a new image is shown.

export interface ZoomController {
  reset(): void;
}

export interface ZoomOptions {
  /** While this returns true, pan/pinch are suppressed (e.g. rotating the angle
   * ring) so the gesture doesn't also move the map. Zoom stays where it is. */
  suppress?: () => boolean;
}

export function attachZoomPan(el: HTMLElement, opts: ZoomOptions = {}): ZoomController {
  const suppressed = () => opts.suppress?.() ?? false;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const MIN = 1;
  const MAX = 8;

  const apply = () => {
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const reset = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };

  // Zoom keeping the point under (clientX, clientY) fixed on screen.
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const ns = Math.min(MAX, Math.max(MIN, scale * factor));
    if (ns === scale) return;
    const rect = el.getBoundingClientRect();
    const dx = clientX - rect.left;
    const dy = clientY - rect.top;
    tx += dx * (1 - ns / scale);
    ty += dy * (1 - ns / scale);
    scale = ns;
    if (scale === MIN) {
      tx = 0;
      ty = 0;
    }
    apply();
  };

  const panBy = (mx: number, my: number) => {
    if (scale <= MIN) return;
    tx += mx;
    ty += my;
    apply();
  };

  el.style.touchAction = 'none';

  el.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );

  // Mouse drag to pan (desktop).
  let dragging = false;
  el.addEventListener('mousedown', (e: MouseEvent) => {
    if (scale <= MIN || suppressed()) return;
    dragging = true;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging && !suppressed()) panBy(e.movementX, e.movementY);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  // Touch: pinch to zoom, one finger to pan.
  let lastDist = 0;
  let lastX = 0;
  let lastY = 0;
  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  el.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        lastDist = dist(e.touches);
      } else if (e.touches.length === 1) {
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
      }
    },
    { passive: false },
  );
  el.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const nd = dist(e.touches);
        if (lastDist > 0) {
          const m = mid(e.touches);
          zoomAt(m.x, m.y, nd / lastDist);
        }
        lastDist = nd;
      } else if (e.touches.length === 1 && scale > MIN && !suppressed()) {
        e.preventDefault();
        const t = e.touches[0];
        panBy(t.clientX - lastX, t.clientY - lastY);
        lastX = t.clientX;
        lastY = t.clientY;
      }
    },
    { passive: false },
  );
  el.addEventListener('touchend', (e: TouchEvent) => {
    lastDist = 0;
    if (e.touches.length === 1) {
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
    }
  });

  return { reset };
}
