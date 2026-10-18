import type Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import type Mtk from 'gi://Mtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { getWindowActors } from './actors/windows.js';
import { isActorValid } from './actors/lifecycle.js';
import { getAllocatedSize } from './actors/geometry.js';
import { setActorVisible, ensureGlassAllocated, ensureWindowActorAllocated } from './actors/allocation.js';
import { setPositionIfChanged, setSizeIfChanged } from './actors/writes.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { hexToColorArray } from './animation/colors.js';
import { noteStrandEntry } from './diagnostics/glass.js';
import { reportFrameLoopError } from './diagnostics/logging.js';

import { Logger } from './logger.js';

// How far the glass extends past the window on each side. It is both the
// sampling headroom for refraction and blur and the only room the drop shadow
// has to render into, so it grows with the shadow settings instead of
// enlarging every window's glass permanently.
const GLASS_MIN_MARGIN = 10;
// Room between the shadow's largest radius and the actor edge, so the shadow
// fades out before it is clipped. dockManager leaves the same 20px.
const SHADOW_MARGIN_HEADROOM = 20;
// prefs.js caps shadow-radius at 100.
const GLASS_MAX_MARGIN = 100 + SHADOW_MARGIN_HEADROOM;

// Consecutive stranded frames before each stage of the window actor rescue:
// first a relayout of the nearest allocated ancestor, then a remap of mutter's
// window actor itself. See ensureWindowActorAllocated().
const WINDOW_ACTOR_RELAYOUT_FRAMES = 4;
const WINDOW_ACTOR_STRANDED_FRAMES = 14;

/**
 * Which settings namespace a window's glass reads from. `desktop-menu` is the
 * desktop's own right-click menu, which on Wayland is a toplevel window rather
 * than a shell widget (see _isDesktopMenuWindow()).
 */
type GlassProfile = 'application' | 'desktop-menu';

// GTK's Wayland backend maps a menu xdg_popup onto DROPDOWN_MENU; the other
// two cover X11 and toolkits that pick a different hint.
const MENU_WINDOW_TYPES = [
  Meta.WindowType.DROPDOWN_MENU,
  Meta.WindowType.POPUP_MENU,
  Meta.WindowType.MENU,
];

// Bound on the transient_for walk, so a cycle cannot hang the first-frame
// handler. A desktop menu is one hop from the desktop, submenus a few more.
const MAX_TRANSIENT_DEPTH = 8;

interface WindowState {
  // Fixed when the state is built; a profile change rebuilds the state.
  profile: GlassProfile;
  windowActor: Meta.WindowActor;
  // The window's own surface. Cached because the glass is inserted below it,
  // after which get_first_child() no longer returns it.
  surfaceActor: Clutter.Actor;
  // Surface opacity before the glass dialled it down; restored on cleanup.
  originalOpacity: number;
  glass: BackdropGlass;
  signals: { obj: any, id: number }[];
  // Pending later from _forceGlassReallocation().
  remapReallocLaterId?: number;
  // Last known-good invisible border offset and the actor position it was
  // sampled at. See _frameLocalOffset().
  frameLocal?: [number, number];
  frameLocalActorPos?: [number, number];
  // Inputs of the last geometry sync, compared exactly each frame.
  geomSig?: Float64Array;
}

