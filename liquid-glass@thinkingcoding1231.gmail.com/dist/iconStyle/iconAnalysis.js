// Takes an application icon apart into the plates it is drawn on (rounded
// squares, circles and the like, outermost first) and the symbol drawn on them,
// so that it can be redrawn as glass plates under a one-color symbol.
//
// A plate is a shape close to a rounded rectangle or a superellipse (a circle,
// an ellipse and a squircle are superellipses), possibly with regular teeth or
// waves along its outline. Its color is one color or a smooth gradient; a
// plate that carries a picture keeps its shape, and the picture is taken as
// the symbol. Pure computation on unpremultiplied RGBA, so that it runs in a
// worker process as well as in tests.
// A shape counts as a plate when it covers the candidate this well, a shape between a diamond and an ellipse only when
// it covers it as well as FIT_POINTED: one that covers it less rounds off the corners of a polygon.
const FIT_PLATE = 0.94;
const FIT_POINTED = 0.96;
// Oklab distances: neighbours closer than this are one area; a pixel this far
// from its plate's color is symbol, fully from SYMBOL_HIGH.
const SAME_AREA = 0.035;
// For fineAreas(): how readily small areas join (over their size in analysis px), the largest step ever joined, and
// room for every edge of an image up to 1024 px square.
const EDGE_SLOTS = 2 ** 21;
const FINE_JOIN = 0.6;
const FINE_MAX = 0.1;
const FINE_DRIFT = 0.25;
const SYMBOL_LOW = 0.045;
const SYMBOL_HIGH = 0.11;
// A plate whose largest area strays this much (RMS) from a smooth color, or
// covers less than this share of it, carries a picture.
const PLAIN_RMS = 0.035;
const MIN_SURFACE = 0.3;
// The most grain (typical distance from the plate's color) a plain plate has.
const MAX_GRAIN = 0.04;
// An area smaller than this share of the image is never a plate, and an inner
// plate has at least this share of the plate it sits on.
const MIN_PLATE_AREA = 0.04;
// A shape counts as a plate only when this much of it is opaque (an outline
// drawn on nothing is a symbol).
const MIN_OPAQUE = 0.85;
// Two areas of the symbol meet on an edge where the color across it steps by this share of their colors' difference.
const TONE_STEP = 0.5;
// The weakest part of a symbol is drawn this much weaker than its strongest; see symbolTone().
const DETAIL_DIM = 0.45;
const TONE_GROUPS = 6;
// See gradientsOf().
const GRADIENT_SPREAD = 0.15;
const GRADIENT_TAIL = 0.05;
const TONE_LEVELS = 8;
const TONE_FULL = 0.3;
const TONE_SEEN = 0.2;
const TONE_ORDER = 0.12;
const MIN_INNER_SHARE = 0.1;
// A shape that falls a little short of a plate (smaller than MIN_PLATE_AREA or MIN_INNER_SHARE, or fitted less closely
// than FIT_PLATE) is one all the same when a plate on the same plate has about its size and proportions, so that of two or three
// alike shapes all become plates, not one.
const PEER_AREA = 0.012;
const PEER_FIT = 0.88;
const PEER_SIZE = 0.3;
// An area with pieces of other colors on its edge (a toggle's knob) is not closed by filling its holes: the pieces
// mostly in the shape fitted to it (which ends where the piece begins), adding at most this share to it, are taken in
// and the shape fitted again.
const ABSORB_SHARE = 0.7;
const ABSORB_INSIDE = 0.6;
// A plate's surface cut into pieces, each at least this share of the largest and of the plate, in three or more
// colors this far apart, has none of them as its color. Two colors are a surface and something on it.
const PIECE_SHARE = 0.4;
const PIECE_MIN = 0.08;
const PIECE_APART = 0.07;
// A plate on such a plate whose color is this far from all the pieces' is not one of them (the disc in a pie's middle).
const PIECE_FOREIGN = 0.14;
// A shape on a plate in a shade of its color with more than this share of its edge along the plate's outline (within
// BAND) is part of the plate's surface.
const ALONG_PARENT = 0.1;
// Areas smaller than this share of the image are measured pixel by pixel (anti-aliased edges, thin lines, specks), and
// so are areas less than THICK of whose pixels have all four neighbours in them.
const REGION_MIN = 0.002;
const THICK = 0.4;
// A large area of a plate is part of its surface when it covers GROUND_SHARE of the plate, lies along GROUND_EDGE of
// its outline (the pixels within BAND analysis px of it, past a rim or a border along it) and the closest
// GROUND_CLOSEST of its pixels come within GROUND_NEAR (Oklab) of an area of the surface.
const GROUND_SHARE = 0.02;
const GROUND_EDGE = 0.015;
const BAND = 4;
const GROUND_CLOSEST = 0.05;
const GROUND_NEAR = 0.1;
// Nor is an area narrower than this (its breadth, analysis px; see broad()).
const GROUND_BREADTH = 3;
// An area with EDGE_INSIDE of its pixels within EDGE_BAND of its plate's half size from its outline is the icon's own
// rim, which the glass's rim takes the place of.
// A pixel outside every plate that is this transparent and this dark is a drop shadow, not symbol.
const SHADOW_ALPHA = 0.6;
const SHADOW_LIGHTNESS = 0.3;
const EDGE_BAND = 0.09;
const EDGE_INSIDE = 0.8;
// So is a line running along the outline at an even depth within twice that, as long as the plate is wide.
const EDGE_EVEN = 1.2;
// Two areas shade into each other when the median step across their edge, at least SEAM_MIN px long, is below SEAM_STEP.
const SEAM_STEP = 0.02;
const SEAM_MIN = 12;
// Inside a plate, deeper than FADE_DEPTH (analysis px), a symbol pixel's opacity is raised to FADE_GAMMA: a symbol that
// fades out over a hole in its plate keeps its fade without growing faint.
const FADE_DEPTH = 2;
const FADE_GAMMA = 0.6;
// A gloss or a shade lays GLOSS_MIN to GLOSS_MAX of white or black over what is under it, the same over each color to
// within GLOSS_NEAR (Oklab).
const GLOSS_MIN = 0.05;
const GLOSS_MAX = 0.6;
const GLOSS_NEAR = 0.03;
// A veil (see symbolLayer()) lays GLOSS_MIN to VEIL_MAX of white or black over at least VEIL_MIN analysis px², within
// VEIL_NEAR (Oklab) of the surface's colors under it, which change by VEIL_SPREAD or more across it.
const VEIL_MAX = 0.35;
const VEIL_MIN = 40;
const VEIL_NEAR = 0.04;
const VEIL_SPREAD = 0.08;
// Pixels that stand out of the surface more than STROKE_LOW of the symbol's threshold, next to one another and at
// least STROKE_MIN analysis px² together, are one stroke.
const STROKE_LOW = 0.6;
const STROKE_MIN = 3;
// The share of a large area's pixels closest to the surface that tell whether it fades into it.
const FADE_CLOSEST = 0.05;
// The surface around a pixel is averaged over squares of these half sides (analysis px), the nearer weighing more.
const REACH = [1, 2, 4, 8, 16, 32, 64];
// Lightness differences on a plate's surface smaller than this (Oklab L), or than twice its grain, are noise.
const SURFACE_STEP = 0.012;
const LINEAR = new Float32Array(256).map((_, i) => {
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function oklab(r, g, b, out, at) {
    const lr = LINEAR[r], lg = LINEAR[g], lb = LINEAR[b];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    out[at] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[at + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[at + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808650822 * s;
}

/** sRGB (0-255) of an Oklab color. */
export function oklabToSrgb(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return lin.map(c => {
        const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(Math.max(v, 0), 1) * 255);
    });
}

function smoothstep(lo, hi, x) {
    const t = Math.min(Math.max((x - lo) / (hi - lo), 0), 1);
    return t * t * (3 - 2 * t);
}

/** Signed distance (px, negative inside) from a pixel position to the shape's outline. */
export function shapeDistance(shape, x, y) {
    const dx = x - shape.cx, dy = y - shape.cy;
    let d;
    if (shape.kind === 'roundrect') {
        const r = Math.min(shape.radius, shape.rx, shape.ry);
        const qx = Math.abs(dx) - shape.rx + r, qy = Math.abs(dy) - shape.ry + r;
        d = Math.min(Math.max(qx, qy), 0) + cornerLength(Math.max(qx, 0), Math.max(qy, 0), r, shape.corner ?? 2) - r;
    }
    else {
        const n = shape.exponent;
        const f = (Math.abs(dx / shape.rx) ** n + Math.abs(dy / shape.ry) ** n) ** (1 / n);
        // A first-order distance: the level set's value over the length of its gradient.
        d = (f - 1) * Math.min(shape.rx, shape.ry);
    }
    if (!shape.ripple)
        return d;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6)
        return d;
    const base = len - d;
    return len - base * rippleFactor(shape.ripple, Math.atan2(dy, dx));
}

// The distance into a corner of radius r at (px, py) from its center, for a superellipse corner of exponent n: its
// norm over the length of its gradient, which fades in from the center, where the gradient has no direction.
function cornerLength(px, py, r, n) {
    if (n === 2)
        return Math.hypot(px, py);
    const m = Math.max(px, py);
    if (m <= 0)
        return 0;
    const len = m * ((px / m) ** n + (py / m) ** n) ** (1 / n);
    const grad = Math.hypot((px / len) ** (n - 1), (py / len) ** (n - 1));
    const gradLen = 1 + (grad - 1) * Math.min(len / Math.max(r, 1e-3), 1);
    return r + (len - r) / Math.max(gradLen, 0.5);
}

function rippleFactor(ripple, angle) {
    let f = 1;
    ripple.harmonics.forEach(([amp, phase], i) => {
        f += amp * Math.cos((i + 1) * ripple.count * angle - phase);
    });
    return ripple.scale * f;
}

function coverageOf(shape, x, y) {
    return Math.min(Math.max(0.5 - shapeDistance(shape, x + 0.5, y + 0.5), 0), 1);
}

function maskOf(data, w, h) {
    let x1 = w, y1 = h, x2 = -1, y2 = -1, area = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!data[y * w + x])
                continue;
            area++;
            x1 = Math.min(x1, x);
            x2 = Math.max(x2, x);
            y1 = Math.min(y1, y);
            y2 = Math.max(y2, y);
        }
    }
    return { data, x1, y1, x2, y2, area };
}

