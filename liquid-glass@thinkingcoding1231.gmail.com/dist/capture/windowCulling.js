import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import { isActorValid } from '../actors/lifecycle.js';
import { utilsLog } from '../diagnostics/logging.js';
/**
 * [window-clone-clip] Makes mutter stop clipping a window we CLONE to the
 * current frame's damage region.
 *
 * Same trap as BackgroundMirror, one actor further along. MetaSurfaceActor
 * implements MetaCullable, and its cull methods stash the frame's damage on
 * the texture that actually paints the window
 * (mutter 50.1, src/compositor/meta-surface-actor.c):
 *
 *     meta_surface_actor_cull_redraw_clip (cullable, clip_region)
 *       -> set_clip_region()  -> meta_shaped_texture_set_clip_region (stex, ...)
 *     meta_surface_actor_cull_unobscured (cullable, unobscured_region)
 *       -> set_unobscured_region()
 *
 * and meta_shaped_texture_paint_content() applies it with NO clone escape
 * hatch at all — unlike MetaBackgroundContent, it never even looks at
 * clutter_actor_is_in_clone_paint():
 *
 *     if (stex->clip_region && mtk_region_is_empty (stex->clip_region))
 *       return;                                    // paints NOTHING
 *     ...
 *     blended_tex_region = mtk_region_ref (stex->clip_region);
 *
 * So a Clutter.Clone of a MetaWindowActor paints that window only where the
 * frame happened to be damaged. Inside a glass that reads as: the wallpaper
 * is there (BackgroundMirror fixed that), but the windows behind the glass
 * are missing or smeared — the glass shows plain wallpaper where a behind-
 * window should be, a repaint leaves the previous frame's colours behind,
 * and opening a menu or clicking the panel makes the behind-window clones
 * vanish entirely for a frame while the wallpaper stays put.
 *
 * mutter has an opt-out for exactly this, in meta-cullable.c, and says so:
 *
 *     // If an actor has effects applied, then that can change the area
 *     // it paints and the opacity ... so we skip the actor.
 *     //
 *     // This has a secondary beneficial effect: if a ClutterOffscreenEffect
 *     // is applied to an actor, then our clipped redraws interfere with the
 *     // caching of the FBO ...  So, skipping actors with effects applied
 *     // also prevents these bugs.
 *     if (needs_culling && has_active_effects (child))
 *       needs_culling = FALSE;
 *     ...
 *     else
 *       method (META_CULLABLE (child), NULL);      // clip/unobscured := NULL
 *
 * has_active_effects() is just "does this actor carry an enabled
 * ClutterEffect", so parking a do-nothing effect on a window actor we clone
 * makes mutter hand its surface actor a NULL clip region and the clone paints
 * in full.
 *
 * Cost: that branch `continue`s without subtracting the actor's opaque region,
 * so a window carrying the opt-out no longer occludes what is behind it.
 * Only windows currently cloned into a glass get one, and the effect is
 * dropped again as soon as the last clone of them goes away.
 */
export const CullOptOutEffect = GObject.registerClass(
// Deliberately empty: ClutterEffectClass->paint defaults to
// clutter_effect_real_paint(), which ends in add_actor_node() — a plain
// pass-through. The effect exists only to be counted by has_active_effects().
class CullOptOutEffect extends Clutter.Effect {
});
const CULL_OPT_OUT_NAME = 'lg-cull-opt-out';
const _cullOptOutOwners = new Map();
const _cullOptOutEffects = new Map();
let _cullOptOutEnabled = true;
function _reconcileCullOptOut() {
    const before = _cullOptOutEffects.size;
    const wanted = new Set();
    if (_cullOptOutEnabled) {
        for (const actors of _cullOptOutOwners.values()) {
            for (const actor of actors) {
                if (isActorValid(actor))
                    wanted.add(actor);
            }
        }
    }
    for (const actor of wanted) {
        if (_cullOptOutEffects.has(actor))
            continue;
        try {
            const effect = new CullOptOutEffect();
            actor.add_effect_with_name(CULL_OPT_OUT_NAME, effect);
            _cullOptOutEffects.set(actor, effect);
        }
        catch (e) {
            utilsLog(`[cull-opt-out] could not attach: ${e}`);
        }
    }
    for (const [actor, effect] of [..._cullOptOutEffects.entries()]) {
        if (wanted.has(actor))
            continue;
        _cullOptOutEffects.delete(actor);
        try {
            if (isActorValid(actor))
                actor.remove_effect(effect);
        }
        catch (_) { /* noop */ }
    }
    if (_cullOptOutEffects.size !== before) {
        // Only ever logged when the set really moved, i.e. a window started or
        // stopped being cloned into some glass.
        utilsLog(`[cull-opt-out] holding ${_cullOptOutEffects.size} window actor(s)` +
            ` [${[..._cullOptOutEffects.keys()].map(a => {
                try {
                    return a.get_meta_window()?.get_title() ?? '?';
                }
                catch (_) {
                    return '?';
                }
            }).join(', ')}]`);
    }
}
function _sameSet(a, b) {
    if (!a)
        return false;
    let n = 0;
    for (const x of b) {
        if (!a.has(x))
            return false;
        n++;
    }
    return n === a.size;
}
/**
 * Declares which window actors `owner` currently clones. Safe to call every
 * frame: it returns immediately unless the set actually changed.
 */
export function reportClonedWindowActors(owner, actors) {
    if (_sameSet(_cullOptOutOwners.get(owner), actors))
        return;
    _cullOptOutOwners.set(owner, new Set(actors));
    _reconcileCullOptOut();
}
/** Drops `owner`'s claim; call when a manager or a window's glass goes away. */
export function releaseClonedWindowActors(owner) {
    if (_cullOptOutOwners.delete(owner))
        _reconcileCullOptOut();
}
/** Drops every claim and every effect; call from the extension's disable(). */
export function releaseAllClonedWindowActors() {
    _cullOptOutOwners.clear();
    _reconcileCullOptOut();
}
// A/B switch. false restores mutter's normal culling of cloned windows, i.e.
// the damage-clipped behaviour described above, and with it the occlusion
// culling that the opt-out gives up.
export function setCullOptOutEnabled(enabled) {
    _cullOptOutEnabled = !!enabled;
    _reconcileCullOptOut();
}
export function isCullOptOutEnabled() {
    return _cullOptOutEnabled;
}
