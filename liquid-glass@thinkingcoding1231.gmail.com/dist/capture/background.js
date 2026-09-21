import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { utilsLog } from '../diagnostics/logging.js';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
import Shell from 'gi://Shell';
import { UnpickableClone } from '../actors/unpickable.js';
/**
 * [black-frame] Stand-in for
 *   `new UnpickableClone({ source: Main.layoutManager._backgroundGroup })`
 * that renders the wallpaper WITHOUT going through Clutter.Clone.
 *
 * WHY THIS EXISTS — the "black frame" bug
 * ---------------------------------------
 * `MetaBackgroundContent` (the ClutterContent that actually paints the
 * wallpaper) culls itself against two regions that mutter stores ON THE
 * CONTENT OBJECT itself — mutter 50.1,
 * src/compositor/meta-background-content.c:
 *
 *   clip_region       the CURRENT FRAME'S DAMAGE REGION. Pushed down by
 *                     meta_window_group_paint() ->
 *                     meta_cullable_cull_redraw_clip() immediately before
 *                     the window group paints its children, and reset to
 *                     NULL immediately after.
 *   unobscured_region what is left of the wallpaper after the opaque
 *                     windows above it subtract themselves.
 *
 * meta_background_content_paint_content() applies BOTH unconditionally —
 * including while it runs inside a Clutter.Clone's paint. It even has an
 * explicit `clutter_actor_is_in_clone_paint()` branch, and that branch
 * still intersects with clip_region:
 *
 *     if (self->clip_region && mtk_region_is_empty (self->clip_region))
 *       return;                                      // paints NOTHING
 *     ...
 *     if (clutter_actor_is_in_clone_paint (actor))
 *       untransformed = FALSE;
 *     ...
 *     if (self->clip_region) {
 *       region = mtk_region_copy (self->clip_region);
 *       mtk_region_intersect_rectangle (region, &rect_within_actor);
 *     }
 *     ...
 *     if (self->unobscured_region)
 *       mtk_region_intersect (region, self->unobscured_region);
 *
 * A Clone paints its SOURCE actor, so it uses the SOURCE's content object —
 * which means a clone of _backgroundGroup inherits the real wallpaper's
 * per-frame culling state wholesale. In one sentence:
 *
 *   The wallpaper inside our glass only painted where THIS FRAME happened
 *   to be damaged.
 *
 * That is the whole bug. When a window behind the glass repaints on its own
 * (a system monitor, a terminal, a video), the frame's damage region is just
 * that window's rectangle. Any glass that re-captures its
 * ClutterOffscreenEffect FBO on that frame therefore captures the wallpaper
 * ONLY inside that rectangle and black everywhere else. Because
 * ClutterOffscreenEffect caches the FBO, the black then LATCHES until
 * something forces a full re-capture.
 *
 * Which is exactly the reported symptom, down to the details:
 *   - a bright rectangle around the updating background window, the rest of
 *     the glass filled flat (the tint over black);
 *   - a ~padding-wide gradient ring, darkening outwards, where the blur
 *     smears that black inwards from the FBO edge;
 *   - dump() / queue_redraw() / opening a menu clears it, because they force
 *     a full-screen damage and therefore a full, correct re-capture;
 *   - no reproduction steps, because it depends on which rectangle of the
 *     screen happened to be damaged on the frame the FBO was captured.
 *
 * THE FIX — and why it MUST still be painted through a Clone
 * ----------------------------------------------------------
 * Own the content, then clone OUR content. Both halves are required.
 *
 * Half 1: build our OWN Meta.BackgroundActor for each of the shell's,
 * sharing the same Meta.Background (no second wallpaper decode, no extra
 * texture) but carrying its own MetaBackgroundContent. Our actors hang off
 * a plain Clutter.Actor outside the window group, and
 * cull_out_children_common() in meta-cullable.c stops at any child that is
 * not a MetaCullable:
 *
 *     if (!META_IS_CULLABLE (child))
 *       continue;
 *
 * so our content's clip_region and unobscured_region stay NULL forever.
 *
 * Half 2 — THE PART THE FIRST ATTEMPT MISSED. Killing clip_region is not
 * enough, because paint_content has a SECOND clip and it reads the damage
 * region straight off the paint context:
 *
 *     if (untransformed) {
 *         if (self->clip_region) { ... }
 *         else {
 *             redraw_clip = clutter_paint_context_get_redraw_clip (paint_context);
 *             if (redraw_clip) { region = copy (redraw_clip); ... }   // <-- still partial!
 *         }
 *     } else {
 *         if (self->clip_region) { ... }
 *         else
 *             region = mtk_region_create_rectangle (&rect_within_actor);  // <-- FULL
 *     }
 *
 * and clutter_paint_context_push_framebuffer() does NOT reset redraw_clip,
 * so inside a glass's offscreen FBO it is still the frame's stage damage.
 *
 * `untransformed` is true exactly when the actor's stage rect equals its own
 * content box — which is precisely the case for a wallpaper actor parked at
 * (0,0) at monitor size, i.e. ours. So painting our mirror DIRECTLY lands in
 * the redraw_clip branch and is clipped to the damage region anyway. That is
 * what the first attempt did, and it was strictly WORSE than the clone it
 * replaced: dock / menu / OSD glasses paint from uiGroup, OUTSIDE the window
 * group, where clip_region has already been reset to NULL — so their clones
 * used to paint in full. Measured on two screencasts of the same bug:
 * 8% of frames flat-filled before, 34% after.
 *
 * The `else` branch is unconditional and full, and the way into it is
 * `clutter_actor_is_in_clone_paint()`, which is ancestor-aware:
 *
 *     if (self->priv->in_clone_paint) return TRUE;
 *     ... walks priv->parent while in_cloned_branch != 0 ...
 *
 * So: keep ONE shared source actor holding our uncalled background contents,
 * and give every glass a Clutter.Clone of it. In the clone paint
 * untransformed is FALSE and clip_region is NULL, which is the one
 * combination that paints the whole wallpaper unconditionally.
 *
 * It also restores the shell's wallpaper cross-fade inside the glass for
 * free: the glass clones a GROUP holding both the outgoing and incoming
 * background actors at their live opacities, exactly as cloning
 * _backgroundGroup used to.
 */
