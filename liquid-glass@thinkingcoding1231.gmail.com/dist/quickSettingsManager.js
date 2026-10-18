"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuickSettingsManager = void 0;
const toggleStyles_js_1 = require("./quickSettings/toggleStyles.js");
const menuSpring_js_1 = require("./animation/menuSpring.js");
const frameTicker_js_1 = require("./animation/frameTicker.js");
const spring_js_1 = require("./animation/spring.js");
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const 3 = __importDefault(require("gi://Clutter"));
const 4 = __importDefault(require("gi://St"));
const 5 = __importDefault(require("gi://GLib"));
const 6 = __importDefault(require("gi://Meta"));
const backdropGlass_js_1 = require("./rendering/backdropGlass.js");
const toggleGlass_js_1 = require("./rendering/toggleGlass.js");
const contrastSampler_js_1 = require("./contrastSampler.js");
const unpickable_js_1 = require("./actors/unpickable.js");
const allocation_js_1 = require("./actors/allocation.js");
const lifecycle_js_1 = require("./actors/lifecycle.js");
const geometry_js_1 = require("./actors/geometry.js");
const frameLoops_js_1 = require("./animation/frameLoops.js");
const glassBounds_js_1 = require("./actors/glassBounds.js");
const writes_js_1 = require("./actors/writes.js");
const colors_js_1 = require("./animation/colors.js");
const shellVersion_js_1 = require("./shellVersion.js");
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
const SAMPLE_PER_ELEMENT = false;
// Background mode: opacity of the buttons' own backgrounds over the glass.
const BUTTON_ALPHA = 0.8;

function _collectSubmenus(actor, into) {
    if (!actor)
        return;
    if (actor instanceof 4.default.Widget && actor.has_style_class_name('quick-toggle-menu'))
        into.push(actor);
    for (let child of actor.get_children())
        _collectSubmenus(child, into);
}
// Where `actor` is in `ancestor` as laid out, without the transforms of the
// open and close animations, or null when it is not inside it.

