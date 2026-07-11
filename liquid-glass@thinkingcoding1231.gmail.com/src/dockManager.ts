// src/dockManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import Gio from 'gi://Gio';
import { UnpickableClone, UnpickableActor, UILayerSampler, UnpickableWidget, WindowCloneManager, PassThroughEffect } from './utils.js';

// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 20;

// Utility: Convert HEX color string (e.g., "#ffffff") to normalized RGB array [1.0, 1.0, 1.0]
function hexToColorArray(hex: string): [number, number, number] {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) {
    console.warn(`[Liquid Glass] Invalid color format received: ${hex}`);
    return [1.0, 1.0, 1.0];
  }
  let r = parseInt(hex.slice(1, 3), 16) / 255.0;
  let g = parseInt(hex.slice(3, 5), 16) / 255.0;
  let b = parseInt(hex.slice(5, 7), 16) / 255.0;
  return [r, g, b];
}

export class DashManager {
  private extensionPath: string;
  private targetActor: St.Widget;
  private _settings: Gio.Settings;

  // private bgActor: St.Widget | null = null;
  private bgActor: Clutter.Actor | null = null;
  // Delete Shell.BlurEffect and use custom blur (dual kawase) — now handled inside LiquidEffect
  private effect: LiquidEffect | null = null;

  // [NEW] Separate actor layers for liquid-glass effect.
  //
  // Nesting order (outermost → innermost):
  //   bgActor (full monitor, no effect)
  //     └─ liquidBox  ← LiquidEffect with built-in dual-Kawase blur
  //          └─ _cloneContainer  ← bgClone + windowClones + uiClones
  private liquidBox: Clutter.Actor | null = null;

  // [NEW] Cached monitor dimensions — used to detect monitor-resize events
  // so the full-screen actors and clips are rebuilt when needed.
  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _glassExpand: number;


  private _signals: number[];
  private _settingsSignals: number[]; // GSettingsのイベントリスナーを管理
  private _frameSyncId: number;
  private _isEffectActive: boolean; // エフェクトが現在適用されているかのフラグ

  private _originalStyle: string | undefined;
  private _currentMarginStyle: string | undefined;
  private _dockParent: St.Widget | null = null;

  private _cloneContainer: Clutter.Actor | null = null;

  private _lastAbsX: number | undefined;
  private _lastAbsY: number | undefined;
  private _lastTW: number | undefined;
  private _lastTH: number | undefined;
  private _stableDeltaW: number | undefined;
  private _stableDeltaH: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _lastBaseW: number | undefined;
  private _lastBaseH: number | undefined;

  private _outputLogs: boolean = false;

  private _marginValue: number = 0;

  private _uiSampler: UILayerSampler | null = null;
  private _windowCloneManager: WindowCloneManager | null = null;

  // コンストラクタに settings を追加
  constructor(extensionPath: string, targetActor: St.Widget, settings: Gio.Settings) {
    this.extensionPath = extensionPath;
    this.targetActor = targetActor;
    this._settings = settings; // GSettings object

    // this.bgActor = null;
    // this.effect = null;

    this._glassExpand = 0; // ガラスエリアの拡張量（ピクセル）

    // this.bgClone = null;
    // this.windowClonesContainer = null;


    this._signals = [];
    this._settingsSignals = []; // GSettingsのイベントリスナーを管理
    this._frameSyncId = 0;
    this._isEffectActive = false; // エフェクトが現在適用されているかのフラグ
  }

  // 拡張機能が有効化された時に呼ばれるエントリーポイント
  setup() {
    if (!this.targetActor || !this._settings) return;

    // 設定の監視を開始
    this._bindSettings();

    // 初回起動時にスイッチがONならエフェクトを適用
    if (this._settings.get_boolean('enable-dock-glass')) {
      this._applyEffect();
    }
  }

