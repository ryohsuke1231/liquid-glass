import Gio from "gi://Gio"

// Logger class. Used by other classes and initialized in extension.js.
export class Logger {
  private _settings: Gio.Settings;
  private _outputLogs: boolean;
  private _settingsIds: number[] = [];

  constructor(settings: Gio.Settings) {
    this._settings = settings;
    this._outputLogs = this._settings.get_boolean('output-logs');
    this._bindSettings();
  }

  _bindSettings() {

    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsIds.push(id);
    };
    connectSetting('output-logs', () => {
      this._outputLogs = this._settings.get_boolean('output-logs');
    });
  }

  log(...args: any[]) {
    if (!this._outputLogs) return;
    console.log(...args);
  }

  error(...args: any[]) {
    if (!this._outputLogs) return;
    console.error(...args);
  }

  warn(...args: any[]) {
    if (!this._outputLogs) return;
    console.warn(...args);
  }

  debug(...args: any[]) {
    if (!this._outputLogs) return;
    console.debug(...args);
  }

  cleanup() {
    if (this._settings) {
      for (const id of this._settingsIds) {
        this._settings.disconnect(id);
      }
      this._settingsIds = [];
    }
  }
}
