import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { BackdropGlass } from './rendering/backdropGlass.js';
import { reportFrameLoopError, Logger } from './logger.js';
import {
  ensureGlassAllocated, setClipIfChanged, isActorValid, placeScreenGlass, GLASS_SHADOW_MAX_RADIUS
} from './actors.js';
import {
  isFrameSyncFrozen, SAME_FRAME_WINDOW_US, startStageLoop, stopStageLoop, hexToColorArray
} from './animation.js';
import type { IconStyler } from './iconStyle/iconStyler.js';
import { MAX_GLASS_GROWTHS } from './rendering/glassRenderer.js';
import { addGrowthBar, removeGrowthBar, cornerReach, layoutGrowths, type GrowthBar } from './growthBars.js';

// Room around the glass rect for the shader's edge effects.
export const SHADER_PADDING = 20;
// How far past the glass (and the menus grown out of it) the dock glass draws, for its shadow.
const DOCK_CLIP_PADDING = 200;
// The setting a menu's BarGrowth asks with, which the dock answers by dock-menus-grow.
const MENUS_GROW_KEY = 'top-bar-menus-grow';

// The dock glass's look, from the dock-* settings, for every kind of dock.
const DOCK_MATERIAL: [string, (glass: BackdropGlass, settings: Gio.Settings) => void][] = [
  ['dock-tint-color', (g, s) => g.setTintColor(...hexToColorArray(s.get_string('dock-tint-color')))],
  ['dock-tint-strength', (g, s) => g.setTintStrength(s.get_double('dock-tint-strength'))],
  ['dock-blur-radius', (g, s) => g.setBlurRadius(s.get_int('dock-blur-radius'))],
  ['dock-corner-radius', (g, s) => g.setCornerRadius(s.get_double('dock-corner-radius'))],
  ['dock-brightness', (g, s) => g.setBrightness(s.get_double('dock-brightness'))],
  ['dock-contrast', (g, s) => g.setContrast(s.get_double('dock-contrast'))],
  ['dock-saturation', (g, s) => g.setSaturation(s.get_double('dock-saturation'))],
];

export function createDockGlass(extensionPath: string, settings: Gio.Settings, logger: Logger, owner: string): BackdropGlass {
  const glass = new BackdropGlass({ extensionPath, settings, logger, owner, outline: 'dock' } as any);
  glass.setPadding(SHADER_PADDING);
  for (const [, apply] of DOCK_MATERIAL) apply(glass, settings);
  glass.setIsDock(true);
  return glass;
}

/** Keeps the glass `glass()` returns, if any, in the dock's look. Returns the ids of the signals on `settings`. */
export function followDockMaterial(settings: Gio.Settings, glass: () => BackdropGlass | null): number[] {
  const ids = DOCK_MATERIAL.map(([key, apply]) => settings.connect(`changed::${key}`, () => {
    const current = glass();
    if (current) apply(current, settings);
  }));
  // The attachment is applied with the geometry on the next frame, which a redraw brings.
  for (const key of ['dock-attach-to-edge', 'dock-edge-radius'])
    ids.push(settings.connect(`changed::${key}`, () => glass()?.queue_redraw()));
  return ids;
}

/**
 * Grows `glass` out of `side` when the dock is `attached` (dock-attach-to-edge), flaring by `radius`. Returns `rect` (monitor-local, padded by SHADER_PADDING)
 * reaching that edge and the side, or `rect` unchanged and null while the dock floats.
 */
export function attachDockGlass(glass: BackdropGlass, attached: boolean, radius: number, rect: number[], side: DockSide,
  monitorW: number, monitorH: number): { rect: number[], side: DockSide | null } {
  glass.setAttachedEdge(attached ? side : 'none', radius);
  return attached
    ? { rect: attachRectToEdge(rect, side, monitorW, monitorH, SHADER_PADDING), side }
    : { rect, side: null };
}

export class DashManager implements GrowthBar {
  private extensionPath: string;
  private targetActor: St.Widget;
  private _settings: Gio.Settings;

  // Monitor-sized; see _syncDockGlass().
  private glass: BackdropGlass | null = null;

  private _lastScreenW: number | undefined;
  private _lastScreenH: number | undefined;

  private _glassExpand: number;

  private _signals: number[];
  private _settingsSignals: number[];
  private _frameSyncId: number;
  private _frameSignalId = 0;
  private _lastTickUs = 0;
  private _isEffectActive: boolean;

  private _originalStyle: string | undefined;
  private _currentMarginStyle: string | undefined;
  private _dockParent: St.Widget | null = null;

  private _lastAbsX: number | undefined;
  private _lastAbsY: number | undefined;
  private _lastTW: number | undefined;
  private _lastTH: number | undefined;
  private _stableDeltaW: number | undefined;
  private _stableDeltaH: number | undefined;
  private _lastBgW: number | undefined;
  private _lastBgH: number | undefined;
  private _lastBgX: number | undefined;
  private _lastBgY: number | undefined;

  private _lastBaseW: number | undefined;
  private _lastBaseH: number | undefined;

  // dock-margin-bottom, or 0 while the glass grows out of the screen edge.
  private _marginValue: number = 0;
  // Tracks the hide/show transition so the reason is logged once, not per frame.
  private _lastHidden: boolean | undefined;

  // What the last _syncGeometry() based the glass rect on; see
  // _syncGlassGeometryLive().
  private _liveRef: {
    actor: Clutter.Actor;
    rawX: number; rawY: number;
    rect: [number, number, number, number];
    // The edge the rect is attached to, if it is, and the monitor's size.
    side: DockSide | null; monitorW: number; monitorH: number;
  } | null = null;

  private _logger: Logger;

