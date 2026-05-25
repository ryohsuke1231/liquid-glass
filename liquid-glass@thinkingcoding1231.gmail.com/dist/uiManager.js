// src/uiManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableClone, UnpickableActor, UILayerSampler } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area. 
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
export class UIManager {
    extensionPath;
    _settings;
    targetActor;
    menu;
    animActor;
    bgActor;
    blurEffect;
    effect;
    bgClone;
    windowClonesContainer;
    fboContainer;
    overviewCloneContainer;
    _windowClones;
    _overviewClone;
    _appDisplayClone;
    _searchClone;
    // private _signals: number[];
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _tickId;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _settingsSignals;
    _isEffectActive;
    _adaptiveConfig;
    clipBox = null;
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    // Spring physics parameters
    _springScale;
    _springPos;
    _springStiffness;
    _springDamping;
    _springMass;
    // SwiftUI Animation parameters
    _swiftAnimation = false; // trueにするとSwiftUI風アニメーションを使用
    _swiftResponse = 0.3; // 応答時間（小さいほど速い。0.3〜0.6程度がおすすめ）
    _swiftDampingFraction = 0.65; // 減衰比（0.6〜0.8あたりが心地よいバウンド）
    _swiftSpringScale;
    _swiftSpringPos;
    _enableAnimation;
    _interfaceSettings = null;
    _accentColorSignalId = 0;
    _dynamicCssFile = null;
    _cornerRadius = 0;
    _animationInterval = 16;
    _uiSampler = null;
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        // Target the main container of the Date/Calendar menu
        this.targetActor = Main.panel.statusArea.dateMenu.menu.actor;
        this.menu = Main.panel.statusArea.dateMenu.menu;
        // Target for animations and visual offsets (The inner content)
        // @ts-expect-error
        this.animActor = Main.panel.statusArea.dateMenu.menu.box;
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this.fboContainer = null;
        this.overviewCloneContainer = null;
        // Map to keep track of active windows and their corresponding clone actors.
        this._windowClones = new Map();
        this._signals = [];
        this._frameSyncId = 0;
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
        // SwiftUI Animation init
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
        this._overviewClone = null;
        this._appDisplayClone = null;
        this._searchClone = null;
        // Listen for the menu opening/closing to trigger our custom physics animation
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._startAnimation(1); // Target scale: 1.0 (fully open)
            }
            else {
                this._startAnimation(0); // Target scale: 0.0 (closed)
            }
        });
    }
    setup() {
        if (!this._settings)
            return;
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
            // テーマの更新を少し待ってから取得
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._applySystemAccentColor();
                return GLib.SOURCE_REMOVE;
            });
        });
        // 初回実行
        this._applySystemAccentColor();
        // uiManager は 'enable-menu-glass'、notificationManager は 'notification-enable-glass' （※スキーマによる）
        if (this._settings.get_boolean('enable-menu-glass')) {
            this._applyEffect();
        }
    }
    _applySystemAccentColor() {
        if (!this.targetActor)
            return;
        // 1. 親要素と子要素を作成して、GNOMEテーマが要求する正しい階層を再現
        const parent = new St.Widget({ style_class: 'calendar' });
        const child = new St.Widget({ style_class: 'calendar-day calendar-today' });
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
        /*
        // 6. 親要素にCSS変数としてセット
        let currentStyle = this.targetActor.get_style() || '';
        currentStyle = currentStyle.replace(/--system-accent-color-yeah:\s*[^;]+;?/g, ''); // 重複防止
        this.targetActor.set_style(`${currentStyle} --system-accent-color-yeah: ${colorStr};`);
        */
        // 3. その場で読み込ませる動的CSSの内容を作成（変数は使わず、直接色を埋め込む）
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
            // 4. ユーザーのキャッシュディレクトリに一時CSSファイルとして保存
            const cacheDir = GLib.get_user_cache_dir();
            const filePath = GLib.build_filenamev([cacheDir, 'liquid-glass-accent.css']);
            // 文字列をファイルに書き込み
            GLib.file_set_contents(filePath, cssContent);
            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            const theme = themeContext.get_theme();
            // 5. 古い動くスタイルシートがあれば先にアンロード（多重適用防止）
            if (this._dynamicCssFile) {
                theme.unload_stylesheet(this._dynamicCssFile);
            }
            // 6. 新しいスタイルシートをテーマに直接ロード
            this._dynamicCssFile = Gio.File.new_for_path(filePath);
            theme.load_stylesheet(this._dynamicCssFile);
            console.log(`[Liquid Glass] 動的CSSの注入に成功しました。適用色: ${colorStr}`);
        }
        catch (e) {
            console.log(`[Liquid Glass] 動的CSSの適用に失敗しました: ${e}`);
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
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        return Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
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
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting('enable-menu-animation', () => {
            this._enableAnimation = this._settings.get_boolean('enable-menu-animation');
        });
        connectSetting('menu-spring-stiffness', () => {
            this._springStiffness = this._settings.get_double('menu-spring-stiffness');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('menu-spring-damping', () => {
            this._springDamping = this._settings.get_double('menu-spring-damping');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting('menu-spring-mass', () => {
            this._springMass = this._settings.get_double('menu-spring-mass');
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
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
            if (this.blurEffect) {
                this.blurEffect.radius = this._settings.get_int('menu-blur-radius');
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
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        // Remove default GNOME styling and make the background transparent
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-transparent');
        this.animActor.add_style_class_name('liquid-glass-menu-root');
        // Shift the menu down to prevent it from clipping into the top bar
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
        // Create the main background actor that will hold the glass effect
        // clip_to_allocation is false so the shader can draw outside the strict bounds if needed
        // 1. bgActor (LiquidEffect用：メニューサイズ)
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        this.bgActor.set_size(1.0, 1.0);
        // 2. clipBox (切り抜き用ハサミ：メニューサイズ)
        this.clipBox = new St.Widget({
            clip_to_allocation: true
        });
        this.bgActor.add_child(this.clipBox);
        // 🌟 新規追加: 3. fboContainer (マイナス座標回避用フルスクリーンキャンバス)
        // this.fboContainer = new Clutter.Actor();
        this.fboContainer = new UnpickableActor();
        this.clipBox.add_child(this.fboContainer);
        // Set pivot points for scaling. 
        // The menu scales from the top-center (0.5, 0.0)
        this.animActor.set_pivot_point(0.5, 0.0);
        // bgActor scales from the top-left (0.0, 0.0) because we manually sync its exact coordinates
        this.bgActor.set_pivot_point(0.0, 0.0);
        /*
        // Insert the custom background *underneath* the actual menu UI
        let menuParent = this.menu.actor.get_parent();
        if (menuParent) {
          menuParent.insert_child_below(this.bgActor, this.menu.actor);
        } else {
          // Fallback: If it has no parent yet, add it directly to the UI group
          Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        */
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        // bgActor を uiGroup の直接の子として挿入（再帰クローンを完全に防ぐ）
        if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        this._uiSampler = new UILayerSampler(this.bgActor, this.fboContainer, [menuRoot]);
        let blurRadius = this._settings.get_int('menu-blur-radius');
        let tintColorStr = this._settings.get_string('menu-tint-color');
        let tintStrength = this._settings.get_double('menu-tint-strength');
        this._cornerRadius = this._settings.get_double('menu-corner-radius');
        // Apply native GNOME blur to the internal clipBox (which contains the clones)
        this.blurEffect = new Shell.BlurEffect({ radius: blurRadius, mode: Shell.BlurMode.ACTOR });
        this.fboContainer.add_effect(this.blurEffect);
        // Apply our custom GLSL liquid shader to the outer background actor
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings });
        // Tell the shader about the padding so it calculates refraction coordinates correctly
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(...this._hexToColorArray(tintColorStr)); // Pure transparent base
        this.effect.setTintStrength(tintStrength); // Subtle tint strength to enhance the glass look without overpowering the background
        this.effect.setCornerRadius(this._cornerRadius);
        this.effect.setIsDock(false);
        this.bgActor.add_effect(this.effect);
        this.bgActor.show();
        // Helper functions to hook into GNOME's render pipeline
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
        // Function to create clones of the desktop wallpaper and all visible windows
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // 1. ISOLATED CLEANUP (Adopted from quickSettingsManager for safety)
            const safeDestroy = (actorRef) => {
                if (actorRef) {
                    try {
                        actorRef.destroy();
                    }
                    catch (e) {
                        // C object was already disposed, ignore safely.
                    }
                }
            };
            safeDestroy(this.bgClone);
            this.bgClone = null;
            safeDestroy(this.windowClonesContainer);
            this.windowClonesContainer = null;
            safeDestroy(this.overviewCloneContainer);
            this.overviewCloneContainer = null;
            // 2. CREATION WITH LIFECYCLE TRACKING
            // Clone the desktop background
            // this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
            this.bgClone.connect('destroy', () => { this.bgClone = null; });
            this.fboContainer?.add_child(this.bgClone);
            // this.overviewCloneContainer = new Clutter.Actor();
            this.overviewCloneContainer = new UnpickableActor();
            this.overviewCloneContainer.connect('destroy', () => { this.overviewCloneContainer = null; });
            this.fboContainer?.add_child(this.overviewCloneContainer);
            // Create a container for the window clones
            // this.windowClonesContainer = new Clutter.Actor();
            this.windowClonesContainer = new UnpickableActor();
            this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
            this.fboContainer?.add_child(this.windowClonesContainer);
            this._uiSampler?.rebindSelf();
            this._uiSampler?.refresh();
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
                // let clone = new UnpickableClone({ source: w });
                let clone = new UnpickableClone({ source: w });
                let [parentX, parentY] = this.windowClonesContainer.get_transformed_position();
                if (Number.isNaN(parentX) || Number.isNaN(parentY)) {
                    // Fallback
                    parentX = 0;
                    parentY = 0;
                }
                // 親の座標分をマイナスすることで、画面上の絶対座標を w.x, w.y に一致させる
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
        let stopFrameSync = () => {
            if (this._frameSyncId !== 0) {
                laterRemove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        };
        // Clear the cached size whenever the menu opens so it can recalculate 
        // based on any new notifications or calendar events added
        this._signals.push({
            target: this.menu,
            id: this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._stableBaseW = undefined;
                    this._stableBaseH = undefined;
                    startFrameSync();
                    this._startAdaptiveColorSampling(true); // Skip animations on the first open for instant feedback
                }
                else {
                    this._stopAdaptiveColorSampling();
                }
            })
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
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // 追加: UIクローンの位置・サイズ同期用メソッド (Adopted try/catch from quickSettingsManager)
    _syncActorProperties(source, clone) {
        if (!source || !clone)
            return;
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
        }
        catch (e) {
            // The C-level actor was destroyed by GNOME Shell, but JS hasn't caught up yet.
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
            }
            else {
                // If no history exists, calculate based on the top panel clock button
                /*
                let buttonActor = Main.panel.statusArea.dateMenu.actor;
                let [btnX, btnY] = buttonActor.get_transformed_position();
                let [btnW, btnH] = buttonActor.get_size();
           
                if (!Number.isNaN(btnX) && !Number.isNaN(btnY)) {
                    // Assume the menu opens centered directly below the clock button
                    animAbsX = btnX + (btnW / 2) - (w / 2) + this._menuXoffset; // Apply horizontal offset
                    animAbsY = btnY + btnH + this._menuYoffset;
                } else {
                    // Ultimate fallback: Just place it in the top-center of the primary monitor
                    let monitor = Main.layoutManager.primaryMonitor;
                    if (monitor) {
                        animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset; // Apply horizontal offset
                        animAbsY = (Main.panel.height || 27) + this._menuYoffset;
                    } else {
                        animAbsX = 0;
                        animAbsY = 0;
                    }
                }
                */
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset; // Apply horizontal offset
                    animAbsY = (Main.panel.height || 27) + this._menuYoffset;
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
                let monitor = this._getMenuMonitorGeometry();
                let monitorX = monitor?.x ?? 0;
                let monitorY = monitor?.y ?? 0;
                let monitorW = Math.max(1, monitor?.width ?? 1);
                let monitorH = Math.max(1, monitor?.height ?? 1);
                // メニューの絶対座標からモニターの原点を引いた分だけマイナスにシフトする
                if (this.fboContainer) {
                    let fboOffsetX = bgX - monitorX;
                    let fboOffsetY = bgY - monitorY;
                    this.fboContainer.set_position(-fboOffsetX, -fboOffsetY);
                    this.fboContainer.set_size(monitorW, monitorH);
                }
                // bgCloneのサイズもモニターに合わせる
                if (this.bgClone) {
                    this.bgClone.set_size(monitorW, monitorH);
                }
                // Update the shader with the new resolution
                this.effect?.setResolution(bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
            }
        }
        if (this.effect) {
            // 縦横のスケールのうち小さい方を採用し、角丸が潰れないようにする
            let currentScale = Math.min(scaleX, scaleY);
            // let baseRadius = this._settings.get_double('menu-corner-radius');
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
                this.bgClone.show();
                this._uiSampler?.refresh();
                this._uiSampler?.sync();
                for (let w of windows) {
                    try {
                        let metaWindow = w.get_meta_window();
                        if (!metaWindow || metaWindow.minimized || !w.visible)
                            continue;
                        activeWindows.add(w);
                        let clone;
                        if (!this._windowClones.has(w)) {
                            // Create a clone for newly opened windows.
                            // clone = new UnpickableClone({ source: w });
                            clone = new UnpickableClone({ source: w });
                            this.windowClonesContainer.add_child(clone);
                            this._windowClones.set(w, clone);
                        }
                        else {
                            // Retrieve existing clone.
                            clone = this._windowClones.get(w);
                        }
                        // Keep the position synchronized with the real window.
                        let [parentX, parentY] = this.windowClonesContainer.get_transformed_position();
                        if (clone)
                            clone.set_position(w.x - parentX, w.y - parentY);
                        if (Number.isNaN(parentX) || Number.isNaN(parentY)) {
                            // Fallback
                            parentX = 0;
                            parentY = 0;
                        }
                        // Update the Z-index dynamically to reflect window focus changes.
                        if (clone)
                            this.windowClonesContainer.set_child_at_index(clone, zIndex);
                        zIndex++;
                    }
                    catch (e) {
                        continue;
                    }
                }
            }
            else {
                // --- Overview時 ---
                this.bgClone.show();
                this._uiSampler?.refresh();
                this._uiSampler?.sync();
                let controls = Main.overview._overview?._controls;
                if (controls) {
                    if (controls._workspacesDisplay) {
                        if (!this._overviewClone) {
                            // this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            this._overviewClone = new UnpickableClone({ source: controls._workspacesDisplay });
                            this.overviewCloneContainer?.add_child(this._overviewClone);
                        }
                        this._syncActorProperties(controls._workspacesDisplay, this._overviewClone);
                    }
                    if (controls._appDisplay) {
                        if (!this._appDisplayClone) {
                            // this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            this._appDisplayClone = new UnpickableClone({ source: controls._appDisplay });
                            this.overviewCloneContainer?.add_child(this._appDisplayClone);
                        }
                        this._syncActorProperties(controls._appDisplay, this._appDisplayClone);
                    }
                    if (controls._searchController && controls._searchController.actor) {
                        if (!this._searchClone) {
                            // this._searchClone = new UnpickableClone({ source: controls._searchController.actor });
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
        if (!this.bgActor || !this.effect)
            return;
        let [width, height] = this.bgActor.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.effect.setResolution(width, height);
        }
    }
    // Utility function to safely check if an actor has a specific style class
    _hasStyleClass(actor, className) {
        return actor instanceof St.Widget &&
            actor.has_style_class_name(className);
    }
    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(this.menu?.actor);
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
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
    _setActorColor(actor, color, skipAnimations = false) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
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
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive)
            return;
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;
        // Kick off the color transition animation!
        this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations);
    }
    // Removes all dynamically applied adaptive text color styles and stops related animations
    _clearAdaptiveStyles() {
        // 1. 変更履歴 (styledActors) から元の状態を復元する
        for (const [actor, originalStyle] of this._styledActors.entries()) {
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
                    // 元のスタイル(またはnull)をセット
                    actor.set_style(originalStyle || null);
                }
                catch (e) { }
            }
        }
        this._styledActors.clear();
        // 2. 念のため、現在DOM上に存在するターゲットの色も強制クリア（フェイルセーフ）
        const currentTargets = this._collectAdaptiveTextTargets();
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
                }
                catch (e) { }
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
    _animateActorColor(actor, targetHexColor, isInsensitive, durationMs = 380, skipAnimations = false) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        // Cancel any existing color tween if running (handles mid-transition target changes).
        if (actor._colorTweenId) {
            GLib.source_remove(actor._colorTweenId);
            actor._colorTweenId = undefined;
        }
        // --- Retrieve the "actual physical color" currently displayed on screen ---
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color(); // Returns Clutter.Color
        let targetRgb = this._hexToRgb(targetHexColor);
        // 無効状態なら透明度を50%(0.5)にし、有効なら100%(1.0)にする
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0;
        if (skipAnimations) {
            let alphaStr = targetAlpha.toFixed(3);
            let targetRgba = `rgba(${targetRgb.r}, ${targetRgb.g}, ${targetRgb.b}, ${alphaStr})`;
            try {
                actor.set_style(`color: ${targetRgba}; -st-icon-foreground-color: ${targetRgba};`);
            }
            catch (e) { }
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
            try {
                actor.set_style(`color: ${currentRgba}; -st-icon-foreground-color: ${currentRgba};`);
            }
            catch (e) { }
            // Check for animation completion
            if (progress >= 1.0) {
                actor._colorTweenId = undefined;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }
    // Handles the custom bounce/spring physics when the menu opens or closes
    _startAnimation(targetValue) {
        let isClosing = (targetValue === 0);
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
                // アニメーション中の透明度や位置の同期は _syncGeometry が行います
            }
            return;
        }
        // Clear any built-in GNOME transitions that might interfere with our logic
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.bgActor)
            this.bgActor.remove_all_transitions();
        // Update the spring physics parameters
        // this._springScale.updateParams(this._settings.get_double("menu-spring-stiffness"), this._settings.get_double("menu-spring-damping"), this._settings.get_double("menu-spring-mass"));
        if (this._swiftAnimation) {
            this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringPos.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringScale.target = targetValue;
            this._swiftSpringPos.target = targetValue;
            // Safety check
            if (Number.isNaN(this._swiftSpringScale.value))
                this._swiftSpringScale.value = 0;
            if (Number.isNaN(this._swiftSpringPos.value))
                this._swiftSpringPos.value = 0;
        }
        else {
            this._springScale.target = targetValue;
            this._springPos.target = targetValue;
        }
        // If an animation loop isn't already running, start a new one
        if (this._tickId === 0) {
            let lastTime = GLib.get_monotonic_time();
            // Run at ~60fps (every 16ms)
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._animationInterval, () => {
                if (!this.bgActor || !this.targetActor) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                let currentTime = GLib.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;
                let isClosing = this._swiftAnimation ? (this._swiftSpringScale.target === 0) : (this._springScale.target === 0);
                // Cap delta time to prevent physics explosions during severe lag spikes
                let dt = elapsedMs / 1000;
                if (dt > 0.033)
                    dt = 0.033;
                let stopped = false;
                let s, p;
                if (isClosing) {
                    // Use a simple exponential decay for closing (faster, no bounce)
                    let speed = 15.0;
                    if (this._swiftAnimation) {
                        this._swiftSpringScale.value += (0 - this._swiftSpringScale.value) * (1.0 - Math.exp(-speed * dt));
                        this._swiftSpringPos.value += (0 - this._swiftSpringPos.value) * (1.0 - Math.exp(-speed * dt));
                        s = this._swiftSpringScale.value;
                        p = this._swiftSpringPos.value;
                    }
                    else {
                        this._springScale.value += (0 - this._springScale.value) * (1.0 - Math.exp(-speed * dt));
                        this._springPos.value += (0 - this._springPos.value) * (1.0 - Math.exp(-speed * dt));
                        s = this._springScale.value;
                        p = this._springPos.value;
                    }
                    // Stop animation completely when it's virtually invisible
                    if (s < 0.005) {
                        s = 0;
                        p = 0;
                        stopped = true;
                    }
                }
                else {
                    // Use Hooke's law spring physics for opening (creates a nice bounce effect)
                    if (this._swiftAnimation) {
                        stopped = this._swiftSpringScale.update(elapsedMs) && this._swiftSpringPos.update(elapsedMs);
                        s = this._swiftSpringScale.value;
                        p = this._swiftSpringPos.value;
                    }
                    else {
                        stopped = this._springScale.update(elapsedMs) && this._springPos.update(elapsedMs);
                        s = this._springScale.value;
                        p = this._springPos.value;
                    }
                    // Magnet effect: Snap to exactly 1.0 when the bounce is almost settled.
                    if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._swiftAnimation ? this._swiftSpringScale.velocity : this._springScale.velocity) < 0.03) {
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
                    // Start opening from scale 0.2 instead of 0.0 so it looks less jarring
                    currentScale = 0.2 + (s * 0.8);
                    opacity = Math.min(255, Math.max(0, (s / 0.3) * 255));
                }
                // Apply the calculated scale to the UI
                this.animActor.set_scale(currentScale, currentScale);
                /* Remove this code (do in _syncGeometry)
                // Dynamically adjust the shader's corner radius during the animation.
                if (this.effect && typeof this.effect.setCornerRadius === 'function') {
                  let baseRadius = this._settings.get_double('menu-corner-radius');
                  this.effect.setCornerRadius(baseRadius * currentScale);
                  if (typeof this.effect.setAnimationScale === 'function') {
                    this.effect.setAnimationScale(currentScale);
                  }
                }
                */
                this.bgActor.opacity = opacity;
                this.animActor.opacity = opacity;
                // Crucial step: Instantly update geometry right after scaling.
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
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        // Disconnect all event listeners
        for (let sig of this._signals) {
            try {
                if (sig && sig.id)
                    sig.target.disconnect(sig.id);
            }
            catch (e) { }
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
            // Revert UI shifts and forced states
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
        /*
        const messageList = Main.panel.statusArea.dateMenu._messageList;
        if (messageList && "actor" in messageList) {
            messageList.actor.remove_style_class_name('liquid-glass-message-list');
        }
        */
        // Revert UI shifts and forced states when extension is disabled
        this.targetActor.translation_y = 0;
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
        // DESTROY EFFECT FIRST
        if (this.effect) {
            this.effect.cleanup();
            this.effect = null;
        }
        // DESTROY ACTOR SECOND
        if (this.bgActor) {
            this.bgActor.destroy();
            this.bgActor = null;
        }
        this.blurEffect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this._windowClones.clear();
        this._uiSampler?.destroy();
        this._uiSampler = null;
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }
    cleanup() {
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
class SwiftSpring {
    response;
    dampingFraction;
    mass;
    value;
    velocity;
    target;
    constructor(response, dampingFraction, mass = 1.0) {
        // 徹底した型チェックとデフォルト値フォールバック
        this.response = typeof response === 'number' && !isNaN(response) && response > 0.01 ? response : 0.4;
        this.dampingFraction = typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0 ? dampingFraction : 0.7;
        this.mass = typeof mass === 'number' && !isNaN(mass) && mass > 0.01 ? mass : 1.0;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(response, dampingFraction, mass = 1.0) {
        if (typeof response === 'number' && !isNaN(response) && response > 0.01)
            this.response = response;
        if (typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0)
            this.dampingFraction = dampingFraction;
        if (typeof mass === 'number' && !isNaN(mass) && mass > 0.01)
            this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (isNaN(dt) || dt <= 0)
            return false;
        if (dt > 0.1)
            dt = 0.1; // ラグ時のカクつき防止（最大100ms制限）
        // 万が一、現在の状態がすでに NaN 等で壊れていた場合の緊急復帰
        if (isNaN(this.value) || !isFinite(this.value) || isNaN(this.velocity) || !isFinite(this.velocity)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const x0 = this.value - this.target;
        const v0 = this.velocity;
        // すでにターゲットに到達している場合は即座に終了
        if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const omega0 = (2 * Math.PI) / this.response;
        const zeta = this.dampingFraction;
        let x_t = 0;
        let v_t = 0;
        // 数学的な解析解 (Analytical Solution) による1発計算
        // ループによる近似ではないため、バネがどれだけ硬くても絶対に数値爆発（無限大化）しません
        if (zeta < 0.999) {
            // 1. 不足減衰 (Underdamped) - ふわっと跳ねる標準的な動き
            const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
            const alpha = zeta * omega0;
            const exp = Math.exp(-alpha * dt);
            const cos = Math.cos(omegaD * dt);
            const sin = Math.sin(omegaD * dt);
            x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
            v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
        }
        else if (zeta > 1.001) {
            // 2. 過減衰 (Overdamped) - もっさり粘り気のある動き
            const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
            const gamma1 = -zeta * omega0 + beta;
            const gamma2 = -zeta * omega0 - beta;
            const exp1 = Math.exp(gamma1 * dt);
            const exp2 = Math.exp(gamma2 * dt);
            const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
            const c2 = x0 - c1;
            x_t = c1 * exp1 + c2 * exp2;
            v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
        }
        else {
            // 3. 臨界減衰 (Critically damped) - 最速でピッタリ止まる動き
            const exp = Math.exp(-omega0 * dt);
            x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
            v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
        }
        this.value = x_t + this.target;
        this.velocity = v_t;
        // 最終出力の安全確認（値を物理的な常識の範囲「-0.5 〜 2.5」に強制クランプ）
        if (isNaN(this.value) || !isFinite(this.value)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        this.value = Math.max(-0.5, Math.min(2.5, this.value));
        // 停止判定
        if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}
