// src/dockManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';

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
    // コンストラクタに settings を追加
    constructor(extensionPath, targetActor, settings) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this._settings = settings; // GSettings object
        
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        
        this.bgClone = null;
        this.windowClonesContainer = null;
        
        this._windowClones = new Map();

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

        // マージン変更時
        connectSetting('dock-margin-bottom', () => {
            if (this._isEffectActive) this._applyMargin();
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

        let marginStyle = '';
        if (w > h) {
            if (y > monitor.y + monitor.height / 2) {
                marginStyle = `margin-bottom: ${marginBottom}px;`;
            } else {
                marginStyle = `margin-top: ${marginBottom}px;`;
            }
        } else {
            if (x > monitor.x + monitor.width / 2) {
                marginStyle = `margin-right: ${marginBottom}px;`;
            } else {
                marginStyle = `margin-left: ${marginBottom}px;`;
            }
        }

        // _originalStyleが存在しない場合は現在取得できるものを保存
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
        
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
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

        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);

        this.effect = new LiquidEffect({ extensionPath: this.extensionPath });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...hexToColorArray(tintColorStr));
        this.effect.setTintStrength(tintStrength);
        this.effect.setCornerRadius(cornerRadius);
        
        this.effect.setIsDock(true);
        this.bgActor.add_effect(this.effect);

        this.bgActor.show();

        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback) ??
                   Meta.later_add(laterType, callback);
        };
        
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW ?? Meta.LaterType.BEFORE_PAINT;

        let buildClones = () => {
            if (!this.bgActor) return;
            
            if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
            if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }

            this.bgClone = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
            this.clipBox.add_child(this.bgClone);

            this.windowClonesContainer = new Clutter.Actor();
            this.clipBox.add_child(this.windowClonesContainer);

            this.overviewCloneContainer = new Clutter.Actor();
            this.clipBox.add_child(this.overviewCloneContainer);

            this._windowClones.clear();
            this._overviewClone = null;

            let windows = global.get_window_actors();
            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                
                if (!metaWindow || metaWindow.minimized || !w.visible) continue;
                
                let clone = new Clutter.Clone({ source: w });
                clone.set_position(w.x, w.y);
                this.windowClonesContainer.add_child(clone);
                this._windowClones.set(w, clone);
            }
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
        if (Number.isNaN(absX) || Number.isNaN(absY)) return;

        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

        // --------------------------------------------------------------------
        // --------------------------------------------------------------------
        // 【修正版】静止時かつ画面内にいる時のみクリップし、アニメーション中はスルーする
        let marginValue = this._settings.get_int('dock-margin-bottom') || 0;
        
        if (monitor && marginValue > 0) {
            // 前フレームからの座標変動をチェックし、アニメーション中（スライド中）か判定
            let isMoving = false;
            if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
                let diffX = Math.abs(absX - this._lastAbsX);
                let diffY = Math.abs(absY - this._lastAbsY);
                // わずかな座標変動があれば移動中とみなす
                if (diffX > 0.1 || diffY > 0.1) {
                    isMoving = true;
                }
            }
            
            // 現在の座標を次回のために記憶
            this._lastAbsX = absX;
            this._lastAbsY = absY;

            // スライドイン・アウトのアニメーション中はカット処理を行わない（形を保つため）
            if (!isMoving) {
                if (baseW > baseH) { 
                    // 水平ドック（下または上に配置）
                    if (absY > monitor.y + monitor.height / 2) {
                        // 画面下部に配置されている場合
                        let expectedBottom = monitor.y + monitor.height - marginValue;
                        // ドックが画面内にあり、かつ下端が壁を越えている場合のみカット（隠れている時は無視）
                        if (absY < expectedBottom && absY + baseH > expectedBottom) {
                            baseH = expectedBottom - absY; 
                        }
                    } else {
                        // 画面上部に配置されている場合
                        let expectedTop = monitor.y + marginValue;
                        if (absY + baseH > expectedTop && absY < expectedTop) {
                            let diff = expectedTop - absY;
                            absY = expectedTop;
                            baseH -= diff;
                        }
                    }
                } else { 
                    // 垂直ドック（左または右に配置）
                    if (absX > monitor.x + monitor.width / 2) {
                        // 画面右側に配置されている場合
                        let expectedRight = monitor.x + monitor.width - marginValue;
                        if (absX < expectedRight && absX + baseW > expectedRight) {
                            baseW = expectedRight - absX;
                        }
                    } else {
                        // 画面左側に配置されている場合
                        let expectedLeft = monitor.x + marginValue;
                        if (absX + baseW > expectedLeft && absX < expectedLeft) {
                            let diff = expectedLeft - absX;
                            absX = expectedLeft;
                            baseW -= diff;
                        }
                    }
                }
            }
        }
        // --------------------------------------------------------------------

        // 補正されたサイズを適用
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);

        if (baseW <= 9 || baseH <= 9) {
            this.bgActor.hide();
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

        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2));
        let bgX = absX - SHADER_PADDING;
        let bgY = absY - SHADER_PADDING;

        if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX, bgY);
            
            this.clipBox.set_size(bgW, bgH);
            this.clipBox.set_position(0, 0);

            this.effect.setResolution(bgW, bgH);

            this._lastBgW = bgW; this._lastBgH = bgH;
            this._lastBgX = bgX; this._lastBgY = bgY;
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
                    clone = new Clutter.Clone({ source: w });
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
                if (this._overviewClone) { this._overviewClone.destroy(); this._overviewClone = null; }
                if (this._appDisplayClone) { this._appDisplayClone.destroy(); this._appDisplayClone = null; }
                if (this._searchClone) { this._searchClone.destroy(); this._searchClone = null; }

                this.bgClone.show(); // 通常の壁紙クローンを表示

                // 既存のウィンドウクローン同期ロジック
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
            } else {
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
                            this._overviewClone = new Clutter.Clone({ source: controls._workspacesDisplay });
                            this.overviewCloneContainer.add_child(this._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
                    }

                    // 2. アプリ一覧 (AppGrid) のクローン
                    if (controls._appDisplay) {
                        if (!this._appDisplayClone) {
                            this._appDisplayClone = new Clutter.Clone({ source: controls._appDisplay });
                            this.overviewCloneContainer.add_child(this._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
                    }

                    // 3. 検索画面 のクローン
                    if (controls._searchController && controls._searchController.actor) {
                        if (!this._searchClone) {
                            this._searchClone = new Clutter.Clone({ source: controls._searchController.actor });
                            this.overviewCloneContainer.add_child(this._searchClone);
                        }
                        this._syncActorProperties(controls._searchController.actor, this._searchClone);
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
        if (!this._isEffectActive) return;
        this._isEffectActive = false;

        this._currentMarginStyle = undefined;

        for (let sigId of this._signals) {
            this.targetActor.disconnect(sigId);
        }
        this._signals = [];

        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        
        if (this._dockParent) {
            this._dockParent.remove_style_class_name('liquid-glass-transparent');
            this._dockParent = null;
        }

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
            } else {
                Meta.later_remove(this._frameSyncId);
            }
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
}