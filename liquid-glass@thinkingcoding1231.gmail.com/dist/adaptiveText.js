import GLib from 'gi://GLib';
import St from 'gi://St';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { adaptiveColorTweener, hexToRgb, resolveCrossFade } from './animation/colors.js';
import { isActorValid } from './actors/lifecycle.js';
const COLOR_TWEEN_MS = 380;

/**
 * Keeps the labels and icons under `roots` readable on their glass: every
 * `intervalMs` it measures what is behind them and colors them light or
 * dark. For surfaces that stay on screen (the top bar, desktop widgets,
 * the launcher); a measurement is skipped while nothing behind them was
 * repainted.
 */
export class AdaptiveTextColor {
    _roots;
    _glasses;
    _logger;
    _label;
    _options;
    _sampler = new StageContrastSampler();
    _config = { ...AdaptiveContrastConfig, enabled: true, samplePerElement: false };
    _timerId = 0;
    _inFlight = false;
    _first = true;
    // colorFor() calls still measuring; the periodic measurement waits for them.
    _pending = 0;
    // Each colored actor's own inline style, put back by clear().
    _styled = new Map();

    constructor(_roots, _glasses, _logger, _label, _options = {}) {
        this._roots = _roots;
        this._glasses = _glasses;
        this._logger = _logger;
        this._label = _label;
        this._options = _options;
    }

    /**
     * @param preferredMinContrast When above 0, `preference` is kept while it
     *   reads at least this well; see AdaptiveContrastConfig.
     */
    start(intervalMs, preference, preferredMinContrast = 0) {
        this._config.sampleIntervalMs = intervalMs;
        this._config.preference = preference;
        this._config.preferredMinContrast = preferredMinContrast;
        this.stop();
        this._first = true;
        this._sampler.reset();
        this.update();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(100, intervalMs), () => {
            this.update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    // Measures again at the next update, for a surface whose content changed.
    invalidate() {
        this._sampler.invalidate();
    }

    // True while any of this surface's text actors are being recolored. Layouts
    // that derive geometry from those actors can hold their last stable bounds.
    isAnimating() {
        for (const actor of this._styled.keys()) {
            if (adaptiveColorTweener.isAnimating(actor))
                return true;
        }
        return false;
    }

    update() {
        if (this._inFlight || this._pending > 0 || this._options.held?.())
            return;
        const targets = [];
        for (const root of this._roots()) {
            if (!this._options.ownColor)
                collectText(root, targets);
            else if (root.visible)
                targets.push(root);
        }
        if (targets.length === 0)
            return;
        this._inFlight = true;
        const skip = this._first;
        this._first = false;
        const glasses = () => this._glasses().filter(g => g.mapped);
        this._sampler.chooseColorsForActors(targets, this._config, null, () => glasses().reduce((sum, g) => sum + (g.paintCount ?? NaN), 0), glasses)
            .then(colors => {
            const batch = GLib.get_monotonic_time();
            for (const [actor, color] of colors)
                this._apply(actor, color, skip, batch);
        })
            .catch(e => this._logger.error(`[Liquid Glass] ${this._label} text color update failed: ${e}`))
            .finally(() => { this._inFlight = false; });
    }

    /**
     * Colors the roots at once, without a tween, for what is behind `rect` (stage coordinates): for a surface with
     * ownColor about to take that size, whose new part has no glass under it yet. Does nothing unless started.
     */
    colorFor(rect) {
        if (!this._timerId)
            return;
        this._pending++;
        this._sampler.chooseColorFor(rect, this._config, this._glasses())
            .then(color => {
            if (!color)
                return;
            const batch = GLib.get_monotonic_time();
            for (const root of this._roots())
                this._apply(root, color, true, batch);
        })
            .catch(e => this._logger.error(`[Liquid Glass] ${this._label} text color update failed: ${e}`))
            .finally(() => { this._pending--; });
    }

    _apply(actor, color, skip, batch) {
        if (!(actor instanceof St.Widget) || !isActorValid(actor))
            return;
        let entry = this._styled.get(actor);
        if (!entry) {
            entry = { style: actor.get_style() ?? '', destroyId: 0, color: '' };
            entry.destroyId = actor.connect('destroy', () => {
                adaptiveColorTweener.cancel(actor);
                this._styled.delete(actor);
            });
            this._styled.set(actor, entry);
        }
        // A style that went back to the actor's own was reset by someone else; the color is put on again.
        const reset = entry.color !== '' && (actor.get_style() ?? '') === entry.style && !adaptiveColorTweener.isAnimating(actor);
        if (entry.color === color && !skip && !reset)
            return;
        entry.color = color;
        const own = entry.style.trim();
        const prefix = own ? `${own.replace(/;$/, '')}; ` : '';
        const apply = (r, g, b, a) => {
            const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            actor.set_style(`${prefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
        };
        const target = hexToRgb(color);
        if (skip) {
            adaptiveColorTweener.cancel(actor);
            apply(target.r, target.g, target.b, 1);
            return;
        }
        const start = actor.get_theme_node().get_foreground_color();
        const startRgb = { r: start.red, g: start.green, b: start.blue };
        adaptiveColorTweener.add(actor, {
            startRgb, startAlpha: start.alpha / 255,
            targetRgb: target, targetAlpha: 1,
            crossFade: resolveCrossFade(startRgb, target),
            durationMs: COLOR_TWEEN_MS,
            apply,
            coalesce: true,
        }, batch);
    }

    /** Stops measuring and gives every actor its own style back. */
    clear() {
        this.stop();
        for (const [actor, entry] of this._styled) {
            adaptiveColorTweener.cancel(actor);
            actor.disconnect(entry.destroyId);
            actor.set_style(entry.style || null);
        }
        this._styled.clear();
    }
}

function collectText(actor, out) {
    if (!actor.visible)
        return;
    if (actor instanceof St.Label || actor instanceof St.Icon) {
        out.push(actor);
        return;
    }
    for (const child of actor.get_children())
        collectText(child, out);
}
