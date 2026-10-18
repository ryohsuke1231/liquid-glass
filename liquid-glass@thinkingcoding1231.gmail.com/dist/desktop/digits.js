"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DigitsMaker = exports.FIELD_RANGE = void 0;
// The glass clock's digits for one time, as the pixels of the texture
// glass.frag's LG_SHAPE_TEXTURE reads (see glassText.ts). Made in a process
// of their own (digitsWorker.ts), or in the shell where that cannot start.
const 2 = __importDefault(require("gi://Gio"));
const bundledFonts_js_1 = require("./bundledFonts.js");
const glassText_js_1 = require("./glassText.js");
const trueType_js_1 = require("./trueType.js");
// How far (px) the distance field reaches past the outline: room for the
// drop shadow, whose reach stays a little inside it.
exports.FIELD_RANGE = 48;
// The lens rises over at most this much of a stroke (px), as on any glass.
const MAX_BAND = 22;
// The lens's slope points the way of the outline softened by this fraction of
// its band, so it turns smoothly in a corner instead of folding along the
// corner's bisector.
const LENS_SOFTNESS = 0.35;

function fontKey(r) {
    return `${r.font}|${r.size}|${r.stretch}|${r.height}|${r.style}`;
}
/** Makes digits, keeping the glyphs of the last font asked for. */

class DigitsMaker {
    _key = '';
    _fields = null;
    _cancellable = new 2.default.Cancellable();
    /** Rejects with a GError when the font cannot be read or the request was given up. */
    async make(request) {
        const key = fontKey(request);
        if (key !== this._key || !this._fields) {
            this._fields?.then(old => old.cancellable.cancel(), () => { });
            this._key = key;
            this._fields = this._face(request).then(face => new glassText_js_1.GlyphFields(face, exports.FIELD_RANGE, request.stretch, request.height, request.style));
            this._fields.catch(() => {
                if (this._key === key)
                    this._fields = null;
            });
        }
        const fields = await this._fields;
        const field = await fields.fieldFor(request.text);
        const band = Math.min(Math.max((0, glassText_js_1.maxDepth)(field), 2), MAX_BAND);
        const lens = await (0, glassText_js_1.softenedInSteps)(field, band * LENS_SOFTNESS, () => fields.pause());
        await fields.pause();
        return { bytes: (0, glassText_js_1.encodeFields)(field, lens, exports.FIELD_RANGE), width: field.width, height: field.height, band,
            digitHeight: fields.digitHeight };
    }
    // One of the fonts the extension ships with, or an installed one.
    async _face(request) {
        const file = (0, bundledFonts_js_1.bundledFontFile)(request.extensionPath, request.font);
        if (!file)
            return (0, glassText_js_1.pangoFace)(request.font, request.size);
        const gfile = 2.default.File.new_for_path(file);
        const bytes = await new Promise((resolve, reject) => {
            gfile.load_contents_async(this._cancellable, (_f, res) => {
                try {
                    resolve(gfile.load_contents_finish(res)[1]);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        return (0, glassText_js_1.fileFace)(new trueType_js_1.TrueTypeFont(bytes), request.size);
    }
    destroy() {
        this._cancellable.cancel();
        this._fields?.then(fields => fields.cancellable.cancel(), () => { });
        this._fields = null;
    }
}
exports.DigitsMaker = DigitsMaker;
