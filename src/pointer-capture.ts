// Shared pointer plumbing used by BOTH the map-gesture handlers (gestures.ts) and the
// manual-grid editor (manual-grid.ts): the live active-pointer set and the best-effort
// pointer-capture helper. Kept in one module so both consumers mutate the same set.
import { view } from './dom';

// Pointer gestures on the map. On a PIECE (placement off): a quick TAP shows its
// movement, a LONG-PRESS opens its edit menu, a DRAG repositions it. Elsewhere: a
// tap sets the movement arrival (in move mode) or drops a piece/area (placement),
// and the angle ring / area origin / arrival cell can be dragged. Two pointers →
// pinch/pan (the zoom controller).
export const activePointers = new Set<number>();

export const capturePointer = (id: number) => {
  try {
    view.setPointerCapture(id);
  } catch {
    /* not all inputs support capture */
  }
};