// Every `step`th pixel each way only, when ranking shapes.
function overlap(shape, mask, w, h, step = 1) {
    let inter = 0, union = 0;
    // Teeth reach out of the basic shape; nothing else does.
    const reach = shape.ripple ? 1.3 : 1;
    const x1 = Math.max(Math.floor(Math.min(mask.x1, shape.cx - shape.rx * reach)) - 2, 0);
    const x2 = Math.min(Math.ceil(Math.max(mask.x2, shape.cx + shape.rx * reach)) + 2, w - 1);
    const y1 = Math.max(Math.floor(Math.min(mask.y1, shape.cy - shape.ry * reach)) - 2, 0);
    const y2 = Math.min(Math.ceil(Math.max(mask.y2, shape.cy + shape.ry * reach)) + 2, h - 1);
    for (let y = y1; y <= y2; y += step) {
        for (let x = x1; x <= x2; x += step) {
            const c = coverageOf(shape, x, y);
            const m = mask.data[y * w + x];
            inter += Math.min(c, m);
            union += Math.max(c, m);
        }
    }
    return union > 0 ? inter / union : 0;
}

// The fewest teeth or waves a plate's outline has: fewer are a polygon's corners (a hexagon), not teeth.
const MIN_TEETH = 7;
// An icon's outline that is a plate but that its shape covers less than this is moved and resized to fit better, for at most
// REFINE_ROUNDS steps, and the result kept when it fits at least REFINE_GAIN better.
const REFINE_BELOW = 0.985;
const REFINE_ROUNDS = 12;
const REFINE_GAIN = 0.008;
// From a diamond (1) through an ellipse (2) and a squircle to nearly a rectangle.
const EXPONENTS = [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8];
const RADII = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

function fits(shape) {
    return shape.fit >= (shape.kind === 'superellipse' && shape.exponent < 2 ? FIT_POINTED : FIT_PLATE);
}

// The shape spans the mask's bounding box unless refined, so that it ends where a piece on the mask's edge begins.
function fitBasic(mask, w, h, refine = false, exponents = EXPONENTS) {
    const base = {
        cx: (mask.x1 + mask.x2 + 1) / 2, cy: (mask.y1 + mask.y2 + 1) / 2,
        rx: (mask.x2 - mask.x1 + 1) / 2, ry: (mask.y2 - mask.y1 + 1) / 2,
        radius: 0, exponent: 2, ripple: null, fit: 0,
    };
    let best = { ...base, kind: 'roundrect' };
    const consider = (shape) => {
        shape.fit = overlap(shape, mask, w, h, 2);
        if (shape.fit > best.fit)
            best = shape;
    };
    for (const t of RADII)
        consider({ ...base, kind: 'roundrect', radius: t * Math.min(base.rx, base.ry) });
    for (const n of exponents)
        consider({ ...base, kind: 'superellipse', exponent: n });
    best.fit = overlap(best, mask, w, h);
    return !refine || best.fit < FIT_PLATE || best.fit >= REFINE_BELOW ? best : refined(best, mask, w, h);
}

// The shape moved and resized a pixel at a time while that fits better: the bounding box is too large when something
// sticks out of the icon's plate (a badge over its corner).
function refined(shape, mask, w, h) {
    let best = shape;
    const moves = [[1, 0, 0, 0], [-1, 0, 0, 0], [0, 1, 0, 0], [0, -1, 0, 0], [0, 0, 1, 0], [0, 0, -1, 0], [0, 0, 0, 1],
        [0, 0, 0, -1]];
    for (let round = 0; round < REFINE_ROUNDS; round++) {
        let next = best;
        for (const [dx, dy, drx, dry] of moves) {
            const rx = best.rx + drx, ry = best.ry + dry;
            if (rx < 3 || ry < 3)
                continue;
            const k = best.kind === 'roundrect' ? Math.min(rx, ry) / Math.min(best.rx, best.ry) : 1;
            const candidate = { ...best, cx: best.cx + dx, cy: best.cy + dy, rx, ry, radius: best.radius * k };
            candidate.fit = overlap(candidate, mask, w, h);
            if (candidate.fit > next.fit + 1e-4)
                next = candidate;
        }
        if (next === best)
            break;
        best = next;
    }
    return best.fit - shape.fit >= REFINE_GAIN ? best : shape;
}

// The outline's distance from the center at `count` angles, or null when a ray
// leaves the shape more than once (not star-shaped).
function radii(mask, w, h, cx, cy, count) {
    const out = new Float64Array(count);
    const reach = Math.hypot(mask.x2 - mask.x1 + 2, mask.y2 - mask.y1 + 2);
    let bent = 0;
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * 2 * Math.PI;
        const ux = Math.cos(angle), uy = Math.sin(angle);
        let last = 0, inside = true, exits = 0;
        for (let r = 0; r <= reach; r += 0.25) {
            const x = Math.floor(cx + ux * r), y = Math.floor(cy + uy * r);
            const now = x >= 0 && y >= 0 && x < w && y < h && mask.data[y * w + x] > 0;
            if (now)
                last = r;
            else if (inside)
                exits++;
            inside = now;
        }
        if (exits > 1)
            bent++;
        out[i] = last;
    }
    return bent > count * 0.03 ? null : out;
}

// A shape with regular teeth or waves (a gear, a scalloped badge): the
// outline's distance from the center is the basic shape's times a periodic
// factor whose energy sits in one count of teeth and its multiples.
function fitRipple(mask, w, h, basic) {
    const N = 256;
    const measured = radii(mask, w, h, basic.cx, basic.cy, N);
    if (!measured)
        return null;
    const ratio = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) {
        const angle = (i / N) * 2 * Math.PI;
        const ux = Math.cos(angle), uy = Math.sin(angle);
        // The basic shape's radius along the ray, by bisection on its distance.
        let lo = 0, hi = Math.max(basic.rx, basic.ry) * 2;
        const plain = { ...basic, ripple: null };
        for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2;
            if (shapeDistance(plain, basic.cx + ux * mid, basic.cy + uy * mid) < 0)
                lo = mid;
            else
                hi = mid;
        }
        ratio[i] = measured[i] / Math.max(lo, 1);
        mean += ratio[i];
    }
    mean /= N;
    const amps = [0], phases = [0];
    let total = 0;
    for (let k = 1; k <= N / 4; k++) {
        let re = 0, im = 0;
        for (let i = 0; i < N; i++) {
            const a = (k * i / N) * 2 * Math.PI;
            re += (ratio[i] / mean - 1) * Math.cos(a);
            im += (ratio[i] / mean - 1) * Math.sin(a);
        }
        amps[k] = Math.hypot(re, im) * 2 / N;
        phases[k] = Math.atan2(im, re);
        total += amps[k] ** 2;
    }
    let best = 0, bestEnergy = 0;
    for (let k = MIN_TEETH; 3 * k <= N / 4; k++) {
        const energy = amps[k] ** 2 + amps[2 * k] ** 2 + amps[3 * k] ** 2;
        if (energy > bestEnergy) {
            best = k;
            bestEnergy = energy;
        }
    }
    if (!best || amps[best] < 0.015 || bestEnergy < total * 0.75)
        return null;
    const shape = {
        ...basic,
        ripple: { count: best, scale: mean, harmonics: [1, 2, 3].map(n => [amps[n * best], phases[n * best]]) },
    };
    shape.fit = overlap(shape, mask, w, h);
    return shape.fit >= FIT_PLATE ? shape : null;
}

// The closest shape, which may fit less than FIT_PLATE (down to PEER_FIT).
function fitShape(mask, w, h, refine = false) {
    if (mask.x2 - mask.x1 < 6 || mask.y2 - mask.y1 < 6)
        return null;
    const basic = fitBasic(mask, w, h, refine);
    if (fits(basic))
        return basic;
    // Teeth sit on a round or a square outline, not on a diamond's.
    const round = basic.kind === 'superellipse' && basic.exponent < 2
        ? fitBasic(mask, w, h, refine, EXPONENTS.filter(n => n >= 2)) : basic;
    return fitRipple(mask, w, h, round) ?? (basic.fit >= PEER_FIT ? basic : null);
}

// Neighbouring pixels closer than SAME_AREA in color, joined: the plates are found in these areas, which keep a shape
// whole across faint lines in it.
function areas(lab, opaque, w, h) {
    const parent = new Int32Array(w * h).map((_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!opaque[i])
                continue;
            for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1]) {
                if (j >= 0 && opaque[j] && apart(lab, i, j) < SAME_AREA)
                    parent[find(i)] = find(j);
            }
        }
    }
    const labels = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
        if (opaque[i])
            labels[i] = find(i);
    }
    return labels;
}

function apart(lab, i, j) {
    return Math.hypot(lab[i * 3] - lab[j * 3], lab[i * 3 + 1] - lab[j * 3 + 1], lab[i * 3 + 2] - lab[j * 3 + 2]);
}

