"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconStyler = exports.SHOW_APPS_ID = void 0;
// Redraws application icons in the dock (Dash to Dock), the launcher and the
// overview's app grid as glass plates under a symbol (see iconEffect.ts), for
// the applications the settings pick. Clear icons read what is behind them
// from one backdrop per actor that holds them (iconBackdrop.ts).
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const MessageTray = __importStar(require("resource:///org/gnome/shell/ui/messageTray.js"));
const 2 = __importDefault(require("gi://Clutter"));
const 3 = __importDefault(require("gi://Gio"));
const 4 = __importDefault(require("gi://GLib"));
const 5 = __importDefault(require("gi://Meta"));
const 6 = __importDefault(require("gi://Shell"));
const 7 = __importDefault(require("gi://St"));
const colors_js_1 = require("../animation/colors.js");
const shellVersion_js_1 = require("../shellVersion.js");
const iconBackdrop_js_1 = require("./iconBackdrop.js");
const iconEffect_js_1 = require("./iconEffect.js");
const iconMaps_js_1 = require("./iconMaps.js");
const styleColors_js_1 = require("./styleColors.js");
// The id the Show Apps button goes by in the application lists.
exports.SHOW_APPS_ID = 'show-apps';
// Icons are looked up at the size their maps are taken from.
const LOOKUP_SIZE = 128;
const EFFECT_NAME = 'liquid-glass-icon-style';
// After the extension starts or what is styled changes, the icons not in the cache yet are made after this wait,
// so that the session's start is not slowed.
const PREPARE_DELAY_S = 5;
const FALLBACK_ICON = 'application-x-executable';
// The actor a backdrop goes on for icons in `holder`. One painted into an ancestor's offscreen, which Dash to Dock
// keeps its dash in, cannot read the stage, so it goes above that ancestor. The offscreen keeps what was drawn
// until something in it changes, so `cached` says the icons have to be redrawn whenever the backdrop is copied again.

function backdropHost(holder) {
    let host = holder, cached = false;
    for (let actor = holder; actor; actor = actor.get_parent()) {
        const parent = actor.get_parent();
        if (parent && actor.offscreen_redirect & 2.default.OffscreenRedirect.ALWAYS) {
            host = parent;
            cached = true;
        }
    }
    return { host, cached };
}
// Keys that decide which icons are styled, and keys that only change how they look.
const KEYS = ['icon-style-dock', 'icon-style-launcher', 'icon-style-app-grid', 'icon-style-all-apps', 'icon-style-whitelist', 'icon-style-blacklist'];
const COLOR_KEYS = ['icon-style-use-accent', 'icon-style-color', 'icon-style-tint-variant',
    'icon-style-tint-strength', 'icon-style-symbol-opacity', 'icon-style-tuning'];

function appIdOf(icon) {
    // The shell's and Dash to Dock's Show Apps buttons, whatever icon they show.
    if (icon.has_style_class_name('show-apps-icon'))
        return exports.SHOW_APPS_ID;
    for (let actor = icon.get_parent(); actor; actor = actor.get_parent()) {
        const app = actor.app;
        if (app instanceof 6.default.App)
            return app.get_id();
    }
    return folderAppIdOf(icon);
}
// A folder's icon shows its first apps in a grid of bins, one icon each, laid out in the folder's order.

function folderAppIdOf(icon) {
    const bin = icon.get_parent();
    const grid = bin?.get_parent();
    if (!bin || !grid)
        return null;
    for (let actor = grid.get_parent(); actor; actor = actor.get_parent()) {
        const items = actor.view?._orderedItems;
        if (!Array.isArray(items))
            continue;
        const app = items[grid.get_children().indexOf(bin)]?.app;
        return app instanceof 6.default.App ? app.get_id() : null;
    }
    return null;
}

