// Quick Settings' toggle mode puts a piece of glass behind each toggle, inside
// the menu: over the panel's own background and under the toggles' labels.
// The menu (a BoxPointer) is always drawn through an offscreen, where the
// glass cannot read the stage, so the work is split in two:
//
// - BackdropReader sits outside the menu, just below it in uiGroup. It draws
//   nothing; it copies the stage behind the toggles while the stage is
//   painted, before the menu is.
// - ToggleBackdropGlass sits inside the menu. It copies the panel background
//   already drawn into the menu's offscreen, lays it over the reader's copy,
//   blurs that and draws the toggles' glass.
//
// The glass holds the relays. A change behind the toggles then both puts the
// area into the redraw clip, so the reader copies it, and dirties the menu,
// whose offscreen would otherwise be reused without painting the glass.
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import { GlassActor } from './backdropGlass.js';
import { StageCopier, addBlit, createTarget } from './stageCopy.js';
import { RelaySet, localToStage } from './relays.js';
import { configureSamplerLayer } from './pipelines.js';
import { setTranslationIfChanged, setScaleIfChanged } from '../actors/writes.js';
import { isActorValid } from '../actors/lifecycle.js';
import { offscreenFormat, paintNodeWithContext, setUniformVector, uniformDeclarations } from '../shellVersion.js';
// The reader's fixed size; it is fitted to its rect by translation and scale
// for the same reason as the sample area (relays.ts).
const READER_BASE = 256;

export const BackdropReader = GObject.registerClass(paintNodeWithContext(class BackdropReader extends Clutter.Actor {
    _init(logger) {
        super._init({ name: 'liquid-glass-backdrop-reader', reactive: false, width: READER_BASE, height: READER_BASE });
        Shell.util_set_hidden_from_pick(this, true);
        this.copier = new StageCopier(logger);
        this._rect = null;
    }

    vfunc_pick(_pickContext) {
    }

    // The stage rect [x0, y0, x1, y1] to copy. The actor covers it, so it is
    // painted whenever the rect is redrawn.
    setStageRect(rect) {
        // The glass maps its rect through its own transform, which is not
        // finite before its first allocation.
        if (!rect.every(Number.isFinite))
            return;
        this._rect = rect;
        const parent = this.get_parent();
        if (!parent)
            return;
        const [ok0, x0, y0] = parent.transform_stage_point(rect[0], rect[1]);
        const [ok1, x1, y1] = parent.transform_stage_point(rect[2], rect[3]);
        if (!ok0 || !ok1 || ![x0, y0, x1, y1].every(Number.isFinite))
            return;
        setTranslationIfChanged(this, x0, y0);
        setScaleIfChanged(this, Math.max(x1 - x0, 1) / READER_BASE, Math.max(y1 - y0, 1) / READER_BASE);
    }

    vfunc_paint_node(root, paintContext) {
        if (this._rect)
            this.copier.take(this, root, paintContext, this._rect);
    }
}));

// "Over" for premultiplied colors: the panel material (layer 1) over the
// desktop (layer 0). Each layer has its own rect within the composed quad.
const COMPOSE_DECL = 'uniform vec4 d_rect;\nuniform vec4 m_rect;\n';
const COMPOSE_BODY = 'vec2 uv = cogl_tex_coord_in[0].st;\n' +
    'vec4 d = texture2D(cogl_sampler0, mix(d_rect.xy, d_rect.zw, uv));\n' +
    'vec4 m = texture2D(cogl_sampler1, mix(m_rect.xy, m_rect.zw, uv));\n' +
    'cogl_color_out = m + d * (1.0 - m.a);\n';

