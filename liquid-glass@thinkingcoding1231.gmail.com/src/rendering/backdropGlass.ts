// Glass that reads what is behind it from the stage framebuffer while the
// stage is painted (see StageCopier). Relays (RelaySet) put the whole sample
// area into the redraw clip whenever anything behind it changes, so a reused
// copy is never stale.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import type { Logger } from '../logger.js';
import { GlassRenderer, type AttachedEdge, type GlassGrowth, type GlassRegion } from './glassRenderer.js';
import type { BlurMethod } from './pipelines.js';
import {
  coglContext, paintNodeWithContext, canCloneSource, undoCloneScale, newRootNode, offscreenFormat
} from '../shellVersion.js';
import { windowMayCover, UnpickableActor, setTranslationIfChanged, setScaleIfChanged } from '../actors.js';
import { registerGlass, unregisterGlass } from '../diagnostics.js';

export interface GlassActorParams {
  extensionPath?: string;
  settings?: Gio.Settings;
  logger?: Logger;
  // The owning manager, shown by global._lgGlass.dump().
  owner?: string;
  // The outline comes from a distance field (setShapeTexture()).
  shapeTexture?: boolean;
  // The surface whose outline settings this glass follows; none draws no outline.
  outline?: string;
  // Drawn under the windows, in the window group (the desktop items).
  underWindows?: boolean;
}

/**
 * What every stage-reading glass shares: the renderer and its setters, the
 * shaders, the paint-time geometry hook, the sample rect and the composite.
 * Subclasses supply the backdrop texture.
 */
