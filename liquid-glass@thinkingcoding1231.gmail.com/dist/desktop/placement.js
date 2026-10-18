// Where an item on the desktop goes: a corner or the center of the primary
// monitor's work area, or where the user moved it, kept as the fraction of
// the work area its center is at so it survives a resolution change.
export const ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
// Room between an item and the edge of the work area, and between items.
export const EDGE_MARGIN = 32;
export const ITEM_GAP = 16;

export function sanitizeAnchor(value, fallback = 'top-right') {
    return ANCHORS.includes(value) ? value : fallback;
}

/**
 * Stacks items of the given sizes at `anchor` of `area`, the first nearest
 * the edge (or on top, at the center). Returns each item's top left corner.
 */
export function stackAt(anchor, area, sizes) {
    const total = sizes.reduce((sum, [, h]) => sum + h, 0) + ITEM_GAP * Math.max(sizes.length - 1, 0);
    const bottom = anchor === 'bottom-left' || anchor === 'bottom-right';
    let y = anchor === 'center'
        ? area.y + (area.height - total) / 2
        : bottom ? area.y + area.height - EDGE_MARGIN - total : area.y + EDGE_MARGIN;
    // Bottom stacks keep their first item nearest the edge.
    const order = bottom ? [...sizes.keys()].reverse() : [...sizes.keys()];
    const out = Array.from({ length: sizes.length }, () => [0, 0]);
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
export function placeAtFraction(fraction, area, size) {
    const [w, h] = size;
    const x = area.x + fraction[0] * area.width - w / 2;
    const y = area.y + fraction[1] * area.height - h / 2;
    return [
        Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(area.width - w, 0))),
        Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(area.height - h, 0))),
    ];
}

/** The fraction of `area` the center of an item at `pos` of `size` is at. */
export function fractionOf(pos, area, size) {
    const fx = (pos[0] + size[0] / 2 - area.x) / Math.max(area.width, 1);
    const fy = (pos[1] + size[1] / 2 - area.y) / Math.max(area.height, 1);
    return [Math.min(Math.max(fx, 0), 1), Math.min(Math.max(fy, 0), 1)];
}

/** `rect` with the edges a handle holds moved by (dx, dy), at least `min` px each way. */
export function resizeRect(rect, hx, hy, dx, dy, min) {
    const out = { ...rect };
    if (hx > 0)
        out.width = Math.max(rect.width + dx, min);
    if (hx < 0) {
        out.width = Math.max(rect.width - dx, min);
        out.x = rect.x + rect.width - out.width;
    }
    if (hy > 0)
        out.height = Math.max(rect.height + dy, min);
    if (hy < 0) {
        out.height = Math.max(rect.height - dy, min);
        out.y = rect.y + rect.height - out.height;
    }
    return out;
}

// The positions the user moved items to, by item id, as stored in the
// `desktop-item-positions` setting. Anything unreadable counts as none.
export function parsePositions(json) {
    let parsed;
    try {
        parsed = JSON.parse(json || '{}');
    }
    catch {
        return {};
    }
    const out = {};
    if (!parsed || typeof parsed !== 'object')
        return out;
    for (const [id, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && (value.length === 2 || value.length === 3) &&
            value.every(v => typeof v === 'number' && Number.isFinite(v)))
            out[id] = value.length === 2 ? [value[0], value[1]] : [value[0], value[1], value[2]];
    }
    return out;
}

/** The JSON of desktop-widget-anchors as id → anchor, skipping anything that is not one. */
export function parseAnchors(json) {
    let parsed;
    try {
        parsed = JSON.parse(json || '{}');
    }
    catch {
        return {};
    }
    const out = {};
    if (!parsed || typeof parsed !== 'object')
        return out;
    for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && ANCHORS.includes(value))
            out[id] = value;
    }
    return out;
}

function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The top left corner of a button of `size` beside `frame`, `gap` px off it:
 * below, above, right or left of it, whichever comes first that is inside
 * `area` and clear of `obstacles`. Kept inside `area` when none is.
 */
export function placeBeside(frame, size, gap, area, obstacles) {
    const [w, h] = size;
    const clamp = (v, lo, span) => Math.min(Math.max(v, lo), lo + Math.max(span, 0));
    const cx = clamp(frame.x + (frame.width - w) / 2, area.x, area.width - w);
    const cy = clamp(frame.y + (frame.height - h) / 2, area.y, area.height - h);
    const candidates = [
        [cx, frame.y + frame.height + gap],
        [cx, frame.y - gap - h],
        [frame.x + frame.width + gap, cy],
        [frame.x - gap - w, cy],
    ];
    const fits = ([x, y]) => {
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

function shareColumn(a, b) {
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
export function stackColumns(items, area) {
    const order = items.map((_, i) => i).sort((a, b) => items[a].saved.y - items[b].saved.y);
    const columns = [];
    for (const i of order) {
        const r = items[i].saved;
        let best = null;
        for (const column of columns) {
            const last = items[column[column.length - 1]].saved;
            if (!shareColumn(last, r) || r.y - (last.y + last.height) > COLUMN_GAP)
                continue;
            if (!best || last.y > items[best[best.length - 1]].saved.y)
                best = column;
        }
        if (best)
            best.push(i);
        else
            columns.push([i]);
    }
    const out = Array.from({ length: items.length });
    for (const column of columns) {
        const shown = column.filter(i => items[i].shown);
        for (const i of column)
            out[i] = [Math.round(items[i].saved.x), Math.round(items[i].saved.y)];
        if (shown.length === 0)
            continue;
        const total = shown.reduce((sum, i) => sum + items[i].size[1], 0) + ITEM_GAP * (shown.length - 1);
        let y = Math.max(Math.min(items[shown[0]].saved.y, area.y + area.height - total), area.y);
        for (const i of shown) {
            out[i][1] = Math.round(y);
            y += items[i].size[1] + ITEM_GAP;
        }
    }
    return out;
}
