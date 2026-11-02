// PNG in and out for pixels GJS cannot read or write otherwise: a Cairo
// surface's pixels and a texture's are out of reach, so images go through PNG
// files. Only what Cairo writes is read (8 bits a channel, not interlaced).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';

import type { IconPixels } from './iconStyle/iconAnalysis.js';

export interface DecodedPng {
  width: number;
  height: number;
  // 1 (grey), 2 (grey, alpha), 3 (RGB) or 4 (RGBA)
  channels: number;
  data: Uint8Array;
}

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function convert(data: Uint8Array, converter: Gio.Converter): Uint8Array {
  const input = new Gio.ConverterInputStream({
    base_stream: Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(data)),
    converter,
  });
  const output = Gio.MemoryOutputStream.new_resizable();
  output.splice(input, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET, null);
  return output.steal_as_bytes().toArray();
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Uint8Array): DecodedPng {
  let pos = 8;
  let width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const chunks: Uint8Array[] = [];
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
    } else if (type === 'IDAT') {
      chunks.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
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
export function decodePngRgba(png: Uint8Array): { width: number, height: number, data: Uint8Array } {
  const { width, height, channels, data } = decodePng(png);
  if (channels === 4) return { width, height, data };
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

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** An 8-bit RGBA PNG of unpremultiplied pixels. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
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

// Draws an icon file at a given size into unpremultiplied RGBA, for the icon
// worker (iconWorker.ts) and the contact sheet's collector. SVGs go through
// librsvg and PNGs through Cairo; anything else through GdkPixbuf, whose
// loaders may start a sandboxed process of their own.

let rsvg: any = null;

// Imported on first use, so that a system without its typelib can still draw PNGs.
async function librsvg(): Promise<any> {
  const name = 'gi://Rsvg?version=2.0';
  rsvg ??= (await import(name)).default;
  return rsvg;
}

// Cairo keeps its pixels premultiplied and cannot hand them over; its PNG writer unpremultiplies them.
function pixelsOf(surface: Cairo.ImageSurface): IconPixels {
  const [fd, path] = GLib.file_open_tmp('liquid-glass-icon-XXXXXX.png');
  GLib.close(fd);
  try {
    surface.writeToPNG(path);
    surface.finish();
    return decodePngRgba(GLib.file_get_contents(path)[1]);
  } finally {
    GLib.unlink(path);
  }
}

function fromPixbuf(pixbuf: GdkPixbuf.Pixbuf, size: number): IconPixels {
  const scaled = pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER)!.add_alpha(false, 0, 0, 0)!;
  const stride = scaled.get_rowstride();
  const bytes = scaled.get_pixels();
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) data.set(bytes.subarray(y * stride, y * stride + size * 4), y * size * 4);
  return { width: size, height: size, data };
}

/** Throws a GError when the file cannot be read or drawn. */
export async function drawIcon(path: string, size: number): Promise<IconPixels> {
  const svg = /\.svgz?$/i.test(path);
  if (!svg && !/\.png$/i.test(path)) return fromPixbuf(GdkPixbuf.Pixbuf.new_from_file(path), size);
  const Rsvg = svg ? await librsvg() : null;
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, size, size);
  const cr = new Cairo.Context(surface);
  try {
    if (Rsvg) {
      Rsvg.Handle.new_from_file(path).render_document(cr, new Rsvg.Rectangle({ x: 0, y: 0, width: size, height: size }));
    } else {
      const image = Cairo.ImageSurface.createFromPNG(path) as Cairo.ImageSurface;
      const fit = size / Math.max(image.getWidth(), image.getHeight());
      cr.translate((size - image.getWidth() * fit) / 2, (size - image.getHeight() * fit) / 2);
      cr.scale(fit, fit);
      cr.setSourceSurface(image, 0, 0);
      (cr.getSource() as any).setFilter(Cairo.Filter.GOOD);
      cr.paint();
    }
  } finally {
    cr.$dispose();
  }
  return pixelsOf(surface);
}
