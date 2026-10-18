// The outline of a line of text as a signed distance field, for glass whose
// shape is the text itself (the glass clock).
//
// GJS cannot read a Cairo surface's pixels or a texture's back, so each glyph
// is drawn (with Pango, or from a font file the extension ships) into a Cairo
// surface that is written to a PNG and decoded here. Glyphs are measured once
// per font and kept: a new time only places the cached fields side by side.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Cairo from 'cairo';
import { traceGlyph } from './trueType.js';
import { decodePng } from '../imaging/png.js';
// Glyphs are drawn this many times larger and their fields scaled down, for
// sub-pixel accurate edges.
const SUPERSAMPLE = 2;

/** The coverage (alpha, 0-255) of every pixel of a PNG. */
export function decodePngAlpha(png) {
    const { width, height, channels, data } = decodePng(png);
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++)
        alpha[i] = channels === 4 ? data[i * 4 + 3] : channels === 2 ? data[i * 2 + 1] : data[i * channels];
    return { alpha, width, height };
}

// Distance transform
const INF = 1e20;

// How far (px) the edge is from a pixel's center, positive when the center is
// outside, from its coverage `a` (0 to 1) and the coverage's gradient: the
// edge is taken to be straight across the pixel (Gustavson's anti-aliased
// distance transform).
function edgeOffset(gx, gy, a) {
    if (gx === 0 || gy === 0)
        return 0.5 - a;
    const len = Math.hypot(gx, gy);
    let x = Math.abs(gx) / len, y = Math.abs(gy) / len;
    if (x < y)
        [x, y] = [y, x];
    const a1 = 0.5 * y / x;
    if (a < a1)
        return 0.5 * (x + y) - Math.sqrt(2 * x * y * a);
    if (a < 1 - a1)
        return (0.5 - a) * x;
    return -0.5 * (x + y) + Math.sqrt(2 * x * y * (1 - a));
}

// Signed distances (px, negative inside) from coverage (0-255), the piece of
// edge each pixel is nearest (the index of the pixel it crosses, or -1), and
// each piece's normal (into the glyph). Every pixel the outline crosses gets
// the short piece of edge that crosses it, placed to a fraction of a pixel
// from its coverage; every other
// pixel takes the nearest of those pieces from its neighbours. Distances to
// pixel centers instead would follow the pixels' staircase, which the glass
// shows as facets along a curve.
function edgeField(alpha, w, h) {
    const n = w * h;
    const cov = new Float32Array(n);
    for (let i = 0; i < n; i++)
        cov[i] = alpha[i] / 255;
    const at = (x, y) => cov[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
    // Each piece of edge: its middle, its normal (into the glyph) and half its length.
    const ex = new Float32Array(n);
    const ey = new Float32Array(n);
    const nx = new Float32Array(n);
    const ny = new Float32Array(n);
    const half = new Float32Array(n);
    const nearest = new Int32Array(n).fill(-1);
    const dist2 = new Float32Array(n).fill(INF);
    const squaredDistanceTo = (x, y, e) => {
        const dx = x - ex[e], dy = y - ey[e];
        const across = dx * nx[e] + dy * ny[e];
        const along = Math.max(Math.abs(dy * nx[e] - dx * ny[e]) - half[e], 0);
        return across * across + along * along;
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const a = cov[i];
            // The edge runs through this pixel, or right between it and a neighbour
            // covered the other way. A whole pixel next to a partly covered one
            // says little about where the edge is; the partly covered one does.
            const other = 1 - a;
            const crossed = (a > 0 && a < 1) || (x > 0 && cov[i - 1] === other) || (x < w - 1 && cov[i + 1] === other) ||
                (y > 0 && cov[i - w] === other) || (y < h - 1 && cov[i + w] === other);
            if (!crossed)
                continue;
            // Sobel, pointing into the glyph.
            const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
            const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
            const len = Math.hypot(gx, gy);
            if (len === 0)
                continue;
            const off = edgeOffset(gx, gy, a);
            nx[i] = gx / len;
            ny[i] = gy / len;
            ex[i] = x + nx[i] * off;
            ey[i] = y + ny[i] * off;
            half[i] = 0.5 / Math.max(Math.abs(nx[i]), Math.abs(ny[i]));
            nearest[i] = i;
            dist2[i] = squaredDistanceTo(x, y, i);
        }
    }
    const take = (i, x, y, j) => {
        const e = nearest[j];
        if (e < 0 || e === nearest[i])
            return;
        const d = squaredDistanceTo(x, y, e);
        if (d < dist2[i]) {
            dist2[i] = d;
            nearest[i] = e;
        }
    };
    // A sweep down and one back up over the 8 neighbours.
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (x > 0)
                take(i, x, y, i - 1);
            if (y > 0) {
                if (x > 0)
                    take(i, x, y, i - w - 1);
                take(i, x, y, i - w);
                if (x < w - 1)
                    take(i, x, y, i - w + 1);
            }
        }
        for (let x = w - 2; x >= 0; x--)
            take(y * w + x, x, y, y * w + x + 1);
    }
    for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
            const i = y * w + x;
            if (x < w - 1)
                take(i, x, y, i + 1);
            if (y < h - 1) {
                if (x < w - 1)
                    take(i, x, y, i + w + 1);
                take(i, x, y, i + w);
                if (x > 0)
                    take(i, x, y, i + w - 1);
            }
        }
        for (let x = 1; x < w; x++)
            take(y * w + x, x, y, y * w + x - 1);
    }
    const signed = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++)
        signed[i] = (alpha[i] >= 128 ? -1 : 1) * Math.sqrt(dist2[i]);
    return { signed, nearest, nx, ny };
}

/** Signed distances (px, negative inside) from coverage (0-255); see edgeField(). */
export function signedDistances(alpha, w, h) {
    return edgeField(alpha, w, h).signed;
}

// The box widths for three box blurs that together approximate a Gaussian of `sigma`.
function boxRadii(sigma) {
    const ideal = Math.sqrt(4 * sigma * sigma + 1);
    let lower = Math.floor(ideal);
    if (lower % 2 === 0)
        lower--;
    const upper = lower + 2;
    const m = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
    return [0, 1, 2].map(i => ((i < m ? lower : upper) - 1) / 2);
}

// One box blur of radius r along rows (step 1) or columns (step w), edges extended.
function boxBlur(src, dst, w, h, r, alongRows) {
    const [n, lines, step, lineStep] = alongRows ? [w, h, 1, w] : [h, w, w, 1];
    const norm = 1 / (2 * r + 1);
    const last = (n - 1) * step;
    for (let line = 0; line < lines; line++) {
        const base = line * lineStep;
        const first = src[base], end = src[base + last];
        let sum = 0;
        for (let k = -r; k <= r; k++)
            sum += src[base + Math.min(Math.max(k, 0), n - 1) * step];
        for (let k = 0; k < n; k++) {
            dst[base + k * step] = sum * norm;
            const add = k + r + 1, drop = k - r;
            sum += (add < n ? src[base + add * step] : end) - (drop > 0 ? src[base + drop * step] : first);
        }
    }
}

