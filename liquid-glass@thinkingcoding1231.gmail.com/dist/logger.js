// Writes only while the `output-logs` setting is on.
export class Logger {
    _settings;
    _outputLogs;
    _settingsIds = [];

    constructor(settings) {
        this._settings = settings;
        this._outputLogs = this._settings.get_boolean('output-logs');
        this._bindSettings();
    }

    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsIds.push(id);
        };
        connectSetting('output-logs', () => {
            this._outputLogs = this._settings.get_boolean('output-logs');
        });
    }

    // Check this before building an expensive message only to log it.
    get enabled() {
        return this._outputLogs;
    }

    log(...args) {
        if (!this._outputLogs)
            return;
        console.log(...args);
    }

    error(...args) {
        if (!this._outputLogs)
            return;
        console.error(...args);
    }

    warn(...args) {
        if (!this._outputLogs)
            return;
        console.warn(...args);
    }

    debug(...args) {
        if (!this._outputLogs)
            return;
        console.debug(...args);
    }

    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
}

export let _utilsLogger = null;

export function setUtilsLogger(logger) {
    _utilsLogger = logger;
}

export function utilsLog(msg) {
    _utilsLogger?.log(msg);
}

/**
 * Output the user asked for explicitly (Looking Glass diagnostics, the dump
 * shortcut), so it is not gated on `output-logs`.
 */
export function diagnosticLog(msg) {
    console.log(msg);
}

// Reports an exception that escaped a per-frame sync loop. Not gated on
// `output-logs`, since it means a glass stopped following its target, and
// rate-limited per tag, since the cause usually repeats every frame.
const _frameLoopErrorLastLogged = new Map();
const FRAME_LOOP_ERROR_LOG_INTERVAL_MS = 5000;

export function reportFrameLoopError(tag, e) {
    const now = Date.now();
    const last = _frameLoopErrorLastLogged.get(tag) ?? 0;
    if (now - last < FRAME_LOOP_ERROR_LOG_INTERVAL_MS)
        return;
    _frameLoopErrorLastLogged.set(tag, now);
    const stack = e instanceof Error && e.stack ? `\n${e.stack}` : '';
    console.error(`[Liquid Glass] exception in ${tag} frame sync: ${e}${stack}`);
}
