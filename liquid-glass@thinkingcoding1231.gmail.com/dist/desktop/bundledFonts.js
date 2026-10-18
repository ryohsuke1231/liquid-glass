"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUNDLED_FAMILIES = void 0;
exports.bundledFontFile = bundledFontFile;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Pango"));
// The families in fonts/, and the file names their weights are kept under.
exports.BUNDLED_FAMILIES = {
    'Antonio': 'Antonio',
    'Barlow Condensed': 'BarlowCondensed',
    'Saira Extra Condensed': 'SairaExtraCondensed',
    'Sofia Sans Extra Condensed': 'SofiaSansExtraCondensed',
};
const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [600, 'SemiBold'], [700, 'Bold']];
/**
 * The file in `extensionPath`/fonts for a font description such as
 * "Antonio SemiBold" (the nearest weight it has), or null when the extension
 * does not ship that family.
 */

function bundledFontFile(extensionPath, description) {
    // By name, not through Pango, which reads "Condensed" as a width and keeps
    // only "Barlow" of "Barlow Condensed".
    const family = Object.keys(exports.BUNDLED_FAMILIES)
        .find(name => description === name || description.startsWith(`${name} `));
    if (!family)
        return null;
    const file = exports.BUNDLED_FAMILIES[family];
    const weight = 2.default.FontDescription.from_string(`Sans${description.slice(family.length)}`).get_weight();
    const [, name] = WEIGHTS.reduce((best, w) => Math.abs(w[0] - weight) < Math.abs(best[0] - weight) ? w : best);
    return 1.default.build_filenamev([extensionPath, 'fonts', `${file}-${name}.ttf`]);
}
