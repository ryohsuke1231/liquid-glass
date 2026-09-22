import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { getTransformedRect } from './utils.js';
// How much better the OTHER colour has to score before the decision flips.
// Only used when no preference is set ('auto'); with a preference the two
// directions get their own, deliberately asymmetric thresholds below.
const SWITCH_ADVANTAGE = 1.2;
// Flipping TOWARDS the user's preferred colour barely needs an excuse ...
const SWITCH_ADVANTAGE_TOWARD_PREFERRED = 1.02;
// ... flipping AWAY from it needs a decisive one.
const SWITCH_ADVANTAGE_AGAINST_PREFERRED = 1.6;
// Contrast ratios this close to each other mean the background genuinely does
// not favour either colour. See decideTextColor(): in that band a configured
// preference is applied outright ("断定してしまう") instead of letting the
// measurement decide, which is what the ping-ponging came from.
const AMBIGUOUS_RATIO = 1.15;
// After the decision flips, ignore every measurement for this long. The colour
// tween takes ~380ms and the sampler photographs the screen area the text
// itself is drawn on, so samples taken during the tween are measuring our own
// half-finished colour change. See the feedback-loop note on sampleLuminance().
const SWITCH_SETTLE_MS = 600;
const MIN_READABLE_CONTRAST = 4.5;
export const AdaptiveContrastConfig = {
    enabled: true,
    samplePerElement: false, // 要素ごとにサンプリングするか、全体をまとめてサンプリングするか　負荷を考慮してデフォルトはまとめてサンプリング
    sampleIntervalMs: 200, // 5Hz
    lightTextColor: '#f2f2f2',
    darkTextColor: '#1a1a1a',
    // 'auto' keeps the previous behaviour exactly (symmetric hysteresis, no
    // snapping). 'light'/'dark' name the TEXT colour to favour.
    preference: 'auto',
};
/**
 * Narrows a raw GSettings string to an AdaptiveColorPreference. Anything
 * unrecognised (an older/newer schema, a hand-edited dconf value) falls back
 * to 'auto', which is the behaviour that existed before the setting did.
 */
