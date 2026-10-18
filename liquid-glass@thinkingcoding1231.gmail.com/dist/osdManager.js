import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { isActorValid } from './actors/lifecycle.js';
import { StageContrastSampler, AdaptiveContrastConfig, sanitizeColorPreference } from './contrastSampler.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { startStageLoop, stopStageLoop } from './animation/frameLoops.js';
import { setClipIfChanged } from './actors/writes.js';
import { resolveCrossFade, adaptiveColorTweener, hexToColorArray, hexToRgb, rgbToHex } from './animation/colors.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
export class OsdManager {
    extensionPath;
    _settings;
    _logger;
    _settingsSignals;
    _frameSyncId;
    _frameSignalId = 0;
    _lastTickUs = 0;
    _isEffectActive;
    _osdYOffset;
    _osdStates;
    _baseTint;
    _glassExpand;
    _monitorsChangedId;
    _contrastSampler;
    _adaptiveConfig;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _isFirstAdaptiveRun;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._osdStates = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._monitorsChangedId = 0;
        this._isEffectActive = false;
        this._contrastSampler = new StageContrastSampler();
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: true,
            samplePerElement: false,
            sampleIntervalMs: 400,
        };
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._glassExpand = 12;
        this._baseTint = 0.08;
        this._osdYOffset = 0;
        this._isFirstAdaptiveRun = true;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-osd-glass')) {
            this._applyEffect();
        }
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        connectSetting('enable-osd-glass', () => {
            let enabled = this._settings.get_boolean('enable-osd-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('osd-tint-color', () => {
            if (this._isEffectActive) {
                let colorArray = hexToColorArray(this._settings.get_string('osd-tint-color'));
                for (let state of this._osdStates) {
                    state.glass?.setTintColor(...colorArray);
                }
            }
        });
        connectSetting('osd-tint-strength', () => {
            if (this._isEffectActive) {
                this._baseTint = this._settings.get_double('osd-tint-strength');
                for (let state of this._osdStates) {
                    state._currentTint = this._baseTint;
                    state.glass?.setTintStrength(this._baseTint);
                }
            }
        });
        connectSetting('osd-blur-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_int('osd-blur-radius');
                for (let state of this._osdStates) {
                    state.glass?.setBlurRadius(radius);
                }
            }
        });
        connectSetting('osd-corner-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_double('osd-corner-radius');
                for (let state of this._osdStates) {
                    state.glass?.setCornerRadius(radius);
                }
            }
        });
        connectSetting('osd-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('osd-glass-expand');
                for (const state of this._osdStates)
                    state.glass?.queue_redraw();
            }
        });
        connectSetting('osd-brightness', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-brightness');
                for (let state of this._osdStates) {
                    state.glass?.setBrightness(v);
                }
            }
        });
        connectSetting('osd-saturation', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-saturation');
                for (let state of this._osdStates) {
                    state.glass?.setSaturation(v);
                }
            }
        });
        connectSetting('osd-contrast', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-contrast');
                for (let state of this._osdStates) {
                    state.glass?.setContrast(v);
                }
            }
        });
        connectSetting('osd-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
            if (this._adaptiveConfig.enabled)
                this._startAdaptiveColorSampling();
            else {
                this._stopAdaptiveColorSampling();
                this._clearAdaptiveStyles();
            }
        });
        connectSetting('osd-adaptive-text-preference', () => {
            this._adaptiveConfig.preference = sanitizeColorPreference(this._settings.get_string('osd-adaptive-text-preference'));
        });
        connectSetting('osd-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
        });
        connectSetting('osd-y-offset', () => {
            this._osdYOffset = this._settings.get_int('osd-y-offset');
            for (let state of this._osdStates) {
                if (state.targetBox) {
                    state.targetBox.translation_y = -this._osdYOffset;
                }
            }
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
        this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
        this._glassExpand = this._settings.get_int('osd-glass-expand');
        this._baseTint = this._settings.get_double('osd-tint-strength');
        this._osdYOffset = this._settings.get_int('osd-y-offset');
        let osdWindows = Main.osdWindowManager._osdWindows;
        if (!osdWindows)
            return;
        for (let osdWindow of osdWindows) {
            this._setupOsdEffect(osdWindow);
        }
        // One stage loop for every monitor's OSD (see DockManager's frameTick).
        const frameTick = () => {
            if (!this._isEffectActive)
                return;
            if (isFrameSyncFrozen())
                return;
            const nowUs = GLib.get_monotonic_time();
            if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US)
                return;
            this._lastTickUs = nowUs;
            for (let state of this._osdStates) {
                ensureGlassAllocated(state.glass);
                try {
                    this._syncGeometry(state);
                }
                catch (e) {
                    reportFrameLoopError('OSDManager', e);
                }
            }
        };
        startStageLoop(this._frameSignalSlot, this._frameSlot, frameTick);
        this._startAdaptiveColorSampling();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._removeEffect();
            if (this._settings.get_boolean('enable-osd-glass')) {
                this._applyEffect();
            }
        });
    }
    _setupOsdEffect(osdWindow) {
        // The OSD's 'osd-window' box, which draws its background.
        const targetBox = osdWindow._hbox ?? null;
        if (!targetBox) {
            this._logger.warn('[Liquid Glass] OSD UI container not found.');
            return;
        }
        targetBox.add_style_class_name('liquid-glass-transparent');
        targetBox.translation_y = -this._osdYOffset;
        const glass = new BackdropGlass({
            extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: 'osd',
        });
        glass.set_size(1.0, 1.0);
        glass.set_pivot_point(0.0, 0.0);
        // The OSD's ancestor that is a direct child of uiGroup.
        let osdRoot = osdWindow;
        while (osdRoot.get_parent() && osdRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = osdRoot.get_parent();
            if (!p)
                break;
            osdRoot = p;
        }
        // Below the OSD, so the glass reads the stage before the OSD is drawn.
        if (osdRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(glass, osdRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(glass);
        }
        let blurRadius = this._settings.get_int('osd-blur-radius');
        let tintColorStr = this._settings.get_string('osd-tint-color');
        let cornerRadius = this._settings.get_double('osd-corner-radius');
        let brightness = this._settings.get_double('osd-brightness');
        let saturation = this._settings.get_double('osd-saturation');
        let contrast = this._settings.get_double('osd-contrast');
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(tintColorStr));
        glass.setTintStrength(this._baseTint);
        glass.setCornerRadius(cornerRadius);
        glass.setIsDock(false);
        glass.setBrightness(brightness);
        glass.setSaturation(saturation);
        glass.setContrast(contrast);
        glass.setBlurRadius(blurRadius);
        glass.hide();
        let state = {
            osdWindow,
            targetBox,
            glass,
            _lastBgW: undefined,
            _lastBgH: undefined,
            _lastBgX: undefined,
            _lastBgY: undefined,
            _lastScreenW: undefined,
            _lastScreenH: undefined,
            _stableBaseH: undefined,
            _currentTint: this._baseTint,
            _wasVisible: false,
            _isFirstAdaptiveRun: true,
            _destroyId: 0,
        };
        this._osdStates.push(state);
        // The shell destroys the OSD window of a removed monitor.
        state._destroyId = osdWindow.connect('destroy', () => {
            this._osdStates = this._osdStates.filter(s => s !== state);
            this._destroyGlass(state);
        });
    }
    // Every frame, for one monitor's OSD.
    _syncGeometry(state) {
        const glass = state.glass;
        if (!glass || !state.targetBox)
            return;
        let [w, h] = state.targetBox.get_size();
        let [absX, absY] = state.targetBox.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        // Follow the OSD's fade.
        let osdWindowVisible = state.osdWindow.visible && state.osdWindow.mapped;
        let targetBoxVisible = state.targetBox.visible && state.targetBox.mapped;
        let currentOpacity = (osdWindowVisible && targetBoxVisible)
            ? Math.min(state.osdWindow.opacity, state.targetBox.opacity)
            : 0;
        let isVisible = currentOpacity > 0;
        if (isVisible && !state._wasVisible) {
            state._wasVisible = true;
            this._isFirstAdaptiveRun = true;
            this._contrastSampler.reset();
            this._updateAdaptiveTextColors();
        }
        else if (!isVisible && state._wasVisible) {
            state._wasVisible = false;
        }
        glass.opacity = currentOpacity;
        if (!isVisible) {
            glass.hide();
            return;
        }
        else if (!glass.visible) {
            glass.show();
        }
        const visualW = w;
        const visualH = this._osdVisualHeight(state, h);
        let visualX = absX;
        let visualY = absY;
        let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX_abs = visualX - this._glassExpand - SHADER_PADDING;
        let bgY_abs = visualY - this._glassExpand - SHADER_PADDING;
        let monitorIndex = Main.layoutManager.findIndexForActor(state.osdWindow);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        // Monitor-local, as the shader uses them.
        let localBgX = bgX_abs - monitorX;
        let localBgY = bgY_abs - monitorY;
        if (state._lastBgW !== bgW || state._lastBgH !== bgH ||
            state._lastBgX !== bgX_abs || state._lastBgY !== bgY_abs ||
            state._lastScreenW !== screenW || state._lastScreenH !== screenH) {
            glass.remove_transition('size');
            glass.remove_transition('position');
            glass.set_position(monitorX, monitorY);
            glass.set_size(screenW, screenH);
            glass.remove_transition('size');
            glass.remove_transition('position');
            // Limit drawing to the glass plus room for its shadow.
            const CLIP_PADDING = 200;
            setClipIfChanged(glass, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
            const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
            glass.setShadowMaxRadius(SHADOW_MAX_RADIUS);
            glass.setResolution(screenW, screenH);
            glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);
            state._lastBgW = bgW;
            state._lastBgH = bgH;
            state._lastBgX = bgX_abs;
            state._lastBgY = bgY_abs;
            state._lastScreenW = screenW;
            state._lastScreenH = screenH;
        }
        // After the geometry setters, so the relays cover this frame's rect.
        glass.syncSources();
    }
    _osdVisualHeight(state, h) {
        // When the icon changes, the box's height briefly includes its bottom
        // margin; that jump is ignored.
        let mB = state.targetBox.get_theme_node().get_margin(St.Side.BOTTOM);
        if (state._stableBaseH === undefined) {
            let [, naturalH] = state.targetBox.get_preferred_height(-1);
            state._stableBaseH = naturalH > 0 ? naturalH : h;
        }
        let isHeightBloated = Math.abs(h - (state._stableBaseH + mB)) <= 1;
        let visualH = isHeightBloated ? h - mB : h;
        if (!isHeightBloated)
            state._stableBaseH = h;
        return visualH;
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        if (this._monitorsChangedId !== 0) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._stopFrameSync();
        for (let state of this._osdStates) {
            this._cleanupOsdState(state);
        }
        this._osdStates = [];
    }
    _cleanupOsdState(state) {
        this._restoreOsdTarget(state);
        this._destroyGlass(state);
    }
    _destroyGlass(state) {
        const glass = state.glass;
        if (!glass)
            return;
        state.glass = null;
        glass.cleanup();
        // At shell shutdown the stage may have destroyed it already.
        if (isActorValid(glass))
            glass.destroy();
    }
    _restoreOsdTarget(state) {
        if (state.osdWindow && state._destroyId) {
            state.osdWindow.disconnect(state._destroyId);
            state._destroyId = 0;
        }
        if (state.targetBox) {
            state.targetBox.remove_style_class_name('liquid-glass-transparent');
            state.targetBox.translation_y = 0;
        }
    }
    cleanup() {
        this._stopFrameSync();
        for (let sigId of this._settingsSignals)
            this._settings.disconnect(sigId);
        this._settingsSignals = [];
        this._removeEffect();
    }
    _collectAdaptiveTextTargets() {
        let targets = [];
        for (let state of this._osdStates) {
            if (state.osdWindow && state.osdWindow.opacity > 0 && state.osdWindow.visible) {
                this._findAllTextActors(state.targetBox, targets);
            }
        }
        return targets;
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        let isProgressBar = actor instanceof St.Widget && actor.has_style_class_name('level');
        if (actor instanceof St.Label || actor instanceof Clutter.Text ||
            actor instanceof St.Button || actor instanceof St.Icon || isProgressBar) {
            if (actor.visible)
                foundActors.push(actor);
        }
        let children = actor.get_children();
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }
        return foundActors;
    }
    _setActorColor(actor, color, skipAnimations = false, batchStart) {
        // Clutter.Text targets have no St style.
        if (!(actor instanceof St.Widget))
            return;
        if (!this._styledActors.has(actor)) {
            this._styledActors.set(actor, actor.get_style() || '');
            actor.connect('destroy', () => {
                adaptiveColorTweener.cancel(actor);
                this._styledActors.delete(actor);
            });
        }
        if (actor._currentTargetColor === color)
            return;
        actor._currentTargetColor = color;
        this._animateActorColor(actor, color, 380, skipAnimations, batchStart);
    }
    _clearAdaptiveStyles() {
        for (const [actor, style] of this._styledActors.entries()) {
            adaptiveColorTweener.cancel(actor);
            actor._currentTargetColor = undefined;
            actor.set_style(style);
        }
        this._styledActors.clear();
    }
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        // One timestamp for the whole map, so label, icon and level bar move as one.
        const batchStart = GLib.get_monotonic_time();
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color, skipAnimations, batchStart);
        }
    }
    _startAdaptiveColorSampling() {
        if (!this._adaptiveConfig.enabled)
            return;
        this._updateAdaptiveTextColors();
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            let isActive = this._osdStates.some(s => s.osdWindow && s.osdWindow.visible);
            if (isActive)
                this._updateAdaptiveTextColors();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }
    _updateAdaptiveTextColors() {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        let isFirst = this._isFirstAdaptiveRun;
        this._isFirstAdaptiveRun = false;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig, null, () => this._osdStates.reduce((sum, st) => sum + (st.glass?.paintCount ?? NaN), 0), () => this._osdStates.flatMap((st) => st.glass ? [st.glass] : []))
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, isFirst);
        })
            .catch(e => {
            this._logger.error(`[Liquid Glass] OSD adaptive color update failed: ${e}`);
        })
            .finally(() => {
            this._adaptiveInFlight = false;
        });
    }
    _animateActorColor(actor, targetHexColor, durationMs = 380, skipAnimations = false, batchStart) {
        // An existing tween is not cancelled: add() restarts from the color it
        // last applied.
        const originalStyle = (this._styledActors.get(actor) || '').trim();
        const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let startBgColor = themeNode.get_background_color();
        let targetRgb = hexToRgb(targetHexColor);
        // The level bar's fill takes the text color and its track a color 70%
        // of the way to the other one.
        let isProgressBar = actor.has_style_class_name('level');
        let trackTargetRgb = targetRgb;
        if (isProgressBar) {
            let lightHex = this._adaptiveConfig?.lightTextColor || '#ffffff';
            let darkHex = this._adaptiveConfig?.darkTextColor || '#000000';
            let isTargetLight = targetHexColor.toLowerCase() === lightHex.toLowerCase();
            let otherRgb = hexToRgb(isTargetLight ? darkHex : lightHex);
            let lerpRatio = 0.7;
            trackTargetRgb = {
                r: Math.round(targetRgb.r + (otherRgb.r - targetRgb.r) * lerpRatio),
                g: Math.round(targetRgb.g + (otherRgb.g - targetRgb.g) * lerpRatio),
                b: Math.round(targetRgb.b + (otherRgb.b - targetRgb.b) * lerpRatio),
            };
        }
        // The level bar keeps the plain lerp: it is a filled shape, not a glyph, so
        // it never becomes illegible against the background it sits on, and dipping
        // it through transparent would punch a hole in the OSD instead. Its track
        // color rides the same eased progress, which is why `apply` takes one.
        const apply = (r, g, b, a, progress) => {
            if (isProgressBar) {
                const e = progress < 0.5
                    ? 2 * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                const bgR = Math.round(startBgColor.red + (trackTargetRgb.r - startBgColor.red) * e);
                const bgG = Math.round(startBgColor.green + (trackTargetRgb.g - startBgColor.green) * e);
                const bgB = Math.round(startBgColor.blue + (trackTargetRgb.b - startBgColor.blue) * e);
                actor.set_style(`${stylePrefix}-barlevel-active-background-color: ${rgbToHex(r, g, b)}; ` +
                    `-barlevel-background-color: ${rgbToHex(bgR, bgG, bgB)};`);
                return;
            }
            const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
        };
        if (skipAnimations) {
            adaptiveColorTweener.cancel(actor);
            apply(targetRgb.r, targetRgb.g, targetRgb.b, 1.0, 1.0);
            return;
        }
        const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
        const startAlpha = startColor.alpha / 255.0;
        adaptiveColorTweener.add(actor, {
            startRgb, startAlpha,
            targetRgb, targetAlpha: 1.0,
            crossFade: !isProgressBar && resolveCrossFade(startRgb, targetRgb),
            durationMs,
            apply,
            // The bar writes a second color the tuple does not describe.
            coalesce: !isProgressBar,
        }, batchStart);
    }
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
    _stopFrameSync() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
    }
}
