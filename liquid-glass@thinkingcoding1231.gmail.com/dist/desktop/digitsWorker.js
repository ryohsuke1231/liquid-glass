// Makes the glass clock's digits in a process of its own (gjs -m), so the
// shell keeps drawing and following the pointer while they are made. Answers
// a DigitsRequest by writing the texture's pixels to a temporary file:
// {path, width, height, band, digitHeight}.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { DigitsMaker } from './digits.js';
import { serveRequests } from '../workers/workerProcess.js';
const maker = new DigitsMaker();

function save(bytes) {
    const [fd, path] = GLib.file_open_tmp('liquid-glass-digits-XXXXXX');
    GLib.close(fd);
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.NONE, null, (_f, res) => {
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

await serveRequests(async (request) => {
    const digits = await maker.make(request);
    const path = await save(digits.bytes);
    return { path, width: digits.width, height: digits.height, band: digits.band, digitHeight: digits.digitHeight };
});