export const BackgroundMirror = GObject.registerClass(class BackgroundMirror extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        this._mirrors = new Map();
        this._groupHandlers = [];
        this._sourceGroup = null;
        const group = Main.layoutManager?._backgroundGroup ?? null;
        if (!group)
            return;
        this._sourceGroup = group;
        this._groupHandlers.push(group.connect('child-added', (_g, child) => this._addMirror(child)), group.connect('child-removed', (_g, child) => this._removeMirror(child)), 
        // [wallpaper-ease] Reordering is NOT child-added/child-removed.
        //
        // BackgroundManager._createBackgroundActor() (js/ui/background.js)
        // does add_child() and then, immediately:
        //
        //     this._container.set_child_below_sibling(backgroundActor, null);
        //
        // and clutter_actor_set_child_below_sibling() re-links the child with
        // ADD_CHILD_NOTIFY_FIRST_LAST / REMOVE_CHILD_NOTIFY_FIRST_LAST —
        // single bits that notify first-child/last-child and deliberately do
        // NOT emit child-added/child-removed. So our restack ran while the new
        // wallpaper was still on top, and never ran again once the shell moved
        // it to the bottom.
        //
        // That inverted our stacking for the whole cross-fade: the shell fades
        // the OLD actor 255 -> 0 on top of the new one
        // (_swapBackgroundActor(), FADE_ANIMATION_TIME), so with our order
        // flipped the incoming wallpaper sat opaque ON TOP and the glass
        // simply snapped to it while the desktop faded correctly.
        group.connect('notify::first-child', () => this._restack()), group.connect('notify::last-child', () => this._restack()));
        this.connect('destroy', () => this._onDestroy());
        for (const child of group.get_children())
            this._addMirror(child);
    }
    // Every MetaBackgroundContent property worth mirroring. `background` is
    // the important one (it carries the wallpaper texture); the rest are what
    // the shell animates for the overview dim / login vignette, and mirroring
    // them keeps the glass consistent with the desktop underneath it.
    _contentProps() {
        return [
            'background',
            'brightness',
            'vignette',
            'vignette-sharpness',
            'gradient',
            'gradient-height',
            'gradient-max-darkness',
            'rounded-clip-radius',
        ];
    }
    _addMirror(child) {
        try {
            this._addMirrorUnsafe(child);
        }
        catch (e) {
            // A glass with a stale wallpaper is a cosmetic problem; a glass that
            // failed to build is a broken window. Never let this path throw into
            // ApplicationManager's actor construction.
            utilsLog(`[bg-mirror] _addMirror failed: ${e}`);
        }
    }
    _addMirrorUnsafe(child) {
        if (!child || this._mirrors.has(child))
            return;
        const srcContent = child.content;
        // Only MetaBackgroundActors carry a MetaBackgroundContent. Anything
        // else another extension parked in the background group is not ours
        // to reproduce, and cloning it would reintroduce the very coupling
        // this class exists to remove.
        if (!srcContent || !(srcContent instanceof Meta.BackgroundContent))
            return;
        let mirror;
        try {
            mirror = new Meta.BackgroundActor({
                meta_display: global.display,
                monitor: child.monitor,
                reactive: false,
            });
        }
        catch (e) {
            utilsLog(`[bg-mirror] could not create Meta.BackgroundActor: ${e}`);
            return;
        }
        mirror.set_name('lg-bg-mirror');
        // [CRASH] Start hidden, and stay hidden until the content actually has
        // a MetaBackground. This is not defensive padding — it is load-bearing.
        //
        // meta_background_get_texture() (mutter 50.1,
        // src/compositor/meta-background.c) reads self->display in its variable
        // declarations, i.e. BEFORE its own guard:
        //
        //     MetaContext *context = meta_display_get_context (self->display);
        //     ...
        //     g_return_val_if_fail (META_IS_BACKGROUND (self), NULL);
        //
        // so painting a MetaBackgroundContent whose background is NULL
        // dereferences NULL and takes the whole compositor down with SIGSEGV --
        // confirmed the hard way, a full session loss to greetd
        // (2026-09-17 20:42:59, org.gnome.Shell@ubuntu.service status=11/SEGV,
        // stack: clutter_frame_clock_dispatch -> clutter_stage_paint_view ->
        // ... -> clutter_actor_continue_paint -> libmutter).
        //
        // The shell adds a background actor to the group and assigns its
        // MetaBackground afterwards, so 'child-added' genuinely can reach us
        // with background == NULL. A hidden actor is never painted, so gating
        // visibility on it is what keeps that window closed.
        mirror.visible = false;
        const dstContent = mirror.content;
        if (dstContent) {
            for (const prop of this._contentProps()) {
                try {
                    srcContent.bind_property(prop, dstContent, prop, GObject.BindingFlags.SYNC_CREATE);
                }
                catch (e) {
                    // A property that does not exist on this mutter version is not
                    // fatal — the wallpaper itself ('background') is what matters.
                    utilsLog(`[bg-mirror] skipped content prop '${prop}': ${e}`);
                }
            }
            // Belt and braces: SYNC_CREATE should have carried the background
            // across already, but the whole class is worthless (and dangerous)
            // if it did not, so set it outright too.
            try {
                if (!dstContent.background && srcContent.background)
                    dstContent.set_background(srcContent.background);
            }
            catch (e) {
                utilsLog(`[bg-mirror] set_background failed: ${e}`);
            }
        }
        try {
            child.bind_property('opacity', mirror, 'opacity', GObject.BindingFlags.SYNC_CREATE);
        }
        catch (e) {
            utilsLog(`[bg-mirror] opacity binding failed: ${e}`);
        }
        // Visibility is computed rather than bound, because it has to answer to
        // the background-is-NULL gate above as well as to the real actor.
        const syncVisible = () => {
            if (!isActorValid(mirror))
                return;
            let hasBackground = false;
            try {
                hasBackground = !!(mirror.content && mirror.content.background);
            }
            catch (_) { /* noop */ }
            const wanted = hasBackground && isActorValid(child) && child.visible;
            if (mirror.visible !== wanted)
                mirror.visible = wanted;
        };
        const watchers = [];
        try {
            watchers.push([child, child.connect('notify::visible', syncVisible)]);
            // notify::first-child / last-child cannot see a reorder among MIDDLE
            // children, and the group holds two actors per monitor mid-fade. The
            // fade itself ticks opacity every frame, so piggyback on it; _restack()
            // compares before it writes, so the steady state costs one loop over
            // two or three actors.
            watchers.push([child, child.connect('notify::opacity', () => this._restack())]);
            if (dstContent)
                watchers.push([dstContent, dstContent.connect('notify::background', syncVisible)]);
        }
        catch (e) {
            utilsLog(`[bg-mirror] visibility watchers failed: ${e}`);
        }
        mirror.connect('destroy', () => {
            for (const [obj, id] of watchers) {
                try {
                    obj.disconnect(id);
                }
                catch (_) { /* noop */ }
            }
            watchers.length = 0;
        });
        syncVisible();
        // Geometry follows the real actor's allocation. Both live at the same
        // origin (the background group is at 0,0 and so are we), so a straight
        // BindConstraint is all that is needed — and it keeps tracking through
        // monitor changes without any signal bookkeeping of our own.
        mirror.set_position(child.x, child.y);
        mirror.set_size(child.width, child.height);
        // Four separate constraints, NOT BindCoordinate.ALL: Clutter 18's
        // ClutterBindCoordinate enum only defines X, Y, WIDTH and HEIGHT (0-3).
        // The POSITION/SIZE/ALL members that older Clutter had are gone, so
        // `Clutter.BindCoordinate.ALL` is undefined here and would have bound
        // nothing useful — leaving the mirror at 0x0, i.e. a glass with no
        // wallpaper in it at all.
        for (const coordinate of [
            Clutter.BindCoordinate.X,
            Clutter.BindCoordinate.Y,
            Clutter.BindCoordinate.WIDTH,
            Clutter.BindCoordinate.HEIGHT,
        ]) {
            mirror.add_constraint(new Clutter.BindConstraint({ source: child, coordinate }));
        }
        this._mirrors.set(child, mirror);
        this.add_child(mirror);
        // Keep our stacking identical to the group's: the shell's cross-fade
        // relies on the incoming wallpaper sitting ABOVE the outgoing one.
        this._restack();
    }
    _removeMirror(child) {
        const mirror = this._mirrors.get(child);
        if (!mirror)
            return;
        this._mirrors.delete(child);
        if (isActorValid(mirror))
            mirror.destroy();
    }
    // Puts our children in the same order as the real background group's.
    //
    // Compare-then-write: set_child_at_index() re-links the child and queues a
    // relayout even when the index does not change, and this runs from the
    // fade's opacity ticks as well as from the reorder notifications.
    _restack() {
        if (!isActorValid(this._sourceGroup))
            return;
        const wanted = [];
        for (const child of this._sourceGroup.get_children()) {
            const mirror = this._mirrors.get(child);
            if (mirror && isActorValid(mirror))
                wanted.push(mirror);
        }
        const current = this.get_children();
        let ordered = current.length === wanted.length;
        if (ordered) {
            for (let i = 0; i < wanted.length; i++) {
                if (current[i] !== wanted[i]) {
                    ordered = false;
                    break;
                }
            }
        }
        if (ordered)
            return;
        for (let i = 0; i < wanted.length; i++)
            this.set_child_at_index(wanted[i], i);
        // Only ever logged when the order really moved, which in practice means
        // a wallpaper cross-fade just started.
        utilsLog(`[bg-mirror] restacked ${wanted.length} wallpaper mirror(s)`);
    }
    _onDestroy() {
        if (isActorValid(this._sourceGroup)) {
            for (const id of this._groupHandlers) {
                try {
                    this._sourceGroup.disconnect(id);
                }
                catch (_) { /* noop */ }
            }
        }
        this._groupHandlers = [];
        this._mirrors.clear();
        this._sourceGroup = null;
    }
    vfunc_pick(_pickContext) {
        // No-op: never respond to picking, exactly like UnpickableClone.
    }
});
// [black-frame] A/B switch for the fix above. `true` clones our own
// BackgroundMirror (uncalled MetaBackgroundContent, painted through a Clone so
// paint_content takes its unconditional full-rect branch); `false` restores
// the historical Clone of _backgroundGroup, which is what produced the black
// frame. Default on.
let _backgroundMirrorEnabled = true;
export function setBackgroundMirrorEnabled(enabled) {
    _backgroundMirrorEnabled = !!enabled;
}
export function isBackgroundMirrorEnabled() {
    return _backgroundMirrorEnabled;
}
// The single BackgroundMirror every glass clones.
//
// One shared source, not one per glass: the contents are identical, and
// WindowCloneManager.rebuildClones() throws its wallpaper actor away and
// builds a new one often enough that creating a MetaBackgroundContent (and
// its Cogl pipeline) per rebuild was a real cost.
let _sharedBackgroundSource = null;
function ensureSharedBackgroundSource() {
    if (isActorValid(_sharedBackgroundSource))
        return _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    const uiGroup = Main.layoutManager?.uiGroup ?? null;
    const group = Main.layoutManager?._backgroundGroup ?? null;
    if (!uiGroup || !group)
        return null;
    const source = new BackgroundMirror();
    source.set_name('lg-bg-mirror-source');
    source.set_position(0, 0);
    source.set_size(group.width, group.height);
    // Track the group through monitor changes: every caller does
    // clone.set_size(monitor...), and ClutterClone scales the source into that,
    // so a stale source size would scale the wallpaper.
    for (const coordinate of [Clutter.BindCoordinate.WIDTH, Clutter.BindCoordinate.HEIGHT]) {
        try {
            source.add_constraint(new Clutter.BindConstraint({ source: group, coordinate }));
        }
        catch (e) {
            utilsLog(`[bg-mirror] source size constraint failed: ${e}`);
        }
    }
    // Opacity 0, NOT visible=false. clutter_actor_paint() bails out at the top
    // on a zero paint opacity:
    //
    //     if (!CLUTTER_ACTOR_IS_TOPLEVEL (self) &&
    //         ((priv->opacity_override >= 0) ? priv->opacity_override : priv->opacity) == 0)
    //       return;
    //
    // so on the real screen this costs one comparison and draws nothing — while
    // ClutterClone sets opacity_override to ITS OWN paint opacity before
    // painting the source, so every glass still gets a fully opaque wallpaper.
    // Hiding it instead would take it out of the mapped/allocated set and make
    // the clones depend on the has_mapped_clones path, which is a far subtler
    // contract to rely on.
    source.opacity = 0;
    source.reactive = false;
    Shell.util_set_hidden_from_pick(source, true);
    // uiGroup, deliberately: it is a sibling of global.window_group, so
    // meta_window_group_paint()'s cull walk can never reach our contents.
    uiGroup.add_child(source);
    source.connect('destroy', () => {
        if (_sharedBackgroundSource === source)
            _sharedBackgroundSource = null;
    });
    _sharedBackgroundSource = source;
    return source;
}
/** The shared source if one exists; never creates one. */
export function getSharedBackgroundSource() {
    return isActorValid(_sharedBackgroundSource) ? _sharedBackgroundSource : null;
}
/** Tears the shared source down; call from the extension's disable(). */
export function destroySharedBackgroundSource() {
    const source = _sharedBackgroundSource;
    _sharedBackgroundSource = null;
    if (isActorValid(source)) {
        try {
            source.destroy();
        }
        catch (_) { /* noop */ }
    }
}
/**
 * Builds the wallpaper actor that sits at the back of a glass.
 *
 * Always a Clutter.Clone — see BackgroundMirror's comment for why painting
 * the background content directly would put it back under the frame's damage
 * region. What changes is WHAT is cloned: our own uncalled mirror normally,
 * or the shell's _backgroundGroup when the A/B switch is off.
 */
export function createBackgroundMirror(name) {
    let source = null;
    if (_backgroundMirrorEnabled) {
        try {
            source = ensureSharedBackgroundSource();
        }
        catch (e) {
            utilsLog(`[bg-mirror] shared source unavailable, falling back: ${e}`);
            source = null;
        }
    }
    if (!source)
        source = Main.layoutManager._backgroundGroup;
    const clone = new UnpickableClone({ source });
    clone.set_name(name);
    return clone;
}