// Finer areas, by graph-based segmentation (Felzenszwalb and Huttenlocher): neighbours are joined from the closest
// pair up, and two areas only while the step between them is no larger than the steps already inside each, plus
// FINE_JOIN over the area's size (`pixel` is the size of an analysis pixel). A gradient's small steps join it whole,
// while a faint edge parts two areas even where anti-aliasing along a curve softens it. Two areas whose mean colors
// are more than FINE_DRIFT apart stay apart all the same, so that a soft edge (a bevel, a blur) is not a gradient
// that joins a letter to its outline.
function fineAreas(lab, opaque, w, h, pixel) {
    const n = w * h;
    // Each edge as its weight in millionths and its index in one number, so that a numeric sort orders them by weight.
    const keys = new Float64Array(n * 2);
    let edges = 0;
    for (let i = 0; i < n; i++) {
        if (!opaque[i])
            continue;
        if (i % w + 1 < w && opaque[i + 1])
            keys[edges++] = Math.round(apart(lab, i, i + 1) * 1e6) * EDGE_SLOTS + i * 2;
        if (i + w < n && opaque[i + w])
            keys[edges++] = Math.round(apart(lab, i, i + w) * 1e6) * EDGE_SLOTS + i * 2 + 1;
    }
    const order = keys.subarray(0, edges).sort();
    const parent = new Int32Array(n).map((_, i) => i);
    const size = new Float64Array(n).fill(1);
    const inside = new Float64Array(n);
    const sums = Float64Array.from(lab.subarray(0, n * 3));
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const join = FINE_JOIN * pixel;
    for (const key of order) {
        const slot = key % EDGE_SLOTS, i = Math.floor(slot / 2);
        const a = find(i), b = find(slot % 2 ? i + w : i + 1), step = Math.floor(key / EDGE_SLOTS) / 1e6;
        if (a === b || step > FINE_MAX || step > Math.min(inside[a] + join / size[a], inside[b] + join / size[b]))
            continue;
        const drift = Math.hypot(...[0, 1, 2].map(c => sums[a * 3 + c] / size[a] - sums[b * 3 + c] / size[b]));
        if (drift > FINE_DRIFT)
            continue;
        parent[a] = b;
        size[b] += size[a];
        inside[b] = step;
        for (let c = 0; c < 3; c++)
            sums[b * 3 + c] += sums[a * 3 + c];
    }
    const labels = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        if (opaque[i])
            labels[i] = find(i);
    }
    return labels;
}

/** The mask with every hole in it filled. */
function filled(data, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const push = (i) => {
        if (!data[i] && !outside[i]) {
            outside[i] = 1;
            stack.push(i);
        }
    };
    for (let x = 0; x < w; x++) {
        push(x);
        push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        push(y * w);
        push(y * w + w - 1);
    }
    while (stack.length) {
        const i = stack.pop();
        const x = i % w, y = (i - x) / w;
        if (x > 0)
            push(i - 1);
        if (x < w - 1)
            push(i + 1);
        if (y > 0)
            push(i - w);
        if (y < h - 1)
            push(i + w);
    }
    return outside.map(v => 1 - v);
}

const TERMS = 6;

function terms(shape, x, y, out) {
    const u = (x - shape.cx) / shape.rx, v = (y - shape.cy) / shape.ry;
    out[0] = 1;
    out[1] = u;
    out[2] = v;
    out[3] = u * u;
    out[4] = u * v;
    out[5] = v * v;
}

/** The plate's Oklab color at a pixel position. */
export function plateColor(plate, x, y, out = [0, 0, 0]) {
    const t = new Float64Array(TERMS);
    terms(plate.shape, x, y, t);
    for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < TERMS; k++)
            v += plate.color[c][k] * t[k];
        out[c] = v;
    }
    return out;
}

function solve(a, b, n) {
    const m = Float64Array.from(a);
    const x = Float64Array.from(b);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(m[r * n + col]) > Math.abs(m[pivot * n + col]))
                pivot = r;
        }
        if (Math.abs(m[pivot * n + col]) < 1e-9)
            return null;
        for (let k = 0; k < n; k++)
            [m[col * n + k], m[pivot * n + k]] = [m[pivot * n + k], m[col * n + k]];
        [x[col], x[pivot]] = [x[pivot], x[col]];
        for (let r = 0; r < n; r++) {
            if (r === col)
                continue;
            const f = m[r * n + col] / m[col * n + col];
            for (let k = col; k < n; k++)
                m[r * n + k] -= f * m[col * n + k];
            x[r] -= f * x[col];
        }
    }
    for (let r = 0; r < n; r++)
        x[r] /= m[r * n + r];
    return x;
}

// A least-squares quadratic color over the pixels, refitted twice without the
// ones far from it (a symbol over the rim, the plate's own highlights).
function fitColor(shape, pixels, lab, w) {
    // Start from the pixels near the median color, so that a symbol that runs
    // into the plate through soft edges does not pull the first fit.
    const median = [0, 1, 2].map(ch => {
        const values = pixels.map(i => lab[i * 3 + ch]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)] ?? 0;
    });
    let weights = Float64Array.from(pixels, i => (Math.hypot(lab[i * 3] - median[0], lab[i * 3 + 1] - median[1], lab[i * 3 + 2] - median[2]) < 0.15 ? 1 : 0));
    let color = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
    let rms = 1, kept = 0, noise = 1;
    const t = new Float64Array(TERMS);
    for (let round = 0; round < 3; round++) {
        const ata = new Float64Array(TERMS * TERMS);
        const atb = [new Float64Array(TERMS), new Float64Array(TERMS), new Float64Array(TERMS)];
        pixels.forEach((i, n) => {
            if (!weights[n])
                return;
            terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
            for (let r = 0; r < TERMS; r++) {
                for (let c = 0; c < TERMS; c++)
                    ata[r * TERMS + c] += t[r] * t[c];
                for (let ch = 0; ch < 3; ch++)
                    atb[ch][r] += t[r] * lab[i * 3 + ch];
            }
        });
        // A little damping keeps the curvature terms from running off on a thin rim.
        for (let r = 1; r < TERMS; r++)
            ata[r * TERMS + r] += r >= 3 ? 2 : 0.5;
        const solved = atb.map(b => solve(ata, b, TERMS));
        if (solved.some(s => !s))
            break;
        color = solved.map(s => Array.from(s));
        const residuals = pixels.map(i => {
            terms(shape, i % w + 0.5, Math.floor(i / w) + 0.5, t);
            let d2 = 0;
            for (let ch = 0; ch < 3; ch++) {
                let v = 0;
                for (let k = 0; k < TERMS; k++)
                    v += color[ch][k] * t[k];
                d2 += (v - lab[i * 3 + ch]) ** 2;
            }
            return Math.sqrt(d2);
        });
        const sorted = [...residuals].sort((a, b) => a - b);
        noise = sorted[Math.floor(sorted.length * 0.5)] ?? 1;
        const limit = Math.max(noise * 3, 0.03);
        weights = Float64Array.from(residuals, r => (r <= limit ? 1 : 0));
        let sum = 0;
        kept = 0;
        residuals.forEach((r, n) => {
            if (!weights[n])
                return;
            sum += r * r;
            kept++;
        });
        rms = kept ? Math.sqrt(sum / kept) : 1;
    }
    return { color, rms, kept: pixels.length ? kept / pixels.length : 0, noise };
}

// The mask grown by `steps` pixels.
function dilated(mask, w, h, steps) {
    let out = mask;
    for (let k = 0; k < steps; k++) {
        const from = out;
        out = from.map((v, i) => {
            const x = i % w;
            return v || (x > 0 && from[i - 1]) || (x < w - 1 && from[i + 1]) || (i >= w && from[i - w]) || (i < w * (h - 1) && from[i + w])
                ? 1 : 0;
        });
    }
    return out;
}

// Shapes a pixel or so apart in place and size are one plate.
function sameShape(a, b) {
    return [a.cx - b.cx, a.cy - b.cy, a.rx - b.rx, a.ry - b.ry].every(d => Math.abs(d) <= 1.5);
}

// How much of the mask's edge lies on the shape's outline.
function alongOutline(mask, shape, w, h) {
    let edge = 0, on = 0;
    for (let y = mask.y1; y <= mask.y2; y++) {
        for (let x = mask.x1; x <= mask.x2; x++) {
            const i = y * w + x;
            if (!mask.data[i])
                continue;
            if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && mask.data[i - 1] && mask.data[i + 1] && mask.data[i - w] && mask.data[i + w])
                continue;
            edge++;
            if (Math.abs(shapeDistance(shape, x + 0.5, y + 0.5)) < BAND)
                on++;
        }
    }
    return edge ? on / edge : 0;
}

function alike(a, b) {
    const near = (x, y) => Math.abs(x - y) <= PEER_SIZE * Math.max(x, y);
    return near(a.mask.area, b.mask.area) && near(a.shape.rx, b.shape.rx) && near(a.shape.ry, b.shape.ry);
}