// The passes of a blur of about a Gaussian of `sigma` px over `a` (`w` x
// `h`), which holds the result after the last; `b` is room for the passes.
function blurPasses(a, b, w, h, sigma) {
    if (sigma <= 0.3)
        return [];
    return boxRadii(sigma).filter(r => r >= 1).flatMap(r => [
        () => boxBlur(a, b, w, h, r, true),
        () => boxBlur(b, a, w, h, r, false),
    ]);
}

/** `field` blurred by about a Gaussian of `sigma` px. */
export function softened(field, sigma) {
    const { width: w, height: h } = field;
    const a = Float32Array.from(field.data);
    for (const pass of blurPasses(a, new Float32Array(w * h), w, h, sigma))
        pass();
    return { data: a, width: w, height: h };
}

/** softened(), awaiting `pause` before each pass. */
export async function softenedInSteps(field, sigma, pause) {
    const { width: w, height: h } = field;
    const a = Float32Array.from(field.data);
    for (const pass of blurPasses(a, new Float32Array(w * h), w, h, sigma)) {
        await pause();
        pass();
    }
    return { data: a, width: w, height: h };
}

// Taller glyphs
//
// A glyph is made taller by drawing it that much taller, evenly, which also
// thickens its strokes: a flat one by the whole factor, an upright one not
// at all, a slanted or curved one in between. Its outline is then pulled
// back into the ink by what the stretch added on each side, as if the
// stretched strokes had been drawn with the font's own pen: an ellipse as
// wide as its upright strokes and as tall as its flat ones. Every piece of
// the outline moves along its normal by an amount that depends only on which
// way it faces, and neighbouring pieces meet where their moved lines cross,
// so corners stay sharp and curves stay smooth.
// Pieces of edge whose normal is this close to across (down) the rows are
// on the side of an upright (flat) stroke.
const SIDE_NORMAL = 0.9;
// How far (px) the traced outline may stray from the pixels' edge.
const TRACE_TOLERANCE = 0.2;
// Corners rounded off by less than this many strokes are made sharp (see sharpenCorners()).
const CORNER_SIZE = 0.3;
// A corner whose moved lines meet further out than this many times the move
// is too sharp to keep; it is cut off between them instead.
const MITER_LIMIT = 6;

// The mean of the middle half of `values`: one side of a stroke may reach
// its middle and the other not, and joins and ends are far off either way.
function middleMean(values) {
    values.sort((a, b) => a - b);
    const middle = values.slice(values.length >> 2, values.length - (values.length >> 2));
    return middle.length ? middle.reduce((sum, v) => sum + v, 0) / middle.length : 0;
}

/**
 * How thick the strokes of coverage `alpha` (`w` x `h`) are, px: across
 * the upright ones and across the flat ones. A stroke is as thick as the
 * largest circle that touches its edge from inside.
 */
export function strokeWidths(alpha, w, h) {
    const { signed, nearest, nx, ny } = edgeField(alpha, w, h);
    const deepest = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const e = nearest[i];
        if (signed[i] < 0 && e >= 0)
            deepest[e] = Math.max(deepest[e], -signed[i]);
    }
    const upright = [], flat = [];
    for (let e = 0; e < w * h; e++) {
        if (nearest[e] !== e || deepest[e] === 0)
            continue;
        // The pixel centers on the two sides of a stroke stop short of its
        // middle by a pixel between them.
        const width = 2 * deepest[e] + 1;
        if (Math.abs(nx[e]) > SIDE_NORMAL)
            upright.push(width);
        else if (Math.abs(ny[e]) > SIDE_NORMAL)
            flat.push(width);
    }
    const across = middleMean(upright) || middleMean(flat) || 1;
    return [across, middleMean(flat) || across];
}

/**
 * How wide and how tall the widest and tallest runs of ink in coverage
 * `alpha` (`w` x `h`) are, px: a dot's size.
 */
export function dotSize(alpha, w, h) {
    let wide = 0, tall = 0;
    for (let y = 0; y < h; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) {
            run = alpha[y * w + x] ? run + alpha[y * w + x] / 255 : 0;
            wide = Math.max(wide, run);
        }
    }
    for (let x = 0; x < w; x++) {
        let run = 0;
        for (let y = 0; y < h; y++) {
            run = alpha[y * w + x] ? run + alpha[y * w + x] / 255 : 0;
            tall = Math.max(tall, run);
        }
    }
    return [wide, tall];
}

/**
 * Where coverage `alpha` (`w` x `h`) crosses half, as closed loops of
 * points [x0, y0, x1, y1, ...], pixel (x, y) covering x to x + 1, each loop
 * running with the ink on its left.
 */
export function traceOutlines(alpha, w, h) {
    const inside = (i) => alpha[i] >= 128;
    // Edges between neighbouring pixel centers: 2i to the right of pixel i, 2i + 1 below it.
    const points = new Map();
    const next = new Map();
    const cross = (edge, i, j, x, y, dx, dy) => {
        if (!points.has(edge)) {
            const t = (127.5 - alpha[i]) / (alpha[j] - alpha[i]);
            points.set(edge, [x + 0.5 + t * dx, y + 0.5 + t * dy]);
        }
        return edge;
    };
    for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w - 1; x++) {
            const tl = y * w + x, tr = tl + 1, bl = tl + w, br = bl + 1;
            const corners = [tl, tr, br, bl];
            const ins = corners.map(inside);
            if (ins.every(v => v === ins[0]))
                continue;
            // Round the cell clockwise: top, right, bottom, left.
            const sides = [
                () => cross(2 * tl, tl, tr, x, y, 1, 0),
                () => cross(2 * tr + 1, tr, br, x + 1, y, 0, 1),
                () => cross(2 * bl, bl, br, x, y + 1, 1, 0),
                () => cross(2 * tl + 1, tl, bl, x, y, 0, 1),
            ];
            const entries = [], exits = [];
            for (let k = 0; k < 4; k++) {
                if (ins[k] === ins[(k + 1) % 4])
                    continue;
                (ins[k] ? exits : entries).push(k);
            }
            if (entries.length === 1) {
                next.set(sides[entries[0]](), sides[exits[0]]());
                continue;
            }
            // A saddle: the ink joins across the middle if the middle is covered.
            const middle = corners.reduce((sum, c) => sum + alpha[c], 0) / 4 >= 127.5;
            for (const k of entries) {
                const exit = middle ? (k + 3) % 4 : (k + 1) % 4;
                next.set(sides[k](), sides[exit]());
            }
        }
    }
    const loops = [];
    for (const start of next.keys()) {
        if (!points.has(start))
            continue;
        const loop = [];
        let edge = start;
        while (edge !== undefined && points.has(edge)) {
            loop.push(...points.get(edge));
            points.delete(edge);
            edge = next.get(edge);
        }
        if (loop.length >= 6)
            loops.push(loop);
    }
    return loops;
}