export const GlassActor = GObject.registerClass(
  class GlassActor extends Clutter.Actor {
    declare _owner: string;
    // What this glass belongs to, for the dump.
    declare _diagOwnerLabel: string;
    declare protected _extensionPath: string | undefined;
    declare protected _logger: Logger | undefined;
    declare protected _renderer: GlassRenderer;
    declare protected _shadersLoaded: boolean;
    declare protected _diagEnabled: boolean;

    declare private _liveGeometryHook: (() => void) | null;
    declare private _inLiveGeometry: boolean;
    declare private _batchDepth: number;
    declare private _batchDirty: boolean;
    // Cancels the shader read when the glass goes away before it finishes.
    declare private _shaderLoad: Gio.Cancellable;

    // For global._lgGlass.dump().
    declare protected _paints: number;
    declare protected _blurRuns: number;
    declare protected _blurSkips: number;
    declare protected _diagLast: any;
    declare private _diagLastSnapshotAt: number;

    _init(params: GlassActorParams = {}) {
      super._init({ name: 'liquid-glass-bg-actor', reactive: false });
      Shell.util_set_hidden_from_pick(this, true);

      this._owner = params.owner ?? '?';
      this._diagOwnerLabel = '';
      this._extensionPath = params.extensionPath;
      this._logger = params.logger;
      this._shadersLoaded = false;
      this._diagEnabled = false;
      this._liveGeometryHook = null;
      this._inLiveGeometry = false;
      this._batchDepth = 0;
      this._batchDirty = false;
      this._shaderLoad = new Gio.Cancellable();
      this._paints = 0;
      this._blurRuns = 0;
      this._blurSkips = 0;
      this._diagLast = null;
      this._diagLastSnapshotAt = 0;

      this._renderer = new GlassRenderer({
        settings: params.settings,
        logger: params.logger,
        repaint: () => this._queueRepaint(),
        setDiagnostics: enabled => { this._diagEnabled = enabled; },
        shapeTexture: params.shapeTexture,
        outline: params.outline,
      });

      registerGlass(this);
      this._loadShaders();
    }

    vfunc_pick(_pickContext: any): void {
    }

    private async _loadShaders(): Promise<void> {
      // Nothing has been drawn yet, so there is nothing for _onShadersLoaded() to redraw.
      if (this._renderer.pipelines.loadCached(this._extensionPath)) {
        this._shadersLoaded = true;
        return;
      }
      const start = GLib.get_monotonic_time();
      try {
        await this._renderer.pipelines.load(this._extensionPath, this._shaderLoad);
      } catch (e) {
        // Cancelled by cleanup(): the glass is gone.
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        this._logger?.error(`[Liquid Glass] Failed to load shaders: ${e}`);
        return;
      }
      this._shadersLoaded = true;
      const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
      this._logger?.log(`[Liquid Glass] shaders loaded in ${elapsedMs.toFixed(1)}ms`);
      this._onShadersLoaded();
    }

    // Nothing was copied while the shaders were missing.
    protected _onShadersLoaded(): void {
      this._queueRepaint();
    }

    // The sample rect in shader space: the blur rect, or the whole glass.
    protected _sampleShaderRect(): number[] | null {
      const [resW, resH] = this._renderer.getResolution();
      if (!(resW >= 1) || !(resH >= 1)) return null;
      return this._renderer.geometry.blurRect() ?? [0, 0, resW, resH];
    }

    // Shader space to actor space. The size requested this frame, which the
    // allocation only catches up with in the relayout.
    protected _shaderScale(): [number, number] | null {
      const [resW, resH] = this._renderer.getResolution();
      const [w, h] = this.get_size();
      if (!(resW >= 1) || !(resH >= 1) || !(w >= 1) || !(h >= 1)) return null;
      return [w / resW, h / resH];
    }

    // The sample rect plus SAMPLE_MARGIN, [x, y, w, h] in actor space.
    protected _sampleAreaRect(): number[] | null {
      const s = this._sampleShaderRect();
      const k = this._shaderScale();
      if (!s || !k) return null;
      const x0 = Math.floor(s[0] * k[0]) - SAMPLE_MARGIN;
      const y0 = Math.floor(s[1] * k[1]) - SAMPLE_MARGIN;
      const x1 = Math.ceil((s[0] + s[2]) * k[0]) + SAMPLE_MARGIN;
      const y1 = Math.ceil((s[1] + s[3]) * k[1]) + SAMPLE_MARGIN;
      return [x0, y0, x1 - x0, y1 - y0];
    }

    // A stage rect [x0, y0, x1, y1] as [x, y, w, h] in shader space.
    protected _stageToShader(rect: number[], kx: number, ky: number): number[] | null {
      const [ok0, ax, ay] = this.transform_stage_point(rect[0], rect[1]);
      const [ok1, bx, by] = this.transform_stage_point(rect[2], rect[3]);
      if (!ok0 || !ok1) return null;
      const x0 = Math.min(ax, bx) / kx;
      const y0 = Math.min(ay, by) / ky;
      const x1 = Math.max(ax, bx) / kx;
      const y1 = Math.max(ay, by) / ky;
      if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1)) return null;
      return [x0, y0, x1 - x0, y1 - y0];
    }

    // Shader space to actor space for this paint, from the allocation; null
    // while there is nothing to draw.
    protected _paintScale(): { kx: number, ky: number, resW: number, resH: number } | null {
      const [resW, resH] = this._renderer.getResolution();
      const box = this.get_allocation_box();
      const allocW = box.get_width();
      const allocH = box.get_height();
      if (!(resW >= 1) || !(resH >= 1) || !(allocW >= 1) || !(allocH >= 1)) return null;
      return { kx: allocW / resW, ky: allocH / resH, resW, resH };
    }

    protected _beginPaint(): Cogl.Context | null {
      this._paints++;
      this._runLiveGeometryHook();
      if (!this._shadersLoaded) return null;
      const ctx = coglContext();
      this._renderer.prepare(ctx);
      return ctx;
    }

    /**
     * Blurs `texture`, which holds `blurRect` (shader space) of the backdrop,
     * unless `key` says the last blur is still current. The pool works in
     * shader-space pixels, so the blur radius means the same at every
     * monitor scale. `slot` names the pool to use; a glass that blurs a
     * different texture on each stage view passes the view.
     */
    protected _runBlur(root: Clutter.PaintNode, ctx: Cogl.Context, texture: Cogl.Texture,
      blurRect: number[], key: readonly unknown[], slot: unknown = null): void {
      const blur = this._renderer.blur;
      blur.use(slot);
      if (blur.passCount <= 0) return;
      const w = Math.max(1, Math.round(blurRect[2]));
      const h = Math.max(1, Math.round(blurRect[3]));
      if (blur.width === w && blur.height === h && blur.canReuse(key)) {
        this._blurSkips++;
        return;
      }
      if (blur.width !== w || blur.height !== h) blur.resize(ctx, w, h);
      if (!blur.ready) return;
      blur.render(root, texture, [0, 0, 1, 1], key);
      this._blurRuns++;
    }

    // Draws glass.frag over the part of the glass that can be non-transparent.
    protected _composite(root: Clutter.PaintNode, backdrop: Cogl.Texture, blurRect: number[],
      kx: number, ky: number, resW: number, resH: number): number[] {
      this._renderer.bindBackdrop(backdrop, blurRect);
      const r = this._renderer.geometry.compositeRect() ?? [0, 0, resW, resH];
      const drawRect = [r[0] * kx, r[1] * ky, (r[0] + r[2]) * kx, (r[1] + r[3]) * ky];
      const drawUV = [r[0] / resW, r[1] / resH, (r[0] + r[2]) / resW, (r[1] + r[3]) / resH];
      this._renderer.addComposite(root, drawRect, drawUV, this.get_paint_opacity());
      return r;
    }

    private _runLiveGeometryHook(): void {
      if (!this._liveGeometryHook) return;
      this._inLiveGeometry = true;
      try {
        this._liveGeometryHook();
      } finally {
        this._inLiveGeometry = false;
      }
    }

    protected _queueRepaint(): void {
      // Repainting from inside this paint would request a new frame every frame.
      if (this._inLiveGeometry) return;
      if (this._batchDepth) {
        this._batchDirty = true;
        return;
      }
      this.queue_redraw();
    }

    // The state behind global._lgGlass.dump(): every paint with diagnostics
    // on, about once a second otherwise.
    protected _snapshot(fields: () => object): void {
      const now = GLib.get_monotonic_time();
      if (!this._diagEnabled && now - this._diagLastSnapshotAt < 1000 * 1000) return;
      this._diagLastSnapshotAt = now;
      this._diagLast = {
        owner: this._owner,
        ...fields(),
        ...this._renderer.blur.describe(),
        paintOpacity: this.get_paint_opacity(),
      };
    }

    /** One row of global._lgGlass.dump(). */
    describe(): object {
      return {
        ...(this._diagLast ?? { owner: this._owner, state: 'never composited' }),
        label: this._diagOwnerLabel || undefined,
        paints: this._paints,
        blurRuns: this._blurRuns,
        blurSkips: this._blurSkips,
        mapped: this.mapped,
        opacity: this.opacity,
      };
    }

    get paintCount(): number {
      return this._paints;
    }

    get uniformValues(): ReadonlyMap<string, number> {
      return this._renderer.uniforms.values;
    }

    /**
     * Runs `fn` at the start of every paint, when the allocation of whatever
     * the glass follows is current, so it can correct the geometry the frame
     * sync read before the relayout. Setters called from it do not queue
     * another repaint.
     */
    setLiveGeometryHook(fn: (() => void) | null): void {
      this._liveGeometryHook = fn;
    }

    beginBatch(): void {
      this._batchDepth++;
    }

    endBatch(): void {
      if (!this._batchDepth) return;
      this._batchDepth--;
      if (this._batchDepth === 0 && this._batchDirty) {
        this._batchDirty = false;
        this.queue_redraw();
      }
    }

    cleanup(): void {
      this._shaderLoad.cancel();
      // The hook's closure holds the manager and its actors.
      this._liveGeometryHook = null;
      unregisterGlass(this);
      this._renderer.cleanup();
    }

    getResolution(): [number, number] {
      return this._renderer.getResolution();
    }

    setBlurRectEnabled(enabled: boolean): void { this._renderer.setBlurRectEnabled(enabled); }
    setCompositeRectEnabled(enabled: boolean): void { this._renderer.setCompositeRectEnabled(enabled); }
    setEdgeTapsEnabled(enabled: boolean): void { this._renderer.setEdgeTapsEnabled(enabled); }
    setEarlyExitEnabled(enabled: boolean): void { this._renderer.setEarlyExitEnabled(enabled); }
    setDebugView(mode: number): void { this._renderer.setDebugView(mode); }
    setIsDock(isDock: boolean): void { this._renderer.setIsDock(isDock); }
    setSurfaceLightEnabled(enabled: boolean): void { this._renderer.setSurfaceLightEnabled(enabled); }
    setCornerSmoothingEnabled(enabled: boolean): void { this._renderer.setCornerSmoothingEnabled(enabled); }
    setPadding(pad: number): void { this._renderer.setPadding(pad); }
    setShadowMaxRadius(radius: number): void { this._renderer.setShadowMaxRadius(radius); }
    setBlurMethod(method: BlurMethod): void { this._renderer.setBlurMethod(method); }
    setBlurRadius(radius: number): void { this._renderer.setBlurRadius(radius); }
    reloadShaders(): void { this._renderer.reloadShaders(); }
    setTintColor(r: number, g: number, b: number): void { this._renderer.setTintColor(r, g, b); }
    setTintStrength(strength: number): void { this._renderer.setTintStrength(strength); }
    setCornerRadius(radius: number): void { this._renderer.setCornerRadius(radius); }
    setAttachedEdge(edge: AttachedEdge, radius: number): void { this._renderer.setAttachedEdge(edge, radius); }
    setGrowths(growths: GlassGrowth[]): void { this._renderer.setGrowths(growths); }
    setAnimationScale(scale: number): void { this._renderer.setAnimationScale(scale); }
    // The glass's size in shader space; normally its own size.
    setResolution(width: number, height: number): void { this._renderer.setResolution(width, height); }
    setGlassGeometry(x: number, y: number, w: number, h: number): void { this._renderer.setGlassGeometry(x, y, w, h); }
    setMultiRegionMode(enabled: boolean): void { this._renderer.setMultiRegionMode(enabled); }
    setShapeTexture(texture: Cogl.Texture | null, range: number, band: number): void {
      this._renderer.setShapeTexture(texture, range, band);
    }
    setGlassRegions(regions: GlassRegion[]): void { this._renderer.setGlassRegions(regions); }
    setBrightness(brightness: number): void { this._renderer.setBrightness(brightness); }
    setContrast(contrast: number): void { this._renderer.setContrast(contrast); }
    setSaturation(saturation: number): void { this._renderer.setSaturation(saturation); }
  }
);

