"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adaptiveColorTweener = void 0;
exports.hexToColorArray = hexToColorArray;
exports.hexToRgb = hexToRgb;
exports.rgbToHex = rgbToHex;
exports.crossFadeColorAt = crossFadeColorAt;
exports.shouldCrossFadeColors = shouldCrossFadeColors;
exports.lerpColorAt = lerpColorAt;
exports.setAdaptiveColorMode = setAdaptiveColorMode;
exports.getAdaptiveColorMode = getAdaptiveColorMode;
exports.resolveCrossFade = resolveCrossFade;
const 1 = __importDefault(require("gi://GLib"));
const 2 = __importDefault(require("gi://Meta"));
const lifecycle_js_1 = require("../actors/lifecycle.js");
// '#rrggbb' as normalized [r, g, b]; anything else gives white.

function hexToColorArray(hex) {
    if (!hex || !hex.startsWith('#') || hex.length !== 7)
        return [1.0, 1.0, 1.0];
    return [
        parseInt(hex.slice(1, 3), 16) / 255.0,
        parseInt(hex.slice(3, 5), 16) / 255.0,
        parseInt(hex.slice(5, 7), 16) / 255.0,
    ];
}

function hexToRgb(hex) {
    const value = parseInt(hex.replace('#', ''), 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function rgbToHex(r, g, b) {
    return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}

function crossFadeColorAt(start, startAlpha, target, targetAlpha, progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (p < 0.5) {
        const local = p / 0.5;
        const a = startAlpha * (1 - local * local);
        return { r: start.r, g: start.g, b: start.b, a };
    }
    const local = (p - 0.5) / 0.5;
    // easeOutQuad on the fade-in: mirrors the curve above.
    const e = 1 - (1 - local) * (1 - local);
    return { r: target.r, g: target.g, b: target.b, a: targetAlpha * e };
}
// A small change (off-white to white) has no grey to pass through, and a
// dissolve would only add a flicker. Rec. 709 luma difference, 0..1.
const CROSS_FADE_LUMA_DELTA = 0.4;

function shouldCrossFadeColors(start, target) {
    const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    return Math.abs(luma(target) - luma(start)) > CROSS_FADE_LUMA_DELTA;
}
// Plain per-channel interpolation (easeInOutQuad), used for small changes.

function lerpColorAt(start, startAlpha, target, targetAlpha, progress) {
    const p = Math.max(0, Math.min(1, progress));
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    return {
        r: Math.round(start.r + (target.r - start.r) * e),
        g: Math.round(start.g + (target.g - start.g) * e),
        b: Math.round(start.b + (target.b - start.b) * e),
        a: startAlpha + (targetAlpha - startAlpha) * e,
    };
}
let _adaptiveColorMode = 'cross-fade';

function setAdaptiveColorMode(mode) {
    _adaptiveColorMode = mode === 'rgb-lerp' ? 'rgb-lerp' : 'cross-fade';
}

function getAdaptiveColorMode() {
    return _adaptiveColorMode;
}
// Whether this change should dissolve rather than interpolate.

function resolveCrossFade(start, target) {
    return _adaptiveColorMode === 'cross-fade' && shouldCrossFadeColors(start, target);
}

class AdaptiveColorTweener {
    _entries = new Map();
    _laterId = 0;
    /**
     * @param batchStart monotonic timestamp shared by every actor updated in the
     *   same turn. Callers pass one value for a whole color map so the actors
     *   move in lockstep; omitted, the actor starts from now.
     */
    add(actor, entry, batchStart) {
        if (!actor)
            return;
        const prev = this._entries.get(actor);
        // Restarting mid-tween: start from what is on screen, not from the theme
        // node, which St may not have re-resolved yet.
        const startRgb = prev?.last
            ? { r: prev.last.r, g: prev.last.g, b: prev.last.b }
            : entry.startRgb;
        const startAlpha = prev?.last ? prev.last.a : entry.startAlpha;
        this._entries.set(actor, {
            ...entry,
            startRgb,
            startAlpha,
            crossFade: entry.crossFade && shouldCrossFadeColors(startRgb, entry.targetRgb),
            startTime: batchStart ?? 1.default.get_monotonic_time(),
        });
        this._schedule();
    }
    cancel(actor) {
        this._entries.delete(actor);
    }
    stopAll() {
        this._entries.clear();
        this._unschedule();
    }
    isAnimating(actor) {
        return this._entries.has(actor);
    }
    _schedule() {
        if (this._laterId !== 0)
            return;
        this._laterId = global.compositor.get_laters().add(2.default.LaterType.BEFORE_REDRAW, () => { this._tick(); return false; });
    }
    _unschedule() {
        if (this._laterId === 0)
            return;
        global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }
    _applyEntry(e, now) {
        const elapsedMs = (now - e.startTime) / 1000;
        const progress = e.durationMs > 0 ? Math.min(elapsedMs / e.durationMs, 1) : 1;
        const c = e.crossFade
            ? crossFadeColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress)
            : lerpColorAt(e.startRgb, e.startAlpha, e.targetRgb, e.targetAlpha, progress);
        const a = Math.max(0, Math.min(1, c.a));
        // set_style() re-parses CSS and relayouts, so skip frames that would
        // write the same value (the flat ends of the curve).
        const same = e.coalesce !== false && e.last &&
            e.last.r === c.r && e.last.g === c.g && e.last.b === c.b &&
            Math.abs(e.last.a - a) < 0.002;
        if (!same) {
            e.last = { r: c.r, g: c.g, b: c.b, a };
            e.apply(c.r, c.g, c.b, a, progress);
        }
        return progress;
    }
    _tick() {
        this._laterId = 0;
        const now = 1.default.get_monotonic_time();
        for (const [actor, e] of this._entries) {
            if (!(0, lifecycle_js_1.isActorValid)(actor)) {
                this._entries.delete(actor);
                continue;
            }
            const progress = this._applyEntry(e, now);
            if (progress >= 1)
                this._entries.delete(actor);
        }
        if (this._entries.size > 0)
            this._schedule();
    }
}
exports.adaptiveColorTweener = new AdaptiveColorTweener();
