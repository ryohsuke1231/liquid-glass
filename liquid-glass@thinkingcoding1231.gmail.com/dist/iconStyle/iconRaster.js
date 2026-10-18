"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.drawIcon = drawIcon;
// Draws an icon file at a given size into unpremultiplied RGBA, for the icon
// worker (iconWorker.ts) and the contact sheet's collector. SVGs go through
// librsvg and PNGs through Cairo; anything else through GdkPixbuf, whose
// loaders may start a sandboxed process of their own.
const cairo_1 = __importDefault(require("cairo"));
const 2 = __importDefault(require("gi://GdkPixbuf"));
const 3 = __importDefault(require("gi://GLib"));
const png_js_1 = require("../imaging/png.js");
let rsvg = null;
// Imported on first use, so that a system without its typelib can still draw PNGs.
async function librsvg() {
    const name = 'gi://Rsvg?version=2.0';
    rsvg ??= (await import(name)).default;
    return rsvg;
}
// Cairo keeps its pixels premultiplied and cannot hand them over; its PNG writer unpremultiplies them.

function pixelsOf(surface) {
    const [fd, path] = 3.default.file_open_tmp('liquid-glass-icon-XXXXXX.png');
    3.default.close(fd);
    try {
        surface.writeToPNG(path);
        surface.finish();
        return (0, png_js_1.decodePngRgba)(3.default.file_get_contents(path)[1]);
    }
    finally {
        3.default.unlink(path);
    }
}

function fromPixbuf(pixbuf, size) {
    const scaled = pixbuf.scale_simple(size, size, 2.default.InterpType.HYPER).add_alpha(false, 0, 0, 0);
    const stride = scaled.get_rowstride();
    const bytes = scaled.get_pixels();
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++)
        data.set(bytes.subarray(y * stride, y * stride + size * 4), y * size * 4);
    return { width: size, height: size, data };
}
/** Throws a GError when the file cannot be read or drawn. */
async function drawIcon(path, size) {
    const svg = /\.svgz?$/i.test(path);
    if (!svg && !/\.png$/i.test(path))
        return fromPixbuf(2.default.Pixbuf.new_from_file(path), size);
    const Rsvg = svg ? await librsvg() : null;
    const surface = new cairo_1.default.ImageSurface(cairo_1.default.Format.ARGB32, size, size);
    const cr = new cairo_1.default.Context(surface);
    try {
        if (Rsvg) {
            Rsvg.Handle.new_from_file(path).render_document(cr, new Rsvg.Rectangle({ x: 0, y: 0, width: size, height: size }));
        }
        else {
            const image = cairo_1.default.ImageSurface.createFromPNG(path);
            const fit = size / Math.max(image.getWidth(), image.getHeight());
            cr.translate((size - image.getWidth() * fit) / 2, (size - image.getHeight() * fit) / 2);
            cr.scale(fit, fit);
            cr.setSourceSurface(image, 0, 0);
            cr.getSource().setFilter(cairo_1.default.Filter.GOOD);
            cr.paint();
        }
    }
    finally {
        cr.$dispose();
    }
    return pixelsOf(surface);
}
