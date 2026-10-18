"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaWidget = void 0;
const cairo_1 = __importDefault(require("cairo"));
const 1 = __importDefault(require("gi://Clutter"));
const 2 = __importDefault(require("gi://Gio"));
const 3 = __importDefault(require("gi://GLib"));
const 4 = __importDefault(require("gi://Pango"));
const 5 = __importDefault(require("gi://St"));
const desktopItem_js_1 = require("./desktopItem.js");
const audioSpectrum_js_1 = require("./audioSpectrum.js");
const frameTicker_js_1 = require("../animation/frameTicker.js");
const contentLens_js_1 = require("../rendering/contentLens.js");
const shellVersion_js_1 = require("../shellVersion.js");
const CARD_WIDTH = 300;
const ART_SIZE = 56;
const ART_RADIUS = 10;
// The bars beside the title (px): their width, the room between them, and
// how tall they are when silent and when loudest.
const BAR_WIDTH = 4;
const BAR_GAP = 4;
const BAR_MIN = 4;
const BAR_MAX = 30;
// How long (s) a bar takes to rise most of the way to a louder level, and to fall to a quieter one.
const BAR_RISE_S = 0.04;
const BAR_FALL_S = 0.16;
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
/**
 * The song or video that is playing (or was last), with buttons for the
 * previous track, play/pause and the next track. Talks to the players over
 * MPRIS directly; the card hides itself while no player is running.
 */