// Keeps the points of a closed loop that it cannot do without to stay
// within `tolerance` px (Douglas-Peucker).
function simplify(loop, tolerance) {
    const n = loop.length / 2;
    const far = (from) => {
        let best = from, bestD = -1;
        for (let i = 0; i < n; i++) {
            const d = Math.hypot(loop[2 * i] - loop[2 * from], loop[2 * i + 1] - loop[2 * from + 1]);
            if (d > bestD)
                [best, bestD] = [i, d];
        }
        return best;
    };
    const a = far(0), b = far(a);
    const keep = new Uint8Array(n);
    keep[a] = keep[b] = 1;
    const stack = [[a, b], [b, a]];
    while (stack.length) {
        const [i, j] = stack.pop();
        const count = (j - i + n) % n;
        if (count < 2)
            continue;
        const [x0, y0, x1, y1] = [loop[2 * i], loop[2 * i + 1], loop[2 * j], loop[2 * j + 1]];
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        let worst = -1, worstD = tolerance;
        for (let k = 1; k < count; k++) {
            const m = (i + k) % n;
            const d = Math.abs((x1 - x0) * (y0 - loop[2 * m + 1]) - (x0 - loop[2 * m]) * (y1 - y0)) / len;
            if (d > worstD)
                [worst, worstD] = [m, d];
        }
        if (worst < 0)
            continue;
        keep[worst] = 1;
        stack.push([i, worst], [worst, j]);
    }
    const out = [];
    for (let i = 0; i < n; i++)
        if (keep[i])
            out.push(loop[2 * i], loop[2 * i + 1]);
    return out;
}

// A corner that is rounded off a little (by the font, or by anti-aliasing)
// would have its few short pieces moved by amounts between those of the two
// sides, and come out as a bevel. Short pieces adding up to less than
// `limit` px between two at least twice as long, which turn by more than
// CORNER_TURN, are put back to the corner where the long ones' lines cross,
// when that is about where the short ones are.
const CORNER_TURN = 0.5;

function sharpenCorners(loop, limit) {
    const n = loop.length / 2;
    if (n < 4)
        return loop;
    const pt = (k) => [loop[2 * ((k % n + n) % n)], loop[2 * ((k % n + n) % n) + 1]];
    const lengths = Array.from({ length: n }, (_, k) => Math.hypot(pt(k + 1)[0] - pt(k)[0], pt(k + 1)[1] - pt(k)[1]));
    const long = (k) => lengths[(k % n + n) % n] >= limit;
    let first = 0;
    while (first < n && !long(first))
        first++;
    if (first === n)
        return loop;
    // The corner that replaces vertices k..m + 1, by k.
    const corners = new Map();
    for (let k = first + 1; k < first + n; k++) {
        if (long(k))
            continue;
        let m = k, run = 0;
        while (!long(m))
            run += lengths[m++ % n];
        const [a, b] = [k - 1, m];
        const next = m;
        if (run < limit && lengths[a % n] >= 2 * run && lengths[b % n] >= 2 * run) {
            const [a0, a1, b0, b1] = [pt(a), pt(a + 1), pt(b), pt(b + 1)];
            const [ux, uy, vx, vy] = [a1[0] - a0[0], a1[1] - a0[1], b1[0] - b0[0], b1[1] - b0[1]];
            const det = ux * vy - uy * vx;
            const turn = Math.abs(Math.atan2(det, ux * vx + uy * vy));
            if (turn >= CORNER_TURN) {
                const t = ((b0[0] - a1[0]) * vy - (b0[1] - a1[1]) * vx) / det;
                const at = [a1[0] + ux * t, a1[1] + uy * t];
                if (Math.hypot(at[0] - (a1[0] + b0[0]) / 2, at[1] - (a1[1] + b0[1]) / 2) <= run)
                    corners.set(k % n, { end: m % n, at });
            }
        }
        k = next;
    }
    if (!corners.size)
        return loop;
    const out = [];
    for (let i = 0, k = first; i < n; i++, k = (k + 1) % n) {
        const corner = corners.get(k);
        if (!corner) {
            out.push(...pt(k));
            continue;
        }
        out.push(...corner.at);
        // Vertices k + 1 to the end of the run go with it.
        const skip = (corner.end - k + n) % n;
        i += skip;
        k = (k + skip) % n;
    }
    return out;
}

/**
 * `loop` (ink on its left) with every piece moved into the ink by
 * `move(nx, ny, x, y)` px, its normal into the ink being (nx, ny) and its
 * middle (x, y): the corners
 * where the moved pieces' lines cross. A piece the move turns round (a curve
 * or a corner tighter than the move) is dropped, and its neighbours meet
 * instead. Empty when nothing is left.
 */
export function moveOutline(loop, move) {
    const n = loop.length / 2;
    const nx = new Float64Array(n), ny = new Float64Array(n), shift = new Float64Array(n), along = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const dx = loop[2 * j] - loop[2 * k], dy = loop[2 * j + 1] - loop[2 * k + 1];
        const len = Math.hypot(dx, dy) || 1;
        nx[k] = dy / len;
        ny[k] = -dx / len;
        // The moved line: the points p with p . normal = along.
        shift[k] = move(nx[k], ny[k], (loop[2 * k] + loop[2 * j]) / 2, (loop[2 * k + 1] + loop[2 * j + 1]) / 2);
        along[k] = loop[2 * k] * nx[k] + loop[2 * k + 1] * ny[k] + shift[k];
    }
    const prev = Array.from({ length: n }, (_, k) => (k + n - 1) % n);
    const next = Array.from({ length: n }, (_, k) => (k + 1) % n);
    // Where piece b starts: on piece a's line and on its own.
    const start = (a, b) => {
        const det = nx[a] * ny[b] - ny[a] * nx[b];
        const [cx, cy] = [loop[2 * b], loop[2 * b + 1]];
        if (Math.abs(det) > 0.02) {
            const x = (along[a] * ny[b] - ny[a] * along[b]) / det, y = (nx[a] * along[b] - along[a] * nx[b]) / det;
            if (Math.hypot(x - cx, y - cy) <= MITER_LIMIT * Math.max(shift[a], shift[b], 0.5))
                return [x, y];
        }
        // Nearly in line, or too sharp a corner: between where the two lines pass the corner.
        const end = (a + 1) % n;
        const [ex, ey] = [loop[2 * end], loop[2 * end + 1]];
        return [(ex + nx[a] * shift[a] + cx + nx[b] * shift[b]) / 2, (ey + ny[a] * shift[a] + cy + ny[b] * shift[b]) / 2];
    };
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let k = 0; k < n; k++)
        [xs[k], ys[k]] = start(prev[k], k);
    let alive = n;
    for (let changed = true; changed && alive >= 3;) {
        changed = false;
        for (let k = 0; k < n && alive >= 3; k++) {
            if (next[k] < 0)
                continue;
            const j = next[k];
            // Turned round: it now runs against its normal's tangent.
            if ((xs[j] - xs[k]) * -ny[k] + (ys[j] - ys[k]) * nx[k] >= 0)
                continue;
            const [p, q] = [prev[k], next[k]];
            next[p] = q;
            prev[q] = p;
            next[k] = prev[k] = -1;
            alive--;
            [xs[q], ys[q]] = start(p, q);
            changed = true;
        }
    }
    if (alive < 3)
        return [];
    const out = [];
    let first = 0;
    while (next[first] < 0)
        first++;
    let k = first;
    do {
        out.push(xs[k], ys[k]);
        k = next[k];
    } while (k !== first);
    return out;
}