export type GlassActor = InstanceType<typeof GlassActor>;

/**
 * Counts the paints of its actor before which a redraw was queued on the actor or below it. A glass's relays are
 * below it, so the count moves whenever something behind the glass changed, and stays while only what is in front
 * of it did.
 */
const RedrawCounter = GObject.registerClass(
  class RedrawCounter extends Clutter.Effect {
    declare count: number;

    _init(): void {
      super._init();
      this.count = 0;
    }

    vfunc_paint_node(node: Clutter.PaintNode, paintContext: Clutter.PaintContext, flags: Clutter.EffectPaintFlags): void {
      if (flags & Clutter.EffectPaintFlags.ACTOR_DIRTY) this.count++;
      super.vfunc_paint_node(node, paintContext, flags);
    }
  }
);

type RedrawCounter = InstanceType<typeof RedrawCounter>;

/**
 * A glass drawn straight onto the stage (dock, menus, notifications, OSDs,
 * Quick Settings' background mode): it copies its own backdrop from the
 * stage view it is painted on.
 */
export const BackdropGlass = GObject.registerClass(paintNodeWithContext(
  class BackdropGlass extends GlassActor {
    declare private _relays: RelaySet;
    declare private _copier: StageCopier;
    // Whether the last sync saw the glass painted at all; see syncSources().
    declare private _wasPainted: boolean;
    // The serial of the last copy taken before the glass was last mapped.
    declare private _serialAtMap: number;
    declare private _underWindows: boolean;
    // Whether the copy may hold a window that covered the backdrop, or the
    // backdrop changed while no copy was taken; see vfunc_paint_node().
    declare private _copyDoubtful: boolean;
    declare private _redraws: RedrawCounter;
    // Takes the copy a whole-view redraw left alone again; see StageCopier.take().
    declare private _refreshId: number;

    _init(params: GlassActorParams = {}) {
      super._init(params);
      this._relays = new RelaySet(this);
      this._copier = new StageCopier(this._logger);
      this._redraws = new RedrawCounter();
      this.add_effect(this._redraws);
      this._refreshId = 0;
      this._wasPainted = false;
      this._serialAtMap = 0;
      this._underWindows = params.underWindows ?? false;
      this._copyDoubtful = false;
    }

    // The relays are unmapped with the glass, so nothing behind it was
    // tracked while it was hidden.
    vfunc_map(): void {
      super.vfunc_map();
      this._serialAtMap = this._copier.mainCopy?.serial ?? 0;
      this._relays.redrawArea();
    }

    /**
     * What is behind the glass without the glass or anything above it: the
     * last stage copy and the stage rect [x0, y0, x1, y1] it holds. Null until
     * the glass has copied its backdrop since it was last shown, because an
     * older copy can show what was there before.
     */
    backdropCopy(): { texture: Cogl.Texture, rect: number[] } | null {
      const copy = this._copier.mainCopy;
      if (!copy?.rect || copy.serial <= this._serialAtMap) return null;
      return { texture: copy.texture, rect: copy.rect };
    }

    protected _onShadersLoaded(): void {
      super._onShadersLoaded();
      this._relays.redrawArea();
    }

    /**
     * Places the sample area and the relays for this frame. Call it every frame
     * from before-update, after this frame's geometry setters: a redraw queued
     * there lands in the same frame's clip. `moved` says an ancestor moved the
     * glass on screen this frame. An X11 window actor's paint volume leaves out
     * its children, so moving the window does not redraw the area by itself.
     */
    syncSources(moved = false): void {
      const area = this._sampleAreaRect();
      if (!area) return;
      const changed = this._relays.sync(area);
      // A glass that was fully transparent was not painted when the backdrop
      // changed, so its copy is old as well.
      const painted = this.get_paint_opacity() > 0;
      if (changed || moved || (painted && !this._wasPainted)) this._relays.redrawArea();
      this._wasPainted = painted;
      const views = this.peek_stage_views();
      this._copier.prune(views);
      this._renderer.blur.prune(views);
    }

    vfunc_paint_node(root: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
      const ctx = this._beginPaint();
      if (!ctx) return;
      const scale = this._paintScale();
      const s = this._sampleShaderRect();
      if (!scale || !s) return;
      const { kx, ky, resW, resH } = scale;

      const stageRect = localToStage(this, s[0] * kx, s[1] * ky, (s[0] + s[2]) * kx, (s[1] + s[3]) * ky);
      // Under a window, the framebuffer can hold that window where mutter left
      // out what it covers, and the copy would show it once the window moves
      // off. The last copy is kept meanwhile, and the area is copied again
      // once no window is over it.
      const covered = this._underWindows && windowMayCover(this, stageRect);
      const { copy, missed, fresh, spared } = this._copier.take(this, root, paintContext, stageRect, covered,
        this._redraws.count);
      if (spared) this._refreshLater();
      if (covered) this._copyDoubtful = true;
      else if (fresh) this._copyDoubtful = false;
      // Nothing to draw with yet, or a doubtful copy: the next frame redraws the whole area.
      if (missed || (this._copyDoubtful && !covered && !fresh)) this._relays.redrawArea();
      if (!copy?.rect) return;
      const blurRect = this._stageToShader(copy.rect, kx, ky);
      if (!blurRect) return;

      this._runBlur(root, ctx, copy.texture, blurRect, [copy.texture, copy.serial], copy.view);
      const compositeRect = this._composite(root, copy.texture, blurRect, kx, ky, resW, resH);
      this._snapshot(() => {
        const round = (v: number) => +v.toFixed(2);
        return {
          mode: 'backdrop',
          copy: `${copy.width}x${copy.height}${copy.format === null ? '' : ` fmt=${copy.format}`}`,
          copyStageRect: copy.rect?.map(round) ?? null,
          blurRect: blurRect.map(round),
          compositeRect: compositeRect.map(round),
        };
      });
    }

    // Something behind the glass that no relay follows (what an ancestor draws itself) may have changed in a
    // frame whose copy was spared, so the area is redrawn once more a little later.
    private _refreshLater(): void {
      if (this._refreshId) return;
      this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPARED_COPY_REFRESH_MS, () => {
        this._refreshId = 0;
        this._relays.redrawArea();
        return GLib.SOURCE_REMOVE;
      });
    }

    /** Counters for the test driver and the dump. */
    get stats(): { paints: number, copies: number, reuses: number, misses: number, offStage: number, spared: number } {
      const c = this._copier;
      return {
        paints: this._paints, copies: c.copyCount, reuses: c.reuseCount, misses: c.missCount,
        offStage: c.offStageCount, spared: c.sparedCount,
      };
    }

    describe(): object {
      return {
        ...super.describe(),
        ...this.stats,
        relays: this._relays.names(),
        relayChanges: this._relays.changes,
        sampleArea: this._relays.areaRect(),
      };
    }

    // The relays go with the glass when the caller destroys it; at shell
    // shutdown they can already be gone by the time this runs.
    cleanup(): void {
      if (this._refreshId) {
        GLib.Source.remove(this._refreshId);
        this._refreshId = 0;
      }
      super.cleanup();
      this._relays.clear();
      this._copier.clear();
    }
  }
));

