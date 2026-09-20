// src/applicationManager.ts
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect, noteStrandEntry } from './liquidEffect.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UnpickableClone, UnpickableActor, InverseCornerEffect, getWindowActors, isActorValid, InvertedPositionConstraint, getAllocatedSize, setActorVisible, ensureGlassAllocated, isFrameSyncFrozen,
  getNestedGlassFix, innerGlassEffectOf, isFocusDebugEnabled,
  setTranslationIfChanged, setSizeIfChanged, setScaleIfChanged, setOpacityIfChanged,
  isCullSiteEnabled, rectsIntersect, setCloneCulled,
  createBackgroundMirror, setBackgroundMirrorEnabled, isBackgroundMirrorEnabled,
  reportClonedWindowActors, releaseClonedWindowActors,
  ensureWindowActorAllocated, SAME_FRAME_WINDOW_US } from './utils.js';

import { Logger } from './logger.js';

// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
// [FIX] How far the glass actor extends beyond the real window bounds, in
// screen pixels. This is one number with two jobs: it is the sampling
// headroom the refraction and blur need past the window edge, AND it is the
// only room the drop shadow has to render outward.
//
// It used to be the fixed 10 below, and setShadowMaxRadius() was handed that
// same 10 — so a shadow-radius of 100 was silently clamped to a 10px band no
// matter what the slider said. (setShadowMaxRadius()'s own doc comment warns
// about exactly this: it is meant to carry the actor's real outward room, the
// way dockManager passes CLIP_PADDING - 20.)
//
// Simply raising it to a fixed large value would make every glass window's
// offscreen framebuffer permanently bigger — the actor is (window + 2*margin)
// on each axis, and that size flows into the capture, the crop, the blur pool
// and the composite. So the margin is derived from the shadow settings
// instead: a window pays for the room only when a shadow is actually asked
// for, and 0-intensity or 0-radius keeps the original 10px.
const GLASS_MIN_MARGIN = 10;
// Slack between the margin and the largest radius the shadow may use, so the
// penumbra fades to zero inside the actor rather than being cut at its edge.
// Same 20px dockManager leaves (CLIP_PADDING - 20).
const SHADOW_MARGIN_HEADROOM = 20;
// prefs.js caps shadow-radius at 100; this leaves that reachable with the
// headroom and refuses to grow the framebuffer beyond it.
const GLASS_MAX_MARGIN = 100 + SHADOW_MARGIN_HEADROOM;
// Inward padding for corner rounding
const CORNER_PADDING = 3;

// [FIX] Whether the corner overlay (cornerOverlay + InverseCornerEffect) paints
// at all. Turned off, because it cannot do its job without destroying
// something else.
//
// What it was for: the glass draws a rounded rect with the user's
// application-corner-radius, which need not match the window's own corner
// radius, so where the glass sticks out past the window's corner the true
// background was redrawn over it — with CORNER_PADDING of over-reveal so the
// glass's antialiased corner pixels were covered too.
//
// Why it cannot stay: that reveal has to sit exactly ON the glass's corner
// boundary, and the boundary is shared. Inside it is the window; outside it is
// the drop shadow. The geometry leaves no gap to aim at — along the corner
// diagonal the two arcs differ by at most 0.41 * CORNER_PADDING (1.24px at
// CORNER_PADDING = 3), so a band wide enough to cover a ~1px antialiased edge
// necessarily straddles it. Raising CORNER_PADDING widens the band on BOTH
// sides; it never separates them.
//
// On screen that was a ~3px ring at each corner showing the background
// straight through the window — visible even with the glass radius set
// exactly to the window's, i.e. in the very case where there is nothing to
// correct. Reported as a serious defect, and correctly so: it is a hole in
// the window.
//
// What is lost by turning it off: if application-corner-radius is set SMALLER
// than the window's own corner radius, a wedge of glass shows past the
// window's rounded corner. That is a misconfiguration, it is cosmetic, and it
// costs nothing to look at — whereas the overlay cost a full extra paint of
// baseActor's subtree (wallpaper clone + every behind-window clone) every
// frame, on top of the artifact.
//
// The actors and the effect are left in place, just not painted, so this is
// one flag to flip if a better corner treatment is designed later.
const CORNER_REVEAL_ENABLED = false;

// [PERF/FIX] Whether the unblurred "base" layer under the glass is painted.
// Turned off, because with CORNER_REVEAL_ENABLED off it has no consumer left.
//
// baseActor exists, per its own WindowState comment, as the source for
// cornerOverlayClone — "Unblurred base background, used to reveal the true
// corners (see InverseCornerEffect below)". That overlay is gone, and nothing
// else reads baseActor's pixels.
//
// It was also being painted in its own right, and that is the part worth
// removing. Where the glass covers the window the composite writes alpha 1, so
// baseActor is completely hidden there. The only place it showed was the
// margin ring outside the window, where the glass writes just the drop
// shadow — and what it showed there was its own reproduction of the desktop:
// a monitor-sized wallpaper clone plus a clone of every window behind this
// one, re-rendered every frame.
//
// With it hidden, that ring shows the real framebuffer contents instead — the
// actual wallpaper and the actual windows, already drawn there by the
// compositor before this window actor paints. The shadow composites over them
// exactly the same way (it is premultiplied and never opaque), so the result
// is identical when the clones are correct, and CORRECT rather than merely
// identical when they are not.
//
// That second half matters: the ring is the region of the known "right after a
// focus switch the outer edge briefly shows ONLY the wallpaper, no other
// windows" artifact (see the rebuild debounce comment further down). That
// artifact is a clone that has not caught up yet being shown in the ring. With
// no clones in the ring there is nothing to catch up, so it cannot happen.
//
// NOTE it does not fix the other half of that report — a behind-window
// missing from INSIDE the glass. The glass has to sample clones (that is what
// gets blurred and refracted), so the interior keeps the same exposure.
//
// The actors stay in the tree (surfaceActor is still cached rather than
// re-derived via get_first_child(), which baseActor's presence would break);
// they are simply never shown, never laid out, and their behind-window clones
// are never built or synced.
const BASE_LAYER_ENABLED = false;

// Consecutive frames a MetaWindowActor must sit visible + mapped +
// !has_allocation() before _frameTick() remaps it. Ten frames is ~160ms —
// far longer than any legitimate pending relayout, and short enough that the
// glass under it is only wrong for a fraction of a second. See the comment
// at the call site.
// Stage 2 of the window-actor rescue: how many consecutive stranded frames
// before mutter's own window actor is unmapped and remapped. Raised from 10 so
// the gentler stage below gets room to land first.
const WINDOW_ACTOR_STRANDED_FRAMES = 14;

// Stage 1: ask the window GROUP to relayout. Early, because it is cheap and
// not swallowed -- see ensureWindowActorAllocated().
const WINDOW_ACTOR_RELAYOUT_FRAMES = 4;

// How far the clone containers' screen origin may be from (0,0) before the
// glass is treated as unrenderable and hidden for that frame.
//
// The invariant is that it sits EXACTLY on (0,0) (see _checkContainerAnchor),
// and the values seen while animating are single- to low-double-digit. This
// threshold is not for those: it is for the failure mode where the subtree
// stops being allocated while _applyCounterScale() keeps writing a fresh
// counter-scale — set_scale() is a transform, so it lands even when nothing
// can be re-allocated. A window minimising to the dock reaches scale 0.03,
// i.e. a 30x counter-scale multiplying a frozen container origin of about
// -1200px: the journal caught containerAnchor=(-34237,-11261). At that point
// update_stage_views() has given the actor EVERY stage view (it does that for
// any actor with needs_allocation set), so nothing culls the result — it is
// painted, full-screen, every frame, with damage rectangles that make
// mutter's own pixman calls fail ("In pixman_region32_init_rect: Invalid
// rectangle passed"). That is the giant smeared texture, the black residue
// spreading around the window, and the freeze.
//
// Hiding the glass for those frames costs a plain window with no glass behind
// it; not hiding it costs the session.
const MAX_ANCHOR_DISPLACEMENT = 256;

// Pre-emptive twin of MAX_ANCHOR_DISPLACEMENT.
//
// That guard is correct but reactive: the anchor it reads is what the PREVIOUS
// relayout left behind, so the frame that first writes the runaway transform
// is painted — and handed to mutter as a damage rectangle — before the guard
// can refuse it. One such frame is enough: the journal for the "black frame
// around the window behind" report has
//
//     *** BUG *** In pixman_region32_init_rect: Invalid rectangle passed
//
// landing in the same second as the symptom, and once a damage rectangle has
// been rejected mutter's idea of what still needs repainting is wrong, which
// is why the black stays put until something forces a full repaint (opening
// the screenshot UI is one, which is why the capture shows the region filled
// black rather than showing what is on screen).
//
// The test taken BEFORE the write is: is the counter-scale about to be large,
// and did the container fail to pick up the last relayout? `_frameTick()` runs
// as a BEFORE_REDRAW later, i.e. before `clutter_stage_maybe_relayout()`, so
// the previous tick's writes have already been serviced by the time this runs
// — `has_allocation()` here is false only for a subtree that really is
// stranded, which is the same freshness the anchor read has.
//
// Both halves are required. A large counter-scale on a healthy subtree is an
// ordinary minimise animation and must keep its glass; a stranded subtree at
// scale 1 cannot displace anything far enough to overflow a damage rectangle
// and is left to ensureGlassAllocated() to repair. 4x is where the frozen
// origin (about -1200px for baseActor) starts producing coordinates outside
// any plausible stage, and is far below the ~24x the journal caught.
const MAX_STRANDED_COUNTER_SCALE = 4;

/**
 * Which settings namespace a window's glass reads from.
 *
 * `application` is an ordinary app window, selected by the whitelist or by
 * "apply to all windows". `desktop-menu` is the menu the desktop itself puts
 * up — on Wayland a real toplevel of its own (see _isDesktopMenuWindow), not
 * a shell widget, which is why it lands in this manager and not in
 * panelMenuManager. The two are configured independently.
 */
type GlassProfile = 'application' | 'desktop-menu';

// Window types a desktop menu can plausibly use. GTK's Wayland backend maps
// an xdg_popup with a menu role onto DROPDOWN_MENU; the other two are here
// for X11 and for toolkits that pick a different hint for the same thing.
const MENU_WINDOW_TYPES = [
  Meta.WindowType.DROPDOWN_MENU,
  Meta.WindowType.POPUP_MENU,
  Meta.WindowType.MENU,
];

// Bound on the transient_for walk. A desktop menu is one hop from the desktop
// window; its submenus are a few more. The bound is what stops a cycle in a
// malformed chain from hanging the compositor's first-frame handler.
const MAX_TRANSIENT_DEPTH = 8;

interface WindowState {
  // [nested-glass] Last seen _recaptureSerial of each behind-cloned window's
  // own glass, for the 'propagate' repair. See NestedGlassFix in utils.ts.
  nestedSerials?: Map<any, number>;
  // [nested-glass] MetaWindowActor::damaged handlers on the behind-cloned
  // windows that own a glass, for the 'damage' repair.
  damageHooks?: Map<any, number>;

  // [PERF ①b] Screen rect of this window's glass box, recorded by
  // _syncStateInner() so _syncClones() can cull behind-window clones that
  // cannot contribute a single pixel to the capture. undefined until the
  // first full geometry sync, which means "do not cull yet".
  glassScreenRect?: [number, number, number, number];

  // Settings namespace this window's glass reads from. Fixed when the state
  // is built: a window does not change role mid-life.
  profile: GlassProfile;

  windowActor: Meta.WindowActor;
  // The window's own content/surface actor (the actual client texture). Cached here
  // because windowActor.get_first_child() stops pointing at it once baseActor is
  // inserted below it in _setupWindow — re-deriving it via get_first_child() later
  // (as _updateWindowOpacities/_cleanupState used to) silently targets the wrong actor.
  surfaceActor: Clutter.Actor;
  bgActor: St.Widget;
  clipBox: St.Widget;
  // [black-frame] A BackgroundMirror, or (A/B off) an UnpickableClone of
  // _backgroundGroup; typed as the common base so either fits.
  bgClone: Clutter.Actor;
  // [min-restore] Pending BEFORE_REDRAW later from _forceGlassReallocation().
  remapReallocLaterId?: number;
  windowsContainer: Clutter.Actor;
  clones: Map<Meta.WindowActor, Clutter.Actor>;
  effect: LiquidEffect;
  // Unblurred base background, used to reveal the true corners (see InverseCornerEffect below).
  baseActor: St.Widget;
  baseClone: Clutter.Actor;
  baseWindowsContainer: Clutter.Actor;
  baseClones: Map<Meta.WindowActor, Clutter.Actor>;
  // To cut window corners
  roundingEffect: InstanceType<typeof InverseCornerEffect>;
  cornerOverlay: InstanceType<typeof UnpickableActor>;
  cornerOverlayClone: InstanceType<typeof UnpickableClone>;
  signals: { obj: any, id: number }[];
  // Content opacity applied to the window's own surface layer so the glass shows
  // through it; restored when the effect is removed from this window.
  originalOpacity: number;

  isDirty: boolean; // flag if the window needs to be synced. changed by signals, etc
  constraints: {
    bg: InvertedPositionConstraint;
    windows: InvertedPositionConstraint;
    base: InvertedPositionConstraint;
    baseWindows: InvertedPositionConstraint;
  };
  // Animation scale most recently baked into the corner radius, so
  // _syncAnimatedCornerRadius() can stay a no-op while nothing is animating.
  radiusScaleApplied?: number;
  // Last known-good invisible-CSD-border offset (the frame rect's origin
  // inside the buffer rect) plus the actor position it was measured at, so
  // it is only re-sampled on a frame where the window is standing still.
  // See _frameLocalOffset().
  frameLocal?: [number, number];
  frameLocalActorPos?: [number, number];
  // [PERF] Every input the TOP-LEVEL geometry half of _syncStateInner()
  // derives from, as of the last frame it actually ran. Exact values rather
  // than a hash: a hash collision here would drop a real geometry update for
  // a frame, and this file's history is mostly bugs of exactly that shape.
  // Preallocated once so the comparison allocates nothing per frame.
  geomSig?: Float64Array;
}

