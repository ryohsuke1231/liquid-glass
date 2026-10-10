// Guides for an item being moved on the desktop: where it lines up with the
// other items (the same edge, or the same centre line), with the middle of
// the work area, and where it sits as far from one item as that item is from
// the next. Near such a place the item is pulled onto it.

import type { Rect } from './placement.js';

export interface Guide {
  // A vertical line at x = `at` from y = `from` to `to`, or a horizontal one.
  vertical: boolean;
  at: number;
  from: number;
  to: number;
  // 'spacing' marks one of the equal gaps.
  kind: 'align' | 'spacing';
}

// Lines up within this, px.
const EXACT = 0.5;

// One axis of a rect, so both axes share the code: `lo`..`hi` along it, and
// `across` the span on the other axis.
interface Span { lo: number; hi: number; mid: number; across: [number, number]; }

function span(r: Rect, horizontal: boolean): Span {
  const [lo, size, alo, asize] = horizontal ? [r.x, r.width, r.y, r.height] : [r.y, r.height, r.x, r.width];
  return { lo, hi: lo + size, mid: lo + size / 2, across: [alo, alo + asize] };
}

function overlap(a: [number, number], b: [number, number]): [number, number] | null {
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  return hi > lo ? [lo, hi] : null;
}

// A place along the axis for the moved item's low edge, and the guides that
// show it.
interface Stop { lo: number; guides: Guide[]; }

// The places along one axis for an item spanning `m`. The guides of an
// alignment are lines across the axis; those of a spacing run along it.
function stops(m: Span, others: Span[], area: Span | null, horizontal: boolean): Stop[] {
  const size = m.hi - m.lo;
  const out: Stop[] = [];
  const line = (at: number, a: [number, number], b: [number, number]): Guide =>
    ({ vertical: horizontal, at, from: Math.min(a[0], b[0]), to: Math.max(a[1], b[1]), kind: 'align' });
  const gap = (from: number, to: number, a: [number, number], b: [number, number]): Guide => {
    const shared = overlap(a, b) ?? a;
    return { vertical: !horizontal, at: (shared[0] + shared[1]) / 2, from, to, kind: 'spacing' };
  };
  // The moved item's span across, where it will be: unchanged by a move along this axis.
  const across = m.across;
  for (const o of others) {
    out.push({ lo: o.lo, guides: [line(o.lo, across, o.across)] });
    out.push({ lo: o.hi - size, guides: [line(o.hi, across, o.across)] });
    out.push({ lo: o.mid - size / 2, guides: [line(o.mid, across, o.across)] });
  }
  if (area) out.push({ lo: area.mid - size / 2, guides: [line(area.mid, area.across, area.across)] });

  // Equal gaps, among items in one row or column with the moved one.
  const inLine = others.filter(o => overlap(o.across, across));
  for (const p of inLine) {
    for (const q of inLine) {
      if (p === q || q.lo < p.hi) continue;
      const g = q.lo - p.hi;
      const pq = gap(p.hi, q.lo, p.across, q.across);
      out.push({ lo: q.hi + g, guides: [pq, gap(q.hi, q.hi + g, q.across, across)] });
      out.push({ lo: p.lo - g - size, guides: [pq, gap(p.lo - g, p.lo, across, p.across)] });
      // Between the two, as far from each.
      const half = (g - size) / 2;
      if (half >= 0) {
        out.push({ lo: p.hi + half, guides: [gap(p.hi, p.hi + half, p.across, across),
          gap(q.lo - half, q.lo, across, q.across)] });
      }
    }
  }
  return out;
}

/**
 * Where an item at `rect` goes near the guides, within `reach` px each way,
 * and the guides it then lines up with. `area` is the work area.
 */
export function snapMove(rect: Rect, others: Rect[], area: Rect | null, reach: number):
  { dx: number, dy: number, guides: Guide[] } {
  const axis = (horizontal: boolean, at: Rect) => {
    const m = span(at, horizontal);
    const list = stops(m, others.map(o => span(o, horizontal)), area ? span(area, horizontal) : null, horizontal);
    let best: Stop | null = null;
    for (const stop of list) {
      if (Math.abs(stop.lo - m.lo) <= reach && (!best || Math.abs(stop.lo - m.lo) < Math.abs(best.lo - m.lo)))
        best = stop;
    }
    return best ? best.lo - m.lo : 0;
  };
  const dx = axis(true, rect);
  const dy = axis(false, rect);
  const placed = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
  const guides: Guide[] = [];
  for (const horizontal of [true, false]) {
    const m = span(placed, horizontal);
    const list = stops(m, others.map(o => span(o, horizontal)), area ? span(area, horizontal) : null, horizontal);
    for (const stop of list) {
      if (Math.abs(stop.lo - m.lo) < EXACT) guides.push(...stop.guides);
    }
  }
  return { dx, dy, guides: merge(guides) };
}

// One line for guides on the same line, and none twice.
function merge(guides: Guide[]): Guide[] {
  const out: Guide[] = [];
  for (const g of guides) {
    const same = out.find(o => o.kind === g.kind && o.vertical === g.vertical && Math.abs(o.at - g.at) < EXACT &&
      (g.kind === 'align' || (Math.abs(o.from - g.from) < EXACT && Math.abs(o.to - g.to) < EXACT)));
    if (!same) {
      out.push({ ...g });
    } else {
      same.from = Math.min(same.from, g.from);
      same.to = Math.max(same.to, g.to);
    }
  }
  return out;
}