  // The menus grown out of the dock (the tray icons' menus Dock Tray puts in it), by the BarGrowth that holds each:
  // [x, y, w, h] on the stage and the radius of their free corners. The latest are drawn.
  private _growths = new Map<object, { rect: number[], radius: number }>();
  private _drewGrowths = false;
  // The glass rect last placed (monitor-local, padded) and the screen edge the dock is on.
  private _glassRect: number[] | null = null;
  private _side: DockSide | null = null;
  // dock-attach-to-edge, dock-edge-radius and dock-menus-grow, which the per-frame sync reads.
  private _attached = false;
  private _edgeRadius = 0;
  private _menusGrow = false;

  constructor(extensionPath: string, targetActor: St.Widget, settings: Gio.Settings, logger: Logger) {
    this.extensionPath = extensionPath;
    this.targetActor = targetActor;
    this._settings = settings;
    this._logger = logger;

    // Pixels added around the dock's own rect.
    this._glassExpand = 0;

    this._signals = [];
    this._settingsSignals = [];
    this._frameSyncId = 0;
    this._isEffectActive = false;
  }

  setup() {
    if (!this.targetActor || !this._settings) return;

    this._bindSettings();

    if (this._settings.get_boolean('enable-dock-glass')) {
      this._applyEffect();
    }
  }

  _bindSettings() {
    const connectSetting = (key, callback) => {
      let id = this._settings.connect(`changed::${key}`, callback.bind(this));
      this._settingsSignals.push(id);
    };
    this._readEdgeSettings();

    connectSetting('enable-dock-glass', () => {
      let enabled = this._settings.get_boolean('enable-dock-glass');
      if (enabled && !this._isEffectActive) {
        this._applyEffect();
      } else if (!enabled && this._isEffectActive) {
        this._removeEffect();
      }
    });

    connectSetting('dock-glass-expand', () => {
      if (this.glass && this._isEffectActive) {
        this._glassExpand = this._settings.get_int('dock-glass-expand');
        this.glass?.queue_redraw();
      }
    });

    const remargin = () => {
      if (this._isEffectActive) this._applyMargin();
      this._marginValue = this._effectiveMargin();
    };
    connectSetting('dock-margin-bottom', remargin);
    connectSetting('dock-edge-radius', () => this._readEdgeSettings());
    connectSetting('dock-menus-grow', () => {
      this._readEdgeSettings();
      this._growths.clear();
      if (this._glassRect) this._placeGlassRect(this._glassRect);
      this.glass?.queue_redraw();
    });
    connectSetting('dock-attach-to-edge', () => {
      this._readEdgeSettings();
      remargin();
    });

    this._settingsSignals.push(...followDockMaterial(this._settings, () => this.glass));
  }

  private _readEdgeSettings(): void {
    this._attached = this._settings.get_boolean('dock-attach-to-edge');
    this._edgeRadius = this._settings.get_double('dock-edge-radius');
    this._menusGrow = this._settings.get_boolean('dock-menus-grow');
  }

  private _effectiveMargin(): number {
    return this._attached ? 0 : this._settings.get_int('dock-margin-bottom') || 0;
  }

  // Moves the dock away from the screen edge it is closest to by
  // dock-margin-bottom.
  _applyMargin() {
    if (!this.targetActor) return;

    let marginBottom = this._effectiveMargin();

    let [w, h] = this.targetActor.get_size();
    let [x, y] = this.targetActor.get_transformed_position();

    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) monitorIndex = Main.layoutManager.primaryIndex;
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    let distLeft = x - monitor.x;
    let distRight = (monitor.x + monitor.width) - (x + w);
    let distTop = y - monitor.y;
    let distBottom = (monitor.y + monitor.height) - (y + h);
    let minEdge = Math.min(distLeft, distRight, distTop, distBottom);

    let marginStyle = '';
    if (minEdge === distBottom || minEdge === distTop) {
      if (minEdge === distBottom)
        marginStyle = `margin-bottom: ${marginBottom}px;`;
      else
        marginStyle = `margin-top: ${marginBottom}px;`;
    } else {
      if (minEdge === distRight)
        marginStyle = `margin-right: ${marginBottom}px;`;
      else
        marginStyle = `margin-left: ${marginBottom}px;`;
    }

