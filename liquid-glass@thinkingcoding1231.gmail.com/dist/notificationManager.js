import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { isActorValid } from './actors/lifecycle.js';
import { addFrameTicker, removeFrameTicker } from './animation/frameTicker.js';
import { StageContrastSampler, AdaptiveContrastConfig, sanitizeColorPreference } from './contrastSampler.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { getTransformedRect, resolveMonitorGeometry } from './actors/geometry.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { setClipIfChanged } from './actors/writes.js';
import { resolveCrossFade, adaptiveColorTweener, hexToColorArray, hexToRgb } from './animation/colors.js';
import { BANNER_TRANSPARENT_CLASS } from './shellVersion.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
export class NotificationManager {
    extensionPath;
    _settings;
    _logger;
    tray;
    currentBanner = null;
    // Monitor-sized; see _syncGeometry().
    glass = null;
    _signals;
    _settingsSignals;
    _frameSyncId;
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    _frameSignalId = 0;
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
    _tintTickId = 0;
    _isEffectActive;
    _bannerIdleId = 0;
    _pendingBanner = null;
    _bannerGeneration = 0;
    _originalBannerOffset = 0;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastScreenW;
    _lastScreenH;
    // The monitor origin from the last _syncGeometry(), for _syncGlassGeometryLive().
    _liveMonitorOrigin = null;
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
            if (this.glass && this._isEffectActive) {
                let colorArray = hexToColorArray(this._settings.get_string('notification-tint-color'));
                this.glass.setTintColor(...colorArray);
            }
        });
        connectSetting('notification-tint-strength', () => {
            if (this.glass && this._isEffectActive) {
                this._baseTint = this._settings.get_double('notification-tint-strength');
                this._currentTint = this._baseTint;
                this.glass.setTintStrength(this._baseTint);
            }
        });
        connectSetting('notification-blur-radius', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setBlurRadius(this._settings.get_int('notification-blur-radius'));
            }
        });
        connectSetting('notification-corner-radius', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setCornerRadius(this._settings.get_double('notification-corner-radius'));
            }
        });
        connectSetting('notification-glass-expand', () => {
            if (this._isEffectActive) {
                this._glassExpand = this._settings.get_int('notification-glass-expand');
            }
        });
        connectSetting('notification-brightness', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setBrightness(this._settings.get_double('notification-brightness'));
            }
        });
        connectSetting('notification-saturation', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setSaturation(this._settings.get_double('notification-saturation'));
            }
        });
        connectSetting('notification-contrast', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setContrast(this._settings.get_double('notification-contrast'));
            }
        });
        connectSetting('notification-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
        });
        connectSetting('notification-adaptive-text-preference', () => {
            this._adaptiveConfig.preference = sanitizeColorPreference(this._settings.get_string('notification-adaptive-text-preference'));
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
        // @ts-expect-error: _bannerBin is an internal property
        let bannerBin = this.tray._bannerBin;
        if (!bannerBin) {
            this._logger.error('[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.');
            return;
        }
        this._isEffectActive = true;
        this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
        this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
        this._glassExpand = this._settings.get_int('notification-glass-expand');
        this._baseTint = this._settings.get_double('notification-tint-strength');
        this._currentTint = this._baseTint;
        this._notificationYOffset = this._settings.get_int('notification-y-offset');
        this._signals.push(bannerBin.connect('child-added', (container, actor) => {
            if (actor.get_name() === 'liquid-glass-bg-actor')
                return;
            if (this._bannerIdleId)
                GLib.Source.remove(this._bannerIdleId);
            this._pendingBanner = actor;
            this._bannerIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._bannerIdleId = 0;
                this._pendingBanner = null;
                // A queued setup may outlive the notification or the effect toggle.
                if (!this._isEffectActive || actor.get_parent() !== bannerBin)
                    return GLib.SOURCE_REMOVE;
                if (actor !== this.currentBanner) {
                    this._cleanupCurrentBanner();
                    this.currentBanner = actor;
                    this._setupBannerEffect(actor);
                }
                return GLib.SOURCE_REMOVE;
            });
        }));
        this._signals.push(bannerBin.connect('child-removed', (container, actor) => {
            if (actor.get_name() === 'liquid-glass-bg-actor')
                return;
            if (actor === this._pendingBanner) {
                if (this._bannerIdleId)
                    GLib.Source.remove(this._bannerIdleId);
                this._bannerIdleId = 0;
                this._pendingBanner = null;
            }
            if (actor === this.currentBanner)
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
        targetActor.add_style_class_name(BANNER_TRANSPARENT_CLASS);
        // @ts-expect-error
        if (this.tray._bannerBin) {
            // @ts-expect-error
            this._originalBannerOffset = this.tray._bannerBin.translation_y;
            // @ts-expect-error: shell-owned container
            this.tray._bannerBin.translation_y = this._originalBannerOffset + this._notificationYOffset;
        }
        const glass = new BackdropGlass({
            extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: 'notification',
        });
        this.glass = glass;
        glass.set_size(1.0, 1.0);
        glass.hide();
        glass.set_pivot_point(0.0, 0.0);
        // The banner's ancestor that is a direct child of uiGroup.
        // @ts-expect-error: _bannerBin is an internal property
        let bannerBin = this.tray._bannerBin;
        let bannerRoot = bannerBin ?? targetActor;
        while (bannerRoot.get_parent() && bannerRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = bannerRoot.get_parent();
            if (!p)
                break;
            bannerRoot = p;
        }
        // Below the banner, so the glass reads the stage before the banner is
        // drawn.
        if (bannerRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(glass, bannerRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(glass);
        }
        let blurRadius = this._settings.get_int('notification-blur-radius');
        let tintColorStr = this._settings.get_string('notification-tint-color');
        let cornerRadius = this._settings.get_double('notification-corner-radius');
        let tintStrength = this._settings.get_double('notification-tint-strength');
        let brightness = this._settings.get_double('notification-brightness');
        let saturation = this._settings.get_double('notification-saturation');
        let contrast = this._settings.get_double('notification-contrast');
        this._baseTint = tintStrength;
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(tintColorStr));
        glass.setTintStrength(this._baseTint);
        glass.setCornerRadius(cornerRadius);
        glass.setIsDock(false);
        glass.setBrightness(brightness);
        glass.setSaturation(saturation);
        glass.setContrast(contrast);
        glass.setBlurRadius(blurRadius);
        // The banner slides in by relayout, so the frame tick sees last frame's
        // position; the paint-time hook corrects it.
        glass.setLiveGeometryHook(() => this._syncGlassGeometryLive());
        // The first geometry sync shows the glass.
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this.glass && !!this.currentBanner,
            honourFreeze: true,
            errorTag: 'NotificationManager',
            step: () => {
                // Checked before this frame's sync dirties anything.
                ensureGlassAllocated(this.glass);
                this._syncGeometry();
                this._syncHoverTint();
            },
        });
        this._isFirstAdaptiveRun = true;
        this._contrastSampler.reset();
        this._startAdaptiveColorSampling();
    }
    _hoverTint() {
        return this.currentBanner?.hover ? this._baseTint + 0.1 : this._baseTint;
    }
    // Slightly stronger tint while hovered, eased over a few frames. The sync
    // loop only runs on frames something else asked for, so the easing keeps
    // its own ticker until it settles.
    _syncHoverTint() {
        if (this._tintTickId || Math.abs(this._currentTint - this._hoverTint()) <= 0.001)
            return;
        this._tintTickId = addFrameTicker(() => {
            if (!this.currentBanner || !this.glass) {
                this._tintTickId = 0;
                return false;
            }
            const target = this._hoverTint();
            this._currentTint += (target - this._currentTint) * 0.1;
            this.glass.setTintStrength(this._currentTint);
            if (Math.abs(this._currentTint - target) > 0.001)
                return true;
            this._tintTickId = 0;
            return false;
        });
    }
    _stopHoverTint() {
        if (!this._tintTickId)
            return;
        removeFrameTicker(this._tintTickId);
        this._tintTickId = 0;
    }
    // Every frame. The glass covers the banner's monitor; the shader draws only
    // the glass rect.
    _syncGeometry() {
        if (!this.glass || !this.currentBanner)
            return;
        // Keep the offset on the same parent GNOME animates, never on the glass
        // alone. Written only on change: Clutter queues a redraw even for the
        // same value, and this runs in before-update, so every write would ask
        // for another frame.
        // @ts-expect-error: shell-owned container
        const bannerBin = this.tray._bannerBin;
        const offset = Math.fround(this._originalBannerOffset + this._notificationYOffset);
        if (bannerBin.translation_y !== offset)
            bannerBin.translation_y = offset;
        // GNOME animates opacity and scale on _bannerBin, not on the banner.
        // Both the origin and size must include that ancestor transform.
        const [absX, absY, w, h] = getTransformedRect(this.currentBanner);
        const opacity = this.currentBanner.get_paint_opacity();
        if (!this.currentBanner.mapped || !this.tray.visible || opacity === 0 ||
            ![absX, absY, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
            this.glass.hide();
            return;
        }
        this.glass.opacity = opacity;
        this.glass.show();
        const bgW = w + this._glassExpand * 2 + SHADER_PADDING * 2;
        const bgH = h + this._glassExpand * 2 + SHADER_PADDING * 2;
        const bgX_abs = absX - this._glassExpand - SHADER_PADDING;
        const bgY_abs = absY - this._glassExpand - SHADER_PADDING;
        const monitor = resolveMonitorGeometry([this.currentBanner, this.tray]);
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        // Monitor-local, as the shader uses them.
        let localBgX = bgX_abs - monitorX;
        let localBgY = bgY_abs - monitorY;
        // The only part of the rect the paint-time hook cannot derive on its own.
        this._liveMonitorOrigin = [monitorX, monitorY];
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== bgX_abs || this._lastBgY !== bgY_abs ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH) {
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            this.glass.set_position(monitorX, monitorY);
            this.glass.set_size(screenW, screenH);
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            // Limit drawing to the glass plus room for its shadow.
            const CLIP_PADDING = 200;
            setClipIfChanged(this.glass, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
            const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
            this.glass.setShadowMaxRadius(SHADOW_MAX_RADIUS);
            this.glass.setResolution(screenW, screenH);
            this.glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX_abs;
            this._lastBgY = bgY_abs;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        // After the geometry setters, so the relays cover this frame's rect.
        this.glass.syncSources();
    }
    // Runs at paint time (see GlassActor.setLiveGeometryHook()), when the
    // banner's allocation is current. Only the shader's glass rect is updated;
    // actors must not change mid-paint.
    _syncGlassGeometryLive() {
        const banner = this.currentBanner;
        const origin = this._liveMonitorOrigin;
        if (!banner || !this.glass || !origin)
            return;
        if (!banner.mapped)
            return;
        const [absX, absY, w, h] = getTransformedRect(banner);
        if (![absX, absY, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
            return;
        const bgW = w + this._glassExpand * 2 + SHADER_PADDING * 2;
        const bgH = h + this._glassExpand * 2 + SHADER_PADDING * 2;
        this.glass.setGlassGeometry(absX - this._glassExpand - SHADER_PADDING - origin[0], absY - this._glassExpand - SHADER_PADDING - origin[1], bgW, bgH);
    }
    _cleanupCurrentBanner() {
        this._bannerGeneration++;
        this._contrastSampler.invalidate();
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        // @ts-expect-error: _bannerBin is an internal property
        if (this.currentBanner && this.tray._bannerBin) {
            // @ts-expect-error: _bannerBin is an internal property
            this.tray._bannerBin.translation_y = this._originalBannerOffset;
        }
        if (this.currentBanner) {
            this.currentBanner.remove_style_class_name(BANNER_TRANSPARENT_CLASS);
            this.currentBanner = null;
        }
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._stopHoverTint();
        const glass = this.glass;
        this.glass = null;
        if (glass) {
            glass.cleanup();
            // At shell shutdown the stage may have destroyed it already.
            if (isActorValid(glass))
                glass.destroy();
        }
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
        this._lastScreenW = undefined;
        this._lastScreenH = undefined;
        this._isFirstAdaptiveRun = true;
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        if (this._bannerIdleId)
            GLib.Source.remove(this._bannerIdleId);
        this._bannerIdleId = 0;
        this._pendingBanner = null;
        // @ts-expect-error
        let bannerBin = this.tray._bannerBin;
        for (let sigId of this._signals)
            bannerBin.disconnect(sigId);
        this._signals = [];
        this._cleanupCurrentBanner();
    }
    cleanup() {
        this._liveMonitorOrigin = null;
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._stopHoverTint();
        for (let sigId of this._settingsSignals)
            this._settings.disconnect(sigId);
        this._settingsSignals = [];
        this._removeEffect();
    }
    _collectAdaptiveTextTargets(actor = this.currentBanner, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(actor);
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
        // One timestamp for the whole map, so every label in the banner flips together.
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
            if (!this.currentBanner || !this.glass) {
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
        let [, absY] = this.currentBanner?.get_transformed_position() ?? [0, 0];
        if (absY < 0)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        const generation = this._bannerGeneration;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig, this.currentBanner, () => this.glass?.paintCount ?? NaN, () => this.glass ? [this.glass] : [])
            .then(colorMap => {
            if (generation !== this._bannerGeneration || !this.currentBanner)
                return;
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
    _animateActorColor(actor, targetHexColor, durationMs = 380, skipAnimations = false, batchStart) {
        // An existing tween is not cancelled: add() restarts from the color it
        // last applied.
        const originalStyle = (this._styledActors.get(actor) || '').trim();
        const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let targetRgb = hexToRgb(targetHexColor);
        const apply = (r, g, b, a) => {
            const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
        };
        if (skipAnimations) {
            adaptiveColorTweener.cancel(actor);
            actor.set_style(`${stylePrefix}color: ${targetHexColor}; -st-icon-foreground-color: ${targetHexColor};`);
            return;
        }
        const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
        const startAlpha = startColor.alpha / 255.0;
        adaptiveColorTweener.add(actor, {
            startRgb, startAlpha,
            targetRgb, targetAlpha: 1.0,
            crossFade: resolveCrossFade(startRgb, targetRgb),
            durationMs,
            apply,
        }, batchStart);
    }
}