export class ApplicationManager {
  private extensionPath: string;
  private _states: Map<Meta.WindowActor, WindowState>;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private _settingsSignals: number[];
  private _frameSignalId: number = 0;
  private _lastTickUs: number = 0;
  private _torndown: boolean = false;
  private _windowCreatedId: number;
  private _restackedId: number = 0;
  private _rebuildQueued: boolean = false;


  // ── Diagnostics for the focus-change "shifted texture" issue ───────────────
  // When > 0, _syncState() logs, for every tracked window, the raw actor
  // position vs. Meta's own frame/buffer rects, plus (for every "window
  // behind" clone) the clone's source actor's raw .x/.y vs its
  // get_transformed_position() and the position actually applied to the
  // clone. Armed for a few frames after every 'restacked' event so we can
  // see exactly which value diverges at the moment a focus-driven restack
  // happens, without spamming the log every frame during normal operation.
  private _debugFocusLogFrames: number = 0;
  // [PERF ①b] Slack around the glass box when deciding whether a
  // behind-window clone is worth painting. Generous on purpose: the thing
  // being skipped is an entire window (and, when it has glass, that glass's
  // whole render), so a few dozen pixels of over-inclusion cost nothing,
  // while being a pixel too tight would pop a window in and out at the edge.
  static readonly CLONE_CULL_MARGIN = 48;

  private static readonly DEBUG_FOCUS_LOG_FRAME_COUNT = 8;
  private _debugArmSignals: { obj: any, id: number }[] = [];
  // Windows whose clone container is currently NOT anchored at screen (0,0).
  // Logged on entry and exit only, so a persistent fault costs two lines
  // rather than 60 per second.
  private _displacedContainers: Set<Clutter.Actor> = new Set();
  // Windows currently refused by the MAX_STRANDED_COUNTER_SCALE guard, so the
  // entry and exit are logged once each instead of once a frame.
  private _strandedScaleWindows: Set<Clutter.Actor> = new Set();

  // [FIX] Standing (not debug-window-gated) anomaly detector for 3-2 ("behind
  // window disappears — not necessarily tied to a restacked event, and not
  // limited to full occlusion"). The has_allocation()-based hypothesis was
  // disproven (removing that check did not fix the symptom, and alloc-probe
  // showed it's chronically false for reasons unrelated to hiding — see
  // _syncState()). This instead flags, on ANY frame, any clone our own code
  // considers "should be showing" (src valid/visible/mapped, clone.visible
  // === true) that Clutter itself reports as actually unable to paint
  // (unmapped, unallocated, or a degenerate/zero size) — which is the
  // state that would make it invisible on screen despite our bookkeeping
  // saying otherwise. Logged only on state CHANGE (entering/leaving the
  // anomalous state) to avoid spamming once something gets stuck.
  private _anomalousClones: Set<Clutter.Actor> = new Set();

  // [FIX] Tracks the pending Meta.LaterType.BEFORE_REDRAW chain from
  // _rebuildAllClones()'s post-restack follow-up passes (see there), so
  // _removeAllEffects() can cancel it — otherwise a still-pending later
  // would fire after cleanup and touch destroyed state.
  private _rebuildFollowupLaterId: number = 0;

