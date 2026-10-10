import { stepMenuSpring, applyMenuFrame, showMenuAtRest } from './animation/menuSpring.js';
import { addFrameTicker, removeFrameTicker, normalizeAnimationIntervalMs } from './animation/frameTicker.js';
import { Spring, SwiftSpring } from './animation/spring.js';
import { MenuMorphMotion, type MorphFrame } from './animation/menuMorph.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { ContentLens } from './rendering/contentLens.js';
import { StageContrastSampler, AdaptiveContrastConfig, sanitizeColorPreference } from './contrastSampler.js';
import { UnpickableWidget } from './actors/unpickable.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { resolveMonitorGeometry, getAllocatedSize } from './actors/geometry.js';
import { isActorValid } from './actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { placeScreenGlass, resolveGlassOrigin, applyGlassScale, GLASS_SHADOW_MAX_RADIUS } from './actors/glassBounds.js';
import { resolveCrossFade, adaptiveColorTweener, hexToColorArray, hexToRgb, rgbToHex } from './animation/colors.js';

import { MENU_NO_ANIMATION, accentColors } from './shellVersion.js';
import { Logger } from './logger.js';

// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;

const SAMPLE_PER_ELEMENT = false;

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
  _currentInsensitiveState?: boolean;
  _isUpdatingAlpha?: boolean;
}

const MIN_MENU_SCALE = 0.5;

// Frames to wait for an opening menu to get its size before it just appears.
const MORPH_WAIT_FRAMES = 30;
// The menu's own open and close animations, which the morph replaces; it keeps
// the closing fade.
const BOXPOINTER_EASED = ['opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y'];
const BOXPOINTER_MOVES = BOXPOINTER_EASED.slice(1);
const CONTENT_LENS = 'liquid-glass-content-lens';
// What the refraction (displacement scale) and the blur radius come down to,
// whatever they are set to, as the closing glass settles on the button.
const SOFT_REFRACTION = 0.3;
const SOFT_BLUR_RADIUS = 0;

// The glass travelling between the panel button and the menu.
interface MenuMorph {
  opening: boolean;
  // Null until an opening menu has its size.
  motion: MenuMorphMotion | null;
  // Where the motion it reverses had got to.
  from: MorphFrame | null;
  velocities: number[] | null;
  // The button's glass, [x, y, w, h] in stage coordinates.
  button: number[];
  // On the menu's items while the glass changes shape.
  lens: InstanceType<typeof ContentLens>;
  lastUs: number;
  waitFrames: number;
  // The refraction and blur radius as set, and the blur radius last given to the glass.
  refraction: number;
  blurRadius: number;
  shownBlurRadius: number;
}

const MENU_MEASURE_FRAMES = 30;
const MENU_MEASURE_STABLE_FRAMES = 3;

// Quick Settings' open height, measured once for every menu that matches it,
// and the callbacks waiting for a measurement in progress.
let _quickSettingsHeight = 0;
let _quickSettingsWaiting: ((height: number) => void)[] | null = null;

