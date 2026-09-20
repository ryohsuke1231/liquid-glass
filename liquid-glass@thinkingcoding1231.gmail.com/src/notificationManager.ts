// src/notificationManager.ts
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';
import { StageContrastSampler, AdaptiveContrastConfig } from './contrastSampler.js';
import Gio from 'gi://Gio';
import {
  UnpickableActor,
  UILayerSampler,
  WindowCloneManager,
  reportFrameLoopError,
  ensureGlassAllocated,
  getTransformedRect,
  resolveMonitorGeometry,
  isFrameSyncFrozen,
  setClipIfChanged,
  syncGlassCaptureClip,
  resolveCrossFade,
  adaptiveColorTweener,
} from './utils.js';

import { Logger } from './logger.js';


// ========== Configuration Parameters (Defaults, overridden by settings) ==========
const SHADER_PADDING = 20;

interface CustomBannerActor extends St.Widget {
  _colorTweenId?: number;
  _currentTargetColor?: string;
}

export class NotificationManager {
  private extensionPath: string;
  private _settings: Gio.Settings;
  private _logger: Logger;
  private tray: St.Widget;

  private currentBanner: St.Widget | null = null;

  // Full-screen FBO actor hierarchy (matches dockManager pattern)
  //   bgActor (full monitor, no effect)
  //     └─ liquidBox  ← LiquidEffect with built-in dual-Kawase blur
  //          ├─ _cloneContainer ← WindowCloneManager + UILayerSampler deposits here
  //          └─ dummyBreaker (prevents BMS black-screen optimization bug)
  private bgActor: Clutter.Actor | null = null;
  private liquidBox: Clutter.Actor | null = null;
  private _cloneContainer: Clutter.Actor | null = null;
  private effect: LiquidEffect | null = null;

  private _windowCloneManager: WindowCloneManager | null = null;
  private _uiSampler: UILayerSampler | null = null;