export function sanitizeColorPreference(value) {
    return (value === 'light' || value === 'dark') ? value : 'auto';
}
function _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}
function _srgbToLinear(c) {
    const n = c / 255.0;
    if (n <= 0.04045)
        return n / 12.92;
    return Math.pow((n + 0.055) / 1.055, 2.4);
}
function _luminanceFromRgb(r, g, b) {
    const rl = _srgbToLinear(r);
    const gl = _srgbToLinear(g);
    const bl = _srgbToLinear(b);
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}
function _trimmedMean(values, trimRatio = 0.1) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * trimRatio);
    const start = _clamp(trim, 0, sorted.length - 1);
    const end = _clamp(sorted.length - trim, start + 1, sorted.length);
    let sum = 0.0;
    for (let i = start; i < end; i++)
        sum += sorted[i];
    return sum / (end - start);
}
function _getActorRect(actor) {
    if (!actor)
        return null;
    if (!actor.mapped)
        return null;
    const [x, y, w, h] = getTransformedRect(actor);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
        return null;
    // Shell.Screenshot expects stage coordinates, including ancestor scale.
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(global.stage.width, Math.ceil(x + w));
    const bottom = Math.min(global.stage.height, Math.ceil(y + h));
    if (right <= left || bottom <= top)
        return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
}
function _mergeRects(rects) {
    if (rects.length === 0)
        return null;
    let minX = rects[0].x;
    let minY = rects[0].y;
    let maxX = rects[0].x + rects[0].width;
    let maxY = rects[0].y + rects[0].height;
    for (let i = 1; i < rects.length; i++) {
        const r = rects[i];
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
    }
    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
    };
}
// [PERF] Why this does NOT read the GPU back directly.
//
// The obvious implementation is clutter_stage_paint_to_buffer(): render the
// sampled rectangle straight into a small buffer, no codec and no file. It
// was implemented, measured on GNOME 50 / GJS, and it does not work — the
// buffer comes back untouched:
//
//   [Liquid Glass][contrast] stage.paint_to_buffer() left the buffer
//   untouched — GJS marshalled it as an input copy
//
// The reason is the introspection annotation. In mutter 50.1,
// clutter-stage.c declares the destination as
//
//     @data: (array) (element-type guint8): a pointer to the data
//
// with no direction, which means "in". GJS is free to marshal an input array
// as a temporary copy, which is exactly what it does here, so the pixels are
// written into that copy and freed. The same applies to the other candidate,
// cogl_texture_get_data(), whose cogl-texture.h annotation is
//
//     @data: (array) (nullable): memory location to write the texture's
//
// — also plain "in". So there is no GPU read-back path reachable from GJS in
// this stack, and the code that tried one has been removed rather than left
// in as a branch that can never be taken. (memo.md 6.1 records the same
// class of problem from the other direction: an array argument mis-annotated
// as a scalar, which crashed the shell instead of failing quietly.)
//
// What is left is still a real improvement over the original: the PNG goes
// through a Gio.MemoryOutputStream instead of a file in /tmp, so the write,
// the read back and the unlink are gone. If a future mutter adds
// (out caller-allocates) to either annotation, paint_to_buffer becomes worth
// revisiting — see performance-plan.md.
let _capturePathLogged = false;
function _reportCapturePath(msg) {
    if (_capturePathLogged)
        return;
    _capturePathLogged = true;
    console.log(`[Liquid Glass][contrast] ${msg}`);
}
// Longest edge sampled from the captured image. The original code walked the
// full-resolution pixels with `step = max(1, min(w, h) / 48)`, i.e. it
// already reduced everything to a ~48x48 grid before averaging; keeping that
// number keeps the measurement identical.
const SAMPLE_MAX_EDGE = 48;
/**
 * Captures one rectangle of the screen via Shell.Screenshot, into memory.
 *
 * Still pays for a full-resolution render and a PNG round trip — see the
 * comment above for why a direct read-back is not available — but through a
 * Gio.MemoryOutputStream rather than /tmp, so the file write, the file read
 * and the unlink the original did five times a second are gone.
 */