/**
 * Coverage (0-255, `w` x `h`) of the area inside `loops` (as
 * traceOutlines() gives them), anti-aliased by the exact area each pixel
 * has inside.
 */
export function fillOutlines(loops, w, h) {
    const stride = w + 2;
    const area = new Float32Array(stride * h);
    const line = (px, py, qx, qy) => {
        if (py === qy)
            return;
        const dir = py < qy ? 1 : -1;
        const [ax, ay, bx, by] = py < qy ? [px, py, qx, qy] : [qx, qy, px, py];
        const dxdy = (bx - ax) / (by - ay);
        let x = ax + Math.max(-ay, 0) * dxdy;
        for (let y = Math.max(Math.floor(ay), 0); y < Math.min(Math.ceil(by), h); y++) {
            const row = y * stride;
            const dy = Math.min(y + 1, by) - Math.max(y, ay);
            const xNext = x + dxdy * dy;
            const d = dy * dir;
            const x0 = Math.min(Math.max(Math.min(x, xNext), 0), w);
            const x1 = Math.min(Math.max(Math.max(x, xNext), 0), w);
            const i0 = Math.floor(x0), i1 = Math.ceil(x1);
            if (i1 <= i0 + 1) {
                const mid = (x0 + x1) / 2 - i0;
                area[row + i0] += d * (1 - mid);
                area[row + i0 + 1] += d * mid;
            }
            else {
                // The part of the row's slice left of each pixel boundary.
                const s = 1 / (x1 - x0);
                const f0 = x0 - i0;
                const a0 = 0.5 * s * (1 - f0) ** 2;
                const f1 = x1 - i1 + 1;
                const am = 0.5 * s * f1 * f1;
                area[row + i0] += d * a0;
                if (i1 === i0 + 2) {
                    area[row + i0 + 1] += d * (1 - a0 - am);
                }
                else {
                    const a1 = s * (1.5 - f0);
                    area[row + i0 + 1] += d * (a1 - a0);
                    for (let i = i0 + 2; i < i1 - 1; i++)
                        area[row + i] += d * s;
                    const a2 = a1 + (i1 - i0 - 3) * s;
                    area[row + i1 - 1] += d * (1 - a2 - am);
                }
                area[row + i1] += d * am;
            }
            x = xNext;
        }
    };
    for (const loop of loops) {
        const n = loop.length / 2;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            line(loop[2 * i], loop[2 * i + 1], loop[2 * j], loop[2 * j + 1]);
        }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let x = 0; x < w; x++) {
            sum += area[y * stride + x];
            out[y * w + x] = Math.round(Math.min(Math.abs(sum), 1) * 255);
        }
    }
    return out;
}

/**
 * The outlines `loops` of a glyph drawn taller by `stretch`, each stroke
 * pulled back to the thickness a pen `pen` px across (upright strokes) and
 * tall (flat strokes) draws it at that angle.
 */
export function restroke(loops, pen, stretch) {
    const [across, tall] = pen;
    const move = (nx, ny, _x, y) => {
        const width = Math.hypot(across * nx, tall * ny);
        return (Math.hypot(across * nx, stretch(y, ny, width) * tall * ny) - width) / 2;
    };
    const corner = CORNER_SIZE * Math.min(across, tall);
    return loops.map(loop => moveOutline(sharpenCorners(simplify(loop, TRACE_TOLERANCE), corner), move))
        .filter(loop => loop.length);
}

/** Coverage `alpha` (`w` x `h`) of a glyph drawn `stretch` times as tall, its strokes as thick as `pen` draws them. */
export function keepStrokeWidths(alpha, w, h, pen, stretch) {
    return fillOutlines(restroke(traceOutlines(alpha, w, h), pen, () => stretch), w, h);
}

// Taller along the upright strokes
//
// The other way to grow a glyph taller spaces its rows further apart, more in
// some rows than in others. Each row has a cost for growing (an edge that
// bends or lies flat through it would be drawn out of shape) and takes in
// inverse to it; neighbouring rows that an edge slants or curves through are
// tied to grow alike, or the edge would bend there. So upright straight
// strokes take the height, curves and slanted strokes grow evenly, and a
// glyph with nothing upright grows evenly all over. The glyph's upper and
// lower parts, where it has a join or a bar in its middle third (a 3, a 5, an
// 8), grow by the same factor. The outline is then spaced out with its rows
// and its strokes given back their width (see restroke()).
// How fast a row's cost rises as the outline bends through it: at this much
// change of an edge's slope (horizontal px per row) between half a stroke
// above and half a stroke below, it costs twice what a straight row does.
const BEND_HALF = 0.12;
// Edges flatter than this many px across per row change their angle visibly
// when their rows spread out; past it the row costs more, twice as much at
// FLAT_START + FLAT_HALF.
const FLAT_START = 1.5;
const FLAT_HALF = 1;
// A row whose longest stroke is this many times the glyph's usual stroke runs
// along a horizontal one (a bar, the top of a bowl), whose thickness is kept;
// fully past BAR_START + BAR_SPAN.
const BAR_START = 1.4;
const BAR_SPAN = 0.3;
// No row costs more than BEND_COST_MAX for bending, so the sharpest rows of a
// curve do not stand out from the rest. Rows within half a stroke of where an
// edge starts or ends cost END_COST more: the pixels there move with
// different strokes' middles, and the end of a stroke, or where strokes meet,
// keeps its shape only if its rows do not grow. Rows that must not grow at
// all cost HOLD: those along a bar, and those where an edge is there for that
// row only or nothing is covered past half (the tip of a curve).
const BEND_COST_MAX = 30;
const HOLD = 1e4;
const END_COST = 1000;
// Neighbouring rows an edge slants through by this many px per row, or
// bends through by this much (as BEND_HALF measures it), may differ in growth
// over about as many rows as the band has; the reach grows with the squares,
// so straight upright edges barely tie their rows, and slanted or curved ones
// make them grow as one.
const SLOPE_TIE = 0.03;
const BEND_TIE = 0.03;
// The Gaussian the rows' shares are smoothed by, in strokes.
const SHARE_SMOOTHING = 0.5;

