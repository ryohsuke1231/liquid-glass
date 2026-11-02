// Draws every installed application's icon in one icon theme at 128 px, takes
// it apart with the extension's icon analysis and writes the results as JSON.
// Run through run.sh, which sets up St outside the shell and picks the theme
// without touching the user's settings (GSETTINGS_BACKEND=memory).
//
//   gjs -m collect.js <theme> <out.json> [id substring...]
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {analyzeIcon, oklabToSrgb, plateColor, shapeDistance} from '../../liquid-glass@thinkingcoding1231.gmail.com/dist/iconStyle/iconAnalysis.js';
import {drawIcon, encodePngRgba} from '../../liquid-glass@thinkingcoding1231.gmail.com/dist/imaging.js';
import {buildStyleMap} from '../../liquid-glass@thinkingcoding1231.gmail.com/dist/iconStyle/styleMap.js';

const SIZE = 128;
const [theme, outPath] = ARGV;

new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).set_string('icon-theme', theme);
const iconTheme = new St.IconTheme();

function iconFile(gicon) {
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path();
    const info = iconTheme.lookup_by_gicon(gicon, SIZE, 0);
    return info?.get_filename() ?? null;
}

// The plate's outline as points, for the sheet to draw.
function outline(shape, count = 96) {
    const points = [];
    const reach = Math.max(shape.rx, shape.ry) * 2;
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * 2 * Math.PI;
        const ux = Math.cos(angle), uy = Math.sin(angle);
        let lo = 0, hi = reach;
        for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2;
            if (shapeDistance(shape, shape.cx + ux * mid, shape.cy + uy * mid) < 0)
                lo = mid;
            else
                hi = mid;
        }
        points.push([shape.cx + ux * lo, shape.cy + uy * lo].map(v => Math.round(v * 100) / 100));
    }
    return points;
}

function hex(rgb) {
    return `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

const apps = Gio.AppInfo.get_all()
    .filter(app => app.should_show() && app.get_icon())
    .map(app => ({id: app.get_id(), name: app.get_name(), gicon: app.get_icon()}));
const seen = new Set();
const entries = [{id: 'show-apps', name: 'Show Apps', gicon: new Gio.ThemedIcon({name: 'view-app-grid-symbolic'})}]
    .concat(apps)
    .filter(e => !seen.has(e.id) && seen.add(e.id))
    .filter(e => ARGV.length <= 2 || ARGV.slice(2).some(part => `${e.id} ${e.name}`.toLowerCase().includes(part.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name));

const results = [];
for (const entry of entries) {
    const record = {id: entry.id, name: entry.name, icon: entry.gicon.to_string()};
    try {
        record.file = iconFile(entry.gicon);
        // The shell shows the generic icon for an application whose icon is missing.
        if (!record.file) {
            record.missing = true;
            record.file = iconFile(new Gio.ThemedIcon({name: 'application-x-executable'}));
        }
        if (!record.file)
            throw new Error('not found in the theme');
        record.fromTheme = record.file.includes(`/${theme}/`);
        const pixels = await drawIcon(record.file, SIZE);
        const started = GLib.get_monotonic_time();
        const analysis = analyzeIcon(pixels);
        const map = buildStyleMap(analysis, await drawIcon(record.file, SIZE * 2));
        record.ms = Math.round((GLib.get_monotonic_time() - started) / 1000);
        record.original = GLib.base64_encode(encodePngRgba(SIZE, SIZE, pixels.data));
        const symbol = new Uint8Array(SIZE * SIZE * 4);
        for (let i = 0; i < SIZE * SIZE; i++) {
            const v = Math.round(analysis.intensity[i] * 255);
            symbol.set([v, v, v, Math.round(analysis.symbol[i] * 255)], i * 4);
        }
        record.symbol = GLib.base64_encode(encodePngRgba(SIZE, SIZE, symbol));
        record.map = map ? GLib.base64_encode(encodePngRgba(map.size, map.size, map.data)) : null;
        record.tone = map ? GLib.base64_encode(encodePngRgba(map.size, map.size, map.tone)) : null;
        record.ownPlate = map?.ownPlate ?? false;
        record.plates = analysis.plates.map(plate => ({
            shape: plate.shape,
            outline: outline(plate.shape),
            centre: hex(oklabToSrgb(...plateColor(plate, plate.shape.cx, plate.shape.cy))),
            // The colour at the top left and the bottom right, to show a gradient.
            from: hex(oklabToSrgb(...plateColor(plate, plate.shape.cx - plate.shape.rx * 0.7, plate.shape.cy - plate.shape.ry * 0.7))),
            to: hex(oklabToSrgb(...plateColor(plate, plate.shape.cx + plate.shape.rx * 0.7, plate.shape.cy + plate.shape.ry * 0.7))),
            plain: plate.plain,
            parent: plate.parent,
            surface: Math.round(plate.surface * 100) / 100,
            error: Math.round(plate.error * 1000) / 1000,
            share: Math.round(plate.share * 100) / 100,
            noise: Math.round(plate.noise * 1000) / 1000,
        }));
    } catch (e) {
        record.error = String(e.message ?? e);
    }
    results.push(record);
}

GLib.file_set_contents(outPath, JSON.stringify({theme, size: SIZE, icons: results}));
print(`${theme}: ${results.length} icons, ${results.filter(r => r.error).length} failed, ` +
    `${results.filter(r => r.plates?.length).length} with plates`);