export type BackdropGlass = InstanceType<typeof BackdropGlass>;

// Relays keep a reused backdrop copy correct. Every actor painted before a
// glass gets an invisible clone (a relay) whose paint volume is the glass's
// sample area, so a redraw anywhere in that actor, which Clutter forwards to
// its clones, puts the whole sample area into the same frame's redraw clip,
// and the glass copies its backdrop again.

// Room around the sample rect, so the rect can shift a little at paint time
// (the live geometry hook) and still be inside the redrawn area.
export const SAMPLE_MARGIN = 32;

// The fixed size of the sample area actor and of every relay. The area is
// fitted to the sample rect by translation and scale only: moving or resizing
// an actor through its position or size goes through a relayout, and
// redrawing an actor whose relayout is still pending redraws the whole stage.
const SAMPLE_BASE = 256;

// Room for a server-side shadow around a window that moved this frame, whose
// paint volume is not known yet (see windowReaches()).
const WINDOW_SHADOW_MARGIN = 80;

// A relay is hidden only once its source is this much further away than it
// had to come to be shown, so a source on the edge of a growing or moving
// area does not toggle every frame. Kept small: a source inside the margin
// still costs a copy whenever it redraws.
const RELAY_KEEP_MARGIN = 16;

interface SourceReach {
  near: boolean;
  keep: boolean;
}