function _captureViaScreenshot(screenshot, rect) {
    return new Promise(resolve => {
        try {
            const stream = Gio.MemoryOutputStream.new_resizable();
            screenshot.screenshot_area(Math.floor(rect.x), Math.floor(rect.y), Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)), stream, (obj, res) => {
                try {
                    if (!obj)
                        throw new Error('screenshot object is null');
                    const ok = obj.screenshot_area_finish(res)[0];
                    stream.close(null);
                    if (!ok) {
                        resolve(null);
                        return;
                    }
                    const bytes = stream.steal_as_bytes();
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
                    if (!pixbuf) {
                        resolve(null);
                        return;
                    }
                    const width = pixbuf.get_width();
                    const height = pixbuf.get_height();
                    resolve({
                        data: pixbuf.get_pixels(),
                        width,
                        height,
                        stride: pixbuf.get_rowstride(),
                        channels: pixbuf.get_n_channels(),
                        // Full resolution here, so keep the original subsampling.
                        step: Math.max(1, Math.floor(Math.min(width, height) / SAMPLE_MAX_EDGE)),
                    });
                }
                catch (e) {
                    try {
                        stream.close(null);
                    }
                    catch (_) { }
                    resolve(null);
                }
            });
        }
        catch (e) {
            resolve(null);
        }
    });
}
export class StageContrastSampler {
    // Created lazily on the first sample rather than in the constructor: the
    // managers all build a sampler up front, but most sessions never open the
    // menu/notification/OSD that would use it.
    _screenshot = null;
    _lastLuma = null;
    _lastIsBright = null;
    /** Monotonic time of the last polarity change; see SWITCH_SETTLE_MS. */
    _lastSwitchAt = 0;
    _lastRect = null;
    async sampleLuminance(rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0)
            return null;
        if (!this._screenshot)
            this._screenshot = new Shell.Screenshot();
        const shot = await _captureViaScreenshot(this._screenshot, rect);
        if (!shot) {
            _reportCapturePath('screenshot capture failed; adaptive text colors will keep their current values');
            return null;
        }
        try {
            const { data, width, height, stride, channels, step } = shot;
            const values = [];
            for (let y = 0; y < height; y += step) {
                const row = y * stride;
                for (let x = 0; x < width; x += step) {
                    const idx = row + x * channels;
                    if (channels > 3) {
                        const a = data[idx + 3];
                        if (a < 32)
                            continue;
                        if (a < 255) {
                            // Un-premultiply before measuring luminance. Kept exactly as
                            // the original pixbuf loop had it so the sampled value does not
                            // shift; it only matters for semi-transparent pixels, which the
                            // opaque desktop behind a menu rarely produces.
                            const inv = 255.0 / a;
                            const r = _clamp(Math.round(data[idx + 0] * inv), 0, 255);
                            const g = _clamp(Math.round(data[idx + 1] * inv), 0, 255);
                            const b = _clamp(Math.round(data[idx + 2] * inv), 0, 255);
                            values.push(_luminanceFromRgb(r, g, b));
                            continue;
                        }
                    }
                    values.push(_luminanceFromRgb(data[idx + 0], data[idx + 1], data[idx + 2]));
                }
            }
            if (values.length === 0) {
                _reportCapturePath('capture produced no usable pixels (everything below the alpha cutoff)');
                return null;
            }
            // [FIX] 0.10 -> 0.30. The rectangle handed to this function is the
            // union of the TEXT actors' own rects, so a large minority of the
            // pixels in it are the glyphs themselves — and their colour is the very
            // thing this measurement decides. At a 10% trim the mean still moved by
            // roughly 0.1 in luminance when the text flipped, which on a background
            // sitting anywhere near the light/dark crossover is enough to flip the
            // decision straight back: the white -> black -> white -> black
            // ping-pong. Trimming 30% from each end keeps the middle 40% of the
            // sorted values — an interquartile mean — which is robust to that
            // contamination from BOTH ends (light text on a dark background and
            // dark text on a light one) and barely moves when the glyphs change
            // colour. The background itself, being the majority, still decides.
            return _trimmedMean(values, 0.30);
        }
        catch (e) {
            return null;
        }
    }
    decideTextColor(luminance, config = AdaptiveContrastConfig) {
        if (luminance === null || luminance === undefined)
            return null;
        if (!Number.isFinite(luminance))
            return null;
        luminance = _clamp(luminance, 0, 1);
        const colorLuma = (hex) => {
            const rgb = parseInt(hex.slice(1), 16);
            return _luminanceFromRgb((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        };
        const light = colorLuma(config.lightTextColor);
        const dark = colorLuma(config.darkTextColor);
        const contrast = (background, foreground) => (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
        const rawLight = contrast(luminance, light);
        const rawDark = contrast(luminance, dark);
        const preference = config.preference ?? 'auto';
        const preferDark = preference === 'dark';
        const hasPreference = preference !== 'auto';
        // "Ambiguous" = the two candidates score within AMBIGUOUS_RATIO of each
        // other, i.e. the background is the half-way grey where neither colour is
        // meaningfully more readable. Computed from the RAW contrasts so the
        // classification reflects what is on screen right now.
        const ambiguous = Math.max(rawLight, rawDark) < Math.min(rawLight, rawDark) * AMBIGUOUS_RATIO;
        if (config.samplePerElement) {
            // Stateless path (one decision per element): there is no single "last
            // decision" that could hold, so the only stabiliser available is the
            // preference. In the ambiguous band it decides outright; outside it the
            // measurement still wins, exactly as before.
            if (ambiguous && hasPreference)
                return preferDark ? config.darkTextColor : config.lightTextColor;
            return rawDark > rawLight ? config.darkTextColor : config.lightTextColor;
        }
        // [FIX] Hold everything still for a moment after a flip. This function is
        // driven by a screenshot of the area the text is drawn on, so for the
        // ~380ms the colour tween runs, every measurement is partly a measurement
        // of our own in-progress change — a feedback loop that can sustain the
        // ping-pong on its own even with the hysteresis below.
        const now = GLib.get_monotonic_time();
        if (this._lastIsBright !== null &&
            now - this._lastSwitchAt < SWITCH_SETTLE_MS * 1000) {
            return this._lastIsBright ? config.darkTextColor : config.lightTextColor;
        }
        const smoothed = this._lastLuma === null
            ? luminance : this._lastLuma * 0.7 + luminance * 0.3;
        this._lastLuma = smoothed;
        const lightContrast = contrast(smoothed, light);
        const darkContrast = contrast(smoothed, dark);
        const previous = this._lastIsBright;
        let isBright;
        if (previous === null) {
            // First decision for this surface. An ambiguous background is decided
            // by the preference rather than by a coin-flip-grade measurement.
            isBright = (ambiguous && hasPreference) ? preferDark : (darkContrast > lightContrast);
        }
        else if (ambiguous && hasPreference) {
            // [FIX] The oscillation zone, resolved by fiat. Inside this band the
            // preference is simply asserted; since the band is defined by the
            // measurement alone (no history), the result cannot depend on which
            // colour happens to be on screen, so it cannot oscillate.
            isBright = preferDark;
        }
        else {
            isBright = previous;
            const current = isBright ? darkContrast : lightContrast;
            const alternative = isBright ? lightContrast : darkContrast;
            // Does flipping move us TOWARDS the preferred colour or away from it?
            const alternativeIsPreferred = hasPreference && (preferDark !== isBright);
            const advantage = !hasPreference
                ? SWITCH_ADVANTAGE
                : (alternativeIsPreferred
                    ? SWITCH_ADVANTAGE_TOWARD_PREFERRED
                    : SWITCH_ADVANTAGE_AGAINST_PREFERRED);
            // A meaningful advantage prevents small sampling fluctuations changing polarity.
            if (alternative > current * advantage)
                isBright = !isBright;
        }
        // Smoothing must never delay an obvious readability correction after a
        // window/background changes. Use the current measurement for this decision.
        // This overrides the preference as well: a preference is about taste in the
        // cases where both colours work, never about keeping unreadable text.
        const rawCurrent = isBright ? rawDark : rawLight;
        const rawAlternative = isBright ? rawLight : rawDark;
        if (rawCurrent < MIN_READABLE_CONTRAST && rawAlternative >= MIN_READABLE_CONTRAST)
            isBright = !isBright;
        if (previous !== null && previous !== isBright)
            this._lastSwitchAt = now;
        this._lastIsBright = isBright;
        return isBright ? config.darkTextColor : config.lightTextColor;
    }
    async chooseColorsForActors(actors, config = AdaptiveContrastConfig) {
        const rects = [];
        const targets = [];
        for (const actor of actors) {
            const rect = _getActorRect(actor);
            if (!rect)
                continue;
            targets.push(actor);
            rects.push(rect);
        }
        const result = new Map();
        if (targets.length === 0)
            return result;
        if (!config.samplePerElement) {
            const merged = _mergeRects(rects);
            if (!merged)
                return result;
            if (!this._lastRect || ['x', 'y', 'width', 'height'].some(key => Math.abs(merged[key] - this._lastRect[key]) > 2)) {
                this._lastLuma = null;
                this._lastIsBright = null;
                this._lastSwitchAt = 0;
            }
            this._lastRect = merged;
            const luma = await this.sampleLuminance(merged);
            if (luma === null)
                return result;
            const color = this.decideTextColor(luma, config);
            if (!color)
                return result;
            for (const actor of targets)
                result.set(actor, color);
            return result;
        }
        for (let i = 0; i < targets.length; i++) {
            const luma = await this.sampleLuminance(rects[i]);
            if (luma === null)
                return result;
            const color = this.decideTextColor(luma, config);
            if (color)
                result.set(targets[i], color);
        }
        return result;
    }
}
