// Where an item on the desktop goes: a corner or the centre of the primary
// monitor's work area, or where the user moved it, kept as the fraction of
// the work area its centre is at so it survives a resolution change.

export type Anchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export const ANCHORS: readonly Anchor[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];

export interface Rect { x: number; y: number; width: number; height: number; }

// Room between an item and the edge of the work area, and between items.
export const EDGE_MARGIN = 32;
export const ITEM_GAP = 16;

export function sanitizeAnchor(value: string, fallback: Anchor = 'top-right'): Anchor {
  return (ANCHORS as readonly string[]).includes(value) ? value as Anchor : fallback;
}

/**
 * Stacks items of the given sizes at `anchor` of `area`, the first nearest
 * the edge (or on top, at the centre). Returns each item's top left corner.
 */
export function stackAt(anchor: Anchor, area: Rect, sizes: [number, number][]): [number, number][] {
  const total = sizes.reduce((sum, [, h]) => sum + h, 0) + ITEM_GAP * Math.max(sizes.length - 1, 0);
  const bottom = anchor === 'bottom-left' || anchor === 'bottom-right';
  let y = anchor === 'center'
    ? area.y + (area.height - total) / 2
    : bottom ? area.y + area.height - EDGE_MARGIN - total : area.y + EDGE_MARGIN;
  // Bottom stacks keep their first item nearest the edge.
  const order = bottom ? [...sizes.keys()].reverse() : [...sizes.keys()];
  const out: [number, number][] = new Array(sizes.length);
  for (const i of order) {
    const [w, h] = sizes[i];
    const x = anchor === 'center'
      ? area.x + (area.width - w) / 2
      : anchor.endsWith('left') ? area.x + EDGE_MARGIN : area.x + area.width - EDGE_MARGIN - w;
    out[i] = [Math.round(x), Math.round(y)];
    y += h + ITEM_GAP;
  }
  return out;
}

/** The top left corner of an item of `size` whose centre is at `fraction` of `area`, kept inside it. */
export function placeAtFraction(fraction: [number, number], area: Rect, size: [number, number]): [number, number] {
  const [w, h] = size;
  const x = area.x + fraction[0] * area.width - w / 2;
  const y = area.y + fraction[1] * area.height - h / 2;
  return [
    Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(area.width - w, 0))),
    Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(area.height - h, 0))),
  ];
}

/** The fraction of `area` the centre of an item at `pos` of `size` is at. */
export function fractionOf(pos: [number, number], area: Rect, size: [number, number]): [number, number] {
  const fx = (pos[0] + size[0] / 2 - area.x) / Math.max(area.width, 1);
  const fy = (pos[1] + size[1] / 2 - area.y) / Math.max(area.height, 1);
  return [Math.min(Math.max(fx, 0), 1), Math.min(Math.max(fy, 0), 1)];
}

// Which edges of a rect a resize handle moves, per axis: the low one (-1),
// the high one (1) or neither (0).
export type HandleSide = -1 | 0 | 1;

/** `rect` with the edges a handle holds moved by (dx, dy), at least `min` px each way. */
export function resizeRect(rect: Rect, hx: HandleSide, hy: HandleSide, dx: number, dy: number, min: number): Rect {
  const out = { ...rect };
  if (hx > 0) out.width = Math.max(rect.width + dx, min);
  if (hx < 0) {
    out.width = Math.max(rect.width - dx, min);
    out.x = rect.x + rect.width - out.width;
  }
  if (hy > 0) out.height = Math.max(rect.height + dy, min);
  if (hy < 0) {
    out.height = Math.max(rect.height - dy, min);
    out.y = rect.y + rect.height - out.height;
  }
  return out;
}

// The positions the user moved items to, by item id, as stored in the
// `desktop-item-positions` setting. Anything unreadable counts as none.
export function parsePositions(json: string): Record<string, [number, number]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    return {};
  }
  const out: Record<string, [number, number]> = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v)))
      out[id] = [value[0], value[1]];
  }
  return out;
}

/** The JSON of desktop-widget-anchors as id → anchor, skipping anything that is not one. */
export function parseAnchors(json: string): Record<string, Anchor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    return {};
  }
  const out: Record<string, Anchor> = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && (ANCHORS as readonly string[]).includes(value)) out[id] = value as Anchor;
  }
  return out;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The top left corner of a button of `size` beside `frame`, `gap` px off it:
 * below, above, right or left of it, whichever comes first that is inside
 * `area` and clear of `obstacles`. Kept inside `area` when none is.
 */
export function placeBeside(frame: Rect, size: [number, number], gap: number, area: Rect, obstacles: Rect[]): [number, number] {
  const [w, h] = size;
  const clamp = (v: number, lo: number, span: number) => Math.min(Math.max(v, lo), lo + Math.max(span, 0));
  const cx = clamp(frame.x + (frame.width - w) / 2, area.x, area.width - w);
  const cy = clamp(frame.y + (frame.height - h) / 2, area.y, area.height - h);
  const candidates: [number, number][] = [
    [cx, frame.y + frame.height + gap],
    [cx, frame.y - gap - h],
    [frame.x + frame.width + gap, cy],
    [frame.x - gap - w, cy],
  ];
  const fits = ([x, y]: [number, number]) => {
    const r = { x, y, width: w, height: h };
    return x >= area.x && y >= area.y && x + w <= area.x + area.width && y + h <= area.y + area.height &&
      !obstacles.some(o => overlaps(r, o));
  };
  const [x, y] = candidates.find(fits) ?? [cx, clamp(candidates[0][1], area.y, area.height - h)];
  return [Math.round(x), Math.round(y)];
}
