// Takes icons apart in a process of its own (gjs -m), so the shell keeps
// drawing meanwhile. Answers {file, cache} by drawing the icon file, writing
// its style map's pixels, its tones' and its lens map's to `cache` and saying
// {styled}.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { analyzeIcon } from './iconAnalysis.js';
import { drawIcon } from './iconRaster.js';
import { buildStyleMap } from './styleMap.js';
import { serveRequests } from '../workers/workerProcess.js';
// The size the analysis is tuned at; the symbol is taken from the icon drawn at twice that.
const ANALYSIS_SIZE = 128;

function write(path, bytes) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.NONE, null, (_f, res) => {
            try {
                file.replace_contents_finish(res);
                resolve();
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

await serveRequests(async ({ file, cache }) => {
    const analysis = analyzeIcon(await drawIcon(file, ANALYSIS_SIZE));
    const map = buildStyleMap(analysis, await drawIcon(file, ANALYSIS_SIZE * 2));
    const bytes = new Uint8Array(map.data.length * 2 + map.lens.length);
    bytes.set(map.data);
    bytes.set(map.tone, map.data.length);
    bytes.set(map.lens, map.data.length * 2);
    await write(cache, bytes);
    return { styled: true };
});
