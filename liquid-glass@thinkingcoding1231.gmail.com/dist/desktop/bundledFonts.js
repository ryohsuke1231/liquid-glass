import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
// The families in fonts/, and the file names their weights are kept under.
export const BUNDLED_FAMILIES = {
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
export function bundledFontFile(extensionPath, description) {
    // By name, not through Pango, which reads "Condensed" as a width and keeps
    // only "Barlow" of "Barlow Condensed".
    const family = Object.keys(BUNDLED_FAMILIES)
        .find(name => description === name || description.startsWith(`${name} `));
    if (!family)
        return null;
    const file = BUNDLED_FAMILIES[family];
    const weight = Pango.FontDescription.from_string(`Sans${description.slice(family.length)}`).get_weight();
    const [, name] = WEIGHTS.reduce((best, w) => Math.abs(w[0] - weight) < Math.abs(best[0] - weight) ? w : best);
    return GLib.build_filenamev([extensionPath, 'fonts', `${file}-${name}.ttf`]);
}
