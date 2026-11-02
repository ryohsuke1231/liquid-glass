import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated, isActorValid } from '../actors.js';
import { hexToColorArray } from '../animation.js';
import { AdaptiveTextColor, sanitizeColorPreference } from '../contrastSampler.js';
import { connectClicks, PREFERRED_MIN_CONTRAST } from './widgets.js';
import { FIELD_RANGE, DigitsMaker } from './glassText.js';
import { coglContext } from '../shellVersion.js';
import { WorkerProcess } from '../workers/workerProcess.js';
// The drop shadow's reach (px), a little inside the distance field's.
const SHADOW_REACH = 40;
// New digits are made once the preferences stop changing them; until then
// the digits shown are stretched to the new size.
const FONT_DELAY_MS = 120;
// The date sits this far (px) above the glass digits' outline.
const DATE_GAP = 6;
// The date's font size relative to the clock's digits.
const DATE_SIZE_RATIO = 0.13;
const SIZE_KEYS = ['glass-clock-size', 'glass-clock-stretch', 'glass-clock-height'];

// The [min, max] the schema allows for a number key.
function keyRange(settings, key) {
    const [, range] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
    return range;
}

function clamp(value, [min, max]) {
    return Math.min(Math.max(value, min), max);
}

/**
 * A large clock whose digits are glass, like the clock on the iPhone's lock
 * screen, with the date above it.
 */
export class GlassClock {
    id = 'clock';
    actor;
    shown = true;
    _env;
    _glass;
    _date;
    _source;
    // The font, size and shape the digits are made in; null until there is one.
    _font = null;
    // The digits for the time shown and for the next minute, made ahead so the
    // minute changes without the work.
    _prepared = new Map();
    _text = '';
    // The digits' height in the font as it is (px), once known.
    _digitHeight = 0;
    // The font the digits shown were made in, and their field's size.
    _shownFont = null;
    _shownSize = [1, 1];
    // The field's size on screen, and how much it is stretched to get there.
    _fieldSize = [1, 1];
    _fieldScale = [1, 1];
    _size = [1, 1];
    _bounds = [0, 0, 1, 1];
    _sizeChanged = true;
    _timerId = 0;
    _fontTimerId = 0;
    _settingsIds = [];
    _interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    _interfaceIds = [];
    _adaptive;

