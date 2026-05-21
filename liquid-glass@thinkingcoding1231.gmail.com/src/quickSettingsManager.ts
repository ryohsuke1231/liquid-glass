// src/quickSettingsManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import Gio from 'gi://Gio';
import { UnpickableClone } from './utils.js';

// ========== Configuration Parameters ==========

// Transparent padding outside the glass area. 
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;

// How much larger the glass background should be compared to the actual menu UI.
// const GLASS_EXPAND = 12;   

// Distance to shift the entire menu downwards to avoid overlapping with the top panel.
// const MENU_Y_OFFSET = GLASS_EXPAND + 5;  

// Adaptive text color flags
// const ENABLE_ADAPTIVE_TEXT_COLOR = false;
const SAMPLE_PER_ELEMENT = false;
// const SAMPLE_INTERVAL_MS = 400; // How often to resample colors while the menu is open (in milliseconds)

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
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;
  private bgActor: St.Widget | null;
  private blurEffect: Shell.BlurEffect | null;
  private effect: LiquidEffect | null;
  private bgClone: Clutter.Clone | null;
  private _isEffectActive: boolean;
  private windowClonesContainer: Clutter.Actor | null;
  private fboContainer: Clutter.Actor | null;
  private overviewCloneContainer: Clutter.Actor | null;
  private _windowClones: Map<Clutter.Actor, Clutter.Clone>;
  private _overviewClone: Clutter.Clone | null;
  private _appDisplayClone: Clutter.Clone | null;
  private _searchClone: Clutter.Clone | null;
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
  private clipBox: St.Widget | null = null;
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _cornerRadius: number = 0;

  constructor(extensionPath: string, settings: Gio.Settings) {
    this.extensionPath = extensionPath;
    this._settings = settings;

    // Target the main container of the Date/Calendar menu
    this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
    this.menu = Main.panel.statusArea.quickSettings.menu;

    // Target for animations and visual offsets (The inner content)
    this.animActor = Main.panel.statusArea.quickSettings.menu.box;

    this.bgActor = null;
    this.blurEffect = null;
    this.effect = null;

    this.bgClone = null;
    this.windowClonesContainer = null;
    this.fboContainer = null;

    // Map to keep track of active windows and their corresponding clone actors.
    this._windowClones = new Map();

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
    this._isEffectActive = false;

    this.overviewCloneContainer = null;
    this._overviewClone = null;
    this._appDisplayClone = null;
    this._searchClone = null;

    this.buttonAlpha = 0.8;
    this._buttonTimerId = 0;
    this._styledButtons = new Map();
    this._buttonSignalIds = new Map();
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

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
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
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
    if (!this.targetActor || !this._hasAutoRefreshed)
      return;

    this.targetActor.translation_y = this._menuYoffset;
    this.targetActor.translation_x = this._menuXoffset;
  }

  // 追加: 設定の動的反映
  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // ON/OFF切り替え
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
      if (this.blurEffect) {
        this.blurEffect.radius = this._settings.get_int('quick-settings-blur-radius');
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
  }

  _applyClassStyles() {
    if (!this.targetActor) return;
    if (!this._hasStyleClass(this.targetActor, 'liquid-glass-transparent')) this.targetActor.add_style_class_name('liquid-glass-transparent');
    if (!this._hasStyleClass(this.animActor, 'liquid-glass-transparent')) this.animActor.add_style_class_name('liquid-glass-transparent');

    if (!this._hasStyleClass(this.animActor, 'liquid-glass-qs-root')) this.animActor.add_style_class_name('liquid-glass-qs-root');
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

    // Remove default GNOME styling and make the background transparent
    /*
    this.targetActor.add_style_class_name('liquid-glass-transparent');
    this.animActor.add_style_class_name('liquid-glass-transparent');
    */

    // this.animActor.add_style_class_name('liquid-glass-qs-root');

    // this.animActor.add_style_class_name('liquid-glass-menu-root');

    // Shift the menu down to prevent it from clipping into the top bar
    this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
    this._menuXoffset = this._settings.get_int('quick-settings-x-offset');

    this._glassExpand = this._settings.get_int('quick-settings-glass-expand');

    this._adaptiveConfig = {
      ...AdaptiveContrastConfig,
      enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
      samplePerElement: SAMPLE_PER_ELEMENT,
      sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
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

    this.fboContainer = new Clutter.Actor();
    this.clipBox.add_child(this.fboContainer);

    // Set pivot points for scaling. 
    // The menu scales from the top-center (0.5, 0.0)
    // this.animActor.set_pivot_point(0.5, 0.0);
    this.animActor.set_pivot_point(0.5, 0.0); // Scale from top-left to match the background actor's coordinate system

    // bgActor scales from the top-left (0.0, 0.0) because we manually sync its exact coordinates
    this.bgActor.set_pivot_point(0.0, 0.0);

    // Insert the custom background *underneath* the actual menu UI
    let menuParent = this.menu.actor.get_parent();
    if (menuParent) {
      menuParent.insert_child_below(this.bgActor, this.menu.actor);
    } else {
      // Fallback: If it has no parent yet, add it directly to the UI group
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    let blurRadius = this._settings.get_int('quick-settings-blur-radius');
    let tintColorStr = this._settings.get_string('quick-settings-tint-color');
    let tintStrength = this._settings.get_double('quick-settings-tint-strength');
    this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');

    // Apply native GNOME blur to the internal clipBox (which contains the clones)
    this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
    this.fboContainer.add_effect(this.blurEffect);

    // Apply our custom GLSL liquid shader to the outer background actor
    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);

    // Tell the shader about the padding so it calculates refraction coordinates correctly
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...this._hexToColorArray(tintColorStr)); // Pure transparent base
    this.effect.setTintStrength(tintStrength); // Subtle tint strength to enhance the glass look without overpowering the background
    this.effect.setIsDock(false);
    this.bgActor.add_effect(this.effect);

    this.bgActor.show();

    // Helper functions to hook into GNOME's render pipeline
    const laterAdd = (laterType: Meta.LaterType, callback: GLib.SourceFunc) => {
      return global.compositor?.get_laters?.().add(laterType, callback)
    };

    const laterRemove = (id: number) => {
      if (!id) return;
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(id);
    };

    // Hook into the frame right before it is painted to the screen
    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;

    // Function to create clones of the desktop wallpaper and all visible windows
    // This is necessary because GNOME cannot blur content behind an overlay popup directly
    let buildClones = () => {
      if (!this.bgActor) return;

      // 1. ISOLATED CLEANUP
      // Wrap the destroy call in a helper function so one failure doesn't halt the rest
      const safeDestroy = (actorRef: any) => {
        if (actorRef) {
          try {
            actorRef.destroy();
          } catch (e) {
            // C object was already disposed, ignore safely.
          }
        }
      };

      // Clean up old clones independently
      safeDestroy(this.bgClone);
      this.bgClone = null;

      safeDestroy(this.windowClonesContainer);
      this.windowClonesContainer = null;

      safeDestroy(this.overviewCloneContainer);
      this.overviewCloneContainer = null;

      // 2. CREATION WITH LIFECYCLE TRACKING
      // Clone the desktop background and track its destruction
      this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
      this.bgClone.connect('destroy', () => { this.bgClone = null; });
      this.fboContainer?.add_child(this.bgClone);

      // Create and track overview clone container
      this.overviewCloneContainer = new Clutter.Actor();
      this.overviewCloneContainer.connect('destroy', () => { this.overviewCloneContainer = null; });
      this.fboContainer?.add_child(this.overviewCloneContainer);

      // Create and track window clones container
      this.windowClonesContainer = new Clutter.Actor();
      this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
      this.fboContainer?.add_child(this.windowClonesContainer);

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
        let clone = new UnpickableClone({ source: w });
        let [parentX, parentY] = this.windowClonesContainer.get_transformed_position();
        clone.set_position(w.x - parentX, w.y - parentY);
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

    if (this._hasAutoRefreshed === undefined) {
      this._hasAutoRefreshed = false;
    }
    this._signals = [];

    // Handle the first open as a plain GNOME quick settings open; apply custom behavior only afterwards.
    this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen: boolean) => {
      if (isOpen) {
        if (this.bgActor) {
          let currentMenuParent = this.targetActor.get_parent();
          if (currentMenuParent && this.bgActor.get_parent() !== currentMenuParent) {
            let oldParent = this.bgActor.get_parent();
            if (oldParent) oldParent.remove_child(this.bgActor);
            currentMenuParent.insert_child_below(this.bgActor, this.targetActor);
          }
        }
        if (!this._hasAutoRefreshed) {
          this._hasAutoRefreshed = true;
          return;
        }

        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
        startFrameSync();
        this._startAdaptiveColorSampling(true); // Skip animations on the first open for instant feedback
        this._startButtonAlphaSampling();
        this._startAnimation(1);
        return;
      }

      this._applyClassStyles();
      this._applyMenuOffsets();

      if (!this._hasAutoRefreshed)
        return;

      // stopFrameSync();
      this._stopAdaptiveColorSampling();
      this._stopButtonAlphaSampling();
      this._startAnimation(0);
    });

    // メニューの表示状態（mapped）が変わった時のシグナルを監視
    this._signals.push({
      target: this.menu.actor,
      id: this.menu.actor.connect('notify::mapped', () => {
        // mapped が false になった ＝ 完全に画面から消えた（hideされた）
        if (!this.menu.actor.mapped) {
          // ここで初めて描画・同期ループを止める
          stopFrameSync();

          // 念押しで確実にお掃除しておく
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
    if (this.targetActor.mapped && this._hasAutoRefreshed) {
      startFrameSync();
    }
  }

  // 追加: UIクローンの位置・サイズ同期用メソッド
  _syncActorProperties(source, clone: Clutter.Clone) {
    if (!source || !clone) return;

    try {
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
    } catch (e) {
      // The C-level actor was destroyed by GNOME Shell, but JS hasn't caught up yet.
      // Catching this prevents the "already disposed" critical crash.
    }
  }

  // Calculates and synchronizes the position/size of the glass background every frame
  _syncGeometry() {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) {
      if (this.bgActor && this.bgActor.visible) {
        this.bgActor.hide();
      }
      return;
    }

    if (!this.bgActor.visible) {
      this.bgActor.show();
    }
    if (!this._enableAnimation) {
      // this.bgActor.opacity = Math.min(this.targetActor.opacity, this.animActor.opacity);
      if (this.targetActor !== null) this.bgActor.opacity = this.targetActor.get_first_child()?.opacity ?? 255;
    }

    let [inW, inH] = this.animActor.get_size();
    let [outW, outH] = this.targetActor.get_size();

    inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
    inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
    // let [scaleX, scaleY] = this.animActor.get_scale();

    let [scaleX, scaleY] = this.animActor.get_scale();

    if (!this._enableAnimation) {
      // GNOMEデフォルトアニメーション時（enableanimation = false）
      // targetActor(BoxPointer) の直下にある「透明なラッパー(St.Bin)」がアニメーションの実体
      let gnomeAnimContainer = this.targetActor.get_first_child();

      if (gnomeAnimContainer) {
        // 真犯人のリアルタイムなスケール値を取得（Clutter.ease によって毎フレーム書き換わっている値）
        let gnomeScaleX = gnomeAnimContainer.scale_x;
        let gnomeScaleY = gnomeAnimContainer.scale_y;

        scaleX *= gnomeScaleX;
        scaleY *= gnomeScaleY;
      }
    } else {
      // 独自アニメーション時は targetActor 自体のスケール（通常は1.0）を掛けるだけ
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
        /*
        let buttonActor = Main.panel.statusArea.quickSettings.actor;
        let [btnX, btnY] = buttonActor.get_transformed_position();
        let [btnW, btnH] = buttonActor.get_size();
   
        if (!Number.isNaN(btnX) && !Number.isNaN(btnY)) {
            // Assume the menu opens centered directly below the clock button
            animAbsX = btnX + (btnW / 2) - (w / 2);
            animAbsY = btnY + btnH + (this._menuYoffset ?? 0);
        } else {
            // Ultimate fallback: Just place it in the top-center of the primary monitor
            let monitor = Main.layoutManager.primaryMonitor;
            if (monitor) {
                animAbsX = (monitor.width / 2) - (w / 2);
                animAbsY = (Main.panel.height || 27) + (this._menuYoffset ?? 0);
            }
        }
        */
        let monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
          animAbsX = (monitor.width / 2) - (w / 2);
          animAbsY = (Main.panel.height || 27) + (this._menuYoffset ?? 0);
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
        this.clipBox?.set_size(bgW, bgH);
        this.clipBox?.set_position(0, 0);

        // Update the shader with the new resolution
        this.effect?.setResolution(bgW, bgH);

        this._lastBgW = bgW; this._lastBgH = bgH;
        this._lastBgX = bgX; this._lastBgY = bgY;
      }

      // Keep inverse offset synced every frame so cloned content does not move with animations.
      if (this.fboContainer) {
        let monitor = this._getMenuMonitorGeometry();
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let monitorW = Math.max(1, monitor?.width ?? 1);
        let monitorH = Math.max(1, monitor?.height ?? 1);

        let fboOffsetX = bgX - monitorX;
        let fboOffsetY = bgY - monitorY;
        this.fboContainer.set_position(-fboOffsetX, -fboOffsetY);
        this.fboContainer.set_size(monitorW, monitorH);
      }
    }

    if (this.effect && typeof this.effect.setCornerRadius === 'function') {
      // 縦横のスケールのうち小さい方を採用し、角丸が潰れないようにする
      let currentScale = Math.min(scaleX, scaleY);
      this.effect.setCornerRadius(this._cornerRadius * currentScale);

      if (typeof this.effect.setAnimationScale === 'function') {
        this.effect.setAnimationScale(currentScale);
      }
    }

    // Apply a negative offset to the clones inside the clipBox.
    // This ensures the cloned background matches the real desktop coordinates perfectly,
    // even while the menu is scaling and moving around.
    if (this.bgClone && this.windowClonesContainer && !Number.isNaN(bgX) && !Number.isNaN(bgY)) {
      this.bgClone.set_position(0, 0);
      this.windowClonesContainer.set_position(0, 0);

      let monitor = this._getMenuMonitorGeometry();
      let monitorW = Math.max(1, monitor?.width ?? 1);
      let monitorH = Math.max(1, monitor?.height ?? 1);
      this.bgClone.set_size(monitorW, monitorH);

      if (this.overviewCloneContainer) {
        this.overviewCloneContainer.set_position(0, 0);
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
          try {
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible) continue;

            activeWindows.add(w);

            let clone: Clutter.Clone | undefined;
            if (!this._windowClones.has(w)) {
              // Create a clone for newly opened windows.
              clone = new UnpickableClone({ source: w });
              this.windowClonesContainer.add_child(clone);
              this._windowClones.set(w, clone);
            } else {
              // Retrieve existing clone.
              clone = this._windowClones.get(w);
            }

            // Keep the position synchronized with the real window.
            let [parentX, parentY] = this.windowClonesContainer.get_transformed_position();
            if (clone) clone.set_position(w.x - parentX, w.y - parentY);

            // Update the Z-index dynamically to reflect window focus changes.
            if (clone) this.windowClonesContainer.set_child_at_index(clone, zIndex);
            zIndex++;
          } catch (e) {
            continue; // The window might have been closed or changed state during iteration, just skip it.
          }
        }
      } else {
        // --- Overview時 ---
        this.bgClone.show();
        let controls = Main.overview._overview?._controls;

        if (controls) {
          if (controls._workspacesDisplay) {
            if (!this._overviewClone) {
              this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
              this.overviewCloneContainer?.add_child(this._overviewClone);
            }
            this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
          }
          if (controls._appDisplay) {
            if (!this._appDisplayClone) {
              this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
              this.overviewCloneContainer?.add_child(this._appDisplayClone);
            }
            this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
          }
          if (controls._searchController && controls._searchController.actor) {
            if (!this._searchClone) {
              this._searchClone = new UnpickableClone({ source: controls._searchController.actor });
              this.overviewCloneContainer?.add_child(this._searchClone);
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
  _hasStyleClass(actor: Clutter.Actor, className: string) {
    return actor instanceof St.Widget &&
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

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
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
  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false) {
    if (!actor || typeof actor.set_style !== 'function') return;

    if (!this._styledActors.has(actor)) {
      let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
      // if (origStyle) this._styledActors.set(actor, origStyle);
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
      isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
    }
    // Save the target color to prevent redundant animation triggers for the same color.
    // if (actor._currentTargetColor === color) return;
    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    // Kick off the color transition animation!
    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
  }

  // Removes all dynamically applied adaptive text color styles and stops related animations
  _clearAdaptiveStyles() {
    // 1. 変更履歴 (styledActors) から元の状態を復元する
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

        // 修正: 存在しない remove_style() を削除し、元のスタイル(またはnull)をセット
        actor.set_style(originalStyle || null);
      }
    }
    this._styledActors.clear();

    // 2. 念のため、現在DOM上に存在するターゲットの色も強制クリア（フェイルセーフ）
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
    if (!colorMap || colorMap.size === 0)
      return;

    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations);
    }
  }

  // Starts the timer for periodically sampling contrast and updating adaptive text colors
  _startAdaptiveColorSampling(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled)
      return;

    this._updateAdaptiveTextColors(skipAnimations);

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
        console.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  // Converts a hexadecimal color code string to an RGB object.
  _hexToRgb(hex: string) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  // Converts RGB numerical values to a hexadecimal color string.
  _rgbToHex(r: number, g: number, b: number) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean, durationMs = 380, skipAnimations = false) {
    if (!actor || Object.keys(actor).length === 0) return;

    // Cancel any existing color tween if running (handles mid-transition target changes).
    if (actor._colorTweenId) {
      GLib.source_remove(actor._colorTweenId);
      actor._colorTweenId = undefined;
    }

    // --- Retrieve the "actual physical color" currently displayed on screen ---
    // This allows smooth transitions starting directly from the default theme colors.
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color

    let targetRgb = this._hexToRgb(targetHexColor);

    // 無効状態なら透明度を50%(0.5)にし、有効なら100%(1.0)にする
    let targetAlpha = isInsensitive ? 0.5 : 1.0;
    let startAlpha = startColor.alpha / 255.0; // Clutter.Colorのalphaは0〜255で返る

    if (skipAnimations) {
      let alphaStr = targetAlpha.toFixed(3);
      let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
      actor.set_style(`color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
      return;
    }

    let startTime = GLib.get_monotonic_time();
    // let durationMs = 380; // Animation duration in milliseconds

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
        actor._colorTweenId = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Recursively collect all St.Button elements and quick-toggle containers
  _findAllButtons(actor: Clutter.Actor, foundButtons: Clutter.Actor[] = []) {
    if (!actor) return foundButtons;

    let isQuickSlider = false;
    let isToggleContainer = false;
    let isButton = actor instanceof St.Button;

    // actorがSt.Widget（CSSクラスを持てるUI要素）である場合のみスタイル判定を行う
    if (actor instanceof St.Widget) {
      isQuickSlider = actor.has_style_class_name('quick-slider');
      isToggleContainer = actor.has_style_class_name('quick-toggle');
    }

    // Collect visible St.Button elements and quick-toggle containers (for split buttons)
    if (actor.visible && !isQuickSlider) {
      if (isButton || isToggleContainer) {
        foundButtons.push(actor);
      }
    }

    // Recursively traverse children
    let children = typeof actor.get_children === 'function' ? actor.get_children() : [];
    for (let i = 0; i < children.length; i++) {
      this._findAllButtons(children[i], foundButtons);
    }

    return foundButtons;
  }

  // Helper function to safely update a single button without traversing the whole menu
  _updateSingleButtonAlpha(button: CustomBannerActor, targetAlpha: number) {
    if (!button || button._isUpdatingAlpha) return;
    button._isUpdatingAlpha = true;

    // Temporarily clear inline style to fetch the base theme background
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
            let newStyle = origStyle ? `${origStyle} background-color: transparent !important;` : `background-color: transparent !important;`;
            button.set_style(newStyle);
            button._isUpdatingAlpha = false;
            return; // Exit early since we made the parent transparent
          }
        }

        // FIX 2: If the button is completely transparent by default (like power/lock buttons), keep it transparent.
        if (bgColor.alpha === 0) {
          // Do nothing, leaves it as origStyle (which is already set above)
        } else {
          // Apply target alpha for normally visible buttons
          let rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
          let newStyle = origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`;
          button.set_style(newStyle);

          // Ensure the parent toggle container is also updated dynamically.
          // If a child button changes state, we must force the parent to re-evaluate its transparency.
          let parent = typeof button.get_parent === 'function' ? button.get_parent() : null;
          if (parent && parent instanceof St.Widget && parent.has_style_class_name('quick-toggle')) {
            // if (parent && parent.has_style_class_name && parent.has_style_class_name('quick-toggle')) {
            // Safe to call recursively since _isUpdatingAlpha protects from infinite loops
            this._updateSingleButtonAlpha(parent as CustomBannerActor, targetAlpha);
          }
        }
      }
    }

    button._isUpdatingAlpha = false;
  }

  // Main initialization and polling loop
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

        // CRITICAL FIX: Removed 'style-changed'. 
        // calling set_style() triggers 'style-changed', which caused the infinite crash loop!

        this._buttonSignalIds.set(button, signalIds);
      }
      // Apply style safely
      this._updateSingleButtonAlpha(button as unknown as CustomBannerActor, targetAlpha);
    }
  }

  // サンプリングタイマーの開始
  _startButtonAlphaSampling() {
    this._updateButtonAlpha(); // 初回実行

    if (this._buttonTimerId !== 0) return;

    // イベント駆動と併用するため、間隔は長めの400msや1000msで十分です
    const intervalMs = 400;

    this._buttonTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      intervalMs,
      () => {
        if (!this.menu?.isOpen) {
          this._buttonTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._updateButtonAlpha();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  // サンプリングタイマーの停止
  _stopButtonAlphaSampling() {
    if (this._buttonTimerId !== 0) {
      GLib.source_remove(this._buttonTimerId);
      this._buttonTimerId = 0;
    }
  }

  // 拡張機能無効時などに元に戻す処理
  _clearButtonStyles() {
    this._stopButtonAlphaSampling();
    if (this._buttonSignalIds) {
      for (const [button, signalIds] of this._buttonSignalIds.entries()) {
        // ボタンがまだメモリ上に存在しているか確認
        if (button) {
          for (const id of signalIds) {
            try {
              button.disconnect(id);
            } catch (e) {
              // ボタンが既に破棄されていた場合などのエラーを無視する
            }
          }
        }
      }
      this._buttonSignalIds.clear();
    }
    for (const [button, originalStyle] of this._styledButtons.entries()) {
      if (button && button instanceof St.Widget && typeof button.set_style === 'function') {
        button.set_style(originalStyle || null);
        // delete button._isUpdatingAlpha;
      }
    }
    this._styledButtons.clear();
  }

  // Handles the custom bounce/spring physics when the menu opens or closes
  _startAnimation(targetValue: number) {
    if (this._tickId !== 0) {
      GLib.source_remove(this._tickId);
      this._tickId = 0;
    }

    // If animation is disabled, just hide the menu and exit
    if (!this._enableAnimation) {
      if (this.bgActor) {
        this.bgActor.remove_all_transitions();
        this.bgActor.opacity = 255;
        this.bgActor.set_scale(1.0, 1.0);

        // 独自アニメーション（スケール変更など）の残骸をリセットし、GNOMEデフォルトの動作に任せる
        if (this.animActor) {
          // this.animActor.remove_all_transitions();
          this.animActor.set_scale(1.0, 1.0);
          this.animActor.opacity = 255;
        }
      }
      return;
    }

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
        let s: number, p: number;

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

        let currentScale: number;
        let opacity: number;

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
        /*
        if (this.effect && typeof this.effect.setCornerRadius === 'function') {
          let baseRadius = this._settings.get_double('quick-settings-corner-radius');
          this.effect.setCornerRadius(baseRadius * currentScale);
          if (typeof this.effect.setAnimationScale === 'function') {
            this.effect.setAnimationScale(currentScale);
          }
        }
        */

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
            // this.animActor.translation_x = 0;
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
    this._clearButtonStyles();

    // Disconnect all event listeners safely
    for (let sig of this._signals) {
      try {
        if (sig && sig.id) sig.target.disconnect(sig.id);
      } catch (e) { }
    }
    this._signals = [];

    // _applyEffect内で登録したアニメーションシグナルも解除する（多重登録防止）
    if (this._animSignalId) {
      try {
        this.menu.disconnect(this._animSignalId);
      } catch (e) { }
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

      // Revert UI shifts and forced states
      this.animActor.translation_x = 0;
      this.animActor.translation_y = 0;
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.opacity = 255;
    }

    // Revert UI shifts and forced states when extension is disabled
    this.targetActor.translation_y = 0;
    this.targetActor.translation_x = 0;
    // this.targetActor.margin_top = 0;
    this.targetActor.set_scale(1.0, 1.0);
    this.targetActor.opacity = 255;

    if (this.menu.actor) {
      this.menu.actor.opacity = 255;
      this.menu.actor.translation_x = 0;
      this.menu.actor.translation_y = 0;

      // If the menu is currently open, forcefully close it 
      // without animations to reset GNOME's internal state
      if (this.menu.isOpen) {
        this.menu.close(false);
      }
    }

    if (this.effect) {
      this.effect.cleanup();
      this.effect = null;
    }

    // Destroy all injected actors and clones
    if (this.bgActor) {
      this.bgActor.destroy();
      this.bgActor = null;
    }

    this.blurEffect = null;
    this.bgClone = null;
    this.fboContainer = null;
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
