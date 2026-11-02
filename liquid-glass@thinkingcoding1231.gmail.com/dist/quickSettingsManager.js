import { ToggleStyles, ToggleBackdropGlass } from './quickSettingsToggles.js';
import { stepMenuSpring, applyMenuFrame, showMenuAtRest, Spring, addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs, startSyncLoop, stopStageLoop, MenuMorphMotion, ToggleIntro, resolveCrossFade, adaptiveColorTweener, hexToColorArray, hexToRgb } from './animation.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { ContentLens } from './rendering/pipelines.js';
import { StageContrastSampler, AdaptiveContrastConfig, sanitizeColorPreference } from './contrastSampler.js';
import { LayoutOpaqueActor, ensureGlassAllocated, isActorValid, resolveMonitorGeometry, getAllocatedSize, getTransformedRect, placeScreenGlass, resolveGlassOrigin, applyGlassScale, GLASS_SHADOW_MAX_RADIUS, setPositionIfChanged, setScaleIfChanged } from './actors.js';
import { MENU_NO_ANIMATION } from './shellVersion.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
const SAMPLE_PER_ELEMENT = false;
// Background mode: opacity of the buttons' own backgrounds over the glass.
const BUTTON_ALPHA = 0.8;
// Frames to wait for an opening menu to get its size before it just appears.
const MORPH_WAIT_FRAMES = 30;
// The most the toggle-mode opening moves on from one frame to the next (s): after its first frame, and later.
const INTRO_FIRST_STEP_S = 1 / 60;
const INTRO_MAX_STEP_S = 1 / 30;
// The menu's own open and close animations, which the morph replaces. Its
// closing fade would hide the items and then the menu long before the glass is
// back in the button, so the fade is held and the menu is hidden by the morph.
const BOXPOINTER_EASED = ['opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y'];
const BOXPOINTER_HOLD_MS = 10000;
const CONTENT_LENS = 'liquid-glass-content-lens';
// What the refraction (displacement scale) and the blur radius come down to,
// whatever they are set to, as the closing glass settles on the button.
const SOFT_REFRACTION = 0.3;
const SOFT_BLUR_RADIUS = 0;

