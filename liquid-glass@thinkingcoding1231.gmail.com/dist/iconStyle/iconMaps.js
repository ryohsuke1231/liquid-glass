"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconMaps = void 0;
// The style maps of icon files, made by the icon worker (iconWorker.ts) and
// kept in the user's cache directory, so that an icon is taken apart once.
const 2 = __importDefault(require("gi://Gio"));
const 3 = __importDefault(require("gi://GLib"));
const workerProcess_js_1 = require("../workers/workerProcess.js");
const iconEffect_js_1 = require("./iconEffect.js");
const styleMap_js_1 = require("./styleMap.js");
// Changes whenever the maps would come out differently, so that older ones are made again.
const MAP_VERSION = 10;
// Workers that take icons apart side by side; one more starts only while the others are all busy.
const MAX_WORKERS = 4;
// Icons asked for one after another (an app grid page, a folder) make one run of work, not one each.
const IDLE_DELAY_MS = 1500;

function loadFile(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (_f, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

function modified(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('time::modified', 2.default.FileQueryInfoFlags.NONE, 3.default.PRIORITY_DEFAULT, cancellable, (_f, res) => {
            try {
                resolve(file.query_info_finish(res).get_attribute_uint64('time::modified'));
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

function exists(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('standard::type', 2.default.FileQueryInfoFlags.NONE, 3.default.PRIORITY_DEFAULT, cancellable, (_f, res) => {
            try {
                file.query_info_finish(res);
                resolve(true);
            }
            catch (e) {
                if (e instanceof 3.default.Error && e.matches(2.default.IOErrorEnum, 2.default.IOErrorEnum.NOT_FOUND))
                    resolve(false);
                else
                    reject(e);
            }
        });
    });
}

function isCancelled(e) {
    return e instanceof 3.default.Error && e.matches(2.default.IOErrorEnum, 2.default.IOErrorEnum.CANCELLED);
}

class IconMaps {
    _logger;
    _onBusy;
    _workers;
    // By icon file: its map's, tones' and lens map's textures.
    _maps = new Map();
    // By cache file: the map being made into it.
    _making = new Map();
    _jobs = 0;
    _busy = false;
    _idleId = 0;
    _prepareSerial = 0;
    _cancellable = new 2.default.Cancellable();
    _dir = `${3.default.get_user_cache_dir()}/liquid-glass/icon-maps`;
    // Tracks whether we're in a prepare() batch (multiple icons) vs individual get() calls.
    _inPrepareBatch = false;
    /** @param _onBusy Called when maps start being made, and once they all are. */
    constructor(extensionPath, _logger, _onBusy) {
        this._logger = _logger;
        this._onBusy = _onBusy;
        const count = Math.max(1, Math.min(MAX_WORKERS, 3.default.get_num_processors() - 1));
        this._workers = Array.from({ length: count }, () => new workerProcess_js_1.WorkerProcess(`${extensionPath}/dist/iconStyle/iconWorker.js`, 'icon worker', _logger));
    }
    /** The map of the icon in `path`. Rejects when it cannot be made. */
    get(path) {
        let map = this._maps.get(path);
        if (!map) {
            map = this._load(path);
            // A failure is not kept: the file may be readable later.
            map.catch(() => this._maps.delete(path));
            this._maps.set(path, map);
        }
        return map;
    }
    /**
     * Makes the maps of the icons in `paths` that are not in the cache yet, without loading them, one per worker at
     * a time so that icons asked for meanwhile wait little. A later call takes the place of this one.
     */
    prepare(paths) {
        const serial = ++this._prepareSerial;
        const queue = [...new Set(paths)];
        this._inPrepareBatch = true;
        const next = async () => {
            while (serial === this._prepareSerial && queue.length) {
                const path = queue.shift();
                try {
                    await this._cached(path);
                }
                catch (e) {
                    if (isCancelled(e))
                        return;
                    this._logger.log(`[Liquid Glass] Could not make the glass icon of ${path}: ${e}`);
                }
            }
        };
        this._workers.forEach(() => next());
        // The batch ends when all workers have drained the queue.
        Promise.all(this._workers.map(w => w.whenIdle())).finally(() => {
            if (serial === this._prepareSerial)
                this._inPrepareBatch = false;
        });
    }
    // The cache file of the icon in `path`, made first if it is not there.
    async _cached(path) {
        const time = await modified(2.default.File.new_for_path(path), this._cancellable);
        const key = 3.default.compute_checksum_for_string(3.default.ChecksumType.SHA1, `${MAP_VERSION}|${styleMap_js_1.MAP_SIZE}|${path}|${time}`, -1);
        const cache = 2.default.File.new_for_path(`${this._dir}/${key}`);
        if (await exists(cache, this._cancellable))
            return cache;
        let making = this._making.get(key);
        if (!making) {
            making = this._make(path, cache).finally(() => this._making.delete(key));
            this._making.set(key, making);
        }
        await making;
        return cache;
    }
    async _make(path, cache) {
        if (this._idleId)
            3.default.Source.remove(this._idleId);
        this._idleId = 0;
        const wasBusy = this._busy;
        this._jobs++;
        // Only notify for prepare() batches, not individual get() calls.
        if (this._inPrepareBatch && !wasBusy) {
            this._busy = true;
            this._onBusy(true);
        }
        // The least busy worker, the first of equals, so that a second one starts only when the first has work.
        const usable = this._workers.filter(worker => worker.available);
        const worker = (usable.length ? usable : this._workers).reduce((a, b) => (b.pending < a.pending ? b : a));
        try {
            await worker.request({ file: path, cache: cache.get_path() });
        }
        finally {
            if (--this._jobs === 0) {
                if (this._idleId)
                    3.default.Source.remove(this._idleId);
                // Only notify end-of-batch if we were in a prepare batch.
                if (this._inPrepareBatch) {
                    this._idleId = 3.default.timeout_add(3.default.PRIORITY_DEFAULT, IDLE_DELAY_MS, () => {
                        this._idleId = 0;
                        this._busy = false;
                        this._onBusy(false);
                        return 3.default.SOURCE_REMOVE;
                    });
                }
                else {
                    this._busy = false;
                }
            }
        }
    }
    async _load(path) {
        const cache = await this._cached(path);
        const bytes = await loadFile(cache, this._cancellable);
        const length = styleMap_js_1.MAP_SIZE * styleMap_js_1.MAP_SIZE * 4;
        if (bytes.length !== length * 2 + styleMap_js_1.LENS_SIZE * styleMap_js_1.LENS_SIZE * 2 * 4)
            throw new Error(`${cache.get_path()} is not a style map`);
        return { map: (0, iconEffect_js_1.iconStyleTexture)(bytes.subarray(0, length)), tone: (0, iconEffect_js_1.iconStyleTexture)(bytes.subarray(length, length * 2)),
            lens: (0, iconEffect_js_1.iconStyleTexture)(bytes.subarray(length * 2), styleMap_js_1.LENS_SIZE, styleMap_js_1.LENS_SIZE * 2) };
    }
    destroy() {
        this._cancellable.cancel();
        if (this._idleId)
            3.default.Source.remove(this._idleId);
        this._idleId = 0;
        for (const worker of this._workers)
            worker.destroy();
        this._maps.clear();
        this._making.clear();
    }
}
exports.IconMaps = IconMaps;
