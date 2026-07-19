// src/notificationManager.ts
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
const HIDE_SAFETY_MARGIN = 7;
export class NotificationManager {
    extensionPath;
    _settings;
    _logger;
    tray;
    currentBanner = null;
    // Full-screen FBO actor hierarchy (matches dockManager pattern)
    //   bgActor (full monitor, no effect)
    //     └─ liquidBox  ← LiquidEffect with built-in dual-Kawase blur
    //          ├─ _cloneContainer ← WindowCloneManager + UILayerSampler deposits here
    //          └─ dummyBreaker (prevents BMS black-screen optimization bug)
    bgActor = null;
    liquidBox = null;
    _cloneContainer = null;
    effect = null;
    _windowCloneManager = null;
    _uiSampler = null;
    _signals;
    _settingsSignals;
    _frameSyncId;
    _isEffectActive;
    _stableBaseW;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastScreenW;
    _lastScreenH;
    _contrastSampler;
    _adaptiveConfig;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _glassExpand;
    _baseTint;
    _currentTint;
    _notificationYOffset;
    _isFirstAdaptiveRun = true;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this.tray = Main.messageTray;
        this._signals = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
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
        this._currentTint = 0.08;
        this._notificationYOffset = 10;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-notification-glass')) {
            this._applyEffect();
        }
    }
    // Utility: Convert HEX color string to normalized RGB array
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
        connectSetting('enable-notification-glass', () => {
            let enabled = this._settings.get_boolean('enable-notification-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('notification-tint-color', () => {
            if (this.effect && this._isEffectActive) {
                let colorArray = this._hexToColorArray(this._settings.get_string('notification-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting('notification-tint-strength', () => {
            if (this.effect && this._isEffectActive) {
                this._baseTint = this._settings.get_double('notification-tint-strength');
                this._currentTint = this._baseTint;
                this.effect.setTintStrength(this._baseTint);
            }
        });
        connectSetting('notification-blur-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setBlurRadius(this._settings.get_int('notification-blur-radius'));
            }
        });
        connectSetting('notification-corner-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setCornerRadius(this._settings.get_double('notification-corner-radius'));
            }
        });
        connectSetting('notification-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('notification-glass-expand');
            }
        });
        // Brightness / Saturation / Contrast — dynamic application from settings
        connectSetting('notification-brightness', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setBrightness(this._settings.get_double('notification-brightness'));
            }
        });
        connectSetting('notification-saturation', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setSaturation(this._settings.get_double('notification-saturation'));
            }
        });
        connectSetting('notification-contrast', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setContrast(this._settings.get_double('notification-contrast'));
            }
        });
        connectSetting('notification-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
        });
        connectSetting('notification-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
        });
        connectSetting('notification-y-offset', () => {
            this._notificationYOffset = this._settings.get_int('notification-y-offset');
        });
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        // @ts-expect-error: _bannerBin is an internal property
        let bannerBin = this.tray._bannerBin;
        if (!bannerBin) {
            this._logger.error('[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.');
            return;
        }
        // Apply settings initially
        this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
        this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
        this._glassExpand = this._settings.get_int('notification-glass-expand');
        this._baseTint = this._settings.get_double('notification-tint-strength');
        this._currentTint = this._baseTint;
        this._notificationYOffset = this._settings.get_int('notification-y-offset');
        // Listen for new notifications
        this._signals.push(bannerBin.connect('child-added', (container, actor) => {
            if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor')
                return;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                // @ts-expect-error: _banner is an internal property
                let banner = this.tray._banner || actor;
                if (banner && banner !== this.currentBanner) {
                    this._cleanupCurrentBanner();
                    this.currentBanner = banner;
                    this._setupBannerEffect(banner);
                }
                return GLib.SOURCE_REMOVE;
            });
        }));
        this._signals.push(bannerBin.connect('child-removed', (container, actor) => {
            if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor')
                return;
            this._cleanupCurrentBanner();
        }));
        // @ts-expect-error
        if (this.tray._banner) {
            // @ts-expect-error
            this.currentBanner = this.tray._banner;
            // @ts-expect-error
            this._setupBannerEffect(this.tray._banner);
        }
    }
    _setupBannerEffect(targetActor) {
        targetActor.add_style_class_name('liquid-glass-transparent');
        // @ts-expect-error
        if (this.tray._bannerBin) {
            // @ts-expect-error
            this.tray._bannerBin.translation_y = this._settings.get_int('notification-y-offset');
        }
        // ── 1. bgActor: full monitor, no effect ──────────────────────────────────
        this.bgActor = new UnpickableActor();
        this.bgActor.set_name('liquid-glass-bg-actor');
        this.bgActor.set_size(1.0, 1.0);
        this.bgActor.set_pivot_point(0.0, 0.0);
        // ── 2. liquidBox: outer layer — LiquidEffect with built-in dual-Kawase blur ─
        this.liquidBox = new UnpickableActor();
        this.liquidBox.set_name('liquid-box');
        this.liquidBox.set_clip_to_allocation(true);
        this.bgActor.add_child(this.liquidBox);
        // dummyBreaker: prevents BMS black-screen optimization bug
        let dummyBreaker = new UnpickableActor();
        dummyBreaker.set_name('optimization-breaker');
        dummyBreaker.set_size(1.0, 1.0);
        dummyBreaker.set_opacity(0);
        this.liquidBox.add_child(dummyBreaker);
        // ── 3. _cloneContainer: sub-container inside liquidBox ────────────────────
        this._cloneContainer = new UnpickableActor();
        this._cloneContainer.set_name('clone-container');
        this.liquidBox.add_child(this._cloneContainer);
        // ── Find the bannerBin's ancestor that is a direct child of uiGroup ──────
        // @ts-expect-error
        let bannerBin = this.tray._bannerBin;
        let bannerRoot = bannerBin ?? targetActor;
        while (bannerRoot.get_parent() && bannerRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = bannerRoot.get_parent();
            if (!p)
                break;
            bannerRoot = p;
        }
        // Insert bgActor below the notification root in uiGroup to prevent recursive
        // clone loops (same pattern as dockManager / uiManager)
        if (bannerRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, bannerRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        // ── 4. Read effect parameters from settings ───────────────────────────────
        let blurRadius = this._settings.get_int('notification-blur-radius');
        let tintColorStr = this._settings.get_string('notification-tint-color');
        let cornerRadius = this._settings.get_double('notification-corner-radius');
        let tintStrength = this._settings.get_double('notification-tint-strength');
        let brightness = this._settings.get_double('notification-brightness');
        let saturation = this._settings.get_double('notification-saturation');
        let contrast = this._settings.get_double('notification-contrast');
        this._baseTint = tintStrength;
        // LiquidEffect on liquidBox (includes built-in dual-Kawase blur)
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
        this.effect.setTintStrength(this._baseTint);
        this.effect.setCornerRadius(cornerRadius);
        this.effect.setIsDock(false);
        this.effect.setBrightness(brightness);
        this.effect.setSaturation(saturation);
        this.effect.setContrast(contrast);
        this.effect.setBlurRadius(blurRadius);
        this.liquidBox.add_effect(this.effect);
        // ── 5. WindowCloneManager + UILayerSampler ────────────────────────────────
        this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer);
        this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [bannerRoot, global.windowGroup, global.window_group], this._cloneContainer);
        this.bgActor.show();
        // Initial clone build (also applies liquid-glass mutual exclusions)
        this._buildClones();
        // ── 7. Frame-render loop ──────────────────────────────────────────────────
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        const frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.currentBanner)
                return GLib.SOURCE_REMOVE;
            this._syncGeometry();
            // Hover tint animation (notification-specific behaviour preserved)
            let isHovered = this.currentBanner.hover;
            let targetTint = isHovered ? (this._baseTint + 0.1) : this._baseTint;
            if (Math.abs(this._currentTint - targetTint) > 0.001) {
                this._currentTint += (targetTint - this._currentTint) * 0.1;
                this.effect?.setTintStrength(this._currentTint);
            }
            this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };
        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        this._isFirstAdaptiveRun = true;
        this._startAdaptiveColorSampling();
    }
    // ── Geometry synchronisation ────────────────────────────────────────────────
    // Called every frame. Uses full-screen FBO architecture so that BMS coordinate
    // assumptions are satisfied (all actors cover the entire monitor).
    _syncGeometry() {
        if (!this.bgActor || !this.currentBanner)
            return;
        let [w, h] = this.currentBanner.get_size();
        let [absX, absY] = this.currentBanner.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        this.bgActor.opacity = this.currentBanner.opacity;
        let themeNode = this.currentBanner.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        // Hide when the notification banner has slid completely off-screen
        if (absY + h <= mB + HIDE_SAFETY_MARGIN) {
            this.bgActor.hide();
            return;
        }
        else if (!this.bgActor.visible) {
            this.bgActor.show();
        }
        // Margin-bloat compensation (same logic as before, now used only for shader geometry)
        let marginW = mL + mR;
        let marginH = mT + mB;
        if (this._stableBaseW === undefined) {
            this._stableBaseW = w;
        }
        if (Math.abs(this._stableBaseW - (w + marginW)) <= 1) {
            this._stableBaseW = w;
        }
        let isBloated = Math.abs(w - (this._stableBaseW + marginW)) <= 1;
        let visualW = isBloated ? w - marginW : w;
        let visualH = isBloated ? h - marginH : h;
        if (!isBloated)
            this._stableBaseW = w;
        let visualX = absX;
        let visualY = absY;
        let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX_abs = visualX - this._glassExpand - SHADER_PADDING;
        let bgY_abs = visualY - this._glassExpand - SHADER_PADDING;
        // ── Monitor geometry ─────────────────────────────────────────────────────
        let monitorIndex = Main.layoutManager.findIndexForActor(this.tray);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        // Monitor-local coordinates (shader uses these)
        let localBgX = bgX_abs - monitorX;
        let localBgY = bgY_abs - monitorY;
        // ── Update actors only when geometry actually changed ────────────────────
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== bgX_abs || this._lastBgY !== bgY_abs ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH) {
            // bgActor: full monitor size, positioned at monitor origin
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            this.bgActor.set_position(monitorX, monitorY);
            this.bgActor.set_size(screenW, screenH);
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            // liquidBox fills the entire bgActor
            this.liquidBox?.set_position(0, 0);
            this.liquidBox?.set_size(screenW, screenH);
            // Soft clip — limits GPU work to the notification area + generous margin
            const CLIP_PADDING = 200;
            this.liquidBox?.remove_clip();
            this.bgActor.set_clip(localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
            const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
            this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
            // Inform the shader of the full-screen resolution and where the
            // notification lives within the FBO (mirrors dockManager.setGlassGeometry)
            this.effect?.setResolution(screenW, screenH);
            this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX_abs;
            this._lastBgY = bgY_abs;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        // ── Sync clones every frame (dockManager pattern) ────────────────────────
        this._windowCloneManager?.setOffset(-monitorX, -monitorY);
        this._uiSampler?.refresh();
        this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
        this._windowCloneManager?.sync();
    }
    // Called once when the banner effect is first set up (and after monitor changes).
    // Applies mutual exclusions between multiple Liquid Glass bgActors, then
    // delegates clone construction to WindowCloneManager + UILayerSampler.
    _buildClones() {
        if (!this.bgActor)
            return;
        if (this._uiSampler) {
            for (let child of Main.layoutManager.uiGroup.get_children()) {
                if (child === this.bgActor)
                    continue;
                let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
                    (typeof child.get_children === 'function' &&
                        child.get_children().some((c) => c.get_name?.() === 'liquid-box'));
                if (isLiquidBg)
                    this._uiSampler.addExclusion(child);
            }
        }
        this._windowCloneManager?.rebuildClones();
        this._uiSampler?.rebindSelf();
        this._uiSampler?.refresh();
    }
    // ── Per-banner cleanup ──────────────────────────────────────────────────────
    _cleanupCurrentBanner() {
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        // @ts-expect-error
        if (this.tray._bannerBin) {
            // @ts-expect-error
            this.tray._bannerBin.translation_y = 0;
        }
        if (this.currentBanner) {
            this.currentBanner.remove_style_class_name('liquid-glass-transparent');
            this.currentBanner.translation_y = 0;
            this.currentBanner = null;
        }
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        // DESTROY EFFECT FIRST (must happen before bgActor.destroy())
        if (this.effect) {
            this.effect.cleanup();
            this.effect = null;
        }
        // DESTROY ACTOR HIERARCHY — bgActor.destroy() cascades through
        // liquidBox → _cloneContainer and all their children.
        if (this.bgActor) {
            this.bgActor.destroy();
            this.bgActor = null;
        }
        this.liquidBox = null;
        this._cloneContainer = null;
        // Clean up managers (their destroy() guards against already-destroyed actors)
        this._uiSampler?.destroy();
        this._uiSampler = null;
        this._windowCloneManager?.destroy();
        this._windowCloneManager = null;
        // Reset cached geometry state
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
        this._lastScreenW = undefined;
        this._lastScreenH = undefined;
        this._stableBaseW = undefined;
        this._isFirstAdaptiveRun = true;
    }
    // ── Effect remove / cleanup ─────────────────────────────────────────────────
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        // @ts-expect-error
        let bannerBin = this.tray._bannerBin;
        for (let sigId of this._signals) {
            try {
                bannerBin.disconnect(sigId);
            }
            catch (e) { }
        }
        this._signals = [];
        this._cleanupCurrentBanner();
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            this._settings.disconnect(sigId);
        }
        this._settingsSignals = [];
        this._removeEffect();
    }
    // ── Adaptive text colour helpers (unchanged logic) ──────────────────────────
    _collectAdaptiveTextTargets(actor = this.currentBanner, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(actor);
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
                if (actor._colorTweenId !== undefined) {
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
            if (!this.currentBanner || !this.bgActor) {
                this._adaptiveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
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
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button) {
            if (actor.visible)
                foundActors.push(actor);
        }
        let children = actor.get_children();
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }
        return foundActors;
    }
    _updateAdaptiveTextColors() {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        let [absX, absY] = this.currentBanner?.get_transformed_position() ?? [0, 0];
        if (absY < 0)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, this._isFirstAdaptiveRun);
            this._isFirstAdaptiveRun = false;
        })
            .catch(e => {
            this._logger.error(`[Liquid Glass] Notification adaptive color update failed: ${e}`);
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
        let targetRgb = this._hexToRgb(targetHexColor);
        let startTime = GLib.get_monotonic_time();
        if (skipAnimations) {
            actor.set_style(`color: ${targetHexColor}; -st-icon-foreground-color: ${targetHexColor};`);
            return;
        }
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
            actor.set_style(`color: ${this._rgbToHex(r, g, b)}; -st-icon-foreground-color: ${this._rgbToHex(r, g, b)};`);
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    _hasStyleClass(actor, className) {
        return typeof actor?.has_style_class_name === 'function' &&
            actor.has_style_class_name(className);
    }
    _laterAdd(laterType, callback) {
        return global.compositor?.get_laters?.().add(laterType, callback);
    }
}