// Where the outline crosses row y of coverage `alpha` (`w` wide): x to a
// fraction of a pixel, positive where the row enters the glyph and negative
// where it leaves (the sign is the direction, the magnitude x + 1).
function rowEdges(alpha, w, y) {
    const edges = [];
    let prev = 0;
    for (let x = 0; x <= w; x++) {
        const a = x < w ? alpha[y * w + x] : 0;
        if ((prev < 128) !== (a < 128)) {
            const at = x - 1 + (127.5 - prev) / (a - prev);
            edges.push(a >= 128 ? at + 1 : -(at + 1));
        }
        prev = a;
    }
    return edges;
}

// The usual width of the strokes: the median of the rows' longest runs.
function medianStroke(longest) {
    const stroked = Array.from(longest).filter(v => v > 0).sort((a, b) => a - b);
    return stroked.length ? stroked[stroked.length >> 1] : 1;
}

// Follows each edge from row to row, nearest matches first, so strokes that
// start or end beside it do not break it.
function bandRows(alpha, w, top, bottom) {
    const n = bottom - top;
    const edges = [];
    const longest = new Float64Array(n + 1);
    const inked = [];
    for (let r = 0; r <= n; r++) {
        edges.push(rowEdges(alpha, w, top + r));
        let run = 0, ink = false;
        for (let x = 0, i = (top + r) * w; x < w; x++, i++) {
            run = alpha[i] >= 128 ? run + 1 : 0;
            longest[r] = Math.max(longest[r], run);
            ink ||= alpha[i] > 0;
        }
        inked.push(ink);
    }
    const stroke = medianStroke(longest);
    const reach = Math.max(Math.round(stroke / 2), 1);
    const next = edges.map(row => row.map(() => -1));
    const chains = [];
    const chainOf = [];
    for (let r = 0; r <= n; r++) {
        const ids = edges[r].map(() => -1);
        if (r > 0) {
            const pairs = [];
            edges[r - 1].forEach((a, i) => edges[r].forEach((b, j) => {
                const d = Math.abs(Math.abs(a) - Math.abs(b));
                if (Math.sign(a) === Math.sign(b) && d <= reach)
                    pairs.push([d, i, j]);
            }));
            pairs.sort((p, q) => p[0] - q[0]);
            for (const [, i, j] of pairs) {
                if (next[r - 1][i] >= 0 || ids[j] >= 0)
                    continue;
                next[r - 1][i] = j;
                ids[j] = chainOf[r - 1][i];
                chains[ids[j]].xs.push(Math.abs(edges[r][j]));
            }
        }
        edges[r].forEach((e, j) => {
            if (ids[j] >= 0)
                return;
            ids[j] = chains.length;
            chains.push({ start: r, xs: [Math.abs(e)] });
        });
        chainOf.push(ids);
    }
    const slopes = edges.map(row => row.map(() => NaN));
    const bends = edges.map(row => row.map(() => 0));
    const ends = edges.map(row => row.map(() => 0));
    for (let r = 0; r <= n; r++) {
        chainOf[r].forEach((c, j) => {
            const { start, xs } = chains[c];
            const i = r - start;
            ends[r][j] = Math.min(i, xs.length - 1 - i);
            if (xs.length < 2)
                return;
            const a = Math.max(i - reach, 0), b = Math.min(i + reach, xs.length - 1);
            const up = i > a ? (xs[i] - xs[a]) / (i - a) : null;
            const down = b > i ? (xs[b] - xs[i]) / (b - i) : null;
            slopes[r][j] = (xs[b] - xs[a]) / (b - a);
            if (up !== null && down !== null)
                bends[r][j] = Math.abs(down - up);
        });
    }
    return { edges, slopes, bends, ends, next, longest, inked, stroke };
}

// Solves the tridiagonal system with `diag` on the diagonal, -off[i] between
// i and i + 1, and `rhs` on the right.
function solveTridiagonal(diag, off, rhs) {
    const n = diag.length;
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const below = i > 0 ? off[i - 1] : 0;
        const m = diag[i] + (i > 0 ? below * c[i - 1] : 0);
        c[i] = i < n - 1 ? -off[i] / m : 0;
        d[i] = (rhs[i] + (i > 0 ? below * d[i - 1] : 0)) / m;
    }
    for (let i = n - 2; i >= 0; i--)
        d[i] -= c[i] * d[i + 1];
    return d;
}

