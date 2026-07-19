// Logger class. Used by other classes and initialized in extension.js.
export class Logger {
    _settings;
    _outputLogs;
    _settingsIds = [];
    constructor(settings) {
        this._settings = settings;
        this._outputLogs = settings.get_boolean('output-logs');
        this._bindSettings();
    }
    _bindSettings() {
        const settings = this._settings;
        if (!settings)
            return;
        const connectSetting = (key, callback) => {
            let id = settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsIds.push(id);
        };
        connectSetting('output-logs', () => {
            this._outputLogs = settings.get_boolean('output-logs');
        });
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
}
