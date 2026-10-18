"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Makes the glass clock's digits in a process of its own (gjs -m), so the
// shell keeps drawing and following the pointer while they are made. Answers
// a DigitsRequest by writing the texture's pixels to a temporary file:
// {path, width, height, band, digitHeight}.
const 1 = __importDefault(require("gi://Gio"));
const 2 = __importDefault(require("gi://GLib"));
const digits_js_1 = require("./digits.js");
const workerProcess_js_1 = require("../workers/workerProcess.js");
const maker = new digits_js_1.DigitsMaker();

function save(bytes) {
    const [fd, path] = 2.default.file_open_tmp('liquid-glass-digits-XXXXXX');
    2.default.close(fd);
    const file = 1.default.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new 2.default.Bytes(bytes), null, false, 1.default.FileCreateFlags.NONE, null, (_f, res) => {
            try {
                file.replace_contents_finish(res);
                resolve(path);
            }
            catch (e) {
                reject(e);
            }
        });
    });
}
// @ts-ignore: CommonJS module with GJS runtime supports top-level await
await (0, workerProcess_js_1.serveRequests)(async (request) => {
    const digits = await maker.make(request);
    const path = await save(digits.bytes);
    return { path, width: digits.width, height: digits.height, band: digits.band, digitHeight: digits.digitHeight };
});