export function analyzeIcon(icon) {
    const { width: w, height: h, data } = icon;
    const n = w * h;
    const lab = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const opaque = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        oklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);
        alpha[i] = data[i * 4 + 3] / 255;
        opaque[i] = alpha[i] >= 0.5 ? 1 : 0;
    }
    // Candidates: the whole silhouette, and every large area with its holes filled.
    const candidates = [];
    const add = (fill, absorbed = false, refine = false) => {
        const mask = maskOf(fill, w, h);
        if (mask.area < n * PEER_AREA)
            return;
        let solid = 0;
        for (let i = 0; i < n; i++)
            solid += fill[i] & opaque[i];
        if (solid < mask.area * MIN_OPAQUE)
            return;
        const shape = fitShape(mask, w, h, refine);
        if (shape)
            candidates.push({ mask, shape, strict: mask.area >= n * MIN_PLATE_AREA && fits(shape), absorbed });
    };
    add(filled(opaque, w, h), false, true);
    const labels = areas(lab, opaque, w, h);
    const sizes = new Map();
    for (let i = 0; i < n; i++) {
        if (labels[i] >= 0)
            sizes.set(labels[i], (sizes.get(labels[i]) ?? 0) + 1);
    }
    const absorbed = (fill) => {
        const mask = maskOf(fill, w, h);
        if (mask.area < n * PEER_AREA || mask.x2 - mask.x1 < 6 || mask.y2 - mask.y1 < 6)
            return null;
        const basic = fitBasic(mask, w, h);
        if (fits(basic))
            return null;
        const inside = new Map();
        for (let i = 0; i < n; i++) {
            if (fill[i] || labels[i] < 0 || coverageOf(basic, i % w, Math.floor(i / w)) <= 0.5)
                continue;
            inside.set(labels[i], (inside.get(labels[i]) ?? 0) + 1);
        }
        const taken = [...inside].filter(([label, count]) => count >= sizes.get(label) * ABSORB_INSIDE).map(([label]) => label);
        const added = taken.reduce((sum, label) => sum + sizes.get(label), 0);
        if (!added || added > mask.area * ABSORB_SHARE)
            return null;
        const out = Uint8Array.from(fill);
        for (let i = 0; i < n; i++) {
            if (taken.includes(labels[i]))
                out[i] = 1;
        }
        return out;
    };
    for (const [label, size] of sizes) {
        if (size < n * PEER_AREA * 0.5)
            continue;
        const area = new Uint8Array(n);
        for (let i = 0; i < n; i++)
            area[i] = labels[i] === label ? 1 : 0;
        const fill = filled(area, w, h);
        add(fill);
        const whole = absorbed(fill);
        if (whole)
            add(filled(whole, w, h), true);
    }
    const platesFrom = (pool) => {
        // Outermost first. A candidate the same as one kept already is the same
        // plate, and one that lies partly over a kept plate is not a plate.
        const sorted = [...pool].sort((a, b) => b.mask.area - a.mask.area);
        const kept = [];
        const parents = [];
        // How much of `mask` lies in `shape`.
        const share = (mask, shape) => {
            let inside = 0;
            for (let i = 0; i < n; i++) {
                if (mask.data[i] && coverageOf(shape, i % w, Math.floor(i / w)) > 0.5)
                    inside++;
            }
            return inside / mask.area;
        };
        // The median of an Oklab channel over the opaque pixels of `mask`.
        const medianOf = (mask, ch) => {
            const values = [];
            for (let i = 0; i < n; i++) {
                if (mask[i] && opaque[i])
                    values.push(lab[i * 3 + ch]);
            }
            return values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
        };
        // The kept plate `c` lies in, -1 for none, or null when it lies partly over one.
        const placeOf = (c) => {
            if (kept.some(k => overlap(k.shape, c.mask, w, h) > 0.95 || sameShape(k.shape, c.shape)))
                return null;
            const shares = kept.map(k => share(c.mask, k.shape));
            if (shares.some(share => share > 0.1 && share < 0.9))
                return null;
            let parent = -1;
            for (let k = kept.length - 1; k >= 0 && parent < 0; k--) {
                if (shares[k] >= 0.9)
                    parent = k;
            }
            // A part of the plate's surface lies in it, not on it: a shape in the color around it (one a line encloses), or
            // in a shade of that color reaching the plate's outline past any rim (a stripe, a quarter).
            if (parent >= 0) {
                const around = dilated(c.mask.data, w, h, 6).map((v, i) => v & kept[parent].mask.data[i] & (1 - c.mask.data[i]));
                const near = Math.hypot(...[0, 1, 2].map(ch => medianOf(c.mask.data, ch) - medianOf(around, ch)));
                if (near < SYMBOL_LOW || (near < GROUND_NEAR && alongOutline(c.mask, kept[parent].shape, w, h) > ALONG_PARENT))
                    return null;
            }
            return parent;
        };
        const loose = sorted.filter(candidate => !candidate.strict);
        for (const c of sorted.filter(candidate => candidate.strict)) {
            const parent = placeOf(c);
            if (parent === null)
                continue;
            if (parent >= 0 && c.mask.area < kept[parent].mask.area * MIN_INNER_SHARE) {
                loose.push(c);
                continue;
            }
            kept.push(c);
            parents.push(parent);
        }
        // Then the shapes alike to a kept plate on the same plate. Nothing kept lies in them, so they go last.
        loose.sort((a, b) => b.mask.area - a.mask.area);
        for (const c of loose) {
            const parent = placeOf(c);
            if (parent === null || !kept.some((k, i) => parents[i] === parent && alike(k, c)))
                continue;
            if (kept.some(k => k.mask.area < c.mask.area && share(k.mask, c.shape) >= 0.9))
                continue;
            kept.push(c);
            parents.push(parent);
        }
        // Per pixel, the innermost plate it is in.
        const owner = new Int32Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            const x = i % w + 0.5, y = Math.floor(i / w) + 0.5;
            for (let k = kept.length - 1; k >= 0; k--) {
                if (shapeDistance(kept[k].shape, x, y) < 0) {
                    owner[i] = k;
                    break;
                }
            }
        }
        // A plate's color is that of its largest smooth area: its rim may carry a
        // lit edge or a border, and a symbol may cross it. A plate whose largest
        // area is a small part of it carries a picture.
        const plates = kept.map((c, k) => {
            const own = [];
            const counts = new Map();
            for (let i = 0; i < n; i++) {
                if (owner[i] !== k || !opaque[i])
                    continue;
                own.push(i);
                counts.set(labels[i], (counts.get(labels[i]) ?? 0) + 1);
            }
            let main = -1, most = 0;
            for (const [label, count] of counts) {
                if (count > most) {
                    main = label;
                    most = count;
                }
            }
            // Grain breaks a plate into specks; then the fit starts from all of it.
            const share = own.length ? most / own.length : 0;
            const fit = fitColor(c.shape, share >= MIN_SURFACE ? own.filter(i => labels[i] === main) : own, lab, w);
            const plate = {
                shape: c.shape, color: fit.color, plain: false, parent: parents[k], surface: 0, error: fit.rms,
                share, noise: fit.noise, pieces: piecesOf(own, counts, most, labels, lab)
            };
            let surface = 0;
            const at = [0, 0, 0];
            const near = Math.max(SYMBOL_LOW, fit.noise * 3);
            for (const i of own) {
                plateColor(plate, i % w + 0.5, Math.floor(i / w) + 0.5, at);
                if (Math.hypot(at[0] - lab[i * 3], at[1] - lab[i * 3 + 1], at[2] - lab[i * 3 + 2]) < near)
                    surface++;
            }
            plate.surface = own.length ? surface / own.length : 0;
            // A grainy plate strays evenly: its typical pixel is near its color.
            plate.plain = plate.surface >= MIN_SURFACE && (fit.rms < PLAIN_RMS || fit.noise < MAX_GRAIN);
            return plate;
        });
        return { plates, kept };
    };
    // Plates that took in pieces of other colors must not make the icon one that carries a picture (shown as it is,
    // which happens when such a plate, or the plate it takes the place of part of, is no longer plain): then the
    // pieces stay symbol on the plates under them.
    const picture = (plates) => plates.some(plate => !plate.plain);
    let { plates } = platesFrom(candidates);
    if (picture(plates) && candidates.some(c => c.absorbed)) {
        const without = platesFrom(candidates.filter(c => !c.absorbed)).plates;
        if (!picture(without))
            plates = without;
    }
    // The ring and the disc in the middle of a pie, in colors far from all of its pieces', are drawn as symbol with the
    // pieces, which they belong to.
    const cut = plates;
    plates = withoutPlates(plates, plate => plate.parent >= 0 && cut[plate.parent].pieces.length > 0 &&
        cut[plate.parent].pieces.every(p => Math.hypot(...plateColor(plate, plate.shape.cx, plate.shape.cy).map((v, c) => v - p[c])) >= PIECE_FOREIGN));
    const { symbol, intensity } = symbolLayer(plates, w, icon);
    return { width: w, height: h, plates, symbol, intensity };
}

/** The plates without those `leftOut` picks and the plates on them. A plate comes after the plate it sits on. */
export function withoutPlates(plates, leftOut) {
    const index = [];
    const out = [];
    plates.forEach((plate, k) => {
        index[k] = -1;
        if (leftOut(plate) || (plate.parent >= 0 && index[plate.parent] < 0))
            return;
        index[k] = out.length;
        out.push({ ...plate, parent: plate.parent < 0 ? -1 : index[plate.parent] });
    });
    return out;
}

// The mean colors of the pieces a plate's surface is cut into (see PIECE_SHARE), or none.
function piecesOf(own, counts, most, labels, lab) {
    const big = [...counts].filter(([label, count]) => label >= 0 && count >= most * PIECE_SHARE && count >= own.length * PIECE_MIN)
        .map(([label]) => label);
    if (big.length < 3)
        return [];
    const sums = new Map(big.map(label => [label, [0, 0, 0]]));
    for (const i of own) {
        const sum = sums.get(labels[i]);
        if (sum)
            for (let c = 0; c < 3; c++)
                sum[c] += lab[i * 3 + c];
    }
    const colors = big.map(label => sums.get(label).map(v => v / counts.get(label)));
    const distinct = [];
    for (const c of colors) {
        if (distinct.every(d => Math.hypot(c[0] - d[0], c[1] - d[1], c[2] - d[2]) >= PIECE_APART))
            distinct.push(c);
    }
    return distinct.length >= 3 ? colors : [];
}

// Oklab distance from `c` to the segment from `p` to `q`: a pixel on the
// line between two plates mixes their colors.
function segmentDistance(c, p, q) {
    const v = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const t = len2 > 0 ? Math.min(Math.max(((c[0] - p[0]) * v[0] + (c[1] - p[1]) * v[1] + (c[2] - p[2]) * v[2]) / len2, 0), 1) : 0;
    return Math.hypot(c[0] - p[0] - v[0] * t, c[1] - p[1] - v[1] * t, c[2] - p[2] - v[2] * t);
}

