// Outlines from a TrueType font file, for the fonts the extension ships with.
// Pango finds fonts through fontconfig only; adding a file to it needs Pango
// 1.56, newer than GNOME 46 and 47 have. Only what drawing a line of digits
// needs is read: the glyph outlines, their advances and the line's metrics.
export class TrueTypeFont {
    unitsPerEm;
    ascender;
    descender;
    _view;
    _tables = new Map();
    _longLoca;
    _numGlyphs;
    _hMetrics;
    _cmap = new Map();
    _glyphs = new Map();

    constructor(bytes) {
        this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const v = this._view;
        const count = v.getUint16(4);
        for (let i = 0; i < count; i++) {
            const record = 12 + i * 16;
            const tag = String.fromCharCode(v.getUint8(record), v.getUint8(record + 1), v.getUint8(record + 2), v.getUint8(record + 3));
            this._tables.set(tag, v.getUint32(record + 8));
        }
        for (const tag of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf']) {
            if (!this._tables.has(tag))
                throw new Error(`not a TrueType outline font (no ${tag} table)`);
        }
        const head = this._table('head');
        this.unitsPerEm = v.getUint16(head + 18);
        this._longLoca = v.getInt16(head + 50) === 1;
        const hhea = this._table('hhea');
        this.ascender = v.getInt16(hhea + 4);
        this.descender = v.getInt16(hhea + 6);
        this._hMetrics = v.getUint16(hhea + 34);
        this._numGlyphs = v.getUint16(this._table('maxp') + 4);
        this._readCmap();
    }

    _table(tag) {
        return this._tables.get(tag);
    }

    // The Unicode subtable: format 4 (BMP) or 12 (full range).
    _readCmap() {
        const v = this._view;
        const cmap = this._table('cmap');
        let best = -1, bestFormat = 0;
        for (let i = 0; i < v.getUint16(cmap + 2); i++) {
            const record = cmap + 4 + i * 8;
            const platform = v.getUint16(record), encoding = v.getUint16(record + 2);
            const offset = cmap + v.getUint32(record + 4);
            const format = v.getUint16(offset);
            const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
            if (unicode && (format === 12 || (format === 4 && bestFormat !== 12))) {
                best = offset;
                bestFormat = format;
            }
        }
        if (best < 0)
            throw new Error('the font has no Unicode character map');
        if (bestFormat === 4) {
            const segments = v.getUint16(best + 6) / 2;
            const ends = best + 14, starts = ends + segments * 2 + 2;
            const deltas = starts + segments * 2, ranges = deltas + segments * 2;
            for (let s = 0; s < segments; s++) {
                const end = v.getUint16(ends + s * 2), start = v.getUint16(starts + s * 2);
                const delta = v.getInt16(deltas + s * 2), range = v.getUint16(ranges + s * 2);
                for (let c = start; c <= end && c !== 0xffff; c++) {
                    let glyph;
                    if (range === 0) {
                        glyph = (c + delta) & 0xffff;
                    }
                    else {
                        const at = ranges + s * 2 + range + (c - start) * 2;
                        glyph = v.getUint16(at);
                        if (glyph !== 0)
                            glyph = (glyph + delta) & 0xffff;
                    }
                    if (glyph !== 0)
                        this._cmap.set(c, glyph);
                }
            }
        }
        else {
            const groups = v.getUint32(best + 12);
            for (let g = 0; g < groups; g++) {
                const group = best + 16 + g * 12;
                const start = v.getUint32(group), end = v.getUint32(group + 4), first = v.getUint32(group + 8);
                for (let c = start; c <= end; c++)
                    this._cmap.set(c, first + c - start);
            }
        }
    }

    _advance(id) {
        const index = Math.min(id, this._hMetrics - 1);
        return this._view.getUint16(this._table('hmtx') + index * 4);
    }

    _glyphRange(id) {
        const v = this._view;
        const loca = this._table('loca');
        const at = (i) => this._longLoca ? v.getUint32(loca + i * 4) : v.getUint16(loca + i * 2) * 2;
        return [at(id), at(id + 1)];
    }

    /** The glyph for code point `c`, or for the missing glyph. */
    glyph(c) {
        return this._glyphById(this._cmap.get(c) ?? 0, 0);
    }

