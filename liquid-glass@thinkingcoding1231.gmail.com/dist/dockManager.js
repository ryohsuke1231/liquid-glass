// src/dockManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableClone } from './utils.js';
// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 20;
// Utility: Convert HEX color string (e.g., "#ffffff") to normalized RGB array [1.0, 1.0, 1.0]
function hexToColorArray(hex) {
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
    extensionPath;
    targetActor;
    _settings;
    bgActor = null;
    blurEffect = null;
    effect = null;
    _glassExpand;
    bgClone = null;
    windowClonesContainer = null;
    overviewCloneContainer = null;
    _windowClones;
    _overviewClone = null;
    _appDisplayClone = null;
    _searchClone = null;
    _signals;
    _settingsSignals; // GSettingsのイベントリスナーを管理
    _frameSyncId;
    _isEffectActive; // エフェクトが現在適用されているかのフラグ
    _originalStyle;
    _currentMarginStyle;
    _dockParent = null;
    clipBox = null;
    _lastAbsX;
    _lastAbsY;
    _lastTW;
    _lastTH;
    _stableDeltaW;
    _stableDeltaH;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastBaseW;
    _lastBaseH;
    _outputLogs = false;
    _marginValue = 0;
    // コンストラクタに settings を追加
    constructor(extensionPath, targetActor, settings) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this._settings = settings; // GSettings object
        // this.bgActor = null;
        // this.blurEffect = null;
        // this.effect = null;
        this._glassExpand = 0; // ガラスエリアの拡張量（ピクセル）
        // this.bgClone = null;
        // this.windowClonesContainer = null;
        this._windowClones = new Map();
        this._signals = [];
        this._settingsSignals = []; // GSettingsのイベントリスナーを管理
        this._frameSyncId = 0;
        this._isEffectActive = false; // エフェクトが現在適用されているかのフラグ
    }
    // 拡張機能が有効化された時に呼ばれるエントリーポイント
    setup() {
        if (!this.targetActor || !this._settings)
            return;
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
            }
            else if (!enabled && this._isEffectActive) {
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
            if (this._isEffectActive)
                this._applyMargin();
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
            if (this.blurEffect && this._isEffectActive) {
                this.blurEffect.radius = this._settings.get_int('dock-blur-radius');
            }
        });
        connectSetting('dock-corner-radius', () => {
            if (this.effect && this._isEffectActive) {
                this.effect.setCornerRadius(this._settings.get_double('dock-corner-radius'));
            }
        });
        connectSetting('output-logs', () => {
            this._outputLogs = this._settings.get_boolean('output-logs');
        });
    }
    // マージンの再計算と適用（動的反映のために独立した関数化）
    _applyMargin() {
        if (!this.targetActor)
            return;
        let marginBottom = this._settings.get_int('dock-margin-bottom');
        let [w, h] = this.targetActor.get_size();
        let [x, y] = this.targetActor.get_transformed_position();
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
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
            }
            else {
                marginStyle = `margin-top: ${marginBottom}px;`; // 上
            }
        }
        else {
            if (minEdge === distRight) {
                marginStyle = `margin-right: ${marginBottom}px;`; // 右
            }
            else {
                marginStyle = `margin-left: ${marginBottom}px;`; // 左
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
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this._dockParent = this.targetActor.get_parent();
        if (this._dockParent) {
            this._dockParent.add_style_class_name('liquid-glass-transparent');
        }
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(1.0, 1.0);
        this.clipBox = new St.Widget({ clip_to_allocation: true });
        this.clipBox.set_size(1.0, 1.0);
        this.bgActor.add_child(this.clipBox);
        this.targetActor.set_pivot_point(0.5, 0.5);
        this.bgActor.set_pivot_point(0.0, 0.0);
        // 動的マージンを適用
        this._applyMargin();
        this._marginValue = this._settings.get_int('dock-margin-bottom');
        this._glassExpand = this._settings.get_int("dock-glass-expand");
        this._outputLogs = this._settings.get_boolean('output-logs');
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
            if (!p)
                break;
            dockRoot = p;
        }
        if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        // 設定から初期値を読み込み
        let blurRadius = this._settings.get_int('dock-blur-radius');
        let tintColorStr = this._settings.get_string('dock-tint-color');
        let tintStrength = this._settings.get_double('dock-tint-strength');
        let cornerRadius = this._settings.get_double('dock-corner-radius');
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...hexToColorArray(tintColorStr));
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(cornerRadius);
        this.effect.setIsDock(true);
        this.bgActor.add_effect(this.effect);
        this.bgActor.show();
        const laterAdd = (laterType, callback) => {
            return global.compositor.get_laters().add(laterType, callback);
        };
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        let buildClones = () => {
            if (!this.bgActor)
                return;
            if (this.bgClone) {
                this.bgClone.destroy();
                this.bgClone = null;
            }
            if (this.windowClonesContainer) {
                this.windowClonesContainer.destroy();
                this.windowClonesContainer = null;
            }
            this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            this.clipBox?.add_child(this.bgClone);
            this.windowClonesContainer = new Clutter.Actor();
            this.clipBox?.add_child(this.windowClonesContainer);
            this.overviewCloneContainer = new Clutter.Actor();
            this.clipBox?.add_child(this.overviewCloneContainer);
            this._windowClones.clear();
            this._overviewClone = null;
            let windows = global.get_window_actors();
            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                if (!metaWindow || metaWindow.minimized || !w.visible)
                    continue;
                let clone = new UnpickableClone({ source: w });
                clone.set_position(w.x, w.y);
                this.windowClonesContainer.add_child(clone);
                this._windowClones.set(w, clone);
            }
        };
        let frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.targetActor.mapped)
                return GLib.SOURCE_REMOVE;
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
            }
            else {
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
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped)
            return;
        let sourceActor = this.targetActor;
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 0;
                sourceActor = children[i];
            }
        }
        // 1. まず元の背景のサイズと位置を取得
        let [baseW, baseH] = sourceActor.get_size();
        let [absX, absY] = sourceActor.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return;
        if (sourceActor !== this.targetActor) {
            let [tX, tY] = this.targetActor.get_transformed_position();
            let [tW, tH] = this.targetActor.get_size();
            // 親コンテナからはみ出した分をカットし、本来のサイズに強制する
            if (absX < tX) {
                baseW -= (tX - absX);
                absX = tX;
            }
            if (absY < tY) {
                baseH -= (tY - absY);
                absY = tY;
            }
            if (absX + baseW > tX + tW) {
                baseW = (tX + tW) - absX;
            }
            if (absY + baseH > tY + tH) {
                baseH = (tY + tH) - absY;
            }
        }
        if (this._outputLogs)
            log(`[Raw] ${absX}, ${absY}, ${baseW}, ${baseH}`);
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let minCenterDist = -1;
        // let distLeftCenter: number, distRightCenter: number, distTopCenter: number, distBottomCenter: number;
        let distLeftCenter = 0;
        let distRightCenter = 0;
        let distTopCenter = 0;
        let distBottomCenter = 0;
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
            }
            else {
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
            if (this._outputLogs)
                log(`refActor [Raw]: ${refX}, ${refY}, ${refW}, ${refH}`);
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
                        }
                        else {
                            // 上の隙間の方が広い -> 開始位置(上)を下げて、高さも削る
                            absY += diff;
                            baseH -= diff;
                        }
                    }
                }
                else {
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
                        }
                        else {
                            // 右ドック: 中央方向（左側）の余白を削る
                            if (rightGap > leftGap) {
                                baseW -= diff;
                            }
                            else {
                                absX += diff;
                                baseW -= diff;
                            }
                        }
                    }
                }
            }
        }
        if (this._outputLogs)
            log(`[Gap] ${absX}, ${absY}, ${baseW}, ${baseH}`);
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
                    if (baseH > stableBaseH)
                        baseH = stableBaseH; // Experimental
                }
                else if (minCenterDist === distTopCenter) {
                    // 上ドック
                    let expectedTop = monitor.y + marginValue;
                    if (absY < expectedTop) {
                        let diff = expectedTop - absY;
                        absY = expectedTop;
                        baseH -= diff;
                    }
                    if (baseH > stableBaseH)
                        baseH = stableBaseH;
                }
                else if (minCenterDist === distRightCenter) {
                    // 右ドック
                    let expectedRight = monitor.x + monitor.width - marginValue;
                    if (absX + baseW > expectedRight) {
                        let overflow = (absX + baseW) - expectedRight;
                        baseW -= overflow;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW; // Experimental
                }
                else {
                    // 左ドック
                    let expectedLeft = monitor.x + marginValue;
                    if (absX < expectedLeft) {
                        let diff = expectedLeft - absX;
                        absX = expectedLeft;
                        baseW -= diff;
                    }
                    if (baseW > stableBaseW)
                        baseW = stableBaseW;
                }
            }
        }
        if (this._outputLogs)
            log(`[Final] ${absX}, ${absY}, ${baseW}, ${baseH}`);
        // --------------------------------------------------------------------
        // 補正されたサイズを適用
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);
        if (baseW <= 9 || baseH <= 9) {
            this.bgActor.hide();
            return;
        }
        else {
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
            if (absX < monitor.x)
                visibleW -= (monitor.x - absX);
            if (absY < monitor.y)
                visibleH -= (monitor.y - absY);
            if (absX + baseW > monitor.x + monitor.width)
                visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
            if (absY + baseH > monitor.y + monitor.height)
                visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
        }
        if (visibleW <= 5 || visibleH <= 5) {
            this.bgActor.opacity = 0;
        }
        else {
            this.bgActor.opacity = this.targetActor.opacity;
        }
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgX = absX - SHADER_PADDING - this._glassExpand;
        let bgY = absY - SHADER_PADDING - this._glassExpand;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX, bgY);
            this.clipBox?.set_size(bgW, bgH);
            this.clipBox?.set_position(0, 0);
            this.effect?.setResolution(bgW, bgH);
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX;
            this._lastBgY = bgY;
        }
        if (this.bgClone && this.windowClonesContainer) {
            this.bgClone.set_position(-bgX, -bgY);
            this.windowClonesContainer.set_position(-bgX, -bgY);
            if (this.overviewCloneContainer) {
                this.overviewCloneContainer.set_position(-bgX, -bgY);
            }
            // アクティビティ画面が開いているか（アニメーション中含む）を判定
            let isOverview = Main.overview.visible || Main.overview.animationInProgress;
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0;
            /*
            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                if (!metaWindow || metaWindow.minimized || !w.visible) continue;
       
                activeWindows.add(w);
       
                let clone;
                if (!this._windowClones.has(w)) {
                    clone = new UnpickableClone({ source: w });
                    this.windowClonesContainer.add_child(clone);
                    this._windowClones.set(w, clone);
                } else {
                    clone = this._windowClones.get(w);
                }
                
                clone.set_position(w.x, w.y);
                clone.set_size(w.width, w.height);
                clone.set_scale(w.scale_x, w.scale_y);
                clone.translation_x = w.translation_x;
                clone.translation_y = w.translation_y;
       
                let pX = w.pivot_point ? w.pivot_point.x : 0;
                let pY = w.pivot_point ? w.pivot_point.y : 0;
                clone.set_pivot_point(pX, pY);
       
                this.windowClonesContainer.set_child_at_index(clone, zIndex);
                zIndex++;
            }
       
            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
            */
            if (!isOverview) {
                // --- デスクトップ通常時 ---
                // Overview用のクローン群があれば全て破棄
                if (this._overviewClone) {
                    this._overviewClone.destroy();
                    this._overviewClone = null;
                }
                if (this._appDisplayClone) {
                    this._appDisplayClone.destroy();
                    this._appDisplayClone = null;
                }
                if (this._searchClone) {
                    this._searchClone.destroy();
                    this._searchClone = null;
                }
                this.bgClone.show(); // 通常の壁紙クローンを表示
                // 既存のウィンドウクローン同期ロジック
                for (let w of windows) {
                    let metaWindow = w.get_meta_window();
                    if (!metaWindow || metaWindow.minimized || !w.visible)
                        continue;
                    activeWindows.add(w);
                    let clone;
                    if (!this._windowClones.has(w)) {
                        clone = new UnpickableClone({ source: w });
                        this.windowClonesContainer.add_child(clone);
                        this._windowClones.set(w, clone);
                    }
                    else {
                        clone = this._windowClones.get(w);
                    }
                    clone.set_position(w.x, w.y);
                    clone.set_size(w.width, w.height);
                    clone.set_scale(w.scale_x, w.scale_y);
                    clone.translation_x = w.translation_x;
                    clone.translation_y = w.translation_y;
                    let pX = w.pivot_point ? w.pivot_point.x : 0;
                    let pY = w.pivot_point ? w.pivot_point.y : 0;
                    clone.set_pivot_point(pX, pY);
                    this.windowClonesContainer.set_child_at_index(clone, zIndex);
                    zIndex++;
                }
            }
            else {
                // --- アクティビティ画面（Overview）時 ---
                // ワークスペースプレビュー自体に壁紙が含まれるため、通常の壁紙クローンは隠す
                // this.bgClone.hide();
                this.bgClone.show();
                // Dockを含まない、ワークスペース（背景＋プレビュー）だけのActorをピンポイント取得
                // ※ GNOME 40以降で安全にアクセスできるよう Optional Chaining (?.) を使用
                // Overview内の主要UIを管理しているcontrolsを取得
                let controls = Main.overview._overview?._controls;
                if (controls) {
                    // 1. ワークスペースプレビュー（背景含む）のクローン
                    if (controls._workspacesDisplay) {
                        if (!this._overviewClone) {
                            this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            this.overviewCloneContainer?.add_child(this._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
                    }
                    // 2. アプリ一覧 (AppGrid) のクローン
                    if (controls._appDisplay) {
                        if (!this._appDisplayClone) {
                            this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            this.overviewCloneContainer?.add_child(this._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
                    }
                    // 3. 検索画面 のクローン
                    // NOTE: In GNOME 45+, SearchController extends St.Widget directly,
                    // so the controller itself IS the actor. The previous `.actor` getter
                    // is deprecated (logs "Usage of object.actor is deprecated for
                    // SearchController" on every frame). Use the controller directly.
                    if (controls._searchController) {
                        const searchActor = controls._searchController;
                        if (!this._searchClone) {
                            this._searchClone = new UnpickableClone({ source: searchActor });
                            this.overviewCloneContainer?.add_child(this._searchClone);
                        }
                        this._syncActorProperties(searchActor, this._searchClone);
                    }
                }
                // isOverview が true の間は activeWindows が空のままになるため、
                // 以下のクリーンアップ処理によってフルサイズのウィンドウクローンは自動的に破棄されます。
            }
            // 使われなくなったクローン（閉じたウィンドウ、またはOverview起動時の全ウィンドウ）を削除
            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }
    _syncActorProperties(source, clone) {
        if (!source || !clone)
            return;
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
        clone.set_position(absX, absY);
        clone.set_size(w, h);
        // スケールとピボット
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
        if (!this._isEffectActive)
            return;
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
            let children = this.targetActor.get_children();
            for (let i = 0; i < children.length; i++) {
                if (children[i].has_style_class_name('dash-background')) {
                    children[i].opacity = 255;
                }
            }
        }
        catch (e) {
            // Actor was likely destroyed, safe to ignore
        }
        this._signals = [];
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        try {
            if (this._dockParent) {
                this._dockParent.remove_style_class_name('liquid-glass-transparent');
            }
        }
        catch (e) { }
        this._dockParent = null;
        if (this._originalStyle !== undefined) {
            this.targetActor.set_style(this._originalStyle);
            this._originalStyle = undefined; // 次回オンになった時に再取得できるようクリア
        }
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 255;
            }
        }
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._frameSyncId);
            }
            else {
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
        this.blurEffect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this._windowClones.clear();
        if (this.overviewCloneContainer) {
            // this.overviewCloneContainer.destroy();
            this.overviewCloneContainer = null;
        }
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;
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
    _findReferenceActor(actor) {
        if (!actor)
            return null;
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