/**
 * The symbol over `plates` (from analyzeIcon() at `analysisWidth` px) in `pixels`, which may be the icon drawn at
 * another size: per pixel how much of it is symbol, the symbol's own tone, and the shade of the plate's surface.
 *
 * Whether something is symbol is decided for each large color area as a whole, so that a gradient across an area
 * cannot make part of it symbol. A plate's surface is the area most in its color, the large areas in shades of it
 * that reach its outline and the areas enclosed in it in its color; everything else on the plate is measured against
 * the surface around it. Small areas (anti-aliased edges, thin lines) and areas that fade into the surface (a glow, a
 * soft shadow) are measured pixel by pixel: a pixel's distance from the surface grows with how much of it the symbol
 * covers, up to the symbol's full color, taken from the strongest pixel next to it that differs the same way.
 */
export function symbolLayer(plates, analysisWidth, pixels) {
    const { width: w, height: h, data } = pixels;
    const n = w * h;
    // Analysis px per pixel.
    const s = analysisWidth / w;
    const lab = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const opaque = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        oklab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab, i * 3);
        alpha[i] = data[i * 4 + 3] / 255;
        opaque[i] = alpha[i] >= 0.5 ? 1 : 0;
    }
    const owner = new Int32Array(n).fill(-1);
    // How far inside its plate a pixel is, in pixels, and the plates whose outline it is near.
    const depth = new Float32Array(n);
    const nearby = new Map();
    for (let i = 0; i < n; i++) {
        const x = (i % w + 0.5) * s, y = (Math.floor(i / w) + 0.5) * s;
        for (let k = plates.length - 1; k >= 0; k--) {
            const d = shapeDistance(plates[k].shape, x, y) / s;
            if (d < 0 && owner[i] < 0) {
                owner[i] = k;
                depth[i] = d;
            }
            else if (Math.abs(d) < 1.5) {
                nearby.set(i, [...nearby.get(i) ?? [], k]);
            }
        }
    }
    const regions = regionsOf(lab, opaque, owner, depth, w, h, s);
    const { region } = regions;
    const list = regions.list;
    const plain = (k) => k >= 0 && plates[k].plain;
    // Per plate, how many of its pixels there are and how many lie in its outer band, and its main area: the one with
    // the most pixels in the plate's own color (the largest area may be a symbol over most of it).
    const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const own = plates.map(() => 0), band = plates.map(() => 0);
    const matching = new Float64Array(list.length);
    // Per area, how much lighter its pixels are than the plate's color there, summed (the plate's own gradient left out).
    const lighter = new Float64Array(list.length);
    const fit = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const k = owner[i], j = region[i];
        if (j < 0 || k < 0)
            continue;
        plateColor(plates[k], (i % w + 0.5) * s, (Math.floor(i / w) + 0.5) * s, fit);
        if (colorDistance(lab.subarray(i * 3, i * 3 + 3), fit) < Math.max(SYMBOL_LOW, plates[k].noise * 3))
            matching[j]++;
        if (regions.inner[i])
            lighter[j] += lab[i * 3] - fit[0];
    }
    const main = plates.map(() => -1);
    list.forEach((r, j) => {
        if (r.owner < 0)
            return;
        own[r.owner] += r.count;
        band[r.owner] += r.band;
        if (main[r.owner] < 0 || matching[j] > matching[main[r.owner]])
            main[r.owner] = j;
    });
    // The surface grows from each plate's main area by the large areas along its outline whose closest pixels come
    // near the color of an area already in it: facets shaded away from it, quarters in a darker shade, stripes.
    // A line (a trace, a stroke) is not part of a surface however close in color: its pixels over its edge's are its
    // breadth, about half its width.
    const broad = (r) => r.count / Math.max(r.count - r.interior, 1) * s >= GROUND_BREADTH;
    // The areas that lie along their plate's outline.
    const rim = new Float64Array(list.length);
    const deep = new Float64Array(list.length), deep2 = new Float64Array(list.length);
    const bandOf = (k) => Math.max(1.5, Math.min(plates[k].shape.rx, plates[k].shape.ry) * EDGE_BAND);
    for (let i = 0; i < n; i++) {
        const k = owner[i], j = region[i];
        if (j < 0 || k < 0)
            continue;
        if (-depth[i] * s < bandOf(k))
            rim[j]++;
        deep[j] -= depth[i] * s;
        deep2[j] += (depth[i] * s) ** 2;
    }
    const even = (r, j) => {
        const mean = deep[j] / r.count;
        return !broad(r) && mean < bandOf(r.owner) * 2 && deep2[j] / r.count - mean * mean < EDGE_EVEN ** 2 &&
            r.count >= plates[r.owner].shape.rx + plates[r.owner].shape.ry;
    };
    const pending = new Map();
    list.forEach((r, j) => {
        r.edge = plain(r.owner) && j !== main[r.owner] && (rim[j] >= r.count * EDGE_INSIDE || even(r, j));
        r.decided = plain(r.owner) && !r.edge && r.count >= n * REGION_MIN && r.interior >= Math.max(8, r.count * THICK);
        r.ground = plain(r.owner) && j === main[r.owner];
        if (r.decided && !r.ground && broad(r) && r.count >= own[r.owner] * GROUND_SHARE && r.band >= band[r.owner] * GROUND_EDGE)
            pending.set(j, []);
    });
    for (let i = 0; i < n; i++) {
        if (regions.inner[i])
            pending.get(region[i])?.push(i);
    }
    for (let grown = true; grown;) {
        grown = false;
        for (const [j, inside] of pending) {
            const surface = list.filter(r => r.ground && r.owner === list[j].owner);
            const near = inside.map(i => Math.min(...surface.map(r => colorDistance(lab.subarray(i * 3, i * 3 + 3), r.color))))
                .sort((a, b) => a - b)[Math.floor(inside.length * GROUND_CLOSEST)];
            if (!(near < GROUND_NEAR))
                continue;
            list[j].ground = grown = true;
            pending.delete(j);
        }
    }
    // Then the large areas anywhere on the plate most of whose pixels have that surface's color: the cells between
    // lines drawn across it, a faint glow on it. Measured against that surface alone, so that it does not reach on
    // through a glow into the line it comes from.
    const surfaces = list.filter(r => r.ground);
    const closest = new Map();
    list.forEach((r, j) => {
        if (r.decided && !r.ground && broad(r))
            closest.set(j, []);
    });
    for (let i = 0; i < n; i++) {
        if (regions.inner[i])
            closest.get(region[i])?.push(i);
    }
    for (const [j, inside] of closest) {
        const r = list[j], surface = surfaces.filter(g => g.owner === r.owner);
        const near = inside.map(i => Math.min(...surface.map(g => colorDistance(lab.subarray(i * 3, i * 3 + 3), g.color))))
            .sort((a, b) => a - b)[Math.floor(inside.length / 2)];
        if (near < Math.max(SYMBOL_LOW, plates[r.owner].noise * 3))
            r.ground = true;
    }
    // And the large areas the surface shades into with no step along most of the edge they share: the side of a raised
    // shape turned from the light.
    const seams = new Map();
    for (let i = 0; i < n; i++) {
        const j = region[i];
        if (j < 0)
            continue;
        for (const k of [i % w + 1 < w ? i + 1 : -1, i + w < n ? i + w : -1]) {
            if (k < 0 || region[k] < 0 || region[k] === j)
                continue;
            const key = Math.min(j, region[k]) * list.length + Math.max(j, region[k]);
            if (!seams.has(key))
                seams.set(key, []);
            seams.get(key).push(apart(lab, i, k));
        }
    }
    const seamless = [...seams].filter(([, steps]) => steps.length >= SEAM_MIN &&
        steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] < SEAM_STEP).map(([key]) => key);
    for (let grown = true; grown;) {
        grown = false;
        for (const key of seamless) {
            const a = list[Math.floor(key / list.length)], b = list[key % list.length];
            if (a.owner !== b.owner || a.ground === b.ground)
                continue;
            const r = a.ground ? b : a;
            if (r.decided && broad(r))
                r.ground = grown = true;
        }
    }
    const step = (k) => Math.max(SURFACE_STEP, plates[k].noise * 2);
    // How much lighter or darker than the plate's color a part of its surface is, against the main area's, small
    // differences left out.
    const lift = (j) => (list[j].interior ? lighter[j] / list[j].interior : 0);
    const shades = list.map((r, j) => {
        if (!plain(r.owner))
            return 0;
        const d = lift(j) - lift(main[r.owner]);
        return Math.sign(d) * Math.max(Math.abs(d) - step(r.owner), 0);
    });
    // The surface's color and shade around every pixel of a plate.
    const ref = new Float32Array(n * 3);
    const refShade = new Float32Array(n);
    const low = new Float32Array(n);
    plates.forEach((plate, k) => {
        if (!plate.plain)
            return;
        const surface = new Float32Array(n * 5);
        for (let i = 0; i < n; i++) {
            const r = region[i] >= 0 ? list[region[i]] : null;
            if (owner[i] !== k || !r?.ground || !regions.inner[i])
                continue;
            surface.set([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], shades[region[i]], 1], i * 5);
        }
        const wanted = Uint8Array.from(owner, o => (o === k ? 1 : 0));
        const around = localMeans(surface, wanted, w, h, 5, REACH.map(radius => Math.max(1, Math.round(radius / s))));
        for (let i = 0; i < n; i++) {
            if (!wanted[i])
                continue;
            // Inside the surface only what stands far out of it is symbol (a line in a glow that took the area in).
            const inside = region[i] >= 0 && list[region[i]].ground && regions.inner[i];
            low[i] = Math.max(inside ? SYMBOL_HIGH : SYMBOL_LOW, plate.noise * 3);
            if (around[i * 5 + 4] > 0) {
                ref.set(around.subarray(i * 5, i * 5 + 3), i * 3);
                refShade[i] = around[i * 5 + 3];
            }
            else {
                ref.set(plateColor(plate, (i % w + 0.5) * s, (Math.floor(i / w) + 0.5) * s, fit), i * 3);
            }
        }
    });
    // Per pixel, how far it is from the surface around it (Oklab); Infinity off the plain plates.
    const raw = new Float32Array(n);
    const other = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const k = owner[i];
        if (!plain(k)) {
            raw[i] = Infinity;
            continue;
        }
        // The plate's own anti-aliased outline is not symbol.
        if (depth[i] > -1.2 && plates[k].parent < 0)
            continue;
        const c = lab.subarray(i * 3, i * 3 + 3), at = Array.from(ref.subarray(i * 3, i * 3 + 3));
        let d = colorDistance(c, at);
        // Along the outline between two plates, the pixel mixes them.
        for (const j of nearby.get(i) ?? []) {
            if (j === k || !plates[j].plain)
                continue;
            d = Math.min(d, segmentDistance(c, at, plateColor(plates[j], (i % w + 0.5) * s, (Math.floor(i / w) + 0.5) * s, other)));
        }
        raw[i] = d;
    }
    // A large area's contrast: its typical pixel's distance from the surface around it. One that fades into the surface
    // (a glow, a soft shadow: its closest pixels come within the symbol's threshold of it) is measured pixel by pixel,
    // as the surface itself is: only what stands far out of it is symbol.
    const distances = list.map(r => (r.decided && !r.ground ? [] : null));
    for (let i = 0; i < n; i++) {
        const j = region[i];
        if (j >= 0 && raw[i] !== Infinity)
            distances[j]?.push(raw[i]);
    }
    list.forEach((r, j) => {
        const d = distances[j]?.sort((a, b) => a - b);
        if (!d)
            return;
        const lo = Math.max(SYMBOL_LOW, plates[r.owner].noise * 3);
        r.decided = d.length > 0 && d[Math.floor(d.length * FADE_CLOSEST)] >= lo;
        r.fades = !r.decided;
        if (!r.decided)
            return;
        // An area is symbol or not as a whole: only around the threshold is it partly.
        r.contrast = d[Math.floor(d.length / 2)];
        r.strength = smoothstep(lo * 0.8, lo * 1.3, r.contrast);
    });
    // A large area that is the surface around it under a veil of white or black, laid evenly over a surface whose color
    // changes under it (a pane of frosted glass over a gradient), is a shade of the surface.
    const veiled = list.map(() => []);
    for (let i = 0; i < n; i++) {
        const r = region[i] >= 0 ? list[region[i]] : null;
        if (r?.decided && r.strength > 0 && regions.inner[i] && raw[i] !== Infinity && broad(r))
            veiled[region[i]].push(i);
    }
    const quantile = (values, q) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
    veiled.forEach((inside, j) => {
        if (inside.length < VEIL_MIN / (s * s))
            return;
        const white = quantile(inside.map(i => lab[i * 3] - ref[i * 3]), 0.5) > 0;
        const alpha = quantile(inside.map(i => (white ? (lab[i * 3] - ref[i * 3]) / (1 - ref[i * 3]) : 1 - lab[i * 3] / ref[i * 3])), 0.5);
        if (alpha < GLOSS_MIN || alpha > VEIL_MAX)
            return;
        const off = quantile(inside.map(i => Math.hypot(lab[i * 3] - (ref[i * 3] + ((white ? 1 : 0) - ref[i * 3]) * alpha), lab[i * 3 + 1] - ref[i * 3 + 1] * (1 - alpha), lab[i * 3 + 2] - ref[i * 3 + 2] * (1 - alpha))), 0.75);
        const spread = Math.max(...[0, 1, 2].map(c => {
            const values = inside.map(i => ref[i * 3 + c]);
            return quantile(values, 0.9) - quantile(values, 0.1);
        }));
        if (off < VEIL_NEAR && spread >= VEIL_SPREAD)
            list[j].strength = 0;
    });
    for (let i = 0; i < n; i++) {
        if (region[i] >= 0 && list[region[i]].fades)
            low[i] = Math.max(low[i], SYMBOL_HIGH);
    }
    const like = glossed(list, main, regions, w, h);
    // Whether the pixels of a group in a large area off the surface, which stand out of it, shade into the rest of that area
    // (`rest`) with no step: then only a gradient across the area (the shaded side of a raised shape) sets them apart.
    const stepless = (group, rest) => {
        const steps = [];
        for (const i of group) {
            const r = region[i], x = i % w;
            if (r < 0 || list[r].ground || !(list[r].decided || list[r].fades))
                continue;
            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
                if (j >= 0 && j < n && region[j] === r && rest(j))
                    steps.push(apart(lab, i, j));
            }
        }
        return steps.length >= SEAM_MIN && steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] < SEAM_STEP;
    };
    // In an area that fades into the surface, the pixels that stand far out of it but only through such a gradient, on
    // the lesser part of it.
    const smooth = new Uint8Array(n);
    {
        const far = (i) => region[i] >= 0 && list[region[i]].fades && raw[i] !== Infinity && raw[i] > low[i];
        const seen = new Uint8Array(n);
        for (let start = 0; start < n; start++) {
            if (seen[start] || !far(start))
                continue;
            const group = [start];
            seen[start] = 1;
            for (let g = 0; g < group.length; g++) {
                const i = group[g], x = i % w;
                for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
                    if (j >= 0 && j < n && !seen[j] && region[j] === region[i] && far(j)) {
                        seen[j] = 1;
                        group.push(j);
                    }
                }
            }
            if (group.length < list[region[start]].count / 2 && stepless(group, j => !far(j)))
                for (const i of group)
                    smooth[i] = 1;
        }
    }
    // Faint lines and specks, which fall into many small areas: each group of pixels next to one another that stand out
    // of the surface is symbol as a whole, as strongly as its typical pixel stands out, so that a faint line is drawn
    // evenly instead of in dots.
    const stroke = new Float32Array(n).fill(-1);
    {
        // How far a pixel stands out: from the surface, or within a faint area that is not symbol, from that area's color
        // (the lines of a sketch drawn on a pale patch).
        const out = Float32Array.from(raw, (d, i) => {
            const r = region[i] >= 0 ? list[region[i]] : null;
            return r?.decided && !r.ground ? Math.min(d, colorDistance(lab.subarray(i * 3, i * 3 + 3), r.color)) : d;
        });
        const loose = (i) => {
            const r = region[i] >= 0 ? list[region[i]] : null;
            return out[i] !== Infinity && out[i] > low[i] * STROKE_LOW && !r?.edge && !(r?.decided && !r.ground && r.strength >= 0.5) &&
                like[region[i]] < 0;
        };
        const seen = new Uint8Array(n);
        for (let start = 0; start < n; start++) {
            if (seen[start] || !loose(start))
                continue;
            const group = [start];
            seen[start] = 1;
            for (let g = 0; g < group.length; g++) {
                const i = group[g], x = i % w;
                for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
                    if (j >= 0 && j < n && !seen[j] && owner[j] === owner[i] && loose(j)) {
                        seen[j] = 1;
                        group.push(j);
                    }
                }
            }
            if (group.length * s * s < STROKE_MIN || stepless(group, j => !seen[j]))
                continue;
            const d = group.map(i => out[i]).sort((a, b) => a - b);
            const typical = d[Math.floor(d.length * 0.75)];
            const lo = low[group[0]];
            const strength = smoothstep(lo * 0.8, lo * 1.3, typical);
            for (const i of group)
                stroke[i] = strength * Math.min(out[i] / typical, 1);
        }
    }
    // Coverage: a large area's strength, less along its edge where it mixes with what is next to it; elsewhere the
    // distance over that of the strongest pixel within reach that differs from the surface in the same direction.
    const reach = Math.max(1, Math.ceil(1 / s));
    const cover = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const d = raw[i];
        if (d === Infinity) {
            // The drop shadow an icon casts outside its base would draw as a light halo round the glass.
            cover[i] = owner[i] < 0 && alpha[i] < SHADOW_ALPHA && lab[i * 3] < SHADOW_LIGHTNESS ? 0 : 1;
            continue;
        }
        const r = region[i] >= 0 ? list[region[i]] : null;
        if (r?.edge || smooth[i])
            continue;
        if (r && like[region[i]] >= 0) {
            cover[i] = list[like[region[i]]].strength;
            continue;
        }
        if (stroke[i] >= 0) {
            cover[i] = stroke[i];
            continue;
        }
        if (r?.decided && !r.ground) {
            cover[i] = regions.inner[i] ? r.strength : r.strength * Math.min(d / Math.max(r.contrast, 1e-3), 1);
            continue;
        }
        if (!(d > low[i]))
            continue;
        const x = i % w, y = Math.floor(i / w);
        const dx = lab[i * 3] - ref[i * 3], dy = lab[i * 3 + 1] - ref[i * 3 + 1], dz = lab[i * 3 + 2] - ref[i * 3 + 2];
        let full = d;
        for (let v = Math.max(0, y - reach); v <= Math.min(h - 1, y + reach); v++) {
            for (let u = Math.max(0, x - reach); u <= Math.min(w - 1, x + reach); u++) {
                const j = v * w + u;
                if (raw[j] === Infinity || !(raw[j] > full) || owner[j] !== owner[i])
                    continue;
                const ex = lab[j * 3] - ref[i * 3], ey = lab[j * 3 + 1] - ref[i * 3 + 1], ez = lab[j * 3 + 2] - ref[i * 3 + 2];
                const dot = dx * ex + dy * ey + dz * ez;
                if (dot > 0.9 * d * Math.hypot(ex, ey, ez))
                    full = raw[j];
            }
        }
        full = Math.max(full, low[i] + SYMBOL_HIGH - SYMBOL_LOW);
        cover[i] = Math.min(Math.max((d - low[i]) / (full - low[i]), 0), 1);
    }
    // A line that runs all along a plate at one depth (a lit edge, a border) is
    // part of the plate. A symbol rarely fills most of a ring at one depth.
    plates.forEach((plate, k) => {
        if (!plate.plain)
            return;
        const deepest = Math.max(6, Math.min(plate.shape.rx, plate.shape.ry) * 0.15) / s;
        const bins = Math.ceil(deepest * 2);
        const total = new Float64Array(bins), marked = new Float64Array(bins), means = new Float64Array(bins * 3);
        for (let i = 0; i < n; i++) {
            if (owner[i] !== k || -depth[i] >= deepest)
                continue;
            const b = Math.floor(-depth[i] * 2);
            total[b]++;
            if (cover[i] <= 0.5)
                continue;
            marked[b]++;
            for (let ch = 0; ch < 3; ch++)
                means[b * 3 + ch] += lab[i * 3 + ch];
        }
        const ring = (b) => b >= 0 && b < bins && total[b] >= 20 / s && marked[b] > total[b] * 0.6;
        const spread = Math.ceil(1 / s);
        for (let i = 0; i < n; i++) {
            if (owner[i] !== k || -depth[i] >= deepest || !cover[i])
                continue;
            const b = Math.floor(-depth[i] * 2);
            // The ring's own bins, or ones next to them for its anti-aliased sides.
            let r = -1;
            for (let o = 0; o <= spread * 2 && r < 0; o++) {
                if (ring(b - o))
                    r = b - o;
                else if (ring(b + o))
                    r = b + o;
            }
            if (r < 0)
                continue;
            const mean = [means[r * 3] / marked[r], means[r * 3 + 1] / marked[r], means[r * 3 + 2] / marked[r]];
            const d = segmentDistance(lab.subarray(i * 3, i * 3 + 3), Array.from(ref.subarray(i * 3, i * 3 + 3)), mean);
            cover[i] *= smoothstep(0.04, 0.1, d);
        }
    });
    // The pieces a plate is cut into are symbol, whichever of them its color was taken from.
    for (let i = 0; i < n; i++) {
        const k = owner[i];
        if (k < 0 || raw[i] === Infinity || !plates[k].pieces.length || (depth[i] > -1.2 && plates[k].parent < 0))
            continue;
        const nearest = Math.min(...plates[k].pieces.map(p => colorDistance(lab.subarray(i * 3, i * 3 + 3), p)));
        cover[i] = Math.max(cover[i], 1 - smoothstep(0.03, 0.07, nearest));
    }
    // The symbol's color per pixel: its area's for a large area, otherwise the pixel's own with the surface it is
    // mixed with taken out.
    const symbolic = new Float64Array(list.length);
    for (let i = 0; i < n; i++) {
        if (region[i] >= 0)
            symbolic[region[i]] += cover[i];
    }
    const big = (j) => list[j].count >= n * REGION_MIN && symbolic[j] >= list[j].count * 0.5;
    const gradients = gradientsOf(regions, lab, big);
    const tint = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const j = region[i];
        if (j >= 0 && like[j] >= 0) {
            tint.set(list[like[j]].color, i * 3);
        }
        else if (gradients.has(j)) {
            tint.set(lab.subarray(i * 3, i * 3 + 3), i * 3);
        }
        else if (j >= 0 && big(j)) {
            tint.set(list[j].color, i * 3);
        }
        else if (raw[i] === Infinity || cover[i] <= 0) {
            tint.set(lab.subarray(i * 3, i * 3 + 3), i * 3);
        }
        else {
            for (let c = 0; c < 3; c++)
                tint[i * 3 + c] = ref[i * 3 + c] + (lab[i * 3 + c] - ref[i * 3 + c]) / Math.max(cover[i], 0.25);
        }
    }
    // How long the edges are between the symbol's large areas (across a pixel of anti-aliasing, too), where the color
    // steps from one to the other rather than shading over smoothly.
    const touching = new Map();
    for (let i = 0; i < n; i++) {
        const j = region[i];
        if (j < 0 || !big(j))
            continue;
        const x = i % w, y = (i - x) / w;
        for (const [dx, dy] of [[1, 0], [2, 0], [0, 1], [0, 2]]) {
            if (x + dx >= w || y + dy >= h)
                continue;
            const k = region[i + dy * w + dx];
            if (k < 0 || k === j || !big(k))
                continue;
            if (apart(lab, i, i + dy * w + dx) < colorDistance(list[j].color, list[k].color) * TONE_STEP)
                continue;
            const key = Math.min(j, k) * list.length + Math.max(j, k);
            touching.set(key, (touching.get(key) ?? 0) + 1);
        }
    }
    const edges = [...touching].map(([key, length]) => [list[Math.floor(key / list.length)].color, list[key % list.length].color, length]);
    const tone = symbolTone(list.filter((_, j) => big(j)), edges);
    const symbol = new Float32Array(n);
    const intensity = new Float32Array(n);
    // Where the plate shows, how much lighter (positive) or darker it is there than its color: parts of a surface a
    // little apart in shade, which glass of one color would make the same.
    const surface = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const seen = owner[i] >= 0 && -depth[i] * s >= FADE_DEPTH ? alpha[i] ** FADE_GAMMA : alpha[i];
        symbol[i] = seen * cover[i];
        // A symbol in one color keeps the gradients in it as its only shading.
        const gradient = gradients.get(region[i]);
        intensity[i] = tone ? tone(tint.subarray(i * 3, i * 3 + 3)) : gradient ? 1 - DETAIL_DIM * (1 - gradient(lab, i)) : 1;
        const k = owner[i];
        if (!plain(k))
            continue;
        const r = region[i] >= 0 ? list[region[i]] : null;
        surface[i] = r?.edge ? 0 : r?.decided && r.strength < 0.5 && cover[i] < 0.5 ? shades[region[i]] : refShade[i];
    }
    return { symbol, intensity, surface };
}