  private _signals: number[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  // [FIX] Set by cleanup() before anything that can throw. Read by the
  // per-frame BEFORE_REDRAW tick so an orphaned chain stops itself even if
  // cleanup() never reached its laterRemove(). See the note in frameTick().
  private _torndown: boolean = false;
  private _isEffectActive: boolean;

  private _bannerIdleId = 0;
  private _pendingBanner: St.Widget | null = null;
  private _bannerGeneration = 0;
  private _originalBannerOffset = 0;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _contrastSampler: StageContrastSampler;
  private _adaptiveConfig: typeof AdaptiveContrastConfig;
  private _adaptiveTimerId: number;
  private _adaptiveInFlight: boolean;
  private _styledActors: Map<Clutter.Actor, string>;

  private _glassExpand: number;
  private _baseTint: number;
  private _currentTint: number;
  private _notificationYOffset: number;

  private _isFirstAdaptiveRun: boolean = true;

  constructor(extensionPath: string, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this._settings = settings;
    this._logger = logger;
    this.tray = Main.messageTray;

    this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;

    this._contrastSampler = new StageContrastSampler();
    this._adaptiveConfig = {
      ...AdaptiveContrastConfig,
      enabled: true,
      samplePerElement: false,
      sampleIntervalMs: 400,
    };
    this._adaptiveTimerId = 0;
    this._adaptiveInFlight = false;
    this._styledActors = new Map();

    this._glassExpand = 12;
    this._baseTint = 0.08;
    this._currentTint = 0.08;
    this._notificationYOffset = 10;
  }

  setup() {
    if (!this._settings) return;
    this._bindSettings();

    if (this._settings.get_boolean('enable-notification-glass')) {
      this._applyEffect();
    }
  }

  // Utility: Convert HEX color string to normalized RGB array
  _hexToColorArray(hex: string): [number, number, number] {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
      return [1.0, 1.0, 1.0];
    let r = parseInt(hex.slice(1, 3), 16) / 255.0;
    let g = parseInt(hex.slice(3, 5), 16) / 255.0;
    let b = parseInt(hex.slice(5, 7), 16) / 255.0;
    return [r, g, b];
  }

  _bindSettings() {
    const connectSetting = (key: string, callback: Function) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };

    connectSetting('enable-notification-glass', () => {
      let enabled = this._settings.get_boolean('enable-notification-glass');
      if (enabled && !this._isEffectActive) this._applyEffect();
      else if (!enabled && this._isEffectActive) this._removeEffect();
    });

    connectSetting('notification-tint-color', () => {
      if (this.effect && this._isEffectActive) {
        let colorArray = this._hexToColorArray(this._settings.get_string('notification-tint-color'));
        this.effect.setTintColor(...colorArray);
      }
    });

    connectSetting('notification-tint-strength', () => {
      if (this.effect && this._isEffectActive) {
        this._baseTint = this._settings.get_double('notification-tint-strength');
        this._currentTint = this._baseTint;
        this.effect.setTintStrength(this._baseTint);
      }
    });

    connectSetting('notification-blur-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setBlurRadius(this._settings.get_int('notification-blur-radius'));
      }
    });

    connectSetting('notification-corner-radius', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setCornerRadius(this._settings.get_double('notification-corner-radius'));
      }
    });

    connectSetting('notification-glass-expand', () => {
      if (this._isEffectActive) {
        this._glassExpand = this._settings.get_int('notification-glass-expand');
      }
    });

    // Brightness / Saturation / Contrast — dynamic application from settings
    connectSetting('notification-brightness', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setBrightness(this._settings.get_double('notification-brightness'));
      }
    });

    connectSetting('notification-saturation', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setSaturation(this._settings.get_double('notification-saturation'));
      }
    });

    connectSetting('notification-contrast', () => {
      if (this.effect && this._isEffectActive) {
        this.effect.setContrast(this._settings.get_double('notification-contrast'));
      }
    });

    connectSetting('notification-enable-adaptive-text-color', () => {
      this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
    });

    connectSetting('notification-sample-interval-ms', () => {
      this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
    });

    connectSetting('notification-y-offset', () => {
      this._notificationYOffset = this._settings.get_int('notification-y-offset');
    });
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    // @ts-expect-error: _bannerBin is an internal property
    let bannerBin = this.tray._bannerBin;
    if (!bannerBin) {
      this._logger.error('[Liquid Glass] _bannerBin is not found. GNOME internal structure might have changed.');
      return;
    }

    this._isEffectActive = true;

    // Apply settings initially
    this._adaptiveConfig.enabled = this._settings.get_boolean('notification-enable-adaptive-text-color');
    this._adaptiveConfig.sampleIntervalMs = this._settings.get_int('notification-sample-interval-ms');
    this._glassExpand = this._settings.get_int('notification-glass-expand');
    this._baseTint = this._settings.get_double('notification-tint-strength');
    this._currentTint = this._baseTint;
    this._notificationYOffset = this._settings.get_int('notification-y-offset');

    // Listen for new notifications
    this._signals.push(bannerBin.connect('child-added', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor') return;

      if (this._bannerIdleId) GLib.Source.remove(this._bannerIdleId);
      this._pendingBanner = actor;
      this._bannerIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._bannerIdleId = 0;
        this._pendingBanner = null;
        // A queued setup may outlive the notification or the effect toggle.
        if (!this._isEffectActive || actor.get_parent() !== bannerBin)
          return GLib.SOURCE_REMOVE;
        if (actor !== this.currentBanner) {
          this._cleanupCurrentBanner();
          this.currentBanner = actor;
          this._setupBannerEffect(actor);
        }
        return GLib.SOURCE_REMOVE;
      });
    }));

    this._signals.push(bannerBin.connect('child-removed', (container, actor: St.Widget) => {
      if (actor === this.bgActor || actor.get_name?.() === 'liquid-glass-bg-actor') return;
      if (actor === this._pendingBanner) {
        if (this._bannerIdleId) GLib.Source.remove(this._bannerIdleId);
        this._bannerIdleId = 0;
        this._pendingBanner = null;
      }
      if (actor === this.currentBanner) this._cleanupCurrentBanner();
    }));

    // @ts-expect-error
    if (this.tray._banner) {
      // @ts-expect-error
      this.currentBanner = this.tray._banner;
      // @ts-expect-error
      this._setupBannerEffect(this.tray._banner);
    }
  }

  _setupBannerEffect(targetActor: St.Widget) {
    targetActor.add_style_class_name('liquid-glass-transparent');

    // @ts-expect-error
    if (this.tray._bannerBin) {
      // @ts-expect-error
      this._originalBannerOffset = this.tray._bannerBin.translation_y;
      // @ts-expect-error: shell-owned container
      this.tray._bannerBin.translation_y = this._originalBannerOffset + this._notificationYOffset;
    }

    // ── 1. bgActor: full monitor, no effect ──────────────────────────────────
    this.bgActor = new UnpickableActor();
    this.bgActor.set_name('liquid-glass-bg-actor');
    this.bgActor.hide();
    this.bgActor.set_size(1.0, 1.0);
    this.bgActor.set_pivot_point(0.0, 0.0);

    // ── 2. liquidBox: outer layer — LiquidEffect with built-in dual-Kawase blur ─
    this.liquidBox = new UnpickableActor();
    this.liquidBox.set_name('liquid-box');
    this.liquidBox.set_clip_to_allocation(true);
    this.bgActor.add_child(this.liquidBox);

    // dummyBreaker: prevents BMS black-screen optimization bug
    let dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name('optimization-breaker');
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    this.liquidBox.add_child(dummyBreaker);

    // ── 3. _cloneContainer: sub-container inside liquidBox ────────────────────
    this._cloneContainer = new UnpickableActor();
    this._cloneContainer.set_name('clone-container');
    this.liquidBox.add_child(this._cloneContainer);

    // ── Find the bannerBin's ancestor that is a direct child of uiGroup ──────
    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    let bannerRoot: Clutter.Actor = bannerBin ?? targetActor;
    while (bannerRoot.get_parent() && bannerRoot.get_parent() !== Main.layoutManager.uiGroup) {
      const p = bannerRoot.get_parent();
      if (!p) break;
      bannerRoot = p;
    }

    // Insert bgActor below the notification root in uiGroup to prevent recursive
    // clone loops (same pattern as dockManager / uiManager)
    if (bannerRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(this.bgActor, bannerRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(this.bgActor);
    }

    // ── 4. Read effect parameters from settings ───────────────────────────────
    let blurRadius = this._settings.get_int('notification-blur-radius');
    let tintColorStr = this._settings.get_string('notification-tint-color');
    let cornerRadius = this._settings.get_double('notification-corner-radius');
    let tintStrength = this._settings.get_double('notification-tint-strength');
    let brightness = this._settings.get_double('notification-brightness');
    let saturation = this._settings.get_double('notification-saturation');
    let contrast = this._settings.get_double('notification-contrast');
    this._baseTint = tintStrength;

    // LiquidEffect on liquidBox (includes built-in dual-Kawase blur)
    this.effect = new LiquidEffect({ extensionPath: this.extensionPath, settings: this._settings, owner: 'notification' } as any);
    this.effect.setPadding(SHADER_PADDING);
    this.effect.setTintColor(...this._hexToColorArray(tintColorStr));
    this.effect.setTintStrength(this._baseTint);
    this.effect.setCornerRadius(cornerRadius);
    this.effect.setIsDock(false);
    this.effect.setBrightness(brightness);
    this.effect.setSaturation(saturation);
    this.effect.setContrast(contrast);
    this.effect.setBlurRadius(blurRadius);
    this.liquidBox.add_effect(this.effect);

    // ── 5. WindowCloneManager + UILayerSampler ────────────────────────────────
    this._windowCloneManager = new WindowCloneManager(this.liquidBox, this._cloneContainer, 'lg-notification');
    this._uiSampler = new UILayerSampler(
      this.bgActor,
      this.liquidBox,
      [bannerRoot, global.windowGroup, global.window_group],
      this._cloneContainer,
      'notification'
    );

    // First valid geometry sync makes the glass visible.

    // Initial clone build (also applies liquid-glass mutual exclusions)
    this._buildClones();

    // ── 7. Frame-render loop ──────────────────────────────────────────────────
    const frameLaterType = Meta.LaterType.BEFORE_REDRAW;
    const frameTick = () => {
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
      if (this._torndown) return GLib.SOURCE_REMOVE;
      if (!this.bgActor || !this.currentBanner) return GLib.SOURCE_REMOVE;

      // [DIAG] See setFrameSyncFrozen() in utils.ts. Reschedules but does
      // nothing, so the cost of this poll can be measured directly.
      if (isFrameSyncFrozen()) {
        this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
        return GLib.SOURCE_REMOVE;
      }

      // The reschedule below must stay reachable even if the sync throws —
      // see the comment on DockManager's frameTick.
      // Repair the subtree if Clutter has stopped allocating it. Sampled
      // here, at the top of the tick, because the previous frame's relayout
      // has settled by now and this frame's sync has not dirtied anything
      // yet. See ensureGlassAllocated().
      ensureGlassAllocated(this.bgActor);
      try {
        this._syncGeometry();

        // Hover tint animation (notification-specific behaviour preserved)
        let isHovered = this.currentBanner.hover;
        let targetTint = isHovered ? (this._baseTint + 0.1) : this._baseTint;
        if (Math.abs(this._currentTint - targetTint) > 0.001) {
          this._currentTint += (targetTint - this._currentTint) * 0.1;
          this.effect?.setTintStrength(this._currentTint);
        }
      } catch (e) {
        reportFrameLoopError('NotificationManager', e);
      }

      this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
      return GLib.SOURCE_REMOVE;
    };

    this._frameSyncId = this._laterAdd(frameLaterType, frameTick);
    this._isFirstAdaptiveRun = true;
    this._startAdaptiveColorSampling();
  }

  // ── Geometry synchronisation ────────────────────────────────────────────────
  // Called every frame. Uses full-screen FBO architecture so that BMS coordinate
  // assumptions are satisfied (all actors cover the entire monitor).
  _syncGeometry() {
    if (!this.bgActor || !this.currentBanner) return;

    // Keep the offset on the same parent GNOME animates, never on the glass alone.
    // @ts-expect-error: shell-owned container
    this.tray._bannerBin.translation_y = this._originalBannerOffset + this._notificationYOffset;

    // GNOME animates opacity and scale on _bannerBin, not on the banner.
    // Both the origin and size must include that ancestor transform.
    const [absX, absY, w, h] = getTransformedRect(this.currentBanner);
    const opacity = this.currentBanner.get_paint_opacity();
    if (!this.currentBanner.mapped || !this.tray.visible || opacity === 0 ||
        ![absX, absY, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
      this.bgActor.hide();
      return;
    }
    this.bgActor.opacity = opacity;
    this.bgActor.show();

    const bgW = w + this._glassExpand * 2 + SHADER_PADDING * 2;
    const bgH = h + this._glassExpand * 2 + SHADER_PADDING * 2;
    const bgX_abs = absX - this._glassExpand - SHADER_PADDING;
    const bgY_abs = absY - this._glassExpand - SHADER_PADDING;
    const monitor = resolveMonitorGeometry([this.currentBanner, this.tray]);

    let monitorX = monitor?.x ?? 0;
    let monitorY = monitor?.y ?? 0;
    let screenW = Math.max(1, monitor?.width ?? 1);
    let screenH = Math.max(1, monitor?.height ?? 1);

    // Monitor-local coordinates (shader uses these)
    let localBgX = bgX_abs - monitorX;
    let localBgY = bgY_abs - monitorY;

    // ── Update actors only when geometry actually changed ────────────────────
    if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
      this._lastBgX !== bgX_abs || this._lastBgY !== bgY_abs ||
      this._lastScreenW !== screenW || this._lastScreenH !== screenH) {

      // bgActor: full monitor size, positioned at monitor origin
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');
      this.bgActor.set_position(monitorX, monitorY);
      this.bgActor.set_size(screenW, screenH);
      this.bgActor.remove_transition('size');
      this.bgActor.remove_transition('position');

      // liquidBox fills the entire bgActor
      this.liquidBox?.set_position(0, 0);
      this.liquidBox?.set_size(screenW, screenH);

      // Soft clip — limits GPU work to the notification area + generous margin
      const CLIP_PADDING = 200;
      this.liquidBox?.remove_clip();
      // [PERF] set_clip() queues a redraw unconditionally — see setClipIfChanged().
      setClipIfChanged(
        this.bgActor,
        localBgX - CLIP_PADDING, localBgY - CLIP_PADDING,
        bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2
      );

      const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
      this.effect?.setShadowMaxRadius(SHADOW_MAX_RADIUS);

      // Inform the shader of the full-screen resolution and where the
      // notification lives within the FBO (mirrors dockManager.setGlassGeometry)
      this.effect?.setResolution(screenW, screenH);
      this.effect?.setGlassGeometry(localBgX, localBgY, bgW, bgH);

      this._lastBgW = bgW; this._lastBgH = bgH;
      this._lastBgX = bgX_abs; this._lastBgY = bgY_abs;
      this._lastScreenW = screenW; this._lastScreenH = screenH;
    }

    // ── Sync clones every frame (dockManager pattern) ────────────────────────
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

  // Called once when the banner effect is first set up (and after monitor changes).
  // Applies mutual exclusions between multiple Liquid Glass bgActors, then
  // delegates clone construction to WindowCloneManager + UILayerSampler.
  _buildClones() {
    if (!this.bgActor) return;

    if (this._uiSampler) {
      for (let child of Main.layoutManager.uiGroup.get_children()) {
        if (child === this.bgActor) continue;
        let isLiquidBg = child.get_name?.() === 'liquid-glass-bg-actor' ||
          (typeof child.get_children === 'function' &&
            child.get_children().some((c: Clutter.Actor) => c.get_name?.() === 'liquid-box'));
        if (isLiquidBg) this._uiSampler.addExclusion(child);
      }
    }

    this._windowCloneManager?.rebuildClones();
    this._uiSampler?.rebindSelf();
    this._uiSampler?.refresh();
  }

  // ── Per-banner cleanup ──────────────────────────────────────────────────────
  _cleanupCurrentBanner() {
    this._bannerGeneration++;
    this._stopAdaptiveColorSampling();
    this._clearAdaptiveStyles();

    // @ts-expect-error
    if (this.currentBanner && this.tray._bannerBin) {
      // @ts-expect-error
      this.tray._bannerBin.translation_y = this._originalBannerOffset;
    }

    if (this.currentBanner) {
      this.currentBanner.remove_style_class_name('liquid-glass-transparent');
      this.currentBanner = null;
    }

    if (this._frameSyncId !== 0) {
      if (global.compositor?.get_laters) global.compositor.get_laters().remove(this._frameSyncId);
      this._frameSyncId = 0;
    }

    // DESTROY EFFECT FIRST (must happen before bgActor.destroy())
    if (this.effect) {
      this.effect.cleanup();
      this.effect = null;
    }

    // DESTROY ACTOR HIERARCHY — bgActor.destroy() cascades through
    // liquidBox → _cloneContainer and all their children.
    if (this.bgActor) {
      this.bgActor.destroy();
      this.bgActor = null;
    }
    this.liquidBox = null;
    this._cloneContainer = null;

    // Clean up managers (their destroy() guards against already-destroyed actors)
    this._uiSampler?.destroy();
    this._uiSampler = null;
    this._windowCloneManager?.destroy();
    this._windowCloneManager = null;

    // Reset cached geometry state
    this._lastBgW = undefined;
    this._lastBgH = undefined;
    this._lastBgX = undefined;
    this._lastBgY = undefined;
    this._lastScreenW = undefined;
    this._lastScreenH = undefined;

    this._isFirstAdaptiveRun = true;
  }

  // ── Effect remove / cleanup ─────────────────────────────────────────────────
  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;
    if (this._bannerIdleId) GLib.Source.remove(this._bannerIdleId);
    this._bannerIdleId = 0;
    this._pendingBanner = null;

    // @ts-expect-error
    let bannerBin = this.tray._bannerBin;
    for (let sigId of this._signals) {
      try { bannerBin.disconnect(sigId); } catch (e) { }
    }
    this._signals = [];

    this._cleanupCurrentBanner();
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

    this._teardownStep('frameSync', () => {
      if (this._frameSyncId !== 0) {
        if (global.compositor?.get_laters)
          global.compositor.get_laters().remove(this._frameSyncId);
        this._frameSyncId = 0;
      }
    });

    this._teardownStep('settingsSignals', () => {
      for (let sigId of this._settingsSignals) {
        try { this._settings.disconnect(sigId); } catch (e) { }
      }
      this._settingsSignals = [];
    });

    this._teardownStep('removeEffect', () => this._removeEffect());
  }

  // ── Adaptive text colour helpers (unchanged logic) ──────────────────────────

  _collectAdaptiveTextTargets(actor: Clutter.Actor | null = this.currentBanner, targets: Clutter.Actor[] = []): Clutter.Actor[] {
    if (!actor) return targets;
    return this._findAllTextActors(actor);
  }

  _setActorColor(actor: CustomBannerActor, color: string, skipAnimations = false, batchStart?: number) {
    if (!actor || typeof actor.set_style !== 'function') return;
    if (!this._styledActors.has(actor)) {
      this._styledActors.set(actor, actor.get_style() || '');
      actor.connect('destroy', () => {
        adaptiveColorTweener.cancel(actor);
        this._styledActors.delete(actor);
      });
    }
    if (actor._currentTargetColor === color) return;
    // A light<->dark flip used to be snapped here, because interpolating the
    // two in RGB passes through the background's own grey and the label
    // disappears mid-tween. _animateActorColor() now cross-dissolves that case
    // instead (see crossFadeColorAt() in utils.ts), so it is animated like any
    // other change.
    actor._currentTargetColor = color;
    this._animateActorColor(actor, color, 380, skipAnimations, batchStart);
  }

  _clearAdaptiveStyles() {
    for (const [actor, style] of this._styledActors.entries() as MapIterator<[CustomBannerActor, string]>) {
      if (actor && typeof actor.set_style === 'function') {
        adaptiveColorTweener.cancel(actor);
        actor._currentTargetColor = undefined;
        actor.remove_style_class_name('adaptive-text-transition');
        actor.remove_style_class_name('adaptive-color-light');
        actor.remove_style_class_name('adaptive-color-dark');
        actor.set_style(style);
      }
    }
    this._styledActors.clear();
  }

  _applyAdaptiveColorMap(colorMap: Map<Clutter.Actor, string>, skipAnimations = false) {
    if (!colorMap || colorMap.size === 0) return;
    // One timestamp for the whole map, so every label in the banner flips together.
    const batchStart = GLib.get_monotonic_time();
    for (const [actor, color] of colorMap.entries()) {
      this._setActorColor(actor as unknown as CustomBannerActor, color, skipAnimations, batchStart);
    }
  }

  _startAdaptiveColorSampling() {
    if (!this._adaptiveConfig.enabled) return;
    this._updateAdaptiveTextColors();

    if (this._adaptiveTimerId !== 0) return;

    this._adaptiveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._adaptiveConfig.sampleIntervalMs,
      () => {
        if (!this.currentBanner || !this.bgActor) {
          this._adaptiveTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._updateAdaptiveTextColors();
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  _stopAdaptiveColorSampling() {
    if (this._adaptiveTimerId !== 0) {
      GLib.source_remove(this._adaptiveTimerId);
      this._adaptiveTimerId = 0;
    }
  }

  _findAllTextActors(actor: Clutter.Actor, foundActors: Clutter.Actor[] = []) {
    if (!actor) return foundActors;

    if (actor instanceof St.Label || actor instanceof Clutter.Text || actor instanceof St.Button) {
      if (actor.visible) foundActors.push(actor);
    }

    let children = actor.get_children();
    for (let i = 0; i < children.length; i++) {
      this._findAllTextActors(children[i], foundActors);
    }
    return foundActors;
  }

  _updateAdaptiveTextColors() {
    if (!this._adaptiveConfig.enabled || this._adaptiveInFlight) return;

    let [absX, absY] = this.currentBanner?.get_transformed_position() ?? [0, 0];
    if (absY < 0) return;

    const targets = this._collectAdaptiveTextTargets();
    if (targets.length === 0) return;

    this._adaptiveInFlight = true;
    const generation = this._bannerGeneration;

    this._contrastSampler
      .chooseColorsForActors(targets, this._adaptiveConfig, this.currentBanner)
      .then(colorMap => {
        if (generation !== this._bannerGeneration || !this.currentBanner) return;
        this._applyAdaptiveColorMap(colorMap, this._isFirstAdaptiveRun);
        this._isFirstAdaptiveRun = false;
      })
      .catch(e => {
        this._logger.error(`[Liquid Glass] Notification adaptive color update failed: ${e}`);
      })
      .finally(() => {
        this._adaptiveInFlight = false;
      });
  }

  _hexToRgb(hex: string) {
    let bigint = parseInt(hex.replace('#', ''), 16);
    return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
  }

  _rgbToHex(r: number, g: number, b: number) {
    return '#' + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
  }

  _animateActorColor(actor: CustomBannerActor, targetHexColor: string, durationMs = 380,
    skipAnimations = false, batchStart?: number) {
    if (!actor || Object.keys(actor).length === 0) return;

    // NOT cancelled here: add() below reads the entry this may already have,
    // so that an interrupted tween restarts from the colour that is actually
    // on screen rather than from a theme node St has not re-resolved yet.
    // The snap path does cancel, because nothing should keep stepping after it.
    const originalStyle = (this._styledActors.get(actor) || '').trim();
    const stylePrefix = originalStyle ? `${originalStyle.replace(/;$/, '')}; ` : '';
    let themeNode = actor.get_theme_node();
    let startColor = themeNode.get_foreground_color();
    let targetRgb = this._hexToRgb(targetHexColor);

    const apply = (r: number, g: number, b: number, a: number) => {
      const rgba = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      try { actor.set_style(`${stylePrefix}color: ${rgba}; -st-icon-foreground-color: ${rgba};`); } catch (e) { }
    };

    if (skipAnimations) {
      adaptiveColorTweener.cancel(actor);
      try { actor.set_style(`${stylePrefix}color: ${targetHexColor}; -st-icon-foreground-color: ${targetHexColor};`); } catch (e) { }
      return;
    }

    const startRgb = { r: startColor.red, g: startColor.green, b: startColor.blue };
    const startAlpha = startColor.alpha / 255.0;

    // One shared frame-clock driver, one shared start time per batch — see
    // AdaptiveColorTweener in utils.ts for why this is not a per-actor timer.
    adaptiveColorTweener.add(actor, {
      startRgb, startAlpha,
      targetRgb, targetAlpha: 1.0,
      crossFade: resolveCrossFade(startRgb, targetRgb),
      durationMs,
      apply,
    }, batchStart);
  }

  _hasStyleClass(actor: St.Widget, className: string) {
    return typeof actor?.has_style_class_name === 'function' &&
      actor.has_style_class_name(className);
  }

  _laterAdd(laterType: Meta.LaterType, callback: GLib.SourceFunc) {
    return global.compositor?.get_laters?.().add(laterType, callback);
  }
}
