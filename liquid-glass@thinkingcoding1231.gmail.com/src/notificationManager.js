// src/notificationManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';

const SHADER_PADDING = 20; 
const GLASS_EXPAND = 12; // Assume the notification fits its original size perfectly
const NOTIFICATION_Y_OFFSET = 10;

// Adaptive text color flags
const ENABLE_ADAPTIVE_TEXT_COLOR = true;
const SAMPLE_PER_ELEMENT = false;
const SAMPLE_INTERVAL_MS = 400; // How often to resample colors while the notification is visible (in milliseconds)

export class NotificationManager {
    constructor(extensionPath) {
        this.extensionPath = extensionPath;
        this.tray = Main.messageTray;
        
        // Holds information about the active notification banner
        this.currentBanner = null;
        this.bgActor = null;
        this.clipBox = null;
        this.blurEffect = null;
        this.effect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;

        this._signals = [];
        this._frameSyncId = 0;

        this._stableBaseW = undefined;
        this._stableBaseH = undefined;

        this._lastBgW = undefined;
        this._lastBgH = undefined;

        this._lastBannerH = undefined;
        this._lastBannerW = undefined;

        this._windowClones = new Map();

        this._contrastSampler = new StageContrastSampler();
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: ENABLE_ADAPTIVE_TEXT_COLOR,
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: SAMPLE_INTERVAL_MS,
        };
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
    }

    // Initializes the notification manager and hooks into the GNOME message tray
    setup() {
        let bannerBin = this.tray._bannerBin;

        // Avoid errors if bannerBin is undefined (e.g., if GNOME internal structure changed)
        if (!bannerBin) {
            console.error("[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.");
            return;
        }

        // Listen for new notifications (Changed from 'actor-added' to 'child-added' for newer GNOME versions)
        this._signals.push(bannerBin.connect('child-added', (container, actor) => {
            if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) {
                return;
            }

            console.log("[Liquid Glass] Notification actor added.");
            
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

        // Listen for notifications being dismissed (Changed from 'actor-removed' to 'child-removed')
        this._signals.push(bannerBin.connect('child-removed', (container, actor) => {
            if (actor === this.bgActor || actor.has_style_class_name('liquid-glass-bg-actor')) {
                return;
            }

            console.log("[Liquid Glass] Notification actor removed.");
            this._cleanupCurrentBanner();
        }));

        // Handle the case where a notification is already visible when the extension is enabled
        if (this.tray._banner) {
            console.log("[Liquid Glass] Existing banner found on setup.");
            this.currentBanner = this.tray._banner;
            this._setupBannerEffect(this.tray._banner);
        }
    }

    // Handles banner state changes (appear/disappear)
    _onBannerChanged() {
        let banner = this.tray.banner;

        // If the notification disappears
        if (!banner && this.currentBanner) {
            console.log("[Liquid Glass] Notification banner removed.");
            this._cleanupCurrentBanner();
            return;
        }

        // If a new notification is displayed
        if (banner && banner !== this.currentBanner) {
            console.log("[Liquid Glass] New notification banner detected.");

            this._cleanupCurrentBanner(); // Cleanup just in case
            this.currentBanner = banner;
            this._setupBannerEffect(banner);
        }
    }

    // Injects the glass effect background behind the target notification banner
    _setupBannerEffect(targetActor) {
        // Add a class to make the default GNOME background transparent
        targetActor.add_style_class_name('liquid-glass-transparent');

        // Main background actor for the glass effect
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(1.0, 1.0);
        this.bgActor.set_pivot_point(0.0, 0.0);

        this.clipBox = new St.Widget({ clip_to_allocation: true });
        this.bgActor.add_child(this.clipBox);

        // ==========================================
        // ★ Fix 1: Place bgActor "outside" of _bannerBin
        // ==========================================
        // Placing the background outside the notification container (as a sibling) 
        // prevents layout interference and infinite scaling loops.
        let bannerBin = this.tray._bannerBin;
        let parent = bannerBin ? bannerBin.get_parent() : null;

        if (parent) {
            parent.insert_child_below(this.bgActor, bannerBin);
        } else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }

        

        // --- Blur and Shader Settings (Unchanged) ---
        this.blurEffect = new Shell.BlurEffect({ radius: 5, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);

        this.effect = new LiquidEffect({ extensionPath: this.extensionPath });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(1.0, 1.0, 1.0); 
        this.effect.setTintStrength(0.18); 
        this.effect.setCornerRadius(30.0);
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);

        this.bgActor.show();

        // Build window/desktop clones for the blur effect
        this._buildClones();
        
        // Start the per-frame synchronization loop
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW ?? Meta.LaterType.BEFORE_PAINT;
        const frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.currentBanner) return GLib.SOURCE_REMOVE;

            this._syncGeometry(); 
            this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };

        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        this._startAdaptiveColorSampling();
    }
    
    // Synchronizes the size, position, and clones to perfectly match the notification
    _syncGeometry() {
        if (!this.bgActor || !this.currentBanner) return;
        
        // 1. Always use the size of the "outer frame" (the entire banner) as the reference 
        // (automatically tracks hover animations).
        let [w, h] = this.currentBanner.get_size();

        // --- Fix: Use dedicated variables for comparing the notification's own size ---
        if (this._lastBannerW !== undefined) {
            // Logic to ignore sudden changes of 10px or more as "noise"
            if (Math.abs(w - this._lastBannerW) > 10 || Math.abs(h - this._lastBannerH) > 10) {
                w = this._lastBannerW;
                h = this._lastBannerH;
            }
        }
        this._lastBannerW = w;
        this._lastBannerH = h;
        

        // Sync opacity
        this.bgActor.opacity = this.currentBanner.opacity;

        let [absX, absY] = this.currentBanner.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY)) return;

        // 2. Get the margins set on the outer frame (the 12px invisible padding)
        let themeNode = this.currentBanner.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

        // 3. Subtract margins to calculate the "true visual size (equivalent to 499px)"
        // let visualW = w + mL + mR;
        // let visualH = h + mT + mB;
        let visualW = w - mR - mL;
        let visualH = h - mB - mT;

        // 4. "True top-left coordinates of the drawable area" considering margins
        let visualX = absX;
        let visualY = absY;

        // 5. Calculate the total size of the glass background (expand based on visual size)
        let bgW = visualW + (GLASS_EXPAND * 2) + (SHADER_PADDING * 2);
        let bgH = visualH + (GLASS_EXPAND * 2) + (SHADER_PADDING * 2);

        // 6. Calculate the absolute top-left coordinates of the glass background
        let bgX_abs = visualX - GLASS_EXPAND - SHADER_PADDING;
        let bgY_abs = visualY - GLASS_EXPAND - SHADER_PADDING;

        // Debugging logs
        console.log(`[Liquid Glass] Raw Size: ${w}x${h}, Abs Pos: (${absX}, ${absY}), Margins: (L:${mL}, R:${mR}, T:${mT}, B:${mB}), Visual Size: ${visualW}x${visualH}, Visual Pos: (${visualX}, ${visualY}), BG Size: ${bgW}x${bgH}, BG Abs Pos: (${bgX_abs}, ${bgY_abs})]`);
        // console.debug(`[Liquid Glass] Visual Size: ${visualW}x${visualH}, Visual Pos: (${visualX}, ${visualY}), BG Size: ${bgW}x${bgH}, BG Abs Pos: (${bgX_abs}, ${bgY_abs})`);

        // 6 (part 2). Subtract the parent's absolute coordinates to create "local coordinates"
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

        // ==========================================
        // Geometry Update
        // Apply only when changes are > 0.5px to prevent unnecessary redraws from sub-pixel micro-vibrations
        // ==========================================
        if (this._lastBgW === undefined || 
            Math.abs(this._lastBgW - bgW) > 0.5 || Math.abs(this._lastBgH - bgH) > 0.5 || 
            Math.abs(this._lastBgX - bgX_abs) > 0.5 || Math.abs(this._lastBgY - bgY_abs) > 0.5) {
            
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX_local, bgY_local);

            this.currentBanner.translation_y = NOTIFICATION_Y_OFFSET;   
            
            this.clipBox.set_size(bgW, bgH);
            this.clipBox.set_position(0, 0);

            this.effect.setResolution(bgW, bgH);

            if (this.bgClone && this.windowClonesContainer) {
                this.bgClone.set_position(-bgX_abs, -bgY_abs);
                this.windowClonesContainer.set_position(-bgX_abs, -bgY_abs);
            }

            this._lastBgW = bgW; 
            this._lastBgH = bgH;
            this._lastBgX = bgX_abs; 
            this._lastBgY = bgY_abs;
        }

        // ==========================================
        // Window Synchronization Process
        // ==========================================
        if (this.windowClonesContainer) {
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0;

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

            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }

    // Calculates the median value of an array to filter out noise spikes.
    _getMedian(arr) {
        let sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    // Utility function to safely check if an actor has a specific style class.
    _hasStyleClass(actor, className) {
        return typeof actor?.has_style_class_name === 'function' &&
            actor.has_style_class_name(className);
    }

    // Simplified target collection to use a single recursive pass.
    _collectAdaptiveTextTargets(actor = this.currentBanner, targets = []) {
        if (!actor) return targets;

        // Check if the actor has the specified target classes
        if (typeof actor.set_style === 'function') {
            if (this._hasStyleClass(actor, 'message-source-title') ||
                this._hasStyleClass(actor, 'event-time') ||
                this._hasStyleClass(actor, 'message-title') ||
                this._hasStyleClass(actor, 'message-body')) {
                targets.push(actor);
            }
        }

        // Recurse into children to continue searching
        const children = actor.get_children?.() ?? [];
        for (let i = 0; i < children.length; i++) {
            this._collectAdaptiveTextTargets(children[i], targets);
        }

        return targets;
    }

    // Initiates the color change for a specific actor
    _setActorColor(actor, color) {
        if (!actor || typeof actor.set_style !== 'function') return;

        // Save the target color to prevent redundant animation triggers for the same color.
        if (actor._currentTargetColor === color) return;
        actor._currentTargetColor = color;

        // Kick off the color transition animation!
        this._animateActorColor(actor, color);
    }

    // Removes all dynamically applied adaptive text color styles and stops related animations.
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

    // Iterates through the color map and applies the new target colors to the respective actors.
    _applyAdaptiveColorMap(colorMap) {
        if (!colorMap || colorMap.size === 0)
            return;

        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color);
        }
    }

    // Starts the timer for periodically sampling contrast and updating adaptive text colors.
    _startAdaptiveColorSampling() {
        if (!this._adaptiveConfig.enabled)
            return;

        this._updateAdaptiveTextColors();

        if (this._adaptiveTimerId !== 0)
            return;

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

    // Stops the adaptive color sampling timer.
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }

    // Collects target actors, samples their contrast, and triggers color updates.
    _updateAdaptiveTextColors() {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;

        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;

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

    // Converts a hexadecimal color code string to an RGB object.
    _hexToRgb(hex) {
        let bigint = parseInt(hex.replace('#', ''), 16);
        return {
            r: (bigint >> 16) & 255,
            g: (bigint >> 8) & 255,
            b: bigint & 255
        };
    }

    // Converts RGB numerical values to a hexadecimal color string.
    _rgbToHex(r, g, b) {
        return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
    }

    _animateActorColor(actor, targetHexColor) {
        if (!actor || Object.keys(actor).length === 0) return;

        // Cancel any existing color tween if running (handles mid-transition target changes).
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = null;
        }

        // --- Retrieve the "actual physical color" currently displayed on screen ---
        // This allows smooth transitions starting directly from the default theme colors.
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color

        let targetRgb = this._hexToRgb(targetHexColor);
        
        let startTime = GLib.get_monotonic_time();
        let durationMs = 380; // Animation duration in milliseconds

        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!actor || Object.keys(actor).length === 0) return GLib.SOURCE_REMOVE;

            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);

            // Standard ease-in-out easing function
            let easeProgress = progress < 0.5 
                ? 2 * progress * progress 
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            // Linearly interpolate (lerp) each RGB channel individually
            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);

            let currentHex = this._rgbToHex(r, g, b);

            // Override text color and icon foreground color directly using inline CSS
            actor.set_style(`color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);

            // Check for animation completion
            if (progress >= 1.0) {
                actor._colorTweenId = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Handles the custom bounce/spring physics when the menu opens or closes
    _startAnimation(targetValue) {
        // Clear any built-in GNOME transitions that might interfere with our logic
        if (this.animActor) this.animActor.remove_all_transitions();
        if (this.bgActor) this.bgActor.remove_all_transitions();

        this._springScale.target = targetValue;
        this._springPos.target = targetValue;

        // If an animation loop isn't already running, start a new one
        if (this._tickId === 0) {
            let lastTime = GLib.get_monotonic_time();
            
            // Run at ~60fps (every 16ms)
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                if (!this.bgActor || !this.targetActor) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                let currentTime = GLib.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;

                let isClosing = (this._springScale.target === 0);
                
                // Cap delta time to prevent physics explosions during severe lag spikes
                let dt = elapsedMs / 1000;
                if (dt > 0.033) dt = 0.033;

                let stopped = false;
                let s, p;

                if (isClosing) {
                    // Use a simple exponential decay for closing (faster, no bounce)
                    let speed = 15.0;
                    this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dt));
                    this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dt));
                    
                    s = this._springScale.value;
                    p = this._springPos.value;
                    
                    // Stop animation completely when it's virtually invisible
                    if (s < 0.005) {
                        s = 0; p = 0;
                        stopped = true;
                    }
                } else {
                    // Use Hooke's law spring physics for opening (creates a nice bounce effect)
                    stopped = this._springScale.update(elapsedMs) && this._springPos.update(elapsedMs);
                    s = this._springScale.value;
                    p = this._springPos.value;

                    // Magnet effect: Snap to exactly 1.0 when the bounce is almost settled.
                    // This prevents indefinite micro-stuttering at the end of the animation.
                    if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._springScale.velocity) < 0.03) {
                        s = 1.0;
                        p = 1.0;
                        stopped = true;
                    }
                }

                let currentScale;
                let opacity;

                if (isClosing) {
                    // Clamp to 0.001 because scale = 0 crashes Cogl
                    currentScale = Math.max(0.001, s); 
                    
                    // Fade out opacity faster than the scale shrinks (fades between scale 1.0 and 0.3)
                    opacity = Math.min(255, Math.max(0, (s - 0.3) / 0.7 * 255));
                } else {
                    // Start opening from scale 0.2 instead of 0.0 so it looks less jarring
                    currentScale = 0.2 + (s * 0.8); 
                    opacity = Math.min(255, Math.max(0, s * 255));
                }

                // Apply the calculated scale to the UI
                this.animActor.set_scale(currentScale, currentScale);

                // Dynamically adjust the shader's corner radius during the animation.
                // As the menu shrinks, the absolute radius shrinks too, keeping the corners proportional.
                if (this.effect && typeof this.effect.setCornerRadius === 'function') {
                    let baseRadius = 60.0; 
                    this.effect.setCornerRadius(baseRadius * currentScale);
                }

                this.bgActor.opacity = opacity;
                this.animActor.opacity = opacity;

                // Crucial step: Instantly update geometry right after scaling.
                // This guarantees the glass background moves in perfect sync with the UI.
                this._syncGeometry();

                // Cleanup when animation finishes
                if (stopped) {
                    this._tickId = 0;
                    
                    if (isClosing && this.menu.actor) {
                        this.menu.actor.hide(); // Tell GNOME the menu is officially closed
                    }
                    
                    if (!isClosing) {
                        // Restore scale to exactly 1.0 to fix font hinting/blurriness issues
                        this.animActor.set_scale(1.0, 1.0);
                        this.animActor.opacity = 255;
                        this.bgActor.opacity = 255;
                        this._syncGeometry();
                    }
                    return GLib.SOURCE_REMOVE; // Stop the GLib timeout loop
                }
                return GLib.SOURCE_CONTINUE; // Keep the GLib timeout loop running
            });
        }
    }

    // Function to create clones of the desktop wallpaper and all visible windows
    _buildClones() {
        if (!this.bgActor) return;
        
        if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
        if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }

        this.bgClone = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
        this.clipBox.add_child(this.bgClone); 

        this.windowClonesContainer = new Clutter.Actor();
        this.clipBox.add_child(this.windowClonesContainer);

        this._windowClones.clear();

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

    // Cleans up the glass effect, clones, and timers associated with the current notification banner
    _cleanupCurrentBanner() {
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();

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

        this._windowClones.clear();
        
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;

        this._lastBannerW = undefined; // Added
        this._lastBannerH = undefined; // Added

        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }

    // Completely tears down the manager, disconnecting signals and cleaning up resources
    cleanup() {
        let bannerBin = this.tray._bannerBin;
        for (let sigId of this._signals) {
            bannerBin.disconnect(sigId); 
        }
        this._signals = [];
        this._cleanupCurrentBanner();
    }

    // Helper function to hook into GNOME's render pipeline (using Meta.later_add or global.compositor)
    _laterAdd(laterType, callback) {
        return global.compositor?.get_laters?.().add(laterType, callback) ?? Meta.later_add(laterType, callback);
    }
}