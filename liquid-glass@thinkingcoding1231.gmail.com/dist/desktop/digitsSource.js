// Where the glass clock gets its digits from: a worker process
// (digitsWorker.js) that makes them while the shell goes on drawing, started
// on first use. Where gjs cannot be found or the worker keeps failing, they
// are made in the shell instead, a step at a time.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { WorkerProcess } from '../workers/workerProcess.js';
import { DigitsMaker } from './digits.js';
export class DigitsSource {
    _logger;
    _worker;
    _local = null;
    _cancellable = new Gio.Cancellable();
    constructor(extensionPath, _logger) {
        this._logger = _logger;
        this._worker = new WorkerProcess(`${extensionPath}/dist/desktop/digitsWorker.js`, 'clock\'s worker', _logger);
    }
    /** Rejects when the digits cannot be made. */
    async make(request) {
        if (!this._local && !this._worker.available) {
            this._logger.log('[Liquid Glass] The clock\'s digits are made in the shell');
            this._local = new DigitsMaker();
        }
        if (this._local)
            return this._local.make(request);
        const message = await this._worker.request(request);
        const file = Gio.File.new_for_path(message.path);
        try {
            const bytes = await new Promise((resolve, reject) => {
                file.load_contents_async(this._cancellable, (_f, res) => {
                    try {
                        resolve(file.load_contents_finish(res)[1]);
                    }
                    catch (e) {
                        reject(e);
                    }
                });
            });
            return { bytes, width: message.width, height: message.height, band: message.band, digitHeight: message.digitHeight };
        }
        finally {
            file.delete_async(GLib.PRIORITY_DEFAULT, null, (_f, res) => {
                // Throws a GError when the file is already gone; nothing is left behind then.
                try {
                    file.delete_finish(res);
                }
                catch {
                }
            });
        }
    }
    destroy() {
        this._cancellable.cancel();
        this._worker.destroy();
        this._local?.destroy();
        this._local = null;
    }
}
