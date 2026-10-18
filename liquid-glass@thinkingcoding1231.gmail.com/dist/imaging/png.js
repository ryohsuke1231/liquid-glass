// PNG in and out for pixels GJS cannot read or write otherwise: a Cairo
// surface's pixels and a texture's are out of reach, so images go through PNG
// files. Only what Cairo writes is read (8 bits a channel, not interlaced).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function readU32(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function convert(data, converter) {
    const input = new Gio.ConverterInputStream({
        base_stream: Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(data)),
        converter,
    });
    const output = Gio.MemoryOutputStream.new_resizable();
    output.splice(input, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, null);
    return output.steal_as_bytes().toArray();
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png) {
    let pos = 8;
    let width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
    const chunks = [];
    while (pos + 8 <= png.length) {
        const length = readU32(png, pos);
        const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
        const body = png.subarray(pos + 8, pos + 8 + length);
        if (type === 'IHDR') {
            width = readU32(body, 0);
            height = readU32(body, 4);
            depth = body[8];
            colorType = body[9];
            interlace = body[12];
        }
        else if (type === 'IDAT') {
            chunks.push(body);
        }
        else if (type === 'IEND') {
            break;
        }
        pos += 12 + length;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    if (depth !== 8 || interlace !== 0 || !channels || !width || !height)
        throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
    const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
        joined.set(c, offset);
        offset += c.length;
    }
    const raw = convert(joined, new Gio.ZlibDecompressor({ format: Gio.ZlibCompressorFormat.ZLIB }));
    const stride = width * channels;
    const data = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? data[dst + x - channels] : 0;
            const b = y > 0 ? data[dst - stride + x] : 0;
            const c = x >= channels && y > 0 ? data[dst - stride + x - channels] : 0;
            const v = raw[src + x];
            data[dst + x] = (filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1)
                : filter === 4 ? v + paeth(a, b, c) : v) & 255;
        }
    }
    return { width, height, channels, data };
}

/** Unpremultiplied RGBA, 4 bytes a pixel, whatever the PNG holds. */
export function decodePngRgba(png) {
    const { width, height, channels, data } = decodePng(png);
    if (channels === 4)
        return { width, height, data };
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels;
        const grey = channels <= 2;
        rgba[i * 4] = data[s];
        rgba[i * 4 + 1] = grey ? data[s] : data[s + 1];
        rgba[i * 4 + 2] = grey ? data[s] : data[s + 2];
        rgba[i * 4 + 3] = channels === 2 ? data[s + 1] : 255;
    }
    return { width, height, data: rgba };
}

let crcTable = null;

function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const b of bytes)
        c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++)
        out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
}

/** An 8-bit RGBA PNG of unpremultiplied pixels. */
export function encodePngRgba(width, height, rgba) {
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header.set([8, 6, 0, 0, 0], 8);
    const stride = width * 4;
    const raw = new Uint8Array((stride + 1) * height);
    for (let y = 0; y < height; y++)
        raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const compressed = convert(raw, new Gio.ZlibCompressor({ format: Gio.ZlibCompressorFormat.ZLIB }));
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed),
        chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