function bandShares(rows) {
    const n = rows.edges.length - 1;
    // The room above and below the glyph grows as the band does, so the glyph
    // stays where it was in it; the rest of the height goes to the rows between.
    let first = 0, last = n - 1;
    while (first < n && !rows.inked[first])
        first++;
    while (last >= first && !rows.inked[last])
        last--;
    const shares = new Float64Array(n).fill(1 / n);
    const m = last - first + 1;
    if (m <= 0)
        return shares;
    const cost = new Float64Array(m);
    const along = new Float64Array(m);
    for (let r = first; r <= last; r++) {
        let bend = 0, flat = 0, end = false;
        // Drawn but never covered past half: the tip of a curve.
        let lone = rows.inked[r] && rows.edges[r].length === 0;
        rows.edges[r].forEach((_e, j) => {
            if (rows.ends[r][j] < rows.stroke / 2)
                end = true;
            const slope = rows.slopes[r][j];
            if (Number.isNaN(slope))
                lone = true;
            else
                flat = Math.max(flat, Math.abs(slope));
            bend = Math.max(bend, rows.bends[r][j]);
        });
        const b = bend / BEND_HALF;
        const f = Math.max(flat - FLAT_START, 0) / FLAT_HALF;
        const bar = Math.min(Math.max(rows.longest[r] / rows.stroke - BAR_START, 0) / BAR_SPAN, 1);
        along[r - first] = bar;
        const bending = Math.min((1 + b * b) * (1 + f * f), BEND_COST_MAX) + (end ? END_COST : 0);
        cost[r - first] = bending + HOLD * (bar * bar + (lone ? 1 : 0));
    }
    // Ties between rows r and r + 1, through the edges that run on.
    const tie = new Float64Array(m);
    for (let r = first; r < last; r++) {
        let pull = 0;
        rows.next[r].forEach((j, i) => {
            if (j < 0)
                return;
            const a = rows.slopes[r][i], b = rows.slopes[r + 1][j];
            if (Number.isNaN(a) || Number.isNaN(b))
                return;
            const slope = Math.abs(a + b) / 2, bend = (rows.bends[r][i] + rows.bends[r + 1][j]) / 2;
            pull = Math.max(pull, (slope / SLOPE_TIE) ** 2 + (bend / BEND_TIE) ** 2);
        });
        // Not into a bar, which keeps its thickness however the edges that
        // run into it grow.
        const reach = n * pull * (1 - along[r - first]) * (1 - along[r + 1 - first]);
        tie[r - first] = reach * reach;
    }
    // Each row takes in inverse to its cost, then the ties even that out:
    // minimising sum((k - 1 / cost)^2) + sum(tie * (k[r + 1] - k[r])^2), so
    // rows tied together take the mean of what they would alone.
    const diag = new Float64Array(m);
    for (let i = 0; i < m; i++)
        diag[i] = 1 + (i > 0 ? tie[i - 1] : 0) + tie[i];
    const k = solveTridiagonal(diag, tie, cost.map(c => 1 / c));
    // The parts above and below the row in the middle third that resists
    // growing most each take the height in proportion to their own, when that
    // row is a join or a bar; otherwise one part would be drawn out more than
    // the other.
    let split = Math.floor(m / 3);
    for (let i = split; i < Math.ceil(m * 2 / 3); i++)
        if (cost[i] > cost[split])
            split = i;
    const parts = cost[split] >= END_COST && split > 0 ? [[0, split], [split, m]] : [[0, m]];
    for (const [from, to] of parts) {
        let total = 0;
        for (let i = from; i < to; i++)
            total += k[i];
        for (let i = from; i < to; i++)
            shares[first + i] = total > 0 ? k[i] / total * (to - from) / n : 1 / n;
    }
    // Where the share changes from row to row, a curve through those rows
    // would bend there; spread over SHARE_SMOOTHING strokes, it bends
    // gradually. The strokes get their width back afterwards (restroke()).
    const smooth = new Float64Array(n);
    const sigma = SHARE_SMOOTHING * rows.stroke;
    const reach = Math.ceil(sigma * 3);
    for (let i = 0; i < n; i++) {
        let sum = 0, weight = 0;
        for (let j = Math.max(i - reach, 0); j <= Math.min(i + reach, n - 1); j++) {
            const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
            sum += shares[j] * w;
            weight += w;
        }
        smooth[i] = sum / weight;
    }
    const total = smooth.reduce((a, b) => a + b, 0);
    return smooth.map(v => v / total);
}

/**
 * How much of a glyph's added height each row of coverage `alpha` (0-255,
 * `w` wide) takes, rows `top` to `bottom` (see the top of this section). The
 * shares add up to 1.
 */
export function rowShares(alpha, w, top, bottom) {
    return bandShares(bandRows(alpha, w, top, bottom));
}

/**
 * Where each row boundary of a glyph `h` rows tall lands when rows `top` to
 * `bottom` take `extra` more by `shares`: the rows above stay, the rows below
 * move down by all of it.
 */
export function rowLandings(h, top, shares, extra) {
    const lands = new Float64Array(h + 1);
    for (let y = 0; y <= h; y++) {
        const r = y - top;
        lands[y] = y + (r <= 0 ? 0 : r >= shares.length ? extra : lands[y - 1] - (y - 1) + shares[r - 1] * extra);
    }
    return lands;
}

/**
 * The outlines `loops` of a glyph with its rows landed at `lands` (see
 * rowLandings()), and how many times as tall the glyph is drawn around each
 * height it lands at.
 */
export function spaceRows(loops, lands) {
    const h = lands.length - 1;
    const land = (y) => {
        if (y <= 0)
            return y;
        if (y >= h)
            return y - h + lands[h];
        const i = Math.floor(y);
        return lands[i] + (y - i) * (lands[i + 1] - lands[i]);
    };
    // Where a landed height was.
    const before = (y) => {
        if (y <= lands[0])
            return y;
        if (y >= lands[h])
            return y - lands[h] + h;
        let lo = 0, hi = h;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (lands[mid] <= y)
                lo = mid;
            else
                hi = mid;
        }
        return lo + (y - lands[lo]) / Math.max(lands[lo + 1] - lands[lo], 1e-9);
    };
    // Averaged over the stroke's thickness, which may span rows that grow by
    // very different amounts.
    const stretch = (y, ny, depth) => {
        const from = before(y);
        const down = ny * depth;
        if (Math.abs(down) < 0.5)
            return land(from + 0.5) - land(from - 0.5);
        return (land(from + down) - land(from)) / down;
    };
    return { loops: loops.map(loop => loop.map((v, i) => i % 2 ? land(v) : v)), stretch };
}

/**
 * Coverage `alpha` (`w` x `h`) made `extra` rows taller between rows `top`
 * and `bottom` by rowShares(), its strokes as thick as `pen` draws them;
 * `h + extra` rows.
 */
export function growUpright(alpha, w, h, top, bottom, extra, pen) {
    top = Math.min(Math.max(Math.round(top), 0), h - 1);
    bottom = Math.min(Math.max(Math.round(bottom), top + 1), h - 1);
    const lands = rowLandings(h, top, rowShares(alpha, w, top, bottom), extra);
    const { loops, stretch } = spaceRows(traceOutlines(alpha, w, h), lands);
    return fillOutlines(restroke(loops, pen, stretch), w, h + extra);
}

// Averages `factor` x `factor` blocks and scales the distances to match.
function downsample(field, factor) {
    const width = Math.floor(field.width / factor);
    const height = Math.floor(field.height / factor);
    const data = new Float32Array(width * height);
    const norm = 1 / (factor * factor * factor);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let j = 0; j < factor; j++) {
                const row = (y * factor + j) * field.width + x * factor;
                for (let i = 0; i < factor; i++)
                    sum += field.data[row + i];
            }
            data[y * width + x] = sum * norm;
        }
    }
    return { data, width, height };
}

function layoutFor(cr, font, text) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(font);
    layout.set_text(text, -1);
    return layout;
}

// Runs `fn` with a Cairo context that draws nowhere, for measuring.
function measuring(fn) {
    const probe = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
    const cr = new Cairo.Context(probe);
    const result = fn(cr);
    cr.$dispose();
    probe.finish();
    return result;
}