export class UIManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private targetActor: St.Widget;
  private menu: any;
  private animActor: St.Widget;
  // Monitor-sized; see _applyGlassBounds().
  private glass: BackdropGlass | null;

  private _signals: { target: any, id: number }[];
  private _animSignalId: number = 0;
  private _destroySignalId = 0;
  private _actorDestroyed = false;
  private _frameSyncId: number;
  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }
  private _frameSignalId = 0;
  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }

  private _glassExpand: number;
  private _menuXoffset: number;
  private _menuYoffset: number;
  private _menuScale: number = 1.0;
  private _ownsAccentCss: boolean = true;
  private _matchQuickSettingsHeight: boolean = false;
  private _settledHeightScale: number | null = null;
  private _measuringHeights: boolean = false;
  private _ownOpenHeight: number = 0;
  private _measureLaterIds: Set<number> = new Set();
  private _restoreQuickSettings: (() => void) | null = null;
  private _tickId: number;
  private _contrastSampler: StageContrastSampler;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;
  private _hoverSignals: Map<Clutter.Actor, number> = new Map();
  private _pendingBackdropRoots: Set<Clutter.Actor> = new Set();
  private _backdropColored: Set<Clutter.Actor> = new Set();
  // The last sampled colour of each text, which a row's text returns to when
  // its highlight goes.
  private _sampleColors: Map<Clutter.Actor, string> = new Map();
  // Set on open until the first sample has coloured the text; see
  // _startAdaptiveColorSampling().
  private _awaitingOpenColors: boolean = false;
  private _openSampleId: number = 0;
  // The colour the last merged sample gave every text, for text added since.
  private _sharedColor: string | null = null;
  private _newTextId: number = 0;
  private _newTextPending: boolean = false;
  private _applyingColors: boolean = false;
  private _backdropRefreshId: number = 0;
  private _settingsSignals: number[];
  private _isEffectActive: boolean;
  private _adaptiveConfig!: typeof AdaptiveContrastConfig;
  private _stableBaseW: number | undefined;
  private _stableBaseH: number | undefined;
  private _lastValidAnimAbsX: number | undefined;
  private _lastValidAnimAbsY: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _springScale: Spring;
  private _springStiffness: number;
  private _springDamping: number;
  private _springMass: number;

  // The alternative SwiftUI-style spring; not exposed in the preferences.
  private _swiftAnimation: boolean = false;
  private _swiftResponse: number = 0.3;
  private _swiftDampingFraction: number = 0.65;

  private _swiftSpringScale: SwiftSpring;

  private _enableAnimation: boolean;
  private _growFromButton: boolean = true;
  private _morph: MenuMorph | null = null;
  private _morphTickId: number = 0;

  private _interfaceSettings: Gio.Settings | null = null;
  private _accentColorSignalId: number = 0;
  private _accentColorTimeoutId: number = 0;

  private _dynamicCssFile: Gio.File | null = null;
  private _cornerRadius: number = 0;

  private _animationInterval: number = 16;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  // The menu's ancestor that is a direct child of uiGroup; see _restackGlass().
  private _menuRoot: Clutter.Actor | null = null;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger,
              panelButton: any = Main.panel.statusArea.dateMenu, ownsAccentCss: boolean = true,
              private _enableKey: string = 'enable-menu-glass',
              // Settings prefix: `menu` for the calendar, `panel-menu` for the
              // other panel menus (see PanelMenuManager).
              private _keyPrefix: string = 'menu',
              // Names this glass in logs, dumps and actor names.
              private _label: string = 'menu',
              private _ownsSettingsNamespace: boolean = true) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this._ownsAccentCss = ownsAccentCss;

    this.targetActor = panelButton.menu.actor as St.Widget;
    this.menu = panelButton.menu;
    this.animActor = panelButton.menu.box as St.Widget;

    this.glass = null;

    this._signals = [];
    this._frameSyncId = 0;

    this._glassExpand = 0;
    this._menuXoffset = 0;
    this._menuYoffset = 0;

    this._springScale = new Spring(120, 22, 1.0);
    this._springStiffness = 120;
    this._springDamping = 22;
    this._springMass = 1.0;

    this._swiftSpringScale = new SwiftSpring(this._swiftResponse, this._swiftDampingFraction);

    this._enableAnimation = false;
    this._tickId = 0;

    this._contrastSampler = new StageContrastSampler();
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._settingsSignals = [];
    this._isEffectActive = false;

    this._animSignalId = this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
      if (!this._isEffectActive) return;
      if (isOpen) {
        this._applyMenuScale();
        this._startAnimation(1);
      } else {
        this._startAnimation(0);
      }
    });
    this._destroySignalId = this.targetActor.connect('destroy', () => {
      this._actorDestroyed = true;
      this._destroySignalId = 0;
      this.cleanup();
    });
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    this._enableAnimation = this._settings.get_boolean(this._animationKey());
    this._growFromButton = this._settings.get_boolean(this._key('grow-from-button'));
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

    this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    // The theme context picks up the new accent colour a moment later.
    this._accentColorSignalId = this._interfaceSettings.connect('changed::accent-color', () => {
      if (this._accentColorTimeoutId)
        GLib.Source.remove(this._accentColorTimeoutId);
      this._accentColorTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
        this._accentColorTimeoutId = 0;
        this._applySystemAccentColor();
        return GLib.SOURCE_REMOVE;
      });
    });

    this._applySystemAccentColor();

    if (this._settings.get_boolean(this._enableKey)) {
      this._applyEffect();
    }
  }

  /**
   * The accent colour and its foreground as [background, foreground] hex.
   * Asked of St rather than read off a themed dummy widget, because themes
   * such as MacTahoe only paint today's date in the accent while selected.
   * The dummy (marked :selected) remains the fallback when St has no accent
   * (GNOME 46).
   */
  private _resolveAccentColors(): [string, string] {
    const accent = accentColors();
    if (accent)
      return [rgbToHex(accent[0].red, accent[0].green, accent[0].blue),
        rgbToHex(accent[1].red, accent[1].green, accent[1].blue)];

    // The theme's selectors need the calendar ancestry.
    const parent = new UnpickableWidget({ style_class: 'calendar' });
    const child = new UnpickableWidget({ style_class: 'calendar-day calendar-today' });
    child.add_style_pseudo_class('selected');
    parent.add_child(child);

    Main.layoutManager.uiGroup.add_child(parent);
    child.ensure_style();
    const bgColor = child.get_theme_node().get_background_color();
    Main.layoutManager.uiGroup.remove_child(parent);
    parent.destroy();

    return [rgbToHex(bgColor.red, bgColor.green, bgColor.blue), '#ffffff'];
  }

  private _applySystemAccentColor() {
    if (!this._ownsAccentCss || !this.targetActor) return;

    const [colorStr, fgStr] = this._resolveAccentColors();

    // St loads stylesheets only from files, so the rule goes through the cache
    // directory.
    const cssContent = `
      .liquid-glass-menu-root .calendar-today,
      .liquid-glass-menu-root .calendar-today:hover,
      .liquid-glass-menu-root .calendar-today:active,
      .liquid-glass-menu-root .calendar-today:checked,
      .liquid-glass-menu-root .calendar-today:selected,
      .liquid-glass-menu-root .calendar-today:focus {
        background-color: ${colorStr} !important;
        color: ${fgStr} !important;
      }
    `;

    // Writing the file and parsing the stylesheet both throw a GError on failure.
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
    } catch (e) {
      this._logger.error(`[Liquid Glass] [UIManager] Failed to apply system accent color: ${e}`);
    }
  }

  _allocatedHeightOf(actor: any): number {
    if (!actor || !isActorValid(actor) || !actor.has_allocation())
      return 0;
    const [, allocated] = getAllocatedSize(actor);
    return allocated > 1 ? allocated : 0;
  }

  _firstHeight(actors: any[], measure: (actor: any) => number): number {
    for (const actor of actors) {
      const height = measure(actor);
      if (height > 0)
        return height;
    }
    return 0;
  }

  // Measures a menu's height once it has stopped changing for a few frames
  // (it grows while its content lays out), within MENU_MEASURE_FRAMES.
  _settleHeight(menu: any, done: (height: number) => void): void {
    const actor = menu?.actor;
    if (!actor || !isActorValid(actor)) {
      done(0);
      return;
    }

    let framesLeft = MENU_MEASURE_FRAMES;
    let tallest = 0;
    let repeats = 0;
    const tick = () => {
      const height = this._firstHeight([actor, menu.box], a => this._allocatedHeightOf(a));

      repeats = height > 0 && height === tallest ? repeats + 1 : 0;
      if (height > tallest) tallest = height;

      if (repeats < MENU_MEASURE_STABLE_FRAMES && --framesLeft > 0)
        this._addMeasureLater(tick);
      else
        done(tallest);
    };

    this._addMeasureLater(tick);
  }

  _addMeasureLater(callback: () => void): void {
    const id = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._measureLaterIds.delete(id);
      callback();
      return GLib.SOURCE_REMOVE;
    });
    this._measureLaterIds.add(id);
  }

  _cancelHeightMeasurement(): void {
    for (const id of this._measureLaterIds)
      global.compositor.get_laters().remove(id);
    this._measureLaterIds.clear();

    // This menu was measuring Quick Settings: close it again, and drop the
    // waiting callbacks, which would otherwise never be called.
    const restore = this._restoreQuickSettings;
    this._restoreQuickSettings = null;
    if (restore) {
      restore();
      _quickSettingsWaiting = null;
    }
  }

  _withQuickSettingsHeight(done: (height: number) => void): void {
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
    const settle = (height: number) => {
      _quickSettingsHeight = height;
      const waiting = _quickSettingsWaiting ?? [];
      _quickSettingsWaiting = null;
      for (const callback of waiting) callback(height);
    };

    if (menu.isOpen) {
      this._settleHeight(menu, settle);
      return;
    }

    // Opened invisibly, measured, and closed again.
    const opacity = actor.opacity;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      menu.close(MENU_NO_ANIMATION);
      actor.opacity = opacity;
    };

    menu.open(MENU_NO_ANIMATION);
    actor.opacity = 0;

    this._restoreQuickSettings = restore;
    this._settleHeight(menu, height => {
      this._restoreQuickSettings = null;
      restore();
      settle(height);
    });
  }

  _measureHeightScale(): void {
    if (!this.menu) return;

    _quickSettingsHeight = 0;
    this._ownOpenHeight = 0;
    this._withQuickSettingsHeight(() => this._rememberRatioWhenBothKnown());
  }

  _noteOwnOpenedHeight(): void {
    if (!this._matchQuickSettingsHeight) return;
    if (this._measuringHeights || _quickSettingsHeight <= 0) return;

    this._measuringHeights = true;
    this._settleHeight(this.menu, height => {
      this._measuringHeights = false;
      if (height > 0) {
        this._ownOpenHeight = height;
        this._rememberRatioWhenBothKnown();
      }
    });
  }

  _rememberRatioWhenBothKnown(): void {
    if (_quickSettingsHeight <= 0 || this._ownOpenHeight <= 0) return;

    const ratio = _quickSettingsHeight / this._ownOpenHeight;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return;

    this._rememberHeightScale(ratio);
    this._applyMenuScale();
  }

  _quickSettingsHeightScale(): number | null {
    const quickSettings = Main.panel.statusArea.quickSettings?.menu;
    if (!quickSettings)
      return this._settledHeightScale;

    const targetHeight = this._firstHeight([quickSettings.actor, quickSettings.box],
      actor => this._allocatedHeightOf(actor));
    const ownHeight = this._firstHeight([this.targetActor, this.animActor],
      actor => this._allocatedHeightOf(actor));
    if (targetHeight <= 0 || ownHeight <= 0)
      return this._settledHeightScale;

    const ratio = targetHeight / ownHeight;
    if (!Number.isFinite(ratio) || ratio <= 0)
      return this._settledHeightScale;

    this._rememberHeightScale(ratio);
    return ratio;
  }

  _rememberHeightScale(ratio: number): void {
    if (this._settledHeightScale !== null && Math.abs(this._settledHeightScale - ratio) < 0.005)
      return;

    this._settledHeightScale = ratio;
    if (!this._ownsSettingsNamespace) return;

    this._settings.set_double(this._key('settled-height-scale'), ratio);
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
   * Keeps the glass directly beneath the menu it backs, as the other surfaces
   * do; placed anywhere lower, a dock between the two would cover the glass
   * but not the menu. Re-asserted on every open, because other extensions
   * and dock rebuilds change uiGroup's order.
   */
  private _restackGlass(): void {
    const uiGroup = Main.layoutManager.uiGroup;
    const root = this._menuRoot;
    if (!this.glass || !root) return;
    if (!isActorValid(root) || root.get_parent() !== uiGroup) return;
    if (this.glass.get_parent() !== uiGroup) return;

    const children = uiGroup.get_children();
    const rootIndex = children.indexOf(root);
    if (rootIndex < 0) return;
    if (children.indexOf(this.glass) === rootIndex - 1) return;

    uiGroup.set_child_below_sibling(this.glass, root);
  }

  // A key in this instance's settings namespace; see _keyPrefix.
  private _key(suffix: string): string {
    return `${this._keyPrefix}-${suffix}`;
  }

  // The animation switch is named `enable-<prefix>-animation`.
  private _animationKey(): string {
    return `enable-${this._keyPrefix}-animation`;
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting(this._enableKey, () => {
      let enabled = this._settings.get_boolean(this._enableKey);
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting(this._animationKey(), () => {
      this._enableAnimation = this._settings.get_boolean(this._animationKey());
    });

    connectSetting(this._key('grow-from-button'), () => {
      this._growFromButton = this._settings.get_boolean(this._key('grow-from-button'));
    });

    connectSetting(this._key('spring-stiffness'), () => {
      this._springStiffness = this._settings.get_double(this._key('spring-stiffness'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('spring-damping'), () => {
      this._springDamping = this._settings.get_double(this._key('spring-damping'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('spring-mass'), () => {
      this._springMass = this._settings.get_double(this._key('spring-mass'));
      if (this._springScale) this._springScale.updateParams(this._springStiffness, this._springDamping, this._springMass);
    });

    connectSetting(this._key('animation-interval-ms'), () => {
      this._animationInterval = this._settings.get_int(this._key('animation-interval-ms'));
    });

    connectSetting(this._key('tint-color'), () => {
      if (this.glass) {
        let colorArray = hexToColorArray(this._settings.get_string(this._key('tint-color')));
        this.glass.setTintColor(...colorArray);
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

    connectSetting(this._key('brightness'), () => {
      if (this.glass) {
        this.glass.setBrightness(this._settings.get_double(this._key('brightness')));
      }
    });

    connectSetting(this._key('contrast'), () => {
      if (this.glass) {
        this.glass.setContrast(this._settings.get_double(this._key('contrast')));
      }
    });

    connectSetting(this._key('saturation'), () => {
      if (this.glass) {
        this.glass.setSaturation(this._settings.get_double(this._key('saturation')));
      }
    });

    connectSetting(this._key('corner-radius'), () => {
      if (this.glass) {
        this._cornerRadius = this._settings.get_double(this._key('corner-radius'));
        this.glass.setCornerRadius(this._cornerRadius);
      }
    });

    connectSetting(this._key('glass-expand'), () => {
      if (this.glass) {
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
      if (this._matchQuickSettingsHeight) this._measureHeightScale();
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

    connectSetting(this._key('adaptive-text-preference'), () => {
      this._adaptiveConfig.preference = sanitizeColorPreference(
        this._settings.get_string(this._key('adaptive-text-preference')));
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    if (!this.targetActor) return;

    // The menu's own background is made transparent over the glass.
    this.targetActor.add_style_class_name('liquid-glass-transparent');
    this.animActor.add_style_class_name('liquid-glass-transparent');
    this.animActor.add_style_class_name('liquid-glass-menu-root');

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
      preference: sanitizeColorPreference(
        this._settings.get_string(this._key('adaptive-text-preference'))),
    };

    // Sized to the monitor by _syncGeometry().
    const glass = new BackdropGlass({
      extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: this._label,
    } as any);
    this.glass = glass;
    glass.set_size(1.0, 1.0);

    // The menu scales from its top centre; the glass follows it by geometry.
    this.animActor.set_pivot_point(0.5, 0.0);
    glass.set_pivot_point(0.0, 0.0);

    let menuRoot: Clutter.Actor = this.menu.actor;
    while (menuRoot.get_parent() && menuRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = menuRoot.get_parent();
      if (!p) break;
      menuRoot = p;
    }

    // Below the menu, so the glass reads the stage before the menu is drawn.
    // Not inside the menu: its BoxPointer is always drawn through an
    // offscreen.
    this._menuRoot = menuRoot;
    if (menuRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(glass, menuRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(glass);
    }

    let blurRadius = this._settings.get_int(this._key('blur-radius'));
    let tintColorStr = this._settings.get_string(this._key('tint-color'));
    let tintStrength = this._settings.get_double(this._key('tint-strength'));
    let brightness = this._settings.get_double(this._key('brightness'));
    let contrast = this._settings.get_double(this._key('contrast'));
    let saturation = this._settings.get_double(this._key('saturation'));
    this._cornerRadius = this._settings.get_double(this._key('corner-radius'));

    glass.setPadding(SHADER_PADDING);
    glass.setTintColor(...hexToColorArray(tintColorStr));
    glass.setTintStrength(tintStrength);
    glass.setCornerRadius(this._cornerRadius);
    glass.setIsDock(false);
    glass.setBrightness(brightness);
    glass.setContrast(contrast);
    glass.setSaturation(saturation);
    glass.setBlurRadius(blurRadius);

    glass.hide();

    // Follows the stage's frames while the menu is shown; an open menu that
    // does not change costs no frames.
    const stopFrameSync = () => stopStageLoop(this._frameSignalSlot, this._frameSlot);
    const startFrameSync = () => {
      if (this._frameSignalId !== 0) return;
      this._restackGlass();
      startSyncLoop(this._frameSignalSlot, this._frameSlot, {
        alive: () => !!this.glass && this.targetActor.mapped,
        honourFreeze: true,
        errorTag: 'UIManager',
        step: () => {
          // Checked before this frame's sync dirties anything.
          ensureGlassAllocated(this.glass);
          this._syncGeometry();
        },
      });
    };

    // The cached size is dropped on every open; the content may have changed.
    this._signals.push({
      target: this.menu,
      id: this.menu.connect('open-state-changed', (menu: any, isOpen: boolean) => {
        if (isOpen) {
          this._queueBackdropRefresh(this.menu?.actor);
          this._noteOwnOpenedHeight();
          this._stableBaseW = undefined;
          this._stableBaseH = undefined;
          startFrameSync();
          this._sampleColors.clear();
          this._sharedColor = null;
          this._startAdaptiveColorSampling(true);
        } else {
          this._stopAdaptiveColorSampling();
        }
      })
    });

    this._signals.push({
      target: this.menu.box,
      id: this.menu.box.connect('child-added', () => this._queueNewTextColors()),
    });

    this._signals.push({
      target: this.menu.actor,
      id: this.menu.actor.connect('notify::mapped', () => {
        if (!this.menu.actor.mapped) {
          stopFrameSync();
          // The glass outlives the menu while it goes back into the button.
          if (this._morph && !this._morph.opening) return;

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

  _syncGeometry() {
    // The morph places the glass itself.
    if (this._morph) return;
    if (!this._syncBgVisibility()) return;
    const { w, h, scaleX, scaleY } = this._measureMenu();
    const [animAbsX, animAbsY] = this._resolveMenuOrigin(w);

    let bgW = w + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgH = h + (this._glassExpand * 2) + (SHADER_PADDING * 2);
    let bgX = animAbsX - this._glassExpand - SHADER_PADDING;
    let bgY = animAbsY - this._glassExpand - SHADER_PADDING;

    let monitor = this._getMenuMonitorGeometry();
    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    if (!Number.isNaN(bgX) && !Number.isNaN(bgY) && w >= 1.0 && h >= 1.0)
      this._applyGlassBounds(this.glass!, bgX, bgY, bgW, bgH, monitorX, monitorY, screenW, screenH);

    this._applyGlassScale(scaleX, scaleY);
    // After the geometry setters, so the relays cover this frame's rect.
    this.glass!.syncSources();
  }

  private _syncBgVisibility(): boolean {
    if (!this.glass || !this.targetActor || !this.targetActor.mapped) {
      if (this.glass && this.glass.visible) {
        this.glass.hide();
      }
      return false;
    }
    if (!this.glass.visible) {
      this.glass.show();
    }
    if (!this._enableAnimation) {
      this.glass.opacity = this.targetActor.opacity;
    }
    return true;
  }

  private _measureMenu(): { w: number, h: number, scaleX: number, scaleY: number } {
    // The allocation: a hover restyle leaves a relayout pending, during
    // which get_size() reports the preferred size including CSS margins.
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

    return {
      w: Math.max(1, this._stableBaseW * scaleX),
      h: Math.max(1, this._stableBaseH * scaleY),
      scaleX,
      scaleY,
    };
  }

  private _resolveMenuOrigin(w: number): [number, number] {
    return resolveGlassOrigin(this.animActor, this as any, () => {
      const monitor = Main.layoutManager.primaryMonitor;
      if (!monitor) return [0, 0];
      return [(monitor.width / 2) - (w / 2) + this._menuXoffset, (Main.panel.height || 27) + this._menuYoffset];
    });
  }

  private _applyGlassBounds(glass: BackdropGlass, bgX: number, bgY: number, bgW: number, bgH: number,
    monitorX: number, monitorY: number, screenW: number, screenH: number) {
    if (this._lastBgW === bgW && this._lastBgH === bgH &&
      this._lastBgX === bgX && this._lastBgY === bgY &&
      this._lastScreenW === screenW && this._lastScreenH === screenH) return;

    // Monitor-local, as the shader uses them.
    let localBgX = bgX - monitorX;
    let localBgY = bgY - monitorY;
    placeScreenGlass(glass, monitorX, monitorY, screenW, screenH,
      { x: localBgX, y: localBgY, w: bgW, h: bgH });

    glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
    glass.setResolution(screenW, screenH);
    glass.setGlassGeometry(localBgX, localBgY, bgW, bgH);

    this._lastBgW = bgW; this._lastBgH = bgH;
    this._lastBgX = bgX; this._lastBgY = bgY;
    this._lastScreenW = screenW; this._lastScreenH = screenH;
  }

  private _applyGlassScale(scaleX: number, scaleY: number) {
    applyGlassScale(this.glass, this._cornerRadius, scaleX, scaleY);
  }

  _updateResolution() {
    if (!this.glass) return;
    let [width, height] = this.glass.get_size();
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      this.glass.setResolution(width, height);
    }
  }

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

    for (const child of actor.get_children())
      this._findAllTextActors(child, foundActors);

    return foundActors;
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false, batchStart?: number) {
    // Clutter.Text targets have no St style.
    if (!(actor instanceof St.Widget)) return;

    if (!this._styledActors.has(actor)) {
      this._styledActors.set(actor, actor.get_style() || '');

      actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styledActors.delete(actor);
        this._sampleColors.delete(actor);
      });
    }

    let isInsensitive = false;
    if (actor instanceof St.Button) {
      isInsensitive = !actor.reactive || actor.has_style_pseudo_class('insensitive');
    }

    if (actor._currentTargetColor === color && actor._currentInsensitiveState === isInsensitive) return;
    actor._currentTargetColor = color;
    actor._currentInsensitiveState = isInsensitive;

    this._animateActorColor(actor, color, isInsensitive, 380, skipAnimations, batchStart);
  }

  _clearAdaptiveStyles() {
    for (const [actor, originalStyle] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      adaptiveColorTweener.cancel(actor);
      actor._currentTargetColor = undefined;
      actor._currentInsensitiveState = undefined;
      actor.set_style(originalStyle || null);
    }
    this._styledActors.clear();
    this._backdropColored.clear();
    this._sampleColors.clear();
    this._sharedColor = null;
    this._disconnectHoverWatchers();
  }

  _disconnectHoverWatchers(): void {
    this._pendingBackdropRoots.clear();
    if (this._backdropRefreshId !== 0) {
      global.compositor.get_laters().remove(this._backdropRefreshId);
      this._backdropRefreshId = 0;
    }

    for (const [actor, id] of this._hoverSignals.entries()) {
      if (isActorValid(actor)) actor.disconnect(id);
    }
    this._hoverSignals.clear();
  }

  // A hovered row restyles its parent (the highlight); watching that lets the
  // text colours follow the highlight instead of the glass behind it.
  _watchHoverFor(targets: Clutter.Actor[]): void {
    const restyled = new Set(targets);
    for (const target of targets) {
      const holder = target.get_parent();
      if (!holder || restyled.has(holder) || this._hoverSignals.has(holder)) continue;
      // Only St widgets emit style-changed.
      if (!(holder instanceof St.Widget)) continue;
      this._hoverSignals.set(holder, holder.connect('style-changed', () => {
        if (this._applyingColors) return;
        this._queueBackdropRefresh(holder);
      }));
    }

    // Forget holders that have been destroyed; their handlers went with them.
    for (const actor of [...this._hoverSignals.keys()]) {
      if (!isActorValid(actor))
        this._hoverSignals.delete(actor);
    }
  }

  _queueBackdropRefresh(root: Clutter.Actor): void {
    if (!this._adaptiveConfig.enabled || !this._isEffectActive || this._actorDestroyed) return;

    this._pendingBackdropRoots.add(root);
    if (this._backdropRefreshId !== 0) return;

    this._backdropRefreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._backdropRefreshId = 0;
      const roots = [...this._pendingBackdropRoots];
      this._pendingBackdropRoots.clear();

      const targets: Clutter.Actor[] = [];
      for (const actor of roots) {
        if (isActorValid(actor)) this._findAllTextActors(actor, targets);
      }
      this._applyBackdropColorsTo(targets);
      return GLib.SOURCE_REMOVE;
    });
  }

  _applyBackdropColorsTo(targets: Clutter.Actor[]): void {
    if (!targets || targets.length === 0) return;

    const root = this.menu?.actor ?? null;
    const batchStart = GLib.get_monotonic_time();
    // Our own restyles emit style-changed too; see _watchHoverFor().
    this._applyingColors = true;
    for (const actor of new Set(targets)) {
      const color = this._contrastSampler._backdropColorFor(actor, this._adaptiveConfig, root);
      if (color) {
        this._backdropColored.add(actor);
        this._setActorColor(actor as unknown as CustomBannerActor, color, true, batchStart);
        continue;
      }
      // Off the highlight, the text goes straight back to the colour the rest
      // of the menu has, so moving along the rows never leaves two colours.
      const sampled = this._sampleColors.get(actor);
      if (this._backdropColored.delete(actor) && sampled)
        this._setActorColor(actor as unknown as CustomBannerActor, sampled, true, batchStart);
    }
    this._applyingColors = false;
  }

  // Iterates through the color map and applies the new target colors to the respective actors
  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0)
      return;

    // One timestamp for the whole map, so a row of labels flips together.
    const batchStart = GLib.get_monotonic_time();
    this._applyingColors = true;
    for (const [actor, color] of colorMap.entries()) {
      this._sampleColors.set(actor, color);
      if (this._backdropColored.has(actor)) continue;
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations, batchStart);
    }
    this._applyingColors = false;
  }

  /**
   * @param skipAnimations Set on open. The first sample is taken before the
   *   first frame, before the glass is drawn: the screen then shows the bare
   *   backdrop where the menu will be, and the glass's tone predicts the rest.
   *   Its colours are applied without a tween and kept while the open
   *   animation runs, during which the glass is still growing over the
   *   backdrop. The last open's decision is forgotten: the menu may be over
   *   something else now.
   */
  _startAdaptiveColorSampling(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled)
      return;

    if (skipAnimations) {
      this._contrastSampler.reset();
      this._awaitingOpenColors = true;
      // From GNOME 51 on, open-state-changed comes before the menu is shown
      // and placed; an idle of high priority runs once open() has returned,
      // still ahead of the frame.
      if (this._openSampleId === 0) {
        this._openSampleId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
          this._openSampleId = 0;
          this._updateAdaptiveTextColors(true);
          return GLib.SOURCE_REMOVE;
        });
      }
    } else {
      this._updateAdaptiveTextColors(false);
    }

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

        const opening = this._tickId !== 0;
        if (!opening || this._awaitingOpenColors)
          this._updateAdaptiveTextColors(this._awaitingOpenColors);
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  _stopAdaptiveColorSampling() {
    if (this._adaptiveTimerId !== 0) {
      GLib.source_remove(this._adaptiveTimerId);
      this._adaptiveTimerId = 0;
    }
    if (this._openSampleId !== 0) {
      GLib.source_remove(this._openSampleId);
      this._openSampleId = 0;
    }
    if (this._newTextId !== 0) {
      global.compositor.get_laters().remove(this._newTextId);
      this._newTextId = 0;
    }
    this._newTextPending = false;
  }

  // Some menus add their items as they open (Kiwi Menu rebuilds them every
  // time), after the open sample. Their text takes the menu's colour before it
  // is drawn, rather than the theme's until the next sample; before the first
  // sample has a colour, the items are what it waits for.
  _queueNewTextColors(): void {
    if (!this._adaptiveConfig.enabled || !this.menu?.isOpen || this._newTextId !== 0) return;
    this._newTextId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._newTextId = 0;
      if (this._adaptiveInFlight)
        this._newTextPending = true;
      else if (this._sharedColor !== null)
        this._colorNewText();
      else if (this._awaitingOpenColors)
        this._updateAdaptiveTextColors(true);
      return GLib.SOURCE_REMOVE;
    });
  }

  private _colorNewText(): void {
    const color = this._sharedColor;
    if (color === null) return;
    const fresh = this._collectAdaptiveTextTargets().filter(actor => !this._sampleColors.has(actor));
    if (fresh.length === 0) return;
    this._watchHoverFor(fresh);
    this._applyBackdropColorsTo(fresh);
    this._applyAdaptiveColorMap(new Map(fresh.map(actor => [actor, color])), true);
  }

  _updateAdaptiveTextColors(skipAnimations = false) {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight)
      return;

    let targets = this._collectAdaptiveTextTargets();
    // A menu still empty when it opens is measured all the same, through its
    // box, so the text it gets next can take the colour straight away.
    const placeholder = targets.length === 0 && this._awaitingOpenColors && !this._adaptiveConfig.samplePerElement
      ? this.menu?.box ?? null : null;
    if (placeholder)
      targets = [placeholder];
    if (targets.length === 0)
      return;

    if (!placeholder) this._watchHoverFor(targets);

    this._adaptiveInFlight = true;

    // A menu that rebuilds its items can destroy text while it is measured.
    const gone = new Set<Clutter.Actor>();
    const destroyIds = targets.map(actor => actor.connect('destroy', () => gone.add(actor)));
    const unwatch = () => targets.forEach((actor, i) => {
      if (!gone.has(actor)) actor.disconnect(destroyIds[i]);
    });

    this._contrastSampler
      .chooseColorsForActors(targets, this._adaptiveConfig, this.menu?.actor,
        () => this.glass?.paintCount ?? NaN, () => this.glass ? [this.glass] : [])
      .then(colorMap => {
        for (const actor of gone) colorMap.delete(actor);
        if (!this._isEffectActive || this._actorDestroyed) return;
        if (placeholder) {
          this._sharedColor = colorMap.get(placeholder) ?? null;
          if (this._sharedColor !== null) {
            this._awaitingOpenColors = false;
            this._colorNewText();
          }
          return;
        }
        this._applyAdaptiveColorMap(colorMap, skipAnimations);
        if (colorMap.size > 0) {
          this._awaitingOpenColors = false;
          if (!this._adaptiveConfig.samplePerElement)
            this._sharedColor = colorMap.values().next().value ?? null;
        }
      })
      .catch(e => {
        this._logger.error(`[Liquid Glass] Menu adaptive color update failed: ${e}`);
      })
      .finally(() => {
        unwatch();
        this._adaptiveInFlight = false;
        if (this._newTextPending) {
          this._newTextPending = false;
          this._queueNewTextColors();
        }
      });
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, isInsensitive: boolean,
    durationMs = 380, skipAnimations = false, batchStart?: number) {
    // An existing tween is not cancelled: add() restarts from the colour it
    // last applied.
    const originalStyle = (this._styledActors.get(actor) || '').trim();
    const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();

    let targetRgb = hexToRgb(targetHexColor);

    // Insensitive items keep their dimmed look.
    let targetAlpha = isInsensitive ? 0.5 : 1.0;
    let startAlpha = startColor.alpha / 255.0;

    const apply = (r: number, g: number, b: number, a: number) => {
      const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`);
    };

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

  // The spring open/close animation.
  _startAnimation(targetValue: number) {
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

    if (this.animActor) this.animActor.remove_all_transitions();
    if (this.glass) this.glass.remove_all_transitions();

    if (this._swiftAnimation) {
      this._swiftSpringScale.updateParams(this._swiftResponse, this._swiftDampingFraction);
      this._swiftSpringScale.target = targetValue;
      if (Number.isNaN(this._swiftSpringScale.value)) this._swiftSpringScale.value = 0;
    } else {
      this._springScale.target = targetValue;
    }

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

        const frame = stepMenuSpring(this._swiftAnimation ? this._swiftSpringScale : this._springScale, elapsedMs);
        if (frame.stopped) this._tickId = 0;
        applyMenuFrame(frame, this.animActor, this.glass, this.menu.actor, () => this._syncGeometry());
        return frame.stopped ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
      }, normalizeAnimationIntervalMs(this._animationInterval));
    }
  }

  // The button the menu belongs to, as the glass it grows out of: the capsule
  // the theme highlights it with, [x, y, w, h] in stage coordinates, or null
  // when it is not on screen. Panel buttons draw it inside a transparent
  // border, and the clock on its label rather than on the whole button.
  private _buttonRect(): number[] | null {
    const source = this.menu?.sourceActor;
    if (!source || !isActorValid(source) || !source.mapped) return null;
    const label = (source as any)._clockDisplay;
    const actor: St.Widget = label instanceof St.Widget && label.mapped ? label : source;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w >= 1) || !(h >= 1)) return null;
    const node = actor.get_theme_node();
    const [sx, sy] = actor.get_transformed_size().map((v, i) => v / Math.max(i ? actor.height : actor.width, 1));
    const left = node.get_border_width(St.Side.LEFT) * sx, right = node.get_border_width(St.Side.RIGHT) * sx;
    const top = node.get_border_width(St.Side.TOP) * sy, bottom = node.get_border_width(St.Side.BOTTOM) * sy;
    if (w - left - right < 1 || h - top - bottom < 1) return [x, y, w, h];
    return [x + left, y + top, w - left - right, h - top - bottom];
  }

  // Where the menu's items are at rest: their stage rect without the
  // morph's own scale and shift, and the scale (`k`) the menu puts on them.
  private _menuRest(): { x: number, y: number, w: number, h: number, k: number } | null {
    if (!this.targetActor.mapped) return null;
    const a = this.animActor;
    const [w, h] = getAllocatedSize(a);
    const [tx, ty] = a.get_transformed_position();
    const k = this.targetActor.get_scale()[0] || 1;
    const x = tx - a.translation_x * k;
    const y = ty - a.translation_y * k;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 1) || !(h > 1)) return null;
    return { x, y, w: w * k, h: h * k, k };
  }

  // The resting menu's glass body, [x, y, w, h] in stage coordinates.
  private _menuBodyRect(): number[] | null {
    const rest = this._menuRest();
    if (!rest) return null;
    const e = this._glassExpand;
    return [rest.x - e, rest.y - e, rest.w + e * 2, rest.h + e * 2];
  }

  /**
   * Starts the glass towards the menu (`open`) or back into the button.
   * False when there is no button to grow out of; the scale spring runs then.
   */
  private _startMorph(open: boolean): boolean {
    const button = this._buttonRect();
    if (!this.glass || !button) return false;
    // Reversing midway starts from where the glass is.
    const prev = this._morph;
    if (!open && !prev?.motion && !this._menuBodyRect()) return false;

    this._stopMorphTicker();
    let lens = prev?.lens;
    if (!lens) {
      lens = new ContentLens();
      this.animActor.add_effect_with_name(CONTENT_LENS, lens);
    }
    const blurRadius = this._settings.get_int(this._key('blur-radius'));
    // Opened again while closing: the glass is the menu's again at once, not from the next frame.
    if (open && prev && prev.shownBlurRadius !== blurRadius) this.glass.setBlurRadius(blurRadius);
    if (open) this.glass.setAnimationScale(1);
    this._morph = {
      opening: open, motion: null, button, lens, lastUs: 0, waitFrames: 0,
      from: prev?.motion?.frame ?? null, velocities: prev?.motion?.velocities ?? null,
      refraction: this._settings.get_double('glass-displacement-scale'), blurRadius,
      shownBlurRadius: open ? blurRadius : prev?.shownBlurRadius ?? blurRadius,
    };
    this.animActor.remove_all_transitions();
    this.glass.remove_all_transitions();
    this.animActor.set_pivot_point(0, 0);
    this._morphTickId = addFrameTicker(() => this._stepMorph(),
      normalizeAnimationIntervalMs(this._animationInterval));
    return true;
  }

  private _stepMorph(): boolean {
    const m = this._morph;
    if (!m || !this.glass) {
      this._morphTickId = 0;
      return false;
    }
    m.button = this._buttonRect() ?? m.button;
    // The menu stays where it opens; closing, it only fades.
    for (const name of m.opening ? BOXPOINTER_EASED : BOXPOINTER_MOVES) {
      const ease = this.targetActor.get_transition(name);
      if (!ease) continue;
      if (m.opening) ease.set_from(ease.get_interval().peek_final_value());
      else ease.set_to(ease.get_interval().peek_initial_value());
    }

    const menu = this._menuBodyRect();
    if (!m.motion) {
      if (!menu) {
        // Not laid out yet: hold the glass on the button for a few frames.
        this._placeMorph({ body: m.button, bodyRadius: m.button[3] / 2, contentScale: 1,
          contentOpacity: 0, lens: 0, glassOpacity: 1, soften: 0, done: false });
        if (++m.waitFrames < MORPH_WAIT_FRAMES) return true;
        this._morphTickId = 0;
        this._endMorph();
        return false;
      }
      m.motion = new MenuMorphMotion(m.opening, m.button, menu, this._cornerRadius, m.from, m.velocities);
    } else {
      m.motion.retarget(m.button, menu, this._cornerRadius);
    }

    const now = GLib.get_monotonic_time();
    const frame = m.motion.step(m.lastUs ? (now - m.lastUs) / 1e6 : 1 / 60);
    m.lastUs = now;
    this._placeMorph(frame);
    if (!frame.done) return true;

    this._morphTickId = 0;
    const closed = !m.opening;
    this._endMorph();
    if (closed) {
      this.glass.hide();
      this.glass.opacity = 0;
      this.animActor.opacity = 0;
      if (!this.menu.isOpen) this.menu.actor.hide();
    }
    return false;
  }

  // Draws the travelling glass (stage coordinates) and the menu's items in it.
  private _placeMorph(f: MorphFrame): void {
    const glass = this.glass!;
    const monitor = this._getMenuMonitorGeometry();
    const mx = monitor?.x ?? 0;
    const my = monitor?.y ?? 0;
    const p = SHADER_PADDING;
    const body = f.body;
    if (!glass.visible) glass.show();
    glass.opacity = Math.round(255 * f.glassOpacity);
    this._applyGlassBounds(glass, body[0] - p, body[1] - p, body[2] + p * 2, body[3] + p * 2,
      mx, my, Math.max(1, monitor?.width ?? 1), Math.max(1, monitor?.height ?? 1));
    glass.setCornerRadius(f.bodyRadius);
    this._softenGlass(glass, f.soften);
    this._placeContent(f);
    glass.syncSources();
  }

  // Takes the refraction and the blur from their settings towards
  // SOFT_REFRACTION and SOFT_BLUR_RADIUS, by `soften` (0 to 1).
  private _softenGlass(glass: InstanceType<typeof BackdropGlass>, soften: number): void {
    const m = this._morph!;
    const toward = (from: number, to: number) => from + (Math.min(from, to) - from) * soften;
    glass.setAnimationScale(m.refraction > 0 ? toward(m.refraction, SOFT_REFRACTION) / m.refraction : 1);
    const blur = Math.round(toward(m.blurRadius, SOFT_BLUR_RADIUS));
    if (blur !== m.shownBlurRadius) {
      m.shownBlurRadius = blur;
      glass.setBlurRadius(blur);
    }
  }

  // Draws the menu's items `f.contentScale` times their size around the
  // middle of the travelling glass, cut to its outline.
  private _placeContent(f: MorphFrame): void {
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

  private _stopMorphTicker(): void {
    if (!this._morphTickId) return;
    removeFrameTicker(this._morphTickId);
    this._morphTickId = 0;
  }

  // Leaves the glass and the menu as the rest of the manager expects them.
  private _endMorph(): void {
    this._stopMorphTicker();
    const m = this._morph;
    if (!m) return;
    this._morph = null;
    if (this.glass) {
      this.glass.setAnimationScale(1);
      if (m.shownBlurRadius !== m.blurRadius) this.glass.setBlurRadius(m.blurRadius);
    }
    if (!this._actorDestroyed && this.animActor) {
      this.animActor.remove_effect_by_name(CONTENT_LENS);
      this.animActor.remove_clip();
      this.animActor.set_translation(0, 0, 0);
      this.animActor.set_scale(1.0, 1.0);
      this.animActor.set_pivot_point(0.5, 0.0);
      this.animActor.opacity = 255;
    }
    if (this.glass && this.targetActor.mapped) this._syncGeometry();
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;

    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();
    this._disconnectEffectSources();
    this._restoreMenuActors();
    this._releaseGlass();
  }

  private _disconnectEffectSources() {
    for (let sig of this._signals)
      sig.target.disconnect(sig.id);
    this._signals = [];

    if (this._tickId) {
      removeFrameTicker(this._tickId);
      this._tickId = 0;
    }
    this._endMorph();

    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    this._disconnectAccentColor();
  }

  private _disconnectAccentColor() {
    if (this._accentColorTimeoutId) {
      GLib.Source.remove(this._accentColorTimeoutId);
      this._accentColorTimeoutId = 0;
    }
    if (this._interfaceSettings && this._accentColorSignalId) {
      this._interfaceSettings.disconnect(this._accentColorSignalId);
      this._accentColorSignalId = 0;
      this._interfaceSettings = null;
    }
  }

  private _restoreMenuActors() {
    if (!this._actorDestroyed) this.targetActor.remove_style_class_name('liquid-glass-transparent');
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
        this.menu.close(MENU_NO_ANIMATION);
      }
    }
  }

  private _releaseGlass() {
    const glass = this.glass;
    this.glass = null;
    if (glass) {
      glass.cleanup();
      // At shell shutdown the stage may have destroyed it already.
      if (isActorValid(glass)) glass.destroy();
    }
    this._menuRoot = null;

    this._stableBaseW = undefined;
    this._stableBaseH = undefined;
  }

  cleanup() {
    this._cancelHeightMeasurement();
    stopStageLoop(this._frameSignalSlot, this._frameSlot);

    for (let sigId of this._settingsSignals)
      this._settings.disconnect(sigId);
    this._settingsSignals = [];

    // These exist even while the effect is off.
    if (this._animSignalId) {
      this.menu.disconnect(this._animSignalId);
      this._animSignalId = 0;
    }
    if (this._destroySignalId) {
      this.targetActor.disconnect(this._destroySignalId);
      this._destroySignalId = 0;
    }
    this._disconnectAccentColor();

    this._removeEffect();
  }
}
