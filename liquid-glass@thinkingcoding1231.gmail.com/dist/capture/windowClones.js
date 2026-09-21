import { isCullSiteEnabled } from './options.js';
import { createBackgroundMirror } from './background.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import { isActorValid } from '../actors/lifecycle.js';
import { setTranslationIfChanged, setClipIfChanged, setCloneCulled, setSizeIfChanged, setScaleIfChanged, setPivotIfChanged, setOpacityIfChanged, isDiffWritesEnabled } from '../actors/writes.js';
import { getNestedGlassFix, innerGlassEffectOf } from './nestedGlass.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './windowCulling.js';
import { getWindowActors } from '../actors/windows.js';
import { getAllocatedSize, rectsIntersect } from '../actors/geometry.js';
import { setActorVisible } from '../actors/allocation.js';
export class WindowCloneManager {
    // [PERF ①b] See setCullRect(). Null until a manager hands one over, so a
    // caller that never calls setCullRect() keeps the old behaviour exactly.
    _cullRect = null;
    windowClonesContainer = null;
    _windowClones;
    // [nested-glass] MetaWindowActor::damaged handlers on the cloned windows
    // that own a glass. See NestedGlassFix and _syncDamageHooks().
    _damageHooks = new Map();
    // [black-frame] A BackgroundMirror, or (A/B off) an UnpickableClone of
    // _backgroundGroup. Typed as the common base so either fits.
    bgClone = null;
    container = null;
    cloneContainer = null;
    // Prefix for every actor this manager creates. Clutter's own diagnostics
    // print an actor's NAME — "Can't update stage views actor <name> ... needs
    // an allocation" is the one warning that reliably accompanies the
    // "clone stuck at an old position" bug, and it read "unnamed" for every
    // clone in this file, which made it useless for telling the dock's clones
    // apart from a menu's or from ApplicationManager's. Everything is named now.
    label;
    constructor(container, cloneContainer = null, label = 'lg') {
        this.container = container;
        this.label = label;
        this._windowClones = new Map();
        // [black-frame] Not a Clone of _backgroundGroup any more — see
        // BackgroundMirror for why cloning it made the wallpaper paint only
        // inside the current frame's damage region.
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        this.cloneContainer = cloneContainer;
        // windowClonesContainer can only have one parent, so it's added either
        // to cloneContainer or to container directly — never both. As long as
        // cloneContainer is added to container after bgClone, the intended
        // z-order (bgClone behind, window clones in front) holds regardless.
        if (this.cloneContainer) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        // bgClone (the wallpaper) always sits at the very back of container.
        this.container.insert_child_at_index(this.bgClone, 0);
    }
    rebuildClones() {
        if (!isActorValid(this.container))
            return;
        if (isActorValid(this.bgClone)) {
            this.bgClone.destroy();
        }
        if (isActorValid(this.windowClonesContainer)) {
            this.windowClonesContainer.destroy();
        }
        // destroy() above fires each clone's 'destroy' handler, which prunes
        // _windowClones — but a clone whose handler never ran (e.g. it was
        // already disposed) would leave a dead wrapper behind, so clear the map
        // outright rather than relying on that.
        this._windowClones.clear();
        // [black-frame] Not a Clone of _backgroundGroup any more — see
        // BackgroundMirror for why cloning it made the wallpaper paint only
        // inside the current frame's damage region.
        this.bgClone = createBackgroundMirror(`${this.label}-bgclone`);
        this.bgClone.connect('destroy', () => { this.bgClone = null; });
        this.windowClonesContainer = new UnpickableActor();
        this.windowClonesContainer.set_name(`${this.label}-window-clones`);
        this.windowClonesContainer.connect('destroy', () => { this.windowClonesContainer = null; });
        if (isActorValid(this.cloneContainer)) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        this.container.insert_child_at_index(this.bgClone, 0);
        this.sync();
    }
    // Shifts the entire clone subtree within the full-screen FBO.
    //
    // In the full-screen-FBO architecture, the caller (dockManager) passes
    // (-monitor.x, -monitor.y) rather than the dock's own (-bgX, -bgY).
    //
    // Rationale: clones sit at their absolute screen coordinates (w.x, w.y).
    // blurBox/liquidBox start at (0,0) inside bgActor, which itself sits at
    // (monitor.x, monitor.y). Offsetting this container by
    // (-monitor.x, -monitor.y) makes each clone's net screen position:
    //   monitor.x + 0 + (-monitor.x + w.x) = w.x  ✓
    setOffset(x, y) {
        // Translation, not position, for the same reason as the clones
        // themselves (see sync()): a container shifted by an allocation can be
        // starved along with everything under it.
        if (this.windowClonesContainer) {
            if (this.windowClonesContainer.x !== 0 || this.windowClonesContainer.y !== 0)
                this.windowClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this.windowClonesContainer, x, y);
        }
        if (this.bgClone) {
            if (this.bgClone.x !== 0 || this.bgClone.y !== 0)
                this.bgClone.set_position(0, 0);
            setTranslationIfChanged(this.bgClone, x, y);
        }
    }
    /**
     * [PERF ①b] Screen-coordinate rect this glass can actually show, or null
     * for "draw every window". See the long note on setCaptureClipEnabled().
     */
    setCullRect(rect) {
        this._cullRect = rect;
    }
    /**
     * [PERF ①] Clips the wallpaper clone.
     *
     * bgClone is inserted into `container` (liquidBox) rather than into
     * `cloneContainer` — see rebuildClones(), where it is deliberately put at
     * index 0 of the container so it sits behind everything. So the clip that
     * syncGlassCaptureClip() applies to the clone container does NOT reach it,
     * and the wallpaper is the single biggest full-screen quad in the capture.
     *
     * `rect` is in SCREEN coordinates, not shader space: setOffset() gives
     * bgClone translation (-monitorX, -monitorY) and leaves its position at
     * (0, 0), so a point at bgClone-local p paints at liquidBox-local
     * p - monitorOrigin, i.e. at screen p. Clutter applies the clip inside the
     * actor's own transform (clutter-actor.c:3570: the clip node is a CHILD of
     * the transform node), so the rect is read in exactly that local space.
     */
    applyBgCloneClip(rect) {
        const bg = this.bgClone;
        if (!bg || !isActorValid(bg))
            return;
        if (rect) {
            setClipIfChanged(bg, rect[0], rect[1], rect[2], rect[3]);
        }
        else if (bg._lgClipW !== undefined) {
            bg._lgClipW = undefined;
            try {
                bg.remove_clip();
            }
            catch (_) { }
        }
    }
    /**
     * The nested-glass repair, for every glass that is not an application
     * window's — the dock, the menus, notifications, the OSD, quick settings.
     *
     * They clone windows exactly like ApplicationManager does, so they take the
     * same damage: a cloned window that owns a glass drags its offscreen effect
     * in, and this glass's capture is blanked the moment that inner effect
     * re-renders. It shows up as "the area outside the black ring goes black
     * for an instant whenever a menu or the dock appears".
     *
     * MetaWindowActor::damaged runs while damage is being processed, before the
     * frame clock paints, so marking this glass dirty from it lands on the same
     * frame the inner effect re-renders — see ApplicationManager's copy for the
     * measurements behind choosing this over the other two repairs.
     */
    _syncDamageHooks() {
        const container = this.container;
        if (getNestedGlassFix() !== 'damage' || !container || !isActorValid(container)) {
            this._releaseDamageHooks();
            return;
        }
        for (const src of this._windowClones.keys()) {
            if (this._damageHooks.has(src))
                continue;
            if (!isActorValid(src) || !innerGlassEffectOf(src))
                continue;
            try {
                const id = src.connect('damaged', () => {
                    if (isActorValid(container) && container.mapped && container.visible)
                        container.queue_redraw();
                });
                this._damageHooks.set(src, id);
            }
            catch (_) { /* a source that cannot be connected simply goes unhooked */ }
        }
        if (this._damageHooks.size > this._windowClones.size) {
            for (const [src, id] of [...this._damageHooks]) {
                if (this._windowClones.has(src))
                    continue;
                try {
                    if (isActorValid(src))
                        src.disconnect(id);
                }
                catch (_) { }
                this._damageHooks.delete(src);
            }
        }
    }
    _releaseDamageHooks() {
        if (this._damageHooks.size === 0)
            return;
        for (const [src, id] of this._damageHooks) {
            try {
                if (isActorValid(src))
                    src.disconnect(id);
            }
            catch (_) { }
        }
        this._damageHooks.clear();
    }
    sync() {
        this._syncDamageHooks();
        // [window-clone-clip] Keep the cull opt-out in step with what we clone.
        // reportClonedWindowActors() diffs first, so this is a set comparison over
        // a handful of actors on a normal frame.
        reportClonedWindowActors(this, this._windowClones.keys());
        let windows = getWindowActors();
        let activeWindows = new Set();
        let zIndex = 0;
        // Nothing below may throw out of here. sync() is the tail of every
        // manager's per-frame BEFORE_REDRAW tick, and a single disposed actor
        // used to take the whole tick — and with it that glass instance's
        // reschedule — down with it (see reportFrameLoopError).
        if (!isActorValid(this.windowClonesContainer))
            return;
        for (let w of windows) {
            if (!isActorValid(w))
                continue;
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible)
                continue;
            // Read position/size directly rather than via the more expensive
            // get_transformed_position(). Size comes from the allocation, not
            // w.width/w.height: those fall back to the preferred size while a
            // relayout is pending, and a bogus 0 here would `continue` past the
            // window and destroy its clone for a frame (see getAllocatedSize).
            let [width, height] = getAllocatedSize(w);
            if (width <= 0 || height <= 0)
                continue;
            // The clone is placed at the window's own screen position (see the
            // long note further down), so the source rect below is already in the
            // same space as _cullRect.
            const wX = w.x + w.translation_x;
            const wY = w.y + w.translation_y;
            // [PERF ①b] A window that does not overlap the rect this glass can
            // show contributes nothing to the capture — the clip (and, for
            // applicationManager, clipBox's clip_to_allocation) would throw away
            // every one of its pixels anyway. Hiding the clone instead of merely
            // scissoring it is what makes the difference: clutter_actor_paint()
            // returns immediately for an invisible actor, so the source is never
            // painted through this clone, and if that source is a window with its
            // own glass, ITS capture/blur/composite does not run either.
            //
            // Still counted as active: the clone stays alive and correctly placed,
            // it is only culled, so nothing has to be rebuilt when the window comes
            // back into range.
            activeWindows.add(w);
            const sxSafe = Number.isFinite(w.scale_x) && w.scale_x > 0 ? w.scale_x : 1;
            const sySafe = Number.isFinite(w.scale_y) && w.scale_y > 0 ? w.scale_y : 1;
            // [FIX ①b] The cull decision is taken here but ACTED ON below, after
            // the clone exists and has been given its stacking index.
            //
            // The first cut skipped the whole iteration with `continue`, which had
            // two consequences that turned out to matter more than the work it
            // saved:
            //
            //   * a window that was culled before its clone existed never got one,
            //     so every crossing of a glass boundary destroyed and rebuilt a
            //     clone — and a brand new Clutter actor is visible=false and
            //     unallocated, i.e. exactly the state in which
            //     _clutter_actor_queue_redraw_full() throws its damage away
            //     (clutter-actor.c:7674). Inside a ClutterOffscreenEffect that is
            //     not cosmetic: the capture FBO is only re-rendered when the glass
            //     actor is dirty (clutter-offscreen-effect.c:569), so lost damage
            //     means the glass keeps showing a stale capture.
            //
            //   * zIndex was not advanced for culled windows, so every cull and
            //     un-cull renumbered the whole stack and set_child_at_index() ran
            //     on clones that had not moved.
            //
            // Now the clone is always built, always placed and always indexed; the
            // only thing the cull changes is whether it gets painted. That is where
            // the saving was anyway — an opacity-0 clone never paints its source,
            // so the nested glass inside that source never runs.
            const culled = !!this._cullRect && isCullSiteEnabled('windows') &&
                !rectsIntersect(wX, wY, width * sxSafe, height * sySafe, this._cullRect);
            let clone = this._windowClones.get(w);
            // A clone can be destroyed out from under this map — its container is
            // torn down and rebuilt by rebuildClones(), and Clutter destroys
            // children with their parent. Touching the stale wrapper throws, so
            // treat a dead entry as "no clone" and build a fresh one.
            if (clone && !isActorValid(clone)) {
                this._windowClones.delete(w);
                clone = undefined;
            }
            if (!clone) {
                clone = new UnpickableClone({ source: w });
                const wTitle = (() => {
                    try {
                        return metaWindow.get_title() || '(untitled)';
                    }
                    catch (_) {
                        return '(?)';
                    }
                })();
                clone.set_name(`${this.label}-winclone:${wTitle}`);
                clone.connect('destroy', () => { this._windowClones.delete(w); });
                this.windowClonesContainer?.add_child(clone);
                this._windowClones.set(w, clone);
            }
            // [PERF ①b] Map the clone first — an unmapped actor cannot even report
            // damage — then apply this frame's cull decision. setCloneCulled() is
            // a no-op when the state has not changed.
            setActorVisible(clone, true);
            setCloneCulled(clone, culled, culled
                ? `src=(${Math.round(wX)},${Math.round(wY)},${Math.round(width * sxSafe)}x${Math.round(height * sySafe)}) ` +
                    `cullRect=[${this._cullRect.map(Math.round)}] label=${this.label}`
                : `label=${this.label}`);
            // [PERF] The WRITES below are now conditional (see
            // setTranslationIfChanged), but these removals stay unconditional on
            // purpose: removing a transition that does not exist is a hash lookup
            // that queues no damage, whereas leaving a live transition in place
            // while the write is skipped would let the transition keep driving the
            // property and desync the cache from the actor.
            const tX = wX;
            const tY = wY;
            const pX = w.pivot_point ? w.pivot_point.x : 0;
            const pY = w.pivot_point ? w.pivot_point.y : 0;
            clone.remove_transition('position');
            clone.remove_transition('size');
            clone.remove_transition('translation-x');
            clone.remove_transition('translation-y');
            // [FIX] Place the clone with translation_x/y, NOT set_position().
            //
            // set_position() only moves the actor once Clutter has run a relayout
            // and handed it a new allocation. translation is a paint-time
            // transform: it needs a redraw and nothing else. Clutter adds the two
            // together in exactly the same place —
            //     translate(allocation.x1 + translation_x, ...)
            // happens before the pivot/scale block — so this is arithmetically
            // identical while depending on strictly less machinery.
            //
            // Why it matters: the Looking Glass audit caught this clone with
            //     pos=(507,89)      <- set_position() had been applied, correctly
            //     screen=(642,767)  <- the allocation, hundreds of px out of date
            //     hasAlloc=false
            // and the same for every ancestor up to the glass root, i.e. the
            // subtree had stopped receiving allocations while our per-frame sync
            // went on setting the property. Everything downstream of that reads
            // the allocation, so the clone painted where the window used to be.
            //
            // The decisive contrast is in the same audit: ApplicationManager's
            // per-window glass, which has always placed its clones with
            // translation and pins x/y at 0, was completely healthy in the very
            // same snapshot (DELTA=(0,0), hasAlloc=true everywhere). Positioning
            // that cannot be starved by the layout system does not go stale.
            if (clone.x !== 0 || clone.y !== 0)
                clone.set_position(0, 0);
            setTranslationIfChanged(clone, tX, tY);
            setSizeIfChanged(clone, width, height);
            clone.remove_transition('scale-x');
            clone.remove_transition('scale-y');
            setScaleIfChanged(clone, w.scale_x, w.scale_y);
            setPivotIfChanged(clone, pX, pY);
            // Clutter.Clone paints its source with the clone's own opacity, not
            // the source's — so without this the glass shows a window at full
            // opacity for the whole of GNOME's map/destroy animation, which eases
            // MetaWindowActor.opacity from 0 (and back) while scale animates.
            // That is the "the clone is offset/too solid during the open and
            // close animation" artifact: the geometry follows the animation but
            // the fade does not.
            setOpacityIfChanged(clone, w.opacity);
            // [PERF] set_child_at_index() unparents and re-adds the child, which
            // queues a relayout on the container even when the index is the one
            // it already has — i.e. it damaged the whole glass every frame all by
            // itself. The stacking order only changes on a restack.
            //
            // Culled clones are indexed too (zIndex advances for them below), so
            // the numbering does not shift every time one is culled.
            if (!isDiffWritesEnabled() || clone._lgZIndex !== zIndex) {
                clone._lgZIndex = zIndex;
                this.windowClonesContainer?.set_child_at_index(clone, zIndex);
            }
            zIndex++;
        }
        // Remove clones for windows that closed, or all of them when the
        // Overview starts.
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                if (isActorValid(clone))
                    clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }
    destroy() {
        // First: these live on Mutter's own window actors, which outlive this
        // manager. A missed disconnect keeps the closure, and the container with
        // it, alive against a destroyed glass.
        this._releaseDamageHooks();
        // Same reasoning: the opt-out effects sit on Mutter's window actors.
        releaseClonedWindowActors(this);
        if (isActorValid(this.windowClonesContainer)) {
            try {
                this.windowClonesContainer.destroy();
            }
            catch (_) { /* noop */ }
        }
        this._windowClones.clear();
        if (isActorValid(this.bgClone)) {
            try {
                this.bgClone.destroy();
            }
            catch (_) { /* noop */ }
        }
        this.container = null;
    }
}