/** An installed font, through Pango: a description such as "Cantarell Bold" at `size` px. */
export function pangoFace(description, size) {
    const fontAt = (scale) => {
        const font = Pango.FontDescription.from_string(description);
        font.set_absolute_size(size * scale * Pango.SCALE);
        return font;
    };
    const font = fontAt(1);
    return {
        bounds: (text, scale) => measuring(cr => {
            const [ink, logical] = layoutFor(cr, scale === 1 ? font : fontAt(scale), text).get_pixel_extents();
            return {
                x0: Math.floor(Math.min(ink.x, logical.x)),
                y0: Math.floor(Math.min(ink.y, logical.y)),
                x1: Math.ceil(Math.max(ink.x + ink.width, logical.x + logical.width)),
                y1: Math.ceil(Math.max(ink.y + ink.height, logical.y + logical.height)),
            };
        }),
        offsets: text => measuring(cr => {
            const layout = layoutFor(cr, font, text);
            // Pango indexes the text by UTF-8 byte.
            const encoder = new TextEncoder();
            let byteIndex = 0;
            return Array.from(text, ch => {
                const x = layout.index_to_pos(byteIndex).x / Pango.SCALE;
                byteIndex += encoder.encode(ch).length;
                return x;
            });
        }),
        digitBand: () => measuring(cr => {
            const digits = layoutFor(cr, font, '0123456789');
            const [ink] = digits.get_pixel_extents();
            return [ink.y, digits.get_baseline() / Pango.SCALE];
        }),
        draw: (cr, text, scale) => PangoCairo.show_layout(cr, layoutFor(cr, fontAt(scale), text)),
    };
}

/** A font file the extension ships with, at `size` px. */
export function fileFace(font, size) {
    const unit = size / font.unitsPerEm;
    const glyphs = (text) => Array.from(text, ch => font.glyph(ch.codePointAt(0)));
    const ascent = font.ascender * unit;
    return {
        bounds: (text, scale) => {
            const s = unit * scale;
            let pen = 0;
            const box = { x0: 0, y0: 0, x1: 0, y1: (font.ascender - font.descender) * s };
            for (const g of glyphs(text)) {
                if (g.contours.length) {
                    box.x0 = Math.min(box.x0, pen + g.xMin * s);
                    box.x1 = Math.max(box.x1, pen + g.xMax * s);
                    box.y0 = Math.min(box.y0, (font.ascender - g.yMax) * s);
                    box.y1 = Math.max(box.y1, (font.ascender - g.yMin) * s);
                }
                pen += g.advance * s;
            }
            box.x1 = Math.max(box.x1, pen);
            return { x0: Math.floor(box.x0), y0: Math.floor(box.y0), x1: Math.ceil(box.x1), y1: Math.ceil(box.y1) };
        },
        offsets: text => {
            let pen = 0;
            return glyphs(text).map(g => {
                const x = pen;
                pen += g.advance * unit;
                return x;
            });
        },
        digitBand: () => [Math.min(...glyphs('0123456789').map(g => ascent - g.yMax * unit)), ascent],
        draw: (cr, text, scale) => {
            const s = unit * scale;
            let pen = 0;
            for (const g of glyphs(text)) {
                traceGlyph(cr, g, pen, font.ascender * s, s);
                pen += g.advance * s;
            }
            cr.fill();
        },
    };
}

function tallY(tall, y) {
    if (!tall)
        return y;
    if (tall.even)
        return tall.center + tall.scale * (y - tall.center);
    return y <= tall.top ? y : y >= tall.bottom ? y + tall.extra : y + tall.extra * (y - tall.top) / (tall.bottom - tall.top);
}

// `tall` at `k` times the size.
function scaledTall(tall, k, pen) {
    const scaledPen = pen.map(v => v * k);
    return tall.even ? { ...tall, center: tall.center * k, pen: scaledPen }
        : { ...tall, top: tall.top * k, bottom: tall.bottom * k, extra: tall.extra * k, pen: scaledPen };
}