function _layoutOrigin(actor, ancestor) {
    let x = 0, y = 0;
    let node = actor;
    for (; node && node !== ancestor; node = node.get_parent()) {
        const box = node.get_allocation_box();
        x += box.x1;
        y += box.y1;
    }
    return node && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function _recordSubmenuNeighbour(n, root, gap) {
    const origin = _layoutOrigin(n, root);
    let [nodeW, nodeH] = (0, geometry_js_1.getAllocatedSize)(n);
    if (!origin || Number.isNaN(nodeW) || Number.isNaN(nodeH) || nodeH <= 5 || nodeW <= 5)
        return false;
    const nodeY = origin[1];
    // The lowest item above the submenu's center and the highest one below it.
    if (nodeY + (nodeH / 2) < gap.subCenterY) {
        if (nodeY + nodeH <= gap.subCenterY && nodeY + nodeH > gap.aboveMaxY)
            gap.aboveMaxY = nodeY + nodeH;
    }
    else if (nodeY >= gap.subCenterY && nodeY < gap.belowMinY) {
        gap.belowMinY = nodeY;
    }
    return true;
}

function _findSubmenuGap(n, submenu, root, gap) {
    if (!n || !n.visible || !n.mapped || n === submenu)
        return;
    if (!n.contains(submenu) && !_recordSubmenuNeighbour(n, root, gap))
        return;
    for (let child of n.get_children())
        _findSubmenuGap(child, submenu, root, gap);
}

class QuickSettingsManager {
    // How many frames toggle mode may reuse its last region set while the grid
    // relays out (see _resolveToggleRegions()).
    static REGION_GRACE_FRAMES = 2;
    _toggleStyles;
    extensionPath;
    _settings;
    _logger;
    targetActor;
    menu;
    animActor;
    // Monitor-sized. In toggle mode it sits inside the menu, which is drawn
    // through an offscreen, and reads the stage through a reader outside the
    // menu (see rendering/toggleGlass.ts).
    glass;
    // Toggle mode. The menu's ancestor that is a direct child of uiGroup, and
    // the zero-size host that puts the glass inside the menu box (see
    // LayoutOpaqueActor).
    _menuRoot = null;
    _toggleGlassHost = null;
    _lastScreenW;
    _lastScreenH;
    _isEffectActive;
    _buttonTimerId;
    _buttonIdleIds = new Set();
    _styledButtons;
    _buttonSignalIds;
    _signals;
    _animSignalId = 0;
    _frameSyncId;
    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }
    _frameSignalId = 0;
    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
    _glassExpand;
    _menuXoffset;
    _menuYoffset;
    _springScale;
    _springStiffness;
    _springDamping;
    _springMass;
    _enableAnimation;
    _tickId;
    _contrastSampler;
    _adaptiveTimerId;
    _adaptiveInFlight;
    _styledActors;
    _backdropColors = new Map();
    _backdropSignals = new Map();
    _sampleColors = new Map();
    _dirtyBackdropRoots = new Set();
    _backdropRefreshId = 0;
    _applyingForeground = false;
    // Incremented when sampling stops, so a late result is dropped.
    _adaptiveGeneration = 0;
    // Set on open until the first sample has colored the text; see
    // _startAdaptiveColorSampling().
    _awaitingOpenColors = false;
    _openSampleId = 0;
    _settingsSignals;
    _adaptiveConfig;
    _stableBaseW;
    _stableBaseH;
    _lastValidAnimAbsX;
    _lastValidAnimAbsY;
    _lastBgW;
    _lastBoundsSpace;
    _lastHostX;
    _lastHostY;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _cornerRadius = 0;
    _animationInterval = 16;
    _cachedSubmenus = null;
    _submenuAfterUpdateId = 0;
    // quick-settings-apply-to, and the mode actually running.
    _applyTo = 'background';
    _activeMode = null;
    // quick-settings-tint-color as normalized [r, g, b].
    _tintColorArray = [1.0, 1.0, 1.0];
    // Toggle mode: how strongly each toggle's own color is applied ("Button
    // base color", quick-settings-toggle-tint-strength), independently of the
    // custom tint strength.
    _toggleBaseStrength = 0.5;
    _toggleCornerRadius = 18.0;
    // The last non-empty region set and how many frames it has been reused;
    // see _resolveToggleRegions().
    _lastGoodRegions = null;
    _regionGraceFrames = 0;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
        this.menu = Main.panel.statusArea.quickSettings.menu;
        this._toggleStyles = new toggleStyles_js_1.ToggleStyles(logger, () => !!this.menu?.isOpen);
        // The menu's content box, which the animations and offsets move.
        this.animActor = Main.panel.statusArea.quickSettings.menu.box;
        this.glass = null;
        this._signals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        this._springScale = new spring_js_1.Spring(120, 8, 1.0);
        this._springStiffness = 120;
        this._springDamping = 8;
        this._springMass = 1.0;
        this._enableAnimation = true;
        this._tickId = 0;
        this._contrastSampler = new contrastSampler_js_1.StageContrastSampler();
        this._adaptiveTimerId = 0;
        this._adaptiveInFlight = false;
        this._styledActors = new Map();
        this._settingsSignals = [];
        this._buttonTimerId = 0;
        this._styledButtons = new Map();
        this._buttonSignalIds = new Map();
    }
    setup() {
        if (!this._settings)
            return;
        this._bindSettings();
        this._enableAnimation = this._settings.get_boolean('enable-quick-settings-animation');
        this._springStiffness = this._settings.get_double('quick-settings-spring-stiffness');
        this._springDamping = this._settings.get_double('quick-settings-spring-damping');
        this._springMass = this._settings.get_double('quick-settings-spring-mass');
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._applyTo = this._settings.get_int('quick-settings-apply-to') === 1 ? 'toggles' : 'background';
        this._toggleBaseStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
        this._toggleCornerRadius = this._settings.get_double('quick-settings-toggle-corner-radius');
        if (this._settings.get_boolean('enable-quick-settings-glass')) {
            this._applyEffect();
        }
    }
    _getMenuMonitorGeometry() {
        return (0, geometry_js_1.resolveMonitorGeometry)([this.menu?.sourceActor, this.targetActor]);
    }
    _applyMenuOffsets() {
        if (!this.targetActor)
            return;
        this.targetActor.translation_y = this._menuYoffset;
        this.targetActor.translation_x = this._menuXoffset;
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
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
            this._tintColorArray = (0, colors_js_1.hexToColorArray)(this._settings.get_string('quick-settings-tint-color'));
            if (this.glass) {
                this.glass.setTintColor(...this._tintColorArray);
            }
        });
        connectSetting('quick-settings-tint-strength', () => {
            if (this.glass) {
                this.glass.setTintStrength(this._settings.get_double('quick-settings-tint-strength'));
            }
        });
        connectSetting('quick-settings-blur-radius', () => {
            if (this.glass) {
                this.glass.setBlurRadius(this._settings.get_int('quick-settings-blur-radius'));
            }
        });
        connectSetting('quick-settings-corner-radius', () => {
            this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
            // Toggle mode uses quick-settings-toggle-corner-radius instead.
            if (this.glass && this._activeMode === 'background') {
                this.glass.setCornerRadius(this._cornerRadius);
            }
        });
        // Rebuilds the effect in the new mode at once.
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
            if (this.glass && this._activeMode === 'toggles') {
                this.glass.setCornerRadius(this._toggleCornerRadius);
            }
        });
        connectSetting('quick-settings-glass-expand', () => {
            if (this.glass) {
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
        connectSetting('quick-settings-adaptive-text-preference', () => {
            this._adaptiveConfig.preference = (0, contrastSampler_js_1.sanitizeColorPreference)(this._settings.get_string('quick-settings-adaptive-text-preference'));
        });
        connectSetting('quick-settings-sample-interval-ms', () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('quick-settings-sample-interval-ms');
        });
        connectSetting('quick-settings-brightness', () => {
            if (this.glass) {
                this.glass.setBrightness(this._settings.get_double('quick-settings-brightness'));
            }
        });
        connectSetting('quick-settings-saturation', () => {
            if (this.glass) {
                this.glass.setSaturation(this._settings.get_double('quick-settings-saturation'));
            }
        });
        connectSetting('quick-settings-contrast', () => {
            if (this.glass) {
                this.glass.setContrast(this._settings.get_double('quick-settings-contrast'));
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
    }
    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        if (!this.targetActor)
            return;
        this._activeMode = this._applyTo;
        this._tintColorArray = (0, colors_js_1.hexToColorArray)(this._settings.get_string('quick-settings-tint-color'));
        if (this._activeMode === 'toggles') {
            this._applyToggleEffect();
        }
        else {
            this._applyBackgroundEffect();
        }
    }
    // Background mode: one sheet of glass behind the whole menu.
    _applyBackgroundEffect() {
        this._menuYoffset = this._settings.get_int('quick-settings-y-offset');
        this._menuXoffset = this._settings.get_int('quick-settings-x-offset');
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._animationInterval = this._settings.get_int('quick-settings-animation-interval-ms');
        this._adaptiveConfig = {
            ...contrastSampler_js_1.AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
            preference: (0, contrastSampler_js_1.sanitizeColorPreference)(this._settings.get_string('quick-settings-adaptive-text-preference')),
        };
        const glass = this._createGlass(false);
        // The menu scales from its top center; the glass follows it by geometry.
        this.animActor.set_pivot_point(0.5, 0.0);
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        // Below the menu, so the glass reads the stage before the menu is drawn.
        if (menuRoot.get_parent() === Main.layoutManager.uiGroup)
            Main.layoutManager.uiGroup.insert_child_below(glass, menuRoot);
        else
            Main.layoutManager.uiGroup.add_child(glass);
        let blurRadius = this._settings.get_int('quick-settings-blur-radius');
        let tintColorStr = this._settings.get_string('quick-settings-tint-color');
        let tintStrength = this._settings.get_double('quick-settings-tint-strength');
        this._cornerRadius = this._settings.get_double('quick-settings-corner-radius');
        let brightness = this._settings.get_double('quick-settings-brightness');
        let saturation = this._settings.get_double('quick-settings-saturation');
        let contrast = this._settings.get_double('quick-settings-contrast');
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...(0, colors_js_1.hexToColorArray)(tintColorStr));
        glass.setTintStrength(tintStrength);
        glass.setCornerRadius(this._cornerRadius);
        glass.setIsDock(false);
        glass.setBrightness(brightness);
        glass.setSaturation(saturation);
        glass.setContrast(contrast);
        glass.setBlurRadius(blurRadius);
        glass.hide();
        const startFrameSync = () => this._startFrameSync(() => this._syncGeometry(), 'QuickSettingsManager', true);
        const stopFrameSync = () => this._stopFrameSync();
        this._signals = [];
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._forgetSubmenus();
                this._applyClassStyles();
                this._applyMenuOffsets();
                this._stableBaseW = undefined;
                this._stableBaseH = undefined;
                startFrameSync();
                // The first colors of an open are applied without a tween.
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
        // The frame loop stops once the menu is fully hidden.
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (!this.menu.actor.mapped) {
                    stopFrameSync();
                    this._forgetSubmenus();
                    if (this.glass) {
                        this.glass.hide();
                        this.glass.opacity = 0;
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
    // The glass starts at 1x1: a 0x0 actor with a shader crashes Cogl.
    _createGlass(toggles) {
        const params = {
            extensionPath: this.extensionPath, settings: this._settings, logger: this._logger,
            owner: toggles ? 'quick-settings-toggles' : 'quick-settings',
        };
        const glass = toggles ? new toggleGlass_js_1.ToggleBackdropGlass(params) : new backdropGlass_js_1.BackdropGlass(params);
        this.glass = glass;
        glass.set_size(1.0, 1.0);
        glass.set_pivot_point(0.0, 0.0);
        return glass;
    }
    // Toggle mode: a piece of glass behind each toggle, drawn as regions of one
    // monitor-sized glass so the copy and the blur are done once per frame.
    // The menu keeps its own look and animation.
    _applyToggleEffect() {
        if (!this.targetActor)
            return;
        this._toggleStyles.resetDiagnostics();
        this._lastGoodRegions = null;
        this._regionGraceFrames = 0;
        this._glassExpand = this._settings.get_int('quick-settings-glass-expand');
        this._toggleBaseStrength = this._settings.get_double('quick-settings-toggle-tint-strength');
        this._toggleCornerRadius = this._settings.get_double('quick-settings-toggle-corner-radius');
        this._adaptiveConfig = {
            ...contrastSampler_js_1.AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
            preference: (0, contrastSampler_js_1.sanitizeColorPreference)(this._settings.get_string('quick-settings-adaptive-text-preference')),
        };
        const glass = this._createGlass(true);
        let menuRoot = this.menu.actor;
        while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
            const p = menuRoot.get_parent();
            if (!p)
                break;
            menuRoot = p;
        }
        this._menuRoot = menuRoot;
        // The glass goes into the menu box itself, below its children, so every
        // toggle's label and icon paint over it. A zero-size host keeps the box
        // from growing to the glass's monitor size (see LayoutOpaqueActor), and
        // _placeToggleHost() counters the box's transform every frame so the
        // glass stays in monitor coordinates.
        if (!this._toggleGlassHost) {
            this._toggleGlassHost = new unpickable_js_1.LayoutOpaqueActor();
            this._toggleGlassHost.set_name('liquid-glass-toggle-host');
        }
        this._toggleGlassHost.add_child(glass);
        this.animActor.insert_child_at_index(this._toggleGlassHost, 0);
        // The glass reads what is behind the menu through a reader painted just
        // before the menu.
        if (menuRoot.get_parent() === Main.layoutManager.uiGroup)
            Main.layoutManager.uiGroup.insert_child_below(glass.reader, menuRoot);
        else
            Main.layoutManager.uiGroup.add_child(glass.reader);
        let blurRadius = this._settings.get_int('quick-settings-blur-radius');
        let tintStrength = this._settings.get_double('quick-settings-tint-strength');
        let brightness = this._settings.get_double('quick-settings-brightness');
        let saturation = this._settings.get_double('quick-settings-saturation');
        let contrast = this._settings.get_double('quick-settings-contrast');
        glass.setPadding(SHADER_PADDING);
        this._tintColorArray = (0, colors_js_1.hexToColorArray)(this._settings.get_string('quick-settings-tint-color'));
        glass.setTintColor(...this._tintColorArray);
        glass.setTintStrength(tintStrength);
        glass.setCornerRadius(this._toggleCornerRadius);
        glass.setIsDock(false);
        glass.setBrightness(brightness);
        glass.setSaturation(saturation);
        glass.setContrast(contrast);
        glass.setBlurRadius(blurRadius);
        glass.setMultiRegionMode(true);
        glass.hide();
        const startFrameSync = () => this._startFrameSync(() => this._syncToggleRegions(), 'QuickSettingsManager(toggles)', false);
        const stopFrameSync = () => this._stopFrameSync();
        this._signals = [];
        // No transparent panel, offsets, animation or button dimming here: the
        // panel keeps its own look, and ToggleStyles owns the toggles' styles.
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._forgetSubmenus();
                startFrameSync();
                this._startAdaptiveColorSampling(true);
                this._toggleStyles.start();
                return;
            }
            this._stopAdaptiveColorSampling();
            this._toggleStyles.stop();
        });
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (!this.menu.actor.mapped) {
                    stopFrameSync();
                    this._forgetSubmenus();
                    if (this.glass) {
                        this.glass.hide();
                        this.glass.opacity = 0;
                    }
                }
            })
        });
        this._updateResolution();
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }
    // Follows the stage's frames while the menu is shown.
    _startFrameSync(sync, errorTag, honourFreeze) {
        if (this._frameSignalId !== 0)
            return;
        (0, frameLoops_js_1.startSyncLoop)(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this.glass && this.targetActor.mapped,
            honourFreeze,
            errorTag,
            step: () => {
                // Checked before this frame's sync dirties anything.
                (0, allocation_js_1.ensureGlassAllocated)(this.glass);
                sync();
            },
        });
    }
    _stopFrameSync() {
        (0, frameLoops_js_1.stopStageLoop)(this._frameSignalSlot, this._frameSlot);
    }
    // The product of the scales of `actor` and all its ancestors;
    // get_scale() reports only an actor's own. BoxPointer.open() scales an
    // ancestor while Quick Settings opens.
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
    // Whether the cached region set may stand in for a frame that produced none.
    _canReuseLastRegions() {
        return this._lastGoodRegions !== null &&
            this._regionGraceFrames < QuickSettingsManager.REGION_GRACE_FRAMES;
    }
    // Uses up one grace frame; once they are spent the cache is dropped and the
    // glass hides.
    _takeLastRegions() {
        if (!this._canReuseLastRegions()) {
            this._lastGoodRegions = null;
            return null;
        }
        this._regionGraceFrames++;
        return this._lastGoodRegions;
    }
    // Every frame in toggle mode. The menu's own actors are left alone.
    _syncToggleRegions() {
        if (!this.glass || !this.targetActor || !this.targetActor.mapped) {
            if (this.glass && this.glass.visible)
                this.glass.hide();
            this._lastGoodRegions = null;
            this._regionGraceFrames = 0;
            return;
        }
        // Everything below is in monitor-local coordinates.
        let monitor = this._getMenuMonitorGeometry();
        let monitorX = monitor?.x ?? 0;
        let monitorY = monitor?.y ?? 0;
        let screenW = Math.max(1, monitor?.width ?? 1);
        let screenH = Math.max(1, monitor?.height ?? 1);
        const [bgPosX, bgPosY] = this._placeToggleHost(this.glass, monitorX, monitorY);
        (0, writes_js_1.setPositionIfChanged)(this.glass, bgPosX, bgPosY);
        const toggles = this._toggleStyles.sync(this.menu?.actor);
        if (toggles.length === 0 && !this._canReuseLastRegions()) {
            this.glass.hide();
            return;
        }
        const layout = this._resolveToggleRegions(this._collectToggleRegions(toggles, monitorX, monitorY));
        if (!layout) {
            this.glass.hide();
            return;
        }
        if (!this.glass.visible)
            this.glass.show();
        // Fade with the menu, which the shell animates on menu.actor's first child.
        this.glass.opacity = this.targetActor.get_first_child()?.opacity ?? 255;
        this.glass.setGlassRegions(layout.regions);
        this._applyToggleBounds(this.glass, layout.minX, layout.minY, layout.maxX - layout.minX, layout.maxY - layout.minY, bgPosX, bgPosY, screenW, screenH);
        // After the geometry setters, so the relays cover this frame's rect.
        this.glass.syncSources();
    }
    /**
     * Keeps the glass host at the bottom of the menu box (the shell reorders
     * the box's children when toggles come and go), and returns the position
     * that puts the glass's origin on the monitor origin despite the box's own
     * position and inherited scale, which is also undone on the glass.
     */
    // Every write here is made only on change: Clutter queues a redraw even
    // for the same value, and the sync runs in before-update, so each write
    // would ask for another frame.
    _placeToggleHost(glass, monitorX, monitorY) {
        if (this.animActor.get_first_child() !== this._toggleGlassHost)
            this.animActor.set_child_below_sibling(this._toggleGlassHost, null);
        let [hostAbsX, hostAbsY] = this._toggleGlassHost.get_transformed_position();
        let [accScaleX, accScaleY] = this._getAccumulatedScale(this._toggleGlassHost);
        if (!Number.isFinite(hostAbsX) || !Number.isFinite(hostAbsY))
            return [monitorX, monitorY];
        // The pivot is (0, 0), so the scale does not move the origin.
        (0, writes_js_1.setScaleIfChanged)(glass, 1.0 / accScaleX, 1.0 / accScaleY);
        return [(monitorX - hostAbsX) / accScaleX, (monitorY - hostAbsY) / accScaleY];
    }
    _collectToggleRegions(toggles, monitorX, monitorY) {
        const layout = { regions: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (let toggle of toggles) {
            if (!toggle.visible || !toggle.mapped)
                continue;
            // The toggle's real on-screen rect, including the scale an ancestor
            // animates while the menu opens.
            let [absX, absY, w, h] = (0, geometry_js_1.getTransformedRect)(toggle);
            if (Number.isNaN(absX) || Number.isNaN(absY) || Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0)
                continue;
            let regionX = (absX - monitorX) - this._glassExpand - SHADER_PADDING;
            let regionY = (absY - monitorY) - this._glassExpand - SHADER_PADDING;
            let regionW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
            let regionH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
            let entry = this._toggleStyles.colorFor(toggle);
            // The toggle's own color is the region's base color, a layer separate
            // from the custom tint. A toggle whose color could not be sampled gets
            // strength 0.
            let hasBase = !!(entry && entry.baseAlpha > 0.02);
            let base = hasBase ? entry.baseColor : this._tintColorArray;
            // Weighted by the pod's coverage: with a theme whose panel is
            // see-through (MacTahoe) a toggle's two states can differ only in
            // alpha. Where the panel is opaque the coverage is always 1.
            let baseStrength = hasBase ? this._toggleBaseStrength * entry.baseAlpha : 0.0;
            layout.regions.push({
                x: regionX, y: regionY, w: regionW, h: regionH,
                tintR: base[0], tintG: base[1], tintB: base[2],
                baseStrength,
            });
            layout.minX = Math.min(layout.minX, regionX);
            layout.minY = Math.min(layout.minY, regionY);
            layout.maxX = Math.max(layout.maxX, regionX + regionW);
            layout.maxY = Math.max(layout.maxY, regionY + regionH);
        }
        return layout;
    }
    // Geometry is read before the pending relayout, so for a frame after a
    // submenu opens or a toggle comes or goes, a toggle can be visible but not
    // yet allocated. The last region set covers such a gap for a couple of
    // frames instead of the glass blinking out.
    _resolveToggleRegions(collected) {
        if (collected.regions.length > 0) {
            this._lastGoodRegions = collected;
            this._regionGraceFrames = 0;
            return collected;
        }
        return this._takeLastRegions();
    }
    _applyToggleBounds(glass, localBgX, localBgY, bgW, bgH, bgPosX, bgPosY, screenW, screenH) {
        if (this._lastBoundsSpace === 'toggles' && this._lastBgW === bgW && this._lastBgH === bgH &&
            this._lastBgX === localBgX && this._lastBgY === localBgY &&
            this._lastHostX === bgPosX && this._lastHostY === bgPosY &&
            this._lastScreenW === screenW && this._lastScreenH === screenH)
            return;
        (0, glassBounds_js_1.placeScreenGlass)(glass, bgPosX, bgPosY, screenW, screenH, { x: localBgX, y: localBgY, w: bgW, h: bgH });
        glass.setResolution(screenW, screenH);
        this._lastBoundsSpace = 'toggles';
        this._lastHostX = bgPosX;
        this._lastHostY = bgPosY;
        this._lastBgW = bgW;
        this._lastBgH = bgH;
        this._lastBgX = localBgX;
        this._lastBgY = localBgY;
        this._lastScreenW = screenW;
        this._lastScreenH = screenH;
    }
    // Every frame in background mode.
    _syncGeometry() {
        if (!this.glass || !this.targetActor || !this.targetActor.mapped) {
            if (this.glass && this.glass.visible)
                this.glass.hide();
            return;
        }
        if (!this.glass.visible)
            this.glass.show();
        if (!this._enableAnimation)
            this.glass.opacity = this.targetActor.get_first_child()?.opacity ?? 255;
        const { w, h, scaleX, scaleY } = this._measurePanel();
        const [animAbsX, animAbsY] = this._resolvePanelOrigin(w);
        let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
        let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
        let bgY = animAbsY - this._glassExpand - SHADER_PADDING;
        if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0) {
            let monitor = this._getMenuMonitorGeometry();
            let monitorX = monitor?.x ?? 0;
            let monitorY = monitor?.y ?? 0;
            let screenW = Math.max(1, monitor?.width ?? 1);
            let screenH = Math.max(1, monitor?.height ?? 1);
            this._applyPanelBounds(this.glass, bgX, bgY, bgW, bgH, monitorX, monitorY, screenW, screenH);
            // After the geometry setters, so the relays cover this frame's rect.
            this.glass.syncSources();
        }
        this._applyGlassScale(scaleX, scaleY);
        this._adjustSubmenuPositions();
    }
    _panelScale() {
        let [scaleX, scaleY] = this.animActor.get_scale();
        if (!this._enableAnimation) {
            // The shell's own animation scales the child of the BoxPointer.
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
        return [scaleX, scaleY];
    }
    _themeMarginSize() {
        let themeNode = this.animActor.get_theme_node();
        return [themeNode.get_margin(4.default.Side.LEFT) + themeNode.get_margin(4.default.Side.RIGHT),
            themeNode.get_margin(4.default.Side.TOP) + themeNode.get_margin(4.default.Side.BOTTOM)];
    }
    _measurePanel() {
        let [inW, inH] = this.animActor.get_size();
        let [outW] = this.targetActor.get_size();
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        const [scaleX, scaleY] = this._panelScale();
        const [marginW, marginH] = this._themeMarginSize();
        let targetW = Math.round(inW);
        let targetH = Math.round(inH);
        // While a hover restyle leaves a relayout pending, the box reports its
        // preferred size including the theme margins; those are taken off.
        if (Math.abs(inW - outW) <= 2 && marginW > 0) {
            targetW = Math.round(inW - marginW);
            targetH = Math.round(inH - marginH);
        }
        this._stableBaseW = targetW;
        this._stableBaseH = targetH;
        // Never below 1px: a 0-size actor with a shader crashes Cogl.
        return {
            w: Math.max(1, this._stableBaseW * scaleX),
            h: Math.max(1, this._stableBaseH * scaleY),
            scaleX,
            scaleY,
        };
    }
    _resolvePanelOrigin(w) {
        return (0, glassBounds_js_1.resolveGlassOrigin)(this.animActor, this, () => {
            // Top center of the primary monitor.
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor)
                return [0, 0];
            return [(monitor.width / 2) - (w / 2), (Main.panel.height || 27) + (this._menuYoffset ?? 0)];
        });
    }
    _applyPanelBounds(glass, bgX, bgY, bgW, bgH, monitorX, monitorY, screenW, screenH) {
        if (this._lastBoundsSpace === 'panel' && this._lastBgW === bgW && this._lastBgH === bgH &&
            this._lastBgX === bgX && this._lastBgY === bgY &&
            this._lastScreenW === screenW && this._lastScreenH === screenH)
            return;
        // Monitor-local, as the shader uses them.
        let localBgX = bgX - monitorX;
        let localBgY = bgY - monitorY;
        (0, glassBounds_js_1.placeScreenGlass)(glass, monitorX, monitorY, screenW, screenH, { x: localBgX, y: localBgY, w: bgW, h: bgH });
        glass.setShadowMaxRadius(glassBounds_js_1.GLASS_SHADOW_MAX_RADIUS);
        glass.setResolution(screenW, screenH);
        glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);
        this._lastBoundsSpace = 'panel';
        this._lastBgW = bgW;
        this._lastBgH = bgH;
        this._lastBgX = bgX;
        this._lastBgY = bgY;
        this._lastScreenW = screenW;
        this._lastScreenH = screenH;
    }
    _applyGlassScale(scaleX, scaleY) {
        (0, glassBounds_js_1.applyGlassScale)(this.glass, this._cornerRadius, scaleX, scaleY);
    }
    _updateResolution() {
        if (!this.glass)
            return;
        let [width, height] = this.glass.get_size();
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            this.glass.setResolution(width, height);
        }
    }
    _hasStyleClass(actor, className) {
        return actor instanceof 4.default.Widget && actor.has_style_class_name(className);
    }
    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(this.menu?.actor);
    }
    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        if (actor instanceof 4.default.Label || actor instanceof 3.default.Text ||
            actor instanceof 4.default.Button || actor instanceof 4.default.Icon) {
            if (actor.visible)
                foundActors.push(actor);
        }
        for (const child of actor.get_children())
            this._findAllTextActors(child, foundActors);
        return foundActors;
    }
    _setActorColor(actor, color, skipAnimations = false, batchStart) {
        // Clutter.Text targets have no St style.
        if (!(actor instanceof 4.default.Widget))
            return;
        if (!this._styledActors.has(actor)) {
            this._styledActors.set(actor, actor.get_style() || '');
            actor.connect('destroy', () => {
                colors_js_1.adaptiveColorTweener.cancel(actor);
                this._styledActors.delete(actor);
            });
        }
        let isInsensitive = false;
        if (actor instanceof 4.default.Button) {
            isInsensitive = !actor.reactive || actor.has_style_pseudo_class('insensitive');
        }
        if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive)
            return;
        actor._currentTargetColor = color;
        actor._currentInsensitiveState = isInsensitive;
        this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations, batchStart);
    }
    _clearAdaptiveStyles() {
        this._clearBackdropTracking();
        for (const [actor, originalStyle] of this._styledActors.entries()) {
            colors_js_1.adaptiveColorTweener.cancel(actor);
            actor._currentTargetColor = undefined;
            actor._currentInsensitiveState = undefined;
            actor.set_style(originalStyle || null);
        }
        this._styledActors.clear();
    }
    // Text sitting on an opaque backdrop of its own (a row's highlight, an
    // expanded section) takes its color from that backdrop instead of the
    // sample; see _watchBackdrop().
    _applyAdaptiveColorMap(colorMap, skipAnimations = false) {
        if (!colorMap || colorMap.size === 0)
            return;
        this._sampleColors = colorMap;
        // One timestamp for the whole map, so the toggles flip together.
        const batchStart = 5.default.get_monotonic_time();
        for (const [actor, color] of colorMap.entries()) {
            if (!this._backdropColors.has(actor)) {
                this._watchBackdrop(actor);
                this._backdropColors.set(actor, this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, this.menu.actor));
            }
            const backdrop = this._backdropColors.get(actor);
            this._setActorColor(actor, backdrop ?? color, backdrop !== null || skipAnimations, batchStart);
        }
    }
    // Watches the text's ancestors, whose restyles can change its backdrop.
    _watchBackdrop(actor) {
        for (let node = actor; node; node = node.get_parent()) {
            const holder = node;
            if (holder instanceof 4.default.Widget && !this._backdropSignals.has(holder)) {
                this._backdropSignals.set(holder, [
                    holder.connect('style-changed', () => {
                        if (!this._applyingForeground)
                            this._queueBackdropColors(holder);
                    }),
                    holder.connect('notify::parent', () => {
                        this._watchBackdrop(holder);
                        this._queueBackdropColors(holder);
                    }),
                    holder.connect('destroy', () => {
                        this._backdropSignals.delete(holder);
                        this._backdropColors.delete(holder);
                        this._sampleColors.delete(holder);
                        this._dirtyBackdropRoots.delete(holder);
                    }),
                ]);
            }
            if (holder === this.menu.actor)
                break;
        }
    }
    _queueBackdropColors(root) {
        if (!this.menu?.isOpen || !this._adaptiveConfig.enabled)
            return;
        this._dirtyBackdropRoots.add(root);
        if (this._backdropRefreshId)
            return;
        this._backdropRefreshId = global.compositor.get_laters().add(6.default.LaterType.BEFORE_REDRAW, () => {
            this._backdropRefreshId = 0;
            const dirty = new Set(this._dirtyBackdropRoots);
            this._dirtyBackdropRoots.clear();
            if (!this.menu?.isOpen || !this._adaptiveConfig.enabled)
                return 5.default.SOURCE_REMOVE;
            for (const [actor, fallback] of this._sampleColors) {
                for (let node = actor; node; node = node.get_parent()) {
                    if (dirty.has(node)) {
                        const color = this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, this.menu.actor);
                        this._backdropColors.set(actor, color);
                        this._setActorColor(actor, color ?? fallback, true);
                        break;
                    }
                    if (node === this.menu.actor)
                        break;
                }
            }
            return 5.default.SOURCE_REMOVE;
        });
    }
    _clearBackdropTracking() {
        this._adaptiveGeneration++;
        if (this._backdropRefreshId)
            global.compositor.get_laters().remove(this._backdropRefreshId);
        this._backdropRefreshId = 0;
        for (const [actor, ids] of this._backdropSignals) {
            for (const id of ids)
                actor.disconnect(id);
        }
        this._backdropSignals.clear();
        this._backdropColors.clear();
        this._sampleColors.clear();
        this._dirtyBackdropRoots.clear();
    }
    /**
     * @param skipAnimations Set on open: the first sample is taken before the
     *   first frame, before the glass is drawn, from the bare backdrop where the
     *   panel will be, and its colors are applied without a tween and kept
     *   while the open animation runs. The last open's decision is forgotten.
     */
    _startAdaptiveColorSampling(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled)
            return;
        if (skipAnimations) {
            this._contrastSampler.reset();
            this._awaitingOpenColors = true;
            // From GNOME 51 on, open-state-changed comes before the panel is shown
            // and placed; this runs once open() has returned, still ahead of the frame.
            if (this._openSampleId === 0) {
                this._openSampleId = 5.default.idle_add(5.default.PRIORITY_HIGH, () => {
                    this._openSampleId = 0;
                    this._updateAdaptiveTextColors(true);
                    return 5.default.SOURCE_REMOVE;
                });
            }
        }
        else {
            this._updateAdaptiveTextColors(false);
        }
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = 5.default.timeout_add(5.default.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            if (!this.menu?.isOpen) {
                this._adaptiveTimerId = 0;
                return 5.default.SOURCE_REMOVE;
            }
            const opening = this._tickId !== 0;
            if (!opening || this._awaitingOpenColors)
                this._updateAdaptiveTextColors(this._awaitingOpenColors);
            return 5.default.SOURCE_CONTINUE;
        });
    }
    _stopAdaptiveColorSampling() {
        this._clearBackdropTracking();
        if (this._adaptiveTimerId !== 0) {
            5.default.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
        if (this._openSampleId !== 0) {
            5.default.source_remove(this._openSampleId);
            this._openSampleId = 0;
        }
    }
    _updateAdaptiveTextColors(skipAnimations = false) {
        if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
            return;
        const targets = this._collectAdaptiveTextTargets();
        if (targets.length === 0)
            return;
        this._adaptiveInFlight = true;
        const generation = this._adaptiveGeneration;
        this._contrastSampler
            .chooseColorsForActors(targets, this._adaptiveConfig, this.menu?.actor,
        // In toggle mode the text is not drawn over the glass, so the glass's
        // paint count says nothing about the sampled pixels.
        () => this._activeMode === 'background' ? this.glass?.paintCount ?? NaN : NaN,
        // Only the whole-panel glass copies what is behind it.
        () => this._activeMode === 'background' && this.glass instanceof backdropGlass_js_1.BackdropGlass ? [this.glass] : [])
            .then(colorMap => {
            if (generation !== this._adaptiveGeneration || !this._adaptiveConfig.enabled)
                return;
            this._applyAdaptiveColorMap(colorMap, skipAnimations);
            if (colorMap.size > 0)
                this._awaitingOpenColors = false;
        })
            .catch(e => {
            this._logger.error(`[Liquid Glass] Quick Settings adaptive color update failed: ${e}`);
        })
            .finally(() => {
            this._adaptiveInFlight = false;
        });
    }
    _animateActorColor(actor, targetHexColor, isInsensitive, durationMs = 380, skipAnimations = false, batchStart) {
        let themeNode = actor.get_theme_node();
        let startColor = themeNode.get_foreground_color();
        let targetRgb = (0, colors_js_1.hexToRgb)(targetHexColor);
        // Insensitive items keep their dimmed look.
        let targetAlpha = isInsensitive ? 0.5 : 1.0;
        let startAlpha = startColor.alpha / 255.0;
        // Replaces only the color rules, keeping whatever else the button alpha
        // dimming has put in the inline style.
        const apply = (r, g, b, a) => {
            const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
            const base = (actor.get_style() || '').split(';')
                .filter(rule => !/^\s*(color|-st-icon-foreground-color)\s*:/.test(rule)).join(';').trim();
            // set_style() emits style-changed synchronously; see _watchBackdrop().
            this._applyingForeground = true;
            actor.set_style(`${base}${base.endsWith(';') || !base ? '' : ';'} color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
            this._applyingForeground = false;
        };
        // An existing tween is not cancelled: add() restarts from the color it
        // last applied.
        if (skipAnimations) {
            colors_js_1.adaptiveColorTweener.cancel(actor);
            apply(targetRgb.r, targetRgb.g, targetRgb.b, targetAlpha);
            return;
        }
        const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
        colors_js_1.adaptiveColorTweener.add(actor, {
            startRgb, startAlpha,
            targetRgb, targetAlpha,
            crossFade: (0, colors_js_1.resolveCrossFade)(startRgb, targetRgb),
            durationMs,
            apply,
        }, batchStart);
    }
    // Background mode dims the buttons' own backgrounds to BUTTON_ALPHA, and
    // keeps doing so as their state changes.
    _findAllButtons(actor, foundButtons = []) {
        if (!actor)
            return foundButtons;
        let isQuickSlider = false;
        let isToggleContainer = false;
        let isButton = actor instanceof 4.default.Button;
        if (actor instanceof 4.default.Widget) {
            isQuickSlider = actor.has_style_class_name('quick-slider');
            isToggleContainer = actor.has_style_class_name('quick-toggle');
        }
        if (actor.visible && !isQuickSlider) {
            if (isButton || isToggleContainer)
                foundButtons.push(actor);
        }
        for (const child of actor.get_children())
            this._findAllButtons(child, foundButtons);
        return foundButtons;
    }
    _hasColoredToggleChild(button) {
        if (!(button instanceof 4.default.Widget) || !button.has_style_class_name('quick-toggle'))
            return false;
        for (const child of button.get_children()) {
            if (!(child instanceof 4.default.Widget))
                continue;
            if (child.get_theme_node().get_background_color().alpha > 0)
                return true;
        }
        return false;
    }
    _applyButtonAlpha(button, targetAlpha) {
        const origStyle = this._styledButtons.get(button) || '';
        button.set_style(origStyle || null);
        button.ensure_style();
        const bgColor = button.get_theme_node().get_background_color();
        // A toggle whose child button is colored (checked) hides its own
        // background, which would otherwise darken the child's.
        if (this._hasColoredToggleChild(button)) {
            button.set_style(origStyle
                ? `${origStyle} background-color: transparent !important;`
                : 'background-color: transparent !important;');
            return;
        }
        // Buttons without a background of their own stay that way.
        if (bgColor.alpha === 0)
            return;
        const rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
        button.set_style(origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`);
        // The parent toggle depends on this button's state.
        const parent = button.get_parent();
        if (parent instanceof 4.default.Widget && parent.has_style_class_name('quick-toggle'))
            this._updateSingleButtonAlpha(parent, targetAlpha);
    }
    // Keeps the adaptive text color rules while the background is re-applied.
    _updateSingleButtonAlpha(button, targetAlpha) {
        if (!button || button._isUpdatingAlpha)
            return;
        button._isUpdatingAlpha = true;
        const foreground = this._styledActors.has(button) ? (button.get_style() || '').split(';')
            .filter(rule => /^\s*(color|-st-icon-foreground-color)\s*:/.test(rule)).join(';') : '';
        this._applyButtonAlpha(button, targetAlpha);
        if (foreground) {
            const base = (button.get_style() || '').split(';')
                .filter(rule => !/^\s*(color|-st-icon-foreground-color)\s*:/.test(rule)).join(';');
            button.set_style(`${base};${foreground};`);
        }
        button._isUpdatingAlpha = false;
    }
    _updateButtonAlpha() {
        if (!this.menu?.isOpen)
            return;
        const buttons = this._findAllButtons(this.menu?.actor);
        if (buttons.length === 0)
            return;
        const targetAlpha = BUTTON_ALPHA;
        for (let button of buttons) {
            if (!this._styledButtons.has(button)) {
                if (button instanceof 4.default.Widget) {
                    let origStyle = this._styledActors.get(button) ?? button.get_style();
                    this._styledButtons.set(button, origStyle || '');
                }
                // After the state change has restyled the button.
                const updateHandler = () => {
                    if (!this.menu?.isOpen)
                        return;
                    const id = 5.default.idle_add(5.default.PRIORITY_DEFAULT, () => {
                        this._buttonIdleIds.delete(id);
                        this._updateSingleButtonAlpha(button, targetAlpha);
                        return 5.default.SOURCE_REMOVE;
                    });
                    this._buttonIdleIds.add(id);
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
            this._updateSingleButtonAlpha(button, targetAlpha);
        }
    }
    _startButtonAlphaSampling() {
        this._updateButtonAlpha();
        if (this._buttonTimerId !== 0)
            return;
        this._buttonTimerId = 5.default.timeout_add(5.default.PRIORITY_DEFAULT, 400, () => {
            if (!this.menu?.isOpen) {
                this._buttonTimerId = 0;
                return 5.default.SOURCE_REMOVE;
            }
            this._updateButtonAlpha();
            return 5.default.SOURCE_CONTINUE;
        });
    }
    _stopButtonAlphaSampling() {
        if (this._buttonTimerId !== 0) {
            5.default.source_remove(this._buttonTimerId);
            this._buttonTimerId = 0;
        }
        for (const id of this._buttonIdleIds)
            5.default.Source.remove(id);
        this._buttonIdleIds.clear();
    }
    _clearButtonStyles() {
        this._stopButtonAlphaSampling();
        this._disconnectButtonSignals();
        for (const [button, originalStyle] of this._styledButtons.entries()) {
            if (button instanceof 4.default.Widget)
                button.set_style(originalStyle || null);
        }
        this._styledButtons.clear();
    }
    _disconnectButtonSignals() {
        for (const [button, signalIds] of this._buttonSignalIds.entries()) {
            for (const id of signalIds)
                button.disconnect(id);
        }
        this._buttonSignalIds.clear();
    }
    // The spring open/close animation.
    _startAnimation(targetValue) {
        if (this._tickId !== 0) {
            (0, frameTicker_js_1.removeFrameTicker)(this._tickId);
            this._tickId = 0;
        }
        if (!this._enableAnimation) {
            (0, menuSpring_js_1.showMenuAtRest)(this.glass, this.animActor);
            return;
        }
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.glass)
            this.glass.remove_all_transitions();
        this._springScale.target = targetValue;
        if (this._tickId === 0) {
            let lastTime = 5.default.get_monotonic_time();
            this._tickId = (0, frameTicker_js_1.addFrameTicker)(() => {
                if (!this.glass || !this.targetActor) {
                    this._tickId = 0;
                    return 5.default.SOURCE_REMOVE;
                }
                let currentTime = 5.default.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;
                const frame = (0, menuSpring_js_1.stepMenuSpring)(this._springScale, elapsedMs);
                if (frame.stopped)
                    this._tickId = 0;
                (0, menuSpring_js_1.applyMenuFrame)(frame, this.animActor, this.glass, this.menu.actor, () => this._syncGeometry());
                return frame.stopped ? 5.default.SOURCE_REMOVE : 5.default.SOURCE_CONTINUE;
            }, (0, frameTicker_js_1.normalizeAnimationIntervalMs)(this._animationInterval));
        }
    }
    // Centers an open submenu horizontally in the menu and vertically in the
    // gap between the items above and below it. Everything is measured as laid
    // out in the menu's BoxPointer, which holds both the panel and the
    // submenus: the panel's scale while it opens would skew the result, and so
    // would the shell's own offset for the submenus, which it reads with that
    // scale applied.
    _adjustSubmenuPositions() {
        if (!this.menu?.isOpen || !this.animActor)
            return;
        if (!this._cachedSubmenus) {
            this._cachedSubmenus = [];
            _collectSubmenus(this.menu.actor, this._cachedSubmenus);
            // The frame loop reads the layout before it is updated, and the last
            // change (the shell moving its submenus, a submenu taking its final
            // height) may come with no frame after it; so every frame checks again
            // once its layout is done.
            this._submenuAfterUpdateId = global.stage.connect('after-update', () => this._adjustSubmenuPositions());
        }
        const root = this.targetActor;
        const parent = _layoutOrigin(this.animActor, root);
        let [parentW, parentH] = (0, geometry_js_1.getAllocatedSize)(this.animActor);
        if (!parent || Number.isNaN(parentW) || Number.isNaN(parentH) || parentW <= 0 || parentH <= 0)
            return;
        for (let submenu of this._cachedSubmenus)
            this._centerSubmenu(submenu, root, parent, parentW, parentH);
    }
    _centerSubmenu(submenu, root, [parentX, parentY], parentW, parentH) {
        if (!submenu.mapped || !submenu.visible)
            return;
        const origin = _layoutOrigin(submenu, root);
        let [subW, subH] = (0, geometry_js_1.getAllocatedSize)(submenu);
        if (!origin || Number.isNaN(subW) || Number.isNaN(subH) || subW <= 0 || subH <= 0)
            return;
        const [subX, subY] = origin;
        const translationX = parentX + (parentW - subW) / 2 - subX;
        if (Math.abs(submenu.translation_x - translationX) > 0.5)
            submenu.translation_x = translationX;
        const gap = { subCenterY: subY + (subH / 2), aboveMaxY: parentY, belowMinY: parentY + parentH };
        for (let child of this.animActor.get_children())
            _findSubmenuGap(child, submenu, root, gap);
        const translationY = (gap.aboveMaxY + gap.belowMinY) / 2 - (subH / 2) - subY;
        // Sub-pixel changes are ignored so it cannot jitter.
        if (Math.abs(submenu.translation_y - translationY) > 0.5)
            submenu.translation_y = translationY;
    }
    _forgetSubmenus() {
        if (this._submenuAfterUpdateId)
            global.stage.disconnect(this._submenuAfterUpdateId);
        this._submenuAfterUpdateId = 0;
        this._cachedSubmenus = null;
    }
    _clearSubmenuFix() {
        let foundMenus = this._cachedSubmenus || [];
        if (foundMenus.length === 0 && this.menu?.actor)
            _collectSubmenus(this.menu.actor, foundMenus);
        for (let submenu of foundMenus)
            submenu.set_translation(0, 0, 0);
        this._forgetSubmenus();
    }
    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        this._clearButtonStyles();
        this._clearSubmenuFix();
        this._toggleStyles.clear();
        this._disconnectEffectSignals();
        this._restoreMenuActors();
        const glass = this.glass;
        this.glass = null;
        if (glass) {
            glass.cleanup();
            // At shell shutdown the stage may have destroyed it already.
            if ((0, lifecycle_js_1.isActorValid)(glass))
                glass.destroy();
        }
        // The toggle-mode host is the glass's parent, not destroyed with it.
        if (this._toggleGlassHost) {
            if ((0, lifecycle_js_1.isActorValid)(this._toggleGlassHost))
                this._toggleGlassHost.destroy();
            this._toggleGlassHost = null;
        }
        this._stableBaseW = undefined;
        this._stableBaseH = undefined;
        this._lastScreenW = undefined;
        this._lastScreenH = undefined;
        this._lastBgW = undefined;
        this._lastBoundsSpace = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
        this._activeMode = null;
    }
    _disconnectEffectSignals() {
        for (let sig of this._signals)
            sig.target.disconnect(sig.id);
        this._signals = [];
        if (this._animSignalId) {
            this.menu.disconnect(this._animSignalId);
            this._animSignalId = 0;
        }
        if (this._tickId !== 0) {
            (0, frameTicker_js_1.removeFrameTicker)(this._tickId);
            this._tickId = 0;
        }
        this._stopFrameSync();
    }
    _restoreMenuActors() {
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        if (this.animActor) {
            this.animActor.remove_style_class_name('liquid-glass-transparent');
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
                this.menu.close(shellVersion_js_1.MENU_NO_ANIMATION);
        }
    }
    cleanup() {
        this._stopFrameSync();
        for (let sigId of this._settingsSignals)
            this._settings.disconnect(sigId);
        this._settingsSignals = [];
        this._removeEffect();
    }
}
exports.QuickSettingsManager = QuickSettingsManager;
