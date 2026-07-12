// src/osdManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager, } from './utils.js';
// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;
export class OsdManager {
    extensionPath;
    _settings;
    _settingsSignals;
    _frameSyncId;
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
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
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
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
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
                let colorArray = this._hexToColorArray(this._settings.get_string('osd-tint-color'));
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setTintColor(...colorArray);
                }
            }
        });
        connectSetting('osd-tint-strength', () => {
            if (this._isEffectActive) {
                this._baseTint = this._settings.get_double('osd-tint-strength');
                for (let state of this._osdStates) {
                    state._currentTint = this._baseTint;
                    if (state.effect)
                        state.effect.setTintStrength(this._baseTint);
                }
            }
        });
        connectSetting('osd-blur-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_int('osd-blur-radius');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setBlurRadius(radius);
                }
            }
        });
        connectSetting('osd-corner-radius', () => {
            if (this._isEffectActive) {
                let radius = this._settings.get_double('osd-corner-radius');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setCornerRadius(radius);
                }
            }
        });
        connectSetting('osd-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('osd-glass-expand');
            }
        });
        // [NEW] Brightness / Saturation / Contrast
        connectSetting('osd-brightness', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-brightness');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setBrightness(v);
                }
            }
        });
        connectSetting('osd-saturation', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-saturation');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setSaturation(v);
                }
            }
        });
        connectSetting('osd-contrast', () => {
            if (this._isEffectActive) {
                let v = this._settings.get_double('osd-contrast');
                for (let state of this._osdStates) {
                    if (state.effect)
                        state.effect.setContrast(v);
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
        // Set up each monitor's OSD independently
        for (let osdWindow of osdWindows) {
            this._setupOsdEffect(osdWindow);
        }
        // After all states exist, apply mutual exclusions so each UILayerSampler
        // does not clone the other monitors' liquid-glass bgActors
        for (let state of this._osdStates) {
            if (!state._uiSampler)
                continue;
            // Add the bgActors of all OTHER states as exclusions
            for (let other of this._osdStates) {
                if (other !== state && other.bgActor) {
                    state._uiSampler.addExclusion(other.bgActor);
                }
            }
            // Also exclude any other liquid-glass bgActors already in uiGroup
            for (let child of Main.layoutManager.uiGroup.get_children()) {
                if (child === state.bgActor)
                    continue;
                let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
                    (typeof child.get_children === 'function' &&
                        child.get_children().some((c) => c.get_name?.() === 'liquid-box'));
                if (isLiquidBg)
                    state._uiSampler.addExclusion(child);
            }
        }
        // Global frame-render loop (covers all OSD states)
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        const frameTick = () => {
            this._frameSyncId = 0;
            if (!this._isEffectActive)
                return GLib.SOURCE_REMOVE;
            for (let state of this._osdStates) {
                this._syncGeometry(state);
            }
            this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };
        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        this._startAdaptiveColorSampling();
        // Rebuild everything if monitor configuration changes
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._removeEffect();
            if (this._settings.get_boolean('enable-osd-glass')) {
                this._applyEffect();
            }
        });
    }
    _setupOsdEffect(osdWindow) {
        // ── Find the OSD's targetBox (the St.Widget with style methods) ───────────
        let targetBox = null;
        if (osdWindow._icon && osdWindow._icon.get_parent) {
            targetBox = osdWindow._icon.get_parent();
        }
        else if (typeof osdWindow.get_first_child === 'function') {
            targetBox = osdWindow.get_first_child();
        }
        if (targetBox && typeof targetBox.add_style_class_name !== 'function') {
            let children = osdWindow.get_children();
            for (let child of children) {
                if (typeof child.add_style_class_name === 'function') {
                    targetBox = child;
                    break;
                }
            }
        }
        if (!targetBox || typeof targetBox.add_style_class_name !== 'function') {
            console.warn('[Liquid Glass] OSD UI container not found.');
            return;
        }
        targetBox.add_style_class_name('liquid-glass-transparent');
        targetBox.translation_y = -this._osdYOffset;
        // ── Determine which monitor this OSD belongs to ───────────────────────────
        let monitorIndex = Main.layoutManager.findIndexForActor(osdWindow);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        // ── 1. bgActor: full monitor size, no effect ─────────────────────────────
        let bgActor = new UnpickableActor();
        bgActor.set_name('liquid-glass-bg-actor');
        bgActor.set_size(1.0, 1.0);
        bgActor.set_pivot_point(0.0, 0.0);
        // ── 2. liquidBox: outer layer — LiquidEffect with built-in dual-Kawase blur ─
        let liquidBox = new UnpickableActor();
        liquidBox.set_name('liquid-box');
        liquidBox.set_clip_to_allocation(true);
        bgActor.add_child(liquidBox);
        // dummyBreaker: prevents BMS black-screen optimization bug
        let dummyBreaker = new UnpickableActor();
        dummyBreaker.set_name('optimization-breaker');
        dummyBreaker.set_size(1.0, 1.0);
        dummyBreaker.set_opacity(0);
        liquidBox.add_child(dummyBreaker);
        // ── 3. _cloneContainer: sub-container inside liquidBox ────────────────────
        let cloneContainer = new UnpickableActor();
        cloneContainer.set_name('clone-container');
        liquidBox.add_child(cloneContainer);
        // ── Find the OSD's ancestor that is a direct child of uiGroup ────────────
        let osdRoot = osdWindow;
        while (osdRoot.get_parent() && osdRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = osdRoot.get_parent();
            if (!p)
                break;
            osdRoot = p;
        }
        // Insert bgActor below the OSD root in uiGroup
        if (osdRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(bgActor, osdRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(bgActor);
        }
        // ── 4. Read effect parameters ─────────────────────────────────────────────
        let blurRadius = this._settings.get_int('osd-blur-radius');
        let tintColorStr = this._settings.get_string('osd-tint-color');
        let cornerRadius = this._settings.get_double('osd-corner-radius');
        let brightness = this._settings.get_double('osd-brightness');
        let saturation = this._settings.get_double('osd-saturation');
        let contrast = this._settings.get_double('osd-contrast');
        // LiquidEffect on liquidBox (includes built-in dual-Kawase blur)
        let effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        effect.setPadding(SHADER_PADDING);
        effect.setTintColor(...this._hexToColorArray(tintColorStr));
        effect.setTintStrength(this._baseTint);
        effect.setCornerRadius(cornerRadius);
        effect.setIsDock(false);
        effect.setBrightness(brightness);
        effect.setSaturation(saturation);
        effect.setContrast(contrast);
        effect.setBlurRadius(blurRadius);
        liquidBox.add_effect(effect);
        bgActor.show();
        // ── 5. WindowCloneManager + UILayerSampler ────────────────────────────────
        let windowCloneManager = new WindowCloneManager(liquidBox, cloneContainer);
        let uiSampler = new UILayerSampler(bgActor, liquidBox, [osdRoot, global.windowGroup, global.window_group], cloneContainer);
        // ── 7. Build initial clones ───────────────────────────────────────────────
        windowCloneManager.rebuildClones();
        uiSampler.rebindSelf();
        uiSampler.refresh();
        // ── 6. Compose the state object ───────────────────────────────────────────
        let state = {
            osdWindow,
            targetBox,
            bgActor,
            liquidBox,
            _cloneContainer: cloneContainer,
            effect,
            _windowCloneManager: windowCloneManager,
            _uiSampler: uiSampler,
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
        // When the OSD window itself is destroyed, clean up our matching state
        state._destroyId = osdWindow.connect('destroy', () => {
            this._osdStates = this._osdStates.filter(s => s !== state);
            // effect must be cleaned up before bgActor.destroy()
            if (state.effect) {
                try {
                    state.effect.cleanup();
                }
                catch (e) { }
                state.effect = null;
            }
            if (state.bgActor) {
                try {
                    state.bgActor.destroy();
                }
                catch (e) { }
                state.bgActor = null;
            }
            state._uiSampler?.destroy();
            state._windowCloneManager?.destroy();
        });
    }
    // ── Per-state geometry synchronisation ─────────────────────────────────────
    // Full-screen FBO approach: bgActor covers the full monitor, shader is told
    // where the OSD lives within that FBO via setGlassGeometry().
    _syncGeometry(state) {
        if (!state.bgActor || !state.targetBox)
            return;
        let [w, h] = state.targetBox.get_size();
        let [absX, absY] = state.targetBox.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        // Respect GNOME's OSD fade animation.
        //
        // [FIX] Previously this only looked at targetBox's opacity/visible. After
        // a suspend/resume cycle the outer osdWindow itself can end up hidden or
        // unmapped while its opacity and targetBox's visibility still hold stale
        // "visible" values from before suspend — so bgActor was never told to
        // hide, and the Liquid Glass background stayed on screen indefinitely
        // even though the OSD content itself was gone. Gate visibility on the
        // osdWindow's own visible/mapped state as well, not just targetBox's.
        let osdWindowVisible = state.osdWindow.visible && state.osdWindow.mapped;
        let targetBoxVisible = state.targetBox.visible && state.targetBox.mapped;
        let currentOpacity = (osdWindowVisible && targetBoxVisible)
            ? Math.min(state.osdWindow.opacity, state.targetBox.opacity)
            : 0;
        let isVisible = currentOpacity > 0;
        if (isVisible && !state._wasVisible) {
            state._wasVisible = true;
            this._isFirstAdaptiveRun = true;
            this._updateAdaptiveTextColors();
        }
        else if (!isVisible && state._wasVisible) {
            state._wasVisible = false;
        }
        state.bgActor.opacity = currentOpacity;
        if (!isVisible) {
            state.bgActor.hide();
            return;
        }
        else if (!state.bgActor.visible) {
            state.bgActor.show();
        }
        // OSD-specific margin-bottom bloat compensation (icon switch glitch)
        let themeNode = state.targetBox.get_theme_node();
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        if (state._stableBaseH === undefined)
            state._stableBaseH = h;
        let isHeightBloated = Math.abs(h - (state._stableBaseH + mB)) <= 1;
        let visualW = w;
        let visualH = isHeightBloated ? h - mB : h;
        if (!isHeightBloated)
            state._stableBaseH = h;
        let visualX = absX;
        let visualY = absY;
        let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX_abs = visualX - this._glassExpand - SHADER_PADDING;
        let bgY_abs = visualY - this._glassExpand - SHADER_PADDING;
        // ── Monitor geometry ─────────────────────────────────────────────────────
        let monitorIndex = Main.layoutManager.findIndexForActor(state.osdWindow);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        // Monitor-local shader coordinates
        let localBgX = bgX_abs - monitorX;
        let localBgY = bgY_abs - monitorY;
        // ── Update actors only when geometry changed ─────────────────────────────
        if (state._lastBgW !== bgW || state._lastBgH !== bgH ||
            state._lastBgX !== bgX_abs || state._lastBgY !== bgY_abs ||
            state._lastScreenW !== screenW || state._lastScreenH !== screenH) {
            // bgActor: full monitor size, positioned at monitor origin
            state.bgActor.remove_transition('size');
            state.bgActor.remove_transition('position');
            state.bgActor.set_position(monitorX, monitorY);
            state.bgActor.set_size(screenW, screenH);
            state.bgActor.remove_transition('size');
            state.bgActor.remove_transition('position');
            // liquidBox fills the entire bgActor
            state.liquidBox?.set_position(0, 0);
            state.liquidBox?.set_size(screenW, screenH);
            // Soft clip — limits GPU work to the OSD area + generous margin
            const CLIP_PADDING = 200;
            state.liquidBox?.remove_clip();
            state.bgActor.set_clip(localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
            // Inform shader of full-screen resolution and OSD position within FBO
            state.effect?.setResolution(screenW, screenH);
            state.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
            state._lastBgW = bgW;
            state._lastBgH = bgH;
            state._lastBgX = bgX_abs;
            state._lastBgY = bgY_abs;
            state._lastScreenW = screenW;
            state._lastScreenH = screenH;
        }
        // ── Sync clones every frame (dockManager pattern) ────────────────────────
        state._windowCloneManager?.setOffset(-monitorX, -monitorY);
        state._uiSampler?.refresh();
        state._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
        state._windowCloneManager?.sync();
    }
    // ── Effect remove / cleanup ─────────────────────────────────────────────────
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
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        for (let state of this._osdStates) {
            this._cleanupOsdState(state);
        }
        this._osdStates = [];
    }
    _cleanupOsdState(state) {
        // [FIX] This used to gate every step below on an isDisposed() helper
        // defined as `Object.getOwnPropertyNames(obj).length === 0`. That is not
        // a reliable way to tell whether a GObject/Clutter actor has been
        // disposed — a perfectly live actor can have no JS-owned properties at
        // all — so it could misclassify a live actor as "disposed" and skip its
        // cleanup entirely. In practice that caused two symptoms:
        //   1. targetBox.remove_style_class_name('liquid-glass-transparent')
        //      being skipped, leaving the OSD's own background permanently
        //      transparent after the glass effect was turned off.
        //   2. bgActor.destroy() being skipped, leaving a stale glass background
        //      actor stuck on screen (most visible after suspend/resume).
        // Every step here is already wrapped in try/catch, so it's safe to
        // always attempt it rather than pre-checking disposal state.
        // Disconnect destroy watcher
        if (state.osdWindow && state._destroyId) {
            try {
                state.osdWindow.disconnect(state._destroyId);
            }
            catch (e) { }
            state._destroyId = 0;
        }
        // Restore target box
        if (state.targetBox) {
            try {
                state.targetBox.remove_style_class_name('liquid-glass-transparent');
                state.targetBox.translation_y = 0;
            }
            catch (e) { }
        }
        // DESTROY EFFECT FIRST (before bgActor.destroy())
        if (state.effect) {
            try {
                state.effect.cleanup();
            }
            catch (e) { }
            state.effect = null;
        }
        // DESTROY ACTOR HIERARCHY — cascades through liquidBox → _cloneContainer
        if (state.bgActor) {
            try {
                state.bgActor.hide();
            }
            catch (e) { }
            try {
                state.bgActor.destroy();
            }
            catch (e) { }
            state.bgActor = null;
        }
        state.liquidBox = null;
        state._cloneContainer = null;
        // Clean up managers
        try {
            state._uiSampler?.destroy();
        }
        catch (e) { }
        state._uiSampler = null;
        try {
            state._windowCloneManager?.destroy();
        }
        catch (e) { }
        state._windowCloneManager = null;
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            this._settings.disconnect(sigId);
        }
        this._settingsSignals = [];
        this._removeEffect();
    }
    // ── Adaptive text colour helpers ────────────────────────────────────────────
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
        let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');
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
    _setActorColor(actor, color, skipAnimations = false) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
        if (actor._currentTargetColor === color)
            return;
        actor._currentTargetColor = color;
        this._animateActorColor(actor, color, 380, skipAnimations);
    }
    _clearAdaptiveStyles() {
        for (const [actor, style] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                actor.set_style(style);
            }
        }
        this._styledActors.clear();
    }
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color, skipAnimations);
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
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, isFirst);
        })
            .catch(e => {
            console.error(`[Liquid Glass] OSD adaptive color update failed: ${e}`);
        })
            .finally(() => {
            this._adaptiveInFlight = false;
        });
    }
    _hexToRgb(hex) {
        let bigint = parseInt(hex.replace('#', ''), 16);
        return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
    }
    _rgbToHex(r, g, b) {
        return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
    }
    _animateActorColor(actor, targetHexColor, durationMs = 380, skipAnimations = false) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = undefined;
        }
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let startBgColor = themeNode.get_background_color();
        let targetRgb = this._hexToRgb(targetHexColor);
        // OSD-specific: BarLevel progress bar colour interpolation
        let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');
        let trackTargetRgb = targetRgb;
        if (isProgressBar) {
            let lightHex = this._adaptiveConfig?.lightTextColor || '#ffffff';
            let darkHex = this._adaptiveConfig?.darkTextColor || '#000000';
            let isTargetLight = targetHexColor.toLowerCase() === lightHex.toLowerCase();
            let otherRgb = this._hexToRgb(isTargetLight ? darkHex : lightHex);
            let lerpRatio = 0.7;
            trackTargetRgb = {
                r: Math.round(targetRgb.r + (otherRgb.r - targetRgb.r) * lerpRatio),
                g: Math.round(targetRgb.g + (otherRgb.g - targetRgb.g) * lerpRatio),
                b: Math.round(targetRgb.b + (otherRgb.b - targetRgb.b) * lerpRatio),
            };
        }
        if (skipAnimations) {
            let finalHex = this._rgbToHex(targetRgb.r, targetRgb.g, targetRgb.b);
            if (isProgressBar) {
                let finalBgHex = this._rgbToHex(trackTargetRgb.r, trackTargetRgb.g, trackTargetRgb.b);
                actor.set_style(`-barlevel-active-background-color: ${finalHex}; -barlevel-background-color: ${finalBgHex};`);
            }
            else {
                actor.set_style(`color: ${finalHex}; -st-icon-foreground-color: ${finalHex};`);
            }
            return;
        }
        let startTime = GLib.get_monotonic_time();
        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!actor || Object.keys(actor).length === 0)
                return GLib.SOURCE_REMOVE;
            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);
            let ease = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * ease);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * ease);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * ease);
            let currentHex = this._rgbToHex(r, g, b);
            if (isProgressBar) {
                let bgR = Math.round(startBgColor.red + (trackTargetRgb.r - startBgColor.red) * ease);
                let bgG = Math.round(startBgColor.green + (trackTargetRgb.g - startBgColor.green) * ease);
                let bgB = Math.round(startBgColor.blue + (trackTargetRgb.b - startBgColor.blue) * ease);
                actor.set_style(`-barlevel-active-background-color: ${currentHex}; -barlevel-background-color: ${this._rgbToHex(bgR, bgG, bgB)};`);
            }
            else {
                actor.set_style(`color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);
            }
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    _laterAdd(laterType, callback) {
        return global.compositor?.get_laters?.().add(laterType, callback);
    }
}