// Draws `text` at `scale` times the size, stretched `stretch` times as wide
// and, made evenly taller by `tall` (in px at that scale), into a temporary
// PNG and reads its coverage back, with `margin` px of room around it. The
// coverage is in whole blocks of SUPERSAMPLE.
async function rasterize(face, text, scale, stretch, tall, margin, cancellable) {
    const b = face.bounds(text, scale);
    const x0 = Math.floor(b.x0 * stretch) - margin;
    const y0 = Math.floor(tallY(tall, b.y0)) - margin;
    const x1 = Math.ceil(b.x1 * stretch) + margin;
    const y1 = Math.ceil(tallY(tall, b.y1)) + margin;
    // Whole blocks of SUPERSAMPLE, so the downscaled field keeps its origin.
    const ax = x0 - ((x0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
    const ay = y0 - ((y0 % SUPERSAMPLE) + SUPERSAMPLE) % SUPERSAMPLE;
    const width = Math.ceil((x1 - ax) / SUPERSAMPLE) * SUPERSAMPLE;
    const height = Math.ceil((y1 - ay) / SUPERSAMPLE) * SUPERSAMPLE;
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.translate(-ax, -ay);
    if (tall?.even) {
        cr.translate(0, tall.center);
        cr.scale(stretch, tall.scale);
        cr.translate(0, -tall.center);
    }
    else {
        cr.scale(stretch, 1);
    }
    face.draw(cr, text, scale);
    cr.$dispose();
    const [fd, path] = GLib.file_open_tmp('liquid-glass-glyph-XXXXXX.png');
    GLib.close(fd);
    const file = Gio.File.new_for_path(path);
    try {
        surface.writeToPNG(path);
        surface.finish();
        const bytes = await new Promise((resolve, reject) => {
            file.load_contents_async(cancellable, (_f, res) => {
                try {
                    resolve(file.load_contents_finish(res)[1]);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        const { alpha, width: w, height: h } = decodePngAlpha(bytes);
        return { alpha, width: w, height: h, originX: -ax, originY: -ay };
    }
    finally {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (_f, res) => {
            // Throws a GError when the file is already gone; nothing is left behind then.
            try {
                file.delete_finish(res);
            }
            catch {
            }
        });
    }
}

// The digits are measured for their pen this many px tall.
const MEASURE_HEIGHT = 240;

/**
 * Distance fields of single glyphs of `face`, stretched `stretch` times as
 * wide and made `height` times as tall in `style`, built on first use.
 * `range` is how far (px) from the outline the fields reach. The work is
 * done in steps between which the main loop runs (see pause()).
 */
export class GlyphFields {
    _face;
    range;
    stretch;
    height;
    style;
    _glyphs = new Map();
    // Cancels the reads still running when the fields are no longer wanted.
    cancellable = new Gio.Cancellable();
    /** The digits' height in the font as it is, px. */
    digitHeight;
    _band;
    // How the digits are made taller, and how the colon is: evenly either way,
    // so its dots keep their shape.
    _tall = null;
    // The pauses waiting for the main loop, and how to give each up.
    _pauses = new Map();

    constructor(_face, range, stretch = 1, height = 1, style = 'even') {
        this._face = _face;
        this.range = range;
        this.stretch = stretch;
        this.height = height;
        this.style = style;
        this._band = _face.digitBand();
        this.digitHeight = Math.max(this._band[1] - this._band[0], 1);
        this.cancellable.connect(() => {
            for (const [id, reject] of this._pauses) {
                GLib.Source.remove(id);
                reject(GLib.Error.new_literal(Gio.io_error_quark(), Gio.IOErrorEnum.CANCELLED, 'The digits are no longer wanted'));
            }
            this._pauses.clear();
        });
    }

    /**
     * Lets the main loop run before the next step of work. Rejects with a
     * GError once the fields are no longer wanted.
     */
    pause() {
        return new Promise((resolve, reject) => {
            const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._pauses.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._pauses.set(id, reject);
        });
    }

    // How the glyphs are made taller, in px at the font's size. Evenly, each
    // end of the digits loses half of what the stretch added to a flat stroke,
    // so they are stretched that much more, about the middle of their top
    // stroke: their outline then spans `height` times the digits' height.
    _tallness() {
        if (this._tall)
            return this._tall;
        if (this.height <= 1)
            return this._tall = Promise.resolve(null);
        this._tall = (async () => {
            const pen = await this._pen('0123456789');
            const h = this.digitHeight;
            const [top, baseline] = this._band;
            const flat = Math.min(pen[1], h / 3);
            const even = { even: true, scale: (this.height * h - flat) / (h - flat), center: top + flat / 2, pen };
            const digits = this.style === 'upright'
                ? { even: false, top, bottom: baseline, extra: Math.round((this.height - 1) * h), pen } : even;
            return { digits, colon: even };
        })();
        // Measured again next time when it failed.
        this._tall.catch(() => {
            this._tall = null;
        });
        return this._tall;
    }

    // How thick the strokes of `text` are, px at the font's size (see
    // strokeWidths()), or for dots how big the dots are.
    async _pen(text, dots = false) {
        const scale = Math.min(MEASURE_HEIGHT / this.digitHeight, SUPERSAMPLE);
        const big = await rasterize(this._face, text, scale, this.stretch, null, 2, this.cancellable);
        const [across, tall] = (dots ? dotSize : strokeWidths)(big.alpha, big.width, big.height);
        return [across / scale, tall / scale];
    }

    _glyph(ch) {
        let glyph = this._glyphs.get(ch);
        if (!glyph) {
            glyph = this._buildGlyph(ch);
            // A failed glyph is tried again next time.
            glyph.catch(() => this._glyphs.delete(ch));
            this._glyphs.set(ch, glyph);
        }
        return glyph;
    }

    async _buildGlyph(ch) {
        const both = await this._tallness();
        const t = both && (ch === ':' ? both.colon : both.digits);
        // The colon's dots keep their own shape, whatever the digits' strokes are.
        const tall = t && scaledTall(t, SUPERSAMPLE, ch === ':' ? await this._pen(ch, true) : t.pen);
        const big = await rasterize(this._face, ch, SUPERSAMPLE, this.stretch, tall?.even ? tall : null, this.range * SUPERSAMPLE, this.cancellable);
        const { width } = big;
        let { alpha, height } = big;
        if (tall) {
            await this.pause();
            let loops = traceOutlines(alpha, width, height);
            let stretch = () => tall.even ? tall.scale : 1;
            if (!tall.even) {
                const top = Math.min(Math.max(Math.round(tall.top + big.originY), 0), height - 1);
                const bottom = Math.min(Math.max(Math.round(tall.bottom + big.originY), top + 1), height - 1);
                await this.pause();
                const lands = rowLandings(height, top, rowShares(alpha, width, top, bottom), tall.extra);
                ({ loops, stretch } = spaceRows(loops, lands));
                height += tall.extra;
            }
            await this.pause();
            loops = restroke(loops, tall.pen, stretch);
            await this.pause();
            alpha = fillOutlines(loops, width, height);
        }
        await this.pause();
        const signed = signedDistances(alpha, width, height);
        await this.pause();
        const field = downsample({ data: signed, width, height }, SUPERSAMPLE);
        return { ...field, originX: big.originX / SUPERSAMPLE, originY: big.originY / SUPERSAMPLE };
    }

    /**
     * The field of `text` laid out on one line: each glyph's field placed where
     * the line puts it, merged by taking the nearest outline. Rejects with a
     * GError when a glyph cannot be drawn or `cancellable` was cancelled.
     */
    async fieldFor(text) {
        const glyphs = new Map();
        for (const ch of new Set(text)) {
            if (!/\s/.test(ch))
                glyphs.set(ch, await this._glyph(ch));
        }
        const b = this._face.bounds(text, 1);
        const offsets = this._face.offsets(text);
        const r = this.range;
        // The line's room above and below the digits stays as it was.
        const tall = (await this._tallness())?.digits ?? null;
        const [top, baseline] = this._band;
        const x0 = Math.floor(b.x0 * this.stretch) - r;
        const y0 = Math.floor(tallY(tall, top) - (top - b.y0)) - r;
        const width = Math.ceil(b.x1 * this.stretch) + r - x0;
        const height = Math.ceil(tallY(tall, baseline) + (b.y1 - baseline)) + r - y0;
        const data = new Float32Array(width * height).fill(r);
        for (const [index, ch] of Array.from(text).entries()) {
            const glyph = glyphs.get(ch);
            if (!glyph)
                continue;
            await this.pause();
            const left = Math.round(offsets[index] * this.stretch - glyph.originX - x0);
            const top = Math.round(-glyph.originY - y0);
            for (let gy = 0; gy < glyph.height; gy++) {
                const y = top + gy;
                if (y < 0 || y >= height)
                    continue;
                for (let gx = 0; gx < glyph.width; gx++) {
                    const x = left + gx;
                    if (x < 0 || x >= width)
                        continue;
                    const v = glyph.data[gy * glyph.width + gx];
                    const i = y * width + x;
                    if (v < data[i])
                        data[i] = v;
                }
            }
        }
        return { data, width, height };
    }
}

/** The deepest point of `field`, px. */
export function maxDepth(field) {
    let depth = 0;
    for (let i = 0; i < field.data.length; i++)
        depth = Math.max(depth, -field.data[i]);
    return depth;
}

/**
 * The pixels (RGBA) of a texture for glass.frag's LG_SHAPE_TEXTURE: `outline`
 * above `lens`, two fields of the same size, distances from -range to +range
 * in 16 bits, the high byte in red and the low in green.
 */
export function encodeFields(outline, lens, range) {
    const { width, height } = outline;
    const bytes = new Uint8Array(width * height * 8);
    const scale = 65535 / (2 * range);
    const put = (data, offset) => {
        for (let i = 0, o = offset * 4; i < width * height; i++, o += 4) {
            const v = ((data[i] + range) * scale + 0.5) | 0;
            const c = v < 0 ? 0 : v > 65535 ? 65535 : v;
            bytes[o] = c >> 8;
            bytes[o + 1] = c & 255;
            bytes[o + 3] = 255;
        }
    };
    put(outline.data, 0);
    put(lens.data, width * height);
    return bytes;
}
