import type Clutter from 'gi://Clutter';

import type { GlassGrowth } from './rendering/glassRenderer.js';

/**
 * Glass that menus can grow out of: a top bar's (down out of its bottom) or a dock's (up out of its top, or down
 * out of a dock at the top of the screen).
 */
export interface GrowthBar {
  /** 1 while what grows out of it grows down, -1 while it grows up. */
  readonly growDirection: 1 | -1;
  /** Whether what opens from `source`, a button on this glass, grows out of it by the setting `key`. */
  growsFrom(source: Clutter.Actor, key: string): boolean;
  /** The stage y of the glass's side that things grow out of. */
  glassEdge(): number;
  /**
   * Grows what `owner` holds out of the glass as `rect` ([x, y, w, h] on the stage, its near end inside the glass),
   * its free corners rounded by `radius`; null takes it back in.
   */
  setMenuGrowth(owner: object, rect: number[] | null, radius: number): void;
}

const liveGrowthBars = new Set<GrowthBar>();

export function addGrowthBar(bar: GrowthBar): void {
  liveGrowthBars.add(bar);
}

export function removeGrowthBar(bar: GrowthBar): void {
  liveGrowthBars.delete(bar);
}

/** The glass whose button `source` is, while what opens from it grows out of the glass by `key`, or null. */
export function growthBarFrom(source: Clutter.Actor | null, key: string): GrowthBar | null {
  if (!source) return null;
  for (const bar of liveGrowthBars)
    if (bar.growsFrom(source, key)) return bar;
  return null;
}

/** How far in from its edge a body of height `h` starts to round its corners, as glass.frag's cornerShape() draws them. */
export function cornerReach(radius: number, smoothing: number, h: number): number {
  const r = Math.max(Math.min(radius, h / 2), 0);
  const s = Math.min(Math.max(smoothing, 0), 1);
  return r * Math.min(1 + s, Math.max(h / 2 / Math.max(r, 1e-3), 1));
}

export interface GrowthLayoutOptions {
  // The glass actor's horizontal extent on the stage, which a body may not widen past.
  minX: number;
  maxX: number;
  // The concave fillet joining a menu's side to the body's straight part.
  fillet: number;
  // cornerReach() for a body of height `h`.
  reach: (h: number) => number;
  // 1: the menus hang below the bodies; -1: they stand on top of them.
  direction: 1 | -1;
}

/**
 * The glass's bodies and the glass of each menu in `menus` (both on the stage). A menu's glass starts where the
 * corners of the body it grows out of begin to round, so it covers them. A side of the menu over the body's
 * straight part joins it through a concave fillet; a side that reaches the body's rounded end runs flush into it,
 * the end moving out to the menu, so the two make one straight side across the body. Across the rounded end one
 * turns into the other. Islands that come to touch become one.
 */
export function layoutGrowths(bodies: number[][], menus: { rect: number[], radius: number }[],
  { minX, maxX, fillet, reach: reachOf, direction }: GrowthLayoutOptions): { bodies: number[][], growths: GlassGrowth[] } {
  bodies = bodies.map(body => [...body]);
  const growths: GlassGrowth[] = [];
  for (const { rect: [mx, my, mw, mh], radius } of menus) {
    // The body the menu comes out of: the one it overlaps most, or else the nearest.
    let body = bodies[0], best = -Infinity;
    for (const b of bodies) {
      const overlap = Math.min(b[0] + b[2], mx + mw) - Math.max(b[0], mx);
      if (overlap > best) { best = overlap; body = b; }
    }
    const reach = reachOf(body[3]);
    // One side: the menu's `edge`, the body's `end` and `out`, the way out of the body (-1 left, 1 right).
    const side = (edge: number, end: number, out: number) => {
      const flush = reach > 0 ? Math.min(Math.max(((edge - end) * out + reach) / reach, 0), 1) : 1;
      if (flush >= 1) {
        const at = Math.min(Math.max(edge, minX), maxX);
        return { edge: at, end: (at - end) * out > 0 ? at : end, fillet: 0 };
      }
      return { edge: edge + (end - edge) * flush, end, fillet: fillet * (1 - flush) };
    };
    const left = side(mx, body[0], -1);
    const right = side(mx + mw, body[0] + body[2], 1);
    body[0] = left.end;
    body[2] = right.end - left.end;
    const x = left.edge, w = right.edge - left.edge;
    if (direction > 0) {
      const top = Math.min(my, body[1] + body[3] - reach);
      growths.push({ x, y: top, w, h: my + mh - top, radii: [0, 0, radius, radius], fillets: [left.fillet, right.fillet] });
    } else {
      const bottom = Math.max(my + mh, body[1] + reach);
      growths.push({ x, y: my, w, h: bottom - my, radii: [radius, radius, 0, 0], fillets: [left.fillet, right.fillet] });
    }
  }
  bodies.sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const b of bodies) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[0] + last[2]) last[2] = Math.max(last[0] + last[2], b[0] + b[2]) - last[0];
    else merged.push(b);
  }
  return { bodies: merged, growths };
}
