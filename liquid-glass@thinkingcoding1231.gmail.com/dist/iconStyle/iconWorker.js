"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Takes icons apart in a process of its own (gjs -m), so the shell keeps
// drawing meanwhile. Answers {file, cache} by drawing the icon file, writing
// its style map's pixels, its tones' and its lens map's to `cache` and saying
// {styled}.
const 1 = __importDefault(require("gi://Gio"));
const 2 = __importDefault(require("gi://GLib"));
const iconAnalysis_js_1 = require("./iconAnalysis.js");
const iconRaster_js_1 = require("./iconRaster.js");
const styleMap_js_1 = require("./styleMap.js");
const workerProcess_js_1 = require("../workers/workerProcess.js");
// The size the analysis is tuned at; the symbol is taken from the icon drawn at twice that.
const ANALYSIS_SIZE = 128;

function write(path, bytes) {
    2.default.mkdir_with_parents(2.default.path_get_dirname(path), 0o700);
    const file = 1.default.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new 2.default.Bytes(bytes), null, false, 1.default.FileCreateFlags.NONE, null, (_f, res) => {
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
// @ts-ignore: CommonJS module with GJS runtime supports top-level await
await (0, workerProcess_js_1.serveRequests)(async ({ file, cache }) => {
    const analysis = (0, iconAnalysis_js_1.analyzeIcon)(await (0, iconRaster_js_1.drawIcon)(file, ANALYSIS_SIZE));
    const map = (0, styleMap_js_1.buildStyleMap)(analysis, await (0, iconRaster_js_1.drawIcon)(file, ANALYSIS_SIZE * 2));
    const bytes = new Uint8Array(map.data.length * 2 + map.lens.length);
    bytes.set(map.data);
    bytes.set(map.tone, map.data.length);
    bytes.set(map.lens, map.data.length * 2);
    await write(cache, bytes);
    return { styled: true };
});
