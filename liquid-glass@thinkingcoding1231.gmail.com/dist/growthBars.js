const liveGrowthBars = new Set();

export function addGrowthBar(bar) {
    liveGrowthBars.add(bar);
}

export function removeGrowthBar(bar) {
    liveGrowthBars.delete(bar);
}

/** The glass whose button `source` is, while what opens from it grows out of the glass by `key`, or null. */
export function growthBarFrom(source, key) {
    if (!source)
        return null;
    for (const bar of liveGrowthBars)
        if (bar.growsFrom(source, key))
            return bar;
    return null;
}

/** How far in from its edge a body of height `h` starts to round its corners, as glass.frag's cornerShape() draws them. */
export function cornerReach(radius, smoothing, h) {
    const r = Math.max(Math.min(radius, h / 2), 0);
    const s = Math.min(Math.max(smoothing, 0), 1);
    return r * Math.min(1 + s, Math.max(h / 2 / Math.max(r, 1e-3), 1));
}

/**
 * The glass's bodies and the glass of each menu in `menus` (both on the stage). A menu's glass starts where the
 * corners of the body it grows out of begin to round, so it covers them. A side of the menu over the body's
 * straight part joins it through a concave fillet; a side that reaches the body's rounded end runs flush into it,
 * the end moving out to the menu, so the two make one straight side across the body. Across the rounded end one
 * turns into the other. Islands that come to touch become one.
 */
export function layoutGrowths(bodies, menus, { minX, maxX, fillet, reach: reachOf, direction }) {
    bodies = bodies.map(body => [...body]);
    const growths = [];
    for (const { rect: [mx, my, mw, mh], radius } of menus) {
        // The body the menu comes out of: the one it overlaps most, or else the nearest.
        let body = bodies[0], best = -Infinity;
        for (const b of bodies) {
            const overlap = Math.min(b[0] + b[2], mx + mw) - Math.max(b[0], mx);
            if (overlap > best) {
                best = overlap;
                body = b;
            }
        }
        const reach = reachOf(body[3]);
        // One side: the menu's `edge`, the body's `end` and `out`, the way out of the body (-1 left, 1 right).
        const side = (edge, end, out) => {
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
        }
        else {
            const bottom = Math.max(my + mh, body[1] + reach);
            growths.push({ x, y: my, w, h: bottom - my, radii: [radius, radius, 0, 0], fillets: [left.fillet, right.fillet] });
        }
    }
    bodies.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const b of bodies) {
        const last = merged[merged.length - 1];
        if (last && b[0] <= last[0] + last[2])
            last[2] = Math.max(last[0] + last[2], b[0] + b[2]) - last[0];
        else
            merged.push(b);
    }
    return { bodies: merged, growths };
}