    if (this._originalStyle === undefined) {
      this._originalStyle = this.targetActor.get_style() || '';
    }
    this._currentMarginStyle = marginStyle;
    this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
    // Dash to Dock keeps extra room on the edge side for the running dots; the attached glass already runs on to
    // the edge, so stylesheet.css takes most of that room away.
    if (this._attached) this.targetActor.add_style_class_name('liquid-glass-attached');
    else this.targetActor.remove_style_class_name('liquid-glass-attached');
  }

  _applyEffect() {
    if (this._isEffectActive) return;
    this._isEffectActive = true;

    this._lastScreenW = this._lastScreenH = undefined;
    this._lastBgW = this._lastBgH = undefined;
    this._lastBgX = this._lastBgY = undefined;
    this._lastBaseW = this._lastBaseH = undefined;
    this._lastAbsX = this._lastAbsY = undefined;
    this._lastTW = this._lastTH = undefined;
    this._stableDeltaW = this._stableDeltaH = undefined;
    this._lastHidden = undefined;

    this.targetActor.add_style_class_name('liquid-glass-transparent');

    this._dockParent = this.targetActor.get_parent() as St.Widget | null;
    if (this._dockParent) {
      this._dockParent.add_style_class_name('liquid-glass-transparent');
    }

    const glass = createDockGlass(this.extensionPath, this._settings, this._logger, 'dock');
    this.glass = glass;
    addGrowthBar(this);
    glass.set_size(1.0, 1.0);

    this._applyMargin();
    this._marginValue = this._effectiveMargin();
    this._glassExpand = this._settings.get_int("dock-glass-expand");

    let dockRoot = this.targetActor;
    while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
      let p = dockRoot.get_parent() as St.Widget | null;
      if (!p) break;
      dockRoot = p;
    }

    // Below the dock, so the glass reads the stage before the dock is drawn.
    if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
      Main.layoutManager.uiGroup.insert_child_below(glass, dockRoot);
    } else {
      Main.layoutManager.uiGroup.add_child(glass);
    }

    // Dash to Dock slides by relayout, so the frame tick sees last frame's
    // position; the paint-time hook corrects it.
    glass.setLiveGeometryHook(() => this._syncGlassGeometryLive());

    glass.show();

    // Follows the stage's own frames (startStageLoop()), so it costs nothing
    // while nothing changes. Errors are reported rate-limited instead of
    // logged every frame; SAME_FRAME_WINDOW_US keeps two stage views from
    // stepping it twice in one frame.
    let frameTick = () => {
      if (!this._isEffectActive || !this.glass || !this.targetActor.mapped) return;
      if (isFrameSyncFrozen()) return;

      const nowUs = GLib.get_monotonic_time();
      if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
      this._lastTickUs = nowUs;
      try {
        // Checked before this frame's sync dirties anything.
        ensureGlassAllocated(this.glass);
        this._syncGeometry();
      } catch (e) {
        reportFrameLoopError('DockManager', e);
      }
    };

    let startFrameSync = () => {
      if (this._frameSignalId !== 0) return;
      startStageLoop(this._frameSignalSlot, this._frameSlot, frameTick);
    };

    // The glass is the dock's sibling, so it stays up when the dock is
    // hidden as a whole (for instance over a fullscreen window).
    let mapSignalId = this.targetActor.connect('notify::mapped', () => {
      if (this.targetActor.mapped) {
        startFrameSync();
      } else {
        this._stopFrameSync();
        this._hideGlass();
      }
    });
    this._signals.push(mapSignalId);

    if (this.targetActor.mapped) {
      startFrameSync();
    }
  }

  // Runs at paint time (see GlassActor.setLiveGeometryHook()), when the
  // dock's allocation is current. _syncGeometry() keeps per-frame state and
  // must run once per frame, so only the glass rect's position is corrected
  // here, by how far the dock moved since the tick.
  _syncGlassGeometryLive() {
    const ref = this._liveRef;
    if (!ref || !this.glass) return;
    if (!ref.actor?.mapped) return;

    const [nx, ny] = ref.actor.get_transformed_position();
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

    let rect = [ref.rect[0] + (nx - ref.rawX), ref.rect[1] + (ny - ref.rawY), ref.rect[2], ref.rect[3]];
    // The dock's move must not lift the attached side off the edge.
    if (ref.side) rect = attachRectToEdge(rect, ref.side, ref.monitorW, ref.monitorH, SHADER_PADDING);
    this._placeGlassRect(rect);
  }

  _syncGeometry() {
    if (!this.glass || !this.targetActor || !this.targetActor.mapped) return;
    let bounds = this._readDockBounds();
    if (!bounds) return;
    let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
    if (monitorIndex < 0) {
      monitorIndex = Main.layoutManager.primaryIndex;
    }
    let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;

    const edges = dockEdges(bounds, monitor);
    bounds = this._stabilizeDockBounds(bounds, edges);
    const refActor = this._findReferenceActor(this.targetActor);
    if (refActor) bounds = balanceDockBounds(bounds, this._actorBounds(refActor), edges);
    bounds = this._applyDockMargin(bounds, monitor, edges);
    const { baseW, baseH } = bounds;

    if (baseW <= 9 || baseH <= 9) {
      this._hideGlass();
      return;
    }
    this.glass.show();
    this.glass.opacity = this.targetActor.opacity;
    this._syncDockVisibility(bounds, monitor);
    this._side = dockSide(edges);
    this._syncDockGlass(bounds, monitor, this._side);
  }

  private _actorBounds(actor: Clutter.Actor): DockBounds {
    const [baseW, baseH] = actor.get_size();
    const [absX, absY] = actor.get_transformed_position();
    return { absX, absY, baseW, baseH };
  }

  private _liveSource: { actor: any, rawX: number, rawY: number } | null = null;

  private _readDockBounds(): DockBounds | null {
    let sourceActor = this.targetActor;
    let children = this.targetActor.get_children() as St.Widget[];
    for (let i = 0; i < children.length; i++) {
      if (children[i].has_style_class_name('dash-background')) {
        children[i].opacity = 0;
        sourceActor = children[i];
      }
    }

    let [baseW, baseH] = sourceActor.get_size();
    let [absX, absY] = sourceActor.get_transformed_position();
    if (Number.isNaN(absX) || Number.isNaN(absY)) return null;
    // The uncorrected position, which _syncGlassGeometryLive() compares against.
    this._liveSource = { actor: sourceActor, rawX: absX, rawY: absY };
    const bounds = { absX, absY, baseW, baseH };
    return sourceActor === this.targetActor ? bounds : clipDockBounds(bounds, this._actorBounds(this.targetActor));
  }

  private _stabilizeDockBounds(bounds: DockBounds, edges: DockEdges): DockBounds {
    let { baseW, baseH } = bounds;
    const { minCenterDist, distTopCenter, distBottomCenter } = edges;
    if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
      let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);

      // The dock's thickness can jump by exactly the margin for a frame;
      // such a jump is ignored.
      if (isHorizontalDock) {
        if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1)
          baseH = this._lastBaseH;
      } else {
        if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1)
          baseW = this._lastBaseW;
      }
    }
    this._lastBaseW = baseW;
    this._lastBaseH = baseH;
    return { ...bounds, baseW, baseH };
  }

  private _applyDockMargin(bounds: DockBounds, monitor: DockMonitor | null, edges: DockEdges): DockBounds {
    const marginValue = this._marginValue || 0;
    if (!monitor || !(marginValue > 0)) return bounds;
    const { absX, absY, baseW, baseH } = bounds;
    // No margin correction while the dock slides in or out from its screen edge. A move along the edge
    // is a centered dock growing or shrinking as icons come and go, which still needs it.
    let isMoving = false;
    if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
      const horizontal = edges.minCenterDist === edges.distTopCenter || edges.minCenterDist === edges.distBottomCenter;
      isMoving = horizontal ? Math.abs(absY - this._lastAbsY) > 1.0 : Math.abs(absX - this._lastAbsX) > 1.0;
    }

    this._lastAbsX = absX;
    this._lastAbsY = absY;

    let [tW, tH] = this.targetActor.get_size();
    if (this._stableDeltaW === undefined || this._lastTW !== tW) {
      this._stableDeltaW = baseW - tW;
      this._lastTW = tW;
    }
    if (this._stableDeltaH === undefined || this._lastTH !== tH) {
      this._stableDeltaH = baseH - tH;
      this._lastTH = tH;
    }

    let stableBaseW = tW + this._stableDeltaW;
    let stableBaseH = tH + this._stableDeltaH;
    return isMoving ? bounds : insetDockBounds(bounds, monitor, edges, marginValue, stableBaseW, stableBaseH);
  }

  private _syncDockVisibility(bounds: DockBounds, monitor: DockMonitor | null): void {
    const { absX, absY, baseW, baseH } = bounds;
    const [visibleW, visibleH] = visibleDockSize(bounds, monitor);
    // Only a degenerate box hides the glass: a dock flush against the screen
    // edge is only a few pixels wide on screen. Logged on transition.
    if (visibleW <= 1 || visibleH <= 1) {
      if (this._lastHidden !== true) {
        this._lastHidden = true;
        this._logger.log(
          `[Liquid Glass][dock] hiding the glass: visible=(${visibleW.toFixed(1)}x${visibleH.toFixed(1)}) ` +
          `base=(${baseW.toFixed(1)}x${baseH.toFixed(1)}) abs=(${absX.toFixed(1)},${absY.toFixed(1)}) ` +
          `monitor=(${monitor?.x},${monitor?.y},${monitor?.width}x${monitor?.height}) ` +
          `margin=${this._marginValue}`);
      }
      this.glass!.opacity = 0;
    } else {
      if (this._lastHidden === true) {
        this._lastHidden = false;
        this._logger.log('[Liquid Glass][dock] glass visible again');
      }
      this.glass!.opacity = this.targetActor.opacity;
    }
  }

  private _syncDockGlass(bounds: DockBounds, monitor: DockMonitor, side: DockSide): void {
    const { absX, absY, baseW, baseH } = bounds;
    const w = Math.max(1.0, baseW), h = Math.max(1.0, baseH);
    let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
    let bgX = absX - SHADER_PADDING - this._glassExpand;
    let bgY = absY - SHADER_PADDING - this._glassExpand;

    // The glass covers the whole monitor; the shader draws only the glass
    // rect, in monitor-local coordinates.
    let screenW = monitor.width;
    let screenH = monitor.height;

    // Monitor-local, as the shader uses them.
    let localBgX = bgX - monitor.x;
    let localBgY = bgY - monitor.y;

    if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
      this._lastBgX !== bgX || this._lastBgY !== bgY ||
      this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
      this.glass!.x !== monitor.x || this.glass!.y !== monitor.y) {
      this.glass!.remove_transition('size');
      this.glass!.remove_transition('position');
      this.glass!.set_position(monitor.x, monitor.y);
      this.glass!.set_size(screenW, screenH);
      this.glass!.remove_transition('size');
      this.glass!.remove_transition('position');

      this._lastBgW = bgW; this._lastBgH = bgH;
      this._lastBgX = bgX; this._lastBgY = bgY;
      this._lastScreenW = screenW; this._lastScreenH = screenH;
    }

    const attachment = attachDockGlass(this.glass!, this._attached, this._edgeRadius, [localBgX, localBgY, bgW, bgH],
      side, screenW, screenH);
    const [rectX, rectY, rectW, rectH] = attachment.rect;

    const placed = this._layoutGlassRect([rectX, rectY, rectW, rectH]);
    this.glass?.setShadowMaxRadius(DOCK_CLIP_PADDING - 20);
    this.glass?.setResolution(screenW, screenH);
    if (placed) this.glass?.setGlassGeometry(placed[0], placed[1], placed[2], placed[3]);

    const source = this._liveSource;
    this._liveRef = source ? {
      actor: source.actor,
      rawX: source.rawX, rawY: source.rawY,
      rect: [rectX, rectY, rectW, rectH],
      side: attachment.side, monitorW: screenW, monitorH: screenH,
    } : null;

    // After the geometry setters, so the relays cover this frame's rect.
    this.glass!.syncSources();
  }

  // Sets the glass to `rect` (monitor-local, padded), widened for the menus growing out of it.
  private _placeGlassRect(rect: number[]): void {
    const placed = this._layoutGlassRect(rect);
    if (placed) this.glass!.setGlassGeometry(placed[0], placed[1], placed[2], placed[3]);
  }

  // Draws the menus growing out of the glass at `rect` (monitor-local, padded) and returns the glass's rect, widened
  // for them. Drawing is limited to the glass and the menus plus room for the shadow (not clip_to_allocation, which
  // would cut the shadow off).
  private _layoutGlassRect(rect: number[]): number[] | null {
    const glass = this.glass;
    if (!glass) return null;
    this._glassRect = rect;
    let [x, y, w, h] = rect;
    let [x1, y1, x2, y2] = [x, y, x + w, y + h];
    const menus = this._growsMenus() ? [...this._growths.values()].slice(-MAX_GLASS_GROWTHS) : [];
    if (menus.length > 0 || this._drewGrowths) {
      // The body as glass.frag draws a dock's: inside the padding and the feathered edge.
      const p = SHADER_PADDING + this._feather();
      const ox = glass.x, oy = glass.y;
      const radius = this._settings.get_double('dock-corner-radius');
      const smoothing = this._settings.get_double('glass-corner-smoothing');
      const { bodies, growths } = layoutGrowths([[x + p + ox, y + p + oy, w - p * 2, h - p * 2]], menus, {
        minX: ox, maxX: ox + glass.width,
        fillet: this._edgeRadius,
        reach: bh => cornerReach(radius, smoothing, bh),
        direction: this.growDirection,
      });
      // A menu reaching past the dock's end takes the end out with it.
      x = bodies[0][0] - ox - p;
      w = bodies[0][2] + p * 2;
      const local = growths.map(g => ({ ...g, x: g.x - ox, y: g.y - oy }));
      glass.setGrowths(local);
      this._drewGrowths = local.length > 0;
      for (const g of local) {
        x1 = Math.min(x1, g.x); y1 = Math.min(y1, g.y);
        x2 = Math.max(x2, g.x + g.w); y2 = Math.max(y2, g.y + g.h);
      }
    }
    const c = DOCK_CLIP_PADDING;
    x1 = Math.min(x1, x); x2 = Math.max(x2, x + w);
    setClipIfChanged(glass, x1 - c, y1 - c, x2 - x1 + c * 2, y2 - y1 + c * 2);
    return [x, y, w, h];
  }

  // Menus grow out of a dock along the top or bottom of the screen, by dock-menus-grow.
  private _growsMenus(): boolean {
    return (this._side === 'top' || this._side === 'bottom') && this._menusGrow;
  }

  /** Out of a dock at the bottom things grow up; out of one at the top, down. */
  get growDirection(): 1 | -1 {
    return this._side === 'top' ? 1 : -1;
  }

  growsFrom(source: Clutter.Actor, key: string): boolean {
    return key === MENUS_GROW_KEY && this._isEffectActive && this._growsMenus() && this._glassRect !== null &&
      !!this.glass?.visible && this.glass.opacity > 0 && isActorValid(source) && source.mapped &&
      isActorValid(this.targetActor) && this.targetActor.contains(source);
  }

  /** The stage y of the glass's side facing the screen: its top for a dock at the bottom, its bottom for one at the top. */
  glassEdge(): number {
    const [, y, , h] = this._glassRect ?? [0, 0, 0, 0];
    const oy = this.glass?.y ?? 0;
    const inset = SHADER_PADDING + this._feather();
    return this.growDirection > 0 ? oy + y + h - inset : oy + y + inset;
  }

  // How far glass.frag keeps a dock's body inside its rect past the padding: the feathered edge, which it does not
  // take off the menus grown out of it.
  private _feather(): number {
    return Math.max(this._settings.get_double('glass-edge-smoothing'), 0.75);
  }

  setMenuGrowth(owner: object, rect: number[] | null, radius: number): void {
    this._growths.delete(owner);
    if (rect) this._growths.set(owner, { rect, radius });
    // A growth still running back in at shell shutdown outlives the glass.
    if (!this.glass || !isActorValid(this.glass) || !this._glassRect) return;
    this._placeGlassRect(this._glassRect);
    this.glass.syncSources();
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }

  // The next sync shows it again and updates everything.
  private _hideGlass(): void {
    this.glass?.hide();
    this._glassRect = null;
    this._lastBgW = undefined;
    this._lastBgH = undefined;
    this._lastBgX = undefined;
    this._lastBgY = undefined;
  }

  private _stopFrameSync(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
  }

  _removeEffect() {
    if (!this._isEffectActive) return;
    this._isEffectActive = false;
    this._currentMarginStyle = undefined;
    this._stopFrameSync();
    // The dock may already have been destroyed by Dash to Dock.
    const dockAlive = isActorValid(this.targetActor);
    for (const id of this._signals) {
      if (dockAlive)
        this.targetActor.disconnect(id);
    }
    this._signals = [];
    if (dockAlive) {
      this.targetActor.remove_style_class_name('liquid-glass-transparent');
      this.targetActor.remove_style_class_name('liquid-glass-attached');
      if (this._originalStyle !== undefined) this.targetActor.set_style(this._originalStyle);
      for (const child of this.targetActor.get_children() as St.Widget[]) {
        if (child.has_style_class_name('dash-background')) child.opacity = 255;
      }
    }
    this._originalStyle = undefined;
    if (isActorValid(this._dockParent))
      this._dockParent!.remove_style_class_name('liquid-glass-transparent');
    this._dockParent = null;
    removeGrowthBar(this);
    this._growths.clear();
    this._drewGrowths = false;
    this._glassRect = null;
    const glass = this.glass;
    this.glass = null;
    if (glass) {
      glass.cleanup();
      if (isActorValid(glass)) glass.destroy();
    }
  }

  cleanup() {
    this._liveRef = null;
    this._stopFrameSync();
    this._removeEffect();

    for (let id of this._settingsSignals)
      this._settings.disconnect(id);
    this._settingsSignals = [];
  }

  // The first running-app indicator inside the dock (Dash to Dock's
  // IndicatorDrawingArea), used to balance the gaps around the icons.
  private _findReferenceActor(actor: Clutter.Actor): Clutter.Actor | null {
    if (!actor) return null;
    if (actor.toString().includes('IndicatorDrawingArea'))
      return actor;

    for (const child of actor.get_children()) {
      const found = this._findReferenceActor(child);
      if (found)
        return found;
    }
    return null;
  }
}

