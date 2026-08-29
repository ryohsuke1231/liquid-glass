// src/quickSettingsManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager, isActorValid, SelfExcludingSnapshotCapture, TextureBlitActor, LayoutOpaqueActor, } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class QuickSettingsManager {
    extensionPath;
    _settings;
    _logger;
    targetActor;
    menu;
    animActor;
    bgActor;
    liquidBox = null;
    _cloneContainer = null;
    effect;
    _windowCloneManager = null;
    _uiSampler = null;
    // [FIX] Toggles-mode structural redesign — see _ensurePanelContentClone().
    // `_menuRoot` is the same uiGroup-direct-child ancestor of `this.menu.actor`
    // computed once in _applyToggleEffect()/_applyBackgroundEffect(), cached
    // here so the per-frame sync loop can clone/position it without
    // recomputing the ancestor walk every frame.
    _menuRoot = null;
    // A Clutter.Clone of `_menuRoot` — i.e. the panel exactly as GNOME/the
    // theme renders it, completely untouched — inserted into _cloneContainer
    // ON TOP of the real desktop windows/wallpaper clones from
    // _windowCloneManager, so the glass (now painted structurally ON TOP of
    // the real panel — see _applyToggleEffect()) has something correct to
    // sample/refract within each toggle's own region.
    _panelContentClone = null;
    // [FIX-5] See LayoutOpaqueActor in utils.ts — the intermediary host that
    // actually gets inserted into animActor, so animActor's own real
    // St.BoxLayout sizing never sees bgActor's fixed 1920x1080 size.
    _toggleGlassHost = null;
    // Cached monitor dimensions for change detection
    _lastScreenW;
    _lastScreenH;
    _isEffectActive;
    buttonAlpha;
    _buttonTimerId;
    _styledButtons;
    _buttonSignalIds;
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    // Spring physics parameters
    _springScale;
    _springPos;
    _springStiffness;
    _springDamping;
    _springMass;
    _enableAnimation;
    _tickId;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _hasAutoRefreshed;
    _settingsSignals;
    _adaptiveConfig;
    // Used in _syncGeometry
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _cornerRadius = 0;
    _animationInterval = 16;
    // Flag to forcefully move submenus using translation_x, translation_y
    _enableSubmenuFix = false;
    _cachedSubmenus = null; // Cache of submenus
    // ── "Apply to" (Background / Toggles) ──────────────────────────────────────
    // quick-settings-apply-to. Read into _applyTo on every settings change, but
    // only takes effect the next time the menu opens (_activeMode records which
    // mode is actually running right now) — see connectSetting() below.
    _applyTo = 'background';
    _activeMode = null;
    // Cached [r,g,b] from quick-settings-tint-color (0..1), shared by both
    // modes: Background passes it straight to LiquidEffect.setTintColor();
    // Toggles blends it per-toggle with each toggle's own sampled color (see
    // _syncToggleRegions()).
    _tintColorArray = [1.0, 1.0, 1.0];
    // Toggles-mode-only parameters
    _toggleTintStrength = 0.5;
    _toggleCornerRadius = 18.0;
    // Per-toggle-pod tracked state: the sampled background color of the pod's
    // "primary" button (used for tinting; re-sampled periodically since it
    // changes with ON/OFF and hover state), plus the list of every actor
    // inside the pod whose own background we've forced transparent, along
    // with each one's original inline style (to restore on cleanup).
    //
    // A "pod" is either a standalone `.quick-toggle` button (e.g. Night
    // Light, Do Not Disturb — styledSubs has exactly one entry, the button
    // itself) or a `.quick-toggle-has-menu` wrapper (split toggles like
    // Wi-Fi/Bluetooth that have a separate arrow/expand button beside the
    // main button — styledSubs has one entry per interactive child: the main
    // `.quick-toggle` button, the `.quick-toggle-separator` line, and the
    // `.quick-toggle-menu-button` arrow). See _findAllToggleContainers() and
    // _getStylableSubActors() below.
    _toggleRegions = new Map();
    _toggleColorTimerId = 0;
    // [FIX] Arms _resampleToggleColors()'s diagnostic logging for the next
    // N calls (see there) — decremented once per call, so N * 400ms of
    // logging. Re-armed each time _applyToggleEffect() runs, so
    // disabling/re-enabling Quick Settings' Toggles mode (or the whole
    // extension) gets a fresh logging window.
    _debugToggleColorLogFrames = 15;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        // Target the main container of the Quick Settings menu
        this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
        this.menu = Main.panel.statusArea.quickSettings.menu;
        // Target for animations and visual offsets (The inner content)
        this.animActor = Main.panel.statusArea.quickSettings.menu.box;
        this.bgActor = null;
        this.effect = null;
        this._signals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
        this._hasAutoRefreshed = false;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        // Custom spring physics parameters for the open/close animation
        // Spring(stiffness, damping, mass)
        this._springScale = new Spring(120, 8, 1.0);
        this._springPos = new Spring(300, 12, 1.0);
        this._springStiffness = 120;
        this._springDamping = 8;
        this._springMass = 1.0;
        this._enableAnimation = true;
        this._tickId = 0;
        this._contrastSampler = new StageContrastSampler();
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._settingsSignals = [];
        this.buttonAlpha = 0.8;
        this._buttonTimerId = 0;
        this._styledButtons = new Map();
        this._buttonSignalIds = new Map();
        this._enableSubmenuFix = true;
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        // Setup spring parameters
        this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
        this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
        this._springDamping = this._settings.get_double('quick-settings-spring-damping');
        this._springMass = this._settings.get_double('quick-settings-spring-mass');
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);
        // "Apply to" (Background / Toggles) and Toggles-mode-only parameters
        this._applyTo = this._settings.get_int('quick-settings-apply-to') === 1 ? 'toggles' : 'background';
        this._toggleTintStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
        this._toggleCornerRadius = this._settings.get_double('quick-settings-toggle-corner-radius');
        if (this._settings.get_boolean('enable-quick-settings-glass')) {
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
    _getMenuMonitorGeometry() {
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    }
    _applyMenuOffsets() {
        if (!this.targetActor)
            return;
        this.targetActor.translation_y = this._menuYoffset;
        this.targetActor.translation_x = this._menuXoffset;
    }
    // Dynamically apply settings changes
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF toggle
        connectSetting('enable-quick-settings-glass', () => {
            let enabled = this._settings.get_boolean('enable-quick-settings-glass');
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('enable-quick-settings-animation', () => {
            this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
        });
        connectSetting('quick-settings-spring-stiffness', () => {
            this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-spring-damping', () => {
            this._springDamping = this._settings.get_double('quick-settings-spring-damping');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-spring-mass', () => {
            this._springMass = this._settings.get_double('quick-settings-spring-mass');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('quick-settings-animation-interval-ms', () => {
            this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
        });
        connectSetting('quick-settings-tint-color', () => {
            // Cached regardless of mode: Toggles mode blends this into each
            // toggle's own tint on the next frame sync (_syncToggleRegions), so it
            // doesn't need a direct effect.setTintColor() push here.
            this._tintColorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
            if (this.effect && this._activeMode === 'background') {
                this.effect.setTintColor(...this._tintColorArray);
            }
        });
        connectSetting('quick-settings-tint-strength', () => {
            if (this.effect) {
                this.effect.setTintStrength(this._settings.get_double('quick-settings-tint-strength'));
            }
        });
        connectSetting('quick-settings-blur-radius', () => {
            if (this.effect) {
                this.effect.setBlurRadius(this._settings.get_int('quick-settings-blur-radius'));
            }
        });
        connectSetting('quick-settings-corner-radius', () => {
            this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
            // Toggles mode drives the shared corner_radius uniform from
            // quick-settings-toggle-corner-radius instead (see below) — guard so
            // the two settings don't fight over the same uniform.
            if (this.effect && this._activeMode === 'background') {
                this.effect.setCornerRadius(this._cornerRadius);
            }
        });
        // "Apply to" (Background / Toggles). Switches live: if the effect is
        // currently running in the OTHER mode, tear it down and rebuild it
        // immediately in the new mode instead of waiting for the next full
        // re-enable (previously this only updated the cached _applyTo value —
        // see the _activeMode vs. _applyTo comment above).
        connectSetting('quick-settings-apply-to', () => {
            const newMode = this._settings.get_int('quick-settings-apply-to') === 1 ? 'toggles' : 'background';
            this._applyTo = newMode;
            if (this._isEffectActive && this._activeMode !== null && this._activeMode !== newMode) {
                this._removeEffect();
                this._applyEffect();
            }
        });
        connectSetting('quick-settings-toggle-tint-strength', () => {
            this._toggleTintStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
        });
        connectSetting('quick-settings-toggle-corner-radius', () => {
            this._toggleCornerRadius = this._settings.get_double('quick-settings-toggle-corner-radius');
            if (this.effect && this._activeMode === 'toggles') {
                this.effect.setCornerRadius(this._toggleCornerRadius);
            }
        });
        connectSetting('quick-settings-glass-expand', () => {
            if (this.effect) {
                this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
            }
        });
        connectSetting('quick-settings-y-offset', () => {
            if (this.targetActor) {
                this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('quick-settings-x-offset', () => {
            if (this.targetActor) {
                this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
                this._applyMenuOffsets();
            }
        });
        connectSetting('quick-settings-enable-adaptive-text-color', () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean('quick-settings-enable-adaptive-text-color');
        });
        connectSetting('quick-settings-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('quick-settings-sample-interval-ms');
        });
        // Brightness / Saturation / Contrast — dynamic application from settings
        connectSetting('quick-settings-brightness', () => {
            if (this.effect) {
                this.effect.setBrightness(this._settings.get_double('quick-settings-brightness'));
            }
        });
        connectSetting('quick-settings-saturation', () => {
            if (this.effect) {
                this.effect.setSaturation(this._settings.get_double('quick-settings-saturation'));
            }
        });
        connectSetting('quick-settings-contrast', () => {
            if (this.effect) {
                this.effect.setContrast(this._settings.get_double('quick-settings-contrast'));
            }
        });
    }
    _applyClassStyles() {
        if (!this.targetActor)
            return;
        if (!this._hasStyleClass(this.targetActor, 'liquid-glass-transparent'))
            this.targetActor.add_style_class_name('liquid-glass-transparent');
        if (!this._hasStyleClass(this.animActor, 'liquid-glass-transparent'))
            this.animActor.add_style_class_name('liquid-glass-transparent');
        if (!this._hasStyleClass(this.animActor, 'liquid-glass-qs-root'))
            this.animActor.add_style_class_name('liquid-glass-qs-root');
    }
    // Entry point used by setup()/_bindSettings(). Dispatches to the
    // Background or Toggles implementation based on _applyTo. Per design, a
    // change to quick-settings-apply-to while the effect is already active
    // does NOT switch live — it only takes effect the next time the effect is
    // (re)applied (i.e. next time the menu opens after a full re-enable).
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        this._activeMode = this._applyTo;
        this._tintColorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
        if (this._activeMode === 'toggles') {
            this._applyToggleEffect();
        }
        else {
            this._applyBackgroundEffect();
        }
    }
    // ── Background mode (existing behaviour, unchanged) ─────────────────────────
    _applyBackgroundEffect() {
        // Shift the menu down to prevent it from clipping into the top bar
        this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
        this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
        };
        // ── 1. bgActor: full monitor, no effect ──────────────────────────────────
        // Create the main background actor that covers the full monitor
        this.bgActor = new UnpickableActor();
        this.bgActor.set_name('liquid-glass-bg-actor');
        // Set an initial size of 1x1. Passing a 0x0 size to the Cogl engine 
        // while applying a shader will immediately crash the GNOME Shell.
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
        // Scale pivot points
        // The menu scales from the top-center (0.5, 0.0)
        this.animActor.set_pivot_point(0.5, 0.0);
        // bgActor scales from the top-left (0.0, 0.0) because we manually sync its exact coordinates
        this.bgActor.set_pivot_point(0.0, 0.0);
        // ── Find the menuActor's ancestor that is a direct child of uiGroup ───────
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        // Insert bgActor below menuRoot in uiGroup to prevent recursive clone loops
        // Insert the custom background *underneath* the actual menu UI
        if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
        }
        else {
            // Fallback: If it has no parent yet, add it directly to the UI group
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        // ── 5. Read effect parameters from settings ───────────────────────────────
        let blurRadius = this._settings.get_int('quick-settings-blur-radius');
        let tintColorStr = this._settings.get_string('quick-settings-tint-color');
        let tintStrength = this._settings.get_double('quick-settings-tint-strength');
        this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
        let brightness = this._settings.get_double('quick-settings-brightness');
        let saturation = this._settings.get_double('quick-settings-saturation');
        let contrast = this._settings.get_double('quick-settings-contrast');
        // LiquidEffect on liquidBox (includes built-in dual-Kawase blur)
        // Apply our custom GLSL liquid shader to the outer background actor
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        // Tell the shader about the padding so it calculates refraction coordinates correctly
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(this._cornerRadius);
        this.effect.setIsDock(false);
        this.effect.setBrightness(brightness);
        this.effect.setSaturation(saturation);
        this.effect.setContrast(contrast);
        this.effect.setBlurRadius(blurRadius);
        this.liquidBox.add_effect(this.effect);
        // ── 5. WindowCloneManager + UILayerSampler ────────────────────────────────
        this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer);
        this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [menuRoot, global.windowGroup, global.window_group], this._cloneContainer);
        this.bgActor.hide();
        // ── Helper functions for GNOME's render pipeline ──────────────────────────
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback);
        };
        const laterRemove = (id) => {
            if (!id)
                return;
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(id);
        };
        // Hook into the frame right before it is painted to the screen
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        // Clone build: applies mutual liquid-glass exclusions, then delegates to managers
        let buildClones = () => {
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
        };
        // Frame render loop (runs every frame while the menu is mapped)
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
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                laterRemove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        if (this._hasAutoRefreshed === undefined)
            this._hasAutoRefreshed = false;
        this._signals = [];
        // Handle the first open as a plain GNOME quick settings open; apply custom behavior only afterwards.
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._cachedSubmenus = null; // Reset submenu cache
                if (!this._hasAutoRefreshed)
                    this._hasAutoRefreshed = true;
                this._applyClassStyles();
                this._applyMenuOffsets();
                this._stableBaseW = undefined;
                this._stableBaseH = undefined;
                startFrameSync();
                // Skip animations on the first open for instant feedback
                this._startAdaptiveColorSampling(true);
                this._startButtonAlphaSampling();
                this._startAnimation(1);
                return;
            }
            this._applyClassStyles();
            this._applyMenuOffsets();
            this._stopAdaptiveColorSampling();
            this._stopButtonAlphaSampling();
            this._startAnimation(0);
        });
        // Monitor the signal when the menu's mapped state changes
        // Stop the render loop when the menu unmaps (fully hidden)
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                // When the menu is completely hidden from the screen
                if (!this.menu.actor.mapped) {
                    // Stop the render/sync loop here for the first time
                    stopFrameSync();
                    // Ensure cleanup is done reliably
                    if (this.bgActor) {
                        this.bgActor.hide();
                        this.bgActor.opacity = 0;
                    }
                    if (this.animActor) {
                        this.animActor.opacity = 0;
                    }
                }
            })
        });
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // ── Toggles mode ─────────────────────────────────────────────────────────
    // Unlike Background mode, this never touches animation (spring/scale) or
    // the panel's own background — it draws small independent glass "chips"
    // only over each individual toggle pod. To stay compatible with the
    // Blur My Shell workaround, it still uses ONE full-monitor bgActor/
    // liquidBox/effect (same set_clip() technique as Background mode) so the
    // blur pyramid and window clones are computed exactly once per frame,
    // regardless of how many toggles are on screen — see _syncToggleRegions().
    _applyToggleEffect() {
        if (!this.targetActor)
            return;
        // Re-arm the toggle-color diagnostic logging (see
        // _debugToggleColorLogFrames/_resampleToggleColors()) each time
        // Toggles mode is (re-)applied, so disabling/re-enabling the effect
        // (or the extension) is enough to get a fresh window of logs without
        // needing a code change.
        this._debugToggleColorLogFrames = 15;
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._toggleTintStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
        this._toggleCornerRadius = this._settings.get_double('quick-settings-toggle-corner-radius');
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
        };
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
        this.bgActor.set_pivot_point(0.0, 0.0);
        // ── Find the menuActor's ancestor that is a direct child of uiGroup ───────
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        this._menuRoot = menuRoot;
        // [FIX-STRUCTURAL-3] Per user proposal: instead of drawing the real
        // panel first and painting bgActor OVER the whole uiGroup (which is
        // what forced lowering the glass's own opacity/blur just to let each
        // toggle's label/icon peek back through), make bgActor a plain CHILD
        // of `animActor` (== Main.panel.statusArea.quickSettings.menu.box —
        // the actual `popup-menu-content quick-settings` box that directly
        // holds the toggle grid) at index 0. Clutter paints children in list
        // order, so every real toggle (already a later sibling in animActor)
        // now paints AFTER — on top of — bgActor for free, structurally, with
        // zero opacity/blur compromise and no per-icon/per-label cloning.
        //
        // This needs bgActor to keep behaving as if it still spans the full
        // monitor in monitor-space (all of _syncToggleRegions()'s region math
        // below assumes that). Since it's now parented under animActor
        // instead of uiGroup, animActor's own transform sits between bgActor
        // and the stage, so bgActor's position is counter-translated by
        // animActor's current absolute position every frame in
        // _syncToggleRegions() (see the animActor counter-transform there) —
        // the same technique applicationManager.ts's _applyCounterScale() uses
        // to keep a child's rendered content true-to-screen-space regardless
        // of its parent's own transform.
        //
        // [FIX-5] animActor is a real St.BoxLayout, not a plain Clutter.Actor
        // like uiGroup — it actively queries each direct child's own
        // get_preferred_width()/height() and stacks/sums them into ITS OWN
        // size. bgActor has an explicit fixed size set on it (set_size(screenW,
        // screenH)), which Clutter reports straight back as its preferred size
        // regardless of layout manager — so animActor's own allocation ballooned
        // to include bgActor's full 1920x1080, and the whole screen turned into
        // a dark rectangle with no toggles visible. Inserting bgActor inside a
        // LayoutOpaqueActor host (which unconditionally reports 0x0 preferred
        // size to whatever contains it, see utils.ts) gives animActor nothing
        // to balloon over, while bgActor keeps its own full-monitor geometry
        // entirely self-managed underneath.
        if (!this._toggleGlassHost) {
            this._toggleGlassHost = new LayoutOpaqueActor();
            this._toggleGlassHost.set_name('liquid-glass-toggle-host');
        }
        if (this.bgActor.get_parent() !== this._toggleGlassHost) {
            this.bgActor.get_parent()?.remove_child(this.bgActor);
            this._toggleGlassHost.add_child(this.bgActor);
        }
        // [!] OPEN RISK — needs verification: _ensurePanelContentClone() below
        // clones `_menuRoot` live via Clutter.Clone to get "this toggle,
        // refracted" content. `animActor` (and therefore bgActor) is a
        // descendant of `_menuRoot`, so that clone's source subtree now
        // contains bgActor itself — the exact self-referential capture loop
        // utils.ts's SelfExcludingSnapshotCapture (+ TextureBlitActor) exists
        // to prevent (see their doc comments; currently unused by this file,
        // but built for precisely this "our own glass root sits inside what
        // we need to sample" situation, and already proven for the Blur My
        // Shell panel capture). _ensurePanelContentClone() should be migrated
        // from a live Clutter.Clone(_menuRoot) to a snapshot acquired via
        // SelfExcludingSnapshotCapture (hiding bgActor for one synchronous
        // paint_to_content() call, same as that class already does for its
        // own hide-list) before this ships — left as-is here rather than
        // guessed at blind, since it's not exercisable outside a running shell.
        if (this.animActor instanceof Clutter.Actor) {
            this.animActor.insert_child_at_index(this._toggleGlassHost, 0);
        }
        else if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_above(this._toggleGlassHost, menuRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this._toggleGlassHost);
        }
        // ── 4. Read effect parameters from settings ───────────────────────────────
        let blurRadius = this._settings.get_int('quick-settings-blur-radius');
        let tintStrength = this._settings.get_double('quick-settings-tint-strength');
        let brightness = this._settings.get_double('quick-settings-brightness');
        let saturation = this._settings.get_double('quick-settings-saturation');
        let contrast = this._settings.get_double('quick-settings-contrast');
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(this._toggleCornerRadius);
        this.effect.setIsDock(false);
        this.effect.setBrightness(brightness);
        this.effect.setSaturation(saturation);
        this.effect.setContrast(contrast);
        this.effect.setBlurRadius(blurRadius);
        this.effect.setMultiRegionMode(true);
        this.liquidBox.add_effect(this.effect);
        // ── 5. WindowCloneManager + UILayerSampler (ONE shared instance) ──────────
        this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer);
        this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [menuRoot, global.windowGroup, global.window_group], this._cloneContainer);
        this.bgActor.hide();
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback);
        };
        const laterRemove = (id) => {
            if (!id)
                return;
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(id);
        };
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        let buildClones = () => {
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
        };
        let frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.targetActor.mapped)
                return GLib.SOURCE_REMOVE;
            this._syncToggleRegions();
            this._frameSyncId = laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };
        let startFrameSync = () => {
            if (this._frameSyncId === 0) {
                buildClones();
                this._frameSyncId = laterAdd(frameLaterType, frameTick);
            }
        };
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                laterRemove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        this._signals = [];
        // Unlike Background mode: no _applyClassStyles() (the panel itself must
        // stay opaque/native), no _applyMenuOffsets(), no spring animation, and
        // no _startButtonAlphaSampling() (the existing alpha-dim feature is
        // superseded by full glass here and would fight over the same inline
        // styles — see _ensureToggleStyles()).
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._cachedSubmenus = null;
                startFrameSync();
                this._startAdaptiveColorSampling(true);
                this._startToggleColorSampling();
                return;
            }
            this._stopAdaptiveColorSampling();
            this._stopToggleColorSampling();
        });
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (!this.menu.actor.mapped) {
                    stopFrameSync();
                    if (this.bgActor) {
                        this.bgActor.hide();
                        this.bgActor.opacity = 0;
                    }
                }
            })
        });
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // Discovers the top-level toggle "pods" under `actor`. A pod is either:
    //
    //  - a `.quick-toggle-has-menu` wrapper: GNOME's split/menu toggles
    //    (Wi-Fi, Bluetooth, ...) are actually THREE siblings under this
    //    wrapper — the main `.quick-toggle` button, a `.quick-toggle-separator`
    //    divider line, and a separate `.quick-toggle-menu-button` arrow/expand
    //    button (confirmed via Looking Glass actor-tree probe: the wrapper's
    //    own bounding box, e.g. 176×48, exactly equals the sum of the main
    //    button (139) + separator (1) + arrow button (36)). The arrow button
    //    does NOT carry the `quick-toggle` class itself, so it was previously
    //    invisible to this traversal entirely, and its own background color
    //    (which — unlike the main button's — genuinely does swing between a
    //    dim, low-contrast gray when off/unchecked and a solid, high-contrast
    //    accent color when checked) was never neutralized. That is what
    //    produced BOTH the "glass only covers the left half" artifact and the
    //    "glass strength inversely tracks the toggle's own background" one:
    //    they're the same untouched element. We now detect the WRAPPER itself
    //    as the pod (checked before the plain `.quick-toggle` case below, so
    //    its inner main button is never also collected as a second, separate
    //    region) and treat its full bounding box as one glass shape.
    //
    //  - a standalone `.quick-toggle` button with no such wrapper (Night
    //    Light, Dark Style, Do Not Disturb, ...).
    //
    // Either way, this does NOT descend into a matched pod's children — the
    // whole pod is treated as one shape; see _getStylableSubActors() for how
    // its interactive children get their backgrounds neutralized.
    _findAllToggleContainers(actor, found = []) {
        if (!actor)
            return found;
        let isHasMenuPod = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-has-menu');
        if (isHasMenuPod) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        let isToggle = actor instanceof St.Widget && actor.has_style_class_name('quick-toggle');
        if (isToggle) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let child of children)
            this._findAllToggleContainers(child, found);
        return found;
    }
    // Returns every St.Widget descendant of a pod (the pod itself, plus its
    // icon/title/subtitle/separator/menu-button children, at any depth).
    //
    // This used to special-case `.quick-toggle-has-menu` by class name and
    // only return its direct children — but a fresh Looking-Glass probe still
    // showed the Wi-Fi pod's main button (139×48, checked=true) with an
    // empty inlineStyle even after that fix, while the region/glass geometry
    // for the SAME pod was confirmed correct — meaning class-name-based
    // detection was silently missing this pod's children for a reason not
    // yet root-caused (possibly a GNOME-version difference in exact
    // structure/class names). Rather than keep guessing specific class
    // names, this walks the ENTIRE subtree unconditionally: every St.Widget
    // under the pod gets the transparent-background override — harmless for
    // icons/labels (which already paint no background of their own) and
    // robust to whatever internal structure GNOME actually uses, since it no
    // longer depends on matching a specific class string at all.
    _getStylableSubActors(pod) {
        const found = [];
        const walk = (actor) => {
            if (actor instanceof St.Widget)
                found.push(actor);
            let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let child of children)
                walk(child);
        };
        walk(pod);
        return found;
    }
    // Returns the sub-actor whose color should represent the pod for tinting
    // purposes — the main `.quick-toggle` button (the one whose color
    // genuinely reflects ON/OFF state), not the separator or arrow button.
    //
    // [FIX] "Wi-Fi/Bluetooth tint never changes with ON/OFF state, unlike
    // standalone toggles" — root-caused via the [toggle-color] diagnostic
    // log: for has-menu pods, this returned `pod` itself (the WRAPPER) as
    // `primary`, meaning every sample just read back OUR OWN transparent
    // override on the wrapper's own background (rgba(0,0,0,0.00) — see
    // _getStylableSubActors(), which forces every St.Widget in the pod's
    // subtree transparent, wrapper included) rather than any real
    // checked-state color. That happened because this only checked DIRECT
    // children for `.quick-toggle` — a separate Looking Glass probe (a
    // full recursive walk) found the real main button (style class
    // "quick-toggle button") existing further down, not as a direct child
    // of the wrapper. Searching the whole subtree (excluding `pod` itself,
    // so a has-menu pod can never trivially "match itself") fixes this
    // regardless of how many levels of wrapping GNOME actually uses.
    _getPrimaryToggleButton(pod) {
        if (pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu')) {
            let found = null;
            const search = (actor) => {
                if (found)
                    return;
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children) {
                    if (found)
                        return;
                    if (child instanceof St.Widget && child.has_style_class_name('quick-toggle')) {
                        found = child;
                        return;
                    }
                    search(child);
                }
            };
            search(pod);
            if (found)
                return found;
        }
        return pod;
    }
    // [FIX] Reads a theme-node background color as normalized {r,g,b,a}
    // (0..1), or null if the actor can't be sampled at all. Used by
    // _samplePodColor() so alpha is never silently discarded.
    _readThemeBg(actor) {
        if (!(actor instanceof St.Widget))
            return null;
        actor.ensure_style();
        let themeNode = actor.get_theme_node();
        let bg = themeNode ? themeNode.get_background_color() : null;
        if (!bg)
            return null;
        return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
    }
    // [FIX] "Wi-Fi/Bluetooth glass renders solid black under mactahoe theme,
    // regardless of ON/OFF state". Root cause: for has-menu pods,
    // _getPrimaryToggleButton() always samples the inner `.quick-toggle`
    // button, which is correct for Adwaita (where THAT button carries the
    // real, opaque, checked-state color and the `.quick-toggle-has-menu`
    // wrapper itself stays transparent) — but mactahoe does the opposite: the
    // quick___.txt tree dump shows mactahoe's Wi-Fi/Bluetooth wrapper at
    // rgba(255,255,255,0.15) while its inner button is rgba(0,0,0,0.00) in
    // BOTH the checked and unchecked case. Sampling only the inner button
    // there always reads a fully transparent black, and because the caller
    // only kept the RGB (see baseAlpha comment above), that transparent black
    // was trusted as a real opaque color and painted solid.
    //
    // Fix: sample BOTH candidates (the resolved primary button, and — for
    // has-menu pods only — the wrapper itself) and keep whichever one is
    // actually painting something (higher alpha). If neither is painting
    // anything real, return alpha 0 so the caller knows not to trust the RGB.
    _samplePodColor(pod, primary) {
        let primaryBg = this._readThemeBg(primary) ?? { r: 0, g: 0, b: 0, a: 0 };
        let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
        if (isHasMenu && pod !== primary) {
            let wrapperBg = this._readThemeBg(pod);
            if (wrapperBg && wrapperBg.a > primaryBg.a)
                return wrapperBg;
        }
        return primaryBg;
    }
    // Registers/maintains every toggle pod: samples the primary button's
    // color (for tinting) and forces the background of every CURRENT live
    // stylable sub-actor in the pod fully transparent.
    //
    // Unlike the original one-shot version, this re-derives each pod's
    // sub-actors and re-checks their OWN live style EVERY call (this
    // function runs every frame from _syncToggleRegions()), rather than
    // permanently marking a pod as "handled" the first time it's seen. A
    // second Looking-Glass probe run confirmed why the one-shot version
    // failed for split toggles: standalone `.quick-toggle` buttons kept
    // their `background-color: transparent !important;` override reliably,
    // but `.quick-toggle-has-menu` pods' inner button/menu-button stayed
    // PERMANENTLY un-styled (empty inlineStyle, native solid color) across
    // every sampled frame over several seconds — i.e. not a timing race,
    // but GNOME evidently replacing/rebuilding these pods' inner actors
    // (e.g. when connection state changes) with fresh, un-styled ones after
    // the pod was already marked "done". Checking each sub-actor's OWN
    // current style (rather than a cached per-pod flag) makes this
    // self-healing regardless of why a previously-styled actor stopped
    // being transparent.
    _ensureToggleStyles(toggles) {
        const OVERRIDE = 'background-color: transparent !important;';
        for (let pod of toggles) {
            if (!(pod instanceof St.Widget))
                continue;
            let entry = this._toggleRegions.get(pod);
            if (!entry) {
                // [FIX] Default baseAlpha 0 means "no real sample yet" — a pod that
                // never manages to sample a real color falls through to the
                // caller's own neutral handling (see _syncToggleRegions()) instead
                // of an arbitrary hardcoded white ever being trusted as real.
                entry = { baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [] };
                this._toggleRegions.set(pod, entry);
                pod.connect('destroy', () => {
                    this._toggleRegions.delete(pod);
                });
            }
            let primary = this._getPrimaryToggleButton(pod);
            if (primary instanceof St.Widget) {
                // Sample from whatever the CURRENT inline style leaves as the
                // theme's own background — if we've already overridden it to
                // transparent, get_background_color() on this actor would just
                // report transparent, so only (re-)sample when it still looks
                // like a fresh, un-overridden actor.
                let curStyle = typeof primary.get_style === 'function' ? primary.get_style() : null;
                if (!curStyle || !curStyle.includes(OVERRIDE)) {
                    let sampled = this._samplePodColor(pod, primary);
                    // [FIX] Only trust this sample if it's actually painting
                    // something (alpha above a small noise floor). A near-zero-alpha
                    // read tells us nothing about the pod's real color — keep
                    // whatever baseColor/baseAlpha we already had instead of
                    // clobbering it with an effectively-random transparent RGB.
                    if (sampled.a > 0.02) {
                        entry.baseColor = [sampled.r, sampled.g, sampled.b];
                        entry.baseAlpha = sampled.a;
                    }
                }
            }
            let known = new Set(entry.styledSubs.map(s => s.actor));
            for (let sub of this._getStylableSubActors(pod)) {
                if (!(sub instanceof St.Widget))
                    continue;
                let style = typeof sub.get_style === 'function' ? sub.get_style() : null;
                if (style && style.includes(OVERRIDE))
                    continue; // already correctly overridden
                let origStyle = style || '';
                let newStyle = origStyle ? `${origStyle} ${OVERRIDE}` : OVERRIDE;
                sub.set_style(newStyle);
                if (!known.has(sub))
                    entry.styledSubs.push({ actor: sub, origStyle });
            }
        }
    }
    // Periodically re-samples each tracked pod's ORIGINAL color (it changes
    // with ON/OFF and hover state, e.g. Wi-Fi turning blue when enabled, or
    // its arrow/menu-button swinging between a dim gray and a solid accent
    // fill) by briefly restoring each sub-actor's original style, reading the
    // primary button's theme color, then re-applying the transparent override
    // to every sub-actor — same idiom as _updateSingleButtonAlpha() uses for
    // the Background-mode alpha-dim feature.
    //
    // [FIX] Investigating "has-menu pods (Wi-Fi/Bluetooth) don't reflect
    // their tint color, unlike standalone pods (DND/Dark Style)". Read
    // through _getPrimaryToggleButton()/the sampling logic here and in
    // _ensureToggleStyles() side by side and could not find an asymmetry
    // between the two pod shapes — both sample the same way, from the same
    // kind of actor (the inner `.quick-toggle` button either way). Logging
    // the actual sampled values (throttled to this method's own 400ms timer,
    // so it's not spammy) rather than guessing further — please share what
    // this prints for a has-menu pod (Wi-Fi/Bluetooth) vs a standalone one
    // (DND/Dark Style) next time this reproduces.
    _resampleToggleColors() {
        for (const [pod, entry] of this._toggleRegions.entries()) {
            if (!pod)
                continue;
            // Restore every sub-actor's original style first so the primary
            // button's sampled color reflects its real, un-overridden theme.
            for (const { actor, origStyle } of entry.styledSubs) {
                if (actor instanceof St.Widget)
                    actor.set_style(origStyle || null);
            }
            let primary = this._getPrimaryToggleButton(pod);
            if (primary instanceof St.Widget) {
                let sampled = this._samplePodColor(pod, primary);
                if (sampled.a > 0.02) {
                    entry.baseColor = [sampled.r, sampled.g, sampled.b];
                    entry.baseAlpha = sampled.a;
                }
                if (this._debugToggleColorLogFrames > 0) {
                    let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
                    let podCls = pod instanceof St.Widget && typeof pod.get_style_class_name === 'function' ? (pod.get_style_class_name() || '') : '';
                    let primaryCls = typeof primary.get_style_class_name === 'function' ? (primary.get_style_class_name() || '') : '';
                    let checked = typeof primary.has_style_pseudo_class === 'function' ? primary.has_style_pseudo_class('checked') : 'n/a';
                    // [DEBUG] Also logs the wrapper's OWN background (for has-menu
                    // pods) alongside the primary button's, and the raw sampled
                    // alpha, since telling "a real transparent pod" apart from "a
                    // theme that paints its color somewhere we're not looking yet"
                    // requires seeing both candidates, not just the winner.
                    let wrapperBg = isHasMenu ? this._readThemeBg(pod) : null;
                    this._logger.log(`[Liquid Glass][toggle-color] pod class="${podCls}" isHasMenu=${isHasMenu} ` +
                        `primary class="${primaryCls}" checked=${checked} ` +
                        `primaryBg=${JSON.stringify(this._readThemeBg(primary))} ` +
                        `wrapperBg=${wrapperBg ? JSON.stringify(wrapperBg) : 'n/a'} ` +
                        `chosen.a=${sampled.a.toFixed(2)} trusted=${sampled.a > 0.02} ` +
                        `entry.baseColor=[${entry.baseColor.map(v => v.toFixed(2)).join(',')}] entry.baseAlpha=${entry.baseAlpha.toFixed(2)}`);
                }
            }
            for (const { actor, origStyle } of entry.styledSubs) {
                if (!(actor instanceof St.Widget))
                    continue;
                let newStyle = origStyle
                    ? `${origStyle} background-color: transparent !important;`
                    : `background-color: transparent !important;`;
                actor.set_style(newStyle);
            }
        }
        if (this._debugToggleColorLogFrames > 0)
            this._debugToggleColorLogFrames--;
    }
    _startToggleColorSampling() {
        this._resampleToggleColors();
        if (this._toggleColorTimerId !== 0)
            return;
        this._toggleColorTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            if (!this.menu?.isOpen) {
                this._toggleColorTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._resampleToggleColors();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopToggleColorSampling() {
        if (this._toggleColorTimerId !== 0) {
            GLib.source_remove(this._toggleColorTimerId);
            this._toggleColorTimerId = 0;
        }
    }
    // Restores every tracked pod's sub-actors to their original inline style
    // and forgets them.
    _clearToggleStyles() {
        this._stopToggleColorSampling();
        for (const [, entry] of this._toggleRegions.entries()) {
            for (const { actor, origStyle } of entry.styledSubs) {
                if (actor instanceof St.Widget && typeof actor.set_style === 'function') {
                    try {
                        actor.set_style(origStyle || null);
                    }
                    catch (e) { }
                }
            }
        }
        this._toggleRegions.clear();
        this._destroyPanelContentClone();
    }
    // [FIX] STRUCTURAL REDESIGN #2 (per feedback: popup-menu-content must
    // look 100% unmodified — no CSS override, no opacity change, nothing).
    // The opacity-blend approach above was a step in the wrong direction:
    // the user wants the real panel rendered exactly as GNOME/the theme
    // draws it, with the glass appearing structurally ON TOP of it — not
    // the panel dialed down to let something behind it show through.
    //
    // This works because bgActor is now inserted with
    // insert_child_above(bgActor, menuRoot) (see _applyToggleEffect()),
    // i.e. it paints AFTER — visually on top of — the entire real panel.
    // glass.frag's multi-region mode already produces ~0 alpha everywhere
    // outside every toggle's own region (see insideMask/outsideTransition
    // there), so with bgActor on top, the untouched real panel shows through
    // completely normally everywhere except inside each toggle's bounds,
    // where the glass genuinely overpaints it.
    //
    // What the glass shows *inside* a toggle's bounds needs to be "this
    // toggle, refracted" (plus, transitively, whatever's behind it if the
    // theme itself makes it translucent) rather than raw desktop — so this
    // clones `_menuRoot` (the whole real panel, exactly as rendered) and
    // adds it into `_cloneContainer` ON TOP of `_windowCloneManager`'s
    // desktop-window/wallpaper clones, giving the shader the exact
    // pre-glass composite (wallpaper → windows → real panel) to sample and
    // refract within each region.
    //
    // No recursion: this clone's source is `_menuRoot`, which does NOT
    // contain `bgActor` as a descendant (they are uiGroup siblings) — there
    // is no path by which the glass's own output could feed back into what
    // it samples, structurally, regardless of paint order.
    _panelSnapshotCapture = null;
    // [FIX-4] "GNOME Shell crashes on infinite recursion the instant Quick
    // Settings opens, after bgActor became a child of animActor" — root
    // CONFIRMED via journalctl: JS stack overflow ("onOverRecursed") inside
    // libmozjs, happening synchronously during a paint.
    //
    // Cause: this used to build `_panelContentClone` as a single raw
    // `Clutter.Clone(source: _menuRoot)` (via UnpickableClone). A
    // Clutter.Clone doesn't cache a texture and reuse it — painting a clone
    // re-invokes its source's OWN paint (that's how it always stays live).
    // Once bgActor became a descendant of `_menuRoot` (via animActor, see
    // _applyToggleEffect()), that source-paint call now reaches back down
    // into this very clone's own container, which calls back into the
    // source's paint again, forever — a same-frame, synchronous recursive
    // call chain with no natural base case, hence the stack overflow.
    //
    // The per-actor exclusion list used by UILayerSampler.refresh()
    // (_containsOtherLiquidGlassRoot/addExclusion) can't fix this: it works
    // because UILayerSampler rebuilds its OWN clone tree one actor at a
    // time and can simply skip a subtree while walking it. A bare
    // Clutter.Clone has no such hook — it clones its source's entire
    // rendered output as one indivisible operation, so there is nothing to
    // "exclude" from inside it.
    //
    // Fix: stop using a live Clutter.Clone here entirely. Use
    // SelfExcludingSnapshotCapture instead (already in utils.ts, built for
    // exactly this situation — see its doc comment — and already proven
    // for the Blur My Shell panel capture elsewhere in this extension):
    // it takes a one-off, synchronous `paint_to_content()` snapshot with
    // bgActor hidden for that single call, so the snapshot structurally
    // cannot contain bgActor no matter where bgActor lives in the tree —
    // no recursion is possible because nothing ever paints itself live.
    // TextureBlitActor then just blits that snapshot's texture like any
    // other static image, refreshed on every 'after-paint'.
    _ensurePanelContentClone(monitorX, monitorY) {
        if (!this._menuRoot)
            return;
        if (!this._panelSnapshotCapture && this.bgActor) {
            this._panelSnapshotCapture = new SelfExcludingSnapshotCapture(global.stage, this.bgActor, () => {
                if (!this._menuRoot)
                    return [0, 0, 0, 0];
                let [x, y] = this._menuRoot.get_transformed_position();
                let [w, h] = this._menuRoot.get_size();
                return [x, y, w, h];
            });
        }
        if (!this._panelContentClone || !isActorValid(this._panelContentClone) ||
            !this._panelContentClone.get_stage || !this._panelContentClone.get_stage()) {
            if (isActorValid(this._panelContentClone)) {
                try {
                    this._panelContentClone.destroy();
                }
                catch (e) { }
            }
            let blit = new TextureBlitActor();
            blit.set_name('liquid-glass-panel-snapshot');
            blit.setSourceActor(this._menuRoot);
            blit.setTextureGetter(() => {
                try {
                    const content = this._panelSnapshotCapture?.getContent();
                    return content && typeof content.get_texture === 'function' ? content.get_texture() : null;
                }
                catch (e) {
                    return null;
                }
            });
            this._panelContentClone = blit;
            this._panelContentClone.connect('destroy', () => { this._panelContentClone = null; });
            this._cloneContainer?.add_child(this._panelContentClone);
        }
        // Always keep it above _windowCloneManager's own clone containers —
        // those get destroyed/re-added on every rebuildClones() (see
        // buildClones() in _applyToggleEffect()), which would otherwise
        // silently invert the stacking order (desktop clones ending up drawn
        // ON TOP of the panel clone) the next time a window opens/closes.
        this._cloneContainer?.set_child_above_sibling(this._panelContentClone, null);
        let [absX, absY] = this._menuRoot.get_transformed_position();
        let [w, h] = this._menuRoot.get_size();
        if (Number.isFinite(absX) && Number.isFinite(absY) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            this._panelContentClone.set_position(absX - monitorX, absY - monitorY);
            this._panelContentClone.set_size(w, h);
        }
    }
    _destroyPanelContentClone() {
        if (isActorValid(this._panelContentClone)) {
            try {
                this._panelContentClone.destroy();
            }
            catch (e) { }
        }
        this._panelContentClone = null;
        if (this._panelSnapshotCapture) {
            try {
                this._panelSnapshotCapture.destroy();
            }
            catch (e) { }
            this._panelSnapshotCapture = null;
        }
    }
    // ── Toggles-mode geometry / region synchronisation (per frame) ─────────────
    // Unlike _syncGeometry(), this never touches animActor/targetActor scale,
    // opacity, or position — Toggles mode has no animation of its own; the
    // menu opens/closes using GNOME's native behaviour untouched.
    _syncToggleRegions() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible)
                this.bgActor.hide();
            return;
        }
        // [FIX-STRUCTURAL-3 / FIX-5] bgActor lives inside _toggleGlassHost,
        // which is the actual CHILD of animActor (see _applyToggleEffect() and
        // LayoutOpaqueActor in utils.ts) — real toggle content (later siblings
        // within animActor) naturally paints on top of the host, no opacity/
        // blur compromise needed for labels/icons to stay legible.
        //
        // Two things that used to be handled at the uiGroup level now need to
        // happen at the animActor level instead:
        //
        //  1. Re-assert the host as animActor's BOTTOM-most child every frame.
        //     GNOME can rebuild/reorder animActor's own children at any time
        //     (a quick-toggle being added/removed, e.g. a new Bluetooth device
        //     row appearing) — set_child_below_sibling() is a cheap list-splice
        //     (not a repaint), so doing this unconditionally every frame is the
        //     same self-healing idiom already used for the old uiGroup-level
        //     re-assertion, just re-targeted.
        //
        //  2. Counter-translate bgActor against the HOST's own current absolute
        //     position (which already reflects animActor's cumulative position
        //     AND scale, since the host itself carries no transform of its
        //     own) so bgActor's internal monitor-space math (every regionX/
        //     regionY below, computed via monitorX/monitorY) stays valid
        //     unchanged. Without this, bgActor's (0,0) would sit wherever the
        //     host happens to land on screen instead of at the monitor's own
        //     origin.
        if (this.animActor instanceof Clutter.Actor && this._toggleGlassHost) {
            this.animActor.set_child_below_sibling(this._toggleGlassHost, null);
            let [hostAbsX, hostAbsY] = this._toggleGlassHost.get_transformed_position();
            let [hostScaleX, hostScaleY] = this._toggleGlassHost.get_scale();
            hostScaleX = hostScaleX || 1.0;
            hostScaleY = hostScaleY || 1.0;
            // bgActor is scaled up from its (1.0,1.0) base size to the full
            // monitor elsewhere (see _updateResolution()/setup) — counter only
            // the host's OWN inherited scale/position here, not bgActor's own
            // intended full-monitor scale.
            this.bgActor.set_position(-hostAbsX / hostScaleX, -hostAbsY / hostScaleY);
        }
        else {
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bgActor, null);
        }
        let toggles = this._findAllToggleContainers(this.menu?.actor);
        this._ensureToggleStyles(toggles);
        // Monitor geometry, needed both by _ensurePanelContentClone() (to
        // position the panel-content clone in the same monitor-relative space
        // as everything else) and by setGlassRegions()/setResolution() below.
        let monitor = this._getMenuMonitorGeometry();
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        this._ensurePanelContentClone(monitorX, monitorY);
        if (toggles.length === 0) {
            this.bgActor.hide();
            return;
        }
        let regions = [];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let toggle of toggles) {
            if (!toggle.visible || !toggle.mapped)
                continue;
            let [absX, absY] = toggle.get_transformed_position();
            let [w, h] = toggle.get_size();
            if (Number.isNaN(absX) || Number.isNaN(absY) || Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0)
                continue;
            // Expand by glassExpand + SHADER_PADDING, exactly like Background
            // mode's single bgW/bgH — gives the shader room for refraction/blur
            // at each region's edge.
            let regionX = (absX - monitorX) - this._glassExpand - SHADER_PADDING;
            let regionY = (absY - monitorY) - this._glassExpand - SHADER_PADDING;
            let regionW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
            let regionH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
            let entry = this._toggleRegions.get(toggle);
            // [FIX-2] Round-trip log from the field (mactahoe, after the
            // alpha-aware sampling fix above) confirmed the sample itself is
            // correct — e.g. has-menu pods genuinely read rgba(1,1,1,0.15) and
            // a checked standalone toggle genuinely reads rgba(1,1,1,1.0) — but
            // EVERYTHING still rendered solid white, because baseAlpha was only
            // ever used to decide whether to TRUST entry.baseColor, never to
            // decide how STRONGLY it should pull the tint. A pod whose real
            // on-screen paint is a mostly-transparent 15%-opacity white sheen
            // was still blended in as if it were a fully opaque white square,
            // so effectively every pod (has-menu or not, checked or not) got
            // the same overpowering white cast.
            //
            // Fix: keep the existing strength-slider blend (own color <-> the
            // configured tint color) exactly as before, then pull the RESULT
            // back toward the plain tint color by (1 - baseAlpha). A fully
            // opaque sample (baseAlpha=1, e.g. a genuinely solid checked pill)
            // is completely unaffected by this second step — identical to the
            // old behavior. A faint 15%-opacity sample now only pulls a small
            // fraction of the way away from the plain tint, instead of being
            // treated as if it were fully opaque.
            let base = (entry && entry.baseAlpha > 0.02) ? entry.baseColor : this._tintColorArray;
            let baseAlpha = (entry && entry.baseAlpha > 0.02) ? entry.baseAlpha : 0;
            let strength = this._toggleTintStrength;
            let blendR = base[0] + (this._tintColorArray[0] - base[0]) * strength;
            let blendG = base[1] + (this._tintColorArray[1] - base[1]) * strength;
            let blendB = base[2] + (this._tintColorArray[2] - base[2]) * strength;
            let tintR = this._tintColorArray[0] + (blendR - this._tintColorArray[0]) * baseAlpha;
            let tintG = this._tintColorArray[1] + (blendG - this._tintColorArray[1]) * baseAlpha;
            let tintB = this._tintColorArray[2] + (blendB - this._tintColorArray[2]) * baseAlpha;
            regions.push({ x: regionX, y: regionY, w: regionW, h: regionH, tintR, tintG, tintB });
            minX = Math.min(minX, regionX);
            minY = Math.min(minY, regionY);
            maxX = Math.max(maxX, regionX + regionW);
            maxY = Math.max(maxY, regionY + regionH);
        }
        if (regions.length === 0) {
            this.bgActor.hide();
            return;
        }
        if (!this.bgActor.visible)
            this.bgActor.show();
        // [FIX-1] Sync bgActor's opacity to the panel's own current fade state,
        // the same way _syncGeometry() already does for Background mode
        // (`targetActor.get_first_child()?.opacity`) — GNOME fades the popup
        // menu's close animation by animating its first child's opacity, not
        // `targetActor` (menu.actor) itself. Previously this was hardcoded to
        // 255, so during the close animation the real panel content
        // progressively faded out while the glass (now structurally on top of
        // it) stayed fully solid, only disappearing once the panel was fully
        // gone (i.e. once `targetActor.mapped` finally flips false above).
        // Mirroring the same value keeps them fading in lockstep.
        //
        // [FIX-2] "The real toggle's icon/label text disappears — it's hidden
        // under the glass" now that bgActor paints structurally ON TOP of the
        // untouched real panel (see _applyToggleEffect()/insert_child_above).
        // popup-menu-content stays completely unmodified per the requirement,
        // so the only lever left to make its real (sharp, unblurred) icon/
        // label show back through is bgActor's OWN opacity — the same
        // technique real "Liquid Glass" UI uses: a translucent frosted pane
        // OVER content, not an opaque image replacing it. TOGGLE_GLASS_OVERLAY_OPACITY
        // is an initial guess, not tuned against a real display — a dedicated
        // settings key would be the right home for this once the .gschema.xml
        // is in scope; for now it's a local constant.
        const TOGGLE_GLASS_OVERLAY_OPACITY = 0.7;
        let panelOpacity = this.targetActor.get_first_child()?.opacity ?? 255;
        this.bgActor.opacity = Math.round(panelOpacity * TOGGLE_GLASS_OVERLAY_OPACITY);
        this.effect?.setGlassRegions(regions);
        let bgW = maxX - minX;
        let bgH = maxY - minY;
        let localBgX = minX;
        let localBgY = minY;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== localBgX || this._lastBgY !== localBgY ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH) {
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            this.bgActor.set_position(monitorX, monitorY);
            this.bgActor.set_size(screenW, screenH);
            this.bgActor.remove_transition('size');
            this.bgActor.remove_transition('position');
            this.liquidBox?.set_position(0, 0);
            this.liquidBox?.set_size(screenW, screenH);
            const CLIP_PADDING = 200;
            this.liquidBox?.remove_clip();
            this.bgActor.set_clip(localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
            this.effect?.setResolution(screenW, screenH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = localBgX;
            this._lastBgY = localBgY;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        this._windowCloneManager?.setOffset(-monitorX, -monitorY);
        this._uiSampler?.refresh();
        this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
        this._windowCloneManager?.sync();
    }
    // ── Geometry synchronisation ────────────────────────────────────────────────
    // Calculates and synchronizes the position/size of the glass background every frame
    // Full-screen FBO approach: bgActor covers the entire monitor, shader is told
    // where the menu lives within that FBO via setGlassGeometry().
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible)
                this.bgActor.hide();
            return;
        }
        if (!this.bgActor.visible)
            this.bgActor.show();
        if (!this._enableAnimation) {
            if (this.targetActor !== null)
                this.bgActor.opacity = this.targetActor.get_first_child()?.opacity ?? 255;
        }
        let [inW, inH] = this.animActor.get_size();
        let [outW, outH] = this.targetActor.get_size();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        let [scaleX, scaleY] = this.animActor.get_scale();
        if (!this._enableAnimation) {
            // For default GNOME animation: the transparent wrapper directly under BoxPointer is the actual animated entity
            let gnomeAnimContainer = this.targetActor.get_first_child();
            if (gnomeAnimContainer) {
                scaleX *= gnomeAnimContainer.scale_x;
                scaleY *= gnomeAnimContainer.scale_y;
            }
        }
        else {
            scaleX *= this.targetActor.get_scale()[0];
            scaleY *= this.targetActor.get_scale()[1];
        }
        let themeNode = this.animActor.get_theme_node();
        let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
        let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
        let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
        let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;
        let marginW = mL + mR;
        let marginH = mT + mB;
        let targetW = Math.round(inW);
        let targetH = Math.round(inH);
        // GNOME Shell Hover Bug Compensation
        // Detects when the menu tries to unexpectedly shrink by a few pixels
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
        }
        this._stableBaseW = targetW;
        this._stableBaseH = targetH;
        // Multiply by the current animation scale. 
        // Math.max guarantees the size never drops below 1px (prevents Cogl crashes).
        let w = Math.max(1, this._stableBaseW * scaleX);
        let h = Math.max(1, this._stableBaseH * scaleY);
        // Get correct coordinates directly from animActor, which is the actual UI content area
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
            }
            else {
                // Ultimate fallback: Just place it in the top-center of the primary monitor
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2);
                    animAbsY = (Main.panel.height || 27) + (this._menuYoffset ?? 0);
                }
                else {
                    animAbsX = 0;
                    animAbsY = 0;
                }
            }
        }
        else {
            // Save successful coordinates for future fallbacks
            this._lastValidAnimAbsX = animAbsX;
            this._lastValidAnimAbsY = animAbsY;
        }
        // The background needs to be larger than the UI to account for the glass expansion
        // and the extra padding required by the shader for edge refraction.
        let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        // Cover the background by purely subtracting the padding from the exact UI coordinates
        let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
        let bgY = animAbsY - this._glassExpand - SHADER_PADDING;
        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            // ── Monitor geometry ───────────────────────────────────────────────────
            let monitor = this._getMenuMonitorGeometry();
            let monitorX = monitor?.x ?? 0;
            let monitorY = monitor?.y ?? 0;
            let screenW = Math.max(1, monitor?.width ?? 1);
            let screenH = Math.max(1, monitor?.height ?? 1);
            // Monitor-local coordinates (shader uses these)
            let localBgX = bgX - monitorX;
            let localBgY = bgY - monitorY;
            // ── Update actors only when geometry changed ───────────────────────────
            // Only update positions/sizes if they actually changed to save CPU cycles
            if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
                this._lastBgX !== bgX || this._lastBgY !== bgY ||
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
                // Soft clip — limits GPU work to the menu area + generous margin
                const CLIP_PADDING = 200;
                this.liquidBox?.remove_clip();
                this.bgActor.set_clip(localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
                const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
                this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
                // Inform shader of full-screen resolution and where the menu lives in the FBO
                this.effect?.setResolution(screenW, screenH);
                this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
                this._lastScreenW = screenW;
                this._lastScreenH = screenH;
            }
            // ── Sync clones every frame (dockManager pattern) ──────────────────────
            this._windowCloneManager?.setOffset(-monitorX, -monitorY);
            this._uiSampler?.refresh();
            this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
            this._windowCloneManager?.sync();
        }
        // Scale-aware corner radius
        // Use the smaller of the X/Y scales to prevent corners from squishing incorrectly
        if (this.effect && typeof this.effect.setCornerRadius === 'function') {
            let currentScale = Math.min(scaleX, scaleY);
            this.effect.setCornerRadius(this._cornerRadius * currentScale);
            if (typeof this.effect.setAnimationScale === 'function') {
                this.effect.setAnimationScale(currentScale);
            }
        }
        this._adjustSubmenuPositions();
    }
    // Updates the shader resolution based on the current background actor size
    _updateResolution() {
        if (!this.bgActor || !this.effect)
            return;
        let [width, height] = this.bgActor.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.effect.setResolution(width, height);
        }
    }
    // Utility function to safely check if an actor has a specific style class
    _hasStyleClass(actor, className) {
        return actor instanceof St.Widget && actor.has_style_class_name(className);
    }
    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(this.menu?.actor);
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        // Collect applicable text or button elements that are currently visible
        if (actor instanceof St.Label || actor instanceof Clutter.Text ||
            actor instanceof St.Button || actor instanceof St.Icon) {
            if (actor.visible)
                foundActors.push(actor);
        }
        // Recursively scan child elements
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllTextActors(children[i], foundActors);
        }
        return foundActors;
    }
    // Initiates the color change for a specific actor
    _setActorColor(actor, color, skipAnimations = false) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
        if (!this._styledActors.has(actor)) {
            let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
            this._styledActors.set(actor, origStyle || '');
            actor.connect('destroy', () => {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                this._styledActors.delete(actor);
            });
        }
        let isInsensitive = false;
        if (actor instanceof St.Button) {
            isInsensitive = (actor.reactive === false) ||
                (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
        }
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive)
            return;
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;
        this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
    }
    _clearAdaptiveStyles() {
        for (const [actor, originalStyle] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor._currentInsensitiveState = undefined;
                actor.remove_style_class_name('adaptive-text-transition');
                actor.remove_style_class_name('adaptive-color-light');
                actor.remove_style_class_name('adaptive-color-dark');
                actor.set_style(originalStyle || null);
            }
        }
        this._styledActors.clear();
        const currentTargets = this._collectAdaptiveTextTargets();
        for (let actor of currentTargets) {
            if (actor && typeof actor.set_style === 'function') {
                if (actor._colorTweenId) {
                    GLib.source_remove(actor._colorTweenId);
                    actor._colorTweenId = undefined;
                }
                actor._currentTargetColor = undefined;
                actor._currentInsensitiveState = undefined;
                actor.set_style(null);
            }
        }
    }
    // Iterates through the color map and applies the new target colors to the respective actors
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        for (const [actor, color] of colorMap.entries()) {
            this._setActorColor(actor, color, skipAnimations);
        }
    }
    // Starts the timer for periodically sampling contrast and updating adaptive text colors
    _startAdaptiveColorSampling(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled)
            return;
        this._updateAdaptiveTextColors(skipAnimations);
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            if (!this.menu?.isOpen) {
                this._adaptiveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateAdaptiveTextColors(false);
            return GLib.SOURCE_CONTINUE;
        });
    }
    // Stops the adaptive color sampling timer
    _stopAdaptiveColorSampling() {
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
    }
    // Collects target actors, samples their contrast, and triggers color updates
    _updateAdaptiveTextColors(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig)
            .then(colorMap => {
            this._applyAdaptiveColorMap(colorMap, skipAnimations);
        })
            .catch(e => {
            this._logger.error(`[Liquid Glass] Quick Settings adaptive color update failed: ${e}`);
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
    _animateActorColor(actor, targetHexColor, isInsensitive, durationMs = 380, skipAnimations = false) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = undefined;
        }
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let targetRgb = this._hexToRgb(targetHexColor);
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0;
        if (skipAnimations) {
            let alphaStr = targetAlpha.toFixed(3);
            let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
            actor.set_style(`color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
            return;
        }
        let startTime = GLib.get_monotonic_time();
        actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            if (!actor || Object.keys(actor).length === 0)
                return GLib.SOURCE_REMOVE;
            let currentTime = GLib.get_monotonic_time();
            let elapsedMs = (currentTime - startTime) / 1000;
            let progress = Math.min(elapsedMs / durationMs, 1.0);
            // Standard ease-in-out easing function
            let ease = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            // Linearly interpolate (lerp) each RGB channel individually
            let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * ease);
            let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * ease);
            let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * ease);
            // Interpolate the alpha value and generate the rgba() format
            // Safely clamp between 0.0 and 1.0
            let a = Math.max(0.0, Math.min(1.0, startAlpha + (targetAlpha - startAlpha) * ease));
            // Up to 3 decimal places for CSS
            let currentRgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            // Override text color and icon foreground color directly using inline CSS
            actor.set_style(`color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`);
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    // ── Button alpha sampling (QuickSettings-specific) ─────────────────────────
    _findAllButtons(actor, foundButtons = []) {
        if (!actor)
            return foundButtons;
        let isQuickSlider = false;
        let isToggleContainer = false;
        let isButton = actor instanceof St.Button;
        if (actor instanceof St.Widget) {
            isQuickSlider = actor.has_style_class_name('quick-slider');
            isToggleContainer = actor.has_style_class_name('quick-toggle');
        }
        if (actor.visible && !isQuickSlider) {
            if (isButton || isToggleContainer)
                foundButtons.push(actor);
        }
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let i = 0; i < children.length; i++) {
            this._findAllButtons(children[i], foundButtons);
        }
        return foundButtons;
    }
    _updateSingleButtonAlpha(button, targetAlpha) {
        if (!button || button._isUpdatingAlpha)
            return;
        button._isUpdatingAlpha = true;
        let origStyle = this._styledButtons.get(button) || '';
        button.set_style(origStyle || null);
        button.ensure_style();
        let themeNode = button.get_theme_node();
        if (themeNode) {
            let bgColor = themeNode.get_background_color();
            if (bgColor) {
                let isToggleContainer = button instanceof St.Widget && button.has_style_class_name('quick-toggle');
                // FIX 1: If this is a parent toggle container, hide its background if any child is active/colored.
                // This prevents the dark pod background from muddying the semi-transparent orange child button.
                if (isToggleContainer) {
                    let hasColoredChild = false;
                    let children = typeof button.get_children === 'function' ? button.get_children() : [];
                    for (let i = 0; i < children.length; i++) {
                        let child = children[i];
                        if (child instanceof St.Widget) {
                            let childTheme = child.get_theme_node();
                            if (childTheme) {
                                let childBg = childTheme.get_background_color();
                                if (childBg && childBg.alpha > 0) {
                                    hasColoredChild = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (hasColoredChild) {
                        let newStyle = origStyle
                            ? `${origStyle} background-color: transparent !important;`
                            : `background-color: transparent !important;`;
                        button.set_style(newStyle);
                        button._isUpdatingAlpha = false;
                        return;
                    }
                }
                // FIX 2: If the button is completely transparent by default (like power/lock buttons), keep it transparent.
                if (bgColor.alpha === 0) {
                    // Keep transparent buttons transparent
                }
                else {
                    // Apply target alpha for normally visible buttons
                    let rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
                    let newStyle = origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`;
                    button.set_style(newStyle);
                    // Ensure the parent toggle container is also updated dynamically.
                    // If a child button changes state, we must force the parent to re-evaluate its transparency.
                    let parent = typeof button.get_parent === 'function' ? button.get_parent() : null;
                    if (parent && parent instanceof St.Widget && parent.has_style_class_name('quick-toggle')) {
                        this._updateSingleButtonAlpha(parent, targetAlpha);
                    }
                }
            }
        }
        button._isUpdatingAlpha = false;
    }
    _updateButtonAlpha() {
        if (!this.menu?.isOpen)
            return;
        const buttons = this._findAllButtons(this.menu?.actor);
        if (buttons.length === 0)
            return;
        let targetAlpha = this.buttonAlpha !== undefined ? this.buttonAlpha : 0.5;
        for (let button of buttons) {
            if (!this._styledButtons.has(button)) {
                if (button instanceof St.Widget) {
                    let origStyle = typeof button.get_style === 'function' ? button.get_style() : null;
                    this._styledButtons.set(button, origStyle || '');
                }
                const updateHandler = () => {
                    if (!this.menu?.isOpen)
                        return;
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._updateSingleButtonAlpha(button, targetAlpha);
                        return GLib.SOURCE_REMOVE;
                    });
                };
                let signalIds = [];
                signalIds.push(button.connect('notify::hover', updateHandler));
                signalIds.push(button.connect('notify::active', updateHandler));
                signalIds.push(button.connect('notify::checked', updateHandler));
                signalIds.push(button.connect('notify::reactive', updateHandler));
                signalIds.push(button.connect('notify::mapped', updateHandler));
                signalIds.push(button.connect('key-focus-in', updateHandler));
                signalIds.push(button.connect('key-focus-out', updateHandler));
                this._buttonSignalIds.set(button, signalIds);
            }
            // Apply style safely
            this._updateSingleButtonAlpha(button, targetAlpha);
        }
    }
    // Start sampling timer
    _startButtonAlphaSampling() {
        this._updateButtonAlpha();
        if (this._buttonTimerId !== 0)
            return;
        this._buttonTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            if (!this.menu?.isOpen) {
                this._buttonTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._updateButtonAlpha();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopButtonAlphaSampling() {
        if (this._buttonTimerId !== 0) {
            GLib.source_remove(this._buttonTimerId);
            this._buttonTimerId = 0;
        }
    }
    // Revert processing when extension is disabled, etc.
    _clearButtonStyles() {
        this._stopButtonAlphaSampling();
        if (this._buttonSignalIds) {
            for (const [button, signalIds] of this._buttonSignalIds.entries()) {
                if (button) {
                    for (const id of signalIds) {
                        try {
                            button.disconnect(id);
                        }
                        catch (e) { }
                    }
                }
            }
            this._buttonSignalIds.clear();
        }
        for (const [button, originalStyle] of this._styledButtons.entries()) {
            if (button && button instanceof St.Widget && typeof button.set_style === 'function') {
                button.set_style(originalStyle || null);
            }
        }
        this._styledButtons.clear();
    }
    // ── Spring animation (QuickSettings-specific) ──────────────────────────────
    _startAnimation(targetValue) {
        if (this._tickId !== 0) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (!this._enableAnimation) {
            if (this.bgActor) {
                this.bgActor.remove_all_transitions();
                this.bgActor.opacity = 255;
                this.bgActor.set_scale(1.0, 1.0);
                if (this.animActor) {
                    this.animActor.set_scale(1.0, 1.0);
                    this.animActor.opacity = 255;
                }
            }
            return;
        }
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.bgActor)
            this.bgActor.remove_all_transitions();
        this._springScale.target = targetValue;
        this._springPos.target = targetValue;
        if (this._tickId === 0) {
            let lastTime = GLib.get_monotonic_time();
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._animationInterval, () => {
                if (!this.bgActor || !this.targetActor) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                let currentTime = GLib.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;
                let isClosing = (this._springScale.target === 0);
                let dt = elapsedMs / 1000;
                if (dt > 0.033)
                    dt = 0.033;
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
                        s = 0;
                        p = 0;
                        stopped = true;
                    }
                }
                else {
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
                }
                else {
                    currentScale = 0.2 + (s * 0.8);
                    opacity = Math.min(255, Math.max(0, (s / 0.3) * 255));
                }
                this.animActor.set_scale(currentScale, currentScale);
                this.bgActor.opacity = opacity;
                this.animActor.opacity = opacity;
                this._syncGeometry();
                if (stopped) {
                    this._tickId = 0;
                    if (isClosing && this.menu.actor) {
                        this.menu.actor.hide(); // Tell GNOME the menu is officially closed
                        this.bgActor.opacity = 0;
                        this.animActor.opacity = 0;
                    }
                    if (!isClosing) {
                        this.animActor.set_scale(1.0, 1.0);
                        this.animActor.opacity = 255;
                        this.bgActor.opacity = 255;
                        this._syncGeometry();
                    }
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }
    // ── Submenu position fix (QuickSettings-specific) ──────────────────────────
    // Fix: Force submenu position to the center of the parent menu
    _adjustSubmenuPositions() {
        if (!this._enableSubmenuFix || !this.menu?.isOpen || !this.animActor)
            return;
        // Scan when there's no cached submenus yet
        if (!this._cachedSubmenus) {
            this._cachedSubmenus = [];
            let deepScan = (actor) => {
                if (!actor)
                    return;
                if (actor instanceof St.Widget) {
                    let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
                    if (css && css.split(' ').includes('quick-toggle-menu'))
                        this._cachedSubmenus.push(actor);
                }
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children)
                    deepScan(child);
            };
            deepScan(this.menu.actor);
        }
        let foundMenus = this._cachedSubmenus;
        if (foundMenus.length === 0)
            return;
        // Get the absolute coordinates and size as the parent's base (animActor = the visual bounding box of the menu)
        let [parentAbsX, parentAbsY] = this.animActor.get_transformed_position();
        let [parentW, parentH] = this.animActor.get_size();
        if (Number.isNaN(parentAbsX) || Number.isNaN(parentAbsY) ||
            Number.isNaN(parentW) || Number.isNaN(parentH) ||
            parentW <= 0 || parentH <= 0)
            return;
        for (let submenu of foundMenus) {
            if (!submenu.mapped || !submenu.visible)
                continue;
            let [subAbsX, subAbsY] = submenu.get_transformed_position();
            let [subW, subH] = submenu.get_size();
            if (Number.isNaN(subAbsX) || Number.isNaN(subAbsY) ||
                Number.isNaN(subW) || Number.isNaN(subH) ||
                subW <= 0 || subH <= 0)
                continue;
            // X: centre-align submenu within parent
            let currentTranslationX = submenu.translation_x || 0;
            let baseRelativeX = subAbsX - parentAbsX - currentTranslationX;
            let targetRelativeX = (parentW - subW) / 2;
            let newTranslationX = targetRelativeX - baseRelativeX;
            if (Math.abs(currentTranslationX - newTranslationX) > 0.5) {
                submenu.translation_x = newTranslationX;
            }
            // Y: centre-align submenu in the available gap between neighbours
            let currentTranslationY = submenu.translation_y || 0;
            let baseAbsY = subAbsY - currentTranslationY;
            let subCenterY = baseAbsY + (subH / 2);
            let aboveMaxY = parentAbsY;
            let belowMinY = parentAbsY + parentH;
            let findBoundaries = (n) => {
                if (!n || !n.visible || !n.mapped || n === submenu)
                    return;
                if (typeof n.contains === 'function' && n.contains(submenu)) {
                    let children = typeof n.get_children === 'function' ? n.get_children() : [];
                    for (let child of children)
                        findBoundaries(child);
                    return;
                }
                let [, nodeY] = n.get_transformed_position();
                let [nodeW, nodeH] = n.get_size();
                if (Number.isNaN(nodeY) || Number.isNaN(nodeW) || Number.isNaN(nodeH) ||
                    nodeH <= 5 || nodeW <= 5)
                    return;
                // Separate and evaluate elements above and below based on the submenu's "center point"
                if (nodeY + (nodeH / 2) < subCenterY) {
                    // Elements above: Their bottom edge doesn't cross the submenu center, and are the lowest among them
                    if (nodeY + nodeH <= subCenterY && nodeY + nodeH > aboveMaxY)
                        aboveMaxY = nodeY + nodeH;
                }
                else {
                    // Elements below: Their top edge doesn't cross the submenu center, and are the highest among them
                    if (nodeY >= subCenterY && nodeY < belowMinY)
                        belowMinY = nodeY;
                }
                let children = typeof n.get_children === 'function' ? n.get_children() : [];
                for (let child of children)
                    findBoundaries(child);
            };
            // Execute boundary scan starting from the direct children of the box (parent container)
            let parentChildren = typeof this.animActor.get_children === 'function' ? this.animActor.get_children() : [];
            for (let child of parentChildren)
                findBoundaries(child);
            // Calculate the target value to place the submenu in the center of the identified vertical gap
            let targetTranslationY = (aboveMaxY + (belowMinY - aboveMaxY) / 2) - (subH / 2) - baseAbsY;
            // Chattering prevention (update only if there's a difference of 0.5px or more from the current movement)
            if (Math.abs(currentTranslationY - targetTranslationY) > 0.5) {
                submenu.translation_y = targetTranslationY;
            }
        }
    }
    _clearSubmenuFix() {
        // Scan when there's no cached submenus yet
        let foundMenus = this._cachedSubmenus || [];
        if (foundMenus.length === 0) {
            let deepScan = (actor) => {
                if (!actor)
                    return;
                if (actor instanceof St.Widget) {
                    let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
                    if (css && css.split(' ').includes('quick-toggle-menu'))
                        foundMenus.push(actor);
                }
                let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
                for (let child of children)
                    deepScan(child);
            };
            if (this.menu?.actor)
                deepScan(this.menu.actor);
        }
        for (let submenu of foundMenus) {
            try {
                submenu.translation_x = 0;
            }
            catch (e) { }
        }
        this._cachedSubmenus = null; // Clear cache
    }
    // ── Effect remove / cleanup ─────────────────────────────────────────────────
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        this._clearButtonStyles();
        this._clearSubmenuFix();
        this._clearToggleStyles(); // no-op if Background mode was active (map is empty)
        // Disconnect all event listeners
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
        }
        this._signals = [];
        if (this._animSignalId) {
            try {
                this.menu.disconnect(this._animSignalId);
            }
            catch (e) { }
            this._animSignalId = 0;
        }
        // Stop the render frame loop
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        // Remove transparent CSS overrides
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-qs-root');
            this.animActor.translation_x = 0;
            this.animActor.translation_y = 0;
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.opacity = 255;
        }
        this.targetActor.translation_y = 0;
        this.targetActor.translation_x = 0;
        this.targetActor.set_scale(1.0, 1.0);
        this.targetActor.opacity = 255;
        if (this.menu.actor) {
            this.menu.actor.opacity = 255;
            this.menu.actor.translation_x = 0;
            this.menu.actor.translation_y = 0;
            if (this.menu.isOpen)
                this.menu.close(false);
        }
        // DESTROY EFFECT FIRST (before bgActor.destroy())
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
        // [FIX-5] bgActor's PARENT is now _toggleGlassHost (a LayoutOpaqueActor
        // living inside animActor), not the other way around — destroying
        // bgActor doesn't touch it, so it needs its own explicit teardown or
        // it lingers as a dangling empty child of animActor.
        if (this._toggleGlassHost) {
            if (isActorValid(this._toggleGlassHost)) {
                try {
                    this._toggleGlassHost.destroy();
                }
                catch (e) { }
            }
            this._toggleGlassHost = null;
        }
        this.liquidBox = null;
        this._cloneContainer = null;
        // Clean up managers (their destroy() guards against already-destroyed actors)
        this._uiSampler?.destroy();
        this._uiSampler = null;
        this._windowCloneManager?.destroy();
        this._windowCloneManager = null;
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
        this._lastScreenW = undefined;
        this._lastScreenH = undefined;
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
        this._activeMode = null;
    }
    cleanup() {
        for (let sigId of this._settingsSignals) {
            try {
                this._settings.disconnect(sigId);
            }
            catch (e) { }
        }
        this._settingsSignals = [];
        if (!this.targetActor)
            return;
        this._removeEffect();
    }
}
// A straightforward mathematical implementation of Hooke's Law for spring physics
class Spring {
    stiffness;
    damping;
    mass;
    value;
    velocity;
    target;
    constructor(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
        this.value = 0; // Current position/scale
        this.velocity = 0; // Current speed
        this.target = 0; // Destination value
    }
    updateParams(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
    }
    update(elapsedMs) {
        // Cap max delta time to prevent the spring from violently exploding during heavy CPU load
        let dt = elapsedMs / 1000;
        if (dt > 0.033)
            dt = 0.033;
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
