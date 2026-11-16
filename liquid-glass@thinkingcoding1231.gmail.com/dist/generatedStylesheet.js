import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

/** A stylesheet written at run time, for rules that depend on sizes and colors only known then. */
export class GeneratedStylesheet {
    _logger;
    _file;
    _theme = null;
    _css = null;

    constructor(name, _logger) {
        this._logger = _logger;
        this._file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), name]));
    }

    /** Loads `css` in place of what was loaded; null only unloads it. A new shell theme comes without it. */
    set(css) {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (css === this._css && theme === this._theme)
            return;
        this._theme?.unload_stylesheet(this._file);
        this._theme = null;
        this._css = css;
        if (css === null)
            return;
        // Writing the file and parsing the stylesheet both throw a GError on failure.
        try {
            this._file.replace_contents(new TextEncoder().encode(css), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            theme.load_stylesheet(this._file);
            this._theme = theme;
        }
        catch (e) {
            this._logger.error(`[Liquid Glass] Could not load the generated stylesheet ${this._file.get_basename()}: ${e}`);
        }
    }

    cleanup() {
        this.set(null);
    }
}