/**
 * Its paint volume is its own box (the sample area), not the source's: a
 * redraw anywhere in the source then damages exactly the sample area,
 * whatever happens to the source's size in that frame.
 */
const BackdropRelay = GObject.registerClass(
  class BackdropRelay extends Clutter.Clone {
    declare private _allocated: boolean;

    _init(params: any): void {
      super._init(params);
      Shell.util_set_hidden_from_pick(this, true);
      this._allocated = false;
    }

    vfunc_allocate(box: Clutter.ActorBox): void {
      super.vfunc_allocate(box);
      this._allocated = true;
    }

    // A clone is relaid out whenever its source is, every frame for a
    // dragged window, and the request climbs to the glass, which then waits
    // for an allocation in every frame. A relay's box never changes, so once
    // it has one the requests stop here.
    vfunc_queue_relayout(): void {
      if (!this._allocated) super.vfunc_queue_relayout();
    }

    vfunc_pick(_pickContext: any): void {
    }

    vfunc_get_paint_volume(volume: Clutter.PaintVolume): boolean {
      if (!volume.set_from_allocation(this)) return false;
      undoCloneScale(this, volume);
      return true;
    }
  }
);

// Actors that only carry relays for a backdrop read inside another actor's
// paint (relayHolder()). They draw nothing, so no glass reads them.
const holders = new WeakSet<Clutter.Actor>();

/**
 * A parent for the relays of a RelaySet whose owner is not ours to add
 * children to. It goes on top of the UI group, which is at the stage's
 * origin, so its coordinates are the stage's.
 */
export function relayHolder(): Clutter.Actor {
  const holder = new UnpickableActor({ name: 'liquid-glass-relay-holder' });
  holders.add(holder);
  return holder;
}

export class RelaySet {
  // Parent of the relays, covering the sample rect (see SAMPLE_BASE). It
  // draws nothing itself; it is painted (opacity 255) so that its children
  // are visited and Clutter keeps forwarding their sources' redraws.
  readonly area: Clutter.Actor;
  private _relays = new Map<Clutter.Actor, Clutter.Clone>();
  changes = 0;

  // `exclude` names actors painted before the owner that are not part of
  // its backdrop. The relays go in `holder`, the owner itself by default.
  constructor(private _owner: Clutter.Actor, private _exclude: (actor: Clutter.Actor) => boolean = () => false,
    private _holder: Clutter.Actor = _owner) {
    this.area = new UnpickableActor({ name: 'liquid-glass-sample-area', width: SAMPLE_BASE, height: SAMPLE_BASE });
    _holder.add_child(this.area);
  }

  /**
   * Fits the sample area to `rect` [x, y, w, h] in the holder's coordinates
   * and updates the relays. Returns whether the set of relayed actors
   * changed, which changes the backdrop without necessarily redrawing all
   * of it; the caller then redraws the area.
   */
  sync(rect: number[]): boolean {
    const [x, y, w, h] = rect;
    setTranslationIfChanged(this.area, x, y);
    setScaleIfChanged(this.area, w / SAMPLE_BASE, h / SAMPLE_BASE);

    // A relay out of reach is hidden rather than destroyed, and shown again
    // when its source comes back: Clutter redraws the whole stage for an
    // actor's first frame on stage, since it has no previous paint volume to
    // damage.
    const near = this._localToStage(x, y, x + w, y + h);
    const m = RELAY_KEEP_MARGIN;
    const keep = [near[0] - m, near[1] - m, near[2] + m, near[3] + m];
    const sources = this._collectSources(near, keep);
    let changed = false;
    for (const [source, relay] of this._relays) {
      const reach = sources.get(source);
      if (reach === undefined) {
        if (relay.visible) changed = true;
        relay.destroy();
        this._relays.delete(source);
        continue;
      }
      const show = (relay.visible ? reach.keep : reach.near) && canCloneSource(source);
      if (relay.visible !== show) {
        relay.visible = show;
        changed = true;
      }
    }
    for (const [source, reach] of sources) {
      if (this._relays.has(source) || !reach.near || !canCloneSource(source)) continue;
      const relay = new BackdropRelay({ source, opacity: 0, width: SAMPLE_BASE, height: SAMPLE_BASE }) as Clutter.Clone;
      this.area.add_child(relay);
      this._relays.set(source, relay);
      changed = true;
    }
    if (changed) this.changes++;
    return changed;
  }

