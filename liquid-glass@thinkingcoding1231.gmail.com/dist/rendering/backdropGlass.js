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
import { GlassRenderer } from './glassRenderer.js';
import { coglContext, paintNodeWithContext, canCloneSource, undoCloneScale, newRootNode, offscreenFormat } from '../shellVersion.js';
import { windowMayCover, UnpickableActor, setTranslationIfChanged, setScaleIfChanged } from '../actors.js';
import { registerGlass, unregisterGlass } from '../diagnostics.js';

/**
 * What every stage-reading glass shares: the renderer and its setters, the
 * shaders, the paint-time geometry hook, the sample rect and the composite.
 * Subclasses supply the backdrop texture.
 */
export const GlassActor = GObject.registerClass(class GlassActor extends Clutter.Actor {
    _init(params = {}) {
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

    vfunc_pick(_pickContext) {
    }

    async _loadShaders() {
        // Nothing has been drawn yet, so there is nothing for _onShadersLoaded() to redraw.
        if (this._renderer.pipelines.loadCached(this._extensionPath)) {
            this._shadersLoaded = true;
            return;
        }
        const start = GLib.get_monotonic_time();
        try {
            await this._renderer.pipelines.load(this._extensionPath, this._shaderLoad);
        }
        catch (e) {
            // Cancelled by cleanup(): the glass is gone.
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._logger?.error(`[Liquid Glass] Failed to load shaders: ${e}`);
            return;
        }
        this._shadersLoaded = true;
        const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
        this._logger?.log(`[Liquid Glass] shaders loaded in ${elapsedMs.toFixed(1)}ms`);
        this._onShadersLoaded();
    }

    // Nothing was copied while the shaders were missing.
    _onShadersLoaded() {
        this._queueRepaint();
    }

    // The sample rect in shader space: the blur rect, or the whole glass.
    _sampleShaderRect() {
        const [resW, resH] = this._renderer.getResolution();
        if (!(resW >= 1) || !(resH >= 1))
            return null;
        return this._renderer.geometry.blurRect() ?? [0, 0, resW, resH];
    }

    // Shader space to actor space. The size requested this frame, which the
    // allocation only catches up with in the relayout.
    _shaderScale() {
        const [resW, resH] = this._renderer.getResolution();
        const [w, h] = this.get_size();
        if (!(resW >= 1) || !(resH >= 1) || !(w >= 1) || !(h >= 1))
            return null;
        return [w / resW, h / resH];
    }

    // The sample rect plus SAMPLE_MARGIN, [x, y, w, h] in actor space.
    _sampleAreaRect() {
        const s = this._sampleShaderRect();
        const k = this._shaderScale();
        if (!s || !k)
            return null;
        const x0 = Math.floor(s[0] * k[0]) - SAMPLE_MARGIN;
        const y0 = Math.floor(s[1] * k[1]) - SAMPLE_MARGIN;
        const x1 = Math.ceil((s[0] + s[2]) * k[0]) + SAMPLE_MARGIN;
        const y1 = Math.ceil((s[1] + s[3]) * k[1]) + SAMPLE_MARGIN;
        return [x0, y0, x1 - x0, y1 - y0];
    }

    // A stage rect [x0, y0, x1, y1] as [x, y, w, h] in shader space.
    _stageToShader(rect, kx, ky) {
        const [ok0, ax, ay] = this.transform_stage_point(rect[0], rect[1]);
        const [ok1, bx, by] = this.transform_stage_point(rect[2], rect[3]);
        if (!ok0 || !ok1)
            return null;
        const x0 = Math.min(ax, bx) / kx;
        const y0 = Math.min(ay, by) / ky;
        const x1 = Math.max(ax, bx) / kx;
        const y1 = Math.max(ay, by) / ky;
        if (!(x1 - x0 >= 1) || !(y1 - y0 >= 1))
            return null;
        return [x0, y0, x1 - x0, y1 - y0];
    }

    // Shader space to actor space for this paint, from the allocation; null
    // while there is nothing to draw.
    _paintScale() {
        const [resW, resH] = this._renderer.getResolution();
        const box = this.get_allocation_box();
        const allocW = box.get_width();
        const allocH = box.get_height();
        if (!(resW >= 1) || !(resH >= 1) || !(allocW >= 1) || !(allocH >= 1))
            return null;
        return { kx: allocW / resW, ky: allocH / resH, resW, resH };
    }

    _beginPaint() {
        this._paints++;
        this._runLiveGeometryHook();
        if (!this._shadersLoaded)
            return null;
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
    _runBlur(root, ctx, texture, blurRect, key) {
        const blur = this._renderer.blur;
        if (blur.passCount <= 0)
            return;
        const w = Math.max(1, Math.round(blurRect[2]));
        const h = Math.max(1, Math.round(blurRect[3]));
        if (blur.width === w && blur.height === h && blur.canReuse(key)) {
            this._blurSkips++;
            return;
        }
        if (blur.width !== w || blur.height !== h)
            blur.resize(ctx, w, h);
        if (!blur.ready)
            return;
        blur.render(root, texture, [0, 0, 1, 1], key);
        this._blurRuns++;
    }

    // Draws glass.frag over the part of the glass that can be non-transparent.
    _composite(root, backdrop, blurRect, kx, ky, resW, resH) {
        this._renderer.bindBackdrop(backdrop, blurRect);
        const r = this._renderer.geometry.compositeRect() ?? [0, 0, resW, resH];
        const drawRect = [r[0] * kx, r[1] * ky, (r[0] + r[2]) * kx, (r[1] + r[3]) * ky];
        const drawUV = [r[0] / resW, r[1] / resH, (r[0] + r[2]) / resW, (r[1] + r[3]) / resH];
        this._renderer.addComposite(root, drawRect, drawUV, this.get_paint_opacity());
        return r;
    }

    _runLiveGeometryHook() {
        if (!this._liveGeometryHook)
            return;
        this._inLiveGeometry = true;
        try {
            this._liveGeometryHook();
        }
        finally {
            this._inLiveGeometry = false;
        }
    }

    _queueRepaint() {
        // Repainting from inside this paint would request a new frame every frame.
        if (this._inLiveGeometry)
            return;
        if (this._batchDepth) {
            this._batchDirty = true;
            return;
        }
        this.queue_redraw();
    }

    // The state behind global._lgGlass.dump(): every paint with diagnostics
    // on, about once a second otherwise.
    _snapshot(fields) {
        const now = GLib.get_monotonic_time();
        if (!this._diagEnabled && now - this._diagLastSnapshotAt < 1000 * 1000)
            return;
        this._diagLastSnapshotAt = now;
        this._diagLast = {
            owner: this._owner,
            ...fields(),
            ...this._renderer.blur.describe(),
            paintOpacity: this.get_paint_opacity(),
        };
    }

    /** One row of global._lgGlass.dump(). */
    describe() {
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

    get paintCount() {
        return this._paints;
    }

    get uniformValues() {
        return this._renderer.uniforms.values;
    }

    /**
     * Runs `fn` at the start of every paint, when the allocation of whatever
     * the glass follows is current, so it can correct the geometry the frame
     * sync read before the relayout. Setters called from it do not queue
     * another repaint.
     */
    setLiveGeometryHook(fn) {
        this._liveGeometryHook = fn;
    }

    beginBatch() {
        this._batchDepth++;
    }

    endBatch() {
        if (!this._batchDepth)
            return;
        this._batchDepth--;
        if (this._batchDepth === 0 && this._batchDirty) {
            this._batchDirty = false;
            this.queue_redraw();
        }
    }

    cleanup() {
        this._shaderLoad.cancel();
        // The hook's closure holds the manager and its actors.
        this._liveGeometryHook = null;
        unregisterGlass(this);
        this._renderer.cleanup();
    }

    getResolution() {
        return this._renderer.getResolution();
    }

    setBlurRectEnabled(enabled) { this._renderer.setBlurRectEnabled(enabled); }

    setCompositeRectEnabled(enabled) { this._renderer.setCompositeRectEnabled(enabled); }

    setEdgeTapsEnabled(enabled) { this._renderer.setEdgeTapsEnabled(enabled); }

    setEarlyExitEnabled(enabled) { this._renderer.setEarlyExitEnabled(enabled); }

    setDebugView(mode) { this._renderer.setDebugView(mode); }

    setIsDock(isDock) { this._renderer.setIsDock(isDock); }

    setSurfaceLightEnabled(enabled) { this._renderer.setSurfaceLightEnabled(enabled); }

    setCornerSmoothingEnabled(enabled) { this._renderer.setCornerSmoothingEnabled(enabled); }

    setPadding(pad) { this._renderer.setPadding(pad); }

    setShadowMaxRadius(radius) { this._renderer.setShadowMaxRadius(radius); }

    setBlurMethod(method) { this._renderer.setBlurMethod(method); }

    setBlurRadius(radius) { this._renderer.setBlurRadius(radius); }

    reloadShaders() { this._renderer.reloadShaders(); }

    setTintColor(r, g, b) { this._renderer.setTintColor(r, g, b); }

    setTintStrength(strength) { this._renderer.setTintStrength(strength); }

    setCornerRadius(radius) { this._renderer.setCornerRadius(radius); }

    setAttachedEdge(edge, radius) { this._renderer.setAttachedEdge(edge, radius); }

    setAnimationScale(scale) { this._renderer.setAnimationScale(scale); }

    // The glass's size in shader space; normally its own size.
    setResolution(width, height) { this._renderer.setResolution(width, height); }

    setGlassGeometry(x, y, w, h) { this._renderer.setGlassGeometry(x, y, w, h); }

    setMultiRegionMode(enabled) { this._renderer.setMultiRegionMode(enabled); }

    setShapeTexture(texture, range, band) {
        this._renderer.setShapeTexture(texture, range, band);
    }

    setGlassRegions(regions) { this._renderer.setGlassRegions(regions); }

    setBrightness(brightness) { this._renderer.setBrightness(brightness); }

    setContrast(contrast) { this._renderer.setContrast(contrast); }

    setSaturation(saturation) { this._renderer.setSaturation(saturation); }
});

/**
 * A glass drawn straight onto the stage (dock, menus, notifications, OSDs,
 * Quick Settings' background mode): it copies its own backdrop from the
 * stage view it is painted on.
 */
export const BackdropGlass = GObject.registerClass(paintNodeWithContext(class BackdropGlass extends GlassActor {
    _init(params = {}) {
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
    vfunc_map() {
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
    backdropCopy() {
        const copy = this._copier.lastCopy;
        if (!copy?.rect || copy.serial <= this._serialAtMap)
            return null;
        return { texture: copy.texture, rect: copy.rect };
    }

    _onShadersLoaded() {
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
    syncSources(moved = false) {
        const area = this._sampleAreaRect();
        if (!area)
            return;
        const changed = this._relays.sync(area);
        // A glass that was fully transparent was not painted when the backdrop
        // changed, so its copy is old as well.
        const painted = this.get_paint_opacity() > 0;
        if (changed || moved || (painted && !this._wasPainted))
            this._relays.redrawArea();
        this._wasPainted = painted;
        this._copier.prune(this.peek_stage_views());
    }

    vfunc_paint_node(root, paintContext) {
        const ctx = this._beginPaint();
        if (!ctx)
            return;
        const scale = this._paintScale();
        const s = this._sampleShaderRect();
        if (!scale || !s)
            return;
        const { kx, ky, resW, resH } = scale;
        const stageRect = localToStage(this, s[0] * kx, s[1] * ky, (s[0] + s[2]) * kx, (s[1] + s[3]) * ky);
        // Under a window, the framebuffer can hold that window where mutter left
        // out what it covers, and the copy would show it once the window moves
        // off. The last copy is kept meanwhile, and the area is copied again
        // once no window is over it.
        const covered = this._underWindows && windowMayCover(this, stageRect);
        const { copy, missed, fresh } = this._copier.take(this, root, paintContext, stageRect, covered);
        if (covered)
            this._copyDoubtful = true;
        else if (fresh)
            this._copyDoubtful = false;
        // Nothing to draw with yet, or a doubtful copy: the next frame redraws the whole area.
        if (missed || (this._copyDoubtful && !covered && !fresh))
            this._relays.redrawArea();
        if (!copy?.rect)
            return;
        const blurRect = this._stageToShader(copy.rect, kx, ky);
        if (!blurRect)
            return;
        this._runBlur(root, ctx, copy.texture, blurRect, [copy.texture, copy.serial]);
        const compositeRect = this._composite(root, copy.texture, blurRect, kx, ky, resW, resH);
        this._snapshot(() => {
            const round = (v) => +v.toFixed(2);
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
    get stats() {
        const c = this._copier;
        return { paints: this._paints, copies: c.copyCount, reuses: c.reuseCount, misses: c.missCount, offStage: c.offStageCount };
    }

    describe() {
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
    cleanup() {
        super.cleanup();
        this._relays.clear();
        this._copier.clear();
    }
}));

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

/**
 * Its paint volume is its own box (the sample area), not the source's: a
 * redraw anywhere in the source then damages exactly the sample area,
 * whatever happens to the source's size in that frame.
 */
const BackdropRelay = GObject.registerClass(class BackdropRelay extends Clutter.Clone {
    _init(params) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
        this._allocated = false;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        this._allocated = true;
    }

    // A clone is relaid out whenever its source is, every frame for a
    // dragged window, and the request climbs to the glass, which then waits
    // for an allocation in every frame. A relay's box never changes, so once
    // it has one the requests stop here.
    vfunc_queue_relayout() {
        if (!this._allocated)
            super.vfunc_queue_relayout();
    }

    vfunc_pick(_pickContext) {
    }

    vfunc_get_paint_volume(volume) {
        if (!volume.set_from_allocation(this))
            return false;
        undoCloneScale(this, volume);
        return true;
    }
});

// Actors that only carry relays for a backdrop read inside another actor's
// paint (relayHolder()). They draw nothing, so no glass reads them.
const holders = new WeakSet();

/**
 * A parent for the relays of a RelaySet whose owner is not ours to add
 * children to. It goes on top of the UI group, which is at the stage's
 * origin, so its coordinates are the stage's.
 */
export function relayHolder() {
    const holder = new UnpickableActor({ name: 'liquid-glass-relay-holder' });
    holders.add(holder);
    return holder;
}

export class RelaySet {
    _owner;
    _exclude;
    _holder;
    // Parent of the relays, covering the sample rect (see SAMPLE_BASE). It
    // draws nothing itself; it is painted (opacity 255) so that its children
    // are visited and Clutter keeps forwarding their sources' redraws.
    area;
    _relays = new Map();
    changes = 0;

    // `exclude` names actors painted before the owner that are not part of
    // its backdrop. The relays go in `holder`, the owner itself by default.
    constructor(_owner, _exclude = () => false, _holder = _owner) {
        this._owner = _owner;
        this._exclude = _exclude;
        this._holder = _holder;
        this.area = new UnpickableActor({ name: 'liquid-glass-sample-area', width: SAMPLE_BASE, height: SAMPLE_BASE });
        _holder.add_child(this.area);
    }

    /**
     * Fits the sample area to `rect` [x, y, w, h] in the holder's coordinates
     * and updates the relays. Returns whether the set of relayed actors
     * changed, which changes the backdrop without necessarily redrawing all
     * of it; the caller then redraws the area.
     */
    sync(rect) {
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
                if (relay.visible)
                    changed = true;
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
            if (this._relays.has(source) || !reach.near || !canCloneSource(source))
                continue;
            const relay = new BackdropRelay({ source, opacity: 0, width: SAMPLE_BASE, height: SAMPLE_BASE });
            this.area.add_child(relay);
            this._relays.set(source, relay);
            changed = true;
        }
        if (changed)
            this.changes++;
        return changed;
    }

    redrawArea() {
        this.area.queue_redraw();
    }

    // The relays go with the owner when it is destroyed; at shell shutdown they
    // can already be gone by the time the owner is cleaned up.
    clear() {
        this._relays.clear();
    }

    // The relayed actors, for the dump. Through the relay, whose source is
    // null once the source is gone.
    names() {
        return [...this._relays.values()].filter(relay => relay.visible).map(relay => {
            const a = relay.source;
            if (!a)
                return '(destroyed)';
            if (a instanceof Meta.WindowActor)
                return `window:${a.get_meta_window()?.get_title() ?? '?'}`;
            return a.get_name() || a.constructor.$gtype.name;
        });
    }

    areaRect() {
        return [this.area.translation_x, this.area.translation_y,
            this.area.scale_x * SAMPLE_BASE, this.area.scale_y * SAMPLE_BASE].map(v => Math.round(v));
    }

    _localToStage(x0, y0, x1, y1) {
        return localToStage(this._holder, x0, y0, x1, y1);
    }

    // Everything painted before the owner, and whether it reaches the sample
    // area (`near`) or the wider area a shown relay is kept for (`keep`): the
    // earlier siblings of the owner and of each of its ancestors, and the
    // children of the window group. Never an ancestor itself, whose paint
    // volume would contain the relays. A window's glass meets the windows
    // below it as earlier siblings of its own window.
    _collectSources(near, keep) {
        const wanted = new Map();
        let child = this._owner;
        let parent = child.get_parent();
        while (parent) {
            for (let s = parent.get_first_child(); s && s !== child; s = s.get_next_sibling()) {
                if (!s.mapped || s.opacity === 0 || holders.has(s) || this._exclude(s))
                    continue;
                if (s === global.window_group)
                    this._collectWindowGroup(s, near, keep, wanted);
                else
                    wanted.set(s, sourceReach(s, near, keep));
            }
            child = parent;
            parent = parent.get_parent();
        }
        return wanted;
    }

    _collectWindowGroup(group, near, keep, wanted) {
        for (let a = group.get_first_child(); a; a = a.get_next_sibling()) {
            if (!a.mapped || a.opacity === 0)
                continue;
            wanted.set(a, sourceReach(a, near, keep));
        }
    }
}

function sourceReach(actor, near, keep) {
    if (actor instanceof Meta.WindowActor)
        return { near: windowReaches(actor, near), keep: windowReaches(actor, keep) };
    return { near: actorReaches(actor, near), keep: actorReaches(actor, keep) };
}

// The stage rect [x0, y0, x1, y1] of a rect in `actor`'s coordinates.
export function localToStage(actor, x0, y0, x1, y1) {
    const a = actor.apply_transform_to_point(new Graphene.Point3D({ x: x0, y: y0, z: 0 }));
    const b = actor.apply_transform_to_point(new Graphene.Point3D({ x: x1, y: y1, z: 0 }));
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

// Moving an actor queues its redraw at once but changes its allocation only
// in the coming relayout, so an actor waiting for one may be about to enter
// the area and counts as reaching it. Otherwise its paint volume (which
// already includes this frame's transitions) tells.
function actorReaches(actor, area) {
    if (!actor.has_allocation())
        return true;
    const pv = actor.get_transformed_paint_volume(global.stage);
    return !pv || volumeReaches(pv, area);
}

function volumeReaches(pv, area) {
    const o = pv.get_origin();
    return o.x < area[2] && o.x + pv.get_width() > area[0] &&
        o.y < area[3] && o.y + pv.get_height() > area[1];
}

// A window's paint volume includes the shadow mutter draws around it. A
// window moved this frame has last frame's volume until the relayout, so
// its buffer rect, already moved, decides, with room for a shadow.
function windowReaches(actor, area) {
    if (actor.has_allocation()) {
        const pv = actor.get_transformed_paint_volume(global.stage);
        if (pv)
            return volumeReaches(pv, area);
    }
    const r = actor.get_meta_window()?.get_buffer_rect();
    if (!r)
        return true;
    const m = WINDOW_SHADOW_MARGIN;
    return r.x - m < area[2] && r.x + r.width + m > area[0] &&
        r.y - m < area[3] && r.y + r.height + m > area[1];
}

// An offscreen texture to render or blit into. A blit needs both sides fixed
// point or both floating point, so `format` follows the source when that is
// an offscreen (rotated or HDR views); null is the default RGBA8888_PRE.
export function createTarget(width, height, format = null, logger) {
    const ctx = coglContext();
    const texture = format === null
        ? Cogl.Texture2D.new_with_size(ctx, width, height)
        : Cogl.Texture2D.new_with_format(ctx, width, height, format);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    try {
        framebuffer.allocate();
    }
    catch (e) {
        logger?.error(`[Liquid Glass] ${width}x${height} offscreen could not be allocated: ${e}`);
        return null;
    }
    return { texture, framebuffer };
}

// Queues a blit of `rect` [x, y, w, h] of `source` to the origin of `target`.
// A RootNode makes the target the blit's destination and, with no clear
// flags, leaves it alone otherwise. Its color state must be the source's.
export function addBlit(root, source, target, colorState, rect) {
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
let paintingView = null;
let paintSignalIds = [];

export function trackViewPaints() {
    paintSignalIds = [
        global.stage.connect('before-paint', (_stage, view) => {
            paintingView = view;
        }),
        global.stage.connect('after-paint', () => {
            paintingView = null;
        }),
    ];
}

export function isPaintingView() {
    return paintingView !== null;
}

export function untrackViewPaints() {
    for (const id of paintSignalIds)
        global.stage.disconnect(id);
    paintSignalIds = [];
    paintingView = null;
}

export class StageCopier {
    _logger;
    _copies = new Map();
    _serial = 0;
    // The copy an off-stage paint (screenshot, clone) draws with.
    lastCopy = null;
    copyCount = 0;
    reuseCount = 0;
    offStageCount = 0;
    missCount = 0;

    constructor(_logger) {
        this._logger = _logger;
    }

    // The view a paint of `actor` draws to directly, or null for a paint that
    // goes elsewhere (a clone, a screenshot, an ancestor's offscreen), where
    // the framebuffer does not hold what is behind the actor.
    static liveView(actor, paintContext) {
        const view = paintingView;
        if (!view || actor.is_in_clone_paint() || !actor.peek_stage_views().includes(view))
            return null;
        return paintContext.get_framebuffer() === view.get_framebuffer() ? view : null;
    }

    /**
     * The copy to draw with for this paint of `actor`: a new one of the stage
     * rect `stageRect` [x0, y0, x1, y1] when the clip covers it, otherwise the
     * last one taken on this view. `missed` is set when there is nothing to
     * draw with yet; the caller should get the rect redrawn in a later frame.
     * `fresh` is set when this paint took a new copy. With `keep`, the last
     * copy is drawn with even when the clip covers the rect.
     */
    take(actor, root, paintContext, stageRect, keep = false) {
        const view = StageCopier.liveView(actor, paintContext);
        if (!view) {
            this.offStageCount++;
            return { copy: this.lastCopy, missed: false, fresh: false };
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
        if (!(x1 > x0) || !(y1 > y0))
            return { copy, missed: false, fresh: false };
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
        if (!(fx1 > fx0) || !(fy1 > fy0))
            return { copy, missed: false, fresh: false };
        const rect = [(fx0 - ox) / scale, (fy0 - oy) / scale, (fx1 - ox) / scale, (fy1 - oy) / scale];
        const clip = paintContext.get_redraw_clip();
        const clipX = Math.floor(rect[0]);
        const clipY = Math.floor(rect[1]);
        const inClip = !clip || clip.contains_rectangle(new Mtk.Rectangle({
            x: clipX, y: clipY, width: Math.ceil(rect[2]) - clipX, height: Math.ceil(rect[3]) - clipY,
        })) === Mtk.RegionOverlap.IN;
        if (!inClip) {
            if (copy?.rect) {
                this.reuseCount++;
                return { copy, missed: false, fresh: false };
            }
            this.missCount++;
            return { copy: null, missed: true, fresh: false };
        }
        const format = fb instanceof Cogl.Offscreen ? offscreenFormat(fb) : null;
        copy = this._target(view, copy, fx1 - fx0, fy1 - fy0, format);
        if (!copy)
            return { copy: null, missed: false, fresh: false };
        addBlit(root, fb, copy.framebuffer, view.color_state, [fx0, fy0, fx1 - fx0, fy1 - fy0]);
        copy.rect = rect;
        copy.serial = ++this._serial;
        this.lastCopy = copy;
        this.copyCount++;
        return { copy, missed: false, fresh: true };
    }

    _target(view, copy, width, height, format) {
        if (copy && copy.width === width && copy.height === height && copy.format === format)
            return copy;
        const target = createTarget(width, height, format, this._logger);
        if (!target)
            return null;
        const next = { ...target, width, height, format, rect: null, serial: 0 };
        this._copies.set(view, next);
        return next;
    }

    // Drops the copies of views the actor is no longer on.
    prune(views) {
        for (const view of this._copies.keys()) {
            if (!views.includes(view))
                this._copies.delete(view);
        }
    }

    clear() {
        this._copies.clear();
        this.lastCopy = null;
    }
}
