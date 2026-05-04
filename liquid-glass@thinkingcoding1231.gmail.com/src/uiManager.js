// src/uiManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';

// ========== Configuration Parameters ==========

// Transparent padding outside the glass area. 
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20; 

// How much larger the glass background should be compared to the actual menu UI.
// const GLASS_EXPAND = 12;   

// Distance to shift the entire menu downwards to avoid overlapping with the top panel.
// const MENU_Y_OFFSET = GLASS_EXPAND + 5;  

// Adaptive text color flags
const ENABLE_ADAPTIVE_TEXT_COLOR = true;
const SAMPLE_PER_ELEMENT = false;
const SAMPLE_INTERVAL_MS = 400; // How often to resample colors while the menu is open (in milliseconds)

const TINT_COLOR = [1.0, 1.0, 1.0]; // Pure white tint for the frosted glass effect
const TINT_STRENGTH = 0.20; // Subtle tint strength to enhance the glass look without overpowering the background
const BLUR_RADIUS = 8; // The radius of the native blur effect applied to the background clones
const CORNER_RADIUS = 60.0; // The radius for the rounded corners of the dock background

// ==============================================

export class UIManager {
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        
        // Target the main container of the Date/Calendar menu
        this.targetActor = Main.panel.statusArea.dateMenu.menu.actor;
        this.menu = Main.panel.statusArea.dateMenu.menu;

        // Target for animations and visual offsets (The inner content)
        this.animActor = Main.panel.statusArea.dateMenu.menu.box;
        
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        
        this.bgClone = null;
        this.windowClonesContainer = null;

        // Map to keep track of active windows and their corresponding clone actors.
        this._windowClones = new Map();

        this._signals = [];
        this._frameSyncId = 0;

        this._glassExpand = null;
        this._menuYoffset = null;

        // Custom spring physics parameters for the open/close animation
        // Spring(stiffness, damping, mass)
        this._springScale = new Spring(120, 8, 1.0);
        this._springPos = new Spring(300, 12, 1.0);
        this._tickId = 0;

        this._contrastSampler = new StageContrastSampler();
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();

        this._settingsSignals = [];
        this._isEffectActive = false;

        this.overviewCloneContainer = null;
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;

