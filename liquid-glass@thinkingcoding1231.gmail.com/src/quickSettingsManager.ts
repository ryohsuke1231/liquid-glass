// src/quickSettingsManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import Gio from 'gi://Gio';
import {
  UnpickableActor,
  UILayerSampler,
  WindowCloneManager,
} from './utils.js';

import { Logger } from './logger.js';

// ========== Configuration Parameters ==========

// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;

// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
  _currentInsensitiveState?: boolean;
  _isUpdatingAlpha?: boolean;
}
// ==============================================

export class QuickSettingsManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;

  private bgActor: Clutter.Actor | null;
  private liquidBox: Clutter.Actor | null = null;
  private _cloneContainer: Clutter.Actor | null = null;
  private effect: LiquidEffect | null;

  private _windowCloneManager: WindowCloneManager | null = null;
  private _uiSampler: UILayerSampler | null = null;

  // Cached monitor dimensions for change detection
  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _isEffectActive: boolean;
  private buttonAlpha: number;
  private _buttonTimerId: number;
  private _styledButtons: Map<Clutter.Actor, string>;
  private _buttonSignalIds: Map<Clutter.Actor, number[]>;
  private _signals: { target: any, id: number }[];
  private _animSignalId: number = 0;
  private _frameSyncId: number;
  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;

  // Spring physics parameters
  private _springScale: Spring;
  private _springPos: Spring;
  private _springStiffness: number;
  private _springDamping: number;
  private _springMass: number;

  private _enableAnimation: boolean;

  private _tickId: number;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _hasAutoRefreshed: boolean;
  private _settingsSignals: number[];
  private _adaptiveConfig!: typeof AdaptiveContrastConfig;

  // Used in _syncGeometry
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _cornerRadius: number = 0;
  private _animationInterval: number = 16;

  // Flag to forcefully move submenus using translation_x, translation_y
  private _enableSubmenuFix: boolean = false;

  private _cachedSubmenus: Clutter.Actor[] | null = null; // Cache of submenus

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
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
    if (!this._settings) return;
    this._bindSettings();

    // Setup spring parameters
    this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
    this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
    this._springDamping = this._settings.get_double('quick-settings-spring-damping');
    this._springMass = this._settings.get_double('quick-settings-spring-mass');
    this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);

    if (this._settings.get_boolean('enable-quick-settings-glass')) {
      this._applyEffect();
    }
  }

  // Utility: Convert HEX color string to normalized RGB array
  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
      return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _getMenuMonitorGeometry() {
    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
  }

  _applyMenuOffsets() {
    if (!this.targetActor) return;
    this.targetActor.translation_y = this._menuYoffset;
    this.targetActor.translation_x = this._menuXoffset;
  }

  // Dynamically apply settings changes
  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // ON/OFF toggle
    connectSetting('enable-quick-settings-glass', () => {
      let enabled = this._settings.get_boolean('enable-quick-settings-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('enable-quick-settings-animation', () => {
      this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
    });

    connectSetting('quick-settings-spring-stiffness', () => {
      this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('quick-settings-spring-damping', () => {
      this._springDamping = this._settings.get_double('quick-settings-spring-damping');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('quick-settings-spring-mass', () => {
      this._springMass = this._settings.get_double('quick-settings-spring-mass');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('quick-settings-animation-interval-ms', () => {
      this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
    });

    connectSetting('quick-settings-tint-color', () => {
      if (this.effect) {
        let colorArray = this._hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
        this.effect.setTintColor(...colorArray);
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
      if (this.effect) {
        this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
        this.effect.setCornerRadius(this._cornerRadius);
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
    if (!this.targetActor) return;
    if (!this._hasStyleClass(this.targetActor, 'liquid-glass-transparent'))
      this.targetActor.add_style_class_name('liquid-glass-transparent');
    if (!this._hasStyleClass(this.animActor, 'liquid-glass-transparent'))
      this.animActor.add_style_class_name('liquid-glass-transparent');
    if (!this._hasStyleClass(this.animActor, 'liquid-glass-qs-root'))
      this.animActor.add_style_class_name('liquid-glass-qs-root');
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

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
    let menuRoot: Clutter.Actor = this.menu.actor;
    while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = menuRoot.get_parent();
      if (!p) break;
      menuRoot = p;
    }

    // Insert bgActor below menuRoot in uiGroup to prevent recursive clone loops
    // Insert the custom background *underneath* the actual menu UI
    if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
    } else {
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
    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);
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
    this._uiSampler = new UILayerSampler(
      this.bgActor,
      this.liquidBox,
      [menuRoot, global.windowGroup, global.window_group],
      this._cloneContainer
    );

    this.bgActor.hide();

    // ── Helper functions for GNOME's render pipeline ──────────────────────────
    const laterAdd = (laterType: Meta.LaterType, callback: GLib.SourceFunc) => {
      return global.compositor?.get_laters?.().add(laterType, callback);
    };
    const laterRemove = (id: number) => {
      if (!id) return;
      if (global.compositor?.get_laters) global.compositor.get_laters().remove(id);
    };
    // Hook into the frame right before it is painted to the screen
    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;

    // Clone build: applies mutual liquid-glass exclusions, then delegates to managers
    let buildClones = () => {
      if (!this.bgActor) return;

      if (this._uiSampler) {
        for (let child of Main.layoutManager.uiGroup.get_children()) {
          if (child === this.bgActor) continue;
          let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
            (typeof child.get_children === 'function' &&
              child.get_children().some((c: Clutter.Actor) => c.get_name?.() === 'liquid-box'));
          if (isLiquidBg) this._uiSampler!.addExclusion(child);
        }
      }

      this._windowCloneManager?.rebuildClones();
      this._uiSampler?.rebindSelf();
      this._uiSampler?.refresh();
    };

    // Frame render loop (runs every frame while the menu is mapped)
    let frameTick = () => {
      this._frameSyncId = 0;
      if (!this.bgActor || !this.targetActor.mapped) return GLib.SOURCE_REMOVE;

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

    if (this._hasAutoRefreshed === undefined) this._hasAutoRefreshed = false;
    this._signals = [];

    // Handle the first open as a plain GNOME quick settings open; apply custom behavior only afterwards.
    this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen: boolean) => {
      if (isOpen) {
        this._cachedSubmenus = null; // Reset submenu cache
        if (!this._hasAutoRefreshed) this._hasAutoRefreshed = true;

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

  // ── Geometry synchronisation ────────────────────────────────────────────────
  // Calculates and synchronizes the position/size of the glass background every frame
  // Full-screen FBO approach: bgActor covers the entire monitor, shader is told
  // where the menu lives within that FBO via setGlassGeometry().
  _syncGeometry() {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
      if (this.bgActor && this.bgActor.visible) this.bgActor.hide();
      return;
    }
    if (!this.bgActor.visible) this.bgActor.show();

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
    } else {
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
      } else {
        // Ultimate fallback: Just place it in the top-center of the primary monitor
        let monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
          animAbsX = (monitor.width / 2) - (w / 2);
          animAbsY = (Main.panel.height || 27) + (this._menuYoffset ?? 0);
        } else {
          animAbsX = 0;
          animAbsY = 0;
        }
      }
    } else {
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
        this.bgActor.set_clip(
          localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
          bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
        );

        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

        // Inform shader of full-screen resolution and where the menu lives in the FBO
        this.effect?.setResolution(screenW, screenH);
        this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

        this._lastBgW = bgW; this._lastBgH = bgH;
        this._lastBgX = bgX; this._lastBgY = bgY;
        this._lastScreenW = screenW; this._lastScreenH = screenH;
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
    if (!this.bgActor || !this.effect) return;
    let [width, height] = this.bgActor.get_size();
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      this.effect.setResolution(width, height);
    }
  }

  // Utility function to safely check if an actor has a specific style class
  _hasStyleClass(actor: Clutter.Actor, className: string) {
    return actor instanceof St.Widget && actor.has_style_class_name(className);
  }

  _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
    if (!actor) return targets;
    return this._findAllTextActors(this.menu?.actor);
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    // Collect applicable text or button elements that are currently visible
    if (actor instanceof St.Label || actor instanceof Clutter.Text ||
      actor instanceof St.Button || actor instanceof St.Icon) {
      if (actor.visible) foundActors.push(actor);
    }

    // Recursively scan child elements
    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let i = 0; i < children.length; i++) {
      this._findAllTextActors(children[i], foundActors);
    }
    return foundActors;
  }

  // Initiates the color change for a specific actor
  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false) {
    if (!actor || typeof actor.set_style !== 'function') return;

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

    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
  }

  _clearAdaptiveStyles() {
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
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

    const currentTargets = this._collectAdaptiveTextTargets() as CustomBannerActor[];
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
  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0) return;
    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations);
    }
  }

  // Starts the timer for periodically sampling contrast and updating adaptive text colors
  _startAdaptiveColorSampling(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled) return;
    this._updateAdaptiveTextColors(skipAnimations);
    if (this._adaptiveTimerId !== 0) return;

    this._adaptiveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._adaptiveConfig.sampleIntervalMs,
      () => {
        if (!this.menu?.isOpen) {
          this._adaptiveTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._updateAdaptiveTextColors(false);
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
  _updateAdaptiveTextColors(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight) return;

    const targets = this._collectAdaptiveTextTargets();
    if (targets.length === 0) return;

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

  _hexToRgb(hex: string) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  _rgbToHex(r: number, g: number, b: number) {
    return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean, durationMs = 380, skipAnimations = false) {
    if (!actor || Object.keys(actor).length === 0) return;

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
      if (!actor || Object.keys(actor).length === 0) return GLib.SOURCE_REMOVE;

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

  _findAllButtons(actor: Clutter.Actor, foundButtons: Clutter.Actor[] = []) {
    if (!actor) return foundButtons;

    let isQuickSlider = false;
    let isToggleContainer = false;
    let isButton = actor instanceof St.Button;

    if (actor instanceof St.Widget) {
      isQuickSlider = actor.has_style_class_name('quick-slider');
      isToggleContainer = actor.has_style_class_name('quick-toggle');
    }

    if (actor.visible && !isQuickSlider) {
      if (isButton || isToggleContainer) foundButtons.push(actor);
    }

    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let i = 0; i < children.length; i++) {
      this._findAllButtons(children[i], foundButtons);
    }
    return foundButtons;
  }

  _updateSingleButtonAlpha(button: CustomBannerActor, targetAlpha: number) {
    if (!button || button._isUpdatingAlpha) return;
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
                if (childBg && childBg.alpha > 0) { hasColoredChild = true; break; }
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
        } else {
          // Apply target alpha for normally visible buttons
          let rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
          let newStyle = origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`;
          button.set_style(newStyle);

          // Ensure the parent toggle container is also updated dynamically.
          // If a child button changes state, we must force the parent to re-evaluate its transparency.
          let parent = typeof button.get_parent === 'function' ? button.get_parent() : null;
          if (parent && parent instanceof St.Widget && parent.has_style_class_name('quick-toggle')) {
            this._updateSingleButtonAlpha(parent as CustomBannerActor, targetAlpha);
          }
        }
      }
    }

    button._isUpdatingAlpha = false;
  }

  _updateButtonAlpha() {
    if (!this.menu?.isOpen) return;

    const buttons = this._findAllButtons(this.menu?.actor);
    if (buttons.length === 0) return;

    let targetAlpha = this.buttonAlpha !== undefined ? this.buttonAlpha : 0.5;

    for (let button of buttons) {
      if (!this._styledButtons.has(button)) {
        if (button instanceof St.Widget) {
          let origStyle = typeof button.get_style === 'function' ? button.get_style() : null;
          this._styledButtons.set(button, origStyle || '');
        }

        const updateHandler = () => {
          if (!this.menu?.isOpen) return;
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._updateSingleButtonAlpha(button as CustomBannerActor, targetAlpha);
            return GLib.SOURCE_REMOVE;
          });
        };

        let signalIds: number[] = [];
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
      this._updateSingleButtonAlpha(button as unknown as CustomBannerActor, targetAlpha);
    }
  }

  // Start sampling timer
  _startButtonAlphaSampling() {
    this._updateButtonAlpha();
    if (this._buttonTimerId !== 0) return;

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
            try { button.disconnect(id); } catch (e) { }
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

  _startAnimation(targetValue: number) {
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

    if (this.animActor) this.animActor.remove_all_transitions();
    if (this.bgActor) this.bgActor.remove_all_transitions();

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
        if (dt > 0.033) dt = 0.033;

        let stopped = false;
        let s: number, p: number;

        if (isClosing) {
          // Use a simple exponential decay for closing (faster, no bounce)
          let speed = 15.0;
          this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dt));
          this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dt));
          s = this._springScale.value;
          p = this._springPos.value;
          // Stop animation completely when it's virtually invisible
          if (s < 0.005) { s = 0; p = 0; stopped = true; }
        } else {
          // Use Hooke's law spring physics for opening (creates a nice bounce effect)
          stopped = this._springScale.update(elapsedMs) && this._springPos.update(elapsedMs);
          s = this._springScale.value;
          p = this._springPos.value;
          // Magnet effect: Snap to exactly 1.0 when the bounce is almost settled.
          // This prevents indefinite micro-stuttering at the end of the animation.
          if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._springScale.velocity) < 0.03) {
            s = 1.0; p = 1.0; stopped = true;
          }
        }

        let currentScale: number;
        let opacity: number;

        if (isClosing) {
          // Clamp to 0.001 because scale = 0 crashes Cogl
          currentScale = Math.max(0.001, s);
          // Fade out opacity faster than the scale shrinks (fades between scale 1.0 and 0.3)
          opacity = Math.min(255, Math.max(0, (s - 0.3) / 0.7 * 255));
        } else {
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
    if (!this._enableSubmenuFix || !this.menu?.isOpen || !this.animActor) return;

    // Scan when there's no cached submenus yet
    if (!this._cachedSubmenus) {
      this._cachedSubmenus = [];
      let deepScan = (actor: Clutter.Actor) => {
        if (!actor) return;
        if (actor instanceof St.Widget) {
          let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
          if (css && css.split(' ').includes('quick-toggle-menu')) this._cachedSubmenus!.push(actor);
        }
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let child of children) deepScan(child);
      };
      deepScan(this.menu.actor);
    }

    let foundMenus: Clutter.Actor[] = this._cachedSubmenus;

    if (foundMenus.length === 0) return;

    // Get the absolute coordinates and size as the parent's base (animActor = the visual bounding box of the menu)
    let [parentAbsX, parentAbsY] = this.animActor.get_transformed_position();
    let [parentW, parentH] = this.animActor.get_size();

    if (Number.isNaN(parentAbsX) || Number.isNaN(parentAbsY) ||
      Number.isNaN(parentW) || Number.isNaN(parentH) ||
      parentW <= 0 || parentH <= 0) return;

    for (let submenu of foundMenus) {
      if (!submenu.mapped || !submenu.visible) continue;

      let [subAbsX, subAbsY] = submenu.get_transformed_position();
      let [subW, subH] = submenu.get_size();

      if (Number.isNaN(subAbsX) || Number.isNaN(subAbsY) ||
        Number.isNaN(subW) || Number.isNaN(subH) ||
        subW <= 0 || subH <= 0) continue;

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

      let findBoundaries = (n: Clutter.Actor) => {
        if (!n || !n.visible || !n.mapped || n === submenu) return;
        if (typeof n.contains === 'function' && n.contains(submenu)) {
          let children = typeof n.get_children === 'function' ? n.get_children() : [];
          for (let child of children) findBoundaries(child);
          return;
        }
        let [, nodeY] = n.get_transformed_position();
        let [nodeW, nodeH] = n.get_size();
        if (Number.isNaN(nodeY) || Number.isNaN(nodeW) || Number.isNaN(nodeH) ||
          nodeH <= 5 || nodeW <= 5) return;

        // Separate and evaluate elements above and below based on the submenu's "center point"
        if (nodeY + (nodeH / 2) < subCenterY) {
          // Elements above: Their bottom edge doesn't cross the submenu center, and are the lowest among them
          if (nodeY + nodeH <= subCenterY && nodeY + nodeH > aboveMaxY) aboveMaxY = nodeY + nodeH;
        } else {
          // Elements below: Their top edge doesn't cross the submenu center, and are the highest among them
          if (nodeY >= subCenterY && nodeY < belowMinY) belowMinY = nodeY;
        }
        let children = typeof n.get_children === 'function' ? n.get_children() : [];
        for (let child of children) findBoundaries(child);
      };

      // Execute boundary scan starting from the direct children of the box (parent container)
      let parentChildren = typeof this.animActor.get_children === 'function' ? this.animActor.get_children() : [];
      for (let child of parentChildren) findBoundaries(child);

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
    let foundMenus: Clutter.Actor[] = this._cachedSubmenus || [];

    if (foundMenus.length === 0) {
      let deepScan = (actor: Clutter.Actor) => {
        if (!actor) return;
        if (actor instanceof St.Widget) {
          let css = actor.get_style_class_name ? actor.get_style_class_name() : '';
          if (css && css.split(' ').includes('quick-toggle-menu')) foundMenus.push(actor);
        }
        let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
        for (let child of children) deepScan(child);
      };
      if (this.menu?.actor) deepScan(this.menu.actor);
    }

    for (let submenu of foundMenus) {
      try { submenu.translation_x = 0; } catch (e) { }
    }

    this._cachedSubmenus = null; // Clear cache
  }

  // ── Effect remove / cleanup ─────────────────────────────────────────────────
  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();
    this._clearButtonStyles();
    this._clearSubmenuFix();

    // Disconnect all event listeners
    for (let sig of this._signals) {
      try { if (sig && sig.id) sig.target.disconnect(sig.id); } catch (e) { }
    }
    this._signals = [];

    if (this._animSignalId) {
      try { this.menu.disconnect(this._animSignalId); } catch (e) { }
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
      if (this.menu.isOpen) this.menu.close(false);
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
  }

  cleanup() {
    for (let sigId of this._settingsSignals) {
      try { this._settings.disconnect(sigId); } catch (e) { }
    }
    this._settingsSignals = [];

    if (!this.targetActor) return;
    this._removeEffect();
  }
}

// A straightforward mathematical implementation of Hooke's Law for spring physics
class Spring {
  private stiffness: number;
  private damping: number;
  private mass: number;
  public value: number;
  public velocity: number;
  public target: number;
  constructor(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
    this.damping = damping;     // Friction (higher = less bounce, settles quicker)
    this.mass = mass;           // Weight of the object

    this.value = 0;             // Current position/scale
    this.velocity = 0;          // Current speed
    this.target = 0;            // Destination value
  }

  updateParams(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
    this.damping = damping;     // Friction (higher = less bounce, settles quicker)
    this.mass = mass;           // Weight of the object
  }

  update(elapsedMs: number) {
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
