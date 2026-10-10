import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { BackdropGlass } from '../rendering/backdropGlass.js';
import { ensureGlassAllocated } from '../actors/allocation.js';
import { isActorValid } from '../actors/lifecycle.js';
import { hexToColorArray } from '../animation/colors.js';
import { AdaptiveTextColor } from '../adaptiveText.js';
import { sanitizeColorPreference } from '../contrastSampler.js';
import { verticalBoxParams } from '../shellVersion.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room around a card for its shadow.
const SHADOW_MARGIN = 40;
// A press that moves further than this (px) before it is let go is no click.
const CLICK_SLOP = 6;
// The text on the desktop stays in the preferred colour down to this contrast
// ratio (WCAG's for large text), so a busy wallpaper does not keep flipping it.
export const PREFERRED_MIN_CONTRAST = 3;

/**
 * A left click on `actor` calls `onClick` and a right click opens its menu.
 * Items move only in the menu's edit mode, so a stray drag does nothing.
 */
export function connectClicks(actor, onClick, onMenu) {
    let start = null;
    actor.connect('button-press-event', (_a, event) => {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            onMenu(...event.get_coords());
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        // A button inside gets the press: stopping it here would also cancel the
        // button's click gesture.
        if (global.stage.get_event_actor(event) !== actor)
            return Clutter.EVENT_PROPAGATE;
        start = event.get_coords();
        return Clutter.EVENT_STOP;
    });
    actor.connect('button-release-event', (_a, event) => {
        if (!start || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const moved = Math.hypot(x - start[0], y - start[1]);
        start = null;
        if (moved < CLICK_SLOP)
            onClick();
        return Clutter.EVENT_STOP;
    });
}

/**
 * A desktop widget: content on a rounded card of glass. Subclasses fill
 * `box` and may hide the card (`shown`) when they have nothing to show.
 */
export class GlassCard {
    id;
    actor;
    box;
    glass;
    env;
    _settingsIds = [];
    _lastSize = '';
    _lastShown = false;
    _text;
    _shown = true;

    constructor(id, env, width) {
        this.id = id;
        this.env = env;
        this.actor = new St.Widget({ name: `liquid-glass-desktop-${id}`, reactive: true, track_hover: true });
        this.glass = new BackdropGlass({
            extensionPath: env.path, settings: env.settings, logger: env.logger, owner: `desktop-${id}`,
        });
        this.glass.setPadding(SHADER_PADDING);
        this.glass.setIsDock(false);
        this.glass.setShadowMaxRadius(SHADOW_MARGIN - 8);
        this.actor.add_child(this.glass);
        this.box = new St.BoxLayout({ style_class: 'liquid-glass-desktop-card', width, ...verticalBoxParams() });
        this.actor.add_child(this.box);
        connectClicks(this.actor, () => this.activate(), (x, y) => env.menu(this, x, y));
        this._text = new AdaptiveTextColor(() => [this.box], () => [this.glass], env.logger, `desktop ${id}`);
        const watch = (key, fn) => this._settingsIds.push(env.settings.connect(`changed::${key}`, fn));
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
            watch(`desktop-widget-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`desktop-widget-${key}`, () => this._syncText());
        this._applyMaterial();
        this._syncText();
    }

    activate() {
    }

    get shown() {
        return this._shown;
    }

    set shown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        this.env.relayout();
    }

    _applyMaterial() {
        const s = this.env.settings;
        const g = this.glass;
        g.setTintColor(...hexToColorArray(s.get_string('desktop-widget-tint-color')));
        g.setTintStrength(s.get_double('desktop-widget-tint-strength'));
        g.setBlurRadius(s.get_int('desktop-widget-blur-radius'));
        g.setCornerRadius(s.get_double('desktop-widget-corner-radius'));
        g.setBrightness(s.get_double('desktop-widget-brightness'));
        g.setContrast(s.get_double('desktop-widget-contrast'));
        g.setSaturation(s.get_double('desktop-widget-saturation'));
        this.box.set_style(`border-radius: ${s.get_double('desktop-widget-corner-radius')}px;`);
    }

    _syncText() {
        const s = this.env.settings;
        if (!s.get_boolean('desktop-widget-enable-adaptive-text-color')) {
            this._text.clear();
            return;
        }
        this._text.start(s.get_int('desktop-widget-sample-interval-ms'), sanitizeColorPreference(s.get_string('desktop-widget-adaptive-text-preference')), PREFERRED_MIN_CONTRAST);
    }

    // The content changed; measure the text colour again.
    contentChanged() {
        this._text.invalidate();
        this.env.relayout();
    }

    size() {
        const [, natW] = this.box.get_preferred_width(-1);
        const [, natH] = this.box.get_preferred_height(natW);
        return [Math.ceil(Math.max(natW, this.box.width)), Math.ceil(natH)];
    }

    bounds() {
        return [0, 0, ...this.size()];
    }

    sync() {
        const shown = this.shown;
        this.actor.visible = shown;
        const [w, h] = this.size();
        const key = `${w}x${h}`;
        const changed = key !== this._lastSize || shown !== this._lastShown;
        this._lastShown = shown;
        if (key !== this._lastSize) {
            this._lastSize = key;
            const m = SHADOW_MARGIN;
            const p = SHADER_PADDING;
            this.glass.set_position(-m, -m);
            this.glass.set_size(w + m * 2, h + m * 2);
            this.glass.setResolution(w + m * 2, h + m * 2);
            this.glass.setGlassGeometry(m - p, m - p, w + p * 2, h + p * 2);
            this.actor.set_size(w, h);
            this._text.invalidate();
        }
        if (shown && this.actor.mapped) {
            ensureGlassAllocated(this.glass);
            this.glass.syncSources();
        }
        return changed;
    }

    destroy() {
        for (const id of this._settingsIds)
            this.env.settings.disconnect(id);
        this._settingsIds = [];
        this._text.clear();
        this.glass.cleanup();
        if (isActorValid(this.actor))
            this.actor.destroy();
    }
}