        // Listen for the menu opening/closing to trigger our custom physics animation
        this._signals.push(this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._startAnimation(1); // Target scale: 1.0 (fully open)
            } else {
                this._startAnimation(0); // Target scale: 0.0 (closed)
            }
        }));
    }

    setup() {
        if (!this._settings) return;
        this._bindSettings();

        // uiManager は 'enable-menu-glass'、notificationManager は 'notification-enable-glass' （※スキーマによる）
        if (this._settings.get_boolean('enable-menu-glass')) {
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

    // 追加: 設定の動的反映
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };

        // ON/OFF切り替え
        connectSetting('enable-menu-glass', () => {
            let enabled = this._settings.get_boolean('enable-menu-glass');
            if (enabled && !this._isEffectActive) this._applyEffect();
            else if (!enabled && this._isEffectActive) this._removeEffect();
        });

        connectSetting('menu-tint-color', () => {
            if (this.effect && this._isEffectActive) {
                let colorArray = this._hexToColorArray(this._settings.get_string('menu-tint-color'));
                this.effect.setTintColor(...colorArray);
            }
        });

        connectSetting('menu-tint-strength', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setTintStrength(this._settings.get_double('menu-tint-strength'));
            }
        });

        connectSetting('menu-blur-radius', () => {
            if (this.blurEffect && this._isEffectActive) {
                this.blurEffect.radius = this._settings.get_int('menu-blur-radius');
            }
        });

        connectSetting('menu-corner-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setCornerRadius(this._settings.get_double('menu-corner-radius'));
            }
        });

        connectSetting('menu-glass-expand', () => {
            if (this.effect && this._isEffectActive) {
                this._glassExpand = this._settings.get_int('menu-glass-expand');
            }
        });

        connectSetting('menu-y-offset', () => {
            if (this.animActor && this._isEffectActive) {
                this._menuYoffset = this._settings.get_int('menu-y-offset');
                this.animActor.translation_y = this._menuYoffset;
            }
        });

        connectSetting('menu-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('menu-enable-adaptive-text-color');
        });

        connectSetting('menu-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('menu-sample-interval-ms');

        });
    }

    _applyEffect() {
        if (this._isEffectActive) return;
        this._isEffectActive = true;

        if (!this.targetActor) return;
        
        // Remove default GNOME styling and make the background transparent
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-transparent');

        const messageList = Main.panel.statusArea.dateMenu._messageList;
        if (messageList && messageList.actor) {
            messageList.actor.add_style_class_name('liquid-glass-message-list');
        }
        this.animActor.add_style_class_name('liquid-glass-menu-root');

        // Shift the menu down to prevent it from clipping into the top bar
        this._menuYoffset = this._settings.get_int('menu-y-offset');
        this.animActor.translation_y = this._menuYoffset;
        // this.targetActor.margin_top = MENU_Y_OFFSET;

        this._glassExpand = this._settings.get_int('menu-glass-expand');

        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('menu-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('menu-sample-interval-ms'),
        };

        // Create the main background actor that will hold the glass effect
        // clip_to_allocation is false so the shader can draw outside the strict bounds if needed
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        
        // Set an initial size of 1x1. Passing a 0x0 size to the Cogl engine 
        // while applying a shader will immediately crash the GNOME Shell.
        this.bgActor.set_size(1.0, 1.0);

        // Internal box to hold the desktop/window clones and clip them perfectly
        this.clipBox = new St.Widget({
            clip_to_allocation: true
        });
        this.bgActor.add_child(this.clipBox);
        
        // Set pivot points for scaling. 
        // The menu scales from the top-center (0.5, 0.0)
        this.animActor.set_pivot_point(0.5, 0.0);
        
        // bgActor scales from the top-left (0.0, 0.0) because we manually sync its exact coordinates
        this.bgActor.set_pivot_point(0.0, 0.0);

        // Insert the custom background *underneath* the actual menu UI
        let menuParent = this.menu.actor.get_parent();
        if (menuParent) {
            menuParent.insert_child_below(this.bgActor, this.menu.actor);
        } else {
            // Fallback: If it has no parent yet, add it directly to the UI group
            Main.uiGroup.add_child(this.bgActor);
        }

        let blurRadius = this._settings.get_int('menu-blur-radius');
        let tintColorStr = this._settings.get_string('menu-tint-color');
        let tintStrength = this._settings.get_double('menu-tint-strength');
        let cornerRadius = this._settings.get_double('menu-corner-radius');

        // Apply native GNOME blur to the internal clipBox (which contains the clones)
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);

        // Apply our custom GLSL liquid shader to the outer background actor
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath });
        
        // Tell the shader about the padding so it calculates refraction coordinates correctly
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr)); // Pure transparent base
        this.effect.setTintStrength(tintStrength); // Subtle tint strength to enhance the glass look without overpowering the background
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);

        this.bgActor.show();

        // Helper functions to hook into GNOME's render pipeline
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback) ??
                Meta.later_add(laterType, callback);
        };

        const laterRemove = id => {
            if (!id) return;
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(id);
            else if (Meta.later_remove)
                Meta.later_remove(id);
        };

        // Hook into the frame right before it is painted to the screen
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW ?? Meta.LaterType.BEFORE_PAINT;

        // Function to create clones of the desktop wallpaper and all visible windows
        // This is necessary because GNOME cannot blur content behind an overlay popup directly
        let buildClones = () => {
            if (!this.bgActor) return;
            
            // Clean up old clones before creating new ones
            if (this.bgClone) {
                this.bgClone.destroy();
                this.bgClone = null;
            }
            if (this.windowClonesContainer) {
                this.windowClonesContainer.destroy();
                this.windowClonesContainer = null;
            }
            if (this.overviewCloneContainer) {
                this.overviewCloneContainer.destroy();
                this.overviewCloneContainer = null;
            }

            // Clone the desktop background
            this.bgClone = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
            this.clipBox.add_child(this.bgClone); 

            this.overviewCloneContainer = new Clutter.Actor();
            this.clipBox.add_child(this.overviewCloneContainer);

            // Create a container for the window clones
            this.windowClonesContainer = new Clutter.Actor();
            this.clipBox.add_child(this.windowClonesContainer);

            this._windowClones.clear();
            this._overviewClone = null; 
            this._appDisplayClone = null;
            this._searchClone = null;

            // Iterate through all windows managed by the compositor
            let windows = global.get_window_actors();
            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                
                // Skip minimized or hidden windows to save performance
                if (!metaWindow || metaWindow.minimized || !w.visible) {
                    continue;
                }

                // Clone the active window and place it at its exact screen coordinates
                let clone = new Clutter.Clone({ source: w });
                clone.set_position(w.x, w.y);
                this.windowClonesContainer.add_child(clone);

                this._windowClones.set(w, clone);
            }
        };

        // Render loop function, called every frame while the menu is mapped (visible)
        let frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.targetActor.mapped)
                return GLib.SOURCE_REMOVE;

            this._syncGeometry(); 
            this._frameSyncId = laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };

        // Starts the render loop and builds fresh clones when the menu is opened
        let startFrameSync = () => {
            if (this._frameSyncId === 0) {
                buildClones();
                this._frameSyncId = laterAdd(frameLaterType, frameTick);
            }
        };
        
        let stopFrameSync = () => { // eslint-disable-line no-unused-vars
            if (this._frameSyncId !== 0) {
                laterRemove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };

        // Clear the cached size whenever the menu opens so it can recalculate 
        // based on any new notifications or calendar events added
        this._signals.push(this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._stableBaseW = undefined;
                this._stableBaseH = undefined;
                startFrameSync();
                this._startAdaptiveColorSampling();
            } else {
                this._stopAdaptiveColorSampling();
            }
        }));

        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }

    // 追加: UIクローンの位置・サイズ同期用メソッド
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

    // Calculates and synchronizes the position/size of the glass background every frame
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped)
            return;

        let [inW, inH] = this.animActor.get_size();
        let [outW, outH] = this.targetActor.get_size();
        let [scaleX, scaleY] = this.animActor.get_scale();

        let themeNode = this.animActor.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

        let marginW = mL + mR;
        let marginH = mT + mB;

        let targetW = Math.round(inW);
        let targetH = Math.round(inH);

        // バグ検知フラグを用意
        let isBugActive = false;

        // GNOME Shell Hover Bug Compensation:
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
            isBugActive = true; // バグ発動中！
        }

        this._stableBaseW = targetW;
        this._stableBaseH = targetH;

        // Multiply by the current animation scale. 
        // Math.max guarantees the size never drops below 1px (prevents Cogl crashes).
        let w = Math.max(1, this._stableBaseW * scaleX);
        let h = Math.max(1, this._stableBaseH * scaleY);

        // --- ここから修正 ---
        // 実際のUIコンテンツ領域である animActor から直接正しい座標を取得する
        let [animAbsX, animAbsY] = this.animActor.get_transformed_position();

        // --------------------------------------------------------
        // Advanced Fallback Logic for NaN Coordinates
        // GNOME sometimes fails to report actor positions during the very first frame
        // of an animation. This logic predicts where the menu should be.
        // --------------------------------------------------------
        if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
            if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
                // Use the last known good coordinates if available
                animAbsX = this._lastValidAnimAbsX;
                animAbsY = this._lastValidAnimAbsY;
            } else {
                // If no history exists, calculate based on the top panel clock button
                let buttonActor = Main.panel.statusArea.dateMenu.actor;
                let [btnX, btnY] = buttonActor.get_transformed_position();
                let [btnW, btnH] = buttonActor.get_size();
                
                if (!Number.isNaN(btnX) && !Number.isNaN(btnY)) {
                    // Assume the menu opens centered directly below the clock button
                    animAbsX = btnX + (btnW / 2) - (w / 2);
                    animAbsY = btnY + btnH + MENU_Y_OFFSET;
                } else {
                    // Ultimate fallback: Just place it in the top-center of the primary monitor
                    let monitor = Main.layoutManager.primaryMonitor;
                    animAbsX = (monitor.width / 2) - (w / 2);
                    animAbsY = (Main.panel.height || 27) + MENU_Y_OFFSET; 
                }
            }
        } else {
            // Save successful coordinates for future fallbacks
            this._lastValidAnimAbsX = animAbsX;
            this._lastValidAnimAbsY = animAbsY;
        }
        
        // --------------------------------------------------------

        // The background needs to be larger than the UI to account for the glass expansion
        // and the extra padding required by the shader for edge refraction.
        let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        
        // UIの正確な座標に対して、純粋にパディング分だけマイナスして背景を被せる
        let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
        let bgY = animAbsY - this._glassExpand - SHADER_PADDING;

        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            
            // Only update positions/sizes if they actually changed to save CPU cycles
            if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
                this.bgActor.set_size(bgW, bgH);
                this.bgActor.set_position(bgX, bgY);
                
                // The internal clip region shares the same size, but sits at (0,0) relative to bgActor
                this.clipBox.set_size(bgW, bgH);
                this.clipBox.set_position(0, 0);

                // Update the shader with the new resolution
                this.effect.setResolution(bgW, bgH);

                this._lastBgW = bgW; this._lastBgH = bgH;
                this._lastBgX = bgX; this._lastBgY = bgY;
            }
        }

        // Apply a negative offset to the clones inside the clipBox.
        // This ensures the cloned background matches the real desktop coordinates perfectly,
        // even while the menu is scaling and moving around.
        if (this.bgClone && this.windowClonesContainer && !Number.isNaN(bgX) && !Number.isNaN(bgY)) {
            this.bgClone.set_position(-bgX, -bgY);
            this.windowClonesContainer.set_position(-bgX, -bgY);

            if (this.overviewCloneContainer) {
                this.overviewCloneContainer.set_position(-bgX, -bgY);
            }

            // Efficient window synchronization logic.
            let isOverview = Main.overview.visible || Main.overview.animationInProgress;
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0; // Tracks the stacking order

            if (!isOverview) {
                // --- 通常時 ---
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
                        // Create a clone for newly opened windows.
                        clone = new Clutter.Clone({ source: w });
                        this.windowClonesContainer.add_child(clone);
                        this._windowClones.set(w, clone);
                    } else {
                        // Retrieve existing clone.
                        clone = this._windowClones.get(w);
                    }
                    
                    // Keep the position synchronized with the real window.
                    clone.set_position(w.x, w.y);

                    // Update the Z-index dynamically to reflect window focus changes.
                    this.windowClonesContainer.set_child_at_index(clone, zIndex);
                    zIndex++;
                }
            } else {
                // --- Overview時 ---
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

            // Destroy clones for windows that have been closed or minimized.
            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }

    // Updates the shader resolution based on the current background actor size
    _updateResolution() {
        if (!this.bgActor || !this.effect) return;
        let [width, height] = this.bgActor.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.effect.setResolution(width, height);
        }
    }

    // Utility function to safely check if an actor has a specific style class
    _hasStyleClass(actor, className) {
        return typeof actor?.has_style_class_name === 'function' &&
            actor.has_style_class_name(className);
    }

    /*
    // Simplified target collection to use a single top-down recursive pass.
    _collectAdaptiveTextTargets(actor = this.menu?.actor, inPlaceholder = false, inToday = false, targets = []) {
        if (!actor) return targets;

        // Check if the current element has the target parent class and update the corresponding flag.
        const isPlaceholder = inPlaceholder || this._hasStyleClass(actor, 'message-list-placeholder');
        const isToday = inToday || this._hasStyleClass(actor, 'datemenu-today-button');

        // Check if the actor matches the specified target criteria.
        if (typeof actor.set_style === 'function') {
            if (this._hasStyleClass(actor, 'message-list-clear-button')) {
                targets.push(actor);
            } else if (isPlaceholder && (actor instanceof St.Label || actor instanceof St.Icon)) {
                targets.push(actor);
            } else if (isToday && actor instanceof St.Label && (this._hasStyleClass(actor, 'day-label') || this._hasStyleClass(actor, 'date-label'))) {
                targets.push(actor);
            }
        }

        // Recurse through children, passing down the flag indicating which parent context we are currently in.
        const children = actor.get_children?.() ?? [];
        for (let i = 0; i < children.length; i++) {
            this._collectAdaptiveTextTargets(children[i], isPlaceholder, isToday, targets);
        }

        return targets;
    }
    */
    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor) return targets;
        return this._findAllTextActors(this.menu?.actor);
    }

    _findAllTextActors(actor, foundActors = []) {
        if (!actor) return foundActors;

        // 該当するテキストまたはボタン要素で、かつ可視状態のものを収集
        if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon) {
            if (actor.visible) {
                foundActors.push(actor);
            }
        }

        // 子要素を再帰的に走査
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }

        return foundActors;
    }

    // Initiates the color change for a specific actor
    _setActorColor(actor, color) {
        if (!actor || typeof actor.set_style !== 'function') return;

        if (!this._styledActors.has(actor)) {
            let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
            this._styledActors.set(actor, origStyle);
        }

        let isInsensitive = false;
        if (actor instanceof St.Button) {
            isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
        }
        // Save the target color to prevent redundant animation triggers for the same color.
        // if (actor._currentTargetColor === color) return;
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;

        // Kick off the color transition animation!
        this._animateActorColor(actor, color, isInsensitive);
    }

    // Removes all dynamically applied adaptive text color styles and stops related animations
    _clearAdaptiveStyles() {
        // 1. 変更履歴 (styledActors) から元の状態を復元する
        for (const [actor, originalStyle] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = null;
                }
                actor._currentTargetColor = null;
                actor._currentInsensitiveState = null;
                
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                
                // 修正: 存在しない remove_style() を削除し、元のスタイル(またはnull)をセット
                actor.set_style(originalStyle || null);
            }
        }
        this._styledActors.clear();

        // 2. 念のため、現在DOM上に存在するターゲットの色も強制クリア（フェイルセーフ）
        const currentTargets = this._collectAdaptiveTextTargets();
        for (let actor of currentTargets) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = null;
                }
                actor._currentTargetColor = null;
                actor._currentInsensitiveState = null;
                actor.set_style(null);
            }
        }
    }

    // Iterates through the color map and applies the new target colors to the respective actors
    _applyAdaptiveColorMap(colorMap) {
        if (!colorMap || colorMap.size === 0)
            return;

        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color);
        }
    }

    // Starts the timer for periodically sampling contrast and updating adaptive text colors
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
                if (!this.menu?.isOpen) {
                    this._adaptiveTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                this._updateAdaptiveTextColors();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    // Stops the adaptive color sampling timer
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }

    // Collects target actors, samples their contrast, and triggers color updates
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
                console.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
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

    _animateActorColor(actor, targetHexColor, isInsensitive) {
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
        
        // 無効状態なら透明度を50%(0.5)にし、有効なら100%(1.0)にする
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0; // Clutter.Colorのalphaは0〜255で返る
        
        let startTime = GLib.get_monotonic_time();
        let durationMs = 380; // Animation duration in milliseconds

        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
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

            // Alpha値も補間して rgba() 形式を生成
            let a = startAlpha + (targetAlpha - startAlpha) * easeProgress;
            a = Math.max(0.0, Math.min(1.0, a)); // 0.0 ~ 1.0 に安全にクランプ
            
            let alphaStr = a.toFixed(3); // CSS用に小数点第3位まで
            let currentRgba = `rgba(${r}, ${g}, ${b}, ${alphaStr})`;

            // Override text color and icon foreground color directly using inline CSS
            actor.set_style(`color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`);

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
                    // opacity = Math.min(255, Math.max(0, (s / 0.6) * 255));
                    // opacity = 255;
                } else {
                    // Start opening from scale 0.2 instead of 0.0 so it looks less jarring
                    currentScale = 0.2 + (s * 0.8); 
                    // opacity = Math.min(255, Math.max(0, s * 255));
                    opacity = Math.min(255, Math.max(0, (s / 0.3) * 255));
                }

                // Apply the calculated scale to the UI
                this.animActor.set_scale(currentScale, currentScale);

                // Dynamically adjust the shader's corner radius during the animation.
                // As the menu shrinks, the absolute radius shrinks too, keeping the corners proportional.
                if (this.effect && typeof this.effect.setCornerRadius === 'function') {
                    let baseRadius = CORNER_RADIUS; 
                    this.effect.setCornerRadius(baseRadius * currentScale);
                    if (typeof this.effect.setAnimationScale === 'function') {
                        this.effect.setAnimationScale(currentScale);
                    }
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
                        this.bgActor.opacity = 0; // Ensure the background is fully transparent when closed
                        this.animActor.opacity = 0;
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

    _removeEffect() {
        if (!this._isEffectActive) return;
        this._isEffectActive = false;

        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        
        // Disconnect all event listeners
        for (let sigId of this._signals) {
            this.menu.disconnect(sigId); 
        }
        this._signals = [];
        
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            else if (Meta.later_remove)
                Meta.later_remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-menu-root');
            
            // Revert UI shifts and forced states
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
        }

        const messageList = Main.panel.statusArea.dateMenu._messageList;
        if (messageList && messageList.actor) {
            messageList.actor.add_style_class_name('liquid-glass-message-list');
        }

        // Revert UI shifts and forced states when extension is disabled
        this.targetActor.translation_y = 0;
        // this.targetActor.margin_top = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.opacity = 255;
        
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;

            // If the menu is currently open, forcefully close it 
            // without animations to reset GNOME's internal state
            if (this.menu.isOpen) {
                this.menu.close(false); 
            }
        }
        
        // Destroy all injected actors and clones
        if (this.bgActor) { 
            this.bgActor.destroy(); 
            this.bgActor = null; 
        }
        
        this.effect = null;
        this.blurEffect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        
        this._windowClones.clear();

        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }

    cleanup() {
        if (!this.targetActor) return;
        this._removeEffect();
    }
}

// A straightforward mathematical implementation of Hooke's Law for spring physics
class Spring {
    constructor(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping;     // Friction (higher = less bounce, settles quicker)
        this.mass = mass;           // Weight of the object
        
        this.value = 0;             // Current position/scale
        this.velocity = 0;          // Current speed
        this.target = 0;            // Destination value
    }

    update(elapsedMs) {
        // Cap max delta time to prevent the spring from violently exploding during heavy CPU load
        let dt = elapsedMs / 1000;
        if (dt > 0.033) dt = 0.033;

        // F = -k * x
        let springForce = -this.stiffness * (this.value - this.target);
        
        // F = -c * v
        let dampingForce = -this.damping * this.velocity;
        
        // a = F / m
        let acceleration = (springForce + dampingForce) / this.mass;
        
        // Update velocity and position using Euler integration
        this.velocity += acceleration * dt;
        this.value += this.velocity * dt;

        // Return true if the spring has virtually stopped moving and reached its destination
        return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
    }
}