export class ApplicationManager {
  private _extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private _states: Map<Meta.WindowActor, WindowState> = new Map();
  private _settingsSignals: number[] = [];
  private _displaySignals: number[] = [];
  // Handlers on windows created but not yet painted. See _onWindowCreated().
  private _newWindows: Map<Meta.WindowActor, number[]> = new Map();
  private _frameSignalId = 0;
  private _lastTickUs = 0;
  private _glassMargin = GLASS_MIN_MARGIN;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this._extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
  }

  setup() {
    this._glassMargin = this._computeGlassMargin();
    this._bindSettings();

    this._displaySignals.push(
      global.display.connect('window-created', (_d, metaWindow) => this._onWindowCreated(metaWindow)));

    if (this._isEffectEnabled())
      this._applyEffects();
  }

  cleanup() {
    for (const id of this._displaySignals)
      global.display.disconnect(id);
    this._displaySignals = [];

    for (const actor of this._newWindows.keys())
      this._forgetNewWindow(actor);

    for (const id of this._settingsSignals)
      this._settings.disconnect(id);
    this._settingsSignals = [];

    this._removeAllEffects();
  }

  // A window can only be dressed once it has painted. The handlers are
  // dropped after the first frame, when the window goes away first, or on
  // cleanup.
  _onWindowCreated(metaWindow: Meta.Window) {
    const actor = metaWindow.get_compositor_private() as Meta.WindowActor | null;
    if (!actor) return;

    this._newWindows.set(actor, [
      actor.connect('first-frame', () => {
        this._forgetNewWindow(actor);
        if (this._shouldApplyToWindow(actor))
          this._setupWindow(actor);
      }),
      actor.connect('destroy', () => this._forgetNewWindow(actor)),
    ]);
  }

  _forgetNewWindow(actor: Meta.WindowActor) {
    const ids = this._newWindows.get(actor);
    if (!ids) return;
    this._newWindows.delete(actor);
    for (const id of ids)
      actor.disconnect(id);
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: () => void) => {
      this._settingsSignals.push(this._settings.connect(`changed::${key}`, callback));
    };

    for (const profile of ['application', 'desktop-menu'] as const) {
      // _syncWhitelist() drops the windows that no longer qualify, builds the
      // ones that now do, and removes everything when both switches are off.
      connectSetting(this._profileEnableKey(profile), () => {
        this._syncWhitelist();
        if (this._isEffectEnabled())
          this._startFrameSync();
      });

      for (const suffix of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius',
        'brightness', 'contrast', 'saturation'])
        connectSetting(this._profileKey(profile, suffix), () => this._updateEffectParams());

      connectSetting(this._profileKey(profile, 'content-opacity'), () => this._updateWindowOpacities());
    }

    connectSetting('application-glass-all-windows', () => this._syncWhitelist());
    connectSetting('application-window-whitelist', () => this._syncWhitelist());
    connectSetting('application-window-blacklist', () => this._syncWhitelist());

    // The shadow renders into the margin, so these resize the glass.
    connectSetting('shadow-radius', () => this._updateGlassMargin());
    connectSetting('shadow-intensity', () => this._updateGlassMargin());
  }

  _getContentOpacity(profile: GlassProfile = 'application'): number {
    return this._settings.get_double(this._profileKey(profile, 'content-opacity'));
  }

  _updateWindowOpacities() {
    for (const state of this._states.values()) {
      if (isActorValid(state.surfaceActor))
        state.surfaceActor.opacity = Math.round(this._getContentOpacity(state.profile) * 255);
    }
  }

  /** Appearance key in a profile's namespace, e.g. `desktop-menu-tint-color`. */
  _profileKey(profile: GlassProfile, suffix: string): string {
    return `${profile}-${suffix}`;
  }

  /** The switch that turns one profile on, e.g. `enable-desktop-menu-glass`. */
  _profileEnableKey(profile: GlassProfile): string {
    return `enable-${profile}-glass`;
  }

  _isProfileEnabled(profile: GlassProfile): boolean {
    return this._settings.get_boolean(this._profileEnableKey(profile));
  }

  // Whether any profile wants glass. The per-window decision is made in
  // _profileForWindow().
  _isEffectEnabled(): boolean {
    return this._isProfileEnabled('application') || this._isProfileEnabled('desktop-menu');
  }

  // WM_CLASS casing differs between toolkits, and the preferences promise a
  // case-insensitive match.
  _listContainsClass(list: string[], wmClass: string | null): boolean {
    if (!wmClass)
      return false;
    const normalized = wmClass.toLowerCase();
    return list.some(entry => entry.toLowerCase() === normalized);
  }

  _windowMatchesWhitelist(metaWindow: Meta.Window): boolean {
    const whitelist = this._settings.get_strv('application-window-whitelist');
    return this._listContainsClass(whitelist, metaWindow.get_wm_class());
  }

  _windowMatchesBlacklist(metaWindow: Meta.Window): boolean {
    const blacklist = this._settings.get_strv('application-window-blacklist');
    return this._listContainsClass(blacklist, metaWindow.get_wm_class());
  }

  /**
   * Whether this is the menu the desktop itself puts up (right-click on the
   * wallpaper). On GNOME 50 / Wayland with Desktop Icons NG it is a
   * DROPDOWN_MENU window with no WM_CLASS or application id, transient for
   * the DESKTOP window, so the menu type plus that transient chain is the
   * only reliable signature. An in-app popup such as Chrome's has neither.
   * Override-redirect windows are managed by their clients and left alone.
   */
  _isDesktopMenuWindow(metaWindow: Meta.Window): boolean {
    if (metaWindow.is_override_redirect())
      return false;
    if (!MENU_WINDOW_TYPES.includes(metaWindow.get_window_type()))
      return false;

    let parent: Meta.Window | null = metaWindow.get_transient_for();
    for (let depth = 0; parent && depth < MAX_TRANSIENT_DEPTH; depth++) {
      if (parent.get_window_type() === Meta.WindowType.DESKTOP)
        return true;
      // A submenu is transient for its parent menu. Walk through menus only,
      // never up through an ordinary app window.
      if (!MENU_WINDOW_TYPES.includes(parent.get_window_type()))
        return false;
      parent = parent.get_transient_for();
    }
    return false;
  }

  /**
   * The profile that should dress this window, or null to leave it alone.
   * _shouldApplyToWindow() and _setupWindow() both use it so they agree.
   */
  _profileForWindow(windowActor: Meta.WindowActor): GlassProfile | null {
    const metaWindow = windowActor.get_meta_window();
    if (!metaWindow)
      return null;

    // Checked first so a desktop menu can never fall through to "apply to
    // all windows" and pick up the application settings.
    if (this._isDesktopMenuWindow(metaWindow))
      return this._isProfileEnabled('desktop-menu') ? 'desktop-menu' : null;

    if (!this._isProfileEnabled('application'))
      return null;

    // "Apply to all windows" skips the whitelist but still only covers normal
    // and dialog windows, and still honours the blacklist.
    if (this._settings.get_boolean('application-glass-all-windows')) {
      const windowType = metaWindow.get_window_type();
      const isNormal = windowType === Meta.WindowType.NORMAL ||
        windowType === Meta.WindowType.DIALOG ||
        windowType === Meta.WindowType.MODAL_DIALOG;
      if (!isNormal || this._windowMatchesBlacklist(metaWindow))
        return null;
      return 'application';
    }

    return this._windowMatchesWhitelist(metaWindow) ? 'application' : null;
  }

  _shouldApplyToWindow(windowActor: Meta.WindowActor): boolean {
    return this._profileForWindow(windowActor) !== null;
  }

  _applyEffects() {
    this._buildForExistingWindows();
    this._startFrameSync();
  }

  _removeAllEffects() {
    this._stopFrameSync();

    for (const state of this._states.values())
      this._cleanupState(state);
    this._states.clear();
  }

  _syncWhitelist() {
    if (!this._isEffectEnabled()) {
      this._removeAllEffects();
      return;
    }

    // A window that now belongs to the other profile is rebuilt too, since
    // the profile is fixed in its state.
    for (const [actor, state] of this._states.entries()) {
      if (this._profileForWindow(actor) !== state.profile) {
        this._cleanupState(state);
        this._states.delete(actor);
      }
    }

    for (const actor of getWindowActors()) {
      if (this._shouldApplyToWindow(actor) && !this._states.has(actor))
        this._setupWindow(actor);
    }
  }

  // The margin the shadow settings need. Without a shadow the glass keeps the
  // minimum, so its framebuffers are not enlarged for nothing.
  _computeGlassMargin(): number {
    const radius = this._settings.get_double('shadow-radius');
    const intensity = this._settings.get_double('shadow-intensity');
    if (!(radius > 0) || !(intensity > 0))
      return GLASS_MIN_MARGIN;

    return Math.min(GLASS_MAX_MARGIN,
      Math.max(GLASS_MIN_MARGIN, Math.ceil(radius) + SHADOW_MARGIN_HEADROOM));
  }

  // Pushes a changed margin into every glass. The margin is part of the
  // geometry signature, so the next frame resizes the glass.
  _updateGlassMargin(): void {
    const next = this._computeGlassMargin();
    if (next === this._glassMargin) return;

    this._glassMargin = next;
    const shadowRoom = Math.max(0, next - SHADOW_MARGIN_HEADROOM);

    for (const state of this._states.values()) {
      state.glass.setPadding(next);
      state.glass.setShadowMaxRadius(shadowRoom);
    }
  }

  _updateEffectParams() {
    for (const state of this._states.values())
      this._applyAppearance(state.glass, state.profile);
  }

  _applyAppearance(glass: BackdropGlass, profile: GlassProfile): void {
    const k = (suffix: string) => this._profileKey(profile, suffix);
    glass.setTintColor(...hexToColorArray(this._settings.get_string(k('tint-color'))));
    glass.setTintStrength(this._settings.get_double(k('tint-strength')));
    glass.setCornerRadius(this._settings.get_double(k('corner-radius')));
    glass.setBlurRadius(this._settings.get_int(k('blur-radius')));
    glass.setBrightness(this._settings.get_double(k('brightness')));
    glass.setContrast(this._settings.get_double(k('contrast')));
    glass.setSaturation(this._settings.get_double(k('saturation')));
  }

  // The sync runs from the stage's 'before-update', i.e. only on frames the
  // compositor paints anyway, and never requests frames of its own.
  _startFrameSync() {
    if (this._frameSignalId !== 0) return;
    this._frameSignalId = global.stage.connect('before-update', () => this._frameTick());
    this._frameTick();
  }

  _stopFrameSync() {
    if (!this._frameSignalId) return;
    global.stage.disconnect(this._frameSignalId);
    this._frameSignalId = 0;
  }

  _buildForExistingWindows() {
    for (const actor of getWindowActors()) {
      if (this._shouldApplyToWindow(actor))
        this._setupWindow(actor);
    }
  }

  _setupWindow(windowActor: Meta.WindowActor) {
    if (this._states.has(windowActor))
      return;

    const profile = this._profileForWindow(windowActor);
    if (!profile)
      return;

    const surfaceActor = windowActor.get_first_child();
    if (!surfaceActor || !windowActor.get_parent())
      return;

    const originalOpacity = surfaceActor.opacity;
    surfaceActor.opacity = Math.round(this._getContentOpacity(profile) * 255);

    // Inside the window actor and below its surface: it moves, scales and
    // fades with the window, and it reads the stage after everything below
    // the window and before the window itself.
    const glass = new BackdropGlass({
      extensionPath: this._extensionPath,
      settings: this._settings,
      logger: this._logger,
      owner: profile,
    } as any);
    glass.set_name('liquid-glass-window');
    glass.setPadding(this._glassMargin);
    this._applyAppearance(glass, profile);
    glass.setIsDock(false);
    // No rim, specular or sheen: around a window with translucent content
    // they read as a bright frame. Only this window's glass is affected.
    glass.setSurfaceLightEnabled(false);
    // Windows draw their own circular corners, which the glass has to match.
    glass.setCornerSmoothingEnabled(false);
    glass.setShadowMaxRadius(Math.max(0, this._glassMargin - SHADOW_MARGIN_HEADROOM));
    windowActor.insert_child_below(glass, surfaceActor);

    const state: WindowState = {
      profile,
      windowActor,
      surfaceActor,
      originalOpacity,
      glass,
      signals: [],
    };
    this._states.set(windowActor, state);

    state.signals.push({
      obj: windowActor,
      id: windowActor.connect('notify::mapped', () => {
        if (windowActor.mapped)
          this._forceGlassReallocation(state);
      }),
    });

    const metaWin = windowActor.get_meta_window();
    if (metaWin) {
      state.signals.push({
        obj: metaWin,
        // Maximize and tiling change the invisible border.
        id: metaWin.connect('size-changed', () => { state.frameLocal = undefined; }),
      });
    }

    // The glass is a child of the window actor and is already disposed when
    // this runs; _cleanupState() checks for that.
    state.signals.push({
      obj: windowActor,
      id: windowActor.connect('destroy', () => {
        this._cleanupState(state);
        this._states.delete(windowActor);
      }),
    });
  }

  // The frame rect's origin inside the buffer rect, i.e. the invisible CSD
  // border. It only changes with the decorations, but during a drag the frame
  // rect trails the buffer rect by a frame, so the difference jumps by the
  // mouse movement. It is sampled only while the actor stands still;
  // 'size-changed' clears it.
  _frameLocalOffset(
    state: WindowState,
    actor: Meta.WindowActor,
    rect: Mtk.Rectangle,
    bufferRect: Mtk.Rectangle
  ): [number, number] {
    const px = actor.x;
    const py = actor.y;
    const prev = state.frameLocalActorPos;
    const stationary = !!prev && prev[0] === px && prev[1] === py;
    state.frameLocalActorPos = [px, py];

    if (!state.frameLocal || stationary) {
      const fx = rect.x - bufferRect.x;
      const fy = rect.y - bufferRect.y;
      if (Number.isFinite(fx) && Number.isFinite(fy))
        state.frameLocal = [fx, fy];
    }

    return state.frameLocal ?? [0, 0];
  }

  // Hides the glass while its window is not shown on this workspace. The
  // geometry signature is dropped so the next sync places it again.
  _hideGlass(state: WindowState): void {
    setActorVisible(state.glass, false);
    state.geomSig = undefined;
  }

  _syncState(state: WindowState) {
    const actor = state.windowActor;
    if (!actor.get_stage() || !actor.mapped) {
      this._hideGlass(state);
      return;
    }

    const metaWin = actor.get_meta_window();
    if (!metaWin) return;

    // Folds the repaints of the setters below into one.
    state.glass.beginBatch();
    try {
      this._syncStateInner(state, actor, metaWin);
    } finally {
      state.glass.endBatch();
    }
  }

  /**
   * Places the glass on the frame rect, in the window actor's coordinates.
   * GNOME animates a window (open, close, minimise, resize) through the
   * actor's scale and translation while the frame rect is already final, and
   * the glass follows those transforms with the window. They still move it on
   * screen, so they are part of the signature that tells syncSources().
   */
  _syncStateInner(state: WindowState, actor: Meta.WindowActor, metaWin: Meta.Window) {
    const winWorkspace = metaWin.get_workspace();
    if (winWorkspace && winWorkspace !== global.workspace_manager.get_active_workspace()) {
      this._hideGlass(state);
      return;
    }

    const rect = metaWin.get_frame_rect();
    const bufferRect = metaWin.get_buffer_rect();
    if (rect.width <= 0 || rect.height <= 0) {
      this._hideGlass(state);
      return;
    }

    setActorVisible(state.glass, true);

    const [frameLocalX, frameLocalY] = this._frameLocalOffset(state, actor, rect, bufferRect);
    const margin = this._glassMargin;
    const w = rect.width + margin * 2;
    const h = rect.height + margin * 2;

    const [pivotX, pivotY] = actor.get_pivot_point();
    const [actorW, actorH] = getAllocatedSize(actor);
    const moved = !this._updateGeometrySignature(state, [
      w, h, frameLocalX, frameLocalY,
      actor.x, actor.y,
      actor.translation_x, actor.translation_y,
      actor.scale_x, actor.scale_y,
      pivotX * (Number.isFinite(actorW) ? actorW : 0),
      pivotY * (Number.isFinite(actorH) ? actorH : 0),
    ]);

    if (moved) {
      setPositionIfChanged(state.glass, frameLocalX - margin, frameLocalY - margin);
      setSizeIfChanged(state.glass, w, h);
      state.glass.setResolution(w, h);
      state.glass.setGlassGeometry(0, 0, w, h);
    }

    // Every frame: the windows below move on their own.
    state.glass.syncSources(moved);
  }

  // Stores `values` as the geometry signature and returns whether it was
  // unchanged. A new signature starts as NaN, which never compares equal.
  private _updateGeometrySignature(state: WindowState, values: number[]): boolean {
    let sig = state.geomSig;
    if (!sig || sig.length !== values.length) {
      sig = new Float64Array(values.length).fill(NaN);
      state.geomSig = sig;
    }

    let unchanged = true;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] !== values[i]) {
        unchanged = false;
        sig[i] = values[i];
      }
    }
    return unchanged;
  }

  _frameTick() {
    // Diagnostic switch that freezes the sync so its cost can be measured.
    if (isFrameSyncFrozen()) return;

    // Two stage views updating in the same frame each emit 'before-update'.
    const nowUs = GLib.get_monotonic_time();
    if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
    this._lastTickUs = nowUs;

    // One window's failure must not stop the others.
    for (const state of this._states.values()) {
      try {
        this._syncFrameState(state);
      } catch (e) {
        reportFrameLoopError('ApplicationManager', e);
      }
    }

  }

  private _syncFrameState(state: WindowState): void {
    const metaWin = state.windowActor.get_meta_window();
    if (!metaWin) return;

    const title = metaWin.get_title() || '(untitled)';
    // Names this glass in diagnostic dumps.
    state.glass._diagOwnerLabel = title;

    // The window actor is rescued before the glass. Its children are laid out
    // by its default layout, so a stranded window actor swallows every
    // relayout they queue and the glass's own rescue could never land.
    const rescue = ensureWindowActorAllocated(
      state.windowActor, WINDOW_ACTOR_RELAYOUT_FRAMES, WINDOW_ACTOR_STRANDED_FRAMES);
    if (rescue) this._logStrand(state, metaWin, title, rescue);
    ensureGlassAllocated(state.glass);
    this._syncState(state);
  }

  private _logStrand(state: WindowState, metaWin: Meta.Window, title: string, rescue: string): void {
    const wa = state.windowActor;
    const parent: any = wa.get_parent();
    noteStrandEntry(title,
      `wa.alloc=${wa.has_allocation()} wg.alloc=${parent ? parent.has_allocation() : '-'} ` +
      `scale=${wa.scale_x.toFixed(3)} op=${wa.opacity} min=${metaWin.minimized} stage=${rescue}`);
    this._logger.log(
      `[Liquid Glass][strand] ${rescue} for "${title}" — ` +
      `wa(mapped=${wa.mapped},vis=${wa.visible},alloc=${wa.has_allocation()},op=${wa.opacity},` +
      `scale=${wa.scale_x.toFixed(3)}) ` +
      `parent(${parent ? `${parent.constructor.name},mapped=${parent.mapped},alloc=${parent.has_allocation()}` : 'none'}) ` +
      `glass(mapped=${state.glass.mapped},vis=${state.glass.visible},alloc=${state.glass.has_allocation()}) ` +
      `min=${metaWin.minimized}`
    );
  }

  /**
   * Re-allocates the glass once its window actor is mapped again, after a
   * restore from minimise. clutter_actor_allocate() skips unmapped actors, so
   * the glass still has the allocation it had mid-way through the minimise
   * animation. Runs on the next BEFORE_REDRAW, once the map has settled.
   */
  _forceGlassReallocation(state: WindowState): void {
    if (state.remapReallocLaterId) return;
    state.remapReallocLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      state.remapReallocLaterId = 0;
      if (!state.windowActor.mapped) return GLib.SOURCE_REMOVE;

      if (ensureGlassAllocated(state.glass, 1)) {
        const title = state.windowActor.get_meta_window()?.get_title() || '(untitled)';
        this._logger.log(`[Liquid Glass][min-restore] re-allocated the glass for "${title}"`);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _cleanupState(state: WindowState) {
    if (state.remapReallocLaterId) {
      global.compositor.get_laters().remove(state.remapReallocLaterId);
      state.remapReallocLaterId = 0;
    }

    for (const { obj, id } of state.signals)
      obj.disconnect(id);
    state.signals = [];

    // The glass is a child of the window actor, and already disposed when
    // this runs from the window actor's destroy handler.
    if (isActorValid(state.surfaceActor))
      state.surfaceActor.opacity = state.originalOpacity;

    state.glass.cleanup();
    if (isActorValid(state.glass))
      state.glass.destroy();
  }
}