// Per area, the symbol area it is part of under a gloss or a shade (-1: none): an area next to a symbol area whose
// color is that area's with the same white or black laid over it as an area of the surface next to it has over the
// surface's own color (a highlight across a lens and the rings on it).
function glossed(list, main, regions, w, h) {
    const like = list.map(() => -1);
    const near = new Map();
    const { region } = regions;
    for (let i = 0; i < w * h; i++) {
        const a = region[i];
        if (a < 0)
            continue;
        const x = i % w;
        for (const j of [x + 1 < w ? i + 1 : -1, x + 2 < w ? i + 2 : -1, i + w, i + 2 * w]) {
            const b = j < w * h && j >= 0 ? region[j] : -1;
            if (b < 0 || b === a)
                continue;
            if (!near.has(a))
                near.set(a, new Set());
            if (!near.has(b))
                near.set(b, new Set());
            near.get(a).add(b);
            near.get(b).add(a);
        }
    }
    const symbol = (r) => r.decided && !r.ground && r.strength >= 0.5;
    list.forEach((y, j) => {
        if (symbol(y) || y.edge || y.owner < 0 || main[y.owner] < 0 || y.count < 8)
            return;
        const ground = list[main[y.owner]].color;
        for (const k of near.get(j) ?? []) {
            const over = list[k];
            if (!over.ground || k === main[y.owner])
                continue;
            // How much white (or black) the gloss lays over the surface, from lightness.
            const white = over.color[0] > ground[0];
            const alpha = white ? (over.color[0] - ground[0]) / (1 - ground[0]) : (ground[0] - over.color[0]) / ground[0];
            if (alpha < GLOSS_MIN || alpha > GLOSS_MAX)
                continue;
            const to = white ? [1, 0, 0] : [0, 0, 0];
            for (const m of near.get(j) ?? []) {
                const under = list[m];
                if (!symbol(under))
                    continue;
                const expected = under.color.map((v, c) => v + (to[c] - v) * alpha);
                if (Math.hypot(...expected.map((v, c) => v - y.color[c])) < GLOSS_NEAR)
                    like[j] = m;
            }
        }
    });
    return like;
}

