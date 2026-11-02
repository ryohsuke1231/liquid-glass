// Glass that reads what is behind it from the stage framebuffer while the
// stage is painted (see stageCopy.ts). Relays (relays.ts) put the whole sample
// area into the redraw clip whenever anything behind it changes, so a reused
// copy is never stale.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import type Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';

import type { Logger } from '../logger.js';
import { GlassRenderer, type AttachedEdge, type GlassRegion } from './glassRenderer.js';
import type { BlurMethod } from './blur.js';
import { StageCopier } from './stageCopy.js';
import { coglContext, paintNodeWithContext } from '../shellVersion.js';
import { RelaySet, SAMPLE_MARGIN, localToStage } from './relays.js';
import { windowMayCover } from '../actors/windows.js';
import { registerGlass, unregisterGlass } from '../diagnostics/glass.js';

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
     * monitor scale.
     */
    protected _runBlur(root: Clutter.PaintNode, ctx: Cogl.Context, texture: Cogl.Texture,
      blurRect: number[], key: readonly unknown[]): void {
      const blur = this._renderer.blur;
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

    _init(params: GlassActorParams = {}) {
      super._init(params);
      this._relays = new RelaySet(this);
      this._copier = new StageCopier(this._logger);
      this._wasPainted = false;
      this._serialAtMap = 0;
      this._underWindows = params.underWindows ?? false;
      this._copyDoubtful = false;
    }

    // The relays are unmapped with the glass, so nothing behind it was
    // tracked while it was hidden.
    vfunc_map(): void {
      super.vfunc_map();
      this._serialAtMap = this._copier.lastCopy?.serial ?? 0;
      this._relays.redrawArea();
    }

    /**
     * What is behind the glass without the glass or anything above it: the
     * last stage copy and the stage rect [x0, y0, x1, y1] it holds. Null until
     * the glass has copied its backdrop since it was last shown, because an
     * older copy can show what was there before.
     */
    backdropCopy(): { texture: Cogl.Texture, rect: number[] } | null {
      const copy = this._copier.lastCopy;
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
      this._copier.prune(this.peek_stage_views());
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
      const { copy, missed, fresh } = this._copier.take(this, root, paintContext, stageRect, covered);
      if (covered) this._copyDoubtful = true;
      else if (fresh) this._copyDoubtful = false;
      // Nothing to draw with yet, or a doubtful copy: the next frame redraws the whole area.
      if (missed || (this._copyDoubtful && !covered && !fresh)) this._relays.redrawArea();
      if (!copy?.rect) return;
      const blurRect = this._stageToShader(copy.rect, kx, ky);
      if (!blurRect) return;

      this._runBlur(root, ctx, copy.texture, blurRect, [copy.texture, copy.serial]);
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

    /** Counters for the test driver and the dump. */
    get stats(): { paints: number, copies: number, reuses: number, misses: number, offStage: number } {
      const c = this._copier;
      return { paints: this._paints, copies: c.copyCount, reuses: c.reuseCount, misses: c.missCount, offStage: c.offStageCount };
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
      super.cleanup();
      this._relays.clear();
      this._copier.clear();
    }
  }
));

export type BackdropGlass = InstanceType<typeof BackdropGlass>;