class IconStyler {
    _extensionPath;
    _settings;
    _logger;
    _maps;
    _shader;
    _pipeline = null;
    _glassPipeline = null;
    _hosts = new Map();
    // The views of the app grid's folders, which their dialogs show over the grid.
    _folderViews = new WeakSet();
    _theme = new 7.default.IconTheme();
    _styled = new Map();
    // Per dock and app grid, the actors in it watched for children, by the handlers on each.
    _roots = new Map();
    _scanId = 0;
    _prepareId = 0;
    _installedId = 0;
    _notification = null;
    _settingsIds = [];
    _themeId = 0;
    _unwatchAccent = () => { };
    _cancellable = new 3.default.Cancellable();
    constructor(_extensionPath, _settings, _logger) {
        this._extensionPath = _extensionPath;
        this._settings = _settings;
        this._logger = _logger;
        this._maps = new iconMaps_js_1.IconMaps(_extensionPath, _logger, busy => this._notify(busy));
        const file = 3.default.File.new_for_path(`${_extensionPath}/shaders/icon-style.frag`);
        this._shader = new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (_f, res) => {
                try {
                    resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        this._shader.catch(e => {
            if (!(e instanceof 4.default.Error && e.matches(3.default.IOErrorEnum, 3.default.IOErrorEnum.CANCELLED)))
                this._logger.error(`[Liquid Glass] Could not read the icon shader: ${e}`);
        });
    }
    setup() {
        this._settingsIds = [
            ...KEYS.map(key => this._settings.connect(`changed::${key}`, () => {
                this._restyleAll();
                this._prepareSoon();
            })),
            ...COLOR_KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._recolorAll())),
            this._settings.connect('changed::icon-style-size', () => this._resizeAll()),
            this._settings.connect('changed::icon-style-mode', () => this._restyleAll()),
        ];
        this._themeId = 7.default.TextureCache.get_default().connect('icon-theme-changed', () => {
            this._theme = new 7.default.IconTheme();
            this._restyleAll();
            this._prepareSoon();
        });
        this._installedId = 6.default.AppSystem.get_default().connect('installed-changed', () => this._prepareSoon());
        this._unwatchAccent = (0, shellVersion_js_1.watchAccentColor)(() => this._recolorAll());
        this._watch(Main.overview._overview.controls._appDisplay, 'app-grid');
        this._prepareSoon();
    }
    cleanup() {
        this._cancellable.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._themeId)
            7.default.TextureCache.get_default().disconnect(this._themeId);
        this._themeId = 0;
        if (this._installedId)
            6.default.AppSystem.get_default().disconnect(this._installedId);
        this._installedId = 0;
        if (this._prepareId)
            4.default.Source.remove(this._prepareId);
        this._prepareId = 0;
        this._notification?.destroy();
        this._notification = null;
        this._unwatchAccent();
        if (this._scanId)
            global.compositor.get_laters().remove(this._scanId);
        this._scanId = 0;
        for (const root of this._roots.keys())
            this.unwatchDock(root);
        for (const icon of this._styled.keys())
            this._forget(icon);
        for (const host of this._hosts.keys())
            this._dropHost(host);
        this._maps.destroy();
        this._pipeline = null;
        this._glassPipeline = null;
    }
    /** Styles the application icons in a Dash to Dock dock, and those it adds later. */
    watchDock(dock) {
        this._watch(dock, 'dock');
    }
    unwatchDock(root) {
        const entry = this._roots.get(root);
        if (!entry)
            return;
        this._roots.delete(root);
        for (const [actor, ids] of entry.watched)
            ids.forEach(id => actor.disconnect(id));
        for (const [icon, styled] of this._styled) {
            if (styled.root === root)
                this._forget(icon);
        }
    }
    _watch(root, surface) {
        if (this._roots.has(root))
            return;
        this._roots.set(root, { surface, watched: new Map() });
        this._scanSoon();
    }
    /** Styles a launcher result's icon, which goes away with its row; `panel` holds the rows over the glass. */
    styleLauncherIcon(icon, appId, panel) {
        this._style(icon, appId, 'launcher', null, panel);
    }
    // Before the next frame, so that icons a dock adds are not drawn as they are first.
    _scanSoon() {
        if (this._scanId)
            return;
        this._scanId = global.compositor.get_laters().add(5.default.LaterType.BEFORE_REDRAW, () => {
            this._scanId = 0;
            for (const [root, { surface, watched }] of this._roots)
                this._scan(root, root, surface, watched);
            return 4.default.SOURCE_REMOVE;
        });
    }
    _scan(actor, root, surface, watched) {
        if (actor instanceof 7.default.Icon) {
            const appId = appIdOf(actor);
            if (appId && !this._styled.has(actor))
                this._style(actor, appId, surface, root);
            return;
        }
        if (!watched.has(actor)) {
            watched.set(actor, [
                actor.connect('child-added', () => this._scanSoon()),
                actor.connect('destroy', () => watched.delete(actor)),
            ]);
        }
        for (const child of actor.get_children())
            this._scan(child, root, surface, watched);
        // A folder's apps are laid out in a view of their own, which goes into a dialog over the overview once it opens.
        const folder = actor.view;
        if (surface === 'app-grid' && folder instanceof 2.default.Actor) {
            this._folderViews.add(folder);
            this._scan(folder, root, surface, watched);
        }
    }
    _style(icon, appId, surface, root = null, host = root) {
        if (!this._styled.has(icon)) {
            const restyle = () => this._apply(icon);
            // A folder's icons sit in its dialog, over the grid.
            for (let actor = icon.get_parent(); actor && actor !== root; actor = actor.get_parent()) {
                if (this._folderViews.has(actor)) {
                    host = actor;
                    break;
                }
            }
            this._styled.set(icon, {
                appId, surface, root, host, backdropHost: null, effect: null, serial: 0,
                ids: [icon.connect('destroy', () => this._dropIcon(icon)), icon.connect('notify::gicon', restyle),
                    icon.connect('notify::fallback-gicon', restyle)],
            });
        }
        this._apply(icon);
    }
    _forget(icon) {
        const styled = this._styled.get(icon);
        if (!styled)
            return;
        this._styled.delete(icon);
        styled.ids.forEach(id => icon.disconnect(id));
        this._unstyle(icon, styled);
    }
    _dropIcon(icon) {
        const styled = this._styled.get(icon);
        if (!styled)
            return;
        this._styled.delete(icon);
        this._leaveHost(icon, styled);
    }
    // The backdrop of `host`'s clear icons, made with its first.
    _backdropFor(icon, styled) {
        if (!styled.host)
            return null;
        const { host, cached } = backdropHost(styled.host);
        styled.backdropHost = host;
        let entry = this._hosts.get(host);
        if (!entry) {
            const icons = new Set();
            const backdrop = new iconBackdrop_js_1.IconBackdrop({
                extensionPath: this._extensionPath, settings: this._settings, logger: this._logger,
                prefix: styled.surface === 'launcher' ? 'launcher' : 'dock', rect: () => this._extentsOf(icons),
                copied: () => {
                    if (cached)
                        for (const icon of icons)
                            icon.queue_redraw();
                },
            });
            backdrop.attach(host);
            entry = { backdrop, icons, destroyId: host.connect('destroy', () => this._dropHost(host)) };
            this._hosts.set(host, entry);
        }
        entry.icons.add(icon);
        return entry.backdrop;
    }
    _leaveHost(icon, styled) {
        const host = styled.backdropHost;
        styled.backdropHost = null;
        const entry = host ? this._hosts.get(host) : null;
        if (!entry)
            return;
        entry.icons.delete(icon);
        if (!entry.icons.size)
            this._dropHost(host);
    }
    _dropHost(host) {
        const entry = this._hosts.get(host);
        if (!entry)
            return;
        this._hosts.delete(host);
        host.disconnect(entry.destroyId);
        entry.backdrop.cleanup();
    }
    // The stage rect [x0, y0, x1, y1] the shown icons of a backdrop cover, as drawn (scaled) now.
    _extentsOf(icons) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const icon of icons) {
            if (!icon.mapped)
                continue;
            const r = icon.get_transformed_extents();
            x0 = Math.min(x0, r.get_x());
            y0 = Math.min(y0, r.get_y());
            x1 = Math.max(x1, r.get_x() + r.get_width());
            y1 = Math.max(y1, r.get_y() + r.get_height());
        }
        return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }
    _wanted(styled) {
        return this._settings.get_boolean(`icon-style-${styled.surface}`) && this._wantedApp(styled.appId);
    }
    _wantedApp(appId) {
        const s = this._settings;
        return s.get_boolean('icon-style-all-apps') ? !s.get_strv('icon-style-blacklist').includes(appId)
            : s.get_strv('icon-style-whitelist').includes(appId);
    }
    _file(icon) {
        const named = (name) => (name ? new 3.default.ThemedIcon({ name }) : null);
        return this._fileOf([icon.gicon ?? named(icon.icon_name), icon.fallback_gicon ?? named(icon.fallback_icon_name)]);
    }
    // The file an icon is drawn from, falling back the way St.Icon does when its own icon is not in the theme.
    _fileOf(gicons) {
        for (const gicon of gicons) {
            if (gicon instanceof 3.default.FileIcon)
                return gicon.get_file().get_path();
            const file = gicon ? this._theme.lookup_by_gicon(gicon, LOOKUP_SIZE, 0)?.get_filename() : null;
            if (file)
                return file;
        }
        return null;
    }
    _prepareSoon() {
        if (this._prepareId)
            4.default.Source.remove(this._prepareId);
        this._prepareId = 4.default.timeout_add_seconds(4.default.PRIORITY_LOW, PREPARE_DELAY_S, () => {
            this._prepareId = 0;
            this._prepare();
            return 4.default.SOURCE_REMOVE;
        });
    }
    // Makes the maps of every installed application's icon that will be styled, before any is shown.
    _prepare() {
        const s = this._settings;
        if (!['dock', 'launcher', 'app-grid'].some(surface => s.get_boolean(`icon-style-${surface}`))) {
            this._maps.prepare([]);
            return;
        }
        const fallback = new 3.default.ThemedIcon({ name: FALLBACK_ICON });
        const files = 6.default.AppSystem.get_default().get_installed()
            .filter(info => info.should_show() && this._wantedApp(info.get_id() ?? ''))
            .map(info => this._fileOf([info.get_icon(), fallback]))
            .filter((file) => !!file);
        this._maps.prepare(files);
    }
    _notify(busy) {
        this._notification?.destroy();
        this._notification = null;
        const notification = new MessageTray.Notification({
            source: MessageTray.getSystemSource(),
            title: busy ? 'Making glass icons' : 'Glass icons are ready',
            body: busy ? 'Liquid Glass is making glass versions of your application icons. They are kept in a cache, so you will not have to wait for them next time.'
                : null,
            isTransient: true,
        });
        if (busy) {
            this._notification = notification;
            notification.connect('destroy', () => {
                if (this._notification === notification)
                    this._notification = null;
            });
        }
        notification.source.addNotification(notification);
    }
    _colors() {
        const s = this._settings;
        const accent = s.get_boolean('icon-style-use-accent') ? (0, shellVersion_js_1.accentColors)() : null;
        const tint = accent ? [accent[0].red / 255, accent[0].green / 255, accent[0].blue / 255]
            : (0, colors_js_1.hexToColorArray)(s.get_string('icon-style-color'));
        const mode = s.get_string('icon-style-mode');
        const variant = s.get_string('icon-style-tint-variant') === 'light' ? 'light' : 'dark';
        const tuning = s.get_value('icon-style-tuning').deep_unpack();
        return (0, styleColors_js_1.iconStyleColors)((['mono', 'clear'].includes(mode) ? mode : 'tinted'), tint, s.get_double('icon-style-tint-strength'), s.get_double('icon-style-symbol-opacity'), variant, tuning);
    }
    _apply(icon) {
        const styled = this._styled.get(icon);
        if (!styled)
            return;
        const serial = ++styled.serial;
        const file = this._wanted(styled) ? this._file(icon) : null;
        if (!file) {
            this._unstyle(icon, styled);
            return;
        }
        Promise.all([this._maps.get(file), this._shader]).then(([textures, shader]) => {
            if (this._styled.get(icon) !== styled || styled.serial !== serial)
                return;
            const colors = this._colors();
            const clear = this._settings.get_string('icon-style-mode') === 'clear';
            let pipeline;
            if (clear)
                pipeline = this._glassPipeline ??= (0, iconEffect_js_1.iconStylePipeline)(shader, true);
            else
                pipeline = this._pipeline ??= (0, iconEffect_js_1.iconStylePipeline)(shader);
            const backdrop = clear ? this._backdropFor(icon, styled) : null;
            if (!clear)
                this._leaveHost(icon, styled);
            const effect = styled.effect ?? new iconEffect_js_1.IconStyleEffect();
            effect.prepare(pipeline.copy(), textures, colors, backdrop);
            if (!styled.effect) {
                styled.effect = effect;
                icon.add_effect_with_name(EFFECT_NAME, effect);
            }
            this._resize(icon);
        }).catch(e => {
            if (!(e instanceof 4.default.Error && e.matches(3.default.IOErrorEnum, 3.default.IOErrorEnum.CANCELLED)))
                this._logger.log(`[Liquid Glass] Could not style the icon of ${styled.appId}: ${e}`);
        });
    }
    // Scaled as an actor rather than drawn past its box, so that Clutter keeps what it redraws and culls right.
    _resize(icon) {
        const size = this._settings.get_double('icon-style-size');
        icon.set_pivot_point(0.5, 0.5);
        icon.set_scale(size, size);
    }
    _resizeAll() {
        for (const [icon, styled] of this._styled) {
            if (styled.effect)
                this._resize(icon);
        }
    }
    _unstyle(icon, styled) {
        this._leaveHost(icon, styled);
        if (!styled.effect)
            return;
        icon.remove_effect(styled.effect);
        icon.set_scale(1, 1);
        styled.effect = null;
    }
    _restyleAll() {
        for (const icon of this._styled.keys())
            this._apply(icon);
    }
    _recolorAll() {
        const colors = this._colors();
        for (const styled of this._styled.values())
            styled.effect?.setColors(colors);
    }
}
exports.IconStyler = IconStyler;