// The symbol's large areas (`big`) that are gradients: their colors spread GRADIENT_SPREAD or more apart along the way
// they differ most, the extreme GRADIENT_TAIL of them left out. Each with where a pixel's color lies along that way,
// from 0 to 1 (the lighter end).
function gradientsOf(regions, lab, big) {
    const inside = new Map();
    regions.region.forEach((j, i) => {
        if (j < 0 || !regions.inner[i] || !big(j))
            return;
        if (!inside.has(j))
            inside.set(j, []);
        inside.get(j).push(i);
    });
    const out = new Map();
    for (const [j, pixels] of inside) {
        if (pixels.length < 8)
            continue;
        const mean = [0, 1, 2].map(c => pixels.reduce((sum, i) => sum + lab[i * 3 + c], 0) / pixels.length);
        // The principal direction, by power iteration on the covariance, starting along lightness.
        let axis = [1, 0, 0];
        for (let round = 0; round < 12; round++) {
            const next = [0, 0, 0];
            for (const i of pixels) {
                const v0 = lab[i * 3] - mean[0], v1 = lab[i * 3 + 1] - mean[1], v2 = lab[i * 3 + 2] - mean[2];
                const dot = v0 * axis[0] + v1 * axis[1] + v2 * axis[2];
                next[0] += v0 * dot;
                next[1] += v1 * dot;
                next[2] += v2 * dot;
            }
            const len = Math.hypot(...next);
            if (len < 1e-9)
                break;
            axis = next.map(v => v / len);
        }
        if (axis[0] < 0)
            axis = axis.map(v => -v);
        const along = (data, i) => (data[i * 3] - mean[0]) * axis[0] + (data[i * 3 + 1] - mean[1]) * axis[1] + (data[i * 3 + 2] - mean[2]) * axis[2];
        const sorted = pixels.map(i => along(lab, i)).sort((a, b) => a - b);
        const lo = sorted[Math.floor((sorted.length - 1) * GRADIENT_TAIL)];
        const hi = sorted[Math.floor((sorted.length - 1) * (1 - GRADIENT_TAIL))];
        if (hi - lo < GRADIENT_SPREAD)
            continue;
        out.set(j, (data, i) => Math.min(Math.max((along(data, i) - lo) / (hi - lo), 0), 1));
    }
    return out;
}

