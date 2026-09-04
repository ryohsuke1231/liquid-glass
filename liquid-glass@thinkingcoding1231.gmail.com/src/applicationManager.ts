// src/applicationManager.ts
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UnpickableClone, UnpickableActor, InverseCornerEffect, getWindowActors, isActorValid, InvertedPositionConstraint, getAllocatedSize, setActorVisible, ensureGlassAllocated } from './utils.js';

import { Logger } from './logger.js';

// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 10;
// Inward padding for corner rounding
const CORNER_PADDING = 3;

interface WindowState {
  windowActor: Meta.WindowActor;
  // The window's own content/surface actor (the actual client texture). Cached here
  // because windowActor.get_first_child() stops pointing at it once baseActor is
  // inserted below it in _setupWindow — re-deriving it via get_first_child() later
  // (as _updateWindowOpacities/_cleanupState used to) silently targets the wrong actor.
  surfaceActor: Clutter.Actor;
  bgActor: St.Widget;
  clipBox: St.Widget;
  bgClone: InstanceType<typeof UnpickableClone>;
  windowsContainer: Clutter.Actor;
  clones: Map<Meta.WindowActor, Clutter.Actor>;
  effect: LiquidEffect;
  // Unblurred base background, used to reveal the true corners (see InverseCornerEffect below).
  baseActor: St.Widget;
  baseClone: InstanceType<typeof UnpickableClone>;
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
}