export interface DockBounds {
  absX: number;
  absY: number;
  baseW: number;
  baseH: number;
}

export interface DockMonitor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clipDockBounds(bounds: DockBounds, target: DockBounds): DockBounds {
  let { absX, absY, baseW, baseH } = bounds;
  const { absX: tX, absY: tY, baseW: tW, baseH: tH } = target;
  // Cut off whatever sticks out of the target.
  if (absX < tX) { baseW -= (tX - absX); absX = tX; }
  if (absY < tY) { baseH -= (tY - absY); absY = tY; }
  if (absX + baseW > tX + tW) baseW = (tX + tW) - absX;
  if (absY + baseH > tY + tH) baseH = (tY + tH) - absY;
  return { absX, absY, baseW, baseH };
}

export function dockEdges(bounds: DockBounds, monitor: DockMonitor | null) {
  let minCenterDist = -1;
  let distLeftCenter = 0, distRightCenter = 0, distTopCenter = 0, distBottomCenter = 0;
  if (monitor) {
    const dockCenterX = bounds.absX + bounds.baseW / 2;
    const dockCenterY = bounds.absY + bounds.baseH / 2;
    distLeftCenter = dockCenterX - monitor.x;
    distRightCenter = monitor.x + monitor.width - dockCenterX;
    distTopCenter = dockCenterY - monitor.y;
    distBottomCenter = monitor.y + monitor.height - dockCenterY;
    minCenterDist = Math.min(distLeftCenter, distRightCenter, distTopCenter, distBottomCenter);
  }
  return { minCenterDist, distLeftCenter, distRightCenter, distTopCenter, distBottomCenter };
}

