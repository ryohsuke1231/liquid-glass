// The style maps of icon files, made by the icon worker (iconWorker.ts) and
// kept in the user's cache directory, so that an icon is taken apart once.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { WorkerProcess } from '../workers/workerProcess.js';
import { iconStyleTexture } from './iconEffect.js';
import { LENS_SIZE, MAP_SIZE } from './styleMap.js';
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
        file.query_info_async('time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
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
        file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
            try {
                file.query_info_finish(res);
                resolve(true);
            }
            catch (e) {
                if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    resolve(false);
                else
                    reject(e);
            }
        });
    });
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class IconMaps {
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
    _cancellable = new Gio.Cancellable();
    _dir = `${GLib.get_user_cache_dir()}/liquid-glass/icon-maps`;

    /** @param _onBusy Called when maps start being made, and once they all are. */
    constructor(extensionPath, _logger, _onBusy) {
        this._logger = _logger;
        this._onBusy = _onBusy;
        const count = Math.max(1, Math.min(MAX_WORKERS, GLib.get_num_processors() - 1));
        this._workers = Array.from({ length: count }, () => new WorkerProcess(`${extensionPath}/dist/iconStyle/iconWorker.js`, 'icon worker', _logger));
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
    }

    // The cache file of the icon in `path`, made first if it is not there.
    async _cached(path) {
        const time = await modified(Gio.File.new_for_path(path), this._cancellable);
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${MAP_VERSION}|${MAP_SIZE}|${path}|${time}`, -1);
        const cache = Gio.File.new_for_path(`${this._dir}/${key}`);
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
            GLib.Source.remove(this._idleId);
        this._idleId = 0;
        this._jobs++;
        if (!this._busy) {
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
                    GLib.Source.remove(this._idleId);
                this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE_DELAY_MS, () => {
                    this._idleId = 0;
                    this._busy = false;
                    this._onBusy(false);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    async _load(path) {
        const cache = await this._cached(path);
        const bytes = await loadFile(cache, this._cancellable);
        const length = MAP_SIZE * MAP_SIZE * 4;
        if (bytes.length !== length * 2 + LENS_SIZE * LENS_SIZE * 2 * 4)
            throw new Error(`${cache.get_path()} is not a style map`);
        return { map: iconStyleTexture(bytes.subarray(0, length)), tone: iconStyleTexture(bytes.subarray(length, length * 2)),
            lens: iconStyleTexture(bytes.subarray(length * 2), LENS_SIZE, LENS_SIZE * 2) };
    }

    destroy() {
        this._cancellable.cancel();
        if (this._idleId)
            GLib.Source.remove(this._idleId);
        this._idleId = 0;
        for (const worker of this._workers)
            worker.destroy();
        this._maps.clear();
        this._making.clear();
    }
}