export class ApplicationManager {
  private extensionPath: string;
  private _states: Map<Meta.WindowActor, WindowState>;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private _settingsSignals: number[];
  private _frameSyncId: number;
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
  private static readonly DEBUG_FOCUS_LOG_FRAME_COUNT = 8;
  private _debugArmSignals: { obj: any, id: number }[] = [];
  // Windows whose clone container is currently NOT anchored at screen (0,0).
  // Logged on entry and exit only, so a persistent fault costs two lines
  // rather than 60 per second.
  private _displacedContainers: Set<Clutter.Actor> = new Set();

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

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this._states = new Map();
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._windowCreatedId = 0;
    this._restackedId = 0;
  }

  setup() {
    this._logger.log("[Liquid Glass] ApplicationManager setup starting...");
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

  cleanup() {
    if (this._windowCreatedId) {
      global.display.disconnect(this._windowCreatedId);
      this._windowCreatedId = 0;
    }

    if (this._restackedId) {
      global.display.disconnect(this._restackedId);
      this._restackedId = 0;
    }

    for (const sig of this._debugArmSignals) {
      try { sig.obj.disconnect(sig.id); } catch (e) { }
    }
    this._debugArmSignals = [];
    this._displacedContainers.clear();

    this._settingsSignals.forEach(id => this._settings.disconnect(id));
    this._settingsSignals = [];

    this._removeAllEffects();
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: () => void) => {
      let id = this._settings.connect(`changed::${key}`, callback);
      this._settingsSignals.push(id);
    };

    connectSetting('enable-application-glass', () => {
      this._logger.log("[Liquid Glass] enable-application-glass setting changed to: " + this._isEffectEnabled());
      if (this._isEffectEnabled())
        this._applyEffects();
      else
        this._removeAllEffects();
    });

    // Apply to every normal/dialog window, bypassing the whitelist entirely.
    connectSetting('application-glass-all-windows', () => this._syncWhitelist());
    // Opacity of the window's own content layer, so the glass underneath is visible through it.
    connectSetting('application-content-opacity', () => this._updateWindowOpacities());
    connectSetting('application-window-whitelist', () => this._syncWhitelist());
    connectSetting('application-tint-color', () => this._updateEffectParams());
    connectSetting('application-tint-strength', () => this._updateEffectParams());
    connectSetting('application-blur-radius', () => this._updateEffectParams());
    connectSetting('application-corner-radius', () => this._updateEffectParams());
    connectSetting('application-brightness', () => this._updateEffectParams());
    connectSetting('application-contrast', () => this._updateEffectParams());
    connectSetting('application-saturation', () => this._updateEffectParams());
  }

  _getContentOpacity(): number {
    return this._settings.get_double('application-content-opacity');
  }

  _updateWindowOpacities() {
    const targetOpacity = Math.round(this._getContentOpacity() * 255);
    this._logger.log("[Liquid Glass] Updating window content opacities to: " + targetOpacity);
    for (let state of this._states.values()) {
      // Use the cached reference, NOT windowActor.get_first_child() — after
      // _setupWindow inserts baseActor below it, get_first_child() returns
      // baseActor instead of the real surface, so it stopped being live-updated.
      if (isActorValid(state.surfaceActor)) {
        state.surfaceActor.opacity = targetOpacity;
      }
    }
  }

  _isEffectEnabled(): boolean {
    const enabled = this._settings.get_boolean('enable-application-glass');
    return enabled;
  }

  _getWhitelist(): string[] {
    let whitelist = this._settings.get_strv('application-window-whitelist');
    return whitelist;
  }

  _windowMatchesWhitelist(metaWindow: Meta.Window): boolean {
    const whitelist = this._getWhitelist();
    const appName = metaWindow.get_wm_class();
    if (whitelist.length === 0) {
      return false;
    }

    let ret = !!appName && whitelist.includes(appName);
    if (!ret) {
      this._logger.log("[Liquid Glass] window is not in whitelist. name = " + appName);
    } else {
      this._logger.log("[Liquid Glass] window is in whitelist. name = " + appName);
    }
    return ret;
  }

  _shouldApplyToWindow(windowActor: Meta.WindowActor): boolean {
    if (!this._isEffectEnabled()) {
      return false;
    }

    const metaWindow = windowActor.get_meta_window();
    if (!metaWindow) {
      return false;
    }

    // "Apply to all windows" bypasses the whitelist, but is still restricted to
    // normal/dialog windows so we never touch desktop backgrounds, panels, etc.
    const applyAll = this._settings.get_boolean('application-glass-all-windows');
    if (applyAll) {
      const windowType = metaWindow.get_window_type();
      const isNormal = windowType === Meta.WindowType.NORMAL ||
        windowType === Meta.WindowType.DIALOG ||
        windowType === Meta.WindowType.MODAL_DIALOG;
      if (!isNormal) {
        this._logger.log(`[Liquid Glass] window "${metaWindow.get_title()}" has special type ${windowType}, skipping...`);
        return false;
      }
      return true;
    }

    return this._windowMatchesWhitelist(metaWindow);
  }

  _applyEffects() {
    this._logger.log("[Liquid Glass] _applyEffects called");
    this._buildForExistingWindows();
    this._startFrameSync();
  }

  _removeAllEffects() {
    if (this._frameSyncId) {
      if (global.compositor?.get_laters) {
        global.compositor.get_laters().remove(this._frameSyncId);
      }
      this._frameSyncId = 0;
    }

    if (this._rebuildFollowupLaterId) {
      if (global.compositor?.get_laters) {
        global.compositor.get_laters().remove(this._rebuildFollowupLaterId);
      }
      this._rebuildFollowupLaterId = 0;
    }

    for (let state of this._states.values())
      this._cleanupState(state);

    this._states.clear();
    this._rebuildQueued = false;
  }

  _syncWhitelist() {
    if (!this._isEffectEnabled()) {
      this._removeAllEffects();
      return;
    }

    for (let [actor, state] of [...this._states.entries()]) {
      if (!this._shouldApplyToWindow(actor)) {
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

  _updateEffectParams() {
    let tintColorStr = this._settings.get_string('application-tint-color');
    let tintStrength = this._settings.get_double('application-tint-strength');
    let blurRadius = this._settings.get_int('application-blur-radius');
    let cornerRadius = this._settings.get_double('application-corner-radius');
    let brightness = this._settings.get_double('application-brightness');
    let contrast = this._settings.get_double('application-contrast');
    let saturation = this._settings.get_double('application-saturation');

    for (let state of this._states.values()) {
      state.effect.setTintColor(...this._hexToColorArray(tintColorStr));
      state.effect.setTintStrength(tintStrength);
      state.effect.setCornerRadius(cornerRadius);
      state.radiusScaleApplied = 1;
      state.effect.setBlurRadius(blurRadius);
      state.effect.setBrightness(brightness);
      state.effect.setContrast(contrast);
      state.effect.setSaturation(saturation);
      state.roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
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
    return SHADER_PADDING;
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
    if (this._frameSyncId === 0)
      this._frameTick();
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

    if (!this._shouldApplyToWindow(windowActor))
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
    surfaceActor.opacity = Math.round(this._getContentOpacity() * 255);

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

    let baseClone = new UnpickableClone({
      source: Main.layoutManager._backgroundGroup,
    });
    baseClone.set_name('lgw-base-wallpaper-clone');
    if (monitor) {
      baseClone.set_size(monitor.width, monitor.height);
    }
    baseActor.add_child(baseClone);

    let baseWindowsContainer = new Clutter.Actor();
    baseWindowsContainer.set_name('lgw-base-windows');
    baseActor.add_child(baseWindowsContainer);

    let bgClone = new UnpickableClone({
      source: Main.layoutManager._backgroundGroup,
    });
    bgClone.set_name('lgw-bg-wallpaper-clone');
    if (monitor) {
      bgClone.set_size(monitor.width, monitor.height);
    }
    clipBox.add_child(bgClone);

    let effect = new LiquidEffect({
      extensionPath: this.extensionPath,
      settings: this._settings,
      logger: this._logger,
    } as any);

    let tintColorStr = this._settings.get_string('application-tint-color');
    let tintStrength = this._settings.get_double('application-tint-strength');
    let cornerRadius = this._settings.get_double('application-corner-radius');
    let blurRadius = this._settings.get_int('application-blur-radius');
    let brightness = this._settings.get_double('application-brightness');
    let contrast = this._settings.get_double('application-contrast');
    let saturation = this._settings.get_double('application-saturation');

    effect.setPadding(SHADER_PADDING);
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
    effect.setShadowMaxRadius(SHADER_PADDING);
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
    roundingEffect.setInset(this._cornerOverlayInset());

    cornerOverlay.add_effect(roundingEffect);
    windowActor.add_child(cornerOverlay);

    const createConstraint = () => new InvertedPositionConstraint({
      source: windowActor,
      offset_x: -SHADER_PADDING,
      offset_y: -SHADER_PADDING
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

    windowActor.connect('destroy', () => {
      this._cleanupState(state);
      this._states.delete(windowActor);
      this._rebuildAllClones();
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

    const cornerRadius = this._settings.get_double('application-corner-radius');
    state.effect.setCornerRadius(cornerRadius * s);
    state.roundingEffect.setRadius((cornerRadius + CORNER_PADDING) * s);
  }

  _syncState(state: WindowState) {
    let actor = state.windowActor;
    if (!actor || !actor.get_stage() || !actor.mapped) {
      state.bgActor.visible = false;
      state.baseActor.visible = false;
      state.cornerOverlay.visible = false;
      return;
    }

    const metaWin = actor.get_meta_window();
    if (!metaWin) return;

    // [PERF] Single flag, see LiquidEffect.DRAG_PERF_MODE_ENABLED — no-op
    // (both calls below become no-ops internally) unless that's true.
    // "grabbed AND this window has focus" is the proxy for "this window is
    // the one currently being dragged" (GNOME 50 / Meta 18 removed
    // get_grab_op() and get_grab_window()).
    const isDraggingThisWindow = global.display.is_grabbed() && global.display.get_focus_window() === metaWin;
    state.effect.beginBatch();
    try {
      this._syncStateInner(state, actor, metaWin, isDraggingThisWindow);
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
  _syncStateInner(state: WindowState, actor: Meta.WindowActor, metaWin: Meta.Window, isDraggingThisWindow: boolean) {
    state.effect.setFastMode(isDraggingThisWindow);

    // PERFORMANCE: Only sync windows on the current active workspace.
    const workspaceManager = global.workspace_manager;
    const activeWorkspace = workspaceManager.get_active_workspace();
    const winWorkspace = metaWin.get_workspace();
    if (winWorkspace && winWorkspace !== activeWorkspace) {
      setActorVisible(state.bgActor, false);
      setActorVisible(state.baseActor, false);
      setActorVisible(state.cornerOverlay, false);
      return;
    }

    if (this._debugFocusLogFrames > 0) this._logFocusDebugInfo(state);

    const rect = metaWin.get_frame_rect();
    const bufferRect = metaWin.get_buffer_rect();

    if (!rect || !bufferRect || rect.width <= 0 || rect.height <= 0) {
      setActorVisible(state.bgActor, false);
      setActorVisible(state.baseActor, false);
      setActorVisible(state.cornerOverlay, false);
      return;
    }

    setActorVisible(state.bgActor, true);
    setActorVisible(state.baseActor, true);

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
    const baseActorW = visW + (SHADER_PADDING * 2);
    const baseActorH = visH + (SHADER_PADDING * 2);
    this._applyCounterScale(state.baseActor, actor, frameDX - SHADER_PADDING, frameDY - SHADER_PADDING, baseActorW, baseActorH);

    // Glass background (blurred) expanded by padding.
    const bgW = visW + (SHADER_PADDING * 2);
    const bgH = visH + (SHADER_PADDING * 2);
    const localX = frameDX - SHADER_PADDING;
    const localY = frameDY - SHADER_PADDING;

    this._applyCounterScale(state.bgActor, actor, localX, localY, bgW, bgH);

    state.clipBox.set_position(0, 0);
    state.clipBox.set_size(bgW, bgH);

    // Give containers a real, non-zero size matching their clipping bounds
    state.windowsContainer.set_size(bgW, bgH);
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

    this._checkContainerAnchor(state);

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
    const [pivotFx, pivotFy] = actor.get_pivot_point();
    const [actorW, actorH] = getAllocatedSize(actor);
    const pivotPxX = (Number.isFinite(pivotFx) ? pivotFx : 0) * (Number.isFinite(actorW) ? actorW : 0);
    const pivotPxY = (Number.isFinite(pivotFy) ? pivotFy : 0) * (Number.isFinite(actorH) ? actorH : 0);

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
    state.constraints.base.setOffset(offsetX, offsetY);
    state.constraints.baseWindows.setOffset(offsetX, offsetY);

    // ▼ 個別ウィンドウのクローン同期 (translation_x/yを使用) ▼
    // Sync blurred clones
    for (let [src, clone] of state.clones.entries()) {
      if (!isActorValid(src) || !src.visible || !src.mapped) {
        if (isActorValid(clone)) setActorVisible(clone, false);
        this._clearCloneAnomaly(clone);
        continue;
      }
      if (isActorValid(clone)) {
        setActorVisible(clone, true);

        // 実際のプロパティ(x,y)は0,0に固定し、描画オフセットのみで配置する
        if (clone.x !== 0 || clone.y !== 0) clone.set_position(0, 0);
        clone.translation_x = src.x;
        clone.translation_y = src.y;

        clone.set_size(src.width, src.height);
        clone.set_scale(src.scale_x, src.scale_y);
        clone.opacity = src.opacity;

        this._checkCloneAnomaly(clone, src, 'blurred');
      }
    }

    // Sync base clones (unblurred)
    for (let [src, clone] of state.baseClones.entries()) {
      if (!isActorValid(src) || !src.visible || !src.mapped) {
        if (isActorValid(clone)) setActorVisible(clone, false);
        this._clearCloneAnomaly(clone);
        continue;
      }
      if (isActorValid(clone)) {
        setActorVisible(clone, true);

        if (clone.x !== 0 || clone.y !== 0) clone.set_position(0, 0);
        clone.translation_x = src.x;
        clone.translation_y = src.y;

        clone.set_size(src.width, src.height);
        clone.set_scale(src.scale_x, src.scale_y);
        clone.opacity = src.opacity;

        this._checkCloneAnomaly(clone, src, 'base');
      }
    }

    // Sync corner overlays
    setActorVisible(state.cornerOverlay, true);

    const baseW = visW + (SHADER_PADDING * 2);
    const baseH = visH + (SHADER_PADDING * 2);

    this._applyCounterScale(state.cornerOverlay, actor, frameDX - SHADER_PADDING, frameDY - SHADER_PADDING, baseW, baseH);

    state.cornerOverlayClone.set_position(0, 0);
    state.cornerOverlayClone.set_size(baseW, baseH);

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

  _frameTick() {
    for (let state of this._states.values()) {
      try {
        const metaWin = state.windowActor?.get_meta_window?.();
        // Skip this window only — never return, or the reschedule at the end
        // is missed and the whole per-frame sync chain stops permanently.
        if (!metaWin) continue;
        // bgActor / baseActor / cornerOverlay are direct children of the
        // window actor, which Mutter flags NO_LAYOUT — so they are stage
        // relayout-queue boundary actors exactly like a dock/menu glass
        // root, and can be stranded the same way. See
        // ensureGlassAllocated().
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

    this._frameSyncId = global.compositor.get_laters().add(
      Meta.LaterType.BEFORE_REDRAW,
      () => {
        this._frameTick();
        return false;
      }
    );
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
  _checkContainerAnchor(state: WindowState) {
    const container = state.windowsContainer;
    if (!isActorValid(container)) return;

    let x = NaN, y = NaN;
    try { [x, y] = container.get_transformed_position(); } catch (e) { return; }

    const displaced = !Number.isFinite(x) || !Number.isFinite(y) ||
      Math.abs(x) > 1 || Math.abs(y) > 1;
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