export type DockEdges = ReturnType<typeof dockEdges>;

// The gaps before and after the reference rect. On a flipped axis (a dock
// placed at the top, or a mirrored left/right dock) the reference's origin is
// at its far edge, so its real start is refStart - refSize.
function referenceGaps(start: number, size: number, refStart: number, refSize: number): [number, number] {
  let before = refStart - start;
  let after = start + size - (refStart + refSize);
  if (before < 0 || after < 0) {
    const trueStart = refStart - refSize;
    before = trueStart - start;
    after = start + size - (trueStart + refSize);
  }
  return [before, after];
}

export function balanceDockBounds(bounds: DockBounds, reference: DockBounds, edges: DockEdges): DockBounds {
  let { absX, absY, baseW, baseH } = bounds;
  const { absX: refX, absY: refY, baseW: refW, baseH: refH } = reference;
  if (Number.isNaN(refX) || Number.isNaN(refY) || !(refW > 0) || !(refH > 0)) return bounds;
  const [topGap, bottomGap] = referenceGaps(absY, baseH, refY, refH);
  const [leftGap, rightGap] = referenceGaps(absX, baseW, refX, refW);
  if (baseW >= baseH) {
    // Horizontal dock (top or bottom). A difference larger than half the
    // height is bogus and ignored. Trim the larger gap: the bottom by
    // shrinking, the top by also moving the start down.
    const diff = Math.abs(bottomGap - topGap);
    if (diff > 0 && diff < baseH / 2) {
      if (!(bottomGap > topGap)) absY += diff;
      baseH -= diff;
    }
  } else {
    // Vertical dock. Only the gap facing the screen center is trimmed: for a
    // left dock that is the right gap, and the start is never moved right.
    const diff = Math.abs(rightGap - leftGap);
    if (diff > 0 && diff < baseW / 2 &&
      (edges.minCenterDist !== edges.distLeftCenter || rightGap > leftGap)) {
      if (!(rightGap > leftGap)) absX += diff;
      baseW -= diff;
    }
  }
  return { absX, absY, baseW, baseH };
}

