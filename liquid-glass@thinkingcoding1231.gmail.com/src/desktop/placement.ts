// Where an item on the desktop goes: a corner or the center of the primary
// monitor's work area, or where the user moved it, kept as the fraction of
// the work area its center is at so it survives a resolution change.

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
 * the edge (or on top, at the center). Returns each item's top left corner.
 */
export function stackAt(anchor: Anchor, area: Rect, sizes: [number, number][]): [number, number][] {
  const total = sizes.reduce((sum, [, h]) => sum + h, 0) + ITEM_GAP * Math.max(sizes.length - 1, 0);
  const bottom = anchor === 'bottom-left' || anchor === 'bottom-right';
  let y = anchor === 'center'
    ? area.y + (area.height - total) / 2
    : bottom ? area.y + area.height - EDGE_MARGIN - total : area.y + EDGE_MARGIN;
  // Bottom stacks keep their first item nearest the edge.
  const order = bottom ? [...sizes.keys()].reverse() : [...sizes.keys()];
  const out: [number, number][] = Array.from({ length: sizes.length }, () => [0, 0] as [number, number]);
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

/** The top left corner of an item of `size` whose center is at `fraction` of `area`, kept inside it. */
export function placeAtFraction(fraction: [number, number], area: Rect, size: [number, number]): [number, number] {
  const [w, h] = size;
  const x = area.x + fraction[0] * area.width - w / 2;
  const y = area.y + fraction[1] * area.height - h / 2;
  return [
    Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(area.width - w, 0))),
    Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(area.height - h, 0))),
  ];
}

/** The fraction of `area` the center of an item at `pos` of `size` is at. */
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

// Where the user moved an item to: the fraction of the work area its center
// was at, and the item's height then. The height keeps its top edge in place
// when the content grows or shrinks; older entries have none.
export type SavedPosition = [number, number] | [number, number, number];

// The positions the user moved items to, by item id, as stored in the
// `desktop-item-positions` setting. Anything unreadable counts as none.
export function parsePositions(json: string): Record<string, SavedPosition> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    return {};
  }
  const out: Record<string, SavedPosition> = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && (value.length === 2 || value.length === 3) &&
        value.every(v => typeof v === 'number' && Number.isFinite(v)))
      out[id] = value.length === 2 ? [value[0], value[1]] : [value[0], value[1], value[2]];
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

// Items put one above the other stay a stack: the farthest apart two are
// still taken as neighbours.
const COLUMN_GAP = ITEM_GAP * 4;

function shareColumn(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  return overlap >= Math.min(a.width, b.width) / 2;
}

/**
 * Where items the user moved go, given each one's rect as it was put and its
 * size now. Items that were put in a column are kept in one: the topmost shown
 * stays where it was and the rest follow it with the usual gap, so an item that
 * grows, shrinks or is hidden moves the ones below it instead of overlapping them
 * or leaving a hole. Returns each item's top left corner, in the order given;
 * a hidden item's is not used.
 */
export function stackColumns(items: { saved: Rect, size: [number, number], shown: boolean }[], area: Rect): [number, number][] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].saved.y - items[b].saved.y);
  const columns: number[][] = [];
  for (const i of order) {
    const r = items[i].saved;
    let best: number[] | null = null;
    for (const column of columns) {
      const last = items[column[column.length - 1]].saved;
      if (!shareColumn(last, r) || r.y - (last.y + last.height) > COLUMN_GAP) continue;
      if (!best || last.y > items[best[best.length - 1]].saved.y) best = column;
    }
    if (best) best.push(i);
    else columns.push([i]);
  }
  const out: [number, number][] = Array.from({ length: items.length });
  for (const column of columns) {
    const shown = column.filter(i => items[i].shown);
    for (const i of column) out[i] = [Math.round(items[i].saved.x), Math.round(items[i].saved.y)];
    if (shown.length === 0) continue;
    const total = shown.reduce((sum, i) => sum + items[i].size[1], 0) + ITEM_GAP * (shown.length - 1);
    let y = Math.max(Math.min(items[shown[0]].saved.y, area.y + area.height - total), area.y);
    for (const i of shown) {
      out[i][1] = Math.round(y);
      y += items[i].size[1] + ITEM_GAP;
    }
  }
  return out;
}