  // 設定が変更された時にリアルタイムで反映するためのバインディング
  _bindSettings() {
    const connectSetting = (key, callback) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    // ON/OFFスイッチの切り替え
    connectSetting('enable-dock-glass', () => {
      let enabled = this._settings.get_boolean('enable-dock-glass');
      if (enabled && !this._isEffectActive) {
        this._applyEffect();
      } else if (!enabled && this._isEffectActive) {
        this._removeEffect();
      }
    });

    connectSetting('dock-glass-expand', () => {
      if (this.effect && this._isEffectActive) {
        this._glassExpand = this._settings.get_int('dock-glass-expand');
      }
    });

    // マージン変更時
    connectSetting('dock-margin-bottom', () => {
      if (this._isEffectActive) this._applyMargin();
      this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
    });

    // シェーダーパラメータの動的変更
    connectSetting('dock-tint-color', () => {
      if (this.effect && this._isEffectActive) {
        let colorArray = hexToColorArray(this._settings.get_string('dock-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('dock-tint-strength', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setTintStrength(this._settings.get_double('dock-tint-strength'));
      }
    });

    connectSetting('dock-blur-radius', () => {
      const radius = this._settings.get_int('dock-blur-radius');
      if (this.effect && this._isEffectActive) this.effect.setBlurRadius(radius);
    });

    connectSetting('dock-corner-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setCornerRadius(this._settings.get_double('dock-corner-radius'));
      }
    });

    connectSetting('output-logs', () => {
      this._outputLogs = this._settings.get_boolean('output-logs');
    });

    connectSetting('dock-brightness', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setBrightness(this._settings.get_double('dock-brightness'));
      }
    });

    connectSetting('dock-contrast', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setContrast(this._settings.get_double('dock-contrast'));
      }
    });

    connectSetting('dock-saturation', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setSaturation(this._settings.get_double('dock-saturation'));
      }
    });
  }

  // マージンの再計算と適用（動的反映のために独立した関数化）
  _applyMargin() {
    if (!this.targetActor) return;

    let marginBottom = this._settings.get_int('dock-margin-bottom');

    let [w, h] = this.targetActor.get_size();
    let [x, y] = this.targetActor.get_transformed_position();

    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    // 【修正】w > h の判定をやめ、画面の各エッジとの距離から配置場所を特定する
    let distLeft = x - monitor.x;
    let distRight = (monitor.x + monitor.width) - (x + w);
    let distTop = y - monitor.y;
    let distBottom = (monitor.y + monitor.height) - (y + h);
    let minEdge = Math.min(distLeft, distRight, distTop, distBottom);

    let marginStyle = '';
    if (minEdge === distBottom || minEdge === distTop) {
      if (minEdge === distBottom) {
        marginStyle = `margin-bottom: ${marginBottom}px;`; // 下
      } else {
        marginStyle = `margin-top: ${marginBottom}px;`;    // 上
      }
    } else {
      if (minEdge === distRight) {
        marginStyle = `margin-right: ${marginBottom}px;`;  // 右
      } else {
        marginStyle = `margin-left: ${marginBottom}px;`;   // 左
      }
    }

    if (this._originalStyle === undefined) {
      this._originalStyle = this.targetActor.get_style() || '';
    }
    this._currentMarginStyle = marginStyle;
    this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
  }

  // 実際にエフェクトを描画し始める処理（元の setup() の中身）
  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    this.targetActor.add_style_class_name('liquid-glass-transparent');

    this._dockParent = this.targetActor.get_parent() as St.Widget | null;
    if (this._dockParent) {
      this._dockParent.add_style_class_name('liquid-glass-transparent');
    }

    /*
    this.bgActor = new UnpickableWidget({
      style_class: 'liquid-glass-bg-actor',
      clip_to_allocation: false,
      reactive: false
    });
    */
    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');

    // [CHANGED] bgActor starts at 1×1; _syncGeometry() will immediately expand
    // it to full monitor size on the first frame tick.
    this.bgActor.set_size(1.0, 1.0);

    // [NEW] liquidBox: full-monitor-sized actor that holds the LiquidEffect.
    // LiquidEffect internally runs dual-Kawase blur passes before the glass composite,
    // so no separate blurBox/Shell.BlurEffect is needed.
    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name("liquid-box");
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // [NEW] dummyBreaker: dummy actor to break the BMS bug
    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name("optimization-breaker");
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0); // 完全に透明
    this.liquidBox.add_child(dummyBreaker);

    // _cloneContainer lives inside liquidBox.
    // Clones are captured into the LiquidEffect's OffscreenEffect FBO and
    // blurred + distorted by the shader in a single pass.
    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name("clone-container");
    this.liquidBox.add_child(this._cloneContainer);

    // 動的マージンを適用
    this._applyMargin();
    this._marginValue = this._settings.get_int('dock-margin-bottom');
    this._glassExpand = this._settings.get_int("dock-glass-expand");
    this._outputLogs = this._settings.get_boolean('output-logs');

    let dockRoot = this.targetActor;
    while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
      let p = dockRoot.get_parent() as St.Widget | null;
      if (!p) break;
      dockRoot = p;
    }

    if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    // 設定から初期値を読み込み
    let blurRadius = this._settings.get_int('dock-blur-radius');
    let tintColorStr = this._settings.get_string('dock-tint-color');
    let tintStrength = this._settings.get_double('dock-tint-strength');
    let cornerRadius = this._settings.get_double('dock-corner-radius');
    let brightness = this._settings.get_double('dock-brightness');
    let contrast = this._settings.get_double('dock-contrast');
    let saturation = this._settings.get_double('dock-saturation');

    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...hexToColorArray(tintColorStr));
    this.effect.setTintStrength(tintStrength);
    this.effect.setCornerRadius(cornerRadius);
    this.effect.setBrightness(brightness);
    this.effect.setContrast(contrast);
    this.effect.setSaturation(saturation);
    this.effect.setBlurRadius(blurRadius);

    this.effect.setIsDock(true);
    this.liquidBox.add_effect(this.effect);

    // WindowCloneManager + UILayerSampler deposit their clones inside liquidBox.
    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer);
    this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [dockRoot, global.windowGroup, global.window_group], this._cloneContainer);

    this.bgActor.show();

    const laterAdd = (laterType: Meta.LaterType, callback: GLib.SourceFunc) => {
      return global.compositor.get_laters().add(laterType, callback);
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

    let frameTick = () => {
      this._frameSyncId = 0;
      if (!this.bgActor || !this.targetActor.mapped) return GLib.SOURCE_REMOVE;

      this._syncGeometry();
      this._frameSyncId = laterAdd(frameLaterType, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    let startFrameSync = () => {
      if (this._frameSyncId === 0) {
        buildClones();
        this._frameSyncId = laterAdd(frameLaterType, frameTick);
      }
    };

    let mapSignalId = this.targetActor.connect('notify::mapped', () => {
      if (this.targetActor.mapped) {
        startFrameSync();
      } else {
        if (this._frameSyncId !== 0) {
          this._frameSyncId = 0;
        }
      }
    });
    this._signals.push(mapSignalId);

    if (this.targetActor.mapped) {
      startFrameSync();
    }
  }

  _syncGeometry() {
    if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) return;

    let sourceActor = this.targetActor;
    let children = this.targetActor.get_children() as St.Widget[];
    for (let i = 0; i < children.length; i++) {
      if (children[i].has_style_class_name('dash-background')) {
        children[i].opacity = 0;
        sourceActor = children[i];
      }
    }


    // 1. まず元の背景のサイズと位置を取得
    let [baseW, baseH] = sourceActor.get_size();
    let [absX, absY] = sourceActor.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return;

    if (sourceActor !== this.targetActor) {
      let [tX, tY] = this.targetActor.get_transformed_position();
      let [tW, tH] = this.targetActor.get_size();

      // 親コンテナからはみ出した分をカットし、本来のサイズに強制する
      if (absX < tX) { baseW -= (tX - absX); absX = tX; }
      if (absY < tY) { baseH -= (tY - absY); absY = tY; }
      if (absX + baseW > tX + tW) { baseW = (tX + tW) - absX; }
      if (absY + baseH > tY + tH) { baseH = (tY + tH) - absY; }
    }
    if (this._outputLogs) log(`[Raw] ${absX}, ${absY}, ${baseW}, ${baseH}`);


    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) {
      monitorIndex = Main.layoutManager.primaryIndex;
    }
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    let minCenterDist = -1;
    // let distLeftCenter: number, distRightCenter: number, distTopCenter: number, distBottomCenter: number;
    let distLeftCenter: number = 0;
    let distRightCenter: number = 0;
    let distTopCenter: number = 0;
    let distBottomCenter: number = 0;

    if (monitor) {
      let dockCenterX = absX + (baseW / 2);
      let dockCenterY = absY + (baseH / 2);

      distLeftCenter = dockCenterX - monitor.x;
      distRightCenter = (monitor.x + monitor.width) - dockCenterX;
      distTopCenter = dockCenterY - monitor.y;
      distBottomCenter = (monitor.y + monitor.height) - dockCenterY;

      minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
    }
    if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
      let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);

      if (isHorizontalDock) {
        // ▼ 上・下ドックの場合：異常に膨張するのは H（厚み）
        // Hの変化量が「ちょうど marginValue 分」だった場合のみ、そのジャンプを無効化（<= 1 に修正）
        if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1) {
          baseH = this._lastBaseH;
        }
      } else {
        // ▼ 左・右ドックの場合：異常に膨張するのは W（厚み）
        // Wの変化量が「ちょうど marginValue 分」だった場合のみ無効化
        if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1) {
          baseW = this._lastBaseW;
        }
      }
    }
    this._lastBaseW = baseW;
    this._lastBaseH = baseH;
    let refActor = this._findReferenceActor(this.targetActor);
    if (refActor) {
      let [refW, refH] = refActor.get_size();
      let [refX, refY] = refActor.get_transformed_position();
      if (this._outputLogs) log(`refActor [Raw]: ${refX}, ${refY}, ${refW}, ${refH}`);

      if (!Number.isNaN(refX) && !Number.isNaN(refY) && refW > 0 && refH > 0) {

        let topGap = refY - absY;
        let bottomGap = (absY + baseH) - (refY + refH);
        // let leftGap = refX - absX;
        // let rightGap = (absX + baseW) - (refX + refW);

        // For when the dock is upside down
        if (topGap < 0 || bottomGap < 0) {
          // 原点が下端にあるため、真の左上Y座標は refY - refH になる
          let trueRefY = refY - refH;
          // ギャップを再計算して正常化
          topGap = trueRefY - absY;
          bottomGap = (absY + baseH) - (trueRefY + refH);
        }

        let leftGap = refX - absX;
        let rightGap = (absX + baseW) - (refX + refW);

        // ▼ X軸が反転（左右ミラー）しているかの検知と補正（左/右ドック用）
        if (leftGap < 0 || rightGap < 0) {
          let trueRefX = refX - refW;
          leftGap = trueRefX - absX;
          rightGap = (absX + baseW) - (trueRefX + refW);
        }

        if (baseW >= baseH) {
          // ▼ 横長ドック（上・下ドック）▼
          let diff = Math.abs(bottomGap - topGap);

          // 異常値(高さを超えるようなズレ)は無視する安全装置
          if (diff > 0 && diff < baseH / 2) {
            if (bottomGap > topGap) {
              // 下の隙間の方が広い -> 下を削る
              baseH -= diff;
            } else {
              // 上の隙間の方が広い -> 開始位置(上)を下げて、高さも削る
              absY += diff;
              baseH -= diff;
            }
          }
        } else {
          // ▼ 縦長ドック（左・右ドック）▼
          let diff = Math.abs(rightGap - leftGap);

          if (diff > 0 && diff < baseW / 2) {
            /*
            if (rightGap > leftGap) {
              // 右の隙間の方が広い -> 右を削る
              baseW -= diff;
            } else {
              // 左の隙間の方が広い -> 開始位置(左)を右にズラして、幅も削る
              absX += diff;
              baseW -= diff;
            }
            */
            if (minCenterDist === distLeftCenter) {
              // 左ドック: 中央方向（右側）の余白のみ削る
              // leftGap > rightGap になっても absX を右にズラしてはいけない
              if (rightGap > leftGap) {
                baseW -= diff;
              }
              // leftGap > rightGap の場合は何もしない（誤補正防止）
            } else {
              // 右ドック: 中央方向（左側）の余白を削る
              if (rightGap > leftGap) {
                baseW -= diff;
              } else {
                absX += diff;
                baseW -= diff;
              }
            }
          }
        }
      }
    }
    if (this._outputLogs) log(`[Gap] ${absX}, ${absY}, ${baseW}, ${baseH}`);
    // --------------------------------------------------------------------
    // --------------------------------------------------------------------
    let marginValue = this._settings.get_int('dock-margin-bottom') || 0;

    if (monitor && marginValue > 0) {
      /*
      // Dockの中心座標を算出
      let dockCenterX = absX + (baseW / 2);
      let dockCenterY = absY + (baseH / 2);
 
      // 中心座標から各エッジへの距離を測ることで、全幅・全高Dockでも誤認しない
      let distLeftCenter = dockCenterX - monitor.x;
      let distRightCenter = (monitor.x + monitor.width) - dockCenterX;
      let distTopCenter = dockCenterY - monitor.y;
      let distBottomCenter = (monitor.y + monitor.height) - dockCenterY;
 
      let minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
      */

      // アプリ起動時の微小揺れ（誤動作の元）を完全に無視するため、閾値を大きく設定
      let isMoving = false;
      if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
        let diffX = Math.abs(absX - this._lastAbsX);
        let diffY = Math.abs(absY - this._lastAbsY);
        if (diffX > 1.0 || diffY > 1.0) {
          isMoving = true;
        }
      }

      // Fix hiding animation bug
      // isMoving = false;
      this._lastAbsX = absX;
      this._lastAbsY = absY;

      let [tW, tH] = this.targetActor.get_size();
      if (this._stableDeltaW === undefined || this._lastTW !== tW) {
        this._stableDeltaW = baseW - tW;
        this._lastTW = tW;
      }
      if (this._stableDeltaH === undefined || this._lastTH !== tH) {
        this._stableDeltaH = baseH - tH;
        this._lastTH = tH;
      }

      let stableBaseW = tW + this._stableDeltaW;
      let stableBaseH = tH + this._stableDeltaH;

      if (!isMoving) {
        if (minCenterDist === distBottomCenter) {
          // 下ドック
          let expectedBottom = monitor.y + monitor.height - marginValue;
          if (absY + baseH > expectedBottom) {
            let overflow = (absY + baseH) - expectedBottom;
            baseH -= overflow;
          }
          if (baseH > stableBaseH) baseH = stableBaseH; // Experimental
        } else if (minCenterDist === distTopCenter) {
          // 上ドック
          let expectedTop = monitor.y + marginValue;
          if (absY < expectedTop) {
            let diff = expectedTop - absY;
            absY = expectedTop;
            baseH -= diff;
          }
          if (baseH > stableBaseH) baseH = stableBaseH;
        } else if (minCenterDist === distRightCenter) {
          // 右ドック
          let expectedRight = monitor.x + monitor.width - marginValue;
          if (absX + baseW > expectedRight) {
            let overflow = (absX + baseW) - expectedRight;
            baseW -= overflow;
          }
          if (baseW > stableBaseW) baseW = stableBaseW; // Experimental
        } else {
          // 左ドック
          let expectedLeft = monitor.x + marginValue;
          if (absX < expectedLeft) {
            let diff = expectedLeft - absX;
            absX = expectedLeft;
            baseW -= diff;
          }
          if (baseW > stableBaseW) baseW = stableBaseW;
        }
      }
    }
    if (this._outputLogs) log(`[Final] ${absX}, ${absY}, ${baseW}, ${baseH}`);
    // --------------------------------------------------------------------

    // 補正されたサイズを適用
    let w = Math.max(1.0, baseW);
    let h = Math.max(1.0, baseH);

    if (baseW <= 9 || baseH <= 9) {
      this.bgActor.hide();
      // stateをリセットして、次の表示時に必ずガードを通過させる 
      // Reset state to guard against the next frame tick from applying the guard.
      this._lastBgW = undefined;
      this._lastBgH = undefined;
      this._lastBgX = undefined;
      this._lastBgY = undefined;
      return;
    } else {
      this.bgActor.show();
    }

    this.bgActor.opacity = this.targetActor.opacity;


    /*
    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) {
        monitorIndex = Main.layoutManager.primaryIndex;
    }
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
    */
    let visibleW = baseW;
    let visibleH = baseH;
    if (monitor) {
      if (absX < monitor.x) visibleW -= (monitor.x - absX);
      if (absY < monitor.y) visibleH -= (monitor.y - absY);
      if (absX + baseW > monitor.x + monitor.width) visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
      if (absY + baseH > monitor.y + monitor.height) visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
    }

    if (visibleW <= 5 || visibleH <= 5) {
      this.bgActor.opacity = 0;
    } else {
      this.bgActor.opacity = this.targetActor.opacity;
    }

    let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgX = absX - SHADER_PADDING - this._glassExpand;
    let bgY = absY - SHADER_PADDING - this._glassExpand;

    // [NEW] Full-screen FBO geometry.
    // bgActor and liquidBox are both sized to cover the entire monitor.
    // This makes the FBO coordinate system match what BMS expects (full-screen
    // absolute coordinates), eliminating the BMS blur offset and cache-pollution
    // bugs caused by the old dock-sized FBO.
    let screenW = monitor.width;
    let screenH = monitor.height;

    // Dock background position in monitor-local coordinates (monitor origin = 0,0).
    // This is what the shader receives via setGlassGeometry() to reconstruct the
    // dock-centred local coordinate system inside the full-screen FBO.
    let localBgX = bgX - monitor.x;
    let localBgY = bgY - monitor.y;

    // Detect any change in dock geometry OR monitor size to trigger a rebuild.
    if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
      this._lastBgX !== bgX || this._lastBgY !== bgY ||
      this._lastScreenW !== screenW || this._lastScreenH !== screenH) {

      // [CHANGED] bgActor now occupies the full monitor (was dock-sized).
      // Positioning it at the monitor's absolute origin aligns the FBO coordinate
      // system with BMS's global-absolute sampling assumptions.
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');
      this.bgActor.set_position(monitor.x, monitor.y);
      this.bgActor.set_size(screenW, screenH);
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');

      // [NEW] liquidBox fills the entire bgActor (full monitor size).
      // Being at (0,0) relative to bgActor it occupies the same absolute space,
      // so every pixel of the monitor can participate in the FBO capture.
      this.liquidBox?.set_position(0, 0);
      this.liquidBox?.set_size(screenW, screenH);

      this._lastBgW = bgW; this._lastBgH = bgH;
      this._lastBgX = bgX; this._lastBgY = bgY;
      this._lastScreenW = screenW; this._lastScreenH = screenH;
    }


    // [NEW] Soft clipping via set_clip — limits GPU fragment-shader execution
    // to the dock region + a generous margin for drop-shadow decay, without
    // using clip_to_allocation (which hard-clips child actors and severs shadows).
    //
    // CLIP_PADDING must be at least as large as the maximum shadow_radius
    // setting so the penumbra gradient has room to fade to zero naturally.
    const CLIP_PADDING = 200;
    // Clip only bgActor; liquidBox has no separate clip
    // this.liquidBox?.remove_clip();

    this.bgActor.set_clip(
      localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
      bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
    );

    // [CHANGED] setResolution now receives the full monitor dimensions (was bgW/bgH).
    // The shader uses resolution to compute UV-to-pixel mapping over the full FBO.
    this.effect?.setResolution(screenW, screenH);

    // [NEW] Inform the shader where the dock lives within the full-screen FBO.
    // The shader uses these to compute dock_center and box_size, replacing
    // the old "resolution * 0.5" center assumption that only worked when
    // the FBO was dock-sized.
    this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

    // [CHANGED] Clone offset uses monitor origin instead of dock origin.
    //
    // Clones in WindowCloneManager are placed at (w.x, w.y) — absolute screen
    // coordinates. The container shift of (-monitor.x, -monitor.y) makes each
    // clone appear at (w.x - monitor.x, w.y - monitor.y) inside the full-screen
    // FBO, which maps back to (w.x, w.y) in screen space once bgActor's
    // monitor-origin position is added by Clutter's scene graph. ✓
    this._windowCloneManager?.setOffset(-monitor.x, -monitor.y);

    // UILayerSampler is synced with the monitor origin and full-screen
    // dimensions instead of the dock-relative bgX/bgY/bgW/bgH.
    this._uiSampler?.refresh();
    this._uiSampler?.sync(monitor.x, monitor.y, screenW, screenH);

    this._windowCloneManager?.sync();
  }

  _syncActorProperties(source, clone) {
    if (!source || !clone) return;

    // .x, .y, .width を直接読まず、計算済みの「画面上の絶対座標」と「サイズ」を関数で取得
    let [absX, absY] = source.get_transformed_position();
    let [w, h] = source.get_size();

    // 必須：NaN（非数）や異常なマイナス値が紛れ込んだ場合は同期をキャンセルして描画を止める
    // （これがログのエラーと真っ黒になる原因を防ぎます）
    if (Number.isNaN(absX) || Number.isNaN(absY) || Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0) {
      clone.visible = false;
      return;
    }

    // 正しい絶対座標とサイズをクローンに適用
    clone.remove_transition('position');
    clone.remove_transition('size');
    clone.set_position(absX, absY);
    clone.set_size(w, h);

    // スケールとピボット
    clone.remove_transition('scale-x');
    clone.remove_transition('scale-y');
    clone.set_scale(source.scale_x, source.scale_y);
    let pX = source.pivot_point ? source.pivot_point.x : 0;
    let pY = source.pivot_point ? source.pivot_point.y : 0;
    clone.set_pivot_point(pX, pY);

    // ※ get_transformed_position() はすでに translation（アニメーション移動量）を含んだ
    // 最終的な座標を返すため、ここで再度 translation を設定すると二重にズレてしまいます。
    // なのでクローン側の translation は常に 0 にリセットしておきます。
    clone.translation_x = 0;
    clone.translation_y = 0;

    // 透明度と表示状態
    clone.opacity = source.opacity;
    clone.visible = source.visible && source.mapped;
  }

  // エフェクトを画面から消し、元に戻す処理
  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._currentMarginStyle = undefined;

    // Safely try to remove styles/signals. If targetActor is already destroyed, 
    // this will fail safely without breaking the rest of the cleanup.
    try {
      for (let sigId of this._signals) {
        this.targetActor.disconnect(sigId);
      }
      this.targetActor.remove_style_class_name('liquid-glass-transparent');

      if (this._originalStyle !== undefined) {
        this.targetActor.set_style(this._originalStyle);
        this._originalStyle = undefined;
      }
      let children = this.targetActor.get_children() as St.Widget[];
      for (let i = 0; i < children.length; i++) {
        if (children[i].has_style_class_name('dash-background')) {
          children[i].opacity = 255;
        }
      }
    } catch (e) {
      // Actor was likely destroyed, safe to ignore
    }

    this._signals = [];

    this.targetActor.remove_style_class_name('liquid-glass-transparent');

    try {
      if (this._dockParent) {
        this._dockParent.remove_style_class_name('liquid-glass-transparent');
      }
    } catch (e) { }
    this._dockParent = null;

    if (this._originalStyle !== undefined) {
      this.targetActor.set_style(this._originalStyle);
      this._originalStyle = undefined; // 次回オンになった時に再取得できるようクリア
    }

    let children = this.targetActor.get_children() as St.Widget[];
    for (let i = 0; i < children.length; i++) {
      if (children[i].has_style_class_name('dash-background')) {
        children[i].opacity = 255;
      }
    }

    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters) {
        global.compositor.get_laters().remove(this._frameSyncId);
      } else {
        // Meta.later_remove(this._frameSyncId);
      }
      this._frameSyncId = 0;
    }

    if (this.effect) {
      this.effect.cleanup();
      this.effect = null;
    }

    if (this.bgActor) {
      this.bgActor.destroy();
      this.bgActor = null;
    }
    // liquidBox is a child of bgActor and is already destroyed by bgActor.destroy().
    // Just clear the reference here.
    this.liquidBox = null;

    this._uiSampler?.destroy();
    this._windowCloneManager?.destroy();
  }

  // 拡張機能全体が無効化される時の最終クリーンアップ
  cleanup() {
    // エフェクトを解除
    this._removeEffect();

    // メモリリークを防ぐため、GSettingsのリスナーもすべて解除する
    if (this._settings) {
      for (let id of this._settingsSignals) {
        this._settings.disconnect(id);
      }
      this._settingsSignals = [];
    }
  }

  // ドックの内部から、計算の基準となるアイコンまたはインジケーターを1つ再帰的に探し出す
  private _findReferenceActor(actor: Clutter.Actor): Clutter.Actor | null {
    if (!actor) return null;
    // 1. 安全性のチェック：オブジェクトが存在しない、または get_children がない場合は終了
    if (!actor || typeof actor.get_children !== 'function') {
      return null;
    }

    // 2. 判定条件：文字列化して 'IndicatorDrawingArea' が含まれているか
    if (actor.toString().includes('IndicatorDrawingArea')) {
      return actor;
    }

    // 3. 子要素を再帰的に探索
    const children = actor.get_children();
    for (const child of children) {
      const found = this._findReferenceActor(child);
      if (found) {
        return found; // 見つかったら即座に返す（無駄な探索をしない）
      }
    }

    return null; // 見つからなかった場合
  }
}