export type DockSide = 'top' | 'bottom' | 'left' | 'right';

// The screen edge the dock is closest to.
export function dockSide(edges: DockEdges): DockSide {
  const { minCenterDist, distBottomCenter, distTopCenter, distRightCenter } = edges;
  if (minCenterDist === distBottomCenter) return 'bottom';
  if (minCenterDist === distTopCenter) return 'top';
  if (minCenterDist === distRightCenter) return 'right';
  return 'left';
}

// Trims the dock to `margin` from the screen edge it is closest to.
export function insetDockBounds(bounds: DockBounds, monitor: DockMonitor, edges: DockEdges,
  margin: number, stableBaseW: number, stableBaseH: number): DockBounds {
  let { absX, absY, baseW, baseH } = bounds;
  switch (dockSide(edges)) {
  case 'bottom':
    [absY, baseH] = insetSpan(absY, baseH, monitor.y + monitor.height - margin, stableBaseH, false);
    break;
  case 'top':
    [absY, baseH] = insetSpan(absY, baseH, monitor.y + margin, stableBaseH, true);
    break;
  case 'right':
    [absX, baseW] = insetSpan(absX, baseW, monitor.x + monitor.width - margin, stableBaseW, false);
    break;
  case 'left':
    [absX, baseW] = insetSpan(absX, baseW, monitor.x + margin, stableBaseW, true);
    break;
  }
  return { absX, absY, baseW, baseH };
}

/**
 * The monitor-local glass rect [x, y, w, h], padded by `pad` on every side, with its side on `side` moved onto the
 * monitor's edge so the glass grows out of it. The opposite side stays where it is, so a dock sliding out of the
 * screen draws its glass back into the edge.
 */