export const ToggleBackdropGlass = GObject.registerClass(paintNodeWithContext(class ToggleBackdropGlass extends GlassActor {
    _init(params = {}) {
        super._init(params);
        this.reader = new BackdropReader(params.logger);
        this.reader.hide();
        this._relays = new RelaySet(this, actor => actor === this.reader);
        this._wasPainted = false;
        this._material = null;
        this._materialUV = null;
        this._materialCopies = 0;
        this._composed = null;
        this._composeSerial = 0;
        this._composeBase = null;
    }

    // The reader works only while the glass is shown, and nothing behind it
    // was tracked while it was hidden.
    vfunc_map() {
        super.vfunc_map();
        this.reader.show();
        this._relays.redrawArea();
    }

    vfunc_unmap() {
        this.reader.hide();
        super.vfunc_unmap();
    }

    _onShadersLoaded() {
        super._onShadersLoaded();
        this._relays.redrawArea();
    }

    /** See BackdropGlass.syncSources(); also places the reader. */
    syncSources() {
        const area = this._sampleAreaRect();
        if (!area)
            return;
        const changed = this._relays.sync(area);
        this.reader.setStageRect(localToStage(this, area[0], area[1], area[0] + area[2], area[1] + area[3]));
        const painted = this.get_paint_opacity() > 0;
        if (changed || (painted && !this._wasPainted))
            this._relays.redrawArea();
        this._wasPainted = painted;
        this.reader.copier.prune(this.reader.peek_stage_views());
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
        const local = [s[0] * kx, s[1] * ky, (s[0] + s[2]) * kx, (s[1] + s[3]) * ky];
        const desktop = this.reader.copier.lastCopy;
        if (!desktop?.rect) {
            // Nothing copied yet; the next frame redraws the whole area.
            this._relays.redrawArea();
            return;
        }
        this._takeMaterial(root, paintContext, local);
        if (!this._material || !this._materialUV)
            return;
        const composed = this._compose(root, ctx, desktop.texture, desktop.rect, local);
        if (!composed)
            return;
        this._runBlur(root, ctx, composed.texture, s, [composed.texture, this._composeSerial]);
        const compositeRect = this._composite(root, composed.texture, s, kx, ky, resW, resH);
        this._snapshot(() => {
            const round = (v) => +v.toFixed(2);
            return {
                mode: 'toggle-backdrop',
                desktop: `${desktop.width}x${desktop.height}`,
                desktopStageRect: desktop.rect?.map(round) ?? null,
                material: `${this._material.width}x${this._material.height}`,
                blurRect: s.map(round),
                compositeRect: compositeRect.map(round),
            };
        });
    }

    // The nearest ancestor drawn through an offscreen: the menu's BoxPointer.
    _offscreenAncestor() {
        for (let a = this.get_parent(); a; a = a.get_parent()) {
            if (a.get_offscreen_redirect() & Clutter.OffscreenRedirect.ALWAYS)
                return a;
        }
        return null;
    }

    /**
     * Copies the panel background behind `local` [x0, y0, x1, y1] out of the
     * menu's offscreen, which at this point holds everything the menu drew
     * before the glass. ClutterOffscreenEffect renders the actor in its own
     * coordinates, offset by its enlarged paint box and scaled by the ceiled
     * resource scale; the same arithmetic finds the rect in the offscreen.
     * Any other paint (on stage, in a clone) keeps the last copy.
     */
    _takeMaterial(root, paintContext, local) {
        const fb = paintContext.get_framebuffer();
        if (this.is_in_clone_paint() || !(fb instanceof Cogl.Offscreen) || StageCopier.liveView(this, fb))
            return;
        const menu = this._offscreenAncestor();
        const pv = menu?.get_paint_volume();
        if (!menu || !pv)
            return;
        // _clutter_actor_box_enlarge_for_effects()
        const origin = pv.get_origin();
        const width = Math.round(pv.get_width());
        const height = Math.round(pv.get_height());
        const offX = Math.trunc(Math.ceil(origin.x + pv.get_width() + 0.75) - width - 3);
        const offY = Math.trunc(Math.ceil(origin.y + pv.get_height() + 0.75) - height - 3);
        const cs = menu.get_resource_scale();
        const a = this.apply_relative_transform_to_point(menu, new Graphene.Point3D({ x: local[0], y: local[1], z: 0 }));
        const b = this.apply_relative_transform_to_point(menu, new Graphene.Point3D({ x: local[2], y: local[3], z: 0 }));
        const sx0 = (Math.min(a.x, b.x) - offX) * cs;
        const sy0 = (Math.min(a.y, b.y) - offY) * cs;
        const sx1 = (Math.max(a.x, b.x) - offX) * cs;
        const sy1 = (Math.max(a.y, b.y) - offY) * cs;
        const fx0 = Math.max(0, Math.floor(sx0));
        const fy0 = Math.max(0, Math.floor(sy0));
        const fx1 = Math.min(fb.get_width(), Math.ceil(sx1));
        const fy1 = Math.min(fb.get_height(), Math.ceil(sy1));
        const w = fx1 - fx0;
        const h = fy1 - fy0;
        if (!(w >= 1) || !(h >= 1))
            return;
        if (!this._material || this._material.width !== w || this._material.height !== h) {
            const target = createTarget(w, h, offscreenFormat(fb), this._logger);
            this._material = target ? { ...target, width: w, height: h } : null;
            if (!this._material)
                return;
        }
        addBlit(root, fb, this._material.framebuffer, this.color_state, [fx0, fy0, w, h]);
        this._materialUV = [(sx0 - fx0) / w, (sy0 - fy0) / h, (sx1 - fx0) / w, (sy1 - fy0) / h];
        this._materialCopies++;
    }

    // The material over the desktop, for the blur, at the material's
    // resolution and covering exactly the sample rect `local`.
    _compose(root, ctx, desktop, desktopRect, local) {
        const material = this._material;
        const w = material.width;
        const h = material.height;
        if (!this._composed || this._composed.width !== w || this._composed.height !== h) {
            const target = createTarget(w, h, null, this._logger);
            this._composed = target ? { ...target, width: w, height: h } : null;
            if (!this._composed)
                return null;
        }
        if (!this._composeBase) {
            this._composeBase = Cogl.Pipeline.new(ctx);
            configureSamplerLayer(this._composeBase, 0);
            configureSamplerLayer(this._composeBase, 1);
            const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(COMPOSE_DECL), null);
            snippet.set_replace(COMPOSE_BODY);
            this._composeBase.add_snippet(snippet);
        }
        const pipeline = this._renderer.passes.pipeline('toggle-compose', this._composeBase);
        pipeline.set_layer_texture(0, desktop);
        pipeline.set_layer_texture(1, material.texture);
        // Where the sample rect lies in the desktop copy, by stage position.
        const st = localToStage(this, local[0], local[1], local[2], local[3]);
        const dw = desktopRect[2] - desktopRect[0];
        const dh = desktopRect[3] - desktopRect[1];
        setUniformVector(pipeline, 'd_rect', [
            (st[0] - desktopRect[0]) / dw, (st[1] - desktopRect[1]) / dh,
            (st[2] - desktopRect[0]) / dw, (st[3] - desktopRect[1]) / dh,
        ]);
        setUniformVector(pipeline, 'm_rect', this._materialUV);
        this._renderer.passes.add(root, this._composed.framebuffer, pipeline, w, h, [0, 0, 1, 1]);
        this._composeSerial++;
        return this._composed;
    }

    /** Counters for the test driver and the dump. */
    get stats() {
        const c = this.reader.copier;
        return {
            paints: this._paints, copies: c.copyCount, reuses: c.reuseCount, misses: c.missCount,
            offStage: c.offStageCount, materialCopies: this._materialCopies,
        };
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

    // The reader lives outside the glass (in uiGroup), so it goes here; at
    // shell shutdown the stage may have destroyed it already.
    cleanup() {
        super.cleanup();
        this._relays.clear();
        this.reader.copier.clear();
        if (isActorValid(this.reader))
            this.reader.destroy();
        this._material = null;
        this._composed = null;
        this._composeBase = null;
    }
}));
