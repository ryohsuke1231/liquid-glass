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

/** The corners of a body of height `h` (glass.frag's cornerShape()). */
export function bodyCorner(radius, smoothing, h) {
    const r = Math.max(Math.min(radius, h / 2), 0);
    const s = Math.min(Math.max(smoothing, 0), 1);
    const k = Math.min(1 + s, Math.max(h / 2 / Math.max(r, 1e-3), 1));
    return { reach: r * k, exponent: -1 / Math.log2(1 - 0.29289322 / k) };
}

/**
 * A fillet of `radius` as glass.frag's smoothUnion() draws it: smoothed like a corner with room to grow, a superellipse
 * quarter that keeps a circle's midpoint.
 */
export function filletShape(radius, smoothing) {
    const k = 1 + Math.min(Math.max(smoothing, 0), 1);
    return { reach: Math.max(radius, 0) * k, exponent: -1 / Math.log2(1 - 0.29289322 / k) };
}

// Must match glass.frag's GROWTH_CURVE_POINTS.
export const GROWTH_CURVE_POINTS = 17;
// How far into the menu its glass over a joint reaches (px).
const JOIN_OVERLAP = 64;
const PROFILE_STEPS = (GROWTH_CURVE_POINTS - 1) * 2;

// A superellipse quarter `reach` across, from heading straight down its side to heading straight across its bottom,
// as the length of each step along it and the direction it heads in there, in radians from straight down.
function quarterProfile({ reach, exponent }) {
    const ds = [], heading = [];
    let [pu, pv] = [-reach, 0];
    for (let i = 1; i <= PROFILE_STEPS; i++) {
        const t = i / PROFILE_STEPS * Math.PI / 2;
        const u = -reach * Math.cos(t) ** (2 / exponent), v = reach * Math.sin(t) ** (2 / exponent);
        ds.push(Math.hypot(u - pu, v - pv));
        heading.push(Math.atan2(u - pu, v - pv));
        [pu, pv] = [u, v];
    }
    return { ds, heading };
}

/**
 * How a menu's side that comes within the fillet and the corner of a body's end joins it, in a frame where the side
 * is the line u = -inside, the body's end is u = 0 and its top v = 0, with v growing into the body: points from the
 * side down to where the corner meets the end, or null if both fit. The fillet and the corner each keep their own
 * curvature but turn less, over a shorter run, as the room runs out, so the side steps out in an S whose curvature
 * passes through zero where it turns from one to the other, and flattens out as the side nears the end.
 */
export function joinCurve(inside, fillet, corner) {
    const concave = quarterProfile(fillet);
    const convex = quarterProfile(corner);
    const ds = [...concave.ds, ...convex.ds.reverse()];
    const heading = [...concave.heading, ...convex.heading.reverse()];
    // How far across a share `t` of both turns, over that share of their length, takes the side.
    const across = (t) => ds.reduce((sum, step, i) => sum + step * t * Math.sin(heading[i] * t), 0);
    if (inside >= across(1))
        return null;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (across(mid) < inside)
            lo = mid;
        else
            hi = mid;
    }
    const points = [[0, 0]];
    let [u, v] = [0, 0];
    ds.forEach((step, i) => {
        u += step * lo * Math.sin(heading[i] * lo);
        v += step * lo * Math.cos(heading[i] * lo);
        // Every fourth step: GROWTH_CURVE_POINTS points in all.
        if (i % 4 === 3)
            points.push([u, v]);
    });
    // It ends on the body's end, where the corner does.
    return points.map(([pu, pv]) => [pu - u, pv - v + corner.reach]);
}

/**
 * The glass's bodies and the glass of each menu in `menus` (both on the stage). A menu's glass starts where the
 * corners of the body it grows out of begin to round, so it covers them. A side of the menu over the body's
 * straight part joins it through a concave fillet. A side too near the body's end for the fillet and the corner to
 * fit joins it along joinCurve(), and the corner of the body there along with it. A side that reaches the end runs
 * flush into it, the end moving out to the menu, so the two make one straight side across the body. Islands that come
 * to touch become one.
 */
export function layoutGrowths(bodies, menus, { minX, maxX, fillet, smoothing, corner: cornerOf, direction }) {
    bodies = bodies.map(body => [...body]);
    const growths = [];
    const filletCurve = filletShape(fillet, smoothing);
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
        const corner = cornerOf(body[3]);
        const reach = corner.reach;
        // The body's side things grow from, and where the corners of its far side begin to round.
        const face = direction > 0 ? body[1] + body[3] : body[1];
        const back = (direction > 0 ? body[1] : body[1] + body[3]) + reach * direction;
        // One side: the menu's `edge`, the body's `end` and `out`, the way out of the body (-1 left, 1 right).
        const side = (edge, end, out) => {
            const inside = (end - edge) * out;
            if (inside <= 0 || reach <= 0) {
                const at = Math.min(Math.max(edge, minX), maxX);
                return { edge: at, end: (at - end) * out > 0 ? at : end, fillet: 0, curve: null };
            }
            const join = fillet >= 0.5 ? joinCurve(inside, filletCurve, corner) : null;
            if (!join)
                return { edge, end, fillet, curve: null };
            // To the stage, walked so that the glass is always on its left.
            const points = join.map(([u, v]) => [end + u * out, face - v * direction]);
            if (out * direction > 0)
                points.reverse();
            // The menu's glass runs on over the joint, from where the curve starts to where the far corners begin and
            // from the end to well inside the menu: an overlap of a pixel or so leaves the field near zero along the
            // menu's side, which the rim draws as a line.
            const ys = points.map(p => p[1]);
            const overlap = Math.min(JOIN_OVERLAP, mw / 2);
            const x0 = out > 0 ? edge - overlap : end, x1 = out > 0 ? end : edge + overlap;
            const y0 = Math.min(...ys, back), y1 = Math.max(...ys, back);
            const curve = { points, clip: [face - reach * direction, -direction], box: [x0, y0, x1 - x0, y1 - y0] };
            return { edge, end, fillet: 0, curve };
        };
        const left = side(mx, body[0], -1);
        const right = side(mx + mw, body[0] + body[2], 1);
        body[0] = left.end;
        body[2] = right.end - left.end;
        const x = left.edge, w = right.edge - left.edge;
        const fillets = [left.fillet, right.fillet];
        const curves = [left.curve, right.curve];
        if (direction > 0) {
            const top = Math.min(my, body[1] + body[3] - reach);
            growths.push({ x, y: top, w, h: my + mh - top, radii: [0, 0, radius, radius], fillets, curves });
        }
        else {
            const bottom = Math.max(my + mh, body[1] + reach);
            growths.push({ x, y: my, w, h: bottom - my, radii: [radius, radius, 0, 0], fillets, curves });
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

/** `growth` moved by (dx, dy). */
export function moveGrowth(growth, dx, dy) {
    return {
        ...growth, x: growth.x + dx, y: growth.y + dy,
        curves: growth.curves.map(curve => curve && {
            points: curve.points.map(([x, y]) => [x + dx, y + dy]),
            clip: [curve.clip[0] + dy, curve.clip[1]],
            box: [curve.box[0] + dx, curve.box[1] + dy, curve.box[2], curve.box[3]],
        }),
    };
}