export function attachRectToEdge(rect: number[], side: DockSide, monitorW: number, monitorH: number,
  pad: number): number[] {
  const [x, y, w, h] = rect;
  switch (side) {
  case 'top': return [x, -pad, w, y + h + pad];
  case 'bottom': return [x, y, w, monitorH + pad - y];
  case 'left': return [-pad, y, x + w + pad, h];
  case 'right': return [x, y, monitorW + pad - x, h];
  }
}

function insetSpan(start: number, size: number, edge: number, stableSize: number, leading: boolean): [number, number] {
  if (leading) {
    if (start < edge) { size -= edge - start; start = edge; }
  } else if (start + size > edge) {
    size -= (start + size) - edge;
  }
  // Never grow past the last stable size.
  if (size > stableSize) size = stableSize;
  return [start, size];
}

export function visibleDockSize(bounds: DockBounds, monitor: DockMonitor | null): [number, number] {
  const { absX, absY, baseW, baseH } = bounds;
  let visibleW = baseW, visibleH = baseH;
  if (monitor) {
    if (absX < monitor.x) visibleW -= monitor.x - absX;
    if (absY < monitor.y) visibleH -= monitor.y - absY;
    if (absX + baseW > monitor.x + monitor.width) visibleW -= (absX + baseW) - (monitor.x + monitor.width);
    if (absY + baseH > monitor.y + monitor.height) visibleH -= (absY + baseH) - (monitor.y + monitor.height);
  }
  return [visibleW, visibleH];
}

/**
 * The glass of a Dhruva dock (dhruva@narkagni). Dhruva draws the dock's
 * background as one widget, DhruvaBackground, and while the pointer magnifies
 * the icons it widens that widget with a scale and a translation rather than
 * a new size. The glass takes the widget's rect on screen every frame, and
 * the widget is left in place, transparent, as Dhruva's drop target.
 */
export class DhruvaDock {
  private _glass: BackdropGlass | null = null;
  private _background: Clutter.Actor | null = null;
  private _settingsIds: number[] = [];
  private _mapId = 0;
  private _frameSyncId = 0;
  private _frameSignalId = 0;
  private _lastTickUs = 0;

  constructor(private _path: string, private _container: Clutter.Actor, private _settings: Gio.Settings,
    private _logger: Logger) {}

  setup(): void {
    this._settingsIds.push(this._settings.connect('changed::enable-dock-glass', () => {
      if (this._settings.get_boolean('enable-dock-glass')) this._apply();
      else this._remove();
    }));
    this._settingsIds.push(this._settings.connect('changed::dock-glass-expand', () => this._glass?.queue_redraw()));
    this._settingsIds.push(...followDockMaterial(this._settings, () => this._glass));
    if (this._settings.get_boolean('enable-dock-glass')) this._apply();
  }

  private _apply(): void {
    if (this._glass) return;
    this._background = this._container.get_children().find(child => child.get_name() === 'DhruvaBackground') ?? null;
    if (this._background) this._background.opacity = 0;

    const glass = createDockGlass(this._path, this._settings, this._logger, 'dock:dhruva');
    this._glass = glass;
    // Below the dock, so the glass reads the stage before the dock is drawn.
    const uiGroup = Main.layoutManager.uiGroup;
    if (this._container.get_parent() === uiGroup) uiGroup.insert_child_below(glass, this._container);
    else uiGroup.add_child(glass);
    glass.setShadowMaxRadius(GLASS_SHADOW_MAX_RADIUS);
    // Dhruva's animations move the background between the frame tick and the paint.
    glass.setLiveGeometryHook(() => this._place(false));

    this._mapId = this._container.connect('notify::mapped', () => {
      if (this._container.mapped) {
        this._startFrameSync();
      } else {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._glass?.hide();
      }
    });
    if (this._container.mapped) this._startFrameSync();
    else glass.hide();
  }

  private _startFrameSync(): void {
    startStageLoop(this._frameSignalSlot, this._frameSlot, () => {
      const glass = this._glass;
      if (!glass || !this._container.mapped || isFrameSyncFrozen()) return;
      // Two stage views would step it twice in one frame.
      const nowUs = GLib.get_monotonic_time();
      if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US) return;
      this._lastTickUs = nowUs;
      try {
        ensureGlassAllocated(glass);
        this._place(true);
      } catch (e) {
        reportFrameLoopError('DhruvaDock', e);
      }
    });
  }

  // Puts the glass where the background is on screen. With `sync`, also
  // places the glass on its monitor and its sample area, which must happen
  // in the frame tick; the paint-time call only moves the glass rect.
  private _place(sync: boolean): void {
    const glass = this._glass;
    if (!glass) return;
    const box = (this._background ?? this._container).get_transformed_extents();
    const [x, y, w, h] = [box.get_x(), box.get_y(), box.get_width(), box.get_height()];
    if (![x, y].every(Number.isFinite) || !(w > 1) || !(h > 1)) {
      if (sync) glass.hide();
      return;
    }
    const monitor = Main.layoutManager.monitors[Main.layoutManager.findIndexForActor(this._container)]
      ?? Main.layoutManager.primaryMonitor;
    if (!monitor) return;
    const pad = SHADER_PADDING + this._settings.get_int('dock-glass-expand');
    const side = dockSide(dockEdges({ absX: x, absY: y, baseW: w, baseH: h }, monitor));
    const [rx, ry, rw, rh] = attachDockGlass(glass, this._settings.get_boolean('dock-attach-to-edge'),
      this._settings.get_double('dock-edge-radius'), [x - pad - monitor.x, y - pad - monitor.y, w + pad * 2, h + pad * 2], side, monitor.width, monitor.height).rect;
    const rect = { x: rx, y: ry, w: rw, h: rh };
    if (sync) {
      glass.show();
      // Dhruva fades the whole dock in and out as it hides.
      glass.opacity = this._container.get_paint_opacity();
      placeScreenGlass(glass, monitor.x, monitor.y, monitor.width, monitor.height, rect);
      glass.setResolution(monitor.width, monitor.height);
    }
    glass.setGlassGeometry(rect.x, rect.y, rect.w, rect.h);
    // After the geometry setters, so the relays cover this frame's rect.
    if (sync) glass.syncSources();
  }

  private _remove(): void {
    stopStageLoop(this._frameSignalSlot, this._frameSlot);
    // Dhruva may have destroyed its dock already.
    if (this._mapId && isActorValid(this._container)) this._container.disconnect(this._mapId);
    this._mapId = 0;
    if (this._background && isActorValid(this._background)) this._background.opacity = 255;
    this._background = null;
    const glass = this._glass;
    this._glass = null;
    if (glass) {
      glass.cleanup();
      if (isActorValid(glass)) glass.destroy();
    }
  }

  cleanup(): void {
    this._remove();
    for (const id of this._settingsIds) this._settings.disconnect(id);
    this._settingsIds = [];
  }

  private get _frameSlot() {
    return { get: () => this._frameSyncId, set: (id: number) => { this._frameSyncId = id; } };
  }

  private get _frameSignalSlot() {
    return { get: () => this._frameSignalId, set: (id: number) => { this._frameSignalId = id; } };
  }
}

