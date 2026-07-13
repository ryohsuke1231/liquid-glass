// src/uiManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableClone, UnpickableActor, UILayerSampler, UnpickableWidget, WindowCloneManager } from './utils.js';

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

export class UIManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;
  private bgActor: Clutter.Actor | null;
  private effect: LiquidEffect | null;

  // [CHANGED] Replaced fboContainer / bgClone / windowClonesContainer / overviewCloneContainer
  // and all manual clone maps with WindowCloneManager + UILayerSampler (dockManager pattern).
  private _cloneContainer: Clutter.Actor | null = null;
  private _windowCloneManager: WindowCloneManager | null = null;

  private _signals: { target: any, id: number }[];
  private _animSignalId: number = 0;
  private _frameSyncId: number;
  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;
  private _tickId: number;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _settingsSignals: number[];
  private _isEffectActive: boolean;
  private _adaptiveConfig!: typeof AdaptiveContrastConfig;
  private liquidBox: Clutter.Actor | null = null;
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  // Spring physics parameters
  private _springScale: Spring;
  private _springPos: Spring;
  private _springStiffness: number;
  private _springDamping: number;
  private _springMass: number;

  // SwiftUI Animation parameters
  private _swiftAnimation: boolean = false;
  private _swiftResponse: number = 0.3;
  private _swiftDampingFraction: number = 0.65;

  private _swiftSpringScale: SwiftSpring;
  private _swiftSpringPos: SwiftSpring;

  private _enableAnimation: boolean;

  private _interfaceSettings: Gio.Settings | null = null;
  private _accentColorSignalId: number = 0;

  private _dynamicCssFile: Gio.File | null = null;
  private _cornerRadius: number = 0;

  private _animationInterval: number = 16;
  private _uiSampler: UILayerSampler | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  constructor(extensionPath: string, settings: Gio.Settings) {
    this.extensionPath = extensionPath;
    this._settings = settings;

    // Target the main container of the Date/Calendar menu
    this.targetActor = Main.panel.statusArea.dateMenu.menu.actor as St.Widget;
    this.menu = Main.panel.statusArea.dateMenu.menu;

    // Target for animations and visual offsets (The inner content)
    // @ts-expect-error
    this.animActor = Main.panel.statusArea.dateMenu.menu.box as St.Widget;

    this.bgActor = null;
    this.effect = null;

    this._signals = [];
    this._frameSyncId = 0;

    this._glassExpand = 0;
    this._menuXoffset = 0;
    this._menuYoffset = 0;

    // Custom spring physics parameters for the open/close animation
    this._springScale = new Spring(120, 8, 1.0);
    this._springPos = new Spring(300, 12, 1.0);
    this._springStiffness = 120;
    this._springDamping = 8;
    this._springMass = 1.0;

    this._swiftSpringScale = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);
    this._swiftSpringPos = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);

    this._enableAnimation = false;
    this._tickId = 0;

    this._contrastSampler = new StageContrastSampler();
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._settingsSignals = [];
    this._isEffectActive = false;

    // Listen for the menu opening/closing to trigger our custom physics animation
    this._animSignalId = this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
      if (isOpen) {
        this._startAnimation(1); // Target scale: 1.0 (fully open)
      } else {
        this._startAnimation(0); // Target scale: 0.0 (closed)
      }
    });
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    this._enableAnimation = this._settings.get_boolean('enable-menu-animation');
    this._springStiffness = this._settings.get_double('menu-spring-stiffness');
    this._springDamping = this._settings.get_double('menu-spring-damping');
    this._springMass = this._settings.get_double('menu-spring-mass');
    this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);

    this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
      console.log(`[Liquid Glass] System accent color changed.`);
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._applySystemAccentColor();
        return GLib.SOURCE_REMOVE;
      });
    });

    // 初回実行
    this._applySystemAccentColor();

    if (this._settings.get_boolean('enable-menu-glass')) {
      this._applyEffect();
    }
  }

  private _applySystemAccentColor() {
    if (!this.targetActor) return;

    // 1. 親要素と子要素を作成して、GNOMEテーマが要求する正しい階層を再現
    const parent = new UnpickableWidget({ style_class: 'calendar' });
    const child = new UnpickableWidget({ style_class: 'calendar-day calendar-today' });
    parent.add_child(child);

    // 2. UIグループに追加してスタイルを強制計算させる
    Main.layoutManager.uiGroup.add_child(parent);
    child.ensure_style();

    // 3. 計算済みの色を取得
    const themeNode = child.get_theme_node();
    const bgColor = themeNode.get_background_color();

    // 4. 用が済んだらすぐお掃除
    Main.layoutManager.uiGroup.remove_child(parent);
    parent.destroy();

    // 5. HEXに変換
    const colorStr = this._rgbToHex(bgColor.red, bgColor.green, bgColor.blue);
    console.log(`[Liquid Glass] Set system accent color to ${colorStr}`);

    const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: white !important;
      }
    `;

    try {
      const cacheDir = GLib.get_user_cache_dir();
      const filePath = GLib.build_filenamev([cacheDir, 'liquid-glass-accent.css']);

      GLib.file_set_contents(filePath, cssContent);

      const themeContext = St.ThemeContext.get_for_stage(global.stage);
      const theme = themeContext.get_theme();

      if (this._dynamicCssFile) {
        theme.unload_stylesheet(this._dynamicCssFile);
      }

      this._dynamicCssFile = Gio.File.new_for_path(filePath);
      theme.load_stylesheet(this._dynamicCssFile);

      console.log(`[Liquid Glass] 動的CSSの注入に成功しました。適用色: ${colorStr}`);
    } catch (e) {
      console.log(`[Liquid Glass] 動的CSSの適用に失敗しました: ${e}`);
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
    if (monitorIndex < 0) {
      monitorIndex = Main.layoutManager.primaryIndex;
    }

    return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
  }

  // 設定の動的反映
  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // ON/OFF切り替え
    connectSetting('enable-menu-glass', () => {
      let enabled = this._settings.get_boolean('enable-menu-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('enable-menu-animation', () => {
      this._enableAnimation = this._settings.get_boolean('enable-menu-animation');
    });

    connectSetting('menu-spring-stiffness', () => {
      this._springStiffness = this._settings.get_double('menu-spring-stiffness');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('menu-spring-damping', () => {
      this._springDamping = this._settings.get_double('menu-spring-damping');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('menu-spring-mass', () => {
      this._springMass = this._settings.get_double('menu-spring-mass');
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting('menu-animation-interval-ms', () => {
      this._animationInterval = this._settings.get_int('menu-animation-interval-ms');
    });

    connectSetting('menu-tint-color', () => {
      if (this.effect) {
        let colorArray = this._hexToColorArray(this._settings.get_string('menu-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('menu-tint-strength', () => {
      if (this.effect) {
        this.effect.setTintStrength(this._settings.get_double('menu-tint-strength'));
      }
    });

    connectSetting('menu-blur-radius', () => {
      if (this.effect) {
        this.effect.setBlurRadius(this._settings.get_int('menu-blur-radius'));
      }
    });

    connectSetting('menu-brightness', () => {
      if (this.effect) {
        this.effect.setBrightness(this._settings.get_double('menu-brightness'));
      }
    });

    connectSetting('menu-contrast', () => {
      if (this.effect) {
        this.effect.setContrast(this._settings.get_double('menu-contrast'));
      }
    });

    connectSetting('menu-saturation', () => {
      if (this.effect) {
        this.effect.setSaturation(this._settings.get_double('menu-saturation'));
      }
    });

    connectSetting('menu-corner-radius', () => {
      if (this.effect) {
        this._cornerRadius = this._settings.get_double('menu-corner-radius');
        this.effect.setCornerRadius(this._cornerRadius);
      }
    });

    connectSetting('menu-glass-expand', () => {
      if (this.effect) {
        this._glassExpand = this._settings.get_int('menu-glass-expand');
      }
    });

    connectSetting('menu-x-offset', () => {
      if (this.animActor) {
        this._menuXoffset = this._settings.get_int('menu-x-offset');
        this.animActor.translation_x = this._menuXoffset;
      }
    });

    connectSetting('menu-y-offset', () => {
      if (this.animActor) {
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
    this.animActor.add_style_class_name('liquid-glass-menu-root');

    // Shift the menu to apply user offsets
    this._menuXoffset = this._settings.get_int('menu-x-offset');
    this._menuYoffset = this._settings.get_int('menu-y-offset');
    this.animActor.translation_x = this._menuXoffset;
    this.animActor.translation_y = this._menuYoffset;

    this._glassExpand = this._settings.get_int('menu-glass-expand');
    this._animationInterval = this._settings.get_int('menu-animation-interval-ms');

    this._adaptiveConfig = {
      ...AdaptiveContrastConfig,
      enabled: this._settings.get_boolean('menu-enable-adaptive-text-color'),
      samplePerElement: SAMPLE_PER_ELEMENT,
      sampleIntervalMs: this._settings.get_int('menu-sample-interval-ms'),
    };

    // 1. bgActor: full monitor, no effect — starts 1×1, _syncGeometry expands it immediately
    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');
    this.bgActor.set_size(1.0, 1.0);

    // 2. liquidBox: outer layer — LiquidEffect with built-in dual-Kawase blur
    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name("liquid-box");
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // dummyBreaker: transparent actor to prevent BMS black-screen optimization bug
    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name("optimization-breaker");
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    this.liquidBox.add_child(dummyBreaker);

    // 3. _cloneContainer: explicit sub-container inside liquidBox.
    //    UILayerSampler deposits its _uiClonesContainer here.
    //    WindowCloneManager places bgClone + windowClonesContainer directly in liquidBox.
    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name("clone-container");
    this.liquidBox.add_child(this._cloneContainer);

    // Set pivot points for scaling.
    // The menu scales from the top-center (0.5, 0.0)
    this.animActor.set_pivot_point(0.5, 0.0);
    // bgActor scales from the top-left because we manually sync its exact coordinates
    this.bgActor.set_pivot_point(0.0, 0.0);

    // Find the uiGroup-direct ancestor of the menu actor so we can insert bgActor below it
    let menuRoot: Clutter.Actor = this.menu.actor;
    while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = menuRoot.get_parent();
      if (!p) break;
      menuRoot = p;
    }

    // Insert bgActor below menuRoot in uiGroup to prevent recursive clone loops
    if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
      // Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
      Main.layoutManager.uiGroup.insert_child_above(this.bgActor, Main.layoutManager.panelBox);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    // 4. WindowCloneManager: handles wallpaper clone + window actor clones
    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer);

    // 5. UILayerSampler: handles uiGroup child clones (panels, notifications, overview, etc.)
    //    Exclude menuRoot and window groups to prevent recursive cloning and BMS loops.
    this._uiSampler = new UILayerSampler(
      this.bgActor,
      this.liquidBox,
      [menuRoot, global.windowGroup, global.window_group],
      this._cloneContainer
    );

    let blurRadius = this._settings.get_int('menu-blur-radius');
    let tintColorStr = this._settings.get_string('menu-tint-color');
    let tintStrength = this._settings.get_double('menu-tint-strength');
    let brightness = this._settings.get_double('menu-brightness');
    let contrast = this._settings.get_double('menu-contrast');
    let saturation = this._settings.get_double('menu-saturation');
    this._cornerRadius = this._settings.get_double('menu-corner-radius');

    // Apply our custom GLSL liquid shader to liquidBox (includes built-in dual-Kawase blur)
    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
    this.effect.setTintStrength(tintStrength);
    this.effect.setCornerRadius(this._cornerRadius);
    this.effect.setIsDock(false);
    this.effect.setBrightness(brightness);
    this.effect.setContrast(contrast);
    this.effect.setSaturation(saturation);
    this.effect.setBlurRadius(blurRadius);
    this.liquidBox.add_effect(this.effect);

    // [FIX] Root cause of "the whole screen darkens by a flat amount as soon
    // as the Menu glass toggle is turned on, until the menu is opened once".
    //
    // This used to unconditionally call `this.bgActor.show()` right here,
    // regardless of whether the date menu was open. Showing bgActor makes it
    // paint every frame from that point on (it's a permanent uiGroup child,
    // not parented under the menu itself). But its LiquidEffect uniforms
    // (resolution_x/y, dock_x/y/w/h) only ever get synced to real values
    // inside _syncGeometry(), which only runs once the render loop is
    // started by startFrameSync() below — and that only happens once
    // `this.targetActor.mapped` becomes true, i.e. once the menu is actually
    // opened for the first time.
    //
    // Meanwhile, WindowCloneManager (constructed above) has already inserted
    // a full-monitor-sized background clone into liquidBox, so liquidBox's
    // real on-screen allocation balloons to the monitor's size immediately
    // — well before the menu is ever opened. With bgActor visible but the
    // shader still holding its tiny constructor defaults (resolution ~1x1,
    // dock_w/dock_h = 0), glass.frag's local_pos/box_size math collapses to
    // nearly the same value for every pixel across that much larger real
    // draw area, producing a spatially flat, constant darkening across the
    // entire monitor (scaling with shadow_radius/shadow_intensity) — not an
    // actual out-of-bounds shadow (the shadow's own math is correctly capped
    // at shadow_max_radius; this darkening comes from upstream of it).
    //
    // Fix: keep bgActor hidden until _syncGeometry() has actually run and
    // synced real geometry into the shader. _syncGeometry() itself already
    // shows bgActor once it's safe to do so, and the `notify::mapped`
    // handler above hides it again once the menu closes — so no explicit
    // show() is needed or correct here.
    this.bgActor.hide();

    // Helper functions to hook into GNOME's render pipeline
    const laterAdd = (laterType: Meta.LaterType, callback: GLib.SourceFunc) => {
      return global.compositor?.get_laters?.().add(laterType, callback);
    };

    const laterRemove = (id: number) => {
      if (!id) return;
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(id);
    };

    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;

    // Rebuild clones (called on menu open): delegate entirely to WindowCloneManager + UILayerSampler
    let buildClones = () => {
      if (!this.bgActor) return;

      // _uiSampler が存在する場合のみ除外リストへの追加処理を行う
      if (this._uiSampler) {
        for (let child of Main.layoutManager.uiGroup.get_children()) {
          if (child === this.bgActor) continue;

          // 名前が 'liquid-glass-bg-actor' のもの、または 'liquid-box' を子に持つものを
          // 他のLiquid Glassエフェクトの背景アクターと判定する
          let isLiquidBg = child.name === 'liquid-glass-bg-actor' ||
            (typeof child.get_children === 'function' &&
              child.get_children().some(c => c.name === 'liquid-box'));

          if (isLiquidBg) {
            this._uiSampler.addExclusion(child);
          }
        }
      }

      this._windowCloneManager?.rebuildClones();
      this._uiSampler?.rebindSelf();
      this._uiSampler?.refresh();
    };

    // Render loop: called every frame while the menu is visible
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

    // Clear the cached size whenever the menu opens so it can recalculate
    // based on any new notifications or calendar events
    this._signals.push({
      target: this.menu,
      id: this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
        if (isOpen) {
          this._stableBaseW = undefined;
          this._stableBaseH = undefined;
          startFrameSync();
          this._startAdaptiveColorSampling(true);
        } else {
          this._stopAdaptiveColorSampling();
        }
      })
    });

    // Stop the render loop when the menu is fully hidden (mapped = false)
    this._signals.push({
      target: this.menu.actor,
      id: this.menu.actor.connect('notify::mapped', () => {
        if (!this.menu.actor.mapped) {
          stopFrameSync();

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
      this.bgActor.opacity = this.targetActor.opacity;
    }
    let [inW, inH] = this.animActor.get_size();
    let [outW, outH] = this.targetActor.get_size();
    let [scaleX, scaleY] = this.animActor.get_scale();

    inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
    inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
    scaleX = Number.isNaN(scaleX) ? 1.0 : scaleX;
    scaleY = Number.isNaN(scaleY) ? 1.0 : scaleY;

    scaleX *= this.targetActor.get_scale()[0];
    scaleY *= this.targetActor.get_scale()[1];

    let themeNode = this.animActor.get_theme_node();
    let mL = themeNode ? themeNode.get_margin(St.Side.LEFT) : 0;
    let mR = themeNode ? themeNode.get_margin(St.Side.RIGHT) : 0;
    let mT = themeNode ? themeNode.get_margin(St.Side.TOP) : 0;
    let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

    let marginW = mL + mR;
    let marginH = mT + mB;

    let targetW = Math.round(inW);
    let targetH = Math.round(inH);

    // GNOME Shell Hover Bug Compensation:
    if (Math.abs(inW - outW) <= 2 && marginW > 0) {
      targetW = Math.round(inW - marginW);
      targetH = Math.round(inH - marginH);
    }

    this._stableBaseW = targetW;
    this._stableBaseH = targetH;

    // Multiply by the current animation scale.
    let w = Math.max(1, this._stableBaseW * scaleX);
    let h = Math.max(1, this._stableBaseH * scaleY);

    // Get the absolute position of the inner content actor
    let [animAbsX, animAbsY] = this.animActor.get_transformed_position();

    // Advanced Fallback Logic for NaN Coordinates
    if (Number.isNaN(animAbsX) || Number.isNaN(animAbsY)) {
      if (this._lastValidAnimAbsX !== undefined && this._lastValidAnimAbsY !== undefined) {
        animAbsX = this._lastValidAnimAbsX;
        animAbsY = this._lastValidAnimAbsY;
      } else {
        let monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
          animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset;
          animAbsY = (Main.panel.height || 27) + this._menuYoffset;
        } else {
          animAbsX = 0;
          animAbsY = 0;
        }
      }
    } else {
      this._lastValidAnimAbsX = animAbsX;
      this._lastValidAnimAbsY = animAbsY;
    }

    // The background needs to be larger than the UI to account for the glass expansion
    // and the extra padding required by the shader for edge refraction.
    let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
    let bgY = animAbsY - this._glassExpand - SHADER_PADDING;

    // Monitor geometry — always valid (defaults to 0 if monitor is null)
    let monitor = this._getMenuMonitorGeometry();
    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {

      // Menu position in monitor-local coordinates (shader uses these)
      let localBgX = bgX - monitorX;
      let localBgY = bgY - monitorY;

      // Only update positions/sizes if they actually changed to save CPU cycles
      if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
        this._lastBgX !== bgX || this._lastBgY !== bgY ||
        this._lastScreenW !== screenW || this._lastScreenH !== screenH) {

        // 1. bgActor: full monitor size, positioned at monitor origin
        this.bgActor.remove_transition('size');
        this.bgActor.remove_transition('position');
        this.bgActor.set_position(monitorX, monitorY);
        this.bgActor.set_size(screenW, screenH);
        this.bgActor.remove_transition('size');
        this.bgActor.remove_transition('position');

        // 2. liquidBox: full monitor size (relative to bgActor = 0,0)
        this.liquidBox?.set_position(0, 0);
        this.liquidBox?.set_size(screenW, screenH);

        // 3. GPU-efficient soft clip — limits rendering to the menu region +
        //    generous margin for drop-shadow decay without hard-clipping children.
        const CLIP_PADDING = 200;
        // this.liquidBox?.remove_clip();

        this.bgActor.set_clip(
          localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
          bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
        );

        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

        // 4. Update shader with full-screen resolution
        this.effect?.setResolution(screenW, screenH);

        // 5. Tell the shader where the menu lives within the full-screen FBO
        //    (matches the dockManager setGlassGeometry pattern)
        this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

        this._lastBgW = bgW; this._lastBgH = bgH;
        this._lastBgX = bgX; this._lastBgY = bgY;
        this._lastScreenW = screenW; this._lastScreenH = screenH;
      }
    }

    if (this.effect) {
      let currentScale = Math.min(scaleX, scaleY);
      this.effect.setCornerRadius(this._cornerRadius * currentScale);

      if (typeof this.effect.setAnimationScale === 'function') {
        this.effect.setAnimationScale(currentScale);
      }
    }

    // Clone sync every frame (dockManager pattern).
    // WindowCloneManager handles background + window actor clones.
    // UILayerSampler handles all uiGroup children — including the overview actors
    // automatically, so no separate overview/isOverview branch is needed.
    this._windowCloneManager?.setOffset(-monitorX, -monitorY);
    this._uiSampler?.refresh();
    this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
    this._windowCloneManager?.sync();
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

  _collectAdaptiveTextTargets(actor: Clutter.Actor = this.menu?.actor, targets: Clutter.Actor[] = []) {
    if (!actor) return targets;
    return this._findAllTextActors(this.menu?.actor);
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon) {
      if (actor.visible) {
        foundActors.push(actor);
      }
    }

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
      isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
    }

    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
  }

  // Removes all dynamically applied adaptive text color styles and stops related animations
  _clearAdaptiveStyles() {
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        if (actor._colorTweenId) {
          GLib.source_remove(actor._colorTweenId);
          actor._colorTweenId = undefined;
        }
        actor._currentTargetColor = undefined;
        actor._currentInsensitiveState = undefined;
        try {
          actor.remove_style_class_name('adaptive-text-transition');
          actor.remove_style_class_name('adaptive-color-light');
          actor.remove_style_class_name('adaptive-color-dark');
          actor.set_style(originalStyle || null);
        } catch (e) { }
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
        try {
          actor.set_style(null);
        } catch (e) { }
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
      try { actor.set_style(`color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`); } catch (e) { }
      return;
    }

    let startTime = GLib.get_monotonic_time();

    actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
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

      let a = startAlpha + (targetAlpha - startAlpha) * easeProgress;
      a = Math.max(0.0, Math.min(1.0, a));

      let alphaStr = a.toFixed(3);
      let currentRgba = `rgba(${r}, ${g}, ${b}, ${alphaStr})`;

      try { actor.set_style(`color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`); } catch (e) { }

      if (progress >= 1.0) {
        actor._colorTweenId = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Handles the custom bounce/spring physics when the menu opens or closes
  _startAnimation(targetValue: number) {
    let isClosing = (targetValue === 0);
    if (this._tickId !== 0) {
      GLib.source_remove(this._tickId);
      this._tickId = 0;
    }
    // If animation is disabled, just reset to default state
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

    if (this._swiftAnimation) {
      this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
      this._swiftSpringPos.updateParams(this._swiftResponse, this._swiftDampingFraction);
      this._swiftSpringScale.target = targetValue;
      this._swiftSpringPos.target = targetValue;
      if (Number.isNaN(this._swiftSpringScale.value)) this._swiftSpringScale.value = 0;
      if (Number.isNaN(this._swiftSpringPos.value)) this._swiftSpringPos.value = 0;
    } else {
      this._springScale.target = targetValue;
      this._springPos.target = targetValue;
    }

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

        let isClosing = this._swiftAnimation ? (this._swiftSpringScale.target === 0) : (this._springScale.target === 0);

        let dt = elapsedMs / 1000;
        if (dt > 0.033) dt = 0.033;

        let stopped = false;
        let s: number, p: number;

        if (isClosing) {
          let speed = 15.0;
          if (this._swiftAnimation) {
            this._swiftSpringScale.value += (0 - this._swiftSpringScale.value) * (1.0 - Math.exp(-speed * dt));
            this._swiftSpringPos.value += (0 - this._swiftSpringPos.value) * (1.0 - Math.exp(-speed * dt));
            s = this._swiftSpringScale.value;
            p = this._swiftSpringPos.value;
          } else {
            this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dt));
            this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dt));
            s = this._springScale.value;
            p = this._springPos.value;
          }

          if (s < 0.005) {
            s = 0; p = 0;
            stopped = true;
          }
        } else {
          if (this._swiftAnimation) {
            stopped = this._swiftSpringScale.update(elapsedMs) && this._swiftSpringPos.update(elapsedMs);
            s = this._swiftSpringScale.value;
            p = this._swiftSpringPos.value;
          } else {
            stopped = this._springScale.update(elapsedMs) && this._springPos.update(elapsedMs);
            s = this._springScale.value;
            p = this._springPos.value;
          }

          if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._swiftAnimation ? this._swiftSpringScale.velocity : this._springScale.velocity) < 0.03) {
            s = 1.0;
            p = 1.0;
            stopped = true;
          }
        }

        let currentScale: number;
        let opacity: number;

        if (isClosing) {
          currentScale = Math.max(0.001, s);
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
            this.menu.actor.hide();
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

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();

    // Disconnect all event listeners
    for (let sig of this._signals) {
      try {
        if (sig && sig.id) sig.target.disconnect(sig.id);
      } catch (e) { }
    }
    this._signals = [];

    if (this._tickId && this._tickId !== 0) {
      GLib.Source.remove(this._tickId);
      this._tickId = 0;
    }

    // Stop the render frame loop
    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters)
        global.compositor.get_laters().remove(this._frameSyncId);
      this._frameSyncId = 0;
    }

    if (this._interfaceSettings && this._accentColorSignalId) {
      this._interfaceSettings.disconnect(this._accentColorSignalId);
      this._accentColorSignalId = 0;
      this._interfaceSettings = null;
    }

    // Remove transparent CSS overrides
    this.targetActor.remove_style_class_name('liquid-glass-transparent');
    if (this.animActor) {
      this.animActor.remove_style_class_name('liquid-glass-transparent');
      this.animActor.remove_style_class_name('liquid-glass-menu-root');

      this.animActor.translation_y = 0;
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.opacity = 255;
    }
    if (this._dynamicCssFile) {
      const themeContext = St.ThemeContext.get_for_stage(global.stage);
      const theme = themeContext.get_theme();
      theme.unload_stylesheet(this._dynamicCssFile);
      this._dynamicCssFile = null;
    }

    this.targetActor.translation_y = 0;
    this.targetActor.set_scale(1.0, 1.0);
    this.targetActor.opacity = 255;

    if (this.menu.actor) {
      this.menu.actor.opacity = 255;

      if (this.menu.isOpen) {
        this.menu.close(false);
      }
    }

    // DESTROY EFFECT FIRST
    if (this.effect) {
      this.effect.cleanup();
      this.effect = null;
    }

    // DESTROY ACTOR SECOND
    // bgActor.destroy() cascades through liquidBox → _cloneContainer
    // and its children, so we only need to null the references afterwards.
    if (this.bgActor) {
      this.bgActor.destroy();
      this.bgActor = null;
    }
    this.liquidBox = null;
    this._cloneContainer = null;

    // Clean up managers (try-catch in their destroy() handles already-destroyed actors)
    this._uiSampler?.destroy();
    this._uiSampler = null;
    this._windowCloneManager?.destroy();
    this._windowCloneManager = null;

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
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;

    this.value = 0;
    this.velocity = 0;
    this.target = 0;
  }

  updateParams(stiffness: number, damping: number, mass: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.mass = mass;
  }

  update(elapsedMs: number) {
    let dt = elapsedMs / 1000;
    if (dt > 0.033) dt = 0.033;

    let springForce = -this.stiffness * (this.value - this.target);
    let dampingForce = -this.damping * this.velocity;
    let acceleration = (springForce + dampingForce) / this.mass;

    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;

    return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
  }
}

class SwiftSpring {
  response: number;
  dampingFraction: number;
  mass: number;

  value: number;
  velocity: number;
  target: number;

  constructor(response: number, dampingFraction: number, mass: number = 1.0) {
    this.response = typeof response === 'number' && !isNaN(response) && response > 0.01 ? response : 0.4;
    this.dampingFraction = typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0 ? dampingFraction : 0.7;
    this.mass = typeof mass === 'number' && !isNaN(mass) && mass > 0.01 ? mass : 1.0;

    this.value = 0;
    this.velocity = 0;
    this.target = 0;
  }

  updateParams(response: number, dampingFraction: number, mass: number = 1.0) {
    if (typeof response === 'number' && !isNaN(response) && response > 0.01) this.response = response;
    if (typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0) this.dampingFraction = dampingFraction;
    if (typeof mass === 'number' && !isNaN(mass) && mass > 0.01) this.mass = mass;
  }

  update(elapsedMs: number): boolean {
    let dt = elapsedMs / 1000;

    if (isNaN(dt) || dt <= 0) return false;
    if (dt > 0.1) dt = 0.1;

    if (isNaN(this.value) || !isFinite(this.value) || isNaN(this.velocity) || !isFinite(this.velocity)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const x0 = this.value - this.target;
    const v0 = this.velocity;

    if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    const omega0 = (2 * Math.PI) / this.response;
    const zeta = this.dampingFraction;

    let x_t = 0;
    let v_t = 0;

    // Analytical solution — no numerical explosion regardless of spring stiffness
    if (zeta < 0.999) {
      // 1. Underdamped — standard bouncy motion
      const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
      const alpha = zeta * omega0;
      const exp = Math.exp(-alpha * dt);
      const cos = Math.cos(omegaD * dt);
      const sin = Math.sin(omegaD * dt);

      x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
      v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
    } else if (zeta > 1.001) {
      // 2. Overdamped — slow, viscous motion
      const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
      const gamma1 = -zeta * omega0 + beta;
      const gamma2 = -zeta * omega0 - beta;
      const exp1 = Math.exp(gamma1 * dt);
      const exp2 = Math.exp(gamma2 * dt);

      const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
      const c2 = x0 - c1;

      x_t = c1 * exp1 + c2 * exp2;
      v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
    } else {
      // 3. Critically damped — fastest settle without overshoot
      const exp = Math.exp(-omega0 * dt);
      x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
      v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
    }

    this.value = x_t + this.target;
    this.velocity = v_t;

    if (isNaN(this.value) || !isFinite(this.value)) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    this.value = Math.max(-0.5, Math.min(2.5, this.value));

    if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }

    return false;
  }
}