class MediaWidget extends desktopItem_js_1.GlassCard {
    _art;
    _bars;
    _levels = Array.from({ length: audioSpectrum_js_1.BAR_COUNT }, () => 0);
    _targets = Array.from({ length: audioSpectrum_js_1.BAR_COUNT }, () => 0);
    _barsTickId = 0;
    _barsLastUs = 0;
    _spectrum;
    _settingsId;
    _title;
    _artist;
    _playButton;
    _players = new Map();
    _ownerChangedId = 0;
    _cancellable = new 2.default.Cancellable();
    _current = null;
    constructor(env) {
        super('media', env, CARD_WIDTH);
        this.shown = false;
        const row = new 5.default.BoxLayout({ style_class: 'lg-row' });
        this._art = new 5.default.Icon({ icon_size: ART_SIZE, fallback_icon_name: 'audio-x-generic-symbolic' });
        const rounded = new contentLens_js_1.ContentLens();
        this._art.add_effect(rounded);
        this._art.connect('notify::allocation', () => rounded.shape([0, 0, this._art.width, this._art.height], 1, ART_RADIUS, 0));
        const text = new 5.default.BoxLayout({ y_align: 1.default.ActorAlign.CENTER, x_expand: true, ...(0, shellVersion_js_1.verticalBoxParams)() });
        this._title = new 5.default.Label({ style_class: 'lg-title' });
        this._artist = new 5.default.Label({ style_class: 'lg-dim' });
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = 4.default.EllipsizeMode.END;
        text.add_child(this._title);
        text.add_child(this._artist);
        this._bars = new 5.default.DrawingArea({ width: audioSpectrum_js_1.BAR_COUNT * BAR_WIDTH + (audioSpectrum_js_1.BAR_COUNT - 1) * BAR_GAP, height: BAR_MAX,
            y_align: 1.default.ActorAlign.CENTER });
        this._bars.connect('repaint', () => this._drawBars());
        // The bars are drawn in the title's color, which automatic contrast sets
        // on the labels only.
        this._title.connect('style-changed', () => this._bars.queue_repaint());
        row.add_child(this._art);
        row.add_child(text);
        row.add_child(this._bars);
        this._spectrum = new audioSpectrum_js_1.AudioSpectrum(env.logger, levels => {
            this._targets = levels;
            this._animateBars();
        });
        this._settingsId = env.settings.connect('changed::media-visualizer', () => this._update());
        const controls = new 5.default.BoxLayout({ style_class: 'lg-controls', x_align: 1.default.ActorAlign.CENTER });
        const button = (icon, method) => {
            const b = new 5.default.Button({ style_class: 'lg-control', can_focus: true,
                child: new 5.default.Icon({ icon_name: icon, icon_size: 20 }) });
            b.connect('clicked', () => this._call(method));
            controls.add_child(b);
            return b;
        };
        button('media-skip-backward-symbolic', 'Previous');
        this._playButton = button('media-playback-start-symbolic', 'PlayPause');
        button('media-skip-forward-symbolic', 'Next');
        this.box.add_child(row);
        this.box.add_child(controls);
        this._ownerChangedId = 2.default.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null, 2.default.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
            const [name, , newOwner] = params.deepUnpack();
            if (!name.startsWith(MPRIS_PREFIX))
                return;
            if (newOwner)
                this._addPlayer(name);
            else
                this._removePlayer(name);
        });
        2.default.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null, 2.default.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
            try {
                const [names] = conn.call_finish(res).deepUnpack();
                for (const name of names)
                    if (name.startsWith(MPRIS_PREFIX))
                        this._addPlayer(name);
            }
            catch (e) {
                if (!(e instanceof 3.default.Error && e.matches(2.default.IOErrorEnum, 2.default.IOErrorEnum.CANCELLED)))
                    env.logger.log(`[Liquid Glass] Could not list media players: ${e}`);
            }
        });
    }
    _addPlayer(name) {
        if (this._players.has(name))
            return;
        const player = { name, proxy: null, changedId: 0, playedAt: 0 };
        this._players.set(name, player);
        2.default.DBusProxy.new_for_bus(2.default.BusType.SESSION, 2.default.DBusProxyFlags.NONE, null, name, MPRIS_PATH, PLAYER_IFACE, this._cancellable, (_o, res) => {
            try {
                player.proxy = 2.default.DBusProxy.new_for_bus_finish(res);
            }
            catch (e) {
                if (!(e instanceof 3.default.Error && e.matches(2.default.IOErrorEnum, 2.default.IOErrorEnum.CANCELLED)))
                    this.env.logger.log(`[Liquid Glass] Could not reach media player ${name}: ${e}`);
                return;
            }
            if (this._players.get(name) !== player)
                return;
            player.changedId = player.proxy.connect('g-properties-changed', () => this._update());
            this._update();
        });
    }
    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        if (player.proxy && player.changedId)
            player.proxy.disconnect(player.changedId);
        if (this._current === player)
            this._current = null;
        this._update();
    }
    _property(player, name) {
        return player.proxy?.get_cached_property(name)?.recursiveUnpack() ?? null;
    }
    // The player that is playing, or the one that played last.
    _pick() {
        let best = null;
        const now = 3.default.get_monotonic_time();
        for (const player of this._players.values()) {
            if (!player.proxy)
                continue;
            if (this._property(player, 'PlaybackStatus') === 'Playing')
                player.playedAt = now;
            if (!best || player.playedAt > best.playedAt)
                best = player;
        }
        return best;
    }
    _update() {
        const player = this._pick();
        this._current = player;
        const metadata = player ? this._property(player, 'Metadata') ?? {} : {};
        const title = metadata['xesam:title'] ?? '';
        const artists = metadata['xesam:artist'];
        this.shown = !!player && !!title;
        if (!this.shown) {
            this._listen(false);
            return;
        }
        this._title.text = title;
        this._artist.text = Array.isArray(artists) ? artists.join(', ') : (artists ?? '');
        const art = metadata['mpris:artUrl'] ?? '';
        this._art.gicon = art ? new 2.default.FileIcon({ file: 2.default.File.new_for_uri(art) }) : null;
        const playing = this._property(player, 'PlaybackStatus') === 'Playing';
        this._playButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._listen(playing);
        this.contentChanged();
    }
    // The bars follow the sound while a player plays, and lie down otherwise.
    _listen(playing) {
        const on = this.env.settings.get_boolean('media-visualizer');
        this._bars.visible = on;
        if (on && playing && this.shown) {
            this._spectrum.start();
            return;
        }
        this._spectrum.stop();
        this._targets = Array.from({ length: audioSpectrum_js_1.BAR_COUNT }, () => 0);
        this._animateBars();
    }
    _animateBars() {
        if (this._barsTickId)
            return;
        this._barsLastUs = 3.default.get_monotonic_time();
        this._barsTickId = (0, frameTicker_js_1.addFrameTicker)(() => {
            const now = 3.default.get_monotonic_time();
            const dt = (now - this._barsLastUs) / 1e6;
            this._barsLastUs = now;
            let moving = false;
            this._levels = this._levels.map((level, i) => {
                const target = this._targets[i] ?? 0;
                const next = target + (level - target) * Math.exp(-dt / (target > level ? BAR_RISE_S : BAR_FALL_S));
                if (Math.abs(next - target) < 0.002)
                    return target;
                moving = true;
                return next;
            });
            this._bars.queue_repaint();
            if (moving || this._spectrum.listening)
                return true;
            this._barsTickId = 0;
            return false;
        }, 16);
    }
    // Rounded lines standing on the same baseline, in the title's color.
    _drawBars() {
        const cr = this._bars.get_context();
        const [, height] = this._bars.get_surface_size();
        const color = this._title.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        cr.setLineCap(cairo_1.default.LineCap.ROUND);
        cr.setLineWidth(BAR_WIDTH);
        const cap = BAR_WIDTH / 2;
        this._levels.forEach((level, i) => {
            const x = i * (BAR_WIDTH + BAR_GAP) + cap;
            const h = BAR_MIN + (BAR_MAX - BAR_MIN) * level;
            cr.moveTo(x, height - cap);
            cr.lineTo(x, height - h + cap);
        });
        cr.stroke();
        cr.$dispose();
    }
    _call(method) {
        this._current?.proxy?.call(method, null, 2.default.DBusCallFlags.NONE, -1, null, null);
    }
    destroy() {
        this.env.settings.disconnect(this._settingsId);
        this._cancellable.cancel();
        if (this._ownerChangedId)
            2.default.DBus.session.signal_unsubscribe(this._ownerChangedId);
        this._ownerChangedId = 0;
        for (const name of this._players.keys())
            this._removePlayer(name);
        this._spectrum.stop();
        if (this._barsTickId)
            (0, frameTicker_js_1.removeFrameTicker)(this._barsTickId);
        this._barsTickId = 0;
        super.destroy();
    }
}
exports.MediaWidget = MediaWidget;