// The color areas of an image split by the plates they lie in: per pixel an index into `list` (-1: clear), and
// whether the pixel's four neighbours are in its area too.
function regionsOf(lab, opaque, owner, depth, w, h, s) {
    const labels = fineAreas(lab, opaque, w, h, 1 / (s * s));
    const n = w * h;
    const region = new Int32Array(n).fill(-1);
    const keys = new Map();
    const list = [];
    for (let i = 0; i < n; i++) {
        if (labels[i] < 0)
            continue;
        const key = `${labels[i]}/${owner[i]}`;
        let j = keys.get(key);
        if (j === undefined) {
            j = list.length;
            keys.set(key, j);
            list.push({
                owner: owner[i], count: 0, interior: 0, color: [0, 0, 0], band: 0, ground: false, strength: 0, contrast: 0,
                decided: false, fades: false, edge: false
            });
        }
        region[i] = j;
    }
    const inner = new Uint8Array(n);
    const pixels = list.map(() => []), inside = list.map(() => []);
    for (let i = 0; i < n; i++) {
        const j = region[i];
        if (j < 0)
            continue;
        const r = list[j];
        const x = i % w, y = (i - x) / w;
        r.count++;
        pixels[j].push(i);
        if (r.owner >= 0 && -depth[i] * s < BAND)
            r.band++;
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && region[i - 1] === j && region[i + 1] === j && region[i - w] === j &&
            region[i + w] === j) {
            inner[i] = 1;
            r.interior++;
            inside[j].push(i);
        }
    }
    list.forEach((r, j) => {
        const from = inside[j].length ? inside[j] : pixels[j];
        const middle = from.sort((a, b) => lab[a * 3] - lab[b * 3])[Math.floor(from.length / 2)];
        r.color = Array.from(lab.subarray(middle * 3, middle * 3 + 3));
    });
    return { region, inner, list };
}

// Per pixel `wanted`, the means of `channels` values (the last a weight, 0 or 1) around it, with that weight last
// (0 where there is none): the squares of the given radii, each its weight's density, laid over one another, which
// makes a kernel that falls off smoothly with distance, so that the means do not jump where the nearest values do.
function localMeans(values, wanted, w, h, channels, radii) {
    const W = w + 1;
    const table = new Float64Array(W * (h + 1) * channels);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            for (let c = 0; c < channels; c++) {
                table[((y + 1) * W + x + 1) * channels + c] = values[(y * w + x) * channels + c] +
                    table[(y * W + x + 1) * channels + c] + table[((y + 1) * W + x) * channels + c] - table[(y * W + x) * channels + c];
            }
        }
    }
    const sum = (x1, y1, x2, y2, c) => table[(y2 * W + x2) * channels + c] -
        table[(y1 * W + x2) * channels + c] - table[(y2 * W + x1) * channels + c] + table[(y1 * W + x1) * channels + c];
    const out = new Float32Array(w * h * channels);
    const weight = channels - 1;
    const totals = new Float64Array(channels);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!wanted[y * w + x])
                continue;
            totals.fill(0);
            for (const r of radii) {
                const x1 = Math.max(x - r, 0), y1 = Math.max(y - r, 0), x2 = Math.min(x + r + 1, w), y2 = Math.min(y + r + 1, h);
                const area = (x2 - x1) * (y2 - y1);
                for (let c = 0; c < channels; c++)
                    totals[c] += sum(x1, y1, x2, y2, c) / area;
            }
            if (!totals[weight])
                continue;
            const at = (y * w + x) * channels;
            for (let c = 0; c < weight; c++)
                out[at + c] = totals[c] / totals[weight];
            out[at + weight] = totals[weight];
        }
    }
    return out;
}

// How strongly each color of the symbol is drawn, 1 - DETAIL_DIM to 1 (null: all fully). The symbol's large areas are put together
// into up to TONE_GROUPS colors (the largest), which are given the strengths, out of TONE_LEVELS steps, that best
// keep apart the colors that meet (`edges`: two colors and the length of their edge), the more so the more they
// differ (TONE_FULL of Oklab apart, or more, TONE_SEEN apart in strength, which is told apart at a glance): red next
// to green stays apart from it even at one lightness. Of two colors TONE_ORDER or more apart in lightness the lighter
// is never the weaker; other things equal, lighter is stronger, and a color that meets none of the others is drawn
// at full strength. A color between two of them is drawn in between.
function symbolTone(parts, edges) {
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const groups = [];
    for (const r of [...parts].sort((a, b) => b.count - a.count)) {
        const near = groups.find(g => distance(g.color, r.color) < PIECE_APART);
        if (near) {
            near.color = near.color.map((v, c) => (v * near.count + r.color[c] * r.count) / (near.count + r.count));
            near.count += r.count;
        }
        else {
            groups.push({ color: [...r.color], count: r.count });
        }
    }
    groups.sort((a, b) => b.count - a.count);
    const kept = groups.slice(0, TONE_GROUPS);
    if (kept.length < 2)
        return null;
    const nearest = (c) => {
        let best = 0;
        kept.forEach((g, k) => {
            if (distance(g.color, c) < distance(kept[best].color, c))
                best = k;
        });
        return best;
    };
    // How long each two groups meet.
    const meet = new Map();
    for (const [a, b, length] of edges) {
        const p = nearest(a), q = nearest(b);
        if (p === q)
            continue;
        const key = Math.min(p, q) * TONE_GROUPS + Math.max(p, q);
        meet.set(key, (meet.get(key) ?? 0) + length);
    }
    const pairs = [...meet].map(([key, length]) => {
        const p = Math.floor(key / TONE_GROUPS), q = key % TONE_GROUPS;
        const apart = distance(kept[p].color, kept[q].color);
        return {
            p, q, weight: Math.sqrt(length), want: TONE_SEEN * Math.min(apart / TONE_FULL, 1),
            lighter: Math.sign(kept[p].color[0] - kept[q].color[0])
        };
    });
    if (!pairs.length)
        return null;
    const levels = Array.from({ length: TONE_LEVELS }, (_, k) => 1 - DETAIL_DIM * k / (TONE_LEVELS - 1));
    // Of two colors clearly apart in lightness, the lighter is never the weaker.
    const order = [];
    kept.forEach((a, p) => kept.forEach((b, q) => {
        if (a.color[0] - b.color[0] >= TONE_ORDER)
            order.push([p, q]);
    }));
    const scoreOf = (strength) => {
        if (order.some(([p, q]) => strength[p] < strength[q]))
            return -Infinity;
        let score = 0;
        for (const { p, q, weight, want, lighter } of pairs) {
            const step = strength[p] - strength[q];
            score += weight * (Math.min(Math.abs(step) / want, 1) + 0.01 * lighter * Math.sign(step));
        }
        return score;
    };
    // Each group in turn moved to the step that does best, until none moves, from all at full strength and from strengths
    // spread by lightness either way.
    const lightness = kept.map(g => g.color[0]);
    const lo = Math.min(...lightness), hi = Math.max(...lightness);
    const spread = (k) => Math.round((hi - lightness[k]) / Math.max(hi - lo, 1e-6) * (TONE_LEVELS - 1));
    let best = kept.map(() => 1), bestScore = -Infinity;
    for (const start of [kept.map(() => 0), kept.map((_, k) => spread(k)), kept.map((_, k) => Math.round(spread(k) / 2))]) {
        const steps = start.slice();
        let score = scoreOf(steps.map(k => levels[k]));
        for (let moved = true; moved;) {
            moved = false;
            for (let k = 0; k < kept.length; k++) {
                for (let level = 0; level < TONE_LEVELS; level++) {
                    if (level === steps[k])
                        continue;
                    const tried = steps.slice();
                    tried[k] = level;
                    const value = scoreOf(tried.map(t => levels[t]));
                    if (value > score + 1e-9) {
                        steps[k] = level;
                        score = value;
                        moved = true;
                    }
                }
            }
        }
        if (score > bestScore + 1e-9) {
            best = steps.map(t => levels[t]);
            bestScore = score;
        }
    }
    // Colors a little apart are drawn alike; most pixels share their area's color.
    const known = new Map();
    return c => {
        const key = Math.round(c[0] * 200) * 160000 + Math.round(c[1] * 200 + 200) * 400 + Math.round(c[2] * 200 + 200);
        const cached = known.get(key);
        if (cached !== undefined)
            return cached;
        const a = nearest(c);
        let b = -1;
        kept.forEach((g, k) => {
            if (k !== a && (b < 0 || distance(g.color, c) < distance(kept[b].color, c)))
                b = k;
        });
        const ab = kept[b].color.map((v, i) => v - kept[a].color[i]);
        const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        const u = Math.min(Math.max(((c[0] - kept[a].color[0]) * ab[0] + (c[1] - kept[a].color[1]) * ab[1] +
            (c[2] - kept[a].color[2]) * ab[2]) / Math.max(len2, 1e-9), 0), 0.5);
        const value = best[a] + (best[b] - best[a]) * u;
        known.set(key, value);
        return value;
    };
}
