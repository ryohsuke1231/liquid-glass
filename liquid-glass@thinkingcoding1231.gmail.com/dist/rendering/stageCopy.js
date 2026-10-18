// Copies a rect of a stage view's framebuffer while the stage is painted.
// Everything painted before the copying actor is in the framebuffer by the
// time its paint nodes run. Only the frame's redraw clip holds current pixels,
// though; outside it the framebuffer still has the previous frame. So a copy
// is taken only when the clip contains the whole rect, and reused otherwise.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Mtk from 'gi://Mtk';
import { coglContext, newRootNode, offscreenFormat } from '../shellVersion.js';
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
    static liveView(actor, fb) {
        if (actor.is_in_clone_paint())
            return null;
        for (const view of actor.peek_stage_views()) {
            if (view.get_framebuffer() === fb)
                return view;
        }
        return null;
    }
    /**
     * The copy to draw with for this paint of `actor`: a new one of the stage
     * rect `stageRect` [x0, y0, x1, y1] when the clip covers it, otherwise the
     * last one taken on this view. `missed` is set when there is nothing to
     * draw with yet; the caller should get the rect redrawn in a later frame.
     */
    take(actor, root, paintContext, stageRect) {
        const fb = paintContext.get_framebuffer();
        const view = StageCopier.liveView(actor, fb);
        if (!view) {
            this.offStageCount++;
            return { copy: this.lastCopy, missed: false };
        }
        let copy = this._copies.get(view) ?? null;
        const layout = view.layout;
        const x0 = Math.max(stageRect[0], layout.x);
        const y0 = Math.max(stageRect[1], layout.y);
        const x1 = Math.min(stageRect[2], layout.x + layout.width);
        const y1 = Math.min(stageRect[3], layout.y + layout.height);
        if (!(x1 > x0) || !(y1 > y0))
            return { copy, missed: false };
        // Stage to framebuffer pixels, as Clutter lays the stage out on a view.
        const scale = view.get_scale();
        const ox = Math.round(-layout.x * scale);
        const oy = Math.round(-layout.y * scale);
        const fx0 = Math.floor(x0 * scale) + ox;
        const fy0 = Math.floor(y0 * scale) + oy;
        const fx1 = Math.ceil(x1 * scale) + ox;
        const fy1 = Math.ceil(y1 * scale) + oy;
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
                return { copy, missed: false };
            }
            this.missCount++;
            return { copy: null, missed: true };
        }
        const format = fb instanceof Cogl.Offscreen ? offscreenFormat(fb) : null;
        copy = this._target(view, copy, fx1 - fx0, fy1 - fy0, format);
        if (!copy)
            return { copy: null, missed: false };
        addBlit(root, fb, copy.framebuffer, view.color_state, [fx0, fy0, fx1 - fx0, fy1 - fy0]);
        copy.rect = rect;
        copy.serial = ++this._serial;
        this.lastCopy = copy;
        this.copyCount++;
        return { copy, missed: false };
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