    constructor(env) {
        this._env = env;
        this.actor = new St.Widget({ name: 'liquid-glass-desktop-clock', reactive: true });
        this._glass = new BackdropGlass({
            extensionPath: env.path, settings: env.settings, logger: env.logger, owner: 'desktop-clock', shapeTexture: true, underWindows: true,
        });
        this._glass.setPadding(0);
        this._glass.setIsDock(false);
        this._glass.setShadowMaxRadius(SHADOW_REACH);
        this._source = new DigitsSource(env.path, env.logger);
        this._date = new St.Label({ style_class: 'liquid-glass-clock-date' });
        this.actor.add_child(this._glass);
        this.actor.add_child(this._date);
        connectClicks(this.actor, () => { }, (x, y) => env.menu(this, x, y));
        this._adaptive = new AdaptiveTextColor(() => [this._date], () => [this._glass], env.logger, 'clock');
        const watch = (key, fn) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
        for (const key of ['glass-clock-font', 'glass-clock-size', 'glass-clock-stretch', 'glass-clock-height', 'glass-clock-tall-style'])
            watch(key, () => {
                this._fitShown();
                this._queueFont();
            });
        watch('glass-clock-format', () => this._tick());
        watch('glass-clock-show-date', () => this._tick());
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'brightness', 'contrast', 'saturation'])
            watch(`glass-clock-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`desktop-widget-${key}`, () => this._syncAdaptive());
        this._interfaceIds.push(this._interfaceSettings.connect('changed::clock-format', () => this._tick()));
        this._interfaceIds.push(this._interfaceSettings.connect('changed::font-name', () => this._queueFont()));
        this._applyMaterial();
        this._syncAdaptive();
        this._loadFont();
    }

    _applyMaterial() {
        const s = this._env.settings;
        const g = this._glass;
        g.setTintColor(...hexToColorArray(s.get_string('glass-clock-tint-color')));
        g.setTintStrength(s.get_double('glass-clock-tint-strength'));
        g.setBlurRadius(s.get_int('glass-clock-blur-radius'));
        g.setBrightness(s.get_double('glass-clock-brightness'));
        g.setContrast(s.get_double('glass-clock-contrast'));
        g.setSaturation(s.get_double('glass-clock-saturation'));
    }

    _syncAdaptive() {
        const s = this._env.settings;
        if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
            this._adaptive.clear();
            return;
        }
        this._adaptive.start(s.get_int('desktop-widget-sample-interval-ms'), sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
    }

    // The font the digits are cut from: the chosen one, or the interface font in bold.
    _fontDescription() {
        const chosen = this._env.settings.get_string('glass-clock-font').trim();
        if (chosen)
            return chosen;
        const ui = Pango.FontDescription.from_string(this._interfaceSettings.get_string('font-name'));
        return `${ui.get_family() ?? 'Sans'} Bold`;
    }

    _queueFont() {
        if (this._fontTimerId)
            GLib.Source.remove(this._fontTimerId);
        this._fontTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FONT_DELAY_MS, () => {
            this._fontTimerId = 0;
            this._loadFont();
            return GLib.SOURCE_REMOVE;
        });
    }

    _wantedFont() {
        const s = this._env.settings;
        const style = s.get_string('glass-clock-tall-style') === 'upright' ? 'upright' : 'even';
        return {
            extensionPath: this._env.path, font: this._fontDescription(), size: s.get_int('glass-clock-size'),
            stretch: s.get_double('glass-clock-stretch'), height: s.get_double('glass-clock-height'), style,
        };
    }

    // Stretches the digits shown to about the size the settings ask for, so a
    // change shows at once; the new digits take a while to make.
    _fitShown() {
        const shown = this._shownFont;
        if (!shown)
            return;
        const wanted = this._wantedFont();
        let grow = [1, 1];
        if (wanted.font === shown.font && wanted.style === shown.style) // Only when the font and style (along upright or just stretch) are the same
            grow = [wanted.size * wanted.stretch / (shown.size * shown.stretch), wanted.size * wanted.height / (shown.size * shown.height)];
        // The field's margin for the shadow stays as wide. result = ((width, height) - shadow margin * 2) * scale + shadow margin
        const size = this._shownSize.map((v, i) => Math.max(v - 2 * FIELD_RANGE, 1) * grow[i] + 2 * FIELD_RANGE);
        if (size[0] === this._fieldSize[0] && size[1] === this._fieldSize[1])
            return;
        this._fieldScale = [size[0] / this._shownSize[0], size[1] / this._shownSize[1]];
        this._fieldSize = size;
        // The glass keeps drawing at the resolution of its field, stretched to its size.
        this._glass.set_size(...size);
        this._sizeChanged = true;
    }

    _loadFont() {
        const next = this._wantedFont();
        if (this._font && JSON.stringify(next) === JSON.stringify(this._font))
            return;
        this._font = next;
        this._prepared.clear();
        this._date.set_style(`font-size: ${Math.max(11, Math.round(next.size * DATE_SIZE_RATIO))}px;`);
        this._text = '';
        this._tick();
    }

    /** Whether the digits have a size or width other than the default. */
    get resized() {
        const s = this._env.settings;
        return SIZE_KEYS.some(key => !s.get_value(key).equal(s.get_default_value(key)));
    }

    /**
     * Makes the clock `sx` times as wide and `sy` times as tall, as far as the
     * settings allow: taller alone makes the digits taller with their strokes
     * as thick (see restroke()), wider alone stretches them, and both
     * scale the font.
     */
    resizeBy(sx, sy) {
        const s = this._env.settings;
        if (sx === 1 && this._digitHeight) {
            const added = (sy - 1) * this._bounds[3] / this._digitHeight;
            const height = clamp(s.get_double('glass-clock-height') + added, keyRange(s, 'glass-clock-height'));
            s.set_double('glass-clock-height', Math.round(height * 100) / 100);
            this._loadFont();
            return;
        }
        const size = s.get_int('glass-clock-size');
        const newSize = Math.round(clamp(size * sy, keyRange(s, 'glass-clock-size')));
        // The width follows the size too; the stretch makes up the rest.
        const stretch = clamp(s.get_double('glass-clock-stretch') * sx * size / newSize, keyRange(s, 'glass-clock-stretch'));
        s.set_int('glass-clock-size', newSize);
        s.set_double('glass-clock-stretch', Math.round(stretch * 100) / 100);
        this._loadFont();
    }

    resetSize() {
        for (const key of SIZE_KEYS)
            this._env.settings.reset(key);
        this._loadFont();
    }

    _timeText(now) {
        const format = this._env.settings.get_string('glass-clock-format');
        const twelve = format === '12h' || (format !== '24h' && this._interfaceSettings.get_string('clock-format') === '12h');
        return now.format(twelve ? '%-I:%M' : '%H:%M') ?? '';
    }

    _tick() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        const now = GLib.DateTime.new_now_local();
        this._date.visible = this._env.settings.get_boolean('glass-clock-show-date');
        this._date.text = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        this._setText(this._timeText(now)); // Set glass clock's text
        this._sizeChanged = true;
        const wait = 60 - now.get_seconds() + 0.05;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait * 1000), () => {
            this._timerId = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The glass for `text` in the current font.
    _glassFor(text) {
        let glass = this._prepared.get(text);
        if (!glass) {
            glass = this._source.make({ ...this._font, text }).then(digits => {
                this._digitHeight = digits.digitHeight;
                const texture = Cogl.Texture2D.new_from_data(coglContext(), digits.width, digits.height * 2, Cogl.PixelFormat.RGBA_8888, digits.width * 4, digits.bytes);
                return { texture, band: digits.band, width: digits.width, height: digits.height };
            });
            glass.catch(() => this._prepared.delete(text));
            this._prepared.set(text, glass);
        }
        return glass;
    }

    async _setText(text) {
        const font = this._font;
        if (text === this._text || !font)
            return;
        this._text = text;
        let glass;
        try {
            glass = await this._glassFor(text);
            if (font !== this._font || text !== this._text)
                return;
        }
        catch (e) {
            // Given up for newer digits.
            if (font !== this._font || text !== this._text)
                return;
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                this._env.logger.error(`[Liquid Glass] Could not draw the clock's digits: ${e}`);
            // Tried again at the next minute.
            if (text === this._text)
                this._text = '';
            return;
        }
        const { texture, band, width, height } = glass;
        this._shownFont = font;
        this._shownSize = [width, height];
        this._fieldSize = [width, height];
        this._fieldScale = [1, 1];
        this._glass.set_size(width, height);
        this._glass.setResolution(width, height);
        this._glass.setGlassGeometry(0, 0, width, height);
        this._glass.setShapeTexture(texture, FIELD_RANGE, band);
        this._sizeChanged = true;
        this._adaptive.invalidate();
        for (const key of [...this._prepared.keys()]) {
            if (key !== text)
                this._prepared.delete(key);
        }
        // A failure shows when that minute comes and the digits are made again.
        this._glassFor(this._timeText(GLib.DateTime.new_now_local().add_minutes(1))).catch(() => { });
    }

    // The date above the digits; the field's margin is mostly empty, so the
    // label goes into it.
    _layout() {
        const [fw, fh] = this._fieldSize;
        const [rx, ry] = this._fieldScale.map(k => FIELD_RANGE * k); // Scale the margins
        const [, dateH] = this._date.visible ? this._date.get_preferred_height(-1) : [0, 0];
        const [, dateW] = this._date.visible ? this._date.get_preferred_width(-1) : [0, 0];
        const glassY = Math.max(dateH + DATE_GAP - ry, 0);
        const width = Math.max(fw, dateW);
        const glassX = Math.round((width - fw) / 2);
        this._glass.set_position(glassX, glassY);
        const dateX = Math.round((width - dateW) / 2);
        const dateY = Math.max(glassY + ry - DATE_GAP - dateH, 0); // Ususally 0
        this._date.set_position(dateX, dateY);
        this._size = [Math.ceil(width), Math.ceil(glassY + fh)];
        this.actor.set_size(...this._size);
        let [x0, y0, x1, y1] = [glassX + rx, glassY + ry, glassX + fw - rx, glassY + fh - ry];
        if (this._date.visible) {
            x0 = Math.min(x0, dateX);
            x1 = Math.max(x1, dateX + dateW);
            y0 = Math.min(y0, dateY);
        }
        this._bounds = [x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1)];
    }

    size() {
        return this._size;
    }

    bounds() {
        return this._bounds;
    }

    sync() {
        const changed = this._sizeChanged;
        if (changed) {
            this._sizeChanged = false;
            this._layout();
        }
        if (this.actor.mapped) {
            ensureGlassAllocated(this._glass);
            this._glass.syncSources();
        }
        return changed;
    }

    destroy() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        if (this._fontTimerId)
            GLib.Source.remove(this._fontTimerId);
        this._timerId = this._fontTimerId = 0;
        for (const id of this._settingsIds)
            this._env.settings.disconnect(id);
        for (const id of this._interfaceIds)
            this._interfaceSettings.disconnect(id);
        this._settingsIds = [];
        this._interfaceIds = [];
        this._adaptive.clear();
        this._source.destroy();
        this._font = null;
        this._shownFont = null;
        this._prepared.clear();
        this._glass.cleanup();
        if (isActorValid(this.actor))
            this.actor.destroy();
    }
}

// Where the glass clock gets its digits from: a worker process
// (digitsWorker.js) that makes them while the shell goes on drawing, started
// on first use. Where gjs cannot be found or the worker keeps failing, they
// are made in the shell instead, a step at a time.
export class DigitsSource {
    _logger;
    _worker;
    _local = null;
    _cancellable = new Gio.Cancellable();

    constructor(extensionPath, _logger) {
        this._logger = _logger;
        this._worker = new WorkerProcess(`${extensionPath}/dist/workers/digitsWorker.js`, 'clock\'s worker', _logger);
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