function _collectSubmenus(actor, into) {
    if (!actor)
        return;
    if (actor instanceof St.Widget && actor.has_style_class_name('quick-toggle-menu'))
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
    let [nodeW, nodeH] = getAllocatedSize(n);
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

export class QuickSettingsManager {
    _enableKey;
    _keyPrefix;
    _label;
    _ownsSettingsNamespace;
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
    // menu (see quickSettingsToggles.ts).
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
    // Toggle mode's own animation; see _startIntro().
    _toggleAnimation = false;
    _growFromButton = true;
    _morph = null;
    // Multi Monitors Bar opens this menu from its own bar's button and hands it back to the main bar's button as it
    // closes, so the glass closes into the button it opened from.
    _openedFrom = null;
    _morphTickId = 0;
    _morphSpeed = 1.0;
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
    _actorDestroyed = false;
    _destroySignalId = 0;
    // Toggle mode's opening, while it runs and until the menu is hidden.
    _intro = null;
    // The last non-empty region set and how many frames it has been reused;
    // see _resolveToggleRegions().
    _lastGoodRegions = null;
    _regionGraceFrames = 0;

    constructor(extensionPath, settings, logger, _enableKey = 'enable-quick-settings-glass', _keyPrefix = 'quick-settings', _label = 'quick-settings', _ownsSettingsNamespace = true) {
        this._enableKey = _enableKey;
        this._keyPrefix = _keyPrefix;
        this._label = _label;
        this._ownsSettingsNamespace = _ownsSettingsNamespace;
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this.targetActor = Main.panel.statusArea.quickSettings.menu.actor;
        this.menu = Main.panel.statusArea.quickSettings.menu;
        this._toggleStyles = new ToggleStyles(logger, () => !!this.menu?.isOpen);
        // The menu's content box, which the animations and offsets move.
        this.animActor = Main.panel.statusArea.quickSettings.menu.box;
        this.glass = null;
        this._signals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
        this._glassExpand = 0;
        this._menuXoffset = 0;
        this._menuYoffset = 0;
        this._springScale = new Spring(120, 8, 1.0);
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
        this._buttonTimerId = 0;
        this._styledButtons = new Map();
        this._buttonSignalIds = new Map();
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
        this._toggleAnimation = this._settings.get_boolean(this._key('toggle-animation'));
        this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
        this._springDamping = this._settings.get_double(this._key('spring-damping'));
        this._springMass = this._settings.get_double(this._key('spring-mass'));
        this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
        this._growFromButton = this._settings.get_boolean(this._key('grow-from-button'));
        this._morphSpeed = this._settings.get_double(this._key('morph-speed'));
        this._applyTo = this._settings.get_int(this._key('apply-to')) === 1 ? 'toggles' : 'background';
        this._toggleBaseStrength = this._settings.get_double(this._key('toggle-tint-strength'));
        this._toggleCornerRadius = this._settings.get_double(this._key('toggle-corner-radius'));
        if (this._settings.get_boolean(this._enableKey)) {
            this._applyEffect();
        }
    }

    // A key in this instance's settings namespace; see _keyPrefix.
    _key(suffix) {
        return `${this._keyPrefix}-${suffix}`;
    }

    // The animation switch is named `enable-<prefix>-animation`.
    _animationKey() {
        return `enable-${this._keyPrefix}-animation`;
    }

    _getMenuMonitorGeometry() {
        return resolveMonitorGeometry([this.menu?.sourceActor, this.targetActor]);
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
        connectSetting(this._key('toggle-animation'), () => {
            this._toggleAnimation = this._settings.get_boolean(this._key('toggle-animation'));
        });
        connectSetting(this._key('grow-from-button'), () => {
            this._growFromButton = this._settings.get_boolean(this._key('grow-from-button'));
        });
        connectSetting(this._key('morph-speed'), () => {
            this._morphSpeed = this._settings.get_double(this._key('morph-speed'));
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
            this._tintColorArray = hexToColorArray(this._settings.get_string(this._key('tint-color')));
            if (this.glass) {
                this.glass.setTintColor(...this._tintColorArray);
            }
        });
        connectSetting(this._key('tint-strength'), () => {
            if (this.glass) {
                this.glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
            }
        });
        connectSetting(this._key('blur-radius'), () => {
            if (this.glass) {
                this.glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
            }
        });
        connectSetting(this._key('corner-radius'), () => {
            this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
            // Toggle mode uses quick-settings-toggle-corner-radius instead.
            if (this.glass && this._activeMode === 'background') {
                this.glass.setCornerRadius(this._cornerRadius);
            }
        });
        // Rebuilds the effect in the new mode at once.
        connectSetting(this._key('apply-to'), () => {
            const newMode = this._settings.get_int(this._key('apply-to')) === 1 ? 'toggles' : 'background';
            this._applyTo = newMode;
            if (this._isEffectActive && this._activeMode !== null && this._activeMode !== newMode) {
                this._removeEffect();
                this._applyEffect();
            }
        });
        connectSetting(this._key('toggle-tint-strength'), () => {
            this._toggleBaseStrength = this._settings.get_double(this._key('toggle-tint-strength'));
        });
        connectSetting(this._key('toggle-corner-radius'), () => {
            this._toggleCornerRadius = this._settings.get_double(this._key('toggle-corner-radius'));
            if (this.glass && this._activeMode === 'toggles') {
                this.glass.setCornerRadius(this._toggleCornerRadius);
            }
        });
        connectSetting(this._key('glass-expand'), () => {
            if (this.glass) {
                this._glassExpand = this._settings.get_int(this._key('glass-expand'));
            }
        });
        connectSetting(this._key('y-offset'), () => {
            if (this.targetActor) {
                this._menuYoffset = this._settings.get_int(this._key('y-offset'));
                this._applyMenuOffsets();
            }
        });
        connectSetting(this._key('x-offset'), () => {
            if (this.targetActor) {
                this._menuXoffset = this._settings.get_int(this._key('x-offset'));
                this._applyMenuOffsets();
            }
        });
        connectSetting(this._key('enable-adaptive-text-color'), () => {
            this._adaptiveConfig.enabled = this._settings.get_boolean(this._key('enable-adaptive-text-color'));
            if (this._adaptiveConfig.enabled) {
                if (this._isEffectActive && this.menu?.isOpen)
                    this._startAdaptiveColorSampling();
                return;
            }
            this._stopAdaptiveColorSampling();
            this._clearAdaptiveStyles();
            // Restoring the original styles also took the dimmed button backgrounds.
            if (this._activeMode === 'background')
                this._updateButtonAlpha();
        });
        connectSetting(this._key('adaptive-text-preference'), () => {
            this._adaptiveConfig.preference = sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference')));
        });
        connectSetting(this._key('sample-interval-ms'), () => {
            this._adaptiveConfig.sampleIntervalMs = this._settings.get_int(this._key('sample-interval-ms'));
        });
        connectSetting(this._key('brightness'), () => {
            if (this.glass) {
                this.glass.setBrightness(this._settings.get_double(this._key('brightness')));
            }
        });
        connectSetting(this._key('saturation'), () => {
            if (this.glass) {
                this.glass.setSaturation(this._settings.get_double(this._key('saturation')));
            }
        });
        connectSetting(this._key('contrast'), () => {
            if (this.glass) {
                this.glass.setContrast(this._settings.get_double(this._key('contrast')));
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
        this._tintColorArray = hexToColorArray(this._settings.get_string(this._key('tint-color')));
        if (this._activeMode === 'toggles') {
            this._applyToggleEffect();
        }
        else {
            this._applyBackgroundEffect();
        }
    }

    // Background mode: one sheet of glass behind the whole menu.
    _applyBackgroundEffect() {
        this._menuYoffset = this._settings.get_int(this._key('y-offset'));
        this._menuXoffset = this._settings.get_int(this._key('x-offset'));
        this._glassExpand = this._settings.get_int(this._key('glass-expand'));
        this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));
        this._adaptiveConfig = {
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean(this._key('enable-adaptive-text-color')),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int(this._key('sample-interval-ms')),
            preference: sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))),
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
        let blurRadius = this._settings.get_int(this._key('blur-radius'));
        let tintColorStr = this._settings.get_string(this._key('tint-color'));
        let tintStrength = this._settings.get_double(this._key('tint-strength'));
        this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
        let brightness = this._settings.get_double(this._key('brightness'));
        let saturation = this._settings.get_double(this._key('saturation'));
        let contrast = this._settings.get_double(this._key('contrast'));
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(tintColorStr));
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
                this._openedFrom = this.menu.sourceActor;
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
            owner: toggles ? 'quick-settings-toggles' : 'quick-settings', outline: this._keyPrefix,
        };
        const glass = toggles ? new ToggleBackdropGlass(params) : new BackdropGlass(params);
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
            ...AdaptiveContrastConfig,
            enabled: this._settings.get_boolean('quick-settings-enable-adaptive-text-color'),
            samplePerElement: SAMPLE_PER_ELEMENT,
            sampleIntervalMs: this._settings.get_int('quick-settings-sample-interval-ms'),
            preference: sanitizeColorPreference(this._settings.get_string('quick-settings-adaptive-text-preference')),
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
            this._toggleGlassHost = new LayoutOpaqueActor();
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
        const blurRadius = this._settings.get_int('quick-settings-blur-radius');
        const tintStrength = this._settings.get_double('quick-settings-tint-strength');
        const brightness = this._settings.get_double('quick-settings-brightness');
        const saturation = this._settings.get_double('quick-settings-saturation');
        const contrast = this._settings.get_double('quick-settings-contrast');
        glass.setPadding(SHADER_PADDING);
        this._tintColorArray = hexToColorArray(this._settings.get_string('quick-settings-tint-color'));
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
        // No transparent panel, offsets or button dimming here: the panel keeps
        // its own look, and ToggleStyles owns the toggles' styles. The menu
        // closes with the shell's own animation.
        this._animSignalId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._openedFrom = this.menu.sourceActor;
                this._forgetSubmenus();
                this._startIntro();
                startFrameSync();
                this._startAdaptiveColorSampling(true);
                this._toggleStyles.start();
                return;
            }
            // The buttons stay where the opening had got them while the menu fades.
            if (this._intro)
                this._intro.running = false;
            this._stopAdaptiveColorSampling();
            this._toggleStyles.stop();
        });
        this._signals.push({
            target: this.menu.actor,
            id: this.menu.actor.connect('notify::mapped', () => {
                if (!this.menu.actor.mapped) {
                    stopFrameSync();
                    this._endIntro();
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
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            alive: () => !!this.glass && this.targetActor.mapped,
            honourFreeze,
            errorTag,
            step: () => {
                // Checked before this frame's sync dirties anything.
                ensureGlassAllocated(this.glass);
                sync();
            },
        });
    }

    _stopFrameSync() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
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
        setPositionIfChanged(this.glass, bgPosX, bgPosY);
        const toggles = this._toggleStyles.sync(this.menu?.actor);
        this._stepIntro(toggles);
        // Until the buttons are laid out and start small, their glass would show
        // them at rest (or as the last open left them), and then jump to the start.
        if (this._intro?.running && !this._intro.motion) {
            this.glass.hide();
            return;
        }
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
        // The glass is inside the menu, so it fades with it already.
        this.glass.opacity = 255;
        this.glass.setGlassRegions(layout.regions);
        this._applyToggleBounds(this.glass, layout.minX, layout.minY, layout.maxX - layout.minX, layout.maxY - layout.minY, bgPosX, bgPosY, screenW, screenH);
        // After the geometry setters, so the relays cover this frame's rect.
        this.glass.syncSources();
    }

    // Toggle mode, with its animation on: the buttons spring out as the menu opens.
    _startIntro() {
        this._endIntro();
        if (!this._toggleAnimation || !St.Settings.get().enable_animations)
            return;
        this._intro = { running: true, motion: null, pods: [], rest: [], saved: [], hidden: new Map(), elapsed: 0, lastUs: 0, waitFrames: 0 };
        this._lastGoodRegions = null;
        // The menu shows at once, so the buttons' glass does from the start; the
        // shell's easing still runs to its end and lets the menu take input.
        const boxPointer = this.targetActor.get_first_child();
        for (const name of BOXPOINTER_EASED) {
            const ease = boxPointer?.get_transition(name);
            ease?.set_from(ease.get_interval().peek_final_value());
        }
    }

    // Moves the buttons for this frame, before their rects are read for the glass.
    _stepIntro(toggles) {
        const intro = this._intro;
        if (!intro?.running)
            return;
        const now = GLib.get_monotonic_time();
        if (!intro.motion) {
            // Until the menu is laid out the buttons are kept out of sight, so they
            // do not show at rest for a frame first.
            const shown = toggles.filter(t => t.visible);
            const rest = shown.map(pod => {
                const origin = pod.has_allocation() ? _layoutOrigin(pod, this.animActor) : null;
                const [w, h] = getAllocatedSize(pod);
                return origin && w > 0 && h > 0 ? [origin[0], origin[1], w, h] : null;
            });
            if (shown.length === 0 || rest.some(r => !r)) {
                for (const pod of shown) {
                    if (!intro.hidden.has(pod))
                        intro.hidden.set(pod, pod.opacity);
                    pod.opacity = 0;
                }
                if (++intro.waitFrames >= MORPH_WAIT_FRAMES)
                    this._endIntro();
                return;
            }
            const button = this._buttonRect();
            const anchor = button ? this.animActor.transform_stage_point(button[0] + button[2] / 2, button[1] + button[3] / 2) : null;
            const right = Math.max(...rest.map(r => r[0] + r[2]));
            intro.motion = new ToggleIntro(rest, anchor?.[0] ? [anchor[1], anchor[2]] : [right, 0], this._glassExpand);
            intro.pods = shown;
            intro.rest = rest;
            intro.saved = shown.map(pod => ({
                pivot: pod.get_pivot_point(), scale: pod.get_scale(),
                translation: [pod.translation_x, pod.translation_y], opacity: intro.hidden.get(pod) ?? pod.opacity,
            }));
            for (const pod of shown)
                pod.set_pivot_point(0.5, 0.5);
        }
        else {
            // The frame that first draws the buttons small can be slow (the menu and its glass are drawn for the first
            // time). Taken as it is, that wait would leave them still and then make them jump; it counts as one frame.
            const step = (now - intro.lastUs) / 1e6;
            intro.elapsed += Math.min(step, intro.elapsed === 0 ? INTRO_FIRST_STEP_S : INTRO_MAX_STEP_S);
        }
        intro.lastUs = now;
        const frame = intro.motion.frame(intro.elapsed);
        intro.pods.forEach((pod, i) => {
            if (!isActorValid(pod))
                return;
            const [x, y, w, h] = intro.rest[i];
            const r = frame.rects[i];
            pod.set_scale(r[2] / w, r[3] / h);
            pod.set_translation(r[0] + r[2] / 2 - (x + w / 2), r[1] + r[3] / 2 - (y + h / 2), 0);
            pod.opacity = Math.round(intro.saved[i].opacity * frame.opacity[i]);
        });
        if (frame.done)
            this._endIntro();
    }

    // Puts the buttons back as they were.
    _endIntro() {
        const intro = this._intro;
        this._intro = null;
        if (!intro)
            return;
        for (const [pod, opacity] of intro.hidden) {
            if (isActorValid(pod))
                pod.opacity = opacity;
        }
        intro.pods.forEach((pod, i) => {
            if (!isActorValid(pod))
                return;
            const saved = intro.saved[i];
            pod.set_pivot_point(...saved.pivot);
            pod.set_scale(...saved.scale);
            pod.set_translation(...saved.translation, 0);
            pod.opacity = saved.opacity;
        });
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
        setScaleIfChanged(glass, 1.0 / accScaleX, 1.0 / accScaleY);
        return [(monitorX - hostAbsX) / accScaleX, (monitorY - hostAbsY) / accScaleY];
    }

    _collectToggleRegions(toggles, monitorX, monitorY) {
        const layout = { regions: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (let toggle of toggles) {
            if (!toggle.visible || !toggle.mapped)
                continue;
            // The toggle's real on-screen rect, including the scale an ancestor
            // animates while the menu opens.
            let [absX, absY, w, h] = getTransformedRect(toggle);
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
        placeScreenGlass(glass, bgPosX, bgPosY, screenW, screenH, { x: localBgX, y: localBgY, w: bgW, h: bgH });
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
        if (this._morph)
            return;
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

    _measurePanel() {
        // The allocation: a restyle (hover, adaptive colors, button dimming) leaves a relayout pending,
        // during which get_size() reports the preferred size including the theme margins.
        let [inW, inH] = getAllocatedSize(this.animActor);
        inW = Number.isNaN(inW) || inW <= 0 ? (this._stableBaseW || 1) : inW;
        inH = Number.isNaN(inH) || inH <= 0 ? (this._stableBaseH || 1) : inH;
        const [scaleX, scaleY] = this._panelScale();
        const targetW = Math.round(inW);
        const targetH = Math.round(inH);
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
        return resolveGlassOrigin(this.animActor, this, () => {
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
        placeScreenGlass(glass, monitorX, monitorY, screenW, screenH, { x: localBgX, y: localBgY, w: bgW, h: bgH });
        glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
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
        applyGlassScale(this.glass, this._cornerRadius, scaleX, scaleY);
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
        return actor instanceof St.Widget && actor.has_style_class_name(className);
    }

    _collectAdaptiveTextTargets(actor = this.menu?.actor, targets = []) {
        if (!actor)
            return targets;
        return this._findAllTextActors(this.menu?.actor);
    }

    _findAllTextActors(actor, foundActors = []) {
        if (!actor)
            return foundActors;
        if (actor instanceof St.Label || actor instanceof Clutter.Text ||
            actor instanceof St.Button || actor instanceof St.Icon) {
            if (actor.visible)
                foundActors.push(actor);
        }
        for (const child of actor.get_children())
            this._findAllTextActors(child, foundActors);
        return foundActors;
    }

    _setActorColor(actor, color, skipAnimations = false, batchStart) {
        // Clutter.Text targets have no St style.
        if (!(actor instanceof St.Widget))
            return;
        if (!this._styledActors.has(actor)) {
            this._styledActors.set(actor, actor.get_style() || '');
            actor.connect('destroy', () => {
                adaptiveColorTweener.cancel(actor);
                this._styledActors.delete(actor);
            });
        }
        let isInsensitive = false;
        if (actor instanceof St.Button) {
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
            adaptiveColorTweener.cancel(actor);
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
        const batchStart = GLib.get_monotonic_time();
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
            if (holder instanceof St.Widget && !this._backdropSignals.has(holder)) {
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
        this._backdropRefreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._backdropRefreshId = 0;
            const dirty = new Set(this._dirtyBackdropRoots);
            this._dirtyBackdropRoots.clear();
            if (!this.menu?.isOpen || !this._adaptiveConfig.enabled)
                return GLib.SOURCE_REMOVE;
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
            return GLib.SOURCE_REMOVE;
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
                this._openSampleId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    this._openSampleId = 0;
                    this._updateAdaptiveTextColors(true);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        else {
            this._updateAdaptiveTextColors(false);
        }
        if (this._adaptiveTimerId !== 0)
            return;
        this._adaptiveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._adaptiveConfig.sampleIntervalMs, () => {
            if (!this.menu?.isOpen) {
                this._adaptiveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            // The colors measured as the menu opened are kept while it moves.
            const opening = this._tickId !== 0 || this._morphTickId !== 0 || !!this._intro?.running;
            if (!opening || this._awaitingOpenColors)
                this._updateAdaptiveTextColors(this._awaitingOpenColors);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAdaptiveColorSampling() {
        this._clearBackdropTracking();
        if (this._adaptiveTimerId !== 0) {
            GLib.source_remove(this._adaptiveTimerId);
            this._adaptiveTimerId = 0;
        }
        if (this._openSampleId !== 0) {
            GLib.source_remove(this._openSampleId);
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
        () => this._activeMode === 'background' && this.glass instanceof BackdropGlass ? [this.glass] : [])
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
        let targetRgb = hexToRgb(targetHexColor);
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
            adaptiveColorTweener.cancel(actor);
            apply(targetRgb.r, targetRgb.g, targetRgb.b, targetAlpha);
            return;
        }
        const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
        adaptiveColorTweener.add(actor, {
            startRgb, startAlpha,
            targetRgb, targetAlpha,
            crossFade: resolveCrossFade(startRgb, targetRgb),
            durationMs,
            apply,
        }, batchStart);
    }

    // Background mode dims the buttons' own backgrounds to at most BUTTON_ALPHA,
    // and keeps doing so as their state changes.
    _findAllButtons(actor, foundButtons = []) {
        if (!actor)
            return foundButtons;
        let isQuickSlider = false;
        let isToggleContainer = false;
        let isButton = actor instanceof St.Button;
        if (actor instanceof St.Widget) {
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
        if (!(button instanceof St.Widget) || !button.has_style_class_name('quick-toggle'))
            return false;
        for (const child of button.get_children()) {
            if (!(child instanceof St.Widget))
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
        // Only dims, so themes whose buttons are already translucent keep their own alpha.
        if (bgColor.alpha / 255 > targetAlpha) {
            const rgbaStr = `rgba(${bgColor.red}, ${bgColor.green}, ${bgColor.blue}, ${targetAlpha})`;
            button.set_style(origStyle ? `${origStyle} background-color: ${rgbaStr};` : `background-color: ${rgbaStr};`);
        }
        // The parent toggle depends on this button's state.
        const parent = button.get_parent();
        if (parent instanceof St.Widget && parent.has_style_class_name('quick-toggle'))
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
                if (button instanceof St.Widget) {
                    let origStyle = this._styledActors.get(button) ?? button.get_style();
                    this._styledButtons.set(button, origStyle || '');
                }
                // After the state change has restyled the button.
                const updateHandler = () => {
                    if (!this.menu?.isOpen)
                        return;
                    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        this._buttonIdleIds.delete(id);
                        this._updateSingleButtonAlpha(button, targetAlpha);
                        return GLib.SOURCE_REMOVE;
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
                // The shell destroys rows while the menu is up and on screen lock, before this cleans up.
                signalIds.push(button.connect('destroy', () => {
                    this._buttonSignalIds.delete(button);
                    this._styledButtons.delete(button);
                }));
                this._buttonSignalIds.set(button, signalIds);
            }
            this._updateSingleButtonAlpha(button, targetAlpha);
        }
    }

    _startButtonAlphaSampling() {
        this._updateButtonAlpha();
        if (this._buttonTimerId !== 0)
            return;
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
        for (const id of this._buttonIdleIds)
            GLib.Source.remove(id);
        this._buttonIdleIds.clear();
    }

    _clearButtonStyles() {
        this._stopButtonAlphaSampling();
        this._disconnectButtonSignals();
        for (const [button, originalStyle] of this._styledButtons.entries()) {
            if (button instanceof St.Widget)
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
            removeFrameTicker(this._tickId);
            this._tickId = 0;
        }
        if (!this._enableAnimation) {
            this._endMorph();
            showMenuAtRest(this.glass, this.animActor);
            return;
        }
        if (this._growFromButton && St.Settings.get().enable_animations && this._startMorph(targetValue === 1))
            return;
        this._endMorph();
        if (this.animActor)
            this.animActor.remove_all_transitions();
        if (this.glass)
            this.glass.remove_all_transitions();
        this._springScale.target = targetValue;
        if (this._tickId === 0) {
            let lastTime = GLib.get_monotonic_time();
            this._tickId = addFrameTicker(() => {
                if (!this.glass || !this.targetActor) {
                    this._tickId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                let currentTime = GLib.get_monotonic_time();
                let elapsedMs = (currentTime - lastTime) / 1000;
                lastTime = currentTime;
                const frame = stepMenuSpring(this._springScale, elapsedMs);
                if (frame.stopped)
                    this._tickId = 0;
                applyMenuFrame(frame, this.animActor, this.glass, this.menu.actor, () => this._syncGeometry());
                return frame.stopped ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
            }, normalizeAnimationIntervalMs(this._animationInterval));
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
        let [parentW, parentH] = getAllocatedSize(this.animActor);
        if (!parent || Number.isNaN(parentW) || Number.isNaN(parentH) || parentW <= 0 || parentH <= 0)
            return;
        // The shell places the submenu overlay from an offset it measures once, so it can stay
        // wrong after an animated open; the overlay belongs on the grid.
        const gridOrigin = _layoutOrigin(this.menu._grid, root);
        const overlayOrigin = _layoutOrigin(this.menu._overlay, root);
        const overlayError = gridOrigin && overlayOrigin ? gridOrigin[1] - overlayOrigin[1] : 0;
        for (let submenu of this._cachedSubmenus)
            this._centerSubmenu(submenu, root, parent, parentW, parentH, overlayError);
    }

    _centerSubmenu(submenu, root, [parentX, parentY], parentW, parentH, overlayError) {
        if (!submenu.mapped || !submenu.visible)
            return;
        const origin = _layoutOrigin(submenu, root);
        let [subW, subH] = getAllocatedSize(submenu);
        if (!origin || Number.isNaN(subW) || Number.isNaN(subH) || subW <= 0 || subH <= 0)
            return;
        const [subX, subY] = origin;
        const translationX = parentX + (parentW - subW) / 2 - subX;
        if (Math.abs(submenu.translation_x - translationX) > 0.5)
            submenu.translation_x = translationX;
        // Neighbours are told apart by where the submenu belongs, not where the overlay put it.
        const gap = { subCenterY: subY + overlayError + (subH / 2), aboveMaxY: parentY, belowMinY: parentY + parentH };
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

    _buttonRect() {
        const opener = this._openedFrom;
        const source = opener && isActorValid(opener) && opener.mapped
            ? opener : this.menu?.sourceActor ?? Main.panel.statusArea.quickSettings;
        if (!source || !isActorValid(source) || !source.mapped)
            return null;
        const actor = source;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(w >= 1) || !(h >= 1))
            return null;
        const node = actor.get_theme_node();
        const [sx, sy] = actor.get_transformed_size().map((v, i) => v / Math.max(i ? actor.height : actor.width, 1));
        const left = node.get_border_width(St.Side.LEFT) * sx, right = node.get_border_width(St.Side.RIGHT) * sx;
        const top = node.get_border_width(St.Side.TOP) * sy, bottom = node.get_border_width(St.Side.BOTTOM) * sy;
        if (w - left - right < 1 || h - top - bottom < 1)
            return [x, y, w, h];
        return [x + left, y + top, w - left - right, h - top - bottom];
    }

    // Where the menu's items are at rest: their stage rect without the
    // morph's own scale and shift, and the scale (`k`) the menu puts on them.
    _menuRest() {
        if (!this.targetActor.mapped)
            return null;
        const a = this.animActor;
        const [w, h] = getAllocatedSize(a);
        const [tx, ty] = a.get_transformed_position();
        const k = this.targetActor.get_scale()[0] || 1;
        const x = tx - a.translation_x * k;
        const y = ty - a.translation_y * k;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 1) || !(h > 1))
            return null;
        return { x, y, w: w * k, h: h * k, k };
    }

    // The resting menu's glass body, [x, y, w, h] in stage coordinates.
    _menuBodyRect() {
        const rest = this._menuRest();
        if (!rest)
            return null;
        const e = this._glassExpand;
        return [rest.x - e, rest.y - e, rest.w + e * 2, rest.h + e * 2];
    }

    /**
     * Starts the glass towards the menu (`open`) or back into the button.
     * False when there is no button to grow out of; the scale spring runs then.
     */
    _startMorph(open) {
        const button = this._buttonRect();
        if (!this.glass || !button)
            return false;
        if (!(this.glass instanceof BackdropGlass))
            return false;
        // Reversing midway starts from where the glass is.
        const prev = this._morph;
        if (!open && !prev?.motion && !this._menuBodyRect())
            return false;
        this._stopMorphTicker();
        let lens = prev?.lens;
        if (!lens) {
            lens = new ContentLens();
            this.animActor.add_effect_with_name(CONTENT_LENS, lens);
        }
        const blurRadius = this._settings.get_int(this._key('blur-radius'));
        // Opened again while closing: the glass is the menu's again at once, not from the next frame.
        if (open && prev && prev.shownBlurRadius !== blurRadius)
            this.glass.setBlurRadius(blurRadius);
        if (open)
            this.glass.setAnimationScale(1);
        let fromFrame = prev?.motion?.frame ?? null;
        if (!fromFrame && prev) {
            fromFrame = {
                body: prev.button,
                bodyRadius: prev.button[3] / 2,
                contentScale: 2,
                contentOpacity: 0,
                lens: 1,
                glassOpacity: 1,
                soften: 0,
                done: false,
            };
        }
        this._morph = {
            opening: open, motion: null, button, lens, lastUs: 0, waitFrames: 0,
            from: fromFrame, velocities: prev?.motion?.velocities ?? null,
            refraction: this._settings.get_double('glass-displacement-scale'), blurRadius,
            shownBlurRadius: open ? blurRadius : prev?.shownBlurRadius ?? blurRadius,
            speed: this._morphSpeed,
        };
        this.animActor.remove_all_transitions();
        this.glass.remove_all_transitions();
        this.animActor.set_pivot_point(0, 0);
        this._morphTickId = addFrameTicker(() => this._stepMorph(), normalizeAnimationIntervalMs(this._animationInterval));
        return true;
    }

    _stepMorph() {
        const m = this._morph;
        if (!m || !this.glass) {
            this._morphTickId = 0;
            return false;
        }
        m.button = this._buttonRect() ?? m.button;
        // The menu stays where it opens and stays visible until the morph ends.
        for (const name of BOXPOINTER_EASED) {
            const ease = this.targetActor.get_transition(name);
            if (!ease)
                continue;
            if (m.opening)
                ease.set_from(ease.get_interval().peek_final_value());
            else
                ease.set_to(ease.get_interval().peek_initial_value());
            if (!m.opening && name === 'opacity')
                ease.set_duration(BOXPOINTER_HOLD_MS);
        }
        const menu = this._menuBodyRect();
        if (!m.motion) {
            if (!menu) {
                // Not laid out yet: hold the glass on the button for a few frames.
                this._placeMorph({
                    body: m.button, bodyRadius: m.button[3] / 2, contentScale: 1,
                    contentOpacity: 0, lens: 0, glassOpacity: 1, soften: 0, done: false
                });
                if (++m.waitFrames < MORPH_WAIT_FRAMES)
                    return true;
                this._morphTickId = 0;
                this._endMorph();
                return false;
            }
            m.motion = new MenuMorphMotion(m.opening, m.button, menu, this._cornerRadius, m.from, m.velocities);
        }
        else {
            m.motion.retarget(m.button, menu, this._cornerRadius);
        }
        const now = GLib.get_monotonic_time();
        const frame = m.motion.step(m.lastUs ? (now - m.lastUs) / 1e6 : 1 / 60, m.speed);
        m.lastUs = now;
        this._placeMorph(frame);
        if (!frame.done)
            return true;
        this._morphTickId = 0;
        const closed = !m.opening;
        this._endMorph();
        if (closed) {
            this.glass.hide();
            this.glass.opacity = 0;
            this.animActor.opacity = 0;
            if (!this.menu.isOpen)
                this.menu.actor.hide();
        }
        return false;
    }

    // Draws the travelling glass (stage coordinates) and the menu's items in it.
    _placeMorph(f) {
        if (!(this.glass instanceof BackdropGlass))
            return;
        const glass = this.glass;
        const monitor = this._getMenuMonitorGeometry();
        const mx = monitor?.x ?? 0;
        const my = monitor?.y ?? 0;
        const p = SHADER_PADDING;
        const body = f.body;
        if (!glass.visible)
            glass.show();
        glass.opacity = Math.round(255 * f.glassOpacity);
        this._applyGlassBounds(glass, body[0] - p, body[1] - p, body[2] + p * 2, body[3] + p * 2, mx, my, Math.max(1, monitor?.width ?? 1), Math.max(1, monitor?.height ?? 1));
        glass.setCornerRadius(f.bodyRadius);
        this._softenGlass(glass, f.soften);
        this._placeContent(f);
        glass.syncSources();
    }

    _applyGlassBounds(glass, bgX, bgY, bgW, bgH, monitorX, monitorY, screenW, screenH) {
        if (this._lastBgW === bgW && this._lastBgH === bgH &&
            this._lastBgX === bgX && this._lastBgY === bgY &&
            this._lastScreenW === screenW && this._lastScreenH === screenH)
            return;
        // Monitor-local, as the shader uses them.
        let localBgX = bgX - monitorX;
        let localBgY = bgY - monitorY;
        placeScreenGlass(glass, monitorX, monitorY, screenW, screenH, { x: localBgX, y: localBgY, w: bgW, h: bgH });
        glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
        glass.setResolution(screenW, screenH);
        glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);
        this._lastBgW = bgW;
        this._lastBgH = bgH;
        this._lastBgX = bgX;
        this._lastBgY = bgY;
        this._lastScreenW = screenW;
        this._lastScreenH = screenH;
    }

    // Takes the refraction and the blur from their settings towards
    // SOFT_REFRACTION and SOFT_BLUR_RADIUS, by `soften` (0 to 1).
    _softenGlass(glass, soften) {
        const m = this._morph;
        const toward = (from, to) => from + (Math.min(from, to) - from) * soften;
        glass.setAnimationScale(m.refraction > 0 ? toward(m.refraction, SOFT_REFRACTION) / m.refraction : 1);
        const blur = Math.round(toward(m.blurRadius, SOFT_BLUR_RADIUS));
        if (blur !== m.shownBlurRadius) {
            m.shownBlurRadius = blur;
            glass.setBlurRadius(blur);
        }
    }

    // Draws the menu's items `f.contentScale` times their size around the
    // middle of the travelling glass, cut to its outline.
    _placeContent(f) {
        const a = this.animActor;
        const rest = this._menuRest();
        if (!rest || !this._morph) {
            a.opacity = 0;
            return;
        }
        a.opacity = Math.round(255 * f.contentOpacity * f.glassOpacity);
        const e = this._glassExpand;
        const [bx, by, bw, bh] = f.body;
        // Never 0, which Cogl cannot invert.
        const s = Math.max(f.contentScale, 0.01);
        const x = bx + (bw - (rest.w + e * 2) * s) / 2 + e * s;
        const y = by + (bh - (rest.h + e * 2) * s) / 2 + e * s;
        const k = rest.k;
        a.set_scale(s, s);
        a.set_translation((x - rest.x) / k, (y - rest.y) / k, 0);
        const clip = [(bx - x) / (s * k), (by - y) / (s * k), bw / (s * k), bh / (s * k)];
        a.set_clip(clip[0], clip[1], clip[2], clip[3]);
        this._morph.lens.shape(clip, s * k, f.bodyRadius, f.lens);
    }

    _stopMorphTicker() {
        if (!this._morphTickId)
            return;
        removeFrameTicker(this._morphTickId);
        this._morphTickId = 0;
    }

    // Leaves the glass and the menu as the rest of the manager expects them.
    _endMorph() {
        this._stopMorphTicker();
        const m = this._morph;
        if (!m)
            return;
        this._morph = null;
        if (this.glass) {
            this.glass.setAnimationScale(1);
            if (m.shownBlurRadius !== m.blurRadius)
                this.glass.setBlurRadius(m.blurRadius);
        }
        if (!this._actorDestroyed && this.animActor) {
            this.animActor.remove_effect_by_name(CONTENT_LENS);
            this.animActor.remove_clip();
            this.animActor.set_translation(0, 0, 0);
            this.animActor.set_scale(1.0, 1.0);
            this.animActor.set_pivot_point(0.5, 0.0);
            this.animActor.opacity = 255;
        }
        if (this.glass && this.targetActor.mapped)
            this._syncGeometry();
    }

    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._stopAdaptiveColorSampling();
        this._clearAdaptiveStyles();
        this._clearButtonStyles();
        this._clearSubmenuFix();
        this._endIntro();
        this._toggleStyles.clear();
        this._disconnectEffectSignals();
        this._restoreMenuActors();
        const glass = this.glass;
        this.glass = null;
        if (glass) {
            glass.cleanup();
            // At shell shutdown the stage may have destroyed it already.
            if (isActorValid(glass))
                glass.destroy();
        }
        // The toggle-mode host is the glass's parent, not destroyed with it.
        if (this._toggleGlassHost) {
            if (isActorValid(this._toggleGlassHost))
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
        this._openedFrom = null;
        if (this._tickId !== 0) {
            removeFrameTicker(this._tickId);
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
                this.menu.close(MENU_NO_ANIMATION);
        }
    }

    cleanup() {
        this._stopFrameSync();
        for (let sigId of this._settingsSignals)
            this._settings.disconnect(sigId);
        this._settingsSignals = [];
        if (this._destroySignalId) {
            this.targetActor.disconnect(this._destroySignalId);
            this._destroySignalId = 0;
        }
        this._removeEffect();
    }
}