const SEARCH_DELAY_MS = 2000;
const RESCAN_IDLE_TICKS = 2;
const RESCAN_INTERVAL_MS = 2000;

// The actors Dash to Dock and Dhruva add to the UI group for each dock.
const DOCK_ROOTS = ['dashtodockContainer', 'DhruvaContainer'];

interface DockEntry {
  container: Clutter.Actor;
  manager: DashManager | DhruvaDock;
  destroyId: number;
}

/**
 * Finds Dash to Dock's and Dhruva's docks and gives each its glass. Either may create its dock after we are enabled,
 * and recreates it when monitors change, when it is enabled again and for some of its settings, so it is looked for
 * after a delay and again whenever one may have appeared.
 */
export class DockWatcher {
  private _docks: DockEntry[] = [];
  private _searchId = 0;
  private _rescanId = 0;
  private _monitorsChangedId = 0;
  private _childAddedId = 0;

  constructor(private _path: string, private _settings: Gio.Settings, private _logger: Logger, private _icons: IconStyler) {}

  setup(): void {
    this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleRescan());
    this._childAddedId = Main.layoutManager.uiGroup.connect('child-added', (_group: Clutter.Actor, child: Clutter.Actor) => {
      if (DOCK_ROOTS.includes(child.get_name() ?? '')) this._scheduleRescan();
    });
    this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
      this._searchId = 0;
      this._find();
      this._scheduleRescan();
      return GLib.SOURCE_REMOVE;
    });
  }

  cleanup(): void {
    Main.layoutManager.disconnect(this._monitorsChangedId);
    Main.layoutManager.uiGroup.disconnect(this._childAddedId);
    if (this._searchId) GLib.Source.remove(this._searchId);
    this._searchId = 0;
    if (this._rescanId) GLib.Source.remove(this._rescanId);
    this._rescanId = 0;
    for (const entry of [...this._docks]) this._release(entry);
  }

  private _containers(): { container: Clutter.Actor, dhruva: boolean }[] {
    const found: { container: Clutter.Actor, dhruva: boolean }[] = [];
    const walk = (actor: Clutter.Actor) => {
      if (actor === global.window_group) return;
      if (actor instanceof St.Widget && actor.get_name() === 'dashtodockDashContainer') {
        found.push({ container: actor, dhruva: false });
        return;
      }
      if (actor.get_name() === 'DhruvaContainer') {
        found.push({ container: actor, dhruva: true });
        return;
      }
      for (const child of actor.get_children()) walk(child);
    };
    walk(Main.layoutManager.uiGroup);
    return found;
  }

  // True when a dock was found that had no glass yet.
  private _find(): boolean {
    let added = 0;
    for (const { container, dhruva } of this._containers()) {
      if (this._docks.some(entry => entry.container === container)) continue;
      const manager = dhruva
        ? new DhruvaDock(this._path, container, this._settings, this._logger)
        : new DashManager(this._path, container as St.Widget, this._settings, this._logger);
      manager.setup();
      this._icons.watchDock(container);
      const entry: DockEntry = { container, manager, destroyId: 0 };
      entry.destroyId = container.connect('destroy', () => {
        entry.destroyId = 0;
        this._release(entry);
        this._scheduleRescan();
      });
      this._docks.push(entry);
      added++;
    }
    if (added > 0) this._logger.log(`[Liquid Glass] Docks with glass: ${this._docks.length}`);
    return added > 0;
  }

  private _release(entry: DockEntry): void {
    this._docks = this._docks.filter(e => e !== entry);
    if (entry.destroyId) entry.container.disconnect(entry.destroyId);
    entry.destroyId = 0;
    entry.manager.cleanup();
    this._icons.unwatchDock(entry.container);
  }

  // Keeps looking until RESCAN_IDLE_TICKS scans in a row find nothing new.
  private _scheduleRescan(): void {
    if (this._rescanId) GLib.Source.remove(this._rescanId);
    let idleTicks = 0;
    this._rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
      idleTicks = this._find() ? 0 : idleTicks + 1;
      if (idleTicks < RESCAN_IDLE_TICKS) return GLib.SOURCE_CONTINUE;
      this._rescanId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }
}
