// src/notificationManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';

// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;
const HIDE_SAFETY_MARGIN = 7;
// const NOTIFICATION_Y_OFFSET = 10;

export class NotificationManager {
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this.tray = Main.messageTray;
        
        this.currentBanner = null;
        this.bgActor = null;
        this.clipBox = null;
        this.blurEffect = null;
        this.effect = null;
        
        this.bgClone = null;
        this.windowClonesContainer = null;
        this.overviewCloneContainer = null;
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;

        this._signals = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;

        this._stableBaseW = undefined;
        this._stableBaseH = undefined;

        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;

        this._windowClones = new Map();

        this._contrastSampler = new StageContrastSampler();
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: true, // Will be overridden by settings
            samplePerElement: false,
            sampleIntervalMs: 400, // Will be overridden by settings
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
        if (!this._settings) return;
        this._bindSettings();

        // 拡張機能全体の設定または通知専用の設定で有効化を判断
        if (this._settings.get_boolean('enable-notification-glass')) {
            this._applyEffect();
        }
    }

    // Utility: Convert HEX color string to normalized RGB array
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
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
            if (enabled && !this._isEffectActive) this._applyEffect();
            else if (!enabled && this._isEffectActive) this._removeEffect();
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
            if (this.blurEffect && this._isEffectActive) {
                this.blurEffect.radius = this._settings.get_int('notification-blur-radius');
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
        if (this._isEffectActive) return;
        this._isEffectActive = true;

        let bannerBin = this.tray._bannerBin;
        if (!bannerBin) {
            console.error("[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.");
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
            if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) return;
            
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
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
            if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) return;
            this._cleanupCurrentBanner();
        }));

        if (this.tray._banner) {
            this.currentBanner = this.tray._banner;
            this._setupBannerEffect(this.tray._banner);
        }
    }

    _setupBannerEffect(targetActor) {
        targetActor.add_style_class_name('liquid-glass-transparent');

        if (this.tray._bannerBin) {
            this.tray._bannerBin.translation_y = this._settings.get_int('notification-y-offset');
        }

        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(1.0, 1.0);
        this.bgActor.set_pivot_point(0.0, 0.0);

        this.clipBox = new St.Widget({ clip_to_allocation: true });
        this.bgActor.add_child(this.clipBox);

        let bannerBin = this.tray._bannerBin;
        let parent = bannerBin ? bannerBin.get_parent() : null;

        if (parent) {
            parent.insert_child_below(this.bgActor, bannerBin);
        } else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }

        let blurRadius = this._settings.get_int('notification-blur-radius');
        let tintColorStr = this._settings.get_string('notification-tint-color');
        let cornerRadius = this._settings.get_double('notification-corner-radius');
        let tintStrength = this._settings.get_double('notification-tint-strength');
        this._baseTint = tintStrength;

        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);

        this.effect = new LiquidEffect({ extensionPath: this.extensionPath });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
        this.effect.setTintStrength(this._baseTint);
        this.effect.setCornerRadius(cornerRadius);
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);

        this.bgActor.show();

        this._buildClones();
        
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW ?? Meta.LaterType.BEFORE_PAINT;
        const frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.currentBanner) return GLib.SOURCE_REMOVE;

            this._syncGeometry(); 

            let isHovered = this.currentBanner.hover;
            let targetTint = isHovered ? (this._baseTint + 0.1) : this._baseTint;

            if (Math.abs(this._currentTint - targetTint) > 0.001) {
                this._currentTint += (targetTint - this._currentTint) * 0.1;
                this.effect.setTintStrength(this._currentTint);
            }
            this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };

        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        this._startAdaptiveColorSampling();
    }

    _syncActorProperties(source, clone) {
        if (!source || !clone) return;
        
        let [absX, absY] = source.get_transformed_position();
        let [w, h] = source.get_size();

        if (Number.isNaN(absX) || Number.isNaN(absY) || Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) {
            clone.visible = false;
            return;
        }

        clone.set_position(absX, absY);
        clone.set_size(w, h);
        clone.set_scale(source.scale_x, source.scale_y);
        
        let pX = source.pivot_point ? source.pivot_point.x : 0;
        let pY = source.pivot_point ? source.pivot_point.y : 0;
        clone.set_pivot_point(pX, pY);

        clone.translation_x = 0;
        clone.translation_y = 0;
        
        clone.opacity = source.opacity;
        clone.visible = source.visible && source.mapped;
    }

    _syncGeometry() {
       if (!this.bgActor || !this.currentBanner) return;
        
        let [w, h] = this.currentBanner.get_size();
        let [absX, absY] = this.currentBanner.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY)) return;

        this.bgActor.opacity = this.currentBanner.opacity;

        let themeNode = this.currentBanner.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

        let marginW = mL + mR;
        let marginH = mT + mB;

        if (absY + h <= mB + HIDE_SAFETY_MARGIN) {
            this.bgActor.hide();
            return;
        } else if (!this.bgActor.visible) {
            this.bgActor.show();
        }

        if (this._stableBaseW === undefined) {
            this._stableBaseW = w; 
        }

        if (Math.abs(this._stableBaseW - (w + marginW)) <= 1) {
            this._stableBaseW = w;
        }

        let isBloated = Math.abs(w - (this._stableBaseW + marginW)) <= 1;

        let visualW = w;
        let visualH = h;

        if (isBloated) {
            visualW = w - marginW;
            visualH = h - marginH;
        } else {
            this._stableBaseW = w;
            visualW = w;
            visualH = h;
        }

        let visualX = absX;
        let visualY = absY;

        let bgW = visualW + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (this._glassExpand * 2) + (SHADER_PADDING * 2);

        let bgX_abs = visualX - this._glassExpand - SHADER_PADDING;
        let bgY_abs = visualY - this._glassExpand - SHADER_PADDING;

        let bgX_local = bgX_abs;
        let bgY_local = bgY_abs;
        let parent = this.bgActor.get_parent();
        if (parent) {
            let [pX, pY] = parent.get_transformed_position();
            if (!Number.isNaN(pX) && !Number.isNaN(pY)) {
                bgX_local = bgX_abs - pX;
                bgY_local = bgY_abs - pY;
            }
        }

        if (this._lastBgW === undefined || 
            Math.abs(this._lastBgW - bgW) > 0.5 || Math.abs(this._lastBgH - bgH) > 0.5 || 
            Math.abs(this._lastBgX - bgX_abs) > 0.5 || Math.abs(this._lastBgY - bgY_abs) > 0.5) {
            
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX_local, bgY_local);
            
            this.clipBox.set_size(bgW, bgH);
            this.clipBox.set_position(0, 0);

            this.effect.setResolution(bgW, bgH);

            this._lastBgW = bgW; 
            this._lastBgH = bgH;
            this._lastBgX = bgX_abs; 
            this._lastBgY = bgY_abs;
        }

        if (this.bgClone && this.windowClonesContainer) {
            this.bgClone.set_position(-bgX_abs, -bgY_abs);
            this.windowClonesContainer.set_position(-bgX_abs, -bgY_abs);
            if (this.overviewCloneContainer) {
                this.overviewCloneContainer.set_position(-bgX_abs, -bgY_abs);
            }

            let isOverview = Main.overview.visible || Main.overview.animationInProgress;
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0;

            if (!isOverview) {
                if (this._overviewClone) { this._overviewClone.destroy(); this._overviewClone = null; }
                if (this._appDisplayClone) { this._appDisplayClone.destroy(); this._appDisplayClone = null; }
                if (this._searchClone) { this._searchClone.destroy(); this._searchClone = null; }

                this.bgClone.show();

                for (let w of windows) {
                    let metaWindow = w.get_meta_window();
                    if (!metaWindow || metaWindow.minimized || !w.visible) continue;

                    activeWindows.add(w);

                    let clone;
                    if (!this._windowClones.has(w)) {
                        clone = new Clutter.Clone({ source: w });
                        this.windowClonesContainer.add_child(clone);
                        this._windowClones.set(w, clone);
                    } else {
                        clone = this._windowClones.get(w);
                    }
                    
                    clone.set_position(w.x, w.y);
                    this.windowClonesContainer.set_child_at_index(clone, zIndex);
                    zIndex++;
                }
            } else {
                this.bgClone.show();
                let controls = Main.overview._overview?._controls;
                
                if (controls) {
                    if (controls._workspacesDisplay) {
                        if (!this._overviewClone) {
                            this._overviewClone = new Clutter.Clone({ source: controls._workspacesDisplay });
                            this.overviewCloneContainer.add_child(this._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
                    }
                    if (controls._appDisplay) {
                        if (!this._appDisplayClone) {
                            this._appDisplayClone = new Clutter.Clone({ source: controls._appDisplay });
                            this.overviewCloneContainer.add_child(this._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
                    }
                    if (controls._searchController && controls._searchController.actor) {
                        if (!this._searchClone) {
                            this._searchClone = new Clutter.Clone({ source: controls._searchController.actor });
                            this.overviewCloneContainer.add_child(this._searchClone);
                        }
                        this._syncActorProperties(controls._searchController.actor, this._searchClone);
                    }
                }
            }

            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }

    _buildClones() {
        if (!this.bgActor) return;
        
        if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
        if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }
        if (this.overviewCloneContainer) { this.overviewCloneContainer.destroy(); this.overviewCloneContainer = null; }

        this.bgClone = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
        this.clipBox.add_child(this.bgClone); 

        this.overviewCloneContainer = new Clutter.Actor();
        this.clipBox.add_child(this.overviewCloneContainer);

        this.windowClonesContainer = new Clutter.Actor();
        this.clipBox.add_child(this.windowClonesContainer);

        this._windowClones.clear();
        this._overviewClone = null; 
        this._appDisplayClone = null;
        this._searchClone = null;

        let windows = global.get_window_actors();
        for (let w of windows) {
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible) continue;

            let clone = new Clutter.Clone({ source: w });
            clone.set_position(w.x, w.y);
            this.windowClonesContainer.add_child(clone);

            this._windowClones.set(w, clone);
        }
    }

    _getMedian(arr) {
        let sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    _hasStyleClass(actor, className) {
        return typeof actor?.has_style_class_name === 'function' &&
            actor.has_style_class_name(className);
    }

    _collectAdaptiveTextTargets(actor = this.currentBanner, targets = []) {
        if (!actor) return targets;
        return this._findAllTextActors(this.currentBanner);
    }

    _setActorColor(actor, color) {
        if (!actor || typeof actor.set_style !== 'function') return;

        if (actor._currentTargetColor === color) return;
        actor._currentTargetColor = color;

        this._animateActorColor(actor, color);
    }

    _clearAdaptiveStyles() {
        for (const [actor, style] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = null;
                }
                actor._currentTargetColor = null;
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                actor.set_style(style);
            }
        }
        this._styledActors.clear();
    }

    _applyAdaptiveColorMap(colorMap) {
        if (!colorMap || colorMap.size === 0) return;
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color);
        }
    }

    _startAdaptiveColorSampling() {
        if (!this._adaptiveConfig.enabled) return;
        this._updateAdaptiveTextColors();

        if (this._adaptiveTimerId !== 0) return;

        this._adaptiveTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._adaptiveConfig.sampleIntervalMs,
            () => {
                if (!this.currentBanner || !this.bgActor) {
                    this._adaptiveTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._updateAdaptiveTextColors();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }

    _findAllTextActors(actor, foundActors = []) {
        if (!actor) return foundActors;

        if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button) {
            if (actor.visible) {
                foundActors.push(actor);
            }
        }

        let children = actor.get_children();
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }

        return foundActors;
    }

    _updateAdaptiveTextColors() {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight) return;

        let [absX, absY] = this.currentBanner.get_transformed_position();
        if (absY < 0) return;

        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0) return;

        this._adaptiveInFlight = true;

        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
                this._applyAdaptiveColorMap(colorMap);
            })
            .catch(e => {
                console.error(`[Liquid Glass] Notification adaptive color update failed: ${e}`);
            })
            .finally(() => {
                this._adaptiveInFlight = false;
            });
    }

    _hexToRgb(hex) {
        let bigint = parseInt(hex.replace('#', ''), 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255
        };
    }

    _rgbToHex(r, g, b) {
        return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
    }

    _animateActorColor(actor, targetHexColor) {
        if (!actor || Object.keys(actor).length === 0) return;

        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = null;
        }

        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();

        let targetRgb = this._hexToRgb(targetHexColor);
        let startTime = GLib.get_monotonic_time();
        let durationMs = 380;

        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!actor || Object.keys(actor).length === 0) return GLib.SOURCE_REMOVE;

            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);

            let easeProgress = progress < 0.5 
                ? 2 * progress * progress 
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);

            let currentHex = this._rgbToHex(r, g, b);

            actor.set_style(`color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);

            if (progress >= 1.0) {
                actor._colorTweenId = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _removeEffect() {
        if (!this._isEffectActive) return;
        this._isEffectActive = false;

        let bannerBin = this.tray._bannerBin;
        for (let sigId of this._signals) {
            bannerBin.disconnect(sigId); 
        }
        this._signals = [];

        this._cleanupCurrentBanner();
    }

    _cleanupCurrentBanner() {
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();

        if (this.tray._bannerBin) {
            this.tray._bannerBin.translation_y = 0;
        }

        if (this.currentBanner) {
            this.currentBanner.remove_style_class_name('liquid-glass-transparent');
            this.currentBanner.translation_y = 0;
            this.currentBanner = null;
        }

        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters) global.compositor.get_laters().remove(this._frameSyncId);
            else if (Meta.later_remove) Meta.later_remove(this._frameSyncId);
            this._frameSyncId = 0;
        }

        if (this.bgActor) { 
            this.bgActor.destroy(); 
            this.bgActor = null; 
        }
        
        this.effect = null;
        this.blurEffect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this.overviewCloneContainer = null;

        this._windowClones.clear();
        
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
        this._lastBannerW = undefined; 
        this._lastBannerH = undefined; 
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }

    cleanup() {
        for (let sigId of this._settingsSignals) {
            this._settings.disconnect(sigId);
        }
        this._settingsSignals = [];
        this._removeEffect();
    }

    _laterAdd(laterType, callback) {
        return global.compositor?.get_laters?.().add(laterType, callback) ?? Meta.later_add(laterType, callback);
    }
}