  redrawArea(): void {
    this.area.queue_redraw();
  }

  // The relays go with the owner when it is destroyed; at shell shutdown they
  // can already be gone by the time the owner is cleaned up.
  clear(): void {
    this._relays.clear();
  }

  // The relayed actors, for the dump. Through the relay, whose source is
  // null once the source is gone.
  names(): string[] {
    return [...this._relays.values()].filter(relay => relay.visible).map(relay => {
      const a = relay.source;
      if (!a) return '(destroyed)';
      if (a instanceof Meta.WindowActor) return `window:${a.get_meta_window()?.get_title() ?? '?'}`;
      return a.get_name() || (a.constructor as any).$gtype.name;
    });
  }

  areaRect(): number[] {
    return [this.area.translation_x, this.area.translation_y,
      this.area.scale_x * SAMPLE_BASE, this.area.scale_y * SAMPLE_BASE].map(v => Math.round(v));
  }

  private _localToStage(x0: number, y0: number, x1: number, y1: number): number[] {
    return localToStage(this._holder, x0, y0, x1, y1);
  }

  // Everything painted before the owner, and whether it reaches the sample
  // area (`near`) or the wider area a shown relay is kept for (`keep`): the
  // earlier siblings of the owner and of each of its ancestors, and the
  // children of the window group. Never an ancestor itself, whose paint
  // volume would contain the relays. A window's glass meets the windows
  // below it as earlier siblings of its own window.
  private _collectSources(near: number[], keep: number[]): Map<Clutter.Actor, SourceReach> {
    const wanted = new Map<Clutter.Actor, SourceReach>();
    let child: Clutter.Actor = this._owner;
    let parent = child.get_parent();
    while (parent) {
      for (let s = parent.get_first_child(); s && s !== child; s = s.get_next_sibling()) {
        if (!s.mapped || s.opacity === 0 || holders.has(s) || this._exclude(s)) continue;
        if (s === global.window_group) this._collectWindowGroup(s, near, keep, wanted);
        else wanted.set(s, sourceReach(s, near, keep));
      }
      child = parent;
      parent = parent.get_parent();
    }
    return wanted;
  }

  private _collectWindowGroup(group: Clutter.Actor, near: number[], keep: number[],
    wanted: Map<Clutter.Actor, SourceReach>): void {
    for (let a = group.get_first_child(); a; a = a.get_next_sibling()) {
      if (!a.mapped || a.opacity === 0) continue;
      wanted.set(a, sourceReach(a, near, keep));
    }
  }
}

function sourceReach(actor: Clutter.Actor, near: number[], keep: number[]): SourceReach {
  if (actor instanceof Meta.WindowActor)
    return { near: windowReaches(actor, near), keep: windowReaches(actor, keep) };
  return { near: actorReaches(actor, near), keep: actorReaches(actor, keep) };
}

