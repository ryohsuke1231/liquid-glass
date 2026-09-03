// src/quickSettingsManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableActor, UILayerSampler, WindowCloneManager, isActorValid, LayoutOpaqueActor, UnpickableStyledWidget, } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class QuickSettingsManager {
    // [FIX-6] How many consecutive frames Toggles mode may keep painting its
    // last known-good region set while a structural change settles. Two frames
    // is enough to cover a relayout landing after the BEFORE_REDRAW pass that
    // reads geometry, and short enough to be imperceptible if it ever fires
    // when the toggles really did disappear.
    static REGION_GRACE_FRAMES = 2;
    // How often each pod's own (base) color is re-read from its live theme
    // node. This is what makes a toggle's glass follow its ON/OFF and hover
    // state, so it is felt directly as "how quickly the glass reacts".
    //
    // [PERF] Lowered from 400ms to 100ms. The naive version of that would have
    // quadrupled a genuinely expensive pass (see stateKey on _toggleRegions),
    // so the pass now short-circuits on pods whose style state is unchanged;
    // in the steady state — nothing hovered, nothing toggled — a tick costs a
    // handful of pseudo-class reads and no style invalidation at all.
    static TOGGLE_COLOR_SAMPLE_MS = 100;
    // Every Nth pass ignores that short-circuit and re-samples unconditionally,
    // catching color changes that leave the pseudo-classes untouched — a
    // gnome-shell theme switch above all, which repaints every pod (and can
    // flip whether a `.quick-slider` is a glass pod at all — see
    // _resampleToggleColors()) without any state change to notice. 8 × 100ms
    // keeps that worst case at ~800ms, roughly where the old flat 400ms
    // cadence already put it.
    static TOGGLE_COLOR_FULL_PASS_EVERY = 8;
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
    // Cached [r,g,b] from quick-settings-tint-color (0..1). [FIX-8] Both modes
    // now pass it straight to LiquidEffect.setTintColor(); Toggles mode used to
    // pre-blend it into each region's tint instead, which is what coupled it to
    // the custom tint strength (see _syncToggleRegions()).
    _tintColorArray = [1.0, 1.0, 1.0];
    // Toggles-mode-only parameters.
    //
    // [FIX-8] `quick-settings-toggle-tint-strength` (key name unchanged) is now
    // read as "Base Color Strength": how strongly each toggle's OWN color is
    // applied, independently of `quick-settings-tint-strength` ("Custom Color
    // Strength"). It used to be a crossfade RATIO between the two — 0 meant
    // "show the toggle's own color, none of the custom tint" — so the value's
    // sense is inverted with respect to the old behaviour: 0 now means "do not
    // apply the toggle's own color at all", 1 means "apply it fully".
    _toggleBaseStrength = 0.5;
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
    // [PERF] Counts _resampleToggleColors() passes so every Nth one can ignore
    // the stateKey short-circuit above — a theme change repaints every pod
    // without touching a single pseudo-class, so state alone can't be trusted
    // as the only trigger. See TOGGLE_COLOR_FULL_PASS_EVERY.
    _resamplePassCount = 0;
    // [FIX-6] Last successfully computed Toggles-mode region set, plus how many
    // consecutive frames we have been falling back on it. Used to ride out the
    // one-or-two frames after a structural change (submenu open/close, a toggle
    // being added/removed) during which a pod can be visible but not yet
    // allocated — see _syncToggleRegions().
    _lastGoodRegions = null;
    _regionGraceFrames = 0;
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
        this._toggleBaseStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
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
            // [FIX-8] Pushed in BOTH modes. The custom tint color is its own shader
            // layer now (see glass.frag), so Toggles mode reads the same tint_r/g/b
            // uniform as Background mode rather than having this colour pre-blended
            // into each region's tint on the TS side.
            this._tintColorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
            if (this.effect) {
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
            this._toggleBaseStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
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
        this._lastGoodRegions = null;
        this._regionGraceFrames = 0;
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._toggleBaseStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
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
        // Note bgActor is now a descendant of `_menuRoot` (via animActor). Nothing
        // in _cloneContainer may therefore sample `_menuRoot` by painting it —
        // that is a self-referential loop. _ensurePanelContentClone() paints the
        // panel's theme background onto a bare widget rather than cloning or
        // snapshotting anything; see its comment for the three approaches that
        // did sample it and how each one failed.
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
        // [FIX-8] Toggles mode needs the tint_r/g/b uniform pushed too, now that
        // the custom-color layer reads it directly instead of the TS side folding
        // the custom color into each region's pre-blended tint. Without this the
        // shader would tint every toggle with LiquidEffect's default color.
        this._tintColorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
        this.effect.setTintColor(...this._tintColorArray);
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
    //  - [EXTEND] one of the SystemItem action buttons: the screenshot,
    //    settings, lock and shutdown buttons that sit in the row above the
    //    sliders. In the actor tree they are ScreenshotItem / SettingsItem /
    //    LockItem / ShutdownItem, all plain `.icon-button` St.Buttons parented
    //    (at some depth) by the `.quick-settings-system-item` widget, and both
    //    themes give them a real pill background of their own (Adwaita
    //    #48484b, mactahoe rgba(255,255,255,.15)) — i.e. exactly the same
    //    "solid chip that should become glass" shape as a quick toggle.
    //
    //    The `.icon-button` class alone is NOT a sufficient test: the sliders'
    //    mute/level buttons carry `icon-button flat`, a split toggle's arrow
    //    carries `quick-toggle-menu-button icon-button`, and the keyboard
    //    brightness submenu's level buttons carry a bare `icon-button` too.
    //    Descent therefore only treats `.icon-button` as a pod once it is
    //    inside a `.quick-settings-system-item` subtree (tracked by the
    //    `inSystemItem` flag below), which is precisely the four buttons above
    //    — the toggle arrows are unreachable anyway, since a matched toggle
    //    pod is never descended into.
    //
    //  - [EXTEND] a `.quick-slider` row (volume / input / brightness) — but
    //    ONLY on themes that actually paint a pill around it. mactahoe wraps
    //    the volume bar in a rgba(255,255,255,.15) rounded container (the
    //    thing the user sees "surrounding" the slider); Adwaita paints nothing
    //    there at all (`ThemeColor:#00000000`), and putting a glass chip
    //    behind a slider that has no container of its own would invent a
    //    surface the theme never had. So the decision is made from the live
    //    theme node rather than from a theme name — see _paintsOwnBackground().
    //
    //    A `.quick-slider` is never descended into either way, so on Adwaita
    //    its inner `icon-button flat` mute buttons stay untouched rather than
    //    becoming four stray chips.
    //
    // In every case this does NOT descend into a matched pod's children — the
    // whole pod is treated as one shape; see _getStylableSubActors() for how
    // its interactive children get their backgrounds neutralized.
    _findAllToggleContainers(actor, found = [], inSystemItem = false) {
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
        // [EXTEND] Screenshot / Settings / Lock / Shutdown.
        if (inSystemItem && actor instanceof St.Widget && actor.has_style_class_name('icon-button')) {
            if (actor.visible)
                found.push(actor);
            return found;
        }
        // [EXTEND] The slider's surrounding container, on themes that draw one.
        if (actor instanceof St.Widget && actor.has_style_class_name('quick-slider')) {
            if (actor.visible && this._paintsOwnBackground(actor))
                found.push(actor);
            return found;
        }
        let entersSystemItem = inSystemItem ||
            (actor instanceof St.Widget && actor.has_style_class_name('quick-settings-system-item'));
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let child of children)
            this._findAllToggleContainers(child, found, entersSystemItem);
        return found;
    }
    // [EXTEND] "Does this widget paint a background of its OWN?" — used to
    // decide whether a `.quick-slider` row is a glass pod (mactahoe: yes, it
    // has a visible rgba(255,255,255,.15) container; Adwaita: no, the row is
    // bare and only its children paint).
    //
    // The `_toggleRegions` check first is essential, not an optimization: once
    // a pod has been adopted, _ensureToggleStyles() forces
    // `background-color: transparent !important` onto its whole subtree, and
    // the theme node reflects that inline override — so re-asking this question
    // here on the next frame would read back OUR OWN transparency and un-adopt
    // the pod, making it flicker in and out of the region set every frame.
    //
    // [EXTEND-FIX] An adopted pod therefore keeps its verdict as far as THIS
    // function is concerned, but the verdict is no longer permanent: it is
    // re-checked by _resampleToggleColors(), in the one moment per pass where
    // the override is lifted and the pod's real theme is readable again, and a
    // slider that stopped painting its own pill is released there. Pinning it
    // forever is what let a slider adopted under mactahoe stay glassed after
    // switching to Adwaita — see the comment at that check for the full story.
    _paintsOwnBackground(actor) {
        if (this._toggleRegions.has(actor))
            return true;
        let bg = this._readThemeBg(actor);
        return !!(bg && bg.a > 0.02);
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
    // Returns every `.quick-toggle-icon` widget under `root`. Some themes put
    // a toggle's ON/OFF color on this chip rather than on the button or the
    // has-menu wrapper — see _samplePodColor() for the concrete CSS.
    _getToggleIconActors(root) {
        const found = [];
        const walk = (actor) => {
            if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-icon')) {
                found.push(actor);
            }
            let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
            for (let child of children)
                walk(child);
        };
        if (root)
            walk(root);
        return found;
    }
    // [FIX] Reads a theme-node background color as normalized {r,g,b,a}
    // (0..1), or null if the actor can't be sampled at all. Used by
    // _samplePodColor() so alpha is never silently discarded.
    //
    // [FIX-7] Also falls back to the theme node's background GRADIENT when the
    // flat background-color is fully transparent. St resolves
    // `background-gradient-start`/`-end` into a separate property, so a theme
    // that paints a pod with a gradient reports background-color rgba(0,0,0,0)
    // — indistinguishable, to the old code, from a pod that paints nothing at
    // all, and the "black" the user could see the tint drifting towards. The
    // gradient's two stops averaged is a fair single representative color for
    // tinting purposes (the glass chip gets one flat tint per region anyway).
    _readThemeBg(actor) {
        if (!(actor instanceof St.Widget))
            return null;
        actor.ensure_style();
        let themeNode = actor.get_theme_node();
        if (!themeNode)
            return null;
        let bg = themeNode.get_background_color();
        if (bg && bg.alpha / 255 > 0.02)
            return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
        try {
            let [gradType, start, end] = themeNode.get_background_gradient();
            if (gradType !== St.GradientType.NONE && start && end) {
                let a = ((start.alpha + end.alpha) / 2) / 255;
                if (a > 0.02) {
                    return {
                        r: ((start.red + end.red) / 2) / 255,
                        g: ((start.green + end.green) / 2) / 255,
                        b: ((start.blue + end.blue) / 2) / 255,
                        a,
                    };
                }
            }
        }
        catch (e) {
            // Older/newer St without the gradient getter — the flat color below
            // is still a valid answer, just a transparent one.
        }
        if (!bg)
            return null;
        return { r: bg.red / 255, g: bg.green / 255, b: bg.blue / 255, a: bg.alpha / 255 };
    }
    // [FIX-7] Composites `actor`'s own background over its ancestors' until the
    // stack is opaque (or the walk runs out), i.e. resolves what a viewer
    // ACTUALLY sees at that actor's position.
    //
    // Why this is needed: a fully transparent background-color still carries
    // RGB, and CSS engines overwhelmingly leave that RGB at black — mactahoe's
    // `.quick-toggle-has-menu .quick-toggle { background: none }` reports
    // rgba(0,0,0,0.00), and Adwaita does the same for anything unstyled. Any
    // code path that reads such a sample and keeps its RGB is reading black
    // that the theme never intended to paint. Compositing over the ancestry
    // replaces that meaningless black with the color genuinely visible there
    // (for mactahoe: the pod's own translucent white sheen over
    // `.popup-menu-content`'s rgba(36,36,36,0.92)), so the tint calculation
    // always works from a real color.
    //
    // Returns the composited color plus `a` — the accumulated coverage, which
    // is 1.0 once an opaque ancestor was reached and less when the whole stack
    // really is see-through.
    _compositeOverAncestors(actor, own) {
        // Standard "source-over" accumulation, front to back: each layer further
        // back only contributes through whatever transparency is left above it.
        let outR = 0, outG = 0, outB = 0, outA = 0;
        const add = (c) => {
            if (!c || !(c.a > 0))
                return;
            let w = c.a * (1 - outA);
            outR += c.r * w;
            outG += c.g * w;
            outB += c.b * w;
            outA += w;
        };
        add(own);
        let node = actor ? actor.get_parent() : null;
        // The walk is bounded by the stage anyway; the counter is only a guard
        // against a pathologically deep (or cyclic, if something is very wrong)
        // actor tree being walked every sampling pass.
        let guard = 32;
        while (node && outA < 0.995 && guard-- > 0) {
            if (node instanceof St.Widget)
                add(this._readThemeBg(node));
            node = node.get_parent();
        }
        if (outA <= 0)
            return { r: 0, g: 0, b: 0, a: 0 };
        // Un-premultiply so callers get a plain color plus a coverage figure.
        return { r: outR / outA, g: outG / outA, b: outB / outA, a: outA };
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
    //
    // [FIX-7] "Under mactahoe the toggles' color comes back transparent, and
    // the tint then falls back to black." Confirmed against the theme's own
    // CSS: `.quick-toggle-has-menu .quick-toggle` is `background: none
    // !important` in EVERY state, so the primary button genuinely reports
    // rgba(0,0,0,0.00) — a transparent black whose RGB is an artifact of the
    // CSS engine, not a color the theme ever paints. The max-alpha pick above
    // already avoided trusting it whenever the wrapper painted something, but
    // it still returned that black verbatim whenever NO candidate painted
    // anything, and it still described a candidate's own translucent color as
    // if that color were what the eye sees.
    //
    // Both are now resolved through _compositeOverAncestors(), so the RGB
    // handed to the tint math is always a color that is genuinely visible at
    // the pod: the winning candidate's own paint composited over everything
    // behind it, or — when nothing in the pod paints at all — simply whatever
    // shows through from behind the pod (the panel), never black-by-default.
    //
    // [FIX-8] `a` is now simply the composited coverage — "how much real paint
    // did we actually find here" — and the caller only tests it against a noise
    // floor to decide whether a usable color was resolved at all. It is no
    // longer used to scale the tint: the strength of the base color is the
    // user's Base Color Strength slider alone, and the returned RGB is already
    // the color the pod genuinely composites to on screen, so weighting it a
    // second time by its own transparency would double-count.
    _samplePodColor(pod, primary) {
        let isHasMenu = pod instanceof St.Widget && pod.has_style_class_name('quick-toggle-has-menu');
        let candidates = [primary];
        if (isHasMenu && pod !== primary)
            candidates.push(pod);
        // [FIX-9] "Under mactahoe the base color never changes with a toggle's
        // ON/OFF state, while the custom tint color works fine." Confirmed
        // against MacTahoe-Dark/gnome-shell/gnome-shell.css: for a has-menu pod
        // (Wi-Fi, Bluetooth) NEITHER of the two candidates above carries the
        // state at all —
        //
        //   .quick-toggle-has-menu          { background-color: rgba(255,255,255,.15) }
        //   .quick-toggle-has-menu:checked  { background-color: rgba(255,255,255,.15) }   ← identical
        //   .quick-toggle-has-menu .quick-toggle{,:hover,:active,:checked}
        //                                   { background: none !important }               ← always empty
        //
        // The only element that actually swings is the icon chip:
        //
        //   .quick-toggle-has-menu .quick-toggle .quick-toggle-icon          { rgba(255,255,255,.15) }
        //   .quick-toggle-has-menu .quick-toggle:checked .quick-toggle-icon  { white }
        //
        // so sampling the wrapper/button pair returns exactly the same color in
        // both states, which is what "the base color doesn't react to ON/OFF"
        // looks like. Adwaita puts the state on `.quick-toggle` itself (which is
        // why it has always worked there) and gives `.quick-toggle-icon` no
        // background at all, so adding the icon as a further candidate reads
        // alpha 0 there and can never displace the existing winner: the
        // max-alpha pick below breaks ties in favour of the EARLIER candidate.
        for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod)) {
            if (icon !== primary && icon !== pod)
                candidates.push(icon);
        }
        let bestActor = null;
        let bestOwn = null;
        for (let candidate of candidates) {
            let own = this._readThemeBg(candidate);
            if (!own)
                continue;
            if (!bestOwn || own.a > bestOwn.a) {
                bestOwn = own;
                bestActor = candidate;
            }
        }
        if (bestOwn && bestOwn.a > 0.02) {
            return this._compositeOverAncestors(bestActor, bestOwn);
        }
        // Nothing in the pod paints a background of its own — the pod's real
        // on-screen color is simply what shows through it. Composite from the
        // pod upwards (`own` = null) and report that as the color, with the
        // accumulated coverage as its alpha.
        return this._compositeOverAncestors(pod, null);
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
                entry = { baseColor: [1.0, 1.0, 1.0], baseAlpha: 0, styledSubs: [], stateKey: '' };
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
        // [PERF] See TOGGLE_COLOR_FULL_PASS_EVERY.
        let forceFull = (this._resamplePassCount++ % QuickSettingsManager.TOGGLE_COLOR_FULL_PASS_EVERY) === 0;
        for (const [pod, entry] of this._toggleRegions.entries()) {
            if (!pod)
                continue;
            let primary = this._getPrimaryToggleButton(pod);
            // [PERF] Nothing that can change this pod's color has changed since the
            // last pass, so its overrides are left exactly as they are — no style
            // invalidation, no theme-node resolution, no re-sample.
            let stateKey = this._podStateKey(pod, primary);
            if (!forceFull && stateKey === entry.stateKey)
                continue;
            entry.stateKey = stateKey;
            // Restore every sub-actor's original style first so the primary
            // button's sampled color reflects its real, un-overridden theme.
            for (const { actor, origStyle } of entry.styledSubs) {
                if (actor instanceof St.Widget)
                    actor.set_style(origStyle || null);
            }
            // [EXTEND-FIX] "Adwaita でも音量バーにガラスが適用されてしまう."
            //
            // A `.quick-slider` only becomes a pod on themes that actually paint a
            // pill around it (mactahoe does, Adwaita does not) — but that verdict
            // was made once, from the live theme node, and then pinned for the
            // lifetime of the actor by _paintsOwnBackground()'s `_toggleRegions`
            // short-circuit. That short-circuit is unavoidable while our own
            // transparency override is in place (the theme node reports OUR
            // transparency, so re-asking would un-adopt the pod every frame and
            // make it flicker) — but it silently assumed a pod's theme never
            // changes under it.
            //
            // It does: switching the gnome-shell theme does NOT rebuild the
            // quick-settings actors, so the very same OutputStreamSlider adopted
            // under mactahoe stayed adopted after switching to Adwaita, glass and
            // all, with nothing left that could ever revoke it.
            //
            // Right here is the one moment per pass where the override is lifted
            // and the pod's REAL theme is readable again, so this is where the
            // verdict gets re-checked. A slider that no longer paints its own pill
            // is released outright: its original styles are already restored just
            // above, so simply dropping the entry (and skipping the re-apply below)
            // hands the actor back to the theme untouched. _findAllToggleContainers()
            // then re-reads the live theme node on the next frame — now finding a
            // bare Adwaita row — and stops emitting a region for it. The reverse
            // direction needs nothing extra: an unadopted slider is always judged
            // live, so switching back to mactahoe re-adopts it on the next frame.
            if (pod instanceof St.Widget && pod.has_style_class_name('quick-slider')) {
                let pill = this._readThemeBg(pod);
                if (!(pill && pill.a > 0.02)) {
                    this._logger.log(`[Liquid Glass][toggle-color] releasing .quick-slider pod — theme no longer paints a pill ` +
                        `(bg=${JSON.stringify(pill)})`);
                    this._toggleRegions.delete(pod);
                    continue;
                }
            }
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
                    // [FIX-9] The icon chip is the only element some themes (mactahoe)
                    // move the ON/OFF color onto — log it alongside the other two so a
                    // "the base color never changes" report can be settled from the
                    // journal alone.
                    let iconBgs = this._getToggleIconActors(pod !== primary ? primary : pod)
                        .map(a => JSON.stringify(this._readThemeBg(a))).join(' ');
                    this._logger.log(`[Liquid Glass][toggle-color] pod class="${podCls}" isHasMenu=${isHasMenu} ` +
                        `primary class="${primaryCls}" checked=${checked} ` +
                        `primaryBg=${JSON.stringify(this._readThemeBg(primary))} ` +
                        `wrapperBg=${wrapperBg ? JSON.stringify(wrapperBg) : 'n/a'} ` +
                        `iconBg=[${iconBgs || 'none'}] ` +
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
        this._toggleColorTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QuickSettingsManager.TOGGLE_COLOR_SAMPLE_MS, () => {
            if (!this.menu?.isOpen) {
                this._toggleColorTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._resampleToggleColors();
            return GLib.SOURCE_CONTINUE;
        });
    }
    // [PERF] The pseudo-class fingerprint described on _toggleRegions.stateKey.
    // Covers exactly the actors _samplePodColor() can pick as its winner (the
    // pod, its primary button, and any `.quick-toggle-icon` chip), since a
    // state change anywhere else in the subtree cannot alter the sampled color.
    _podStateKey(pod, primary) {
        const STATES = ['checked', 'hover', 'active', 'insensitive', 'focus', 'selected'];
        let actors = [pod];
        if (primary !== pod)
            actors.push(primary);
        for (let icon of this._getToggleIconActors(pod !== primary ? primary : pod))
            actors.push(icon);
        let key = '';
        for (let actor of actors) {
            if (!(actor instanceof St.Widget) || typeof actor.has_style_pseudo_class !== 'function') {
                key += '?|';
                continue;
            }
            for (let state of STATES) {
                key += actor.has_style_pseudo_class(state) ? '1' : '0';
            }
            key += '|';
        }
        return key;
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
    // ── Panel material layer ──────────────────────────────────────────────────
    //
    // In Toggles mode the glass host is animActor's bottom-most child, so each
    // toggle's glass paints over the panel's own background and under the real
    // toggle. What the glass has to show inside a toggle's bounds is therefore
    // the panel's MATERIAL (its background color / gradient / border-image, and
    // whatever the desktop shows through it) — not the panel's contents, which
    // are already painted, sharp, on top of the glass.
    //
    // Everything BEHIND the panel is already supplied by _uiSampler's clones of
    // every other uiGroup child, so the only layer missing from _cloneContainer
    // is that material. This paints it with a bare St.Widget carrying the real
    // panel's style class (see UnpickableStyledWidget): St resolves and paints
    // the identical background for it, live and for free.
    //
    // [FIX-10] Three earlier attempts and why they were abandoned:
    //
    //  1. Clutter.Clone(_menuRoot). bgActor is a descendant of _menuRoot (via
    //     animActor), and a Clone re-invokes its source's paint, so the source
    //     paint reached back into the clone's own container — an unbounded
    //     synchronous recursion that crashed the shell on a JS stack overflow.
    //
    //  2. SelfExcludingSnapshotCapture: stage.paint_to_content() of the panel
    //     rect on every 'after-paint', with bgActor hidden for that one call.
    //     No recursion, and it worked — but it captured the panel exactly as
    //     rendered, contents included, so every label and icon appeared twice:
    //     once for real on top of the glass, once refracted inside it.
    //
    //  3. As 2, plus hiding animActor's real children for the capture. This
    //     removed the doubling and broke four other things at once, all of them
    //     consequences of toggling the visibility of live, interactive, laid-out
    //     widgets sixty times a second: clutter_actor_hide() queues a relayout
    //     on the parent, unmaps the subtree (dropping key focus, which made
    //     every click inside Quick Settings close the menu), and churns the
    //     stage's damage bookkeeping — the latter showing up as a hard vertical
    //     edge with glass on one side and none on the other, at a position that
    //     moved with the theme, and as the glass momentarily appearing complete
    //     during the open/close animation (when the whole panel is damaged every
    //     frame anyway).
    //
    // Painting the material directly avoids all of it: no clone, no nested stage
    // paint, no touching the real panel at all.
    _panelActorWarned = false;
    // [FIX-9] Resolves the panel rectangle in stage coordinates, plus the actor
    // it came from.
    //
    // This used to read `_menuRoot` (the uiGroup-direct-child ancestor of
    // menu.actor) unconditionally, and the [snapshot:qs-panel] diagnostic showed
    // that actor reporting 0x0 for the whole session — first as
    // `x=NaN y=NaN w=0 h=0` (never allocated) and then `x=0 y=0 w=0 h=0`, which
    // left the panel layer with no geometry at all and so nothing but the
    // wallpaper/window clones showing inside the glass.
    //
    // Rather than depend on one actor being allocated, take the first candidate
    // that reports a usable geometry — the ancestor, the menu actor itself, and
    // the content box are all the same rectangle for our purposes (the content
    // box excludes the BoxPointer's arrow, which the glass never samples
    // anyway).
    _resolvePanelActor() {
        const candidates = [this._menuRoot, this.targetActor, this.animActor];
        for (const actor of candidates) {
            if (!actor || !isActorValid(actor))
                continue;
            let [w, h] = actor.get_size();
            let [x, y] = actor.get_transformed_position();
            if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0)
                return actor;
        }
        if (!this._panelActorWarned) {
            this._panelActorWarned = true;
            const describe = (a) => {
                if (!a)
                    return 'null';
                try {
                    return `${a.get_name?.() ?? '?'}/${a.constructor?.name} ` +
                        `size=${a.get_size()} pos=${a.get_transformed_position()} ` +
                        `mapped=${a.mapped} parent=${a.get_parent()?.get_name?.() ?? '?'}`;
                }
                catch (e) {
                    return `(threw: ${e})`;
                }
            };
            this._logger.error('[Liquid Glass][qs-panel-clone] no usable panel actor: ' +
                `menuRoot=[${describe(this._menuRoot)}] ` +
                `targetActor=[${describe(this.targetActor)}] ` +
                `animActor=[${describe(this.animActor)}]`);
        }
        return null;
    }
    /** Stage-space [x, y, w, h] of the panel, or null when none is usable. */
    _resolvePanelRect() {
        const actor = this._resolvePanelActor();
        if (!actor)
            return null;
        let [x, y] = actor.get_transformed_position();
        let [w, h] = actor.get_size();
        return [x, y, w, h];
    }
    _ensurePanelContentClone(monitorX, monitorY) {
        const panelActor = this._resolvePanelActor();
        if (!panelActor)
            return;
        if (!this._cloneContainer)
            return;
        if (!this._panelContentClone || !isActorValid(this._panelContentClone) ||
            !this._panelContentClone.get_stage || !this._panelContentClone.get_stage()) {
            if (isActorValid(this._panelContentClone)) {
                try {
                    this._panelContentClone.destroy();
                }
                catch (e) { }
            }
            let material = new UnpickableStyledWidget();
            material.set_name('liquid-glass-panel-material');
            material.set_reactive(false);
            this._panelContentClone = material;
            this._panelContentClone.connect('destroy', () => { this._panelContentClone = null; });
            this._cloneContainer.add_child(this._panelContentClone);
        }
        // Track the real panel's style class so a theme change (or GNOME adding a
        // state class) is picked up without a restart.
        let cls = (this.animActor instanceof St.Widget && typeof this.animActor.get_style_class_name === 'function')
            ? (this.animActor.get_style_class_name() || '')
            : '';
        if (this._panelContentClone.get_style_class_name() !== cls) {
            this._panelContentClone.set_style_class_name(cls);
        }
        // No inline style override: the widget is placed at the real panel's
        // ALLOCATION, and St insets a widget's background by its CSS margin, so
        // letting the theme's own margin apply is what lands the material exactly
        // where the real background is drawn (mactahoe's `.popup-menu-content`
        // carries `margin: 4px 12px 17px 12px`). Padding is irrelevant here — it
        // only positions children, and this widget has none.
        // Always keep it above _windowCloneManager's own clone containers —
        // those get destroyed/re-added on every rebuildClones() (see
        // buildClones() in _applyToggleEffect()), which would otherwise
        // silently invert the stacking order (desktop clones ending up drawn
        // ON TOP of the panel material) the next time a window opens/closes.
        this._cloneContainer.set_child_above_sibling(this._panelContentClone, null);
        let rect = this._resolvePanelRect();
        if (rect) {
            this._panelContentClone.set_position(rect[0] - monitorX, rect[1] - monitorY);
            this._panelContentClone.set_size(rect[2], rect[3]);
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
    }
    // [FIX-6] Multiplies the OWN scale of `actor` and of every one of its
    // ancestors up to the stage. Clutter.Actor.get_scale() reports only an
    // actor's own scale property — it says nothing about scale inherited from
    // ancestors — and BoxPointer.open() genuinely eases scale_x/scale_y from
    // 0.96 to 1.0 while Quick Settings opens. Countering only the (always 1.0)
    // own scale of _toggleGlassHost therefore left the glass rendered ~4% off
    // for the whole open animation; this is what actually has to be undone.
    _getAccumulatedScale(actor) {
        let sx = 1.0;
        let sy = 1.0;
        let node = actor;
        while (node) {
            let [nsx, nsy] = node.get_scale();
            if (Number.isFinite(nsx) && nsx !== 0)
                sx *= nsx;
            if (Number.isFinite(nsy) && nsy !== 0)
                sy *= nsy;
            node = node.get_parent();
        }
        return [sx || 1.0, sy || 1.0];
    }
    // [FIX-6] Whether a cached region set is still young enough to stand in for
    // a frame that produced none. Pure query — _takeLastRegions() is what
    // actually consumes a grace frame.
    _canReuseLastRegions() {
        return this._lastGoodRegions !== null &&
            this._regionGraceFrames < QuickSettingsManager.REGION_GRACE_FRAMES;
    }
    // [FIX-6] Consumes one grace frame and hands back the cached region set, or
    // null once the grace window is spent (at which point the cache is dropped,
    // so the glass hides for real rather than lingering over toggles that are
    // genuinely gone).
    _takeLastRegions() {
        if (!this._canReuseLastRegions()) {
            this._lastGoodRegions = null;
            return null;
        }
        this._regionGraceFrames++;
        return this._lastGoodRegions;
    }
    // ── Toggles-mode geometry / region synchronisation (per frame) ─────────────
    // Unlike _syncGeometry(), this never touches animActor/targetActor scale,
    // opacity, or position — Toggles mode has no animation of its own; the
    // menu opens/closes using GNOME's native behaviour untouched.
    _syncToggleRegions() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
            if (this.bgActor && this.bgActor.visible)
                this.bgActor.hide();
            // [FIX-6] A closing menu is a real disappearance, not a transient
            // structural gap — drop the cache so the next open starts clean.
            this._lastGoodRegions = null;
            this._regionGraceFrames = 0;
            return;
        }
        // Monitor geometry. Computed FIRST because the bgActor counter-transform
        // right below needs monitorX/monitorY too — everything in this function
        // (every regionX/regionY, the panel-content clone's position, the
        // shader resolution) works in monitor-local coordinates.
        let monitor = this._getMenuMonitorGeometry();
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
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
        //  2. Counter-transform bgActor against everything animActor's own
        //     ancestry does to it, so bgActor's internal monitor-space math
        //     stays valid unchanged. Without this, bgActor's (0,0) would sit
        //     wherever the host happens to land on screen instead of at the
        //     monitor's own origin.
        //
        // [FIX-6] "The glass only shows up once the open animation has fully
        // finished, and blinks out for a moment whenever a submenu opens or
        // closes." Two separate defects in the counter-transform, both of which
        // only bite while the panel's geometry is CHANGING — which is exactly
        // the open animation and the submenu open/close relayout:
        //
        //  a. The geometry-change branch further down (`if (this._lastBgW !== …)`)
        //     ended with `this.bgActor.set_position(monitorX, monitorY)`, copied
        //     verbatim from Background mode where bgActor is a uiGroup child and
        //     that IS its correct screen position. In Toggles mode bgActor hangs
        //     off animActor instead, so that line silently overwrote the
        //     counter-translation computed here with a raw monitor origin — and
        //     since that branch fires on every frame where the regions move, the
        //     glass spent the entire open animation (and the submenu relayout)
        //     displaced by the panel's own absolute position, i.e. shoved off the
        //     right edge of the screen. It only snapped back into place once the
        //     regions stopped changing and the branch stopped firing — hence
        //     "appears only after the animation ends" / "blinks". bgPosX/bgPosY
        //     are now computed once here and re-applied by that branch instead of
        //     being clobbered.
        //
        //  b. `get_scale()` reports an actor's OWN scale property only; the host
        //     carries none, so `hostScaleX/Y` was always exactly 1.0 and the
        //     divisions were no-ops. The scale that actually matters is INHERITED
        //     — BoxPointer.open() genuinely eases scale_x/scale_y from 0.96 to
        //     1.0 — so the accumulated ancestor scale is what has to be countered
        //     (see _getAccumulatedScale()), otherwise the glass renders ~4% off
        //     for the duration of every open animation.
        let bgPosX = monitorX;
        let bgPosY = monitorY;
        if (this.animActor instanceof Clutter.Actor && this._toggleGlassHost) {
            this.animActor.set_child_below_sibling(this._toggleGlassHost, null);
            let [hostAbsX, hostAbsY] = this._toggleGlassHost.get_transformed_position();
            let [accScaleX, accScaleY] = this._getAccumulatedScale(this._toggleGlassHost);
            if (Number.isFinite(hostAbsX) && Number.isFinite(hostAbsY)) {
                // Undo the inherited scale on bgActor itself (pivot is (0,0), so this
                // never moves its origin), then place its origin so that — after the
                // host's own transform is applied on top — it lands exactly on the
                // monitor's origin. bgActor's content is then 1:1 with real screen
                // pixels again, which is what all the region math below assumes.
                this.bgActor.set_scale(1.0 / accScaleX, 1.0 / accScaleY);
                bgPosX = (monitorX - hostAbsX) / accScaleX;
                bgPosY = (monitorY - hostAbsY) / accScaleY;
            }
        }
        else {
            Main.layoutManager.uiGroup.set_child_above_sibling(this.bgActor, null);
        }
        this.bgActor.set_position(bgPosX, bgPosY);
        let toggles = this._findAllToggleContainers(this.menu?.actor);
        this._ensureToggleStyles(toggles);
        this._ensurePanelContentClone(monitorX, monitorY);
        if (toggles.length === 0 && !this._canReuseLastRegions()) {
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
            // [FIX-8] "A toggle whose background genuinely turns solid white when
            // ON (Do Not Disturb under mactahoe) barely shows any white unless the
            // custom Tint Strength is also turned up."
            //
            // The old code pre-blended the pod's own color with the configured tint
            // color HERE and handed the shader one combined color, so the shader's
            // single tint_strength ended up scaling both. At Tint Strength 0.21 the
            // pod's own white was therefore applied at 21% too — and the only way
            // to make it read strongly was to make the custom tint read strongly as
            // well, which is exactly backwards (there is no "transparent" Tint
            // Color to escape to).
            //
            // The two are now independent layers in the shader (see glass.frag's
            // mix() chain): this passes the pod's own color as the region's BASE
            // color plus its own strength, and the custom tint color/strength stay
            // on their own uniforms. Nothing is pre-blended.
            //
            // The alpha-weighting that used to live here is gone with it: it existed
            // to stop a 15%-opacity white sheen being painted as if it were solid
            // white, and _samplePodColor() now resolves that sheen to the color it
            // actually composites to on screen, so the base color needs no further
            // correction. entry.baseAlpha survives purely as "did we resolve a real
            // color at all" — a pod we could not sample opts out with strength 0
            // rather than contributing an invented color.
            let hasBase = !!(entry && entry.baseAlpha > 0.02);
            let base = hasBase ? entry.baseColor : this._tintColorArray;
            // [FIX-9] Weight the base layer by the pod's own COVERAGE.
            //
            // [FIX-8] removed the alpha weighting entirely on the grounds that
            // _samplePodColor() already returns "the color the pod composites to on
            // screen". That holds only while the ancestry actually terminates in
            // something opaque. Adwaita's `.popup-menu-content` is `#36363a` (fully
            // opaque), so _compositeOverAncestors() always reaches coverage 1.0
            // there and the distinction never mattered — but mactahoe's
            // `.quick-settings { background: none }` overrides that very rule, so
            // under mactahoe the walk runs out of ancestors while still
            // see-through and the coverage stays at the pod's own alpha.
            //
            // _compositeOverAncestors() then UN-PREMULTIPLIES before returning, so
            // for a standalone `.quick-toggle` under mactahoe:
            //
            //   OFF: rgba(255,255,255,0.15) -> {r:1, g:1, b:1, a:0.15}
            //   ON:  #ffffff                -> {r:1, g:1, b:1, a:1.00}
            //
            // i.e. the RGB is pure white in BOTH states and the only thing that
            // changed is the alpha that [FIX-8] discarded — exactly the reported
            // "the base color doesn't follow ON/OFF under mactahoe". (Adwaita
            // works because its two states differ in RGB: a gray sheen vs the
            // accent color.)
            //
            // Multiplying the strength by the coverage restores the distinction
            // without reintroducing what [FIX-8] actually fixed: the base color and
            // the custom tint color remain independent shader layers with
            // independent strengths; this only scales the base layer by how much
            // paint the pod genuinely contributes. It is a no-op wherever the
            // ancestry is opaque, i.e. for every Adwaita pod.
            let baseStrength = hasBase ? this._toggleBaseStrength * entry.baseAlpha : 0.0;
            regions.push({
                x: regionX, y: regionY, w: regionW, h: regionH,
                tintR: base[0], tintG: base[1], tintB: base[2],
                baseStrength,
            });
            minX = Math.min(minX, regionX);
            minY = Math.min(minY, regionY);
            maxX = Math.max(maxX, regionX + regionW);
            maxY = Math.max(maxY, regionY + regionH);
        }
        // [FIX-6] Structural changes (the grid re-allocating around a submenu
        // that just opened or closed, a toggle being added/removed) can leave a
        // pod visible-but-not-yet-allocated for a frame, which used to yield an
        // empty region set and hide the glass outright for that one frame — a
        // visible blink. Geometry here is read at BEFORE_REDRAW, i.e. before the
        // pending relayout runs, so being one frame behind a structural change
        // is expected rather than exceptional. Ride out such a gap by re-using
        // the last good region set for a couple of frames instead of blinking
        // out; a genuinely closing menu is already caught by the `mapped` check
        // at the top of this function, and the grace window is bounded so the
        // glass can never linger over toggles that really are gone.
        if (regions.length === 0) {
            let reused = this._takeLastRegions();
            if (!reused) {
                this.bgActor.hide();
                return;
            }
            regions = reused.regions;
            minX = reused.minX;
            minY = reused.minY;
            maxX = reused.maxX;
            maxY = reused.maxY;
        }
        else {
            this._lastGoodRegions = { regions, minX, minY, maxX, maxY };
            this._regionGraceFrames = 0;
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
        // [FIX-9] TOGGLE_GLASS_OVERLAY_OPACITY is 1.0, not 0.7.
        //
        // The 0.7 came from [FIX-2], back when bgActor painted structurally ON
        // TOP of the real panel: dialing it down was the only way to let the
        // real toggles' sharp icons/labels show back through. [FIX-STRUCTURAL-3]
        // then inverted the structure — the glass host is now animActor's
        // BOTTOM-most child (re-asserted every frame by the
        // set_child_below_sibling() call at the top of this function), so every
        // real toggle already paints ON TOP of the glass for free. The 0.7 kept
        // being applied anyway, and all it did was make the glass 30%
        // see-through.
        //
        // That leak was invisible under Adwaita, whose `.popup-menu-content` is
        // an opaque `#36363a` — the 30% showing through is just dark panel. But
        // mactahoe overrides that rule with `.quick-settings { background: none }`,
        // leaving the panel body fully transparent, so the 30% showing through
        // is the raw, UNBLURRED desktop. glass.frag's own output is opaque
        // inside a region (`float alpha = insideMask;`), and global._lgGlass
        // confirmed the blur pipeline itself is healthy (blurResult 960x540, not
        // null) — so this actor opacity was the entire reason the toggles looked
        // like they had a sharp background and no blur under mactahoe only.
        const TOGGLE_GLASS_OVERLAY_OPACITY = 1.0;
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
            // [FIX-6] NOT set_position(monitorX, monitorY) — that is Background
            // mode's placement, where bgActor is a uiGroup child. Here bgActor
            // hangs off animActor, so re-apply the counter-transformed position
            // computed at the top of this function; see the [FIX-6] note there.
            this.bgActor.set_position(bgPosX, bgPosY);
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