  // Current outward margin, recomputed whenever the shadow settings change.
  // See GLASS_MIN_MARGIN.
  private _glassMargin: number = GLASS_MIN_MARGIN;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this._states = new Map();
    this._settingsSignals = [];
    this._windowCreatedId = 0;
    this._restackedId = 0;
  }

  setup() {
    this._logger.log("[Liquid Glass] ApplicationManager setup starting...");
    // Before anything is built: every actor size below derives from it.
    this._glassMargin = this._computeGlassMargin();
    this._bindSettings();

    this._windowCreatedId = global.display.connect('window-created', (_d, metaWindow) => {
      this._logger.log(`[Liquid Glass] window-created event: window title = "${metaWindow.get_title()}", class = "${metaWindow.get_wm_class()}"`);
      const obj = metaWindow.get_compositor_private();
      if (!obj) {
        this._logger.log("[Liquid Glass] get_compositor_private() returned null");
        return;
      }
      if (!(obj instanceof Meta.WindowActor)) {
        this._logger.log("[Liquid Glass] compositor object is not instance of Meta.WindowActor");
        return;
      }
      this._logger.log("[Liquid Glass] window compositor actor found. Connecting to first-frame.");
      obj.connect('first-frame', () => {
        this._logger.log("[Liquid Glass] first-frame event fired for window: " + metaWindow.get_title());
        if (this._shouldApplyToWindow(obj)) {
          this._setupWindow(obj);
          this._rebuildAllClones();
        }
      });
    });

    this._restackedId = global.display.connect('restacked', () => {
      this._rebuildAllClones();
      this._armFocusDebug('restacked');
    });

    // The "clones render at completely the wrong place / UI clones missing"
    // report reproduces by dragging a window down, releasing, then dragging
    // it back — which need not restack at all, so arming the diagnostic on
    // 'restacked' alone never captured the failing frames. Grab end is the
    // moment the repro actually names.
    for (const sig of ['grab-op-end', 'grab-op-begin']) {
      try {
        this._debugArmSignals.push({
          obj: global.display,
          id: global.display.connect(sig as any, () => this._armFocusDebug(sig)),
        });
      } catch (e) { /* signal not present on this mutter — skip */ }
    }

    this._logger.log("[Liquid Glass] checking if effect enabled in setup: " + this._isEffectEnabled());
    if (this._isEffectEnabled())
      this._applyEffects();
  }

  // [FIX] Teardown must not be all-or-nothing.
  //
  // These steps used to run bare, one after another, so the first one that
  // threw skipped every step after it — signal handlers, actors, effects and
  // (worst of all) the per-frame later chain stayed alive, and the next
  // enable() built a second set on top. Disabling is exactly when a throw is
  // most likely: the shell is destroying the same actors we are.
  private _teardownStep(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this._logger?.error(`[Liquid Glass] ${this.constructor.name}.${name} failed during cleanup: ${e}`);
      } catch (_) {
        console.error(`[Liquid Glass] ${name} failed during cleanup: ${e}`);
      }
    }
  }

  cleanup() {
    this._torndown = true;

    this._teardownStep('displaySignals', () => {
      if (this._windowCreatedId) {
        global.display.disconnect(this._windowCreatedId);
        this._windowCreatedId = 0;
      }

      if (this._restackedId) {
        global.display.disconnect(this._restackedId);
        this._restackedId = 0;
      }
    });

    this._teardownStep('debugArmSignals', () => {
      for (const sig of this._debugArmSignals) {
        try { sig.obj.disconnect(sig.id); } catch (e) { }
      }
      this._debugArmSignals = [];
      this._displacedContainers.clear();
      this._strandedScaleWindows.clear();
    });

    this._teardownStep('settingsSignals', () => {
      this._settingsSignals.forEach(id => {
        try { this._settings.disconnect(id); } catch (e) { }
      });
      this._settingsSignals = [];
    });

    this._teardownStep('removeAllEffects', () => this._removeAllEffects());
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: () => void) => {
      let id = this._settings.connect(`changed::${key}`, callback);
      this._settingsSignals.push(id);
    };

    // Either switch can bring the manager up or take it down, so both run the
    // same re-scan rather than the old unconditional _removeAllEffects(): with
    // two profiles, one being turned off is not the same thing as no profile
    // being on. _syncWhitelist() drops the windows that no longer qualify and
    // builds the ones that now do; it removes everything only when both
    // switches are off.
    for (const profile of ['application', 'desktop-menu'] as const) {
      connectSetting(this._profileEnableKey(profile), () => {
        this._logger.log(`[Liquid Glass] ${this._profileEnableKey(profile)} changed to: ` +
          this._isProfileEnabled(profile));
        // _syncWhitelist() both drops what no longer qualifies and builds
        // what now does, and removes everything when both switches are off.
        this._syncWhitelist();
        if (this._isEffectEnabled())
          this._startFrameSync();
      });

      // Appearance, one set per profile. Both call the same updater, which
      // re-reads each live window through its own namespace.
      for (const suffix of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius',
        'brightness', 'contrast', 'saturation'])
        connectSetting(this._profileKey(profile, suffix), () => this._updateEffectParams());

      // Opacity of the window's own content layer, so the glass underneath is visible through it.
      connectSetting(this._profileKey(profile, 'content-opacity'), () => this._updateWindowOpacities());
    }

    // Apply to every normal/dialog window, bypassing the whitelist entirely.
    connectSetting('application-glass-all-windows', () => this._syncWhitelist());
    connectSetting('application-window-whitelist', () => this._syncWhitelist());
    // Exclusion list, consulted only while "apply to all windows" is on.
    connectSetting('application-window-blacklist', () => this._syncWhitelist());

    // [FIX] The drop shadow needs actual room outside the window to render
    // into, and that room is the actor's margin — so these two shared keys
    // have to resize the glass, not just change a uniform.
    connectSetting('shadow-radius', () => this._updateGlassMargin());
    connectSetting('shadow-intensity', () => this._updateGlassMargin());
  }

  _getContentOpacity(profile: GlassProfile = 'application'): number {
    return this._settings.get_double(this._profileKey(profile, 'content-opacity'));
  }

  _updateWindowOpacities() {
    for (let state of this._states.values()) {
      const targetOpacity = Math.round(this._getContentOpacity(state.profile) * 255);
      // Use the cached reference, NOT windowActor.get_first_child() — after
      // _setupWindow inserts baseActor below it, get_first_child() returns
      // baseActor instead of the real surface, so it stopped being live-updated.
      if (isActorValid(state.surfaceActor)) {
        state.surfaceActor.opacity = targetOpacity;
      }
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

  // [FIX] Whether ANY profile wants glass, not just the application one.
  //
  // This gates setup(), _syncWhitelist() and the per-frame loop, so while it
  // read `enable-application-glass` alone, turning application glass off also
  // silently took the desktop menu with it — and turning it on was a
  // precondition for the desktop menu ever being built. The per-window
  // decision lives in _profileForWindow(), which consults the switch that
  // actually belongs to the window in front of it.
  _isEffectEnabled(): boolean {
    return this._isProfileEnabled('application') || this._isProfileEnabled('desktop-menu');
  }

  _getWhitelist(): string[] {
    let whitelist = this._settings.get_strv('application-window-whitelist');
    return whitelist;
  }

  _getBlacklist(): string[] {
    let blacklist = this._settings.get_strv('application-window-blacklist');
    return blacklist;
  }

  // WM_CLASS casing is not stable across toolkits (GTK reports "Firefox" where
  // xprop may show "firefox"), and the preferences UI advertises the matching as
  // case-insensitive, so compare case-folded on both sides.
  _listContainsClass(list: string[], wmClass: string | null): boolean {
    if (!wmClass)
      return false;
    const normalized = wmClass.toLowerCase();
    return list.some((entry) => entry.toLowerCase() === normalized);
  }

  _windowMatchesWhitelist(metaWindow: Meta.Window): boolean {
    const whitelist = this._getWhitelist();
    const appName = metaWindow.get_wm_class();
    if (whitelist.length === 0) {
      return false;
    }

    let ret = this._listContainsClass(whitelist, appName);
    if (!ret) {
      this._logger.log("[Liquid Glass] window is not in whitelist. name = " + appName);
    } else {
      this._logger.log("[Liquid Glass] window is in whitelist. name = " + appName);
    }
    return ret;
  }

  _windowMatchesBlacklist(metaWindow: Meta.Window): boolean {
    const blacklist = this._getBlacklist();
    if (blacklist.length === 0) {
      return false;
    }

    const appName = metaWindow.get_wm_class();
    const ret = this._listContainsClass(blacklist, appName);
    if (ret) {
      this._logger.log("[Liquid Glass] window is in blacklist, skipping. name = " + appName);
    }
    return ret;
  }

  /**
   * Is this the menu the desktop itself puts up (right-click on the wallpaper)?
   *
   * On Wayland that menu is not a shell widget: it is a genuine toplevel of
   * its own, which is why it reaches this manager at all. Measured on GNOME
   * Shell 50 / Wayland with Desktop Icons NG, the popup reports
   *
   *   type=DROPDOWN_MENU or=false client=WAYLAND class=null inst=null
   *   gtkapp=null transient_for=DESKTOP/gjs/<same pid>
   *
   * so neither the WM_CLASS matching the whitelist uses nor the GTK
   * application id can identify it — every field a menu would normally be
   * recognised by is null. What IS reliable is the pair (menu window type,
   * transitively transient for a DESKTOP-type window), and that pair is also
   * what keeps in-app popups out: a Chrome menu measures as
   * `type=OVERRIDE_OTHER or=true` with no transient parent at all, so it
   * fails both halves.
   *
   * Override-redirect windows are rejected outright. Those are the ones a
   * client positions and manages entirely by itself (X11 menus, Chrome's own
   * popups); they are not ours to decorate, and the user asked for them to
   * stay out.
   */
  _isDesktopMenuWindow(metaWindow: Meta.Window): boolean {
    if (metaWindow.is_override_redirect())
      return false;
    if (!MENU_WINDOW_TYPES.includes(metaWindow.get_window_type()))
      return false;

    let parent: Meta.Window | null = null;
    try {
      parent = metaWindow.get_transient_for();
    } catch (e) {
      return false;
    }

    for (let depth = 0; parent && depth < MAX_TRANSIENT_DEPTH; depth++) {
      if (parent.get_window_type() === Meta.WindowType.DESKTOP)
        return true;
      // A submenu is transient for the menu above it, so keep walking — but
      // only through menus, never up out of an ordinary app window.
      if (!MENU_WINDOW_TYPES.includes(parent.get_window_type()))
        return false;
      try {
        parent = parent.get_transient_for();
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /**
   * Which settings namespace should dress this window, or null to leave it
   * alone. The single place that decides; _shouldApplyToWindow() and
   * _setupWindow() both go through it so they can never disagree.
   */
  _profileForWindow(windowActor: Meta.WindowActor): GlassProfile | null {
    const metaWindow = windowActor?.get_meta_window?.();
    if (!metaWindow)
      return null;

    // Checked before the application rules: a desktop menu must not be able
    // to fall through to "apply to all windows" and pick up app settings.
    if (this._isDesktopMenuWindow(metaWindow))
      return this._isProfileEnabled('desktop-menu') ? 'desktop-menu' : null;

    if (!this._isProfileEnabled('application'))
      return null;

    // "Apply to all windows" bypasses the whitelist, but is still restricted to
    // normal/dialog windows so we never touch desktop backgrounds, panels, etc.,
    // and still honours the blacklist as an opt-out for individual apps.
    const applyAll = this._settings.get_boolean('application-glass-all-windows');
    if (applyAll) {
      const windowType = metaWindow.get_window_type();
      const isNormal = windowType === Meta.WindowType.NORMAL ||
        windowType === Meta.WindowType.DIALOG ||
        windowType === Meta.WindowType.MODAL_DIALOG;
      if (!isNormal) {
        this._logger.log(`[Liquid Glass] window "${metaWindow.get_title()}" has special type ${windowType}, skipping...`);
        return null;
      }
      if (this._windowMatchesBlacklist(metaWindow)) {
        return null;
      }
      return 'application';
    }

    return this._windowMatchesWhitelist(metaWindow) ? 'application' : null;
  }

  _shouldApplyToWindow(windowActor: Meta.WindowActor): boolean {
    return this._profileForWindow(windowActor) !== null;
  }

  _applyEffects() {
    this._logger.log("[Liquid Glass] _applyEffects called");
    this._buildForExistingWindows();
    this._startFrameSync();
  }

  _removeAllEffects() {
    this._stopFrameSync();

    if (this._rebuildFollowupLaterId) {
      if (global.compositor?.get_laters) {
        global.compositor.get_laters().remove(this._rebuildFollowupLaterId);
      }
      this._rebuildFollowupLaterId = 0;
    }

    // [FIX] One window's teardown must not abort the others'. During
    // disable() the shell is destroying the same actors we are, so a state
    // whose subtree is already gone is normal — and it used to take every
    // state after it in the iteration order down with it, leaving glass
    // behind on the remaining windows.
    for (let state of this._states.values()) {
      try {
        this._cleanupState(state);
      } catch (e) {
        this._logger?.error(`[Liquid Glass] per-window cleanup failed: ${e}`);
      }
    }

    this._states.clear();
    this._rebuildQueued = false;
  }

  _syncWhitelist() {
    if (!this._isEffectEnabled()) {
      this._removeAllEffects();
      return;
    }

    for (let [actor, state] of [...this._states.entries()]) {
      // Dropped when it no longer qualifies at all, and also when it would
      // now be dressed by the OTHER profile: the namespace is baked into the
      // state when it is built, so the only way to change it is to rebuild.
      if (this._profileForWindow(actor) !== state.profile) {
        this._cleanupState(state);
        this._states.delete(actor);
      }
    }

    for (let actor of getWindowActors()) {
      if (this._shouldApplyToWindow(actor) && !this._states.has(actor))
        this._setupWindow(actor);
    }

    this._rebuildAllClones();
  }

  /**
   * Outward margin the glass actor should currently have, in screen px.
   *
   * Derived from the shadow settings rather than fixed: the margin is the
   * only room the drop shadow has to render into (the shader clamps it via
   * shadow_max_radius), but it is also what makes the actor — and therefore
   * every framebuffer in the effect's chain — larger than the window. A
   * window with no shadow keeps the original 10px and costs nothing extra.
   */
  _computeGlassMargin(): number {
    let radius = 0;
    let intensity = 0;
    try {
      radius = this._settings.get_double('shadow-radius');
      intensity = this._settings.get_double('shadow-intensity');
    } catch (e) {
      return GLASS_MIN_MARGIN;
    }

    if (!(radius > 0) || !(intensity > 0))
      return GLASS_MIN_MARGIN;

    return Math.min(GLASS_MAX_MARGIN,
      Math.max(GLASS_MIN_MARGIN, Math.ceil(radius) + SHADOW_MARGIN_HEADROOM));
  }

  /**
   * Recomputes the margin and, if it moved, pushes it into every live window:
   * the shader's own padding uniform, the shadow's outward limit, the corner
   * overlay's inset, and the geometry itself.
   *
   * The geometry signature has to be dropped explicitly — every input it
   * hashes (frame rect, scale, translation...) can be completely unchanged
   * while the margin makes every derived size different, so without this the
   * fast path in _syncStateInner() would keep the old actor size forever.
   */
  _updateGlassMargin(): void {
    const next = this._computeGlassMargin();
    if (next === this._glassMargin) return;

    this._glassMargin = next;
    const shadowRoom = Math.max(0, next - SHADOW_MARGIN_HEADROOM);

    for (let state of this._states.values()) {
      try {
        state.effect.setPadding(next);
        state.effect.setShadowMaxRadius(shadowRoom);
        state.roundingEffect.setInset(next);
        state.geomSig = undefined;
      } catch (e) {
        this._logger.error(`[Liquid Glass] Failed to apply the new glass margin: ${e}`);
      }
    }
  }

  _updateEffectParams() {
    for (let state of this._states.values()) {
      const k = (suffix: string) => this._profileKey(state.profile, suffix);
      let tintColorStr = this._settings.get_string(k('tint-color'));
      let tintStrength = this._settings.get_double(k('tint-strength'));
      let blurRadius = this._settings.get_int(k('blur-radius'));
      let cornerRadius = this._settings.get_double(k('corner-radius'));
      let brightness = this._settings.get_double(k('brightness'));
      let contrast = this._settings.get_double(k('contrast'));
      let saturation = this._settings.get_double(k('saturation'));

      state.effect.setTintColor(...this._hexToColorArray(tintColorStr));
      state.effect.setTintStrength(tintStrength);
      state.effect.setCornerRadius(cornerRadius);
      state.radiusScaleApplied = 1;
      state.effect.setBlurRadius(blurRadius);
      state.effect.setBrightness(brightness);
      state.effect.setContrast(contrast);
      state.effect.setSaturation(saturation);
      state.roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
      state.roundingEffect.setGlassRadius(cornerRadius);
      state.roundingEffect.setInset(this._cornerOverlayInset());
    }
  }

  // [FIX] This used to be SHADER_PADDING + CORNER_PADDING, and
  // InverseCornerEffect used it to shrink its rounded-rect cut inward by the
  // same amount on every side (straight edges included), instead of only
  // pulling the 4 actual corners inward. That revealed a uniform band of
  // raw, unblurred/unshadowed background all the way around the window —
  // see InverseCornerEffect._updateShader() in utils.ts for the full
  // explanation. The overlay now derives the window's true edge from this
  // value alone (it equals SHADER_PADDING, the outward padding this actor
  // has beyond the real window bounds), while CORNER_PADDING is applied
  // only to the radius (below) so it exclusively affects the corner arcs.
  _cornerOverlayInset(): number {
    return this._glassMargin;
  }

  // ── Per-frame sync ─────────────────────────────────────────────────────────
  //
  // NOTE on where the drag-lag bug did NOT live, so it is not re-litigated
  // here: this JS-side geometry was measured exact throughout an entire drag
  // (behind-window clone screen positions matched their sources with zero
  // error on every tick), and the tick cadence was a solid ~16.6ms. The
  // one-frame lag came from liquidEffect.ts drawing with Cogl's immediate-mode
  // API inside vfunc_paint_target, which runs before Clutter has rendered the
  // effect's capture for the frame. See the rendering-model header in
  // liquidEffect.ts. Changing the offsets here (frame_rect vs
  // get_transformed_position, set_position vs translation_x/y vs
  // Clutter.Constraint) was tried in every combination and changed nothing.
  _startFrameSync() {
    if (this._frameSignalId !== 0) return;
    this._frameSignalId = global.stage.connect('before-update', () => this._frameTick());
    this._frameTick();
  }

  _stopFrameSync() {
    const signalId = this._frameSignalId;
    this._frameSignalId = 0;
    if (signalId) {
      try { global.stage.disconnect(signalId); } catch (e) { }
    }
  }

  _rebuildAllClones() {
    if (this._rebuildQueued) return;
    this._rebuildQueued = true;

    // Debounce to next idle to avoid crashing during rapid restacking/creation
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this._states.size === 0) {
        this._rebuildQueued = false;
        return GLib.SOURCE_REMOVE;
      }
      for (let state of this._states.values()) {
        this._rebuildWindowClones(state);
      }
      this._rebuildQueued = false;

      // [FIX] Reported symptom (two variants of the same underlying gap):
      // (a) after several quick focus switches, the window that should show
      //     behind the newly-focused one sometimes never appears until the
      //     focused window is moved; (b) a newly-focused window's outer
      //     ~SHADER_PADDING-px edge briefly shows ONLY the wallpaper (no
      //     other windows) right after the focus switch, self-correcting
      //     within well under a second. Both point at this debounced
      //     rebuild occasionally running against a stacking order Mutter
      //     hasn't fully settled yet when several 'restacked' signals fire
      //     in a tight burst (e.g. a single click emits raise + focus
      //     signals close together), with the visible gap lasting until
      //     something else catches it up.
      //
      // Previously this was a single GLib.timeout_add(..., 150, ...)
      // "safety net" — a plain wall-clock guess with no relation to actual
      // frame timing, so the visible gap could span many frames (up to
      // 150ms) before the follow-up pass ran. Replaced with a short chain
      // of Meta.LaterType.BEFORE_REDRAW laters (the same primitive
      // _frameTick() itself uses) so the follow-up passes run on the very
      // next few actual frames instead of after an arbitrary delay,
      // shrinking the visible window considerably. Still a mitigation for
      // a not-fully-confirmed race, not a verified fix for the settling
      // delay itself — please report back if either variant still
      // reproduces.
      const FOLLOWUP_FRAME_COUNT = 0;
      let followupFramesLeft = FOLLOWUP_FRAME_COUNT;
      // [FIX] Meta.Laters callbacks are GSourceFuncs and must return a
      // boolean (GLibvisualAbsREMOVE/CONTINUE) — an implicit `undefined`
      // return was passed here before.
      const runFollowup = () => {
        followupFramesLeft--;
        if (this._states.size > 0) {
          for (let state of this._states.values()) {
            this._rebuildWindowClones(state);
          }
        }
        if (followupFramesLeft > 0) {
          this._rebuildFollowupLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runFollowup);
        } else {
          this._rebuildFollowupLaterId = 0;
        }
        return GLib.SOURCE_REMOVE;
      };
      this._rebuildFollowupLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runFollowup);

      return GLib.SOURCE_REMOVE;
    });
  }

  _buildForExistingWindows() {
    for (let actor of getWindowActors()) {
      if (this._shouldApplyToWindow(actor))
        this._setupWindow(actor);
    }
  }

  _setupWindow(windowActor: any) {
    if (!windowActor || !(windowActor instanceof Meta.WindowActor) || this._states.has(windowActor))
      return;

    const profile = this._profileForWindow(windowActor);
    if (!profile)
      return;

    let surfaceActor = windowActor.get_first_child();
    if (!surfaceActor) {
      return;
    }

    let parent = windowActor.get_parent();
    if (!parent)
      return;

    // [FIX] 3-2 ("behind window disappears from another window's glass —
    // not tied to a restacked event, and reproduces even with the source
    // only PARTIALLY covered, not just fully hidden"). Tried so far:
    //   1. Removing the has_allocation() gate from the per-frame clone sync
    //      loop (see _syncState()) — DISPROVEN by [alloc-probe] logging AND
    //      by this not fixing the symptom.
    //   2. windowActor.inhibit_culling() here — CONFIRMED to be the actual
    //      cause of the disappearing-clone symptom: removing it (along
    //      with baseActor/bgActor's own inhibit_culling() calls below,
    //      tested together) fixed it completely. Best-effort explanation:
    //      inhibit_culling() is meant for actors that are NOT themselves
    //      the "real" live on-screen content of a window — overlays,
    //      clone-only proxies, drag icons — and forces Clutter/Mutter to
    //      treat them as always relevant regardless of geometry. Calling
    //      it on `windowActor` itself — the actual live window, whose
    //      real on-screen compositing/buffer-swap state our OWN clones
    //      then sample from — likely interfered with Mutter's normal
    //      texture-update bookkeeping for that live window in a way
    //      unrelated to (and worse than) the plain scene-graph occlusion
    //      problem it's meant to solve for overlay-only actors; the
    //      REMOVED comment's theory (Mutter suspending compositing of a
    //      fully-covered window) doesn't fully explain it either, since
    //      the symptom also happened with only partial coverage. NOT
    //      reapplying it here.
    // baseActor/bgActor below are NOT live window content (they're our own
    // overlay actors, added as children of surfaceActor's sibling) and
    // exist to fix a DIFFERENT, earlier-diagnosed problem: Clutter's own
    // scene-graph occlusion culling doesn't know surfaceActor above them
    // is translucent, and would otherwise conclude baseActor/bgActor are
    // fully covered and skip painting them. Restoring those two only.

    // Store the surface's original opacity and dial it down so the glass behind
    // it is actually visible; restored in _cleanupState when the effect is removed.
    let originalOpacity = surfaceActor.opacity;
    surfaceActor.opacity = Math.round(this._getContentOpacity(profile) * 255);

    // Every actor this window's glass owns carries a name. Clutter's own
    // "Can't update stage views actor <name> ... because it needs an
    // allocation" warning is the one diagnostic that reliably fires while
    // the "clone stuck at the wrong position" bug is on screen, and it read
    // "unnamed" for all of these — which made it impossible to tell which
    // actor's allocation had gone stale. Deliberately NOT named
    // 'liquid-glass-bg-actor' / 'liquid-box': UILayerSampler treats those
    // two names as "another glass instance, do not clone".
    let baseActor = new St.Widget({
      name: 'lgw-base',
      style_class: 'liquid-glass-base-actor',
      reactive: false,
      clip_to_allocation: true,
      visible: true,
    });
    windowActor.insert_child_below(baseActor, surfaceActor);
    if (!BASE_LAYER_ENABLED)
      setActorVisible(baseActor, false);

    let bgActor = new St.Widget({
      name: 'lgw-bg',
      style_class: 'liquid-glass-bg-actor',
      reactive: false,
      clip_to_allocation: false,
      visible: true,
    });
    windowActor.insert_child_above(bgActor, baseActor);

    // [FIX] Both actors sit entirely behind surfaceActor (the window's own
    // content), which is what makes the glass show "through" it once its
    // opacity is dialed down below. Clutter's own occlusion culling
    // doesn't know that surfaceActor is translucent, though -- it treats
    // it as opaque and, on a window's first paint (before anything else
    // has forced a relayout), can conclude baseActor/bgActor are fully
    // covered and skip painting them entirely. That produced a black
    // background behind the window's translucent chrome until something
    // else (resize, move, opening another window, defocusing) forced
    // Clutter to reconsider.
    //
    // This USED to be fixed with baseActor.inhibit_culling()/
    // bgActor.inhibit_culling() — but per the SAME 3-2 investigation as
    // windowActor's (see above), that inhibit_culling() call was confirmed
    // to be the actual cause of the disappearing-clone bug, and NOT just
    // on windowActor: removing baseActor/bgActor's calls too (leaving
    // windowActor's already-removed) was independently required to fully
    // fix it. Best guess at why: baseActor/bgActor are CHILDREN of
    // windowActor, so when windowActor is used as a Clutter.Clone SOURCE
    // elsewhere, they're part of what gets cloned too — inhibit_culling()
    // appears to break in this environment specifically for any actor
    // that's cloned (or descends from something cloned) via Clutter.Clone,
    // regardless of which of the three actors it's called on.
    //
    // Both calls are removed now (tested, fixes the disappearing-clone
    // bug). This risks REINTRODUCING the original black-background-on-
    // first-paint bug this was written for, since it has no other
    // mitigation right now — if a window's glass looks solid black/missing
    // right when it first opens, and only fixes itself once you move/
    // resize/refocus it, that's this old bug back; please report it so we
    // can find an inhibit_culling-free fix specifically for that case.

    let clipBox = new St.Widget({
      name: 'lgw-clipbox',
      clip_to_allocation: true,
      reactive: false,
    });
    bgActor.add_child(clipBox);

    // Size the clones to cover the full monitor so the wallpaper fills correctly.
    let monitor = Main.layoutManager.primaryMonitor;

    // [black-frame] Deliberately NOT a Clone of _backgroundGroup. Cloning it
    // made the wallpaper inherit the real background actor's per-frame
    // culling state, so it only painted inside the current frame's damage
    // region — see BackgroundMirror in utils.ts for the full mechanism.
    let baseClone = createBackgroundMirror('lgw-base-wallpaper-clone');
    if (monitor) {
      baseClone.set_size(monitor.width, monitor.height);
    }
    baseActor.add_child(baseClone);

    let baseWindowsContainer = new Clutter.Actor();
    baseWindowsContainer.set_name('lgw-base-windows');
    baseActor.add_child(baseWindowsContainer);

    let bgClone = createBackgroundMirror('lgw-bg-wallpaper-clone');
    if (monitor) {
      bgClone.set_size(monitor.width, monitor.height);
    }
    clipBox.add_child(bgClone);

    let effect = new LiquidEffect({
      extensionPath: this.extensionPath,
      settings: this._settings,
      logger: this._logger,
      owner: profile,
    } as any);

    const k = (suffix: string) => this._profileKey(profile, suffix);
    let tintColorStr = this._settings.get_string(k('tint-color'));
    let tintStrength = this._settings.get_double(k('tint-strength'));
    let cornerRadius = this._settings.get_double(k('corner-radius'));
    let blurRadius = this._settings.get_int(k('blur-radius'));
    let brightness = this._settings.get_double(k('brightness'));
    let contrast = this._settings.get_double(k('contrast'));
    let saturation = this._settings.get_double(k('saturation'));

    effect.setPadding(this._glassMargin);
    effect.setTintColor(...this._hexToColorArray(tintColorStr));
    effect.setTintStrength(tintStrength);
    effect.setCornerRadius(cornerRadius);
    effect.setBlurRadius(blurRadius);
    effect.setBrightness(brightness);
    effect.setContrast(contrast);
    effect.setSaturation(saturation);
    effect.setIsDock(false);
    // Application windows should read as plain "drop shadow + AO" at the
    // edge (like dockManager's shadow treatment), not the dock/menu-style
    // rim + specular + sheen glass glint — that glint sits right at the
    // window's true edge and, combined with the window's own (often
    // non-opaque) content, reads as a distracting bright frame around the
    // window. Blur/tint/refraction are unaffected; only this glint group
    // is turned off, and only for this per-window effect instance — the
    // shared glass-rim-*/glass-sheen-*/glass-specular-* settings still
    // apply normally to the dock, menu, notification, quick-settings and
    // OSD glass.
    effect.setSurfaceLightEnabled(false);
    // Keep the drop-shadow within the small padded border around the window,
    // rather than the huge margin dockManager uses for its full-screen FBO.
    effect.setShadowMaxRadius(Math.max(0, this._glassMargin - SHADOW_MARGIN_HEADROOM));
    bgActor.add_effect(effect);

    let windowsContainer = new Clutter.Actor();
    windowsContainer.set_name('lgw-bg-windows');
    clipBox.add_child(windowsContainer);

    let cornerOverlay = new UnpickableActor({
      name: 'lgw-corner-overlay',
      clip_to_allocation: true,
      reactive: false,
    });
    let cornerOverlayClone = new UnpickableClone({ source: baseActor });
    cornerOverlayClone.set_name('lgw-corner-overlay-clone');
    cornerOverlay.add_child(cornerOverlayClone);

    let roundingEffect = new InverseCornerEffect();
    roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
    roundingEffect.setGlassRadius(cornerRadius);
    roundingEffect.setInset(this._cornerOverlayInset());

    cornerOverlay.add_effect(roundingEffect);
    windowActor.add_child(cornerOverlay);
    if (!CORNER_REVEAL_ENABLED)
      setActorVisible(cornerOverlay, false);

    const createConstraint = () => new InvertedPositionConstraint({
      source: windowActor,
      offset_x: -this._glassMargin,
      offset_y: -this._glassMargin
    } as any);

    const constraints = {
      bg: createConstraint(),
      windows: createConstraint(),
      base: createConstraint(),
      baseWindows: createConstraint()
    };

    bgClone.add_constraint(constraints.bg);
    windowsContainer.add_constraint(constraints.windows);
    baseClone.add_constraint(constraints.base);
    baseWindowsContainer.add_constraint(constraints.baseWindows);

    let state: WindowState = {
      windowActor,
      surfaceActor,
      bgActor,
      clipBox,
      bgClone,
      windowsContainer,
      clones: new Map(),
      effect,
      baseActor,
      baseClone,
      baseWindowsContainer,
      baseClones: new Map(),
      roundingEffect,
      cornerOverlay,
      cornerOverlayClone,
      signals: [],
      originalOpacity,
      profile,
      isDirty: true,
      constraints,
    };

    this._states.set(windowActor, state);
    this._rebuildWindowClones(state);

    // Immediate sync connections for resize/move using allocation property
    state.signals.push({
      obj: windowActor,
      id: windowActor.connect('notify::allocation', () => { state.isDirty = true; })
    });

    // [min-restore] Re-allocate the glass the moment its window actor comes
    // back from being unmapped — minimise/restore being the case that matters.
    //
    // clutter_actor_allocate() refuses outright for an actor that is neither
    // mapped nor has mapped clones:
    //
    //     if (!CLUTTER_ACTOR_IS_TOPLEVEL (self) &&
    //         !clutter_actor_is_mapped (self) &&
    //         !clutter_actor_has_mapped_clones (self))
    //       return;
    //
    // so while a window is minimised its glass subtree is never allocated,
    // and it keeps whatever allocation it happened to have when the window
    // actor was unmapped -- which is a frame from the middle of the minimise
    // animation. A 60s capture of three minimised windows:
    //
    //     Extension Manager  alloc 717x502  should be 2132x1149  hasAlloc=false
    //     Calculator         alloc 320x385  should be  582x828   hasAlloc=false
    //     Resources          alloc 501x412  should be 1236x808   hasAlloc=false
    //
    // while every non-minimised window's glass was exactly right. On restore
    // the glass therefore starts from that stale geometry, and the per-frame
    // sync writes transforms against it -- which is what the anchor DRIFT /
    // REFUSED / strand machinery has been reacting to all along, downstream
    // of the real problem.
    //
    // It also explains why opening the app grid clears it: the overview maps
    // and allocates every window actor, so the subtree finally gets a real
    // allocation.
    state.signals.push({
      obj: windowActor,
      id: windowActor.connect('notify::mapped', () => {
        if (!isActorValid(windowActor) || !windowActor.mapped) return;
        this._forceGlassReallocation(state);
      })
    });

    const metaWin = windowActor.get_meta_window();
    if (metaWin) {
      state.signals.push({
        obj: metaWin,
        id: metaWin.connect('size-changed', () => {
          // The invisible-border offset can genuinely change here (maximize,
          // tiling), so drop the cached value — see _frameLocalOffset().
          state.frameLocal = undefined;
          this._rebuildWindowClones(state);
          // this._syncState(state);
          state.isDirty = true;
        })
      });
      state.signals.push({
        obj: metaWin,
        id: metaWin.connect('position-changed', () => {
          // this._syncState(state);
          state.isDirty = true;
        })
      });
    }

    // Use a later to ensure the initial sync happens after actors are properly added to stage
    global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
      if (this._states.has(windowActor)) {
        // this._syncState(state);
        state.isDirty = true;
      }
      return false;
    });

    // [FIX] Recorded in state.signals so cleanup() disconnects it. Left
    // connected, this handler outlives disable(): it keeps a reference to
    // this manager (and through it the settings object and the logger), and
    // when the window is eventually closed it runs _rebuildAllClones() on a
    // torn-down manager — while a freshly enabled one is managing the same
    // window.
    //
    // NOTE on the disposed-actor criticals this used to produce: by the time
    // this fires, Clutter has already run clutter_actor_remove_all_children()
    // on the window actor (that happens inside clutter_actor_dispose, BEFORE
    // ::destroy is emitted), so bgActor/baseActor/cornerOverlay and every
    // clone under them are already disposed. _cleanupState() handles that —
    // but only now that isActorValid() actually detects it.
    state.signals.push({
      obj: windowActor,
      id: windowActor.connect('destroy', () => {
        if (this._torndown) return;
        this._cleanupState(state);
        this._states.delete(windowActor);
        this._rebuildAllClones();
      })
    });
  }

  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _rebuildWindowClones(state: WindowState) {
    state.clones.forEach(clone => clone.destroy());
    state.clones.clear();
    state.windowsContainer.remove_all_children();

    state.baseClones.forEach(clone => clone.destroy());
    state.baseClones.clear();
    state.baseWindowsContainer.remove_all_children();

    const debugLog = this._debugFocusLogFrames > 0;
    if (debugLog) {
      const titles = getWindowActors().map((a: any) => {
        const mw = typeof a.get_meta_window === 'function' ? a.get_meta_window() : null;
        return mw ? (mw.get_title() || '(untitled)') : '(?)';
      });
      const ownTitle = (() => {
        const mw = state.windowActor.get_meta_window();
        return mw ? (mw.get_title() || '(untitled)') : '(?)';
      })();
      this._logger.log(
        `[Liquid Glass][focus-debug] _rebuildWindowClones for="${ownTitle}" ` +
        `stackingOrder=[${titles.join(', ')}]`
      );
    }

    // Get windows in stacking order (bottom to top)
    for (let actor of getWindowActors()) {
      // STOP iterating once we reach our own window.
      // This ensures we ONLY render what is actually BEHIND the app.
      if (actor === state.windowActor)
        break;

      if (!(actor instanceof Meta.WindowActor))
        continue;

      // [FIX] Skip sources with no valid size. The Clutter-WARNING spam
      // ("needs an allocation") turned out to scale with the number of
      // open glass windows rather than with the reported "missing behind
      // window" bug specifically — every window's clone list always
      // includes the SAME actor (logged as "@!0,0;BDHF", always first/
      // bottommost, always at (0,0) — almost certainly the desktop
      // background layer), suggesting THAT clone is the one perpetually
      // stuck without a resolvable allocation, independent of the other
      // issue. A clone built from a genuinely zero-sized source can never
      // produce a valid allocation no matter how often it's re-synced, so
      // there's no point creating it — hence the guard below.
      //
      // The size feeding that guard comes from the allocation, though, not
      // from get_size(): this runs from a BEFORE_REDRAW later, i.e. before
      // clutter_stage_maybe_relayout(), and get_size() answers with the
      // preferred size while a relayout is pending. That is how a perfectly
      // healthy window actor can report 0 here and get skipped for the rest
      // of the rebuild — so some of the zeros this guard used to catch were
      // never real. See getAllocatedSize.
      let [srcW, srcH] = getAllocatedSize(actor);
      if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
        continue;
      }

      let clone = new UnpickableClone({ source: actor });
      const behindTitle = (() => {
        try {
          const mw = actor.get_meta_window();
          return (mw && mw.get_title()) || '(untitled)';
        } catch (_) { return '(?)'; }
      })();
      clone.set_name(`lgw-behind:${behindTitle}`);
      // [FIX] Give the clone its correct geometry RIGHT NOW, synchronously,
      // instead of leaving it at whatever default position a freshly
      // constructed actor starts at (effectively (0,0)) until the next
      // _syncState() call happens to run on a later frame. The focus-debug
      // log confirms this gap is real: right after a 'restacked' event,
      // clone.(x,y) was logged as (0,0) for one _syncState pass before
      // snapping to the correct (e.g. (1181,134)) position on the very
      // next pass — i.e. Clutter had at least one opportunity to paint this
      // clone at the wrong (0,0) spot. That one-frame "content that belongs
      // at local (x,y) inside window A renders at screen (~0,0) instead" is
      // exactly the shape of the reported texture-shift artifact.
      //
      // Seeded in the same form _syncStateInner() maintains — x/y pinned at
      // 0, placement carried by translation — so the very first frame is
      // already in the steady-state representation instead of switching
      // representation on the next sync.
      clone.set_position(0, 0);
      clone.translation_x = actor.x;
      clone.translation_y = actor.y;
      clone.set_size(srcW, srcH);
      clone.set_scale(actor.scale_x, actor.scale_y);
      clone.opacity = actor.opacity;
      state.windowsContainer.add_child(clone);
      state.clones.set(actor, clone);

      // [PERF] The second clone of the same window, for the unblurred base
      // layer. Not built at all while that layer is not painted.
      if (BASE_LAYER_ENABLED) {
        let baseClone = new UnpickableClone({ source: actor });
        baseClone.set_name(`lgw-base-behind:${behindTitle}`);
        baseClone.set_position(0, 0);
        baseClone.translation_x = actor.x;
        baseClone.translation_y = actor.y;
        baseClone.set_size(srcW, srcH);
        baseClone.set_scale(actor.scale_x, actor.scale_y);
        baseClone.opacity = actor.opacity;
        state.baseWindowsContainer.add_child(baseClone);
        state.baseClones.set(actor, baseClone);
      }
    }
  }

  // The frame rect's origin inside the buffer rect — i.e. the width of the
  // window's invisible CSD border on the left/top — held stable across a move.
  //
  // get_frame_rect() and get_buffer_rect() do not update in lockstep. During
  // an interactive drag the frame rect trails the buffer rect (and
  // windowActor.x/y, which track the buffer rect) by one frame, so their
  // difference — a constant in reality — reads up to ~50px off for that
  // frame. Since this value feeds the glass box position, the shader
  // geometry AND the absolute anchor of every clone container, that lag was
  // visible as the whole glass and its sampled content jumping around while
  // dragging, with the last frame's bad value latched until the next sync.
  //
  // Both rects have settled on any frame where the actor did not move, so
  // sample it there and reuse the last good value while the window is
  // moving. `size-changed` clears the cache so a genuine decoration change
  // (maximize, unmaximize, tiling) is picked up immediately.
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
      if (Number.isFinite(fx) && Number.isFinite(fy)) {
        state.frameLocal = [fx, fy];
      }
    }

    return state.frameLocal ?? [0, 0];
  }

  // ── Counter-scale placement (resize/open/close animation) ─────────────────
  // bgActor / baseActor / cornerOverlay are literal children of `windowActor`
  // (see _setupWindow), so they inherit ANY transform GNOME applies to it —
  // including the scale_x/scale_y and translation_x/y that GNOME's resize,
  // map and close animations use. See windowManager.js _sizeChangedWindow():
  // a maximize does NOT grow the actor, it sets the actor to the FINAL rect
  // immediately and eases scale from 1/scaleX up to 1.
  //
  // What we want, unchanged from the original intent of this code: the
  // glass's OUTER boundary shrinks and grows with the window, while the
  // CONTENT sampled through it (a snapshot of the desktop and the windows
  // behind) never stretches or squishes — that content represents fixed 1:1
  // real screen pixels. A shrinking pane of glass over a fixed backdrop
  // reveals LESS of that backdrop, it does not squash a copy of all of it.
  //
  // How it used to try to get there, and why it didn't: the child was pinned
  // at the offset it would have at scale 1 (an inverse-scale trick around
  // the pivot) and then CLIPPED to the window's live footprint. Two things
  // broke:
  //   * the clip came from windowActor.get_size(), i.e. the BUFFER rect,
  //     which for a CSD window is much larger than the frame rect (in a
  //     real capture: frame 941x540 vs buffer 1031x630), so it cropped
  //     nothing useful; and
  //   * a clip cannot fix the SHADER. setGlassGeometry()/setCornerRadius()
  //     were still handed the final, full-size rect, so the rounded corners
  //     and edge refraction were laid out for the maximized window while
  //     the real one was still small — the glass read as "too big, snapping
  //     to fit at the end".
  //
  // So the box is now built at the window's *live* on-screen size instead of
  // being clipped down to it, and the shader is handed those same live
  // numbers.
  //
  // The math is just the actor transform, stated once. Clutter renders a
  // child at local point c as:
  //     screen(c) = A + s * c        where A = get_transformed_position()
  // A already folds in windowActor's position, translation AND pivot, so it
  // is the one anchor worth trusting — reconstructing it from x/y/pivot by
  // hand is what made the old version miss the animation's translation.
  //
  // Hence, to land a child on an arbitrary screen rect while it still paints
  // its own content at true 1:1 scale:
  //     child.scale    = 1 / s          (net scale inside the parent = 1)
  //     child.position = d / s          (so screen origin = A + d)
  //     child.size     = the on-screen size, used verbatim
  // At s = 1 this collapses to position = d, scale = 1 — the plain,
  // non-animating case — so it is safe to call every frame.
  //
  // `dx`/`dy` are the desired screen origin RELATIVE TO A, in screen pixels.
  _applyCounterScale(
    child: Clutter.Actor,
    windowActor: Meta.WindowActor,
    dx: number, dy: number,
    w: number, h: number
  ): void {
    const [sx, sy] = this._animationScale(windowActor);

    child.set_pivot_point(0, 0);
    child.remove_clip();
    child.set_size(w, h);

    if (sx === 1 && sy === 1) {
      child.set_scale(1, 1);
      child.set_position(dx, dy);
      return;
    }

    child.set_scale(1 / sx, 1 / sy);
    child.set_position(dx / sx, dy / sy);
  }

  // windowActor's own animation scale, sanitised. Split out so the geometry
  // in _syncStateInner() and the placement above can never disagree about
  // which scale they are compensating for.
  _animationScale(windowActor: Meta.WindowActor): [number, number] {
    let [sx, sy] = windowActor.get_scale();
    if (!Number.isFinite(sx) || sx <= 0) sx = 1;
    if (!Number.isFinite(sy) || sy <= 0) sy = 1;
    return [sx, sy];
  }

  // Corner radius is a screen-pixel quantity, and the glass box now shrinks
  // with the window during a resize animation — so the radius has to shrink
  // with it, or a half-scale window animates as a pill.
  //
  // Guarded on the last applied scale rather than run unconditionally: while
  // nothing is animating this is a Map lookup and a float compare per frame
  // per window, and the settings are only re-read when they actually change.
  _syncAnimatedCornerRadius(state: WindowState, scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    if (state.radiusScaleApplied === s) return;
    state.radiusScaleApplied = s;

    const cornerRadius = this._settings.get_double(this._profileKey(state.profile, 'corner-radius'));
    state.effect.setCornerRadius(cornerRadius * s);
    state.roundingEffect.setRadius((cornerRadius + CORNER_PADDING) * s);
    state.roundingEffect.setGlassRadius(cornerRadius * s);
  }

  _syncState(state: WindowState) {
    let actor = state.windowActor;
    if (!actor || !actor.get_stage() || !actor.mapped) {
      state.bgActor.visible = false;
      state.baseActor.visible = false;
      state.cornerOverlay.visible = false;
      // [PERF] See the matching comment in _syncStateInner() — a hide that
      // skips the write half must not leave a signature that would let the
      // fast path suppress the re-show.
      state.geomSig = undefined;
      return;
    }

    const metaWin = actor.get_meta_window();
    if (!metaWin) return;

    state.effect.beginBatch();
    try {
      this._syncStateInner(state, actor, metaWin);
    } finally {
      // [PERF] try/finally is load-bearing here, not defensive style: the
      // inner function has multiple early `return`s (workspace check,
      // degenerate rect check) that would otherwise leave beginBatch()
      // unmatched — a leaked, permanently-incremented _batchDepth would
      // silently swallow every future queue_repaint() call for this
      // window's effect for the rest of the session once
      // DRAG_PERF_MODE_ENABLED is on.
      state.effect.endBatch();
    }

  }

  // [PERF] Split out of _syncState() purely so the try/finally above can
  // wrap it with a single call instead of duplicating "state.effect.
  // endBatch()" before every one of the early returns already inside this
  // body — behavior is otherwise identical to before this file's
  // DRAG_PERF_MODE_ENABLED work.
  _syncStateInner(state: WindowState, actor: Meta.WindowActor, metaWin: Meta.Window) {
    // PERFORMANCE: Only sync windows on the current active workspace.
    const workspaceManager = global.workspace_manager;
    const activeWorkspace = workspaceManager.get_active_workspace();
    const winWorkspace = metaWin.get_workspace();
    if (winWorkspace && winWorkspace !== activeWorkspace) {
      setActorVisible(state.bgActor, false);
      setActorVisible(state.baseActor, false);
      setActorVisible(state.cornerOverlay, false);
      // [PERF] Drop the geometry signature: this frame HID the glass without
      // running the write half, so a later frame that comes back with the
      // exact same geometry would match the stale signature, take the fast
      // path, and never show the actors again.
      state.geomSig = undefined;
      return;
    }

    if (this._debugFocusLogFrames > 0) this._logFocusDebugInfo(state);

    const rect = metaWin.get_frame_rect();
    const bufferRect = metaWin.get_buffer_rect();

    if (!rect || !bufferRect || rect.width <= 0 || rect.height <= 0) {
      setActorVisible(state.bgActor, false);
      setActorVisible(state.baseActor, false);
      setActorVisible(state.cornerOverlay, false);
      // [PERF] Drop the geometry signature: this frame HID the glass without
      // running the write half, so a later frame that comes back with the
      // exact same geometry would match the stale signature, take the fast
      // path, and never show the actors again.
      state.geomSig = undefined;
      return;
    }

    setActorVisible(state.bgActor, true);
    setActorVisible(state.baseActor, BASE_LAYER_ENABLED);

    // Local offset of the visible frame within the window actor's full buffer
    // — i.e. the width of the invisible CSD border on the left/top. It is a
    // property of the window's decorations, so it only ever changes when the
    // frame itself does, never while the window is merely being moved.
    //
    // [FIX] It must NOT be recomputed from `rect.x - bufferRect.x` on a frame
    // where the window is moving. get_frame_rect() and get_buffer_rect()
    // update at different points, and during an interactive drag the frame
    // rect trails the buffer rect (and windowActor.x, which matches the
    // buffer rect) by exactly one frame's mouse movement. The [anchor] log
    // caught it directly: while dragging with scale=1 and translation=0, the
    // constraint offset — which is nothing but -frameLocalX + SHADER_PADDING
    // — swung between -35 (the window's true 45px border) and -85, and each
    // excursion equalled that frame's mouse movement — i.e. purely the lag, not any
    // real geometry change. Every consumer below inherits it: the glass box,
    // the shader geometry AND the clone containers' absolute anchor, so the
    // whole glass and everything sampled through it jumped by up to 50px per
    // frame, and whatever value happened to be latched on the last frame of
    // the drag stayed until the next sync.
    //
    // So: sample it only while the actor is stationary (the two rects agree
    // then), and hold the last known-good value for the duration of a move.
    const frameLocal = this._frameLocalOffset(state, actor, rect, bufferRect);
    const frameLocalX = frameLocal[0];
    const frameLocalY = frameLocal[1];

    // GNOME animates a resize by easing windowActor's scale, never by
    // changing the frame rect — get_frame_rect() is already the FINAL rect
    // the whole time (windowManager.js _sizeChangedWindow). So every number
    // below is the window's LIVE on-screen geometry: the final rect taken
    // down by the animation's current scale. At scale 1 they are the plain
    // frame rect again.
    // Snapshot the margin for this sync. Everything below derives from it,
    // and it must not change mid-function.
    const margin = this._glassMargin;

    const [sx, sy] = this._animationScale(actor);
    const visW = rect.width * sx;
    const visH = rect.height * sy;

    // Screen origin of the visible frame, relative to windowActor's own
    // transformed origin: screen(c) = A + s*c, so the frame's local offset
    // scales with the animation too.
    const frameDX = frameLocalX * sx;
    const frameDY = frameLocalY * sy;

    // Base background (unblurred) expanded by expansion margin. The padding
    // is added in SCREEN pixels — the child paints at true 1:1 scale, so it
    // must not be scaled with the window.
    // Kept computed even when the base layer is off: bgW/bgH below are the
    // same numbers, and the containers' sizes are read from these.
    const baseActorW = visW + (margin * 2);
    const baseActorH = visH + (margin * 2);
    // ── [PERF] Skip the geometry half when nothing feeding it moved ──────
    //
    // For a window that is simply sitting there, every write below re-sends
    // values identical to last frame's: the same counter-scale, the same
    // clipBox/container sizes, the same shader resolution and geometry, the
    // same four constraint offsets. Clutter no-ops the property sets that
    // land on an unchanged value, but the JS and GObject marshalling to get
    // there is paid regardless, once per window per frame.
    //
    // Deliberately NOT skipped even when this matches:
    //   * the clone sync loops below — a behind-window can move without any
    //     of this window's own geometry changing, and a clone left at a
    //     stale position is the single most-reported bug in this file;
    //   * _checkContainerAnchor() — it is the detector for a subtree that
    //     has stopped being allocated, which can happen with no geometry
    //     change at all, so it has to keep running and its verdict gates
    //     whether the fast path may be taken at all;
    //   * ensureGlassAllocated() in _frameTick(), which is outside this
    //     function entirely.
    //
    // The pivot/allocation reads used by the constraint offsets are hoisted
    // above the check so they can be part of the comparison; they have no
    // side effects and nothing between here and their old position touched
    // them.
    const [pivotFxEarly, pivotFyEarly] = actor.get_pivot_point();
    const [actorWEarly, actorHEarly] = getAllocatedSize(actor);

    const anchorOffByEarly = this._checkContainerAnchor(state);

    // [FIX] Refuse the frame BEFORE writing a runaway transform, not after —
    // see MAX_STRANDED_COUNTER_SCALE. Returns early rather than falling
    // through to the write half, because the whole point is that none of
    // _applyCounterScale()'s set_scale()/set_position() calls happen. Dropping
    // the geometry signature is what lets the next healthy frame take the full
    // path and show the glass again.
    if (this._counterScaleWouldStrand(state)) {
      // Opacity, not visibility — see _setGlassStrandHidden(). Unmapping here
      // is what stopped ensureGlassAllocated() from ever repairing the
      // subtree this guard is reacting to.
      this._setGlassStrandHidden(state, true);
      state.geomSig = undefined;
      return;
    }

    const GEOM_SIG_LEN = 16;
    let sig = state.geomSig;
    if (!sig || sig.length !== GEOM_SIG_LEN) {
      sig = new Float64Array(GEOM_SIG_LEN);
      // Fill with NaN so the very first comparison always misses (NaN never
      // equals itself), rather than matching a legitimate all-zero geometry.
      sig.fill(NaN);
      state.geomSig = sig;
    }

    let geomUnchanged = anchorOffByEarly <= MAX_ANCHOR_DISPLACEMENT;
    const sigValues = [
      rect.x, rect.y, rect.width, rect.height,
      bufferRect.x, bufferRect.y, bufferRect.width, bufferRect.height,
      frameLocalX, frameLocalY,
      sx, sy,
      actor.translation_x || 0, actor.translation_y || 0,
      pivotFxEarly * (Number.isFinite(actorWEarly) ? actorWEarly : 0),
      pivotFyEarly * (Number.isFinite(actorHEarly) ? actorHEarly : 0),
    ];
    for (let i = 0; i < GEOM_SIG_LEN; i++) {
      if (sig[i] !== sigValues[i]) {
        geomUnchanged = false;
        sig[i] = sigValues[i];
      }
    }

    if (geomUnchanged) {
      this._syncClones(state);
      return;
    }

    if (BASE_LAYER_ENABLED)
      this._applyCounterScale(state.baseActor, actor, frameDX - margin, frameDY - margin, baseActorW, baseActorH);

    // Glass background (blurred) expanded by padding.
    const bgW = visW + (margin * 2);
    const bgH = visH + (margin * 2);
    const localX = frameDX - margin;
    const localY = frameDY - margin;

    this._applyCounterScale(state.bgActor, actor, localX, localY, bgW, bgH);

    // [PERF ①b] The rect this window's glass can actually show, in the SAME
    // space the behind-window clones are positioned in (screen coordinates —
    // windowsContainer's InvertedPositionConstraint puts its origin on screen
    // (0,0), which is the load-bearing invariant of this file).
    //
    // clipBox below has clip_to_allocation and is exactly this box, so a
    // behind-window that does not intersect it already contributes zero
    // pixels to the capture. Recording it here rather than reading it back
    // off the actor keeps it exact and free: _applyCounterScale() places the
    // glass at windowActor-screen + (localX, localY) at an unscaled
    // (bgW, bgH) by construction, whatever the window actor's own animation
    // scale is doing.
    state.glassScreenRect = [
      actor.x + (actor.translation_x || 0) + localX,
      actor.y + (actor.translation_y || 0) + localY,
      bgW,
      bgH,
    ];

    state.clipBox.set_position(0, 0);
    state.clipBox.set_size(bgW, bgH);

    // Give containers a real, non-zero size matching their clipping bounds
    state.windowsContainer.set_size(bgW, bgH);
    if (BASE_LAYER_ENABLED)
      state.baseWindowsContainer.set_size(baseActorW, baseActorH);

    // Update shader resolution/geometry. These get the LIVE size too —
    // handing them the final size is what kept the rounded corners and the
    // edge refraction laid out for the maximized window during the whole
    // animation.
    if (state.effect) {
      state.effect.setResolution(bgW, bgH);
      state.effect.setGlassGeometry(0, 0, bgW, bgH);
    }

    // The corner radius is a screen-pixel quantity on a box that is now
    // shrinking with the window, so it has to come down with it — otherwise
    // a half-scale window animates as a pill. Only touched while an
    // animation is actually running (and once more on the way out), so the
    // steady state still costs nothing.
    this._syncAnimatedCornerRadius(state, sx);

    // Reads LAST frame's anchor: the offsets written below only reach the
    // scene graph at the next relayout, which is the whole point — if the
    // subtree is stranded that relayout never comes, and this is how we find
    // out. See MAX_ANCHOR_DISPLACEMENT.
    // [PERF] Sampled once, up where the geometry fast path needs it.
    const anchorOffBy = anchorOffByEarly;

    // ▼ Constraintによる画面全体(0,0)への絶対座標固定 ▼
    // クローン群は絶対スクリーン座標で配置されるので、そのコンテナの原点が
    // 画面の (0,0) に乗るようオフセットを求める。
    //   コンテナの画面原点 = (bgActor の画面原点) + (コンテナのローカル位置)
    //   bgActor の画面原点  = A + localX
    //   コンテナのローカル位置 = -windowActor.x + offset  (InvertedPositionConstraint)
    // これを 0 と置くと offset = (windowActor.x - A) - localX。
    //
    // ここで A は windowActor の変換後原点だが、**get_transformed_position()
    // で読んではならない**。この関数は Meta.LaterType.BEFORE_REDRAW の later
    // から呼ばれ、それは clutter_stage_maybe_relayout() より前に走る。
    // つまり:
    //   actor.x                        → needs_allocation 中は fixed_pos、
    //                                    すなわち「今フレームの新しい位置」
    //   actor.get_transformed_position() → allocation 由来なので「1フレーム前」
    // となり、ドラッグ中はこの2つがちょうど1フレーム分の移動量だけ食い違う。
    // 実際、両者を引き算していた版では scale=1 / translation=0 の平常ドラッグ
    // でも offset が -35 固定であるべきところ -19〜-44 の間で毎フレーム揺れ、
    // クローンコンテナごと同量ずれていた（＝内側のクローンも外周10pxリングも
    // 遅れる。リングは Clone(baseActor) で、baseActor の子が同じ constraint を
    // 持つため巻き込まれる）。
    //
    // なので A - windowActor.x は、allocation に依存しない**生のプロパティ
    // だけ**から組み立てる。Clutter の変換は
    //   A = x + translation + P*(1 - scale)      (P = pivot_point * 自身のサイズ)
    // なので、必要なのは translation / scale / pivot_point の3つだけ。いずれも
    // 単なるプロパティで、レイアウトフェーズを待たない。
    // scale=1 かつ translation=0 なら 0 になり、offset は従来どおり
    // -frameLocalX + SHADER_PADDING に一致する。
    // [PERF] Hoisted above the geometry fast path so its comparison can
    // include them; identical reads, just done earlier in the function.
    const pivotPxX = (Number.isFinite(pivotFxEarly) ? pivotFxEarly : 0) * (Number.isFinite(actorWEarly) ? actorWEarly : 0);
    const pivotPxY = (Number.isFinite(pivotFyEarly) ? pivotFyEarly : 0) * (Number.isFinite(actorHEarly) ? actorHEarly : 0);

    const anchorDX = (actor.translation_x || 0) + pivotPxX * (1 - sx);
    const anchorDY = (actor.translation_y || 0) + pivotPxY * (1 - sy);

    const offsetX = -anchorDX - localX;
    const offsetY = -anchorDY - localY;

    // setOffset() ではなく生の offset_x/offset_y 代入だと、値は変わっても
    // allocation の再計算が要求されない。ウィンドウが動かない開閉アニメーション
    // 中（scale だけが変わる ＝ offsetX は毎フレーム変わる）はそれで完全に
    // 取り残される。InvertedPositionConstraint.setOffset() 参照。
    state.constraints.bg.setOffset(offsetX, offsetY);
    state.constraints.windows.setOffset(offsetX, offsetY);
    if (BASE_LAYER_ENABLED) {
      state.constraints.base.setOffset(offsetX, offsetY);
      state.constraints.baseWindows.setOffset(offsetX, offsetY);
    }

    this._syncClones(state);

    // Sync corner overlays
    // [PERF] Hidden and not laid out at all when the reveal is off — see
    // CORNER_REVEAL_ENABLED. cornerOverlayClone is a Clone of baseActor, so
    // painting it repaints the wallpaper clone and every behind-window clone
    // a second time per frame per window.
    setActorVisible(state.cornerOverlay, CORNER_REVEAL_ENABLED);

    if (CORNER_REVEAL_ENABLED) {
      const baseW = visW + (margin * 2);
      const baseH = visH + (margin * 2);

      this._applyCounterScale(state.cornerOverlay, actor, frameDX - margin, frameDY - margin, baseW, baseH);

      state.cornerOverlayClone.set_position(0, 0);
      state.cornerOverlayClone.set_size(baseW, baseH);
    }

    // [FIX] Last line of defence, applied after every setActorVisible(…, true)
    // above so it wins. If the clone containers are anchored hundreds of
    // pixels away from screen (0,0), this glass cannot draw anything but
    // garbage this frame — the constraint offsets are computed correctly (the
    // [anchor] log prints them) but are not reaching the allocation, which
    // only happens when the subtree is stranded. Everything inside is then
    // painting the wrong part of the screen, magnified by whatever
    // counter-scale the current animation asked for. Hide it and let
    // _frameTick()'s ensureGlassAllocated() calls do the repair.
    if (anchorOffBy > MAX_ANCHOR_DISPLACEMENT) {
      // Opacity, not visibility — see _setGlassStrandHidden(). The comment
      // above says to let ensureGlassAllocated() do the repair, and with
      // setActorVisible() it never could.
      this._setGlassStrandHidden(state, true);
      // [PERF] Drop the geometry signature: this frame HID the glass without
      // running the write half, so a later frame that comes back with the
      // exact same geometry would match the stale signature, take the fast
      // path, and never show the actors again.
      state.geomSig = undefined;
    } else {
      this._setGlassStrandHidden(state, false);
    }
  }
  /**
   * Places every "window behind" clone at its source's current geometry.
   *
   * [PERF] Split out of _syncStateInner() so the geometry fast path there can
   * skip its own work and still run this: a behind-window can move, resize,
   * fade or unmap without anything about THIS window's geometry changing, and
   * a clone left at a stale position is the failure mode this file has
   * regressed into most often. Body is unchanged from when it was inline.
   */
  /**
   * Keeps a glass whose capture contains another glass from latching to black.
   *
   * The failure: painting a behind-clone paints its source, and for a window
   * that owns a glass that means an inner ClutterOffscreenEffect. At the
   * moment that inner effect RE-RENDERS its own offscreen — not when it
   * simply blits its cached one — the outer capture comes out empty, and it
   * stays empty because nothing afterwards marks the outer actor dirty.
   * Measured 2026-09-16: a static inner glass never triggers it (0/14 black
   * frames), one that keeps re-rendering does (11/14), and forcing
   * bgActor.queue_redraw() clears it for exactly as long as it takes to
   * happen again.
   *
   * Two repairs, switchable so they can be compared on the same desktop —
   * see NestedGlassFix in utils.ts for why neither is obviously right.
   */
  _repairNestedGlass(state: WindowState): void {
    const mode = getNestedGlassFix();
    if (mode === 'off') return;
    const bg = state.bgActor;
    if (!bg || !isActorValid(bg) || !bg.mapped || !bg.visible) return;

    // (D) The one that is both correct and free when nothing is happening.
    // MetaWindowActor::damaged fires while damage is being processed, which
    // is BEFORE the frame clock paints — so marking the outer dirty from it
    // lands on the very frame the inner will re-render, not the one after.
    if (mode === 'damage') {
      this._syncDamageHooks(state);
      return;
    }

    // (B) Never reuse the capture. Correct by construction, and exactly the
    // unconditional repaint phase 3's A2 removed — so this costs back what
    // A2 bought, for every window, whether or not anything is nested.
    if (mode === 'recapture') {
      bg.queue_redraw();
      return;
    }

    // (C) Only after an inner glass we clone actually re-rendered. Cheap, but
    // the serial can only be read on the frame AFTER the re-render, so the
    // repair is one frame late by construction: the black becomes a flicker
    // rather than going away.
    let seen = state.nestedSerials;
    if (!seen) { seen = new Map(); state.nestedSerials = seen; }

    let stale = false;
    for (const [src, clone] of state.clones.entries()) {
      if (!isActorValid(clone) || !clone.visible) continue;
      const inner = innerGlassEffectOf(src);
      if (!inner) continue;
      const serial = inner._recaptureSerial;
      if (seen.get(src) !== serial) { seen.set(src, serial); stale = true; }
    }
    // Drop entries for clones this glass no longer has, so the map cannot grow
    // with every window that has ever been behind this one.
    if (seen.size > state.clones.size) {
      for (const src of [...seen.keys()]) if (!state.clones.has(src)) seen.delete(src);
    }

    if (stale) bg.queue_redraw();
  }

  /**
   * Keeps one MetaWindowActor::damaged handler per behind-cloned window that
   * owns a glass, and nothing else.
   *
   * Why this beats both of the other repairs: the handler runs during damage
   * processing, i.e. before the frame clock dispatches its paint, so the
   * queue_redraw() lands on the SAME frame the inner glass will re-render.
   * 'propagate' can only read the inner's serial on the frame after, which is
   * why it turns the black into a flicker instead of removing it; 'recapture'
   * removes it but pays a repaint per frame per window forever. This pays
   * exactly one extra repaint per actual content change of a glassed window
   * behind, and nothing at all while the desktop sits still.
   *
   * Measured 2026-09-17 with a live prototype of this hook, maximized window
   * with Resources (glassed, 4Hz) behind: 0/26 black frames against 4/26 with
   * no repair, for 298 extra repaints over the whole run.
   *
   * Only glassed sources are hooked: a behind-window with no glass of its own
   * adds no nested offscreen and has never been seen to trigger this.
   */
  _syncDamageHooks(state: WindowState): void {
    let hooks = state.damageHooks;
    if (!hooks) { hooks = new Map(); state.damageHooks = hooks; }

    for (const src of state.clones.keys()) {
      if (hooks.has(src)) continue;
      if (!isActorValid(src) || !innerGlassEffectOf(src)) continue;
      try {
        const id = src.connect('damaged', () => {
          const bg = state.bgActor;
          if (bg && isActorValid(bg) && bg.mapped && bg.visible) bg.queue_redraw();
        });
        hooks.set(src, id);
      } catch (_) { /* a source that cannot be connected simply goes unhooked */ }
    }

    // Drop handlers for windows this glass no longer clones, so the map cannot
    // grow with every window that has ever been behind this one.
    if (hooks.size > state.clones.size) {
      for (const [src, id] of [...hooks]) {
        if (state.clones.has(src)) continue;
        try { if (isActorValid(src)) src.disconnect(id); } catch (_) { }
        hooks.delete(src);
      }
    }
  }

  _releaseDamageHooks(state: WindowState): void {
    if (!state.damageHooks) return;
    for (const [src, id] of state.damageHooks) {
      try { if (isActorValid(src)) src.disconnect(id); } catch (_) { }
    }
    state.damageHooks.clear();
    state.damageHooks = undefined;
  }

  _syncClones(state: WindowState): void {
    // [PERF ①b] Cull behind-window clones that fall outside this glass's own
    // box. See state.glassScreenRect.
    //
    // Why this is the interesting half of ①: clipBox already SCISSORS those
    // clones away, but a scissored clone still paints — and painting a clone
    // paints its source, which for a window that has glass of its own means
    // that window's capture/blur/composite runs again, into its own FBO,
    // where our scissor cannot reach. That is the 2^N-1 nesting of memo.md ⑤.
    // An invisible clone is skipped by clutter_actor_paint() outright, so the
    // nested glass never runs. Nothing changes on screen: those pixels were
    // being thrown away by clipBox anyway.
    //
    // Skipped while the window actor is mid animation-scale: the glass is
    // counter-scaled to stay unscaled on screen, but the window actor's own
    // pivot-based transform makes the screen rect above approximate for those
    // few frames, and a clone flickering during a close animation would be
    // far more visible than the frames are worth.
    const [animSx, animSy] = this._animationScale(state.windowActor);
    const cullRect = (isCullSiteEnabled('app') && animSx === 1 && animSy === 1)
      ? state.glassScreenRect
      : undefined;
    // ▼ 個別ウィンドウのクローン同期 (translation_x/yを使用) ▼
    // Sync blurred clones
    for (let [src, clone] of state.clones.entries()) {
      if (!isActorValid(src) || !src.visible || !src.mapped) {
        if (isActorValid(clone)) setActorVisible(clone, false);
        this._clearCloneAnomaly(clone);
        continue;
      }
      if (isActorValid(clone)) {
        if (this._shouldCullClone(src, cullRect)) {
          setCloneCulled(clone, true, this._cullWhy(src, cullRect!, 'blurred'));
          this._clearCloneAnomaly(clone);
          continue;
        }
        setCloneCulled(clone, false, 'app/blurred');
        setActorVisible(clone, true);

        // 実際のプロパティ(x,y)は0,0に固定し、描画オフセットのみで配置する
        // [PERF] 値が変わったときだけ書く。Clutter の translation/scale の
        // setter は比較せずに queue_redraw() まで走るので、静止中でも毎フレーム
        // クローンを damage し、それを含むガラス全段を再描画させていた。
        // 詳細は utils.ts の setTranslationIfChanged()。
        if (clone.x !== 0 || clone.y !== 0) clone.set_position(0, 0);
        setTranslationIfChanged(clone, src.x, src.y);

        setSizeIfChanged(clone, src.width, src.height);
        setScaleIfChanged(clone, src.scale_x, src.scale_y);
        setOpacityIfChanged(clone, src.opacity);

        this._checkCloneAnomaly(clone, src, 'blurred');
      }
    }

    // [window-clone-clip] Keep the cull opt-out in step with what this glass
    // clones, so mutter stops handing those windows' surface actors a
    // damage-limited clip region. See CullOptOutEffect in utils.ts.
    reportClonedWindowActors(state, state.clones.keys());

    this._repairNestedGlass(state);

    // Sync base clones (unblurred). The map is empty while the base layer is
    // off (they are never built), so this is just skipping the iteration.
    if (!BASE_LAYER_ENABLED) return;

    for (let [src, clone] of state.baseClones.entries()) {
      if (!isActorValid(src) || !src.visible || !src.mapped) {
        if (isActorValid(clone)) setActorVisible(clone, false);
        this._clearCloneAnomaly(clone);
        continue;
      }
      if (isActorValid(clone)) {
        if (this._shouldCullClone(src, cullRect)) {
          setCloneCulled(clone, true, this._cullWhy(src, cullRect!, 'base'));
          this._clearCloneAnomaly(clone);
          continue;
        }
        setCloneCulled(clone, false, 'app/base');
        setActorVisible(clone, true);

        if (clone.x !== 0 || clone.y !== 0) clone.set_position(0, 0);
        setTranslationIfChanged(clone, src.x, src.y);

        setSizeIfChanged(clone, src.width, src.height);
        setScaleIfChanged(clone, src.scale_x, src.scale_y);
        setOpacityIfChanged(clone, src.opacity);

        this._checkCloneAnomaly(clone, src, 'base');
      }
    }
  }

  // [FIX] See the 3-2 investigation comment above _syncState()'s clone sync
  // loops. `kind` is just "blurred"/"base" for the log line. Deliberately
  // does NOT check has_allocation() — we just called set_position()/
  // set_size() on this same clone moments earlier in this same frame,
  // which (per the BEFORE_REDRAW timing already confirmed via
  // [alloc-probe]) would make has_allocation() read false unconditionally
  // regardless of whether anything is actually wrong; including it here
  // would just spam false positives every frame. `mapped` and a
  // degenerate/zero size are the only checks that don't have that problem.
  _checkCloneAnomaly(clone: Clutter.Actor, src: Meta.WindowActor, kind: string): void {
    let mapped = true, w = -1, h = -1;
    try { mapped = clone.mapped; } catch (e) { }
    try { [w, h] = clone.get_size(); } catch (e) { }

    const degenerate = !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0;
    const anomalous = !mapped || degenerate;

    if (anomalous && !this._anomalousClones.has(clone)) {
      this._anomalousClones.add(clone);
      const srcMetaWindow = typeof (src as any).get_meta_window === 'function' ? (src as any).get_meta_window() : null;
      const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
      this._logger.log(
        `[Liquid Glass][clone-anomaly] ENTER kind=${kind} src="${srcTitle}" ` +
        `mapped=${mapped} size=(${w}x${h}) ` +
        `clone.(x,y)=(${clone.x},${clone.y}) clone.visible=${clone.visible} clone.opacity=${clone.opacity}`
      );
    } else if (!anomalous && this._anomalousClones.has(clone)) {
      this._anomalousClones.delete(clone);
      const srcMetaWindow = typeof (src as any).get_meta_window === 'function' ? (src as any).get_meta_window() : null;
      const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
      this._logger.log(`[Liquid Glass][clone-anomaly] EXIT kind=${kind} src="${srcTitle}"`);
    }
  }

  _clearCloneAnomaly(clone: Clutter.Actor): void {
    this._anomalousClones.delete(clone);
  }

  /**
   * [PERF ①b] True when `src` cannot contribute a pixel to a glass whose box
   * is `cullRect` (screen coordinates), so its clone need not be painted.
   *
   * **Fails open.** The size comes from the allocation rather than from
   * src.width/src.height: those fall back to the PREFERRED size whenever a
   * relayout is pending, and this runs from a BEFORE_REDRAW later, i.e.
   * before clutter_stage_maybe_relayout() — the exact situation
   * getAllocatedSize() exists for (see its comment, and the same trap in
   * _rebuildWindowClones()). A source that reports a degenerate rect there
   * would intersect nothing and be culled from every glass that is not at
   * the top-left of the screen, which on screen reads as the glass losing
   * its background. So anything not clearly outside is kept.
   */
  /** [DIAG] The one-line "why" handed to setCloneCulled() on a transition. */
  _cullWhy(
    src: Meta.WindowActor,
    cullRect: [number, number, number, number],
    kind: string
  ): string {
    const [w, h] = getAllocatedSize(src);
    return `src=(${Math.round(src.x)},${Math.round(src.y)},${Math.round(w)}x${Math.round(h)}) ` +
      `glassRect=[${cullRect.map(Math.round)}] app/${kind}`;
  }

  _shouldCullClone(
    src: Meta.WindowActor,
    cullRect: [number, number, number, number] | undefined
  ): boolean {
    if (!cullRect) return false;

    const [w, h] = getAllocatedSize(src);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;

    const x = src.x, y = src.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    const m = ApplicationManager.CLONE_CULL_MARGIN;
    return !rectsIntersect(x - m, y - m, w + m * 2, h + m * 2, cullRect);
  }

  _frameTick() {
    if (this._torndown) return;
    if (isFrameSyncFrozen()) return;

    const nowUs = GLib.get_monotonic_time();
    if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
    this._lastTickUs = nowUs;

    for (let state of this._states.values()) {
      try {
        const metaWin = state.windowActor?.get_meta_window?.();
        // Skip this window only — never return, or the reschedule at the end
        // is missed and the whole per-frame sync chain stops permanently.
        if (!metaWin) continue;
        // [FIX] Rescue the WINDOW ACTOR first, not just our own three roots.
        //
        // The earlier comment here claimed MetaWindowActor is flagged
        // NO_LAYOUT, which would make bgActor/baseActor/cornerOverlay queue
        // their relayouts straight onto the stage
        // (clutter_actor_queue_shallow_relayout) and be rescuable on their
        // own. It is not: mutter's MetaWindowActor sets no such flag and
        // implements no allocate vfunc — its children are laid out by
        // Clutter's default fixed layout. So a glass root's
        // queue_relayout() goes to
        //
        //     clutter_actor_real_queue_relayout()
        //       -> _clutter_actor_queue_only_relayout(windowActor)
        //            if (needs_width_request && needs_height_request &&
        //                needs_allocation) return;  // save some cpu cycles
        //
        // and dies there whenever the window actor itself is stranded. That
        // made the rescue below unable to ever land: hide()/show() cleared
        // the glass root's own three flags via real_map(), the follow-up
        // queue_relayout() was swallowed by the stranded window actor, and
        // the root was unallocated again on the very next frame. journalctl
        // from the bad session shows exactly that — "Can't update stage
        // views actor lgw-base ... needs an allocation" at 60/s per window,
        // for a minute and a half, never once recovering, with the window
        // actor itself ("unnamed [MetaWindowActorWayland]") warned about in
        // the same stretch.
        //
        // Remapping the window actor clears the flags for the whole subtree
        // in one go (real_map() recurses into every child), so this single
        // call is what makes the three below effective again. Gated on a
        // longer stranded streak than our own actors get: this one is
        // Mutter's, and a live window must never be remapped just because a
        // legitimate relayout took a few frames.
        // [anim-jitter] Two stages now; see ensureWindowActorAllocated(). The
        // remap below is mutter's own window actor being unmapped and remapped
        // mid-animation, which the 100ms capture caught happening ~3 times a
        // second across five windows. Stage 1 asks the window group to
        // relayout instead, which is not swallowed by the window actor's own
        // short-circuit and costs one relayout.
        // [anim-diag] Keep the dump able to say WHICH window this glass is.
        try {
          const label = metaWin.get_title() || '(untitled)';
          if ((state.effect as any)._diagOwnerLabel !== label)
            (state.effect as any)._diagOwnerLabel = label;
        } catch (_) { /* noop */ }

        const rescue = ensureWindowActorAllocated(
          state.windowActor, WINDOW_ACTOR_RELAYOUT_FRAMES, WINDOW_ACTOR_STRANDED_FRAMES);
        if (rescue) {
          const title = metaWin.get_title() || '(untitled)';
          // [anim-stall] First few entries only — see noteStrandEntry().
          noteStrandEntry(title,
            `wa.alloc=${state.windowActor.has_allocation()} ` +
            `wg.alloc=${(() => { const p: any = state.windowActor.get_parent();
              return p ? p.has_allocation() : '-'; })()} ` +
            `scale=${state.windowActor.scale_x.toFixed(3)} op=${state.windowActor.opacity} ` +
            `min=${metaWin.minimized} stage=${rescue}`);
          // The whole chain, because "needs an allocation" alone never said
          // WHY. clutter_actor_allocate() refuses outright for an actor that
          // is not mapped and has no mapped clones, and a parent whose own
          // box did not change never re-runs its layout manager -- so the
          // answer is in the map/alloc flags of the actor AND its parent, not
          // in the glass.
          this._logger.log(
            `[Liquid Glass][strand] ${rescue} for "${title}" — ` +
            `wa(mapped=${state.windowActor.mapped},vis=${state.windowActor.visible},` +
            `alloc=${state.windowActor.has_allocation()},op=${state.windowActor.opacity},` +
            `scale=${state.windowActor.scale_x.toFixed(3)}) ` +
            `parent(${(() => { const p: any = state.windowActor.get_parent();
              return p ? `${p.constructor?.name},mapped=${p.mapped},alloc=${p.has_allocation()}` : 'none'; })()}) ` +
            `bg(mapped=${state.bgActor.mapped},vis=${state.bgActor.visible},` +
            `alloc=${state.bgActor.has_allocation()}) ` +
            `min=${metaWin.minimized}`
          );
        }
        ensureGlassAllocated(state.bgActor);
        ensureGlassAllocated(state.baseActor);
        ensureGlassAllocated(state.cornerOverlay);
        this._syncState(state);

        if (this._debugFocusLogFrames > 0) this._logFocusDebugInfo(state);
      } catch (e) {
        this._logger.error(`[Liquid Glass] Error in _syncState: ${e}`);
      }
    }

    if (this._debugFocusLogFrames > 0) this._debugFocusLogFrames--;
  }

  // ── Diagnostics: focus-change "shifted texture" investigation ──────────────
  // Logs, for `state`'s own window, the raw Clutter actor position next to
  // Meta's frame_rect/buffer_rect — this is the "two sources of truth"
  // pairing _syncState() otherwise assumes always agree (see the
  // container-offset math using get_buffer_rect()/get_frame_rect() vs. each
  // behind-window clone's position using the source actor's raw .x/.y).
  // Also logs, for every "window behind" clone this state currently draws,
  // its source actor's raw .x/.y vs. get_transformed_position() (to check
  // whether that assumption itself ever diverges) and the position that
  // will actually be applied to the clone this frame.
  _armFocusDebug(reason: string) {
    // Off by default — see isFocusDebugEnabled(). Checked HERE, not at the
    // log calls, so that with the diagnostic off _debugFocusLogFrames stays 0
    // and none of the per-window / per-clone template strings are built
    // either. Formatting them and throwing the result away was most of the
    // cost even when `output-logs` was off.
    if (!isFocusDebugEnabled()) return;
    this._debugFocusLogFrames = ApplicationManager.DEBUG_FOCUS_LOG_FRAME_COUNT;
    this._logger.log(`[Liquid Glass][focus-debug] ---- ${reason} event ----`);
  }

  // The load-bearing invariant of this whole file: windowsContainer /
  // baseWindowsContainer carry an InvertedPositionConstraint whose offset is
  // chosen so the container's origin lands exactly on SCREEN (0,0) — that is
  // the only reason the clones inside it can be positioned with raw absolute
  // screen coordinates (clone.translation_x = src.x).
  //
  // If that anchor drifts, every clone inside the glass is displaced by the
  // same amount — which is both the "the glass shows a completely different
  // part of the screen" report and the one-frame drag lag (this probe caught
  // the latter: offset wobbling between -19 and -44 where the geometry says
  // it must be a constant -35). Anything computing that offset from an
  // allocation-derived read inside the BEFORE_REDRAW later will trip it, so
  // it is worth leaving armed.
  //
  // Returns how far the anchor is off, in screen pixels (Infinity when it is
  // not a finite position at all), so the caller can refuse to draw glass
  // that is grossly displaced — see MAX_ANCHOR_DISPLACEMENT.
  /**
   * True when this frame is about to counter-scale a subtree that did not pick
   * up the last relayout — the combination that turns a legitimate 1/scale
   * transform into a damage rectangle tens of thousands of pixels wide. See
   * MAX_STRANDED_COUNTER_SCALE for why both halves are needed and why this can
   * be trusted at the top of a BEFORE_REDRAW tick.
   */
  /**
   * [min-restore] Drags a glass subtree back into the allocation cycle after
   * its window actor was remapped.
   *
   * Runs on the next BEFORE_REDRAW rather than inside ::notify so the map has
   * fully settled (real_map recurses into children) before anything is asked
   * about has_allocation(). ensureGlassAllocated() with a one-frame threshold
   * is the existing, proven repair -- hide()/show() clears needs_width_request
   * / needs_height_request / needs_allocation via real_map() -- and here it is
   * applied at the one moment it is certainly needed instead of after three to
   * fourteen stranded frames of the per-frame detector noticing.
   *
   * These are all OUR actors. Mutter's window actor is deliberately not
   * touched: it has just been mapped, so it is not the one that is stuck.
   */
  _forceGlassReallocation(state: WindowState): void {
    if (state.remapReallocLaterId) return;
    state.remapReallocLaterId = global.compositor.get_laters().add(
      Meta.LaterType.BEFORE_REDRAW,
      () => {
        state.remapReallocLaterId = 0;
        try {
          if (this._torndown || !this._states.has(state.windowActor)) return false;
          if (!isActorValid(state.windowActor) || !state.windowActor.mapped) return false;

          let rescued = 0;
          for (const actor of [state.bgActor, state.baseActor,
                               state.cornerOverlay, state.windowsContainer]) {
            if (isActorValid(actor) && ensureGlassAllocated(actor, 1)) rescued++;
          }
          state.isDirty = true;

          if (rescued > 0) {
            const metaWin = state.windowActor.get_meta_window();
            const title = metaWin ? (metaWin.get_title() || '(untitled)') : '(?)';
            this._logger.log(
              `[Liquid Glass][min-restore] re-allocated ${rescued} glass actor(s) for ` +
              `"${title}" after its window actor was remapped`
            );
          }
        } catch (e) {
          this._logger.error(`[Liquid Glass] _forceGlassReallocation failed: ${e}`);
        }
        return false;
      });
  }

  /**
   * [strand-latch] Hides the glass for a frame WITHOUT unmapping it.
   *
   * The two guards that use this both hide the glass because the subtree is
   * stranded, and both say "let ensureGlassAllocated() repair it". With
   * setActorVisible(..., false) that repair can never run, and the result is a
   * closed loop:
   *
   *   1. the anchor is off because the subtree has no allocation
   *      -> hide bgActor/baseActor/cornerOverlay
   *   2. ensureGlassAllocated() opens with
   *          if (!actor.visible || !actor.mapped || actor.has_allocation()) {
   *            _strandedFrames.delete(actor); return false;
   *          }
   *      so a hidden actor is not merely skipped, its stranded streak is
   *      RESET every frame -- the rescue can never reach its threshold
   *   3. and hiding means unmapping, while clutter_actor_allocate() refuses
   *          if (!TOPLEVEL && !is_mapped && !has_mapped_clones) return;
   *      so while hidden the actor cannot be allocated at all
   *   4. -> the anchor stays off -> back to 1.
   *
   * The ring capture caught exactly this: bg(mapped=false,vis=false,
   * alloc=false) on a window sitting at scale=0.995, i.e. long after the
   * animation that triggered it had finished.
   *
   * Opacity 0 costs the same on screen -- clutter_actor_paint() returns at the
   * top for a zero paint opacity -- but keeps the actor mapped, allocatable
   * and therefore repairable. Same reasoning as the shared wallpaper source.
   */
  _setGlassStrandHidden(state: WindowState, hidden: boolean): void {
    const wanted = hidden ? 0 : 255;
    for (const actor of [state.bgActor, state.baseActor, state.cornerOverlay]) {
      if (!isActorValid(actor)) continue;
      if (actor.opacity !== wanted) actor.opacity = wanted;
    }
  }

  _counterScaleWouldStrand(state: WindowState): boolean {
    const container = state.windowsContainer;
    if (!isActorValid(container)) return false;

    const [sx, sy] = this._animationScale(state.windowActor);
    const counterScale = Math.max(1 / sx, 1 / sy);

    let stranded = false;
    if (counterScale > MAX_STRANDED_COUNTER_SCALE) {
      try { stranded = !container.has_allocation(); } catch (_) { stranded = false; }
    }

    const known = this._strandedScaleWindows.has(container);
    if (stranded && !known) {
      this._strandedScaleWindows.add(container);
      const metaWin = state.windowActor.get_meta_window();
      const title = metaWin ? (metaWin.get_title() || '(untitled)') : '(?)';
      this._logger.log(
        `[Liquid Glass][anchor] REFUSED window="${title}" ` +
        `counterScale=${counterScale.toFixed(1)}x scale=(${sx.toFixed(4)},${sy.toFixed(4)}) ` +
        `container.hasAlloc=false — glass hidden for this frame rather than ` +
        `written with a transform the stale allocation cannot cancel`
      );
    } else if (!stranded && known) {
      this._strandedScaleWindows.delete(container);
      this._logger.log('[Liquid Glass][anchor] REFUSED cleared');
    }

    return stranded;
  }

  _checkContainerAnchor(state: WindowState): number {
    const container = state.windowsContainer;
    if (!isActorValid(container)) return 0;

    let x = NaN, y = NaN;
    try { [x, y] = container.get_transformed_position(); } catch (e) { return 0; }

    const offBy = (!Number.isFinite(x) || !Number.isFinite(y))
      ? Infinity
      : Math.max(Math.abs(x), Math.abs(y));
    const displaced = offBy > 1;
    const known = this._displacedContainers.has(container);

    if (displaced && !known) {
      this._displacedContainers.add(container);
      const metaWin = state.windowActor.get_meta_window();
      const title = metaWin ? (metaWin.get_title() || '(untitled)') : '(?)';
      const [sx, sy] = this._animationScale(state.windowActor);
      this._logger.log(
        `[Liquid Glass][anchor] DRIFT window="${title}" ` +
        `container.transformedPos=(${Math.round(x)},${Math.round(y)}) expected=(0,0) ` +
        `windowActor.(x,y)=(${state.windowActor.x},${state.windowActor.y}) ` +
        `translation=(${state.windowActor.translation_x},${state.windowActor.translation_y}) ` +
        `scale=(${sx.toFixed(4)},${sy.toFixed(4)}) ` +
        `constraint.offset=(${state.constraints.windows.offset_x},${state.constraints.windows.offset_y})`
      );
    } else if (!displaced && known) {
      this._displacedContainers.delete(container);
      this._logger.log('[Liquid Glass][anchor] RECOVERED');
    }

    return offBy;
  }

  _logFocusDebugInfo(state: WindowState) {
    const actor = state.windowActor;
    const metaWin = actor.get_meta_window();
    if (!metaWin) return;

    const title = metaWin.get_title() || '(untitled)';
    const [actorX, actorY] = [actor.x, actor.y];
    const [tX, tY] = actor.get_transformed_position();
    const frameRect = metaWin.get_frame_rect();
    const bufferRect = metaWin.get_buffer_rect();

    const [asx, asy] = this._animationScale(actor);
    // The container's real screen origin — must be (0,0), see
    // _checkContainerAnchor(). Logged raw so a drift is visible in the
    // frame-by-frame trace, not just as an enter/exit event.
    let ancX = NaN, ancY = NaN;
    try { [ancX, ancY] = state.windowsContainer.get_transformed_position(); } catch (e) { }

    this._logger.log(
      `[Liquid Glass][focus-debug] window="${title}" ` +
      `windowActor.(x,y)=(${actorX},${actorY}) ` +
      `transformedPos=(${Math.round(tX)},${Math.round(tY)}) ` +
      `translation=(${actor.translation_x},${actor.translation_y}) ` +
      `scale=(${asx.toFixed(4)},${asy.toFixed(4)}) ` +
      `frameRect=(${frameRect.x},${frameRect.y},${frameRect.width}x${frameRect.height}) ` +
      `bufferRect=(${bufferRect.x},${bufferRect.y},${bufferRect.width}x${bufferRect.height}) ` +
      `actorX-bufferRect.x=${actorX - bufferRect.x} actorY-bufferRect.y=${actorY - bufferRect.y} ` +
      `containerAnchor=(${Math.round(ancX)},${Math.round(ancY)}) ` +
      `bgActor.hasAlloc=${state.bgActor.has_allocation()} ` +
      `container.hasAlloc=${state.windowsContainer.has_allocation()}`
    );

    for (let [src, clone] of state.clones.entries()) {
      if (!isActorValid(src) || !isActorValid(clone)) continue;
      const srcMetaWindow = typeof (src as any).get_meta_window === 'function'
        ? (src as any).get_meta_window() : null;
      const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
      const [srcX, srcY] = [src.x, src.y];
      const [srcTX, srcTY] = src.get_transformed_position();
      // clone.(x,y) is pinned at (0,0) BY DESIGN — the position lives in
      // translation_x/y (see the clone sync in _syncStateInner). Logging
      // only (x,y), as this used to, made every healthy clone look broken
      // and hid the value that actually matters.
      let cloneScreenX = NaN, cloneScreenY = NaN;
      try { [cloneScreenX, cloneScreenY] = clone.get_transformed_position(); } catch (e) { }
      this._logger.log(
        `[Liquid Glass][focus-debug]   behind-clone src="${srcTitle}" ` +
        `src.(x,y)=(${srcX},${srcY}) src.transformedPos=(${Math.round(srcTX)},${Math.round(srcTY)}) ` +
        `diff=(${Math.round(srcTX - srcX)},${Math.round(srcTY - srcY)}) ` +
        `clone.translation=(${clone.translation_x},${clone.translation_y}) ` +
        `clone.size=(${clone.width}x${clone.height}) ` +
        `clone.screenPos=(${Math.round(cloneScreenX)},${Math.round(cloneScreenY)}) ` +
        `clone.hasAlloc=${clone.has_allocation()} clone.mapped=${clone.mapped}`
      );
    }
  }

  _cleanupState(state: WindowState) {
    if (!state) return;

    // Before anything else: these are handlers on Mutter's own window actors,
    // which outlive this state. A missed disconnect here keeps the closure —
    // and through it the whole state — alive against a destroyed glass.
    this._releaseDamageHooks(state);
    releaseClonedWindowActors(state);
    // [min-restore] This later closes over `state`; leaving it armed would run
    // against a torn-down glass.
    if (state.remapReallocLaterId) {
      try { global.compositor.get_laters().remove(state.remapReallocLaterId); } catch (_) { /* noop */ }
      state.remapReallocLaterId = 0;
    }

    // Restore the original opacity of the window's own content layer.
    // Uses the cached surfaceActor reference (see WindowState) rather than
    // windowActor.get_first_child(), which no longer points at the real
    // surface once baseActor has been inserted below it.
    if (state.surfaceActor) {
      try {
        if (isActorValid(state.surfaceActor)) {
          state.surfaceActor.opacity = state.originalOpacity;
        }
      } catch (e) {
        // Window actor may already be destroyed; safe to ignore.
      }
    }

    if (state.signals) {
      state.signals.forEach(sig => {
        try {
          sig.obj.disconnect(sig.id);
        } catch (e) { }
      });
      state.signals = [];
    }
    // [FIX] Every actor below is a child of the window actor, so by the time
    // this runs from the 'destroy' handler (windowManager's destroy-animation
    // completion) Clutter has usually already disposed the whole subtree.
    // Reaching into those wrappers unguarded is what produced the
    // "Object ... has been already disposed" Gjs-CRITICALs with backtraces
    // into this function; worse, a method call on a disposed GObject throws,
    // which used to abort the rest of the cleanup (the effect was never
    // cleaned up, the constraints kept their source).
    if (state.constraints) {
      if (isActorValid(state.bgClone))
        state.bgClone.remove_constraint(state.constraints.bg);
      if (isActorValid(state.windowsContainer))
        state.windowsContainer.remove_constraint(state.constraints.windows);
      if (isActorValid(state.baseClone))
        state.baseClone.remove_constraint(state.constraints.base);
      if (isActorValid(state.baseWindowsContainer))
        state.baseWindowsContainer.remove_constraint(state.constraints.baseWindows);

      state.constraints.bg.source = null;
      state.constraints.windows.source = null;
      state.constraints.base.source = null;
      state.constraints.baseWindows.source = null;

    }

    state.clones.forEach(clone => { if (isActorValid(clone)) clone.destroy(); });
    state.clones.clear();

    state.baseClones.forEach(clone => { if (isActorValid(clone)) clone.destroy(); });
    state.baseClones.clear();

    if (state.effect) {
      try {
        state.effect.cleanup();
      } catch (e) { }
    }

    if (isActorValid(state.bgActor))
      state.bgActor.destroy();

    if (isActorValid(state.baseActor))
      state.baseActor.destroy();

    if (isActorValid(state.cornerOverlay))
      state.cornerOverlay.destroy();
  }
}