// The stage rect [x0, y0, x1, y1] of a rect in `actor`'s coordinates.
export function localToStage(actor: Clutter.Actor, x0: number, y0: number, x1: number, y1: number): number[] {
  const a = actor.apply_transform_to_point(new Graphene.Point3D({ x: x0, y: y0, z: 0 }));
  const b = actor.apply_transform_to_point(new Graphene.Point3D({ x: x1, y: y1, z: 0 }));
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

// Moving an actor queues its redraw at once but changes its allocation only
// in the coming relayout, so an actor waiting for one may be about to enter
// the area and counts as reaching it. Otherwise its paint volume (which
// already includes this frame's transitions) tells.
function actorReaches(actor: Clutter.Actor, area: number[]): boolean {
  if (!actor.has_allocation()) return true;
  const pv = actor.get_transformed_paint_volume(global.stage);
  return !pv || volumeReaches(pv, area);
}

function volumeReaches(pv: Clutter.PaintVolume, area: number[]): boolean {
  const o = pv.get_origin();
  return o.x < area[2] && o.x + pv.get_width() > area[0] &&
    o.y < area[3] && o.y + pv.get_height() > area[1];
}

// A window's paint volume includes the shadow mutter draws around it. A
// window moved this frame has last frame's volume until the relayout, so
// its buffer rect, already moved, decides, with room for a shadow.
function windowReaches(actor: Meta.WindowActor, area: number[]): boolean {
  if (actor.has_allocation()) {
    const pv = actor.get_transformed_paint_volume(global.stage);
    if (pv) return volumeReaches(pv, area);
  }
  const r = actor.get_meta_window()?.get_buffer_rect();
  if (!r) return true;
  const m = WINDOW_SHADOW_MARGIN;
  return r.x - m < area[2] && r.x + r.width + m > area[0] &&
    r.y - m < area[3] && r.y + r.height + m > area[1];
}

// Copies a rect of a stage view's framebuffer while the stage is painted.
// Everything painted before the copying actor is in the framebuffer by the
// time its paint nodes run. Only the frame's redraw clip holds current pixels,
// though; outside it the framebuffer still has the previous frame. So a copy
// is taken only when the clip contains the whole rect, and reused otherwise.
//
// Where the stage cannot redraw part of a view (no buffer age), every frame's
// clip is the whole view, and a video anywhere on a monitor would have every
// glass on it copy and blur again on each of its frames. A redraw of a whole
// view therefore takes a new copy only if a redraw was queued behind the glass
// since the last one (see RedrawCounter).

// How long a copy that whole-view redraws left alone may stay before it is taken again.
const SPARED_COPY_REFRESH_MS = 250;

// The copy of one stage view's pixels.
export interface ViewCopy {
  view: Clutter.StageView;
  texture: Cogl.Texture2D;
  framebuffer: Cogl.Offscreen;
  width: number;
  height: number;
  format: Cogl.PixelFormat | null;
  // The stage rect [x0, y0, x1, y1] it holds, on the view's pixel grid; null
  // until the first copy.
  rect: number[] | null;
  serial: number;
  // The owner's redraw count and the time (us) when it was taken.
  redraws: number;
  takenUs: number;
}

// An offscreen texture to render or blit into. A blit needs both sides fixed
// point or both floating point, so `format` follows the source when that is
// an offscreen (rotated or HDR views); null is the default RGBA8888_PRE.
export function createTarget(width: number, height: number, format: Cogl.PixelFormat | null = null,
  logger?: Logger): { texture: Cogl.Texture2D, framebuffer: Cogl.Offscreen } | null {
  const ctx = coglContext();
  const texture = format === null
    ? Cogl.Texture2D.new_with_size(ctx, width, height)
    : Cogl.Texture2D.new_with_format(ctx, width, height, format);
  const framebuffer = Cogl.Offscreen.new_with_texture(texture);
  try {
    framebuffer.allocate();
  } catch (e) {
    logger?.error(`[Liquid Glass] ${width}x${height} offscreen could not be allocated: ${e}`);
    return null;
  }
  return { texture, framebuffer };
}

// Queues a blit of `rect` [x, y, w, h] of `source` to the origin of `target`.
// A RootNode makes the target the blit's destination and, with no clear
// flags, leaves it alone otherwise. Its color state must be the source's.
export function addBlit(root: Clutter.PaintNode, source: Cogl.Framebuffer, target: Cogl.Framebuffer,
  colorState: Clutter.ColorState | undefined, rect: number[]): void {
  const node = newRootNode(target, colorState);
  root.add_child(node);
  const blit = Clutter.BlitNode.new(source);
  blit.add_blit_rectangle(rect[0], rect[1], 0, 0, rect[2], rect[3]);
  node.add_child(blit);
}

// The stage view being painted, between the stage's before-paint and
// after-paint. Outside them a paint goes to a screenshot, whose framebuffer
// is not fetched: holding it from JS keeps it alive until a garbage
// collection, and mutter 46 only flushes a screenshot's drawing when its
// framebuffer is freed, so the picture would come out empty.
let paintingView: Clutter.StageView | null = null;
let paintSignalIds: number[] = [];

export function trackViewPaints(): void {
  paintSignalIds = [
    global.stage.connect('before-paint', (_stage: Clutter.Stage, view: Clutter.StageView) => {
      paintingView = view;
    }),
    global.stage.connect('after-paint', () => {
      paintingView = null;
    }),
  ];
}

export function isPaintingView(): boolean {
  return paintingView !== null;
}

export function untrackViewPaints(): void {
  for (const id of paintSignalIds) global.stage.disconnect(id);
  paintSignalIds = [];
  paintingView = null;
}

// Whether the redraw clip is the whole of a view; no clip at all is an unclipped redraw.
function coversView(clip: Mtk.Region | null, layout: Mtk.Rectangle): boolean {
  return !clip || clip.contains_rectangle(layout) === Mtk.RegionOverlap.IN;
}

export class StageCopier {
  private _copies = new Map<Clutter.StageView, ViewCopy>();
  private _serial = 0;
  // The copy an off-stage paint (screenshot, screen recording, clone) draws with: the one holding the most of
  // the glass. A glass whose sample area reaches onto the next monitor has a thin strip copied there as well.
  mainCopy: ViewCopy | null = null;

  copyCount = 0;
  reuseCount = 0;
  offStageCount = 0;
  missCount = 0;
  sparedCount = 0;

  constructor(private _logger?: Logger) {}

  // The view a paint of `actor` draws to directly, or null for a paint that
  // goes elsewhere (a clone, a screenshot, an ancestor's offscreen), where
  // the framebuffer does not hold what is behind the actor.
  static liveView(actor: Clutter.Actor, paintContext: Clutter.PaintContext): Clutter.StageView | null {
    const view = paintingView;
    if (!view || actor.is_in_clone_paint() || !actor.peek_stage_views().includes(view)) return null;
    return paintContext.get_framebuffer() === view.get_framebuffer() ? view : null;
  }

  /**
   * The copy to draw with for this paint of `actor`: a new one of the stage
   * rect `stageRect` [x0, y0, x1, y1] when the clip covers it, otherwise the
   * last one taken on this view. `missed` is set when there is nothing to
   * draw with yet; the caller should get the rect redrawn in a later frame.
   * `fresh` is set when this paint took a new copy. With `keep`, the last
   * copy is drawn with even when the clip covers the rect. `redraws` is the
   * owner's RedrawCounter count; with it, a redraw of the whole view keeps a
   * copy nothing was redrawn behind, and `spared` is set.
   */
  take(actor: Clutter.Actor, root: Clutter.PaintNode, paintContext: Clutter.PaintContext,
    stageRect: number[], keep = false, redraws = -1,
  ): { copy: ViewCopy | null, missed: boolean, fresh: boolean, spared?: boolean } {
    const view = StageCopier.liveView(actor, paintContext);
    if (!view) {
      this.offStageCount++;
      return { copy: this.mainCopy, missed: false, fresh: false };
    }
    const fb = view.get_framebuffer();
    let copy = this._copies.get(view) ?? null;
    if (keep && copy?.rect) {
      this.reuseCount++;
      return { copy, missed: false, fresh: false };
    }

    const layout = view.layout;
    const x0 = Math.max(stageRect[0], layout.x);
    const y0 = Math.max(stageRect[1], layout.y);
    const x1 = Math.min(stageRect[2], layout.x + layout.width);
    const y1 = Math.min(stageRect[3], layout.y + layout.height);
    if (!(x1 > x0) || !(y1 > y0)) return { copy, missed: false, fresh: false };

    // Stage to framebuffer pixels, as Clutter lays the stage out on a view.
    const scale = view.get_scale();
    const ox = Math.round(-layout.x * scale);
    const oy = Math.round(-layout.y * scale);
    // A fractional scale is stored a little above its value (1.3333334), so the
    // view's far edge would round up to a pixel past the framebuffer, and past the clip.
    const fx0 = Math.max(Math.floor(x0 * scale) + ox, 0);
    const fy0 = Math.max(Math.floor(y0 * scale) + oy, 0);
    const fx1 = Math.min(Math.ceil(x1 * scale) + ox, fb.get_width());
    const fy1 = Math.min(Math.ceil(y1 * scale) + oy, fb.get_height());
    if (!(fx1 > fx0) || !(fy1 > fy0)) return { copy, missed: false, fresh: false };
    const rect = [(fx0 - ox) / scale, (fy0 - oy) / scale, (fx1 - ox) / scale, (fy1 - oy) / scale];

    // A scale stored a little below its value (5/3 as 1.6666666) puts the view's far edge a hair past the
    // layout, and rounding that up would ask for a pixel the clip never holds.
    const clip = paintContext.get_redraw_clip();
    const clipX = Math.max(Math.floor(rect[0]), layout.x);
    const clipY = Math.max(Math.floor(rect[1]), layout.y);
    const clipX1 = Math.min(Math.ceil(rect[2]), layout.x + layout.width);
    const clipY1 = Math.min(Math.ceil(rect[3]), layout.y + layout.height);
    const inClip = !clip || clip.contains_rectangle(new Mtk.Rectangle({
      x: clipX, y: clipY, width: clipX1 - clipX, height: clipY1 - clipY,
    })) === Mtk.RegionOverlap.IN;
    if (!inClip) {
      if (copy?.rect) {
        this.reuseCount++;
        return { copy, missed: false, fresh: false };
      }
      this.missCount++;
      return { copy: null, missed: true, fresh: false };
    }

    const nowUs = GLib.get_monotonic_time();
    if (copy?.rect && redraws >= 0 && copy.redraws === redraws && copy.rect.every((v, i) => v === rect[i]) &&
      nowUs - copy.takenUs < SPARED_COPY_REFRESH_MS * 1000 && coversView(clip, layout)) {
      this.sparedCount++;
      return { copy, missed: false, fresh: false, spared: true };
    }

    const format = fb instanceof Cogl.Offscreen ? offscreenFormat(fb) : null;
    copy = this._target(view, copy, fx1 - fx0, fy1 - fy0, format);
    if (!copy) return { copy: null, missed: false, fresh: false };
    addBlit(root, fb, copy.framebuffer, view.color_state, [fx0, fy0, fx1 - fx0, fy1 - fy0]);

    copy.rect = rect;
    copy.redraws = redraws;
    copy.takenUs = nowUs;
    copy.serial = ++this._serial;
    this.mainCopy = this._largest();
    this.copyCount++;
    return { copy, missed: false, fresh: true };
  }

  private _largest(): ViewCopy | null {
    let best: ViewCopy | null = null;
    let bestArea = 0;
    for (const copy of this._copies.values()) {
      if (!copy.rect) continue;
      const area = (copy.rect[2] - copy.rect[0]) * (copy.rect[3] - copy.rect[1]);
      if (area > bestArea) {
        best = copy;
        bestArea = area;
      }
    }
    return best;
  }

  private _target(view: Clutter.StageView, copy: ViewCopy | null, width: number, height: number,
    format: Cogl.PixelFormat | null): ViewCopy | null {
    if (copy && copy.width === width && copy.height === height && copy.format === format) return copy;
    const target = createTarget(width, height, format, this._logger);
    if (!target) return null;
    const next: ViewCopy = { ...target, view, width, height, format, rect: null, serial: 0, redraws: -1, takenUs: 0 };
    this._copies.set(view, next);
    return next;
  }

  // Drops the copies of views the actor is no longer on.
  prune(views: Clutter.StageView[]): void {
    for (const view of this._copies.keys()) {
      if (!views.includes(view)) this._copies.delete(view);
    }
  }

  clear(): void {
    this._copies.clear();
    this.mainCopy = null;
  }
}
