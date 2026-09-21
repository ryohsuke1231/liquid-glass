// src/uiManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import { UnpickableActor, UILayerSampler, UnpickableWidget, WindowCloneManager, reportFrameLoopError, ensureGlassAllocated, resolveMonitorGeometry, isActorValid, getAllocatedSize, isFrameSyncFrozen, setClipIfChanged, syncGlassCaptureClip, resolveCrossFade, adaptiveColorTweener } from './utils.js';
// ========== Configuration Parameters ==========
// Transparent padding outside the glass area.
// This prevents the shader distortion or rounded corners from being clipped by the actor bounds.
const SHADER_PADDING = 20;
// Adaptive text color flags
const SAMPLE_PER_ELEMENT = false;
// ==============================================
const MIN_MENU_SCALE = 0.5;
const MENU_MEASURE_FRAMES = 30;
let _quickSettingsHeight = 0;
let _quickSettingsWaiting = null;
const MENU_MEASURE_STABLE_FRAMES = 3;
export class UIManager {
    _enableKey;
    _keyPrefix;
    _label;
    _ownsSettingsNamespace;
    extensionPath;
    _settings;
    _logger;
    targetActor;
    menu;
    animActor;
    bgActor;
    effect;
    _cloneContainer = null;
    _windowCloneManager = null;
    _signals;
    _animSignalId = 0;
    _destroySignalId = 0;
    _actorDestroyed = false;
    _frameSyncId;
    // [FIX] Set by cleanup() before anything that can throw. Read by the
    // per-frame BEFORE_REDRAW tick so an orphaned chain stops itself even if
    // cleanup() never reached its laterRemove(). See the note in frameTick().
    _torndown = false;
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _menuScale = 1.0;
    _ownsAccentCss = true;
    _matchQuickSettingsHeight = false;
    _settledHeightScale = null;
    _measuringHeights = false;
    _ownOpenHeight = 0;
    _measureLaterId = 0;
    _restoreQuickSettings = null;
    _tickId;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _hoverSignals = new Map();
    _pendingBackdropRoots = new Set();
    _backdropColored = new Set();
    _applyingColors = false;
    _backdropRefreshId = 0;
    _settingsSignals;
    _isEffectActive;
    _adaptiveConfig;
    liquidBox = null;
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
    _swiftAnimation = false;
    _swiftResponse = 0.3;
    _swiftDampingFraction = 0.65;
    _swiftSpringScale;
    _swiftSpringPos;
    _enableAnimation;
    _interfaceSettings = null;
    _accentColorSignalId = 0;
    _dynamicCssFile = null;
    _cornerRadius = 0;
    _animationInterval = 16;
    _uiSampler = null;
    _lastScreenW;
    _lastScreenH;
    // The uiGroup-direct ancestor of this menu. Kept so the glass can be put
    // back directly beneath it whenever the menu opens — see _restackGlass().
    _menuRoot = null;
    constructor(extensionPath, settings, logger, panelButton = Main.panel.statusArea.dateMenu, ownsAccentCss = true, _enableKey = 'enable-menu-glass', 
    /**
     * GSettings namespace this instance reads its appearance from.
     * The date menu keeps `menu-*`; PanelMenuManager passes
     * `panel-menu` so detected top-bar dropdowns are tuned
     * independently, the way every other surface already is.
     */
    _keyPrefix = 'menu', 
    /**
     * Diagnostic tag. Reaches LiquidEffect's owner, UILayerSampler's
     * log prefix and every clone actor's name, so a journal from a
     * session with several panel menus says which one it is talking
     * about instead of five lines that all read "menu".
     */
    _label = 'menu', _ownsSettingsNamespace = true) {
        this._enableKey = _enableKey;
        this._keyPrefix = _keyPrefix;
        this._label = _label;
        this._ownsSettingsNamespace = _ownsSettingsNamespace;
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._ownsAccentCss = ownsAccentCss;
        this.targetActor = panelButton.menu.actor;
        this.menu = panelButton.menu;
        this.animActor = panelButton.menu.box;
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
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!this._isEffectActive)
                return;
            if (isOpen) {
                this._applyMenuScale();
                this._startAnimation(1); // Target scale: 1.0 (fully open)
            }
            else {
                this._startAnimation(0); // Target scale: 0.0 (closed)
            }
        });
        this._destroySignalId = this.targetActor.connect('destroy', () => {
            this._actorDestroyed = true;
            this._destroySignalId = 0;
            this.cleanup();
        });
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        this._enableAnimation = this._settings.get_boolean(this._animationKey());
        this._menuScale = this._settings.get_double(this._key('scale'));
        this._matchQuickSettingsHeight = this._settings.get_boolean(this._key('match-quick-settings-height'));
        const remembered = this._ownsSettingsNamespace
            ? this._settings.get_double(this._key('settled-height-scale')) : 0;
        this._settledHeightScale = remembered > 0 ? remembered : null;
        this._applyMenuScale();
        this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
        this._springDamping = this._settings.get_double(this._key('spring-damping'));
        this._springMass = this._settings.get_double(this._key('spring-mass'));
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._springPos.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
            // console.log(`[Liquid Glass] System accent color changed.`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._applySystemAccentColor();
                return GLib.SOURCE_REMOVE;
            });
        });
        // 初回実行
        this._applySystemAccentColor();
        if (this._settings.get_boolean(this._enableKey)) {
            this._applyEffect();
        }
    }
    _applySystemAccentColor() {
        if (!this._ownsAccentCss || !this.targetActor)
            return;
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
        // console.log(`[Liquid Glass] Set system accent color to ${colorStr}`);
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
            this._logger.log(`[Liquid Glass] [UIManager] System accent color applied: ${colorStr}`);
        }
        catch (e) {
            this._logger.error(`[Liquid Glass] [UIManager] Failed to apply system accent color: ${e}`);
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
    _allocatedHeightOf(actor) {
        if (!actor || !isActorValid(actor))
            return 0;
        try {
            if (!actor.has_allocation?.())
                return 0;
            const [, allocated] = getAllocatedSize(actor);
            if (allocated > 1)
                return allocated;
        }
        catch (e) { /* no usable allocation */ }
        return 0;
    }
    _firstHeight(actors, measure) {
        for (const actor of actors) {
            const height = measure(actor);
            if (height > 0)
                return height;
        }
        return 0;
    }
    _settleHeight(menu, done) {
        const actor = menu?.actor;
        if (!actor || !isActorValid(actor)) {
            done(0);
            return;
        }
        let framesLeft = MENU_MEASURE_FRAMES;
        let tallest = 0;
        let repeats = 0;
        const tick = () => {
            this._measureLaterId = 0;
            let height = 0;
            try {
                height = this._firstHeight([actor, menu.box], a => this._allocatedHeightOf(a));
            }
            catch (e) { /* measurement failed; caller falls back */ }
            repeats = height > 0 && height === tallest ? repeats + 1 : 0;
            if (height > tallest)
                tallest = height;
            if (repeats < MENU_MEASURE_STABLE_FRAMES && --framesLeft > 0 && !this._torndown) {
                this._measureLaterId = this._addMeasureLater(tick);
                return GLib.SOURCE_REMOVE;
            }
            done(tallest);
            return GLib.SOURCE_REMOVE;
        };
        this._measureLaterId = this._addMeasureLater(tick);
    }
    _addMeasureLater(callback) {
        return global.compositor?.get_laters?.().add(Meta.LaterType.BEFORE_REDRAW, callback) ?? 0;
    }
    _cancelHeightMeasurement() {
        if (this._measureLaterId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._measureLaterId);
            this._measureLaterId = 0;
        }
        const restore = this._restoreQuickSettings;
        this._restoreQuickSettings = null;
        if (restore)
            restore();
    }
    _withQuickSettingsHeight(done) {
        if (_quickSettingsHeight > 0) {
            done(_quickSettingsHeight);
            return;
        }
        if (_quickSettingsWaiting) {
            _quickSettingsWaiting.push(done);
            return;
        }
        const menu = Main.panel.statusArea.quickSettings?.menu;
        const actor = menu?.actor;
        if (!menu || !actor || !isActorValid(actor)) {
            done(0);
            return;
        }
        _quickSettingsWaiting = [done];
        const settle = (height) => {
            _quickSettingsHeight = height;
            const waiting = _quickSettingsWaiting ?? [];
            _quickSettingsWaiting = null;
            for (const callback of waiting)
                callback(height);
        };
        if (menu.isOpen) {
            this._settleHeight(menu, settle);
            return;
        }
        const opacity = actor.opacity;
        let restored = false;
        const restore = () => {
            if (restored)
                return;
            restored = true;
            try {
                menu.close(0);
            }
            catch (e) { /* already gone */ }
            try {
                actor.opacity = opacity;
            }
            catch (e) { /* already gone */ }
        };
        try {
            menu.open(0);
            actor.opacity = 0;
        }
        catch (e) {
            restore();
            settle(0);
            return;
        }
        this._restoreQuickSettings = restore;
        this._settleHeight(menu, height => {
            this._restoreQuickSettings = null;
            restore();
            settle(height);
        });
    }
    _measureHeightScale() {
        if (this._torndown || !this.menu)
            return;
        _quickSettingsHeight = 0;
        this._ownOpenHeight = 0;
        this._withQuickSettingsHeight(() => this._rememberRatioWhenBothKnown());
    }
    _noteOwnOpenedHeight() {
        if (this._torndown || !this._matchQuickSettingsHeight)
            return;
        if (this._measuringHeights || _quickSettingsHeight <= 0)
            return;
        this._measuringHeights = true;
        this._settleHeight(this.menu, height => {
            this._measuringHeights = false;
            if (height > 0) {
                this._ownOpenHeight = height;
                this._rememberRatioWhenBothKnown();
            }
        });
    }
    _rememberRatioWhenBothKnown() {
        if (_quickSettingsHeight <= 0 || this._ownOpenHeight <= 0)
            return;
        const ratio = _quickSettingsHeight / this._ownOpenHeight;
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
            return;
        this._rememberHeightScale(ratio);
        this._applyMenuScale();
    }
    _quickSettingsHeightScale() {
        const quickSettings = Main.panel.statusArea.quickSettings?.menu;
        if (!quickSettings)
            return this._settledHeightScale;
        const targetHeight = this._firstHeight([quickSettings.actor, quickSettings.box], actor => this._allocatedHeightOf(actor));
        const ownHeight = this._firstHeight([this.targetActor, this.animActor], actor => this._allocatedHeightOf(actor));
        if (targetHeight <= 0 || ownHeight <= 0)
            return this._settledHeightScale;
        const ratio = targetHeight / ownHeight;
        if (!Number.isFinite(ratio) || ratio <= 0)
            return this._settledHeightScale;
        this._rememberHeightScale(ratio);
        return ratio;
    }
    _rememberHeightScale(ratio) {
        if (this._settledHeightScale !== null && Math.abs(this._settledHeightScale - ratio) < 0.005)
            return;
        this._settledHeightScale = ratio;
        if (!this._ownsSettingsNamespace)
            return;
        try {
            this._settings.set_double(this._key('settled-height-scale'), ratio);
        }
        catch (e) { /* the cache is an optimisation, never a requirement */ }
    }
    _applyMenuScale() {
        if (!this.targetActor || !isActorValid(this.targetActor))
            return;
        let requested = this._menuScale;
        if (this._matchQuickSettingsHeight) {
            const matched = this._quickSettingsHeightScale();
            if (matched !== null)
                requested = matched;
        }
        const scale = Number.isFinite(requested)
            ? Math.min(1.0, Math.max(MIN_MENU_SCALE, requested))
            : 1.0;
        this.targetActor.set_pivot_point(0.5, 0.0);
        this.targetActor.set_scale(scale, scale);
    }
    _getMenuMonitorGeometry() {
        return resolveMonitorGeometry([this.menu?.sourceActor, this.targetActor]);
    }
    /**
     * Keeps the glass directly beneath the menu it backs.
     *
     * [FIX] This used to pin bgActor just above Main.layoutManager.panelBox,
     * near the BOTTOM of uiGroup, while the menu's own actor sits near the top.
     * Anything added to uiGroup in between therefore painted over the glass but
     * under the menu — most visibly a Dash to Dock container and its own glass,
     * which produced a dropdown whose text and highlights were above the dock
     * while its backdrop was below it. GNOME stacks a panel dropdown above the
     * dock as one piece, and every other manager here already places its glass
     * immediately below its own root; this now matches them.
     *
     * Re-asserted on open because uiGroup's child order is not ours to keep: an
     * indicator, an extension or a dock rebuild that lands after setup() moves
     * relative to us. set_child_below_sibling() is a list splice, and the
     * index check below skips even that whenever the order is already right.
     */
    _restackGlass() {
        const uiGroup = Main.layoutManager.uiGroup;
        const root = this._menuRoot;
        if (!this.bgActor || !root)
            return;
        if (!isActorValid(root) || root.get_parent() !== uiGroup)
            return;
        if (this.bgActor.get_parent() !== uiGroup)
            return;
        const children = uiGroup.get_children();
        const rootIndex = children.indexOf(root);
        if (rootIndex < 0)
            return;
        if (children.indexOf(this.bgActor) === rootIndex - 1)
            return;
        uiGroup.set_child_below_sibling(this.bgActor, root);
    }
    /** Appearance key in this instance's namespace — see _keyPrefix. */
    _key(suffix) {
        return `${this._keyPrefix}-${suffix}`;
    }
    /** The odd one out: the animation switch is named `enable-<surface>-animation`. */
    _animationKey() {
        return `enable-${this._keyPrefix}-animation`;
    }
    // 設定の動的反映
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        // ON/OFF切り替え
        connectSetting(this._enableKey, () => {
            let enabled = this._settings.get_boolean(this._enableKey);
            if (enabled && !this._isEffectActive)
                this._applyEffect();
            else if (!enabled && this._isEffectActive)
                this._removeEffect();
        });
        connectSetting(this._animationKey(), () => {
            this._enableAnimation = this._settings.get_boolean(this._animationKey());
        });
        connectSetting(this._key('spring-stiffness'), () => {
            this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting(this._key('spring-damping'), () => {
            this._springDamping = this._settings.get_double(this._key('spring-damping'));
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting(this._key('spring-mass'), () => {
            this._springMass = this._settings.get_double(this._key('spring-mass'));
            if (this._springScale)
                this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        });
        connectSetting(this._key('animation-interval-ms'), () => {
            this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));
        });
        connectSetting(this._key('tint-color'), () => {
            if (this.effect) {
                let colorArray = this._hexToColorArray(this._settings.get_string(this._key('tint-color')));
                this.effect.setTintColor(...colorArray);
            }
        });
        connectSetting(this._key('tint-strength'), () => {
            if (this.effect) {
                this.effect.setTintStrength(this._settings.get_double(this._key('tint-strength')));
            }
        });
        connectSetting(this._key('blur-radius'), () => {
            if (this.effect) {
                this.effect.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
            }
        });
        connectSetting(this._key('brightness'), () => {
            if (this.effect) {
                this.effect.setBrightness(this._settings.get_double(this._key('brightness')));
            }
        });
        connectSetting(this._key('contrast'), () => {
            if (this.effect) {
                this.effect.setContrast(this._settings.get_double(this._key('contrast')));
            }
        });
        connectSetting(this._key('saturation'), () => {
            if (this.effect) {
                this.effect.setSaturation(this._settings.get_double(this._key('saturation')));
            }
        });
        connectSetting(this._key('corner-radius'), () => {
            if (this.effect) {
                this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
                this.effect.setCornerRadius(this._cornerRadius);
            }
        });
        connectSetting(this._key('glass-expand'), () => {
            if (this.effect) {
                this._glassExpand = this._settings.get_int(this._key('glass-expand'));
            }
        });
        connectSetting(this._key('x-offset'), () => {
            if (this.animActor) {
                this._menuXoffset = this._settings.get_int(this._key('x-offset'));
                this.animActor.translation_x = this._menuXoffset;
            }
        });
        connectSetting(this._key('scale'), () => {
            this._menuScale = this._settings.get_double(this._key('scale'));
            this._applyMenuScale();
        });
        connectSetting(this._key('match-quick-settings-height'), () => {
            this._matchQuickSettingsHeight = this._settings.get_boolean(this._key('match-quick-settings-height'));
            this._applyMenuScale();
            if (this._matchQuickSettingsHeight)
                this._measureHeightScale();
        });
        connectSetting(this._key('y-offset'), () => {
            if (this.animActor) {
                this._menuYoffset = this._settings.get_int(this._key('y-offset'));
                this.animActor.translation_y = this._menuYoffset;
            }
        });
        connectSetting(this._key('enable-adaptive-text-color'), () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean(this._key('enable-adaptive-text-color'));
        });
        connectSetting(this._key('sample-interval-ms'), () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int(this._key('sample-interval-ms'));
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
        // Shift the menu to apply user offsets
        this._menuXoffset = this._settings.get_int(this._key('x-offset'));
        this._menuYoffset = this._settings.get_int(this._key('y-offset'));
        this.animActor.translation_x = this._menuXoffset;
        this.animActor.translation_y = this._menuYoffset;
        this._glassExpand = this._settings.get_int(this._key('glass-expand'));
        this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean(this._key('enable-adaptive-text-color')),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int(this._key('sample-interval-ms')),
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
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        // Insert bgActor below menuRoot in uiGroup to prevent recursive clone loops
        this._menuRoot = menuRoot;
        if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, menuRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }
        // 4. WindowCloneManager: handles wallpaper clone + window actor clones
        this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, `lg-${this._label}`);
        // 5. UILayerSampler: handles uiGroup child clones (panels, notifications, overview, etc.)
        //    Exclude menuRoot and window groups to prevent recursive cloning and BMS loops.
        this._uiSampler = new UILayerSampler(this.bgActor, this.liquidBox, [menuRoot, global.windowGroup, global.window_group], this._cloneContainer, this._label);
        let blurRadius = this._settings.get_int(this._key('blur-radius'));
        let tintColorStr = this._settings.get_string(this._key('tint-color'));
        let tintStrength = this._settings.get_double(this._key('tint-strength'));
        let brightness = this._settings.get_double(this._key('brightness'));
        let contrast = this._settings.get_double(this._key('contrast'));
        let saturation = this._settings.get_double(this._key('saturation'));
        this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
        // Apply our custom GLSL liquid shader to liquidBox (includes built-in dual-Kawase blur)
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings, owner: this._label });
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
        this.bgActor.hide();
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
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
        // Rebuild clones (called on menu open): delegate entirely to WindowCloneManager + UILayerSampler
        let buildClones = () => {
            if (!this.bgActor)
                return;
            // _uiSampler が存在する場合のみ除外リストへの追加処理を行う
            if (this._uiSampler) {
                for (let child of Main.layoutManager.uiGroup.get_children()) {
                    if (child === this.bgActor)
                        continue;
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
            // Before the clones, so this frame's capture already sees the final order.
            this._restackGlass();
            this._windowCloneManager?.rebuildClones();
            this._uiSampler?.rebindSelf();
            this._uiSampler?.refresh();
        };
        // Render loop: called every frame while the menu is visible.
        // The reschedule must survive a throw out of _syncGeometry() — see the
        // comment on DockManager's frameTick: skipping it freezes this glass
        // instance's clones until the menu is closed and reopened.
        let frameTick = () => {
            this._frameSyncId = 0;
            // [FIX] Hard stop after teardown. Every one of these ticks ends by
            // re-adding itself as a BEFORE_REDRAW later, so a cleanup() that does
            // not reach its laterRemove() — because an earlier step threw — leaves
            // a self-rescheduling chain running forever against destroyed actors,
            // holding this whole manager (and its settings and logger) alive. The
            // next enable() then builds a second set on top of a live first set,
            // which is the "the extension can no longer be enabled" symptom.
            // Removing the later is still done in cleanup(); this is the backstop
            // that does not depend on cleanup() getting that far.
            if (this._torndown)
                return GLib.SOURCE_REMOVE;
            if (!this.bgActor || !this.targetActor.mapped)
                return GLib.SOURCE_REMOVE;
            // [DIAG] See setFrameSyncFrozen() in utils.ts. Reschedules but does
            // nothing, so the cost of this poll can be measured directly.
            if (isFrameSyncFrozen()) {
                this._frameSyncId = laterAdd(frameLaterType, frameTick);
                return GLib.SOURCE_REMOVE;
            }
            // Repair the subtree if Clutter has stopped allocating it. Sampled
            // here, at the top of the tick, because the previous frame's relayout
            // has settled by now and this frame's sync has not dirtied anything
            // yet. See ensureGlassAllocated().
            ensureGlassAllocated(this.bgActor);
            try {
                this._syncGeometry();
            }
            catch (e) {
                reportFrameLoopError('UIManager', e);
            }
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
            id: this.menu.connect('open-state-changed', (menu, isOpen) => {
                if (isOpen) {
                    this._queueBackdropRefresh(this.menu?.actor);
                    this._noteOwnOpenedHeight();
                    this._stableBaseW = undefined;
                    this._stableBaseH = undefined;
                    startFrameSync();
                    this._startAdaptiveColorSampling(true);
                }
                else {
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
        // Hover/colour restyles invalidate layout. get_size() then reports the
        // preferred size (including margins), not the body currently on screen.
        // Keep its last allocation until layout commits an actual size change.
        let [inW, inH] = getAllocatedSize(this.animActor);
        let [scaleX, scaleY] = this.animActor.get_scale();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        scaleX = Number.isNaN(scaleX) ? 1.0 : scaleX;
        scaleY = Number.isNaN(scaleY) ? 1.0 : scaleY;
        scaleX *= this.targetActor.get_scale()[0];
        scaleY *= this.targetActor.get_scale()[1];
        this._stableBaseW = Math.round(inW);
        this._stableBaseH = Math.round(inH);
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
            }
            else {
                let monitor = Main.layoutManager.primaryMonitor;
                if (monitor) {
                    animAbsX = (monitor.width / 2) - (w / 2) + this._menuXoffset;
                    animAbsY = (Main.panel.height || 27) + this._menuYoffset;
                }
                else {
                    animAbsX = 0;
                    animAbsY = 0;
                }
            }
        }
        else {
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
                // [PERF] set_clip() queues a redraw unconditionally — see setClipIfChanged().
                setClipIfChanged(this.bgActor, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
                const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
                this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
                // 4. Update shader with full-screen resolution
                this.effect?.setResolution(screenW, screenH);
                // 5. Tell the shader where the menu lives within the full-screen FBO
                //    (matches the dockManager setGlassGeometry pattern)
                this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
                this._lastBgW = bgW;
                this._lastBgH = bgH;
                this._lastBgX = bgX;
                this._lastBgY = bgY;
                this._lastScreenW = screenW;
                this._lastScreenH = screenH;
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
        // [PERF ①/①b] Clip the offscreen CAPTURE to the region this glass can
        // actually show, and hide the clones that fall outside it. Must sit
        // between setGlassGeometry() (which makes the effect's uniforms describe
        // this frame) and the two sync() calls below (which consume the cull
        // rect this sets). See syncGlassCaptureClip() in utils.ts.
        syncGlassCaptureClip({
            cloneContainer: this._cloneContainer,
            effect: this.effect,
            originX: monitorX,
            originY: monitorY,
            uiSampler: this._uiSampler,
            windowCloneManager: this._windowCloneManager,
        });
        this._uiSampler?.sync(monitorX, monitorY, screenW, screenH);
        this._windowCloneManager?.sync();
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
    _setActorColor(actor, color, skipAnimations = false, batchStart) {
        if (!actor || typeof actor.set_style !== 'function')
            return;
        if (!this._styledActors.has(actor)) {
            let origStyle = typeof actor.get_style === 'function' ? actor.get_style() : null;
            this._styledActors.set(actor, origStyle || '');
            actor.connect('destroy', () => {
                adaptiveColorTweener.cancel(actor);
                this._styledActors.delete(actor);
            });
        }
        let isInsensitive = false;
        if (actor instanceof St.Button) {
            isInsensitive = (actor.reactive === false) || (typeof actor.has_style_pseudo_class === 'function' && actor.has_style_pseudo_class('insensitive'));
        }
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive)
            return;
        // A light<->dark flip used to be snapped here, because interpolating the
        // two in RGB passes through the background's own grey and the label
        // disappears mid-tween. _animateActorColor() now cross-dissolves that case
        // instead (see crossFadeColorAt() in utils.ts), so it is animated like any
        // other change.
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;
        this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations, batchStart);
    }
    // Removes all dynamically applied adaptive text color styles and stops related animations
    _clearAdaptiveStyles() {
        for (const [actor, originalStyle] of this._styledActors.entries()) {
            if (actor && typeof actor.set_style === 'function') {
                adaptiveColorTweener.cancel(actor);
                actor._currentTargetColor = undefined;
                actor._currentInsensitiveState = undefined;
                try {
                    actor.remove_style_class_name('adaptive-text-transition');
                    actor.remove_style_class_name('adaptive-color-light');
                    actor.remove_style_class_name('adaptive-color-dark');
                    actor.set_style(originalStyle || null);
                }
                catch (e) { }
            }
        }
        this._styledActors.clear();
        this._backdropColored.clear();
        this._disconnectHoverWatchers();
    }
    _disconnectHoverWatchers() {
        this._pendingBackdropRoots.clear();
        if (this._backdropRefreshId !== 0) {
            if (global.compositor?.get_laters)
                global.compositor.get_laters().remove(this._backdropRefreshId);
            this._backdropRefreshId = 0;
        }
        for (const [actor, id] of this._hoverSignals.entries()) {
            try {
                if (isActorValid(actor))
                    actor.disconnect(id);
            }
            catch (e) { /* the actor took its signals with it */ }
        }
        this._hoverSignals.clear();
    }
    _watchHoverFor(targets) {
        const restyled = new Set(targets);
        for (const target of targets) {
            const holder = target.get_parent?.();
            if (!holder || restyled.has(holder))
                continue;
            if (this._hoverSignals.has(holder) || typeof holder.connect !== 'function')
                continue;
            try {
                this._hoverSignals.set(holder, holder.connect('style-changed', () => {
                    if (this._applyingColors)
                        return;
                    this._queueBackdropRefresh(holder);
                }));
            }
            catch (e) { /* nothing that reports style changes */ }
        }
        for (const [actor, id] of [...this._hoverSignals.entries()]) {
            if (isActorValid(actor))
                continue;
            this._hoverSignals.delete(actor);
            try {
                actor.disconnect(id);
            }
            catch (e) { /* already gone */ }
        }
    }
    _queueBackdropRefresh(root) {
        if (!this._adaptiveConfig.enabled || !this._isEffectActive || this._actorDestroyed)
            return;
        this._pendingBackdropRoots.add(root);
        if (this._backdropRefreshId !== 0)
            return;
        this._backdropRefreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._backdropRefreshId = 0;
            const roots = [...this._pendingBackdropRoots];
            this._pendingBackdropRoots.clear();
            const targets = [];
            for (const actor of roots) {
                if (isActorValid(actor))
                    this._findAllTextActors(actor, targets);
            }
            this._applyBackdropColorsTo(targets);
            return GLib.SOURCE_REMOVE;
        });
    }
    _applyBackdropColorsTo(targets) {
        if (!targets || targets.length === 0)
            return;
        const root = this.menu?.actor ?? null;
        const batchStart = GLib.get_monotonic_time();
        this._applyingColors = true;
        try {
            for (const actor of new Set(targets)) {
                const color = this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, root);
                if (color) {
                    this._backdropColored.add(actor);
                    this._setActorColor(actor, color, true, batchStart);
                }
                else {
                    this._backdropColored.delete(actor);
                }
            }
        }
        finally {
            this._applyingColors = false;
        }
    }
    // Iterates through the color map and applies the new target colors to the respective actors
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        // One timestamp for the whole map. Every actor that flips in this round
        // then runs off the same clock, so a row of labels moves as one instead of
        // each starting whenever its own source first fired.
        const batchStart = GLib.get_monotonic_time();
        this._applyingColors = true;
        try {
            for (const [actor, color] of colorMap.entries()) {
                if (this._backdropColored.has(actor))
                    continue;
                this._setActorColor(actor, color, skipAnimations, batchStart);
            }
        }
        finally {
            this._applyingColors = false;
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
        this._watchHoverFor(targets);
        this._adaptiveInFlight = true;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig, this.menu?.actor)
            .then(colorMap => {
            if (!this._isEffectActive || this._actorDestroyed)
                return;
            this._applyAdaptiveColorMap(colorMap, skipAnimations);
        })
            .catch(e => {
            this._logger.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
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
    _animateActorColor(actor, targetHexColor, isInsensitive, durationMs = 380, skipAnimations = false, batchStart) {
        if (!actor || Object.keys(actor).length === 0)
            return;
        // NOT cancelled here: add() below reads the entry this may already have,
        // so that an interrupted tween restarts from the colour that is actually
        // on screen rather than from a theme node St has not re-resolved yet.
        // The snap path does cancel, because nothing should keep stepping after it.
        const originalStyle = (this._styledActors.get(actor) || '').trim();
        const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let targetRgb = this._hexToRgb(targetHexColor);
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0;
        const apply = (r, g, b, a) => {
            const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            try {
                actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
            }
            catch (e) { }
        };
        if (skipAnimations) {
            adaptiveColorTweener.cancel(actor);
            apply(targetRgb.r, targetRgb.g, targetRgb.b, targetAlpha);
            return;
        }
        const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
        // One shared frame-clock driver, one shared start time per batch — see
        // AdaptiveColorTweener in utils.ts for why this is not a per-actor timer.
        adaptiveColorTweener.add(actor, {
            startRgb, startAlpha,
            targetRgb, targetAlpha,
            crossFade: resolveCrossFade(startRgb, targetRgb),
            durationMs,
            apply,
        }, batchStart);
    }
    // Handles the custom bounce/spring physics when the menu opens or closes
    _startAnimation(targetValue) {
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
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.bgActor)
            this.bgActor.remove_all_transitions();
        if (this._swiftAnimation) {
            this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringPos.updateParams(this._swiftResponse, this._swiftDampingFraction);
            this._swiftSpringScale.target = targetValue;
            this._swiftSpringPos.target = targetValue;
            if (Number.isNaN(this._swiftSpringScale.value))
                this._swiftSpringScale.value = 0;
            if (Number.isNaN(this._swiftSpringPos.value))
                this._swiftSpringPos.value = 0;
        }
        else {
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
                if (dt > 0.033)
                    dt = 0.033;
                let stopped = false;
                let s, p;
                if (isClosing) {
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
                    if (s < 0.005) {
                        s = 0;
                        p = 0;
                        stopped = true;
                    }
                }
                else {
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
                    if (Math.abs(1.0 - s) < 0.002 && Math.abs(this._swiftAnimation ? this._swiftSpringScale.velocity : this._springScale.velocity) < 0.03) {
                        s = 1.0;
                        p = 1.0;
                        stopped = true;
                    }
                }
                let currentScale;
                let opacity;
                if (isClosing) {
                    currentScale = Math.max(0.001, s);
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
        if (!this._actorDestroyed)
            this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (!this._actorDestroyed && this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
            this.animActor.remove_style_class_name('liquid-glass-menu-root');
            this.animActor.translation_x = 0;
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
        if (!this._actorDestroyed) {
            this.targetActor.translation_y = 0;
            this.targetActor.set_scale(1.0, 1.0);
            this.targetActor.opacity = 255;
        }
        if (!this._actorDestroyed && this.menu.actor) {
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
        this._menuRoot = null;
        // Clean up managers (try-catch in their destroy() handles already-destroyed actors)
        this._uiSampler?.destroy();
        this._uiSampler = null;
        this._windowCloneManager?.destroy();
        this._windowCloneManager = null;
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
    }
    // [FIX] Teardown must not be all-or-nothing.
    //
    // These steps used to run bare, one after another, so the first one that
    // threw skipped every step after it — signal handlers, actors, effects and
    // (worst of all) the per-frame later chain stayed alive, and the next
    // enable() built a second set on top. Disabling is exactly when a throw is
    // most likely: the shell is destroying the same actors we are.
    _teardownStep(name, fn) {
        try {
            fn();
        }
        catch (e) {
            try {
                this._logger?.error(`[Liquid Glass] ${this.constructor.name}.${name} failed during cleanup: ${e}`);
            }
            catch (_) {
                console.error(`[Liquid Glass] ${name} failed during cleanup: ${e}`);
            }
        }
    }
    cleanup() {
        this._torndown = true;
        this._teardownStep('heightMeasurement', () => this._cancelHeightMeasurement());
        // The later chain goes first and unconditionally — see _teardownStep().
        this._teardownStep('frameSync', () => {
            if (this._frameSyncId !== 0) {
                if (global.compositor?.get_laters)
                    global.compositor.get_laters().remove(this._frameSyncId);
                this._frameSyncId = 0;
            }
        });
        this._teardownStep('settingsSignals', () => {
            for (let sigId of this._settingsSignals) {
                try {
                    this._settings.disconnect(sigId);
                }
                catch (e) { }
            }
            this._settingsSignals = [];
        });
        // These connections also exist when the global menu effect is disabled,
        // so they cannot be left to _removeEffect() below.
        this._teardownStep('menuSignals', () => {
            if (this._animSignalId) {
                this.menu.disconnect(this._animSignalId);
                this._animSignalId = 0;
            }
            if (this._destroySignalId) {
                this.targetActor.disconnect(this._destroySignalId);
                this._destroySignalId = 0;
            }
            if (this._interfaceSettings && this._accentColorSignalId) {
                this._interfaceSettings.disconnect(this._accentColorSignalId);
                this._accentColorSignalId = 0;
                this._interfaceSettings = null;
            }
        });
        // [FIX] This used to be `if (!this.targetActor) return;`, which skipped
        // _removeEffect() entirely whenever the date menu had gone away —
        // leaving the signal handlers, the glass actors and the per-frame later
        // chain in place across disable().
        this._teardownStep('removeEffect', () => this._removeEffect());
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
        this.stiffness = stiffness;
        this.damping = damping;
        this.mass = mass;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(stiffness, damping, mass) {
        this.stiffness = stiffness;
        this.damping = damping;
        this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (dt > 0.033)
            dt = 0.033;
        let springForce = -this.stiffness * (this.value - this.target);
        let dampingForce = -this.damping * this.velocity;
        let acceleration = (springForce + dampingForce) / this.mass;
        this.velocity += acceleration * dt;
        this.value += this.velocity * dt;
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
            dt = 0.1;
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
        }
        else if (zeta > 1.001) {
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
        }
        else {
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