    _glyphById(id, depth) {
        let glyph = this._glyphs.get(id);
        if (glyph)
            return glyph;
        glyph = { advance: this._advance(id), contours: [], xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
        const [start, end] = this._glyphRange(Math.min(id, this._numGlyphs - 1));
        if (end > start) {
            const v = this._view;
            const offset = this._table('glyf') + start;
            const contours = v.getInt16(offset);
            glyph.xMin = v.getInt16(offset + 2);
            glyph.yMin = v.getInt16(offset + 4);
            glyph.xMax = v.getInt16(offset + 6);
            glyph.yMax = v.getInt16(offset + 8);
            glyph.contours = contours >= 0 ? this._simple(offset, contours) : this._composite(offset, depth);
        }
        this._glyphs.set(id, glyph);
        return glyph;
    }

    _simple(offset, count) {
        const v = this._view;
        const ends = [];
        for (let i = 0; i < count; i++)
            ends.push(v.getUint16(offset + 10 + i * 2));
        const points = count ? ends[count - 1] + 1 : 0;
        let p = offset + 10 + count * 2;
        p += 2 + v.getUint16(p);
        const flags = [];
        while (flags.length < points) {
            const flag = v.getUint8(p++);
            flags.push(flag);
            if (flag & 8) {
                for (let r = v.getUint8(p++); r > 0; r--)
                    flags.push(flag);
            }
        }
        const coords = (short, same) => {
            const out = [];
            let value = 0;
            for (const flag of flags) {
                if (flag & short) {
                    const d = v.getUint8(p++);
                    value += flag & same ? d : -d;
                }
                else if (!(flag & same)) {
                    value += v.getInt16(p);
                    p += 2;
                }
                out.push(value);
            }
            return out;
        };
        const xs = coords(2, 16);
        const ys = coords(4, 32);
        const contours = [];
        let first = 0;
        for (const last of ends) {
            const contour = [];
            for (let i = first; i <= last; i++)
                contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
            contours.push(contour);
            first = last + 1;
        }
        return contours;
    }

    _composite(offset, depth) {
        const v = this._view;
        const contours = [];
        let p = offset + 10;
        for (;;) {
            const flags = v.getUint16(p);
            const id = v.getUint16(p + 2);
            p += 4;
            let dx, dy;
            if (flags & 1) {
                dx = v.getInt16(p);
                dy = v.getInt16(p + 2);
                p += 4;
            }
            else {
                dx = v.getInt8(p);
                dy = v.getInt8(p + 1);
                p += 2;
            }
            let [a, b, c, d] = [1, 0, 0, 1];
            const f2dot14 = (at) => v.getInt16(at) / 16384;
            if (flags & 8) {
                a = d = f2dot14(p);
                p += 2;
            }
            else if (flags & 0x40) {
                a = f2dot14(p);
                d = f2dot14(p + 2);
                p += 4;
            }
            else if (flags & 0x80) {
                [a, b, c, d] = [f2dot14(p), f2dot14(p + 2), f2dot14(p + 4), f2dot14(p + 6)];
                p += 8;
            }
            // Components placed by matching points instead of an offset are rare
            // in digits; they are placed without one.
            if (!(flags & 2))
                dx = dy = 0;
            if (depth < 8) {
                for (const contour of this._glyphById(id, depth + 1).contours)
                    contours.push(contour.map(q => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
            }
            if (!(flags & 0x20))
                break;
        }
        return contours;
    }
}

/**
 * Traces `glyph` on Cairo context `cr` with its origin at (x, y) and `scale`
 * px per font unit, y down.
 */
export function traceGlyph(cr, glyph, x, y, scale) {
    const at = (q) => [x + q.x * scale, y - q.y * scale];
    for (const contour of glyph.contours) {
        const n = contour.length;
        if (n === 0)
            continue;
        // Start on an on-curve point, or between two off-curve ones.
        const startIndex = contour.findIndex(q => q.on);
        const start = startIndex >= 0 ? contour[startIndex]
            : { x: (contour[0].x + contour[1 % n].x) / 2, y: (contour[0].y + contour[1 % n].y) / 2, on: true };
        const first = startIndex >= 0 ? startIndex : 0;
        let [px, py] = at(start);
        cr.moveTo(px, py);
        let control = null;
        const quadTo = (cx, cy, ex, ey) => {
            cr.curveTo(px + (cx - px) * 2 / 3, py + (cy - py) * 2 / 3, ex + (cx - ex) * 2 / 3, ey + (cy - ey) * 2 / 3, ex, ey);
            [px, py] = [ex, ey];
        };
        for (let k = 1; k <= n; k++) {
            const q = k === n && startIndex >= 0 ? start : contour[(first + k) % n];
            const [qx, qy] = at(q);
            if (q.on) {
                if (control)
                    quadTo(control[0], control[1], qx, qy);
                else {
                    cr.lineTo(qx, qy);
                    [px, py] = [qx, qy];
                }
                control = null;
            }
            else if (control) {
                const mx = (control[0] + qx) / 2, my = (control[1] + qy) / 2;
                quadTo(control[0], control[1], mx, my);
                control = [qx, qy];
            }
            else {
                control = [qx, qy];
            }
        }
        if (control) {
            const [sx, sy] = at(start);
            quadTo(control[0], control[1], sx, sy);
        }
        cr.closePath();
    }
}
