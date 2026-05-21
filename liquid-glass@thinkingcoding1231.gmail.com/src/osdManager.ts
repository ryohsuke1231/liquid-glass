// src/osdManager.js
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

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
}

interface OsdState {
  osdWindow: any; // GNOME内部のOsdWindowクラス（厳密な型定義がないためanyで許容）
  targetBox: St.Widget;
  bgActor: St.Widget | null;
  clipBox: St.Widget;
  blurEffect: Shell.BlurEffect | null;
  effect: LiquidEffect | null;
  bgClone: Clutter.Clone | null;
  windowClonesContainer: Clutter.Actor | null;
  overviewCloneContainer: Clutter.Actor | null;
  _windowClones: Map<Clutter.Actor, Clutter.Clone>;
  _overviewClone: Clutter.Clone | null;
  _appDisplayClone: Clutter.Clone | null;
  _searchClone: Clutter.Clone | null;
  _stableBaseW?: number;
  _stableBaseH?: number;
  _lastBgW?: number;
  _lastBgH?: number;
  _lastBgX?: number;
  _lastBgY?: number;
  _currentTint: number;
  _wasVisible: boolean;
  _isFirstAdaptiveRun: boolean;
  _destroyId: number;
}

// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;

export class OsdManager {
  private extensionPath: string;
  private _settings: Gio.Settings;

  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _isEffectActive: boolean;

  private _osdYOffset: number;
  private _osdStates: OsdState[];
  private _baseTint: number;
  private _glassExpand: number;
  private _monitorsChangedId: number;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveConfig: typeof AdaptiveContrastConfig;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _isFirstAdaptiveRun: boolean;

  constructor(extensionPath: string, settings: Gio.Settings) {
    this.extensionPath = extensionPath;
    this._settings = settings;

    // マルチモニター対応：各モニターのOSD状態を管理する配列
    this._osdStates = [];

    // this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._monitorsChangedId = 0;
    this._isEffectActive = false;

    // this._windowClones = new Map();

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
    this._osdYOffset = 0;
    this._isFirstAdaptiveRun = true;
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    if (this._settings.get_boolean('enable-osd-glass')) {
      this._applyEffect();
    }
  }

  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-osd-glass', () => {
      let enabled = this._settings.get_boolean('enable-osd-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('osd-tint-color', () => {
      if (this._isEffectActive) {
        let colorArray = this._hexToColorArray(this._settings.get_string('osd-tint-color'));
        for (let state of this._osdStates) {
          if (state.effect) state.effect.setTintColor(...colorArray);
        }
      }
    });

    connectSetting('osd-tint-strength', () => {
      if (this._isEffectActive) {
        this._baseTint = this._settings.get_double('osd-tint-strength');
        for (let state of this._osdStates) {
          state._currentTint = this._baseTint;
          if (state.effect) state.effect.setTintStrength(this._baseTint);
        }
      }
    });

    connectSetting('osd-blur-radius', () => {
      if (this._isEffectActive) {
        let radius = this._settings.get_int('osd-blur-radius');
        for (let state of this._osdStates) {
          if (state.blurEffect) state.blurEffect.radius = radius;
        }
      }
    });

    connectSetting('osd-corner-radius', () => {
      if (this._isEffectActive) {
        let radius = this._settings.get_double('osd-corner-radius');
        for (let state of this._osdStates) {
          if (state.effect) state.effect.setCornerRadius(radius);
        }
      }
    });

    connectSetting('osd-glass-expand', () => {
      if (this._isEffectActive) {
        this._glassExpand = this._settings.get_int('osd-glass-expand');
      }
    });

    connectSetting('osd-enable-adaptive-text-color', () => {
      this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
      if (this._adaptiveConfig.enabled) this._startAdaptiveColorSampling();
      else {
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
      }
    });

    connectSetting('osd-sample-interval-ms', () => {
      this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
    });

    connectSetting('osd-y-offset', () => {
      this._osdYOffset = this._settings.get_int('osd-y-offset');
      for (let state of this._osdStates) {
        if (state.targetBox) {
          // 上方向へのシフトのためマイナス値を設定
          state.targetBox.translation_y = -this._osdYOffset;
        }
      }
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    this._adaptiveConfig.enabled = this._settings.get_boolean('osd-enable-adaptive-text-color');
    this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('osd-sample-interval-ms');
    this._glassExpand = this._settings.get_int('osd-glass-expand');
    this._baseTint = this._settings.get_double('osd-tint-strength');
    this._osdYOffset = this._settings.get_int('osd-y-offset');

    let osdWindows = Main.osdWindowManager._osdWindows;
    if (!osdWindows) return;

    // 各モニターのOSDに対してエフェクトをセットアップ
    for (let osdWindow of osdWindows) {
      this._setupOsdEffect(osdWindow);
    }

    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
    const frameTick = () => {
      this._frameSyncId = 0;
      if (!this._isEffectActive) return GLib.SOURCE_REMOVE;

      for (let state of this._osdStates) {
        this._syncGeometry(state);
      }

      this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
    this._startAdaptiveColorSampling();

    // モニター構成が変更された場合はOSDの再構築が必要
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
      this._removeEffect();
      if (this._settings.get_boolean('enable-osd-glass')) {
        this._applyEffect();
      }
    });
  }

  _setupOsdEffect(osdWindow) {
    let targetBox: St.Widget | null = null;
    if (osdWindow._icon && osdWindow._icon.get_parent) {
      targetBox = osdWindow._icon.get_parent();
    } else if (typeof osdWindow.get_first_child === 'function') {
      targetBox = osdWindow.get_first_child();
    }

    // それでもSt.Widgetが見つからない場合は子要素をスキャン
    if (targetBox && typeof targetBox.add_style_class_name !== 'function') {
      let children = osdWindow.get_children();
      for (let child of children) {
        if (typeof child.add_style_class_name === 'function') {
          targetBox = child;
          break;
        }
      }
    }

    if (!targetBox || typeof targetBox.add_style_class_name !== 'function') {
      console.warn("[Liquid Glass] OSDのUIコンテナが見つかりませんでした。");
      return;
    }

    // ここで初めてクラスを付与
    targetBox.add_style_class_name('liquid-glass-transparent');
    targetBox.translation_y = -this._osdYOffset;

    let bgActor = new St.Widget({
      style_class: 'liquid-glass-bg-actor',
      clip_to_allocation: false,
      reactive: false
    });
    bgActor.set_size(1.0, 1.0);
    bgActor.set_pivot_point(0.0, 0.0);

    let clipBox = new St.Widget({ clip_to_allocation: true });
    bgActor.add_child(clipBox);

    // OSD内部のレイアウトマネージャーの干渉を防ぐため、
    // targetBoxの親ではなく、OSDウィンドウ自体の背後に差し込む
    let osdParent = osdWindow.get_parent();
    if (osdParent) {
      osdParent.insert_child_below(bgActor, osdWindow);
    } else {
      Main.layoutManager.uiGroup.add_child(bgActor);
    }

    let blurRadius = this._settings.get_int('osd-blur-radius');
    let tintColorStr = this._settings.get_string('osd-tint-color');
    let cornerRadius = this._settings.get_double('osd-corner-radius');

    let blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
    clipBox.add_effect(blurEffect);

    let effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);
    effect.setPadding(SHADER_PADDING);
    effect.setTintColor(...this._hexToColorArray(tintColorStr));
    effect.setTintStrength(this._baseTint);
    effect.setCornerRadius(cornerRadius);
    effect.setIsDock(false);
    bgActor.add_effect(effect);

    bgActor.show();

    // 状態オブジェクトを作成
    let state: OsdState = {
      osdWindow: osdWindow,
      targetBox: targetBox,
      bgActor: bgActor,
      clipBox: clipBox,
      blurEffect: blurEffect,
      effect: effect,
      bgClone: null,
      windowClonesContainer: null,
      overviewCloneContainer: null,
      _windowClones: new Map<Clutter.Actor, Clutter.Clone>(),
      _overviewClone: null,
      _appDisplayClone: null,
      _searchClone: null,
      _stableBaseW: undefined,
      _stableBaseH: undefined,
      _lastBgW: undefined,
      _lastBgH: undefined,
      _lastBgX: undefined,
      _lastBgY: undefined,
      _currentTint: this._baseTint,
      _wasVisible: false,
      _isFirstAdaptiveRun: true,
      _destroyId: 0
    };
    this._buildClones(state);
    this._osdStates.push(state);

    // クリーンアップの徹底：OSDウィンドウが破棄されたらbgActorも道連れにする
    state._destroyId = osdWindow.connect('destroy', () => {
      this._osdStates = this._osdStates.filter(s => s !== state);
      if (state.bgActor) {
        state.bgActor.destroy();
        // state.bgActor = null;
      }
      if (state.effect) {
        state.effect.cleanup();
        // state.effect = null;
      }
    });
  }

  _syncActorProperties(source: Clutter.Actor, clone: Clutter.Clone) {
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

  _syncGeometry(state: OsdState) {
    if (!state.bgActor || !state.targetBox) return;

    let [w, h] = state.targetBox.get_size();
    let [absX, absY] = state.targetBox.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return;

    // 不透明度を連動（GNOMEのOSDアニメーションを尊重）
    let currentOpacity = Math.min(state.osdWindow.opacity, state.targetBox.opacity);
    let isVisible = currentOpacity > 0 && state.targetBox.visible;
    if (isVisible && !state._wasVisible) {
      state._wasVisible = true;
      this._isFirstAdaptiveRun = true; // 初回フラグを立てる
      this._updateAdaptiveTextColors(); // 400msタイマーを待たずに即座に実行！
    } else if (!isVisible && state._wasVisible) {
      state._wasVisible = false;
    }
    state.bgActor.opacity = currentOpacity;

    if (currentOpacity === 0 || !state.targetBox.visible) {
      state.bgActor.hide();
      return;
    } else if (!state.bgActor.visible) {
      state.bgActor.show();
    }

    // OSD特有のバグ対策：アイコン切り替え時に一時的に margin-bottom が height に加算されてしまう現象を検知
    let themeNode = state.targetBox.get_theme_node();
    let mB = themeNode ? themeNode.get_margin(St.Side.BOTTOM) : 0;

    if (state._stableBaseH === undefined) {
      state._stableBaseH = h;
    }

    let isHeightBloated = Math.abs(h - (state._stableBaseH + mB)) <= 1;

    let visualW = w;
    let visualH = h;

    if (isHeightBloated) {
      // 異常膨張を検知した場合は、margin-bottom分を差し引いて正しい高さを保つ
      visualH = h - mB;
    } else {
      // 正常な状態なら、基準の高さを更新
      state._stableBaseH = h;
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
    let parent = state.bgActor.get_parent();
    if (parent) {
      let [pX, pY] = parent.get_transformed_position();
      if (!Number.isNaN(pX) && !Number.isNaN(pY)) {
        bgX_local = bgX_abs - pX;
        bgY_local = bgY_abs - pY;
      }
    }

    if (state._lastBgW === undefined || state._lastBgH === undefined || state._lastBgX === undefined || state._lastBgY === undefined ||
      Math.abs(state._lastBgW - bgW) > 0.5 || Math.abs(state._lastBgH - bgH) > 0.5 ||
      Math.abs(state._lastBgX - bgX_abs) > 0.5 || Math.abs(state._lastBgY - bgY_abs) > 0.5) {

      state.bgActor.set_size(bgW, bgH);
      state.bgActor.set_position(bgX_local, bgY_local);

      state.clipBox.set_size(bgW, bgH);
      state.clipBox.set_position(0, 0);
      state.effect?.setResolution(bgW, bgH);
      // state.effect.setResolution(bgW, bgH);

      state._lastBgW = bgW;
      state._lastBgH = bgH;
      state._lastBgX = bgX_abs;
      state._lastBgY = bgY_abs;
    }

    if (state.bgClone && state.windowClonesContainer) {
      state.bgClone.set_position(-bgX_abs, -bgY_abs);
      state.windowClonesContainer.set_position(-bgX_abs, -bgY_abs);
      if (state.overviewCloneContainer) {
        state.overviewCloneContainer.set_position(-bgX_abs, -bgY_abs);
      }

      let isOverview = Main.overview.visible || Main.overview.animationInProgress;
      let windows = global.get_window_actors();
      let activeWindows = new Set();
      let zIndex = 0;

      if (!isOverview) {
        if (state._overviewClone) { state._overviewClone.destroy(); state._overviewClone = null; }
        if (state._appDisplayClone) { state._appDisplayClone.destroy(); state._appDisplayClone = null; }
        if (state._searchClone) { state._searchClone.destroy(); state._searchClone = null; }

        state.bgClone.show();

        for (let w of windows) {
          let metaWindow = w.get_meta_window();
          if (!metaWindow || metaWindow.minimized || !w.visible) continue;

          activeWindows.add(w);

          let clone: Clutter.Clone | undefined;
          if (!state._windowClones.has(w)) {
            clone = new UnpickableClone({ source: w });
            state.windowClonesContainer.add_child(clone);
            state._windowClones.set(w, clone);
          } else {
            clone = state._windowClones.get(w);
          }

          clone?.set_position(w.x, w.y);
          if (clone) state.windowClonesContainer.set_child_at_index(clone, zIndex);
          zIndex++;
        }
      } else {
        state.bgClone.show();
        let controls = Main.overview._overview?._controls;

        if (controls) {
          if (controls._workspacesDisplay) {
            if (!state._overviewClone) {
              state._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
              state.overviewCloneContainer?.add_child(state._overviewClone);
            }
            this._syncActorProperties(controls._workspacesDisplay, state._overviewClone);
          }
          if (controls._appDisplay) {
            if (!state._appDisplayClone) {
              state._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
              state.overviewCloneContainer?.add_child(state._appDisplayClone);
            }
            this._syncActorProperties(controls._appDisplay, state._appDisplayClone);
          }
          if (controls._searchController && controls._searchController.actor) {
            if (!state._searchClone) {
              state._searchClone = new UnpickableClone({ source: controls._searchController.actor });
              state.overviewCloneContainer?.add_child(state._searchClone);
            }
            this._syncActorProperties(controls._searchController.actor, state._searchClone);
          }
        }
      }

      for (let [w, clone] of state._windowClones.entries()) {
        if (!activeWindows.has(w)) {
          clone.destroy();
          state._windowClones.delete(w);
        }
      }
    }
  }

  _buildClones(state: OsdState) {
    if (!state.bgActor) return;

    if (state.bgClone) { state.bgClone.destroy(); state.bgClone = null; }
    if (state.windowClonesContainer) { state.windowClonesContainer.destroy(); state.windowClonesContainer = null; }
    if (state.overviewCloneContainer) { state.overviewCloneContainer.destroy(); state.overviewCloneContainer = null; }

    state.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
    state.clipBox.add_child(state.bgClone);

    state.overviewCloneContainer = new Clutter.Actor();
    state.clipBox.add_child(state.overviewCloneContainer);

    state.windowClonesContainer = new Clutter.Actor();
    state.clipBox.add_child(state.windowClonesContainer);

    state._windowClones.clear();
    state._overviewClone = null;
    state._appDisplayClone = null;
    state._searchClone = null;

    let windows = global.get_window_actors();
    for (let w of windows) {
      let metaWindow = w.get_meta_window();
      if (!metaWindow || metaWindow.minimized || !w.visible) continue;

      let clone = new UnpickableClone({ source: w });
      clone.set_position(w.x, w.y);
      state.windowClonesContainer.add_child(clone);

      state._windowClones.set(w, clone);
    }
  }

  // --- Adaptive Colors ---

  _collectAdaptiveTextTargets() {
    let targets = [];
    for (let state of this._osdStates) {
      // 表示されているOSDだけを対象にする
      if (state.osdWindow && state.osdWindow.opacity > 0 && state.osdWindow.visible) {
        this._findAllTextActors(state.targetBox, targets);
      }
    }
    return targets;
  }

  _findAllTextActors(actor: St.Widget, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');

    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button || actor instanceof St.Icon || isProgressBar) {
      if (actor.visible) {
        foundActors.push(actor);
      }
    }
    let children = actor.get_children() as St.Widget[];
    for (let i = 0; i < children.length; i++) {
      this._findAllTextActors(children[i], foundActors);
    }

    return foundActors;
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false) {
    if (!actor || typeof actor.set_style !== 'function') return;

    if (actor._currentTargetColor === color) return;
    actor._currentTargetColor = color;

    this._animateActorColor(actor, color, 380, skipAnimations);
  }

  _clearAdaptiveStyles() {
    for (const [actor, style] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        if (actor._colorTweenId) {
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

  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0) return;
    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations);
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
        // 有効なOSDが一つもなければサンプリングをスキップ（タイマーは維持）
        let isActive = this._osdStates.some(s => s.osdWindow && s.osdWindow.visible);
        if (isActive) {
          this._updateAdaptiveTextColors();
        }
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

  _updateAdaptiveTextColors() {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight) return;

    const targets = this._collectAdaptiveTextTargets();
    if (targets.length === 0) return;

    this._adaptiveInFlight = true;

    let isFirst = this._isFirstAdaptiveRun;
    this._isFirstAdaptiveRun = false;

    this._contrastSampler
      .chooseColorsForActors(targets, this._adaptiveConfig)
      .then(colorMap => {
        this._applyAdaptiveColorMap(colorMap, isFirst);
      })
      .catch(e => {
        console.error(`[Liquid Glass] OSD adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  _hexToRgb(hex: string) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }

  _rgbToHex(r: number, g: number, b: number) {
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, durationMs = 380, skipAnimations = false) {
    if (!actor || Object.keys(actor).length === 0) return;

    if (actor._colorTweenId) {
      GLib.source_remove(actor._colorTweenId);
      actor._colorTweenId = undefined;
    }

    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();
    let startBgColor = themeNode.get_background_color(); // トラック（背景）の現在の色を取得

    let targetRgb = this._hexToRgb(targetHexColor);

    // --- プログレスバー専用の Lerp (線形補間) ロジック ---
    let isProgressBar = actor.has_style_class_name && actor.has_style_class_name('level');
    let trackTargetRgb = targetRgb; // デフォルトは同じ色

    if (isProgressBar) {
      // AdaptiveConfig からlight/dark色を取得 (無ければ白黒にフォールバック)
      let lightHex = this._adaptiveConfig?.lightTextColor || '#ffffff';
      let darkHex = this._adaptiveConfig?.darkTextColor || '#000000';

      // ターゲット色がLightかDarkかを判定して、もう片方の色（otherRgb）を決定
      let isTargetLight = targetHexColor.toLowerCase() === lightHex.toLowerCase();
      let otherHexColor = isTargetLight ? darkHex : lightHex;
      let otherRgb = this._hexToRgb(otherHexColor);

      // 補間割合 x (0.0=全く変えない, 1.0=完全にもう片方の色)
      // 0.85 くらいにすると、不透明なまま絶妙に背景トラックっぽく沈む色になります
      let lerpRatio = 0.7;

      trackTargetRgb = {
        r: Math.round(targetRgb.r + (otherRgb.r - targetRgb.r) * lerpRatio),
        g: Math.round(targetRgb.g + (otherRgb.g - targetRgb.g) * lerpRatio),
        b: Math.round(targetRgb.b + (otherRgb.b - targetRgb.b) * lerpRatio)
      };
    }

    if (skipAnimations) {
      let finalHex = this._rgbToHex(targetRgb.r, targetRgb.g, targetRgb.b);
      if (isProgressBar) {
        let finalBgHex = this._rgbToHex(trackTargetRgb.r, trackTargetRgb.g, trackTargetRgb.b);
        actor.set_style(`
                    -barlevel-active-background-color: ${finalHex}; 
                    -barlevel-background-color: ${finalBgHex};
                `);
      } else {
        actor.set_style(`color: ${finalHex}; -st-icon-foreground-color: ${finalHex};`);
      }
      return;
    }
    let startTime = GLib.get_monotonic_time();

    actor._colorTweenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (!actor || Object.keys(actor).length === 0) return GLib.SOURCE_REMOVE;

      let currentTime = GLib.get_monotonic_time();
      let elapsedMs = (currentTime - startTime) / 1000;
      let progress = Math.min(elapsedMs / durationMs, 1.0);

      let easeProgress = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      // 前景色（filled部分・テキスト・アイコン）のアニメーション
      let r = Math.round(startColor.red + (targetRgb.r - startColor.red) * easeProgress);
      let g = Math.round(startColor.green + (targetRgb.g - startColor.green) * easeProgress);
      let b = Math.round(startColor.blue + (targetRgb.b - startColor.blue) * easeProgress);
      let currentHex = this._rgbToHex(r, g, b);

      if (isProgressBar) {
        // BarLevel専用のプロパティで色を適用
        let bgR = Math.round(startBgColor.red + (trackTargetRgb.r - startBgColor.red) * easeProgress);
        let bgG = Math.round(startBgColor.green + (trackTargetRgb.g - startBgColor.green) * easeProgress);
        let bgB = Math.round(startBgColor.blue + (trackTargetRgb.b - startBgColor.blue) * easeProgress);
        let currentBgHex = this._rgbToHex(bgR, bgG, bgB);

        // 発見した -barlevel-* プロパティを使用！
        actor.set_style(`
                    -barlevel-active-background-color: ${currentHex}; 
                    -barlevel-background-color: ${currentBgHex};
                `);
      } else {
        actor.set_style(`color: ${currentHex}; -st-icon-foreground-color: ${currentHex};`);
      }

      if (progress >= 1.0) {
        actor._colorTweenId = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();

    if (this._monitorsChangedId !== 0) {
      Main.layoutManager.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = 0;
    }

    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters) global.compositor.get_laters().remove(this._frameSyncId);
      // else if (Meta.later_remove) Meta.later_remove(this._frameSyncId);
      this._frameSyncId = 0;
    }

    for (let state of this._osdStates) {
      this._cleanupOsdState(state);
    }
    this._osdStates = [];
  }

  _cleanupOsdState(state: OsdState) {
    /*
    if (state.osdWindow && state._destroyId) {
      state.osdWindow.disconnect(state._destroyId);
      state._destroyId = 0;
    }
  
    if (state.targetBox) {
      state.targetBox.remove_style_class_name('liquid-glass-transparent');
      state.targetBox.translation_y = 0;
    }
  
    if (state.effect) {
      state.effect.cleanup();
      state.effect = null;
    }
  
    if (state.bgActor) {
      state.bgActor.destroy();
      state.bgActor = null;
    }
    */
    const isDisposed = (obj: any) => {
      if (!obj) return true;
      try {
        return Object.getOwnPropertyNames(obj).length === 0;
      } catch (e) {
        return true;
      }
    };

    // 各処理を独立させ、1つがコケても他が巻き添えを食らわないようにする
    if (state.osdWindow && !isDisposed(state.osdWindow)) {
      if (state._destroyId) {
        try {
          state.osdWindow.disconnect(state._destroyId);
        } catch (e) {
          // すでにC側で自動切断されている場合はスルー
        }
        state._destroyId = 0;
      }
    }

    if (state.targetBox && !isDisposed(state.targetBox)) {
      try {
        state.targetBox.remove_style_class_name('liquid-glass-transparent');
        state.targetBox.translation_y = 0;
      } catch (e) { }
    }

    if (state.effect) {
      try {
        state.effect.cleanup();
      } catch (e) { }
      state.effect = null;
    }

    if (state.bgActor && !isDisposed(state.bgActor)) {
      try {
        state.bgActor.destroy();
      } catch (e) { }
      state.bgActor = null;
    }

    state.blurEffect = null;
    state.bgClone = null;
    state.windowClonesContainer = null;
    state.overviewCloneContainer = null;
    state._windowClones.clear();
  }

  cleanup() {
    for (let sigId of this._settingsSignals) {
      this._settings.disconnect(sigId);
    }
    this._settingsSignals = [];
    this._removeEffect();
  }

  _laterAdd(laterType: Meta.LaterType, callback: GLib.SourceFunc) {
    return global.compositor?.get_laters?.().add(laterType, callback);
  }
}
