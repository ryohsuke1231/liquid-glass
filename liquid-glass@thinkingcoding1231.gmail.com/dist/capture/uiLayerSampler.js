import Clutter from 'gi://Clutter';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { isCullSiteEnabled } from './options.js';
import { UnpickableActor, UnpickableClone } from '../actors/unpickable.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import { utilsLog, reportFrameLoopError, _utilsLogger } from '../diagnostics/logging.js';
import Shell from 'gi://Shell';
import { isActorValid } from '../actors/lifecycle.js';
import { getAllocatedSize, rectsIntersect } from '../actors/geometry.js';
import { setActorVisible } from '../actors/allocation.js';
import { setPositionIfChanged, setSizeIfChanged, setOpacityIfChanged, setCloneCulled, setTranslationIfChanged, setScaleIfChanged, setPivotIfChanged } from '../actors/writes.js';
import { acquireSelfExcludingSnapshot, releaseSelfExcludingSnapshot } from './snapshot.js';
import { TextureBlitActor } from '../actors/textureBlit.js';
import { getSharedBackgroundSource } from './background.js';
import { reportClonedWindowActors, releaseClonedWindowActors } from './windowCulling.js';
import { getWindowActors } from '../actors/windows.js';
/**
 * Clones every actor under `Main.layoutManager.uiGroup` into a private
 * container so the glass can render a distorted/blurred view of "everything
 * behind it" (panel, windows, other extensions' UI). One instance per glass
 * (permanent dock glass, popup-menu glass, etc).
 */
/**
 * How UILayerSampler supplies a uiGroup child that has a Blur My Shell target
 * under it.
 *
 * Neither of the first two is right, and which one is in use decides which
 * symptom appears — measured in a native session by toggling the two
 * extensions on in either order:
 *
 *   SNAPSHOT — Liquid Glass sees BMS at clone time and takes a self-excluding
 *     stage snapshot of the child's rect. BMS itself keeps working, but the
 *     snapshot is of the WHOLE stage cropped to that rect, so anything else
 *     overlapping it is captured too: with the dock moved to the top edge it
 *     overlaps the panel and its icons show up as ghosts inside the dock's own
 *     glass. The window texture lag was reported in this configuration as well.
 *
 *   CLONE — Liquid Glass was enabled first, found no BMS target, and made an
 *     ordinary Clutter.Clone. No ghosts and no lag, but BMS's own panel
 *     rendering drifts by about 10px wherever the dock overlaps the panel:
 *     Shell.BlurEffect in background mode samples the framebuffer under the
 *     actor, and painting that actor a second time inside our offscreen gives
 *     it a second, differently-positioned consumer.
 *
 *   SKIP — leave the child out of the glass entirely. No ghosts, no lag, BMS
 *     untouched; the cost is that the panel simply does not appear in the
 *     blurred backdrop.
 *
 * Switchable at runtime (global._lgGlass.bmsMode(n)) so the attribution can be
 * settled inside one session instead of by rebuilding between orders.
 */
export const BMS_MODE = { SNAPSHOT: 0, CLONE: 1, SKIP: 2, REPLICATE: 3 };
// [FIX] SKIP is the default, confirmed by switching all three modes in one
// native session with BMS's dynamic panel blur on:
//
//   0 SNAPSHOT -> window texture lag + the dock's own icons ghosted into its
//                 glass (the snapshot is the whole stage cropped to the
//                 child's rect, and it runs a full stage paint with our root
//                 hidden on every after-paint — the very "toggle live UI
//                 visibility every frame" that memo.md's addendum 3 records
//                 as breaking Clutter's damage bookkeeping)
//   1 CLONE    -> lag and ghosts gone, but BMS's own panel drifts ~10px
//                 wherever the dock overlaps it
//   2 SKIP     -> all three gone; the panel simply is not in the glass
//
// SKIP breaks nothing, but it gives up the panel: with the dock at the top
// edge the dock's glass is drawn ABOVE panelBox, so a panel that is not in the
// glass is a panel that is not on screen there at all.
//
//   3 REPLICATE -> the default. None of the three costs above.
//
// REPLICATE works because of one structural detail of BMS: it inserts its
// blur widget into panel_box as a SIBLING of the panel
// (components/panel.js — `panel_box.insert_child_at_index(background_group, 0)`),
// not as a child of it. So "the panel without BMS's blur widget" is not
// something that has to be filtered out of a clone — it is simply a different
// actor to clone. BMS is then never painted a second time, which is the whole
// of the CLONE problem, and nothing is snapshotted, which is the whole of the
// SNAPSHOT problem.
//
// What that leaves missing is the blurred backdrop BMS draws behind the panel,
// so we draw our own in its place: the same effect class BMS uses
// (Shell.BlurEffect in BACKGROUND mode — see BMS's
// effects/native_dynamic_gaussian_blur.js) with the same live radius and
// brightness, sitting under the panel clone inside our own offscreen, where
// what is "behind" it is our own cloned wallpaper and windows. Same effect,
// same parameters, same input relationship — so it reproduces what BMS draws
// rather than approximating it.
let _bmsMode = BMS_MODE.REPLICATE;
// Every live sampler, so a mode change can rebuild the affected clones.
const _liveSamplers = new Set();
export function setBmsMode(mode) {
    _bmsMode = mode;
    let n = 0;
    for (const sampler of _liveSamplers) {
        try {
            sampler.rebuildBmsClones();
            n++;
        }
        catch (_) { }
    }
    const name = mode === BMS_MODE.SNAPSHOT ? 'SNAPSHOT'
        : mode === BMS_MODE.CLONE ? 'CLONE'
            : mode === BMS_MODE.SKIP ? 'SKIP'
                : mode === BMS_MODE.REPLICATE ? 'REPLICATE' : `? (${mode})`;
    const msg = `[Liquid Glass] BMS mode = ${name} on ${n} sampler(s)`;
    console.log(msg);
    return msg;
}
export function getBmsMode() {
    return _bmsMode;
}
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _label = '?';
    // Per cloned child: whether a Blur My Shell target was found under it at the
    // moment its clone was built.
    _bmsStateAtClone = new Map();
    // The BMS target actor as of the last refresh(), so a change can be noticed.
    _lastBmsTarget = undefined;
    _ancestorExclusionSources = [];
    // Names of the uiGroup children currently cloned, so a change can be logged
    // once instead of every frame.
    _clonedNamesLogged = '';
    _clones = new Map();
    _sourceDestroyIds = new Map();
    _dragActor = null;
    _dragMonitor = {
        dragMotion: (event) => {
            this._dragActor = event.dragActor;
            return DND.DragMotionResult.CONTINUE;
        },
    };
    _uiClonesContainer = null;
    // Read-only cache: for each uiGroup child, either the (actor, effect) pair
    // of an existing Clutter.OffscreenEffect found in its subtree, or null if
    // none was found. Never written to by us (no actor tree mutation), so
    // sharing this cache across multiple UILayerSampler instances is safe.
    _existingEffectCache = new Map();
    // While true, a uiGroup child containing the Blur My Shell target is
    // rendered via _createExistingEffectBlitActor() if a usable
    // Clutter.OffscreenEffect is found in its subtree. BMS's actual blur is a
    // native (non-JS) effect that never matches this, so BMS itself always
    // falls through — this toggle mainly matters for *other* extensions that
    // implement their effects as a JS Clutter.OffscreenEffect subclass.
    _useCaptureFixForBms = true;
    // clone actor -> { source actor (BMS target's uiGroup child), hideActor (our own selfRoot) }
    // Both are needed on destroy to release exactly what we registered on the
    // (possibly shared) SelfExcludingSnapshotCapture.
    _delayedCaptureOwners = new Map();
    // Clones currently rendering somewhere other than their source's own
    // screen rect — see _checkCloneDrift().
    _driftingClones = new Set();
    // [PERF ①b] Screen-coordinate rect this glass can actually show, or null
    // for "no culling" (the pre-① behaviour: cull only against the container,
    // i.e. the whole monitor). Set once per frame by syncGlassCaptureClip().
    _cullRect = null;
    // [PERF ①] Screen rects of the Blur My Shell replicas drawn this frame.
    //
    // A BACKGROUND-mode BMS blur takes its source rect in STAGE coordinates
    // and blits it out of whatever framebuffer is current — here, our
    // offscreen. If the capture clip stops the wallpaper and the window clones
    // from being painted under the panel, BMS blurs TRANSPARENT pixels, and
    // its gaussian smears that transparency back across the whole panel: the
    // "the blur peels away from the top" symptom from memo.md's 追記4, back
    // again. The panel is full width, so with the dock at the top edge (where
    // it overlaps the panel) the clip has to widen to the full screen — but
    // the HEIGHT still collapses, which is where most of the saving is.
    _bmsScreenRects = [];
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null, label = '?', 
    /**
     * [FIX] Actors whose uiGroup ANCESTOR should be excluded, resolved fresh on
     * every refresh() instead of once at construction.
     *
     * extraExclusions above holds fixed actors, which is only correct while
     * the thing being excluded keeps the same uiGroup child as its root.
     * dockManager's use does not: it passes the uiGroup ancestor it walked to
     * at setup time, and Dash to Dock destroys and rebuilds its container
     * whenever its settings change — moving the dock to the top edge does
     * exactly that ("Dash to Dock container destroyed (settings changed?)" in
     * the log). A stale entry there means the sampler starts cloning the dock
     * into the dock's own glass, which shows up as ghost icons inside it.
     */
    ancestorExclusions = []) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._ancestorExclusionSources = ancestorExclusions.slice();
        this._label = label;
        this._selfRoot = this._findUiGroupAncestor(selfActor);
        _liveSamplers.add(this);
        this._uiClonesContainer = new UnpickableActor();
        this._uiClonesContainer.set_name("ui-clones-container");
        // Connect to the destroy signal and assign null
        this._uiClonesContainer.connect('destroy', () => {
            this._uiClonesContainer = null;
        });
        if (cloneContainer) {
            cloneContainer.add_child(this._uiClonesContainer);
        }
        else {
            this._container.add_child(this._uiClonesContainer);
        }
        DND.addDragMonitor(this._dragMonitor);
    }
    /**
     * [PERF ①b] Restricts clone culling to `rect` (screen coordinates), or
     * null to fall back to culling against the container's own bounds.
     */
    setCullRect(rect) {
        this._cullRect = rect;
    }
    /**
     * [PERF ①] Screen rects of the BMS replicas painted during the LAST sync.
     * One frame old by construction (they are recorded while the clones are
     * synced, and the clip is computed before that) — harmless, because the
     * panel does not move. Empty when this glass draws no BMS replica.
     */
    getBmsScreenRects() {
        return this._bmsScreenRects;
    }
    /** True when this sampler has a BMS replica whose rect is not known yet. */
    hasUnmeasuredBmsReplica() {
        if (this._bmsScreenRects.length > 0)
            return false;
        for (const clone of this._clones.values()) {
            if (clone._lgBmsReplica)
                return true;
        }
        return false;
    }
    _findUiGroupAncestor(actor) {
        const uiGroup = Main.layoutManager.uiGroup;
        let current = actor;
        while (current) {
            if (current.get_parent() === uiGroup)
                return current;
            current = current.get_parent();
        }
        return null;
    }
    /** Adds an actor to the set of uiGroup children that should never be cloned. */
    addExclusion(actor) {
        if (!actor)
            return;
        this._extraExclusions.add(actor);
    }
    /**
     * Resolves the Blur My Shell panel-blur target actor via
     * Main.extensionManager, if BMS is installed and enabled and its internal
     * structure matches what we expect. Everything here is best-effort and
     * guarded: if BMS is absent or has changed shape, this simply returns
     * null and callers fall back to normal cloning.
     */
    _resolveBmsTargetActor() {
        try {
            const ext = Main.extensionManager?.lookup?.('blur-my-shell@aunetx');
            const actor = ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor;
            return actor ?? null;
        }
        catch (_) {
            return null;
        }
    }
    /**
     * Returns the BMS target actor if `child` (a direct uiGroup child) either
     * *is* the BMS target or contains it as a descendant — i.e. whether
     * cloning `child` would also clone BMS's blurred panel.
     */
    _findBmsDescendant(child) {
        const target = this._resolveBmsTargetActor();
        if (!target)
            return null;
        if (child === target)
            return target;
        try {
            if (typeof child.contains === 'function' && child.contains(target)) {
                return target;
            }
        }
        catch (_) { /* noop */ }
        return null;
    }
    /**
     * @deprecated no-op, kept only so older callers that still toggle these
     * debug switches don't break. The multi-paint diagnostic probe and the
     * "force-hide the BMS clone" A/B switch they used to control have both
     * been removed now that the real fix (SelfExcludingSnapshotCapture) is in
     * place.
     */
    setDebugDisableBmsClone(_disabled) { }
    /** @deprecated no-op, see setDebugDisableBmsClone. */
    setDebugBmsProbeEnabled(_enabled) { }
    /**
     * Builds the stand-in for a uiGroup child that holds a Blur My Shell target
     * (in practice: panelBox).
     *
     * Two actors, in this order:
     *
     *   1. an St.Widget carrying our own Shell.BlurEffect in BACKGROUND mode,
     *      standing exactly where BMS puts its own blurred widget, with BMS's
     *      current radius and brightness copied off its live effect;
     *   2. a clone of every OTHER child of panel_box — the panel itself.
     *
     * BMS's blur widget is deliberately not among them. It is a sibling of the
     * panel rather than a child (components/panel.js inserts background_group
     * into panel_box), so leaving it out costs nothing but choosing a different
     * actor to clone — and it is what keeps BMS's own effect from being painted
     * a second time, from a second framebuffer, which is what made the real
     * panel drift.
     *
     * Our blur samples what is behind it in OUR offscreen, which is the cloned
     * wallpaper and windows — the same relationship BMS's has to the real
     * framebuffer. So the panel appears inside the glass blurred the way BMS
     * blurs it, and our own glass blur then applies on top as it does to
     * everything else.
     */
    _createBmsReplicaActor(child) {
        try {
            const target = this._findBmsDescendant(child);
            if (!target)
                return null;
            // BMS's blur widget lives inside its own background group; that group is
            // the child of panel_box we must not clone.
            let bmsGroup = target;
            while (bmsGroup && bmsGroup.get_parent() !== child) {
                bmsGroup = bmsGroup.get_parent();
            }
            if (!bmsGroup)
                return null;
            const container = new UnpickableActor();
            container.set_name(`${child.name ?? 'bms'}-replica`);
            const blurWidget = new St.Widget({ name: 'lg-bms-replica-blur' });
            blurWidget.add_effect(this._buildReplicaBlurEffect(target));
            container.add_child(blurWidget);
            const parts = [];
            for (const c of child.get_children()) {
                if (c === bmsGroup)
                    continue;
                const clone = new UnpickableClone({ source: c });
                clone.set_name(`${c.name ?? 'part'}-replicaClone`);
                container.add_child(clone);
                parts.push({ src: c, clone });
            }
            if (parts.length === 0) {
                container.destroy();
                return null;
            }
            container._lgBmsReplica = { blurWidget, parts, bmsTarget: target };
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica built for ` +
                `name="${child.name ?? '(unnamed)'}" with ${parts.length} part(s)`);
            return container;
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler._createBmsReplicaActor', e);
            return null;
        }
    }
    /**
     * Where the actor's own pixels start inside the offscreen this sampler's
     * clones are drawn into, in pixels. Published by LiquidEffect each paint;
     * (0, 0) until then, and for any container that carries no such effect.
     */
    _captureOffset() {
        try {
            const off = this._container?._lgCaptureOffset;
            if (Array.isArray(off) && Number.isFinite(off[0]) && Number.isFinite(off[1]))
                return [off[0], off[1]];
        }
        catch (_) { /* noop */ }
        return [0, 0];
    }
    /**
     * Builds the blur effect for a replica, as the SAME CLASS Blur My Shell is
     * using on the real panel.
     *
     * [FIX] This used to hardcode Shell.BlurEffect, and that was a different
     * implementation from the one BMS had picked. BMS chooses at load time:
     *
     *   // blur-my-shell/effects/native_dynamic_gaussian_blur.js
     *   let BlurOrShell = await utils.import_in_shell_only('gi://Blur');
     *   if (BlurOrShell === null)
     *       BlurOrShell = await utils.import_in_shell_only('gi://Shell');
     *
     * Blur-1.0 is present on this system, so the real panel runs the Blur
     * module's effect while the replica ran gnome-shell's — which visibly
     * diverges as the radius grows. gnome-shell's blur only downscales while
     * BOTH dimensions exceed 256px (shell-blur-effect.c's
     * calculate_downscale_factor, and again in mutter's clutter-blur.c), and the
     * panel is 46px tall, so nothing is ever downscaled and the gaussian is asked
     * for ceil(1.5 * sigma) * 2 taps at full size: 18 at sigma 6, but 240 at
     * sigma 80. The result degrades toward unblurred exactly as reported, while
     * the real panel — a different implementation — stayed sharp-free.
     *
     * Rather than re-derive which module to import, take the class off BMS's own
     * live effect. That matches whatever it chose, including its subclass and
     * the corner-radius handling that only exists on the Blur module's branch.
     */
    _buildReplicaBlurEffect(bmsTarget) {
        try {
            const theirs = (bmsTarget.get_effects() ?? [])
                .find((e) => typeof e?.radius === 'number');
            if (theirs) {
                const Ctor = Object.getPrototypeOf(theirs)?.constructor;
                if (typeof Ctor === 'function') {
                    // corner_radius must ALWAYS be a number. BMS's constructor
                    // destructures it and, on the Blur-module branch, hands it straight
                    // to super() — `undefined` there is rejected by GObject with
                    // "Invalid value 'undefined' for property corner-radius", which is
                    // exactly what sent this down the fallback path on the first
                    // attempt. Its own unscaled_corner_radius getter reads a field that
                    // only its setter writes, and DummyPipeline sets `corner_radius`
                    // instead, so the unscaled one is undefined in practice.
                    const cornerRadius = theirs.unscaled_corner_radius ?? theirs.corner_radius ?? 0;
                    const params = {
                        unscaled_radius: theirs.unscaled_radius ?? theirs.radius ?? 0,
                        brightness: theirs.brightness ?? 1.0,
                        corner_radius: cornerRadius,
                    };
                    const ours = new Ctor(params);
                    utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica blur uses ` +
                        `${Ctor.name ?? '?'} (matching BMS's own effect), ` +
                        `unscaled_radius=${params.unscaled_radius} brightness=${params.brightness} ` +
                        `corner_radius=${params.corner_radius}`);
                    return ours;
                }
            }
        }
        catch (e) {
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] could not mirror BMS's ` +
                `blur effect (${e}); falling back to Shell.BlurEffect`);
        }
        // Fallback only: BMS not reachable, or its effect could not be copied.
        return new Shell.BlurEffect({
            mode: Shell.BlurMode.BACKGROUND,
            radius: 0,
            brightness: 1.0,
        });
    }
    /**
     * Per-frame geometry for a replica built above. `source` is panel_box, so
     * every part is placed at its own position inside it, and the blur widget
     * takes the panel's rect — the same rect BMS gives its own widget in
     * update_size()'s dynamic branch (`background.x = panel.x`, etc).
     */
    _syncBmsReplica(source, replica) {
        try {
            const parts = replica.parts;
            let panelRect = null;
            for (const { src, clone } of parts) {
                if (!isActorValid(src) || !isActorValid(clone))
                    continue;
                const [w, h] = getAllocatedSize(src);
                if (!(w > 0) || !(h > 0)) {
                    setActorVisible(clone, false);
                    continue;
                }
                setPositionIfChanged(clone, src.x, src.y);
                setSizeIfChanged(clone, w, h);
                setOpacityIfChanged(clone, src.opacity);
                setActorVisible(clone, src.visible && src.mapped);
                if (!panelRect)
                    panelRect = [src.x, src.y, w, h];
            }
            const blurWidget = replica.blurWidget;
            if (isActorValid(blurWidget) && panelRect) {
                replica.panelRect = panelRect;
                // [FIX] Compensate for the offscreen's capture padding.
                //
                // A background-mode blur asks for its source by STAGE coordinates and
                // then blits that rectangle out of whatever framebuffer is current.
                // On the real panel those two spaces are the same. Inside our
                // offscreen they are not: ClutterOffscreenEffect enlarges the paint
                // box by 3px, so actor-local (0, 0) sits at texel (2, 2) and a blit
                // asking for stage (0, 0) reads two rows and columns of cleared
                // padding instead.
                //
                // That is what "the blur peels away from the top, by more the larger
                // the sigma" is: the gaussian smears those transparent rows down over
                // its whole radius, and where the blurred result is transparent the
                // sharp clone behind it shows through. At sigma 100 the smear is wider
                // than the 46px panel, which is why the blur looked like it had
                // vanished entirely. The real panel never shows it because it is not
                // being drawn into an offscreen at all.
                //
                // Shifting the widget by the padding makes the blit land on the actor's
                // own pixels. The visible backdrop moves by those same 2px, which on a
                // blurred image is not detectable.
                const [offX, offY] = this._captureOffset();
                setPositionIfChanged(blurWidget, panelRect[0] + offX, panelRect[1] + offY);
                setSizeIfChanged(blurWidget, panelRect[2], panelRect[3]);
                setActorVisible(blurWidget, true);
                // Track BMS's live values rather than re-reading its settings: the
                // effect already holds them scaled by the theme's scale factor.
                const src = replica.bmsTarget;
                let ours = blurWidget.get_effects()[0];
                if (ours && isActorValid(src)) {
                    const theirs = (src.get_effects() ?? []).find((e) => typeof e?.radius === 'number');
                    if (theirs) {
                        // [FIX] Self-heal a class mismatch. The replica is built once, and
                        // if BMS's effect was not on its actor yet — or constructing its
                        // class failed — the fallback would otherwise stay for the life of
                        // the clone, silently blurring by a different implementation than
                        // the real panel. Rebuilding it here costs one comparison a frame.
                        if (Object.getPrototypeOf(ours)?.constructor !==
                            Object.getPrototypeOf(theirs)?.constructor) {
                            try {
                                blurWidget.remove_effect(ours);
                                blurWidget.add_effect(this._buildReplicaBlurEffect(src));
                                ours = blurWidget.get_effects()[0];
                            }
                            catch (_) { /* keep the one we have */ }
                        }
                        if (ours.radius !== theirs.radius)
                            ours.radius = theirs.radius;
                        if (ours.brightness !== theirs.brightness)
                            ours.brightness = theirs.brightness;
                    }
                }
            }
            this._reportReplicaGeometry(source, replica);
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler._syncBmsReplica', e);
        }
    }
    /**
     * [DIAG] Logs the replica's real geometry whenever it changes.
     *
     * The blurred band inside the glass not lining up with the panel is a
     * question about coordinates — where the blur widget ended up, and which
     * space Shell.BlurEffect resolved it in — and none of that is visible from
     * the outside. Reported on change only, so a stable panel costs one line.
     */
    _reportReplicaGeometry(source, replica) {
        if (!_utilsLogger)
            return;
        try {
            const blurWidget = replica.blurWidget;
            const [srcAbsX, srcAbsY] = source.get_transformed_position();
            const [bwAbsX, bwAbsY] = blurWidget.get_transformed_position();
            const [bwW, bwH] = blurWidget.get_size();
            const ours = blurWidget.get_effects()[0];
            const theirs = (replica.bmsTarget?.get_effects?.() ?? [])
                .find((e) => typeof e?.radius === 'number');
            const parts = replica.parts
                .map((p) => `${p.src.name ?? '?'}@(${p.src.x},${p.src.y})` +
                `${getAllocatedSize(p.src)[0]}x${getAllocatedSize(p.src)[1]}`)
                .join(' ');
            const line = `src=${source.name ?? '?'}@(${Math.round(srcAbsX)},${Math.round(srcAbsY)}) ` +
                `parts=[${parts}] ` +
                `blur=(${blurWidget.x},${blurWidget.y}) ${bwW}x${bwH} ` +
                `blurAbs=(${Math.round(bwAbsX)},${Math.round(bwAbsY)}) ` +
                `r=${ours?.radius}/${theirs?.radius} b=${ours?.brightness}/${theirs?.brightness} ` +
                `capOff=(${this._captureOffset()[0]},${this._captureOffset()[1]}) ` +
                `cls=${Object.getPrototypeOf(ours ?? {})?.constructor?.name ?? '?'}/` +
                `${Object.getPrototypeOf(theirs ?? {})?.constructor?.name ?? '?'}`;
            if (line === replica.lastGeomLine)
                return;
            replica.lastGeomLine = line;
            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] replica geom ${line}`);
        }
        catch (_) { /* noop */ }
    }
    /**
     * Primary path for rendering the BMS-blurred panel inside the glass. See
     * SelfExcludingSnapshotCapture for the full rationale. Returns null (and
     * lets the caller fall back) if this Clutter version lacks
     * `Stage.paint_to_content()`.
     */
    _createSelfExcludingSnapshotActor(child) {
        try {
            const stage = child.get_stage();
            if (!stage)
                return null;
            if (typeof stage.paint_to_content !== 'function')
                return null;
            if (!this._selfRoot)
                return null;
            const selfRoot = this._selfRoot;
            const rectGetter = () => {
                const [x, y] = child.get_transformed_position();
                const [w, h] = getAllocatedSize(child);
                if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) {
                    return [0, 0, 0, 0];
                }
                return [x, y, w, h];
            };
            const capture = acquireSelfExcludingSnapshot(child, stage, selfRoot, rectGetter);
            const actor = new UnpickableActor();
            actor.set_name(`${child.name}-selfExcludingSnapshot`);
            // Push new content onto the actor whenever the capture updates,
            // rather than polling on a timer, so this stays in lockstep with
            // SelfExcludingSnapshotCapture's own 'after-paint'-driven refresh.
            const applyContent = () => {
                if (actor._isDisposed)
                    return;
                const content = capture.getContent();
                if (content && actor.content !== content) {
                    actor.content = content;
                }
            };
            let afterPaintId = 0;
            try {
                afterPaintId = stage.connect('after-paint', applyContent);
            }
            catch (e) {
            }
            applyContent();
            this._delayedCaptureOwners.set(actor, { source: child, hideActor: selfRoot });
            actor.connect('destroy', () => {
                actor._isDisposed = true;
                if (afterPaintId) {
                    try {
                        stage.disconnect(afterPaintId);
                    }
                    catch (_) { /* noop */ }
                }
                const owner = this._delayedCaptureOwners.get(actor);
                if (owner) {
                    releaseSelfExcludingSnapshot(owner.source, owner.hideActor);
                    this._delayedCaptureOwners.delete(actor);
                }
            });
            return actor;
        }
        catch (e) {
            return null;
        }
    }
    /** Toggle for the OffscreenEffect-reading fallback (see _useCaptureFixForBms). */
    setUseCaptureFixForBms(enabled) {
        this._useCaptureFixForBms = enabled;
    }
    /**
     * Searches `root`'s subtree (read-only, no mutation) for an existing
     * Clutter.OffscreenEffect — e.g. a blur implemented as a JS effect by some
     * other extension. Our own debug effects (GTypeName starting with
     * "LiquidGlass") are skipped so we never pick up our own instrumentation.
     */
    _findExistingOffscreenEffect(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const effects = actor.get_effects?.() ?? [];
                for (const effect of effects) {
                    if (!(effect instanceof Clutter.OffscreenEffect))
                        continue;
                    const gtypeName = effect.constructor?.$gtype?.name ?? '';
                    if (gtypeName.startsWith('LiquidGlass'))
                        continue;
                    return { actor, effect: effect };
                }
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return null;
    }
    /**
     * Fallback for BMS-target children when SelfExcludingSnapshotCapture is
     * unavailable: reads an existing OffscreenEffect's captured texture
     * directly, without adding anything to the actor tree. This never
     * matches BMS's own native blur effect (see class doc comment on
     * _useCaptureFixForBms) but can help other, JS-effect-based extensions.
     * Returns null if nothing suitable was found.
     */
    _createExistingEffectBlitActor(child) {
        let found = this._existingEffectCache.get(child);
        if (found === undefined) {
            found = this._findExistingOffscreenEffect(child);
            this._existingEffectCache.set(child, found);
        }
        if (!found)
            return null;
        const { actor: effectOwner, effect } = found;
        const blit = new TextureBlitActor();
        blit.setSourceActor(effectOwner);
        blit.setTextureGetter(() => effect.get_texture());
        return blit;
    }
    rebindSelf() {
        this._selfRoot = this._findUiGroupAncestor(this._selfActor);
    }
    /**
     * Returns true if `root`'s subtree contains the root actor of *another*
     * Liquid Glass instance (bgActor, named 'liquid-glass-bg-actor', or its
     * child liquidBox, named 'liquid-box'). Searched recursively with no
     * depth limit — a shallow, direct-child-only check is not enough: if a
     * glass instance's root ends up nested more than one level below a
     * uiGroup child (e.g. when multiple popups are open at once, or another
     * container wraps it), a shallow check silently misses it and that whole
     * instance — including whatever it has already rendered — gets cloned
     * into this glass, producing a visible "glass inside glass" nesting
     * artifact.
     */
    _containsOtherLiquidGlassRoot(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const name = actor.name;
                if (name === 'liquid-glass-bg-actor' || name === 'liquid-box')
                    return true;
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return false;
    }
    /**
     * Repositions a freshly-added clone within `_uiClonesContainer` to match
     * `child`'s real z-order among `uiGroup`'s children, rather than leaving
     * it wherever `add_child()` put it (always the front).
     *
     * Without this, any uiGroup child that appears *after* the glass was
     * already showing other clones — e.g. the full-screen blurred backdrop
     * GNOME's Activities/Overview creates — ends up rendered in front of
     * clones added earlier, regardless of its real stacking order on screen.
     * (The real screen is unaffected since this only concerns our own clone
     * container's internal ordering.)
     */
    _insertCloneInZOrder(child, clone) {
        if (!this._uiClonesContainer)
            return;
        try {
            const uiGroup = Main.layoutManager.uiGroup;
            const siblings = uiGroup.get_children();
            const idx = siblings.indexOf(child);
            if (idx < 0)
                return; // Not found: leave it at the front.
            let insertAboveClone = null;
            for (let i = idx - 1; i >= 0; i--) {
                const prevClone = this._clones.get(siblings[i]);
                if (prevClone && !prevClone._isDisposed) {
                    insertAboveClone = prevClone;
                    break;
                }
            }
            if (insertAboveClone) {
                this._uiClonesContainer.set_child_above_sibling(clone, insertAboveClone);
            }
            else {
                // No cloned sibling sits below `child` in uiGroup's real order, so
                // this one is currently the backmost among cloned siblings.
                this._uiClonesContainer.set_child_below_sibling(clone, null);
            }
        }
        catch (e) {
        }
    }
    /**
     * Scans uiGroup's current children, creating/destroying clones as needed.
     * Call whenever the set of top-level UI actors may have changed (e.g. a
     * menu opening or closing).
     */
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        if (this._dragActor && !children.includes(this._dragActor))
            this._dragActor = null;
        // [FIX] One lookup per refresh, not per child: notice BMS appearing or
        // disappearing and rebuild only the clones whose answer moved.
        const bmsTarget = this._resolveBmsTargetActor();
        if (this._lastBmsTarget !== bmsTarget) {
            const first = this._lastBmsTarget === undefined;
            this._lastBmsTarget = bmsTarget;
            if (!first)
                this._reevaluateBmsClones();
        }
        // [FIX] Resolved every refresh: see ancestorExclusions in the constructor.
        const dynamicExclusions = new Set();
        for (const src of this._ancestorExclusionSources) {
            try {
                if (!isActorValid(src))
                    continue;
                const root = this._findUiGroupAncestor(src);
                if (root)
                    dynamicExclusions.add(root);
            }
            catch (_) { /* noop */ }
        }
        for (const child of children) {
            // Per-child containment: refresh() runs from the same per-frame
            // BEFORE_REDRAW tick as everything else, and one uiGroup child going
            // away mid-iteration must not cost the caller its reschedule (see
            // reportFrameLoopError).
            try {
                if (child._isDisposed)
                    continue;
                if (!isActorValid(child))
                    continue;
                if (child === this._dragActor)
                    continue;
                if (child === this._selfActor || child === this._selfRoot)
                    continue;
                if (child === Main.layoutManager._backgroundGroup)
                    continue;
                // [black-frame] Same reasoning as the line above: the shared wallpaper
                // mirror lives in uiGroup so the window group's cull walk cannot reach
                // it, but it IS the wallpaper. Every glass already clones it directly
                // as its own bgClone, so letting the UI-layer sampler clone it too
                // would paint the wallpaper into the UI layer a second time.
                if (child === getSharedBackgroundSource())
                    continue;
                if (this._extraExclusions.has(child))
                    continue;
                if (dynamicExclusions.has(child))
                    continue;
                if (!child.visible || !child.mapped)
                    continue;
                // if (this._containsOtherLiquidGlassRoot(child)) continue;
                // Deep scan for nested Liquid Glass roots only once per newly discovered actor.
                // Doing this every frame causes massive performance drops in the Overview.
                if (!this._clones.has(child) && this._containsOtherLiquidGlassRoot(child)) {
                    // NOTE: addExclusion() is PERMANENT for the life of this sampler,
                    // and the deep scan that reaches here only runs for a child that
                    // currently has no clone. So a child whose clone was dropped for a
                    // single frame (it went unmapped, or syncProperties() culled it) is
                    // re-scanned, and if another glass instance happens to be nested
                    // under it at that instant, it is banned from the sampler for good
                    // — which is a candidate explanation for "the UI clones are just
                    // missing" persisting until the menu is reopened. Logged so a repro
                    // says outright whether that is what happened.
                    utilsLog(`[Liquid Glass][ui-sampler] permanent exclusion of uiGroup child ` +
                        `name="${child.name ?? '(unnamed)'}" ` +
                        `type=${child.constructor?.name} ` +
                        `(nested liquid-glass root found during deep scan)`);
                    this.addExclusion(child);
                    continue;
                }
                seen.add(child);
                if (!this._clones.has(child)) {
                    const bmsTarget = this._findBmsDescendant(child);
                    // SKIP: leave the BMS target out of the glass altogether. Done here
                    // rather than in the exclusion block above so the child is still
                    // tracked (and rebuilt) when the mode or the BMS state changes.
                    if (bmsTarget && _bmsMode === BMS_MODE.SKIP) {
                        seen.delete(child);
                        continue;
                    }
                    let sourceClone = null;
                    if (bmsTarget && _bmsMode === BMS_MODE.REPLICATE) {
                        sourceClone = this._createBmsReplicaActor(child);
                        if (!sourceClone) {
                            // Do NOT quietly fall through to the ordinary clone here: that
                            // is the path that makes BMS's own panel drift. Leaving the
                            // child out is the lesser failure, and it is logged.
                            utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS replica ` +
                                `could not be built for name="${child.name ?? '(unnamed)'}"; ` +
                                `leaving it out of the glass rather than cloning BMS's target`);
                            seen.delete(child);
                            continue;
                        }
                    }
                    if (!sourceClone && bmsTarget && _bmsMode === BMS_MODE.SNAPSHOT) {
                        // 1st: the real fix — a snapshot that structurally cannot
                        // include ourselves (see SelfExcludingSnapshotCapture).
                        sourceClone = this._createSelfExcludingSnapshotActor(child);
                        // 2nd: read an existing OffscreenEffect's texture (useful for
                        // other extensions; BMS's native effect never matches this).
                        if (!sourceClone && this._useCaptureFixForBms) {
                            sourceClone = this._createExistingEffectBlitActor(child);
                        }
                    }
                    // Fallback: an ordinary unpickable clone.
                    if (!sourceClone) {
                        sourceClone = new UnpickableClone({ source: child });
                    }
                    // [FIX] Remember whether this child was cloned as "BMS present" or
                    // not, so the answer can be re-checked when the extension set
                    // changes. See _reevaluateBmsClones().
                    this._bmsStateAtClone.set(child, !!bmsTarget);
                    sourceClone.set_name(`${child.name}-sourceClone`);
                    sourceClone.connect('destroy', () => {
                        this._clones.delete(child);
                    });
                    this._uiClonesContainer?.add_child(sourceClone);
                    this._clones.set(child, sourceClone);
                    if (!this._sourceDestroyIds.has(child)) {
                        this._sourceDestroyIds.set(child, child.connect('destroy', () => {
                            this._sourceDestroyIds.delete(child);
                            this._bmsStateAtClone.delete(child);
                            this._existingEffectCache.delete(child);
                            const clone = this._clones.get(child);
                            this._clones.delete(child);
                            try {
                                clone?.destroy();
                            }
                            catch (_) { }
                        }));
                    }
                    this._insertCloneInZOrder(child, sourceClone);
                }
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.refresh', e);
            }
        }
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    sourceClone.destroy();
                }
                catch (_) { }
                this._clones.delete(actor);
            }
        }
        for (const [actor, id] of this._sourceDestroyIds) {
            if (this._clones.has(actor))
                continue;
            try {
                actor.disconnect(id);
            }
            catch (_) { }
            this._sourceDestroyIds.delete(actor);
            this._bmsStateAtClone.delete(actor);
            this._existingEffectCache.delete(actor);
        }
        this._reportClonedSet();
        this._reportClonedWindowGroups();
    }
    static _stageToLocal(actor, stageX, stageY) {
        try {
            const res = actor.transform_stage_point(stageX, stageY);
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch (_) { }
        try {
            const [cx, cy] = actor.get_transformed_position();
            return [
                stageX - (Number.isNaN(cx) ? 0 : cx),
                stageY - (Number.isNaN(cy) ? 0 : cy),
            ];
        }
        catch (_) {
            return [stageX, stageY];
        }
    }
    /**
     * Copies `source`'s current position/size/opacity/visibility onto its
     * clone, and culls the clone if it falls outside the given container
     * bounds.
     */
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = getAllocatedSize(source);
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                setActorVisible(sourceClone, false);
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            // get_transformed_position() already folds in source's own
            // scale/pivot (it maps the local origin through the full accumulated
            // transform). So we must NOT also apply scale/pivot again on the
            // clone — doing so double-counts the pivot offset
            // (pivot * size * (1 - scale)), which is invisible when scale is 1
            // and pivot is (0,0) but shows up as a few pixels of drift on
            // anything that scales on hover/press (e.g. the calendar's "today"
            // highlight, panel buttons). Instead, bake the visual scale directly
            // into the clone's size and leave its own scale at 1.
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            // Placed by translation rather than allocation — see the long note in
            // WindowCloneManager.sync(). This is what keeps a UI clone (the
            // Overview's controls, the panel) from freezing at a stale rect when
            // the glass subtree stops being allocated.
            // [PERF ①b] Cull against the rect this glass can actually show, when
            // one has been handed to us. Decided here, before the writes, so a
            // culled clone costs nothing at all this frame.
            //
            // Two clones are never culled:
            //   - one carrying a BMS replica, because the replica's blur reads the
            //     framebuffer and the clip rect was widened to keep its band
            //     intact (see _bmsScreenRects);
            //   - one whose source has no usable size or position yet, because a
            //     degenerate rect intersects nothing and would cull a clone that is
            //     merely waiting for its first allocation. Fail open: not culling
            //     costs a frame of fill, culling wrongly leaves a hole in the glass.
            const cull = this._cullRect;
            const cullable = !!cull && isCullSiteEnabled('ui') &&
                !sourceClone._lgBmsReplica &&
                scaledW > 0 && scaledH > 0 &&
                Number.isFinite(absX) && Number.isFinite(absY);
            if (cullable && !rectsIntersect(absX, absY, scaledW, scaledH, cull)) {
                setCloneCulled(sourceClone, true, `src=(${Math.round(absX)},${Math.round(absY)},${Math.round(scaledW)}x${Math.round(scaledH)}) ` +
                    `cullRect=[${cull.map(Math.round)}] label=${this._label}`);
                return;
            }
            setCloneCulled(sourceClone, false, `label=${this._label}`);
            // [PERF] Compare-then-write: see setTranslationIfChanged(). The UI
            // sampler runs this for every uiGroup child of every open glass, on
            // every frame; unconditional transform writes damaged all of them
            // even with nothing on screen moving.
            if (sourceClone.x !== 0 || sourceClone.y !== 0)
                sourceClone.set_position(0, 0);
            setTranslationIfChanged(sourceClone, absX, absY);
            setSizeIfChanged(sourceClone, scaledW, scaledH);
            setScaleIfChanged(sourceClone, 1.0, 1.0);
            setPivotIfChanged(sourceClone, 0, 0);
            setOpacityIfChanged(sourceClone, source.opacity);
            const replica = sourceClone._lgBmsReplica;
            if (replica) {
                this._syncBmsReplica(source, replica);
                // [PERF ①] Remember where this replica lands on screen so the
                // capture clip can be widened to cover it — see _bmsScreenRects.
                // panelRect is local to this clone, and the clone's local origin is
                // at (absX, absY) in screen space.
                const pr = replica.panelRect;
                if (pr && pr[2] > 0 && pr[3] > 0)
                    this._bmsScreenRects.push([absX + pr[0], absY + pr[1], pr[2], pr[3]]);
            }
            this._checkCloneDrift(source, sourceClone, absX, absY);
            const localX = absX - cX;
            const localY = absY - cY;
            const isVisible = source.visible && source.mapped;
            // The pre-① containment test. It runs against the container, which is
            // the whole monitor for every glass with a monitor-sized bgActor, so
            // in practice it only catches clones that are genuinely off-screen.
            // The real culling happens above, against _cullRect.
            if (isVisible && containerW > 0 && containerH > 0) {
                const isIntersecting = localX < containerW &&
                    (localX + scaledW) > 0 &&
                    localY < containerH &&
                    (localY + scaledH) > 0;
                setActorVisible(sourceClone, isIntersecting);
            }
            else {
                setActorVisible(sourceClone, isVisible);
            }
        }
        catch (_) { }
    }
    // A clone is supposed to land on its source's own screen rect. When it
    // does not, the glass shows a piece of the desktop from somewhere else
    // entirely — the "the clone is showing a completely different place"
    // report. Logged on entry and exit only, so a stuck clone costs two lines
    // instead of 60 per second.
    _checkCloneDrift(source, sourceClone, expectX, expectY) {
        if (!_utilsLogger)
            return;
        try {
            const [gotX, gotY] = sourceClone.get_transformed_position();
            const drifted = !Number.isFinite(gotX) || !Number.isFinite(gotY) ||
                Math.abs(gotX - expectX) > 1 || Math.abs(gotY - expectY) > 1;
            const known = this._driftingClones.has(sourceClone);
            if (drifted && !known) {
                this._driftingClones.add(sourceClone);
                utilsLog(`[Liquid Glass][ui-sampler] DRIFT clone for ` +
                    `name="${source.name ?? '(unnamed)'}" ` +
                    `type=${source.constructor?.name} ` +
                    `expected=(${Math.round(expectX)},${Math.round(expectY)}) ` +
                    `got=(${Math.round(gotX)},${Math.round(gotY)}) ` +
                    `containerPos=${this._uiClonesContainer?.get_transformed_position()} ` +
                    `clone.hasAlloc=${sourceClone.has_allocation()}`);
            }
            else if (!drifted && known) {
                this._driftingClones.delete(sourceClone);
                utilsLog(`[Liquid Glass][ui-sampler] RECOVERED clone for name="${source.name ?? '(unnamed)'}"`);
            }
        }
        catch (_) { /* noop */ }
    }
    // Repositions the UI-clone container and culls off-screen clones.
    //
    // In the full-screen-FBO architecture, callers pass
    //   sync(monitor.x, monitor.y, screenW, screenH)
    // rather than the dock's own local (bgX, bgY, bgW, bgH).
    //
    // Effect: _uiClonesContainer is placed at (-monitor.x, -monitor.y) so a
    // clone at absolute screen position (absX, absY) ends up at:
    //   monitor.x + (-monitor.x + absX) = absX  ✓
    // The wider container dimensions (screenW, screenH) relax the cull
    // frustum to the full monitor; actual rendering is still limited to the
    // dock area by the clip applied to liquidBox/blurBox elsewhere.
    sync(cX, cY, cW, cH) {
        // [PERF ①] Rebuilt every frame by syncProperties(); see _bmsScreenRects.
        this._bmsScreenRects = [];
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            try {
                const [cw, ch] = this._container.get_size();
                if (!Number.isNaN(cw))
                    contW = cw;
                if (!Number.isNaN(ch))
                    contH = ch;
                const [tx, ty] = this._container.get_transformed_position();
                contAbsX = Number.isNaN(tx) ? 0 : tx;
                contAbsY = Number.isNaN(ty) ? 0 : ty;
            }
            catch (_) { }
        }
        // Always bring the UI clones container to the front, regardless of its parent.
        // This prevents WindowCloneManager's rebuilds from placing windows above the UI.
        try {
            const parent = this._uiClonesContainer?.get_parent();
            if (parent && this._uiClonesContainer) {
                const siblings = parent.get_children();
                if (siblings[siblings.length - 1] !== this._uiClonesContainer) {
                    parent.set_child_above_sibling(this._uiClonesContainer, null);
                }
            }
        }
        catch (e) {
            reportFrameLoopError('UILayerSampler.sync', e);
        }
        // Sign is flipped relative to WindowCloneManager.setOffset(x, y).
        // Translation, not position — see WindowCloneManager.sync().
        if (this._uiClonesContainer) {
            if (this._uiClonesContainer.x !== 0 || this._uiClonesContainer.y !== 0)
                this._uiClonesContainer.set_position(0, 0);
            setTranslationIfChanged(this._uiClonesContainer, -contAbsX, -contAbsY);
        }
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    /**
     * [FIX] Re-checks the Blur My Shell decision when BMS comes or goes.
     *
     * Which clone a uiGroup child gets depends on whether a BMS target is found
     * underneath it, and that was decided once, when the clone was first built.
     * So the two extensions behaved differently depending on the order they were
     * switched on:
     *
     *   BMS first, then this one — the target is found, the child is supplied as
     *     a self-excluding snapshot, and BMS keeps working.
     *   This one first, then BMS — nothing was found, so the child is an
     *     ordinary Clutter.Clone. BMS then installs its effect on an actor that
     *     already has a second consumer, and its own panel rendering drifts
     *     (reported: about 10px, whenever the dock overlaps the panel).
     *
     * Driven by comparing the resolved target each refresh rather than by
     * extension-state-changed: BMS populates _panel_blur.actors_list during and
     * after its own enable(), so a signal handler can easily look too early,
     * while "the target is not what it was" is true whenever it settles.
     */
    _reevaluateBmsClones() {
        // The cache is keyed by actor and holds "is there an offscreen effect
        // under here", which is exactly what an extension being toggled changes.
        this._existingEffectCache.clear();
        for (const [child, wasBms] of [...this._bmsStateAtClone]) {
            try {
                if (!isActorValid(child)) {
                    this._bmsStateAtClone.delete(child);
                    continue;
                }
                const isBms = !!this._findBmsDescendant(child);
                if (isBms === wasBms)
                    continue;
                utilsLog(`[Liquid Glass][ui-sampler:${this._label}] BMS state changed for ` +
                    `name="${child.name ?? '(unnamed)'}" (${wasBms} -> ${isBms}); rebuilding its clone`);
                const clone = this._clones.get(child);
                if (clone) {
                    this._clones.delete(child);
                    try {
                        clone.destroy();
                    }
                    catch (_) { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler._reevaluateBmsClones', e);
            }
        }
        // refresh() runs from each manager's per-frame tick and rebuilds whatever
        // is missing, so nothing else is needed here.
    }
    /**
     * Drops every clone built for a child that currently has a BMS target under
     * it, so the next refresh() rebuilds it down whatever path the mode now
     * selects. Called when the mode is switched at runtime.
     */
    rebuildBmsClones() {
        this._existingEffectCache.clear();
        for (const [child] of [...this._bmsStateAtClone]) {
            try {
                if (isActorValid(child) && !this._findBmsDescendant(child))
                    continue;
                const clone = this._clones.get(child);
                if (clone) {
                    this._clones.delete(child);
                    try {
                        clone.destroy();
                    }
                    catch (_) { }
                }
                this._bmsStateAtClone.delete(child);
            }
            catch (e) {
                reportFrameLoopError('UILayerSampler.rebuildBmsClones', e);
            }
        }
        this._clonedNamesLogged = '';
    }
    /**
     * Logs which uiGroup children this sampler is cloning, whenever that set
     * changes.
     *
     * Exists because "what ended up inside this glass" is otherwise invisible:
     * a wrongly-included child shows up only as a ghost of itself in the blurred
     * backdrop, with nothing in the log to say why. The dock cloning ITSELF is
     * the case this was written for.
     */
    /**
     * [window-clone-clip] Holds the cull opt-out for the windows this sampler
     * reaches THROUGH a cloned window group.
     *
     * The sampler clones uiGroup's children wholesale, and two of those children
     * are global.window_group and global.top_window_group — so every window
     * actor inside them is painted through a Clutter.Clone here too, and takes
     * the same damage-region clip from MetaShapedTexture that CullOptOutEffect
     * exists to defeat. (The UI actors themselves are St widgets: not
     * MetaCullable, no clip state, nothing to fix.)
     *
     * In practice those windows are usually already covered, because whichever
     * glass owns this sampler also runs a WindowCloneManager that clones the
     * same actors individually and holds the opt-out for them. That is luck,
     * not design: a window the manager skips (no allocation yet, hidden behind
     * a cull) would still be reached through the group clone.
     */
    _reportClonedWindowGroups() {
        let clonesAWindowGroup = false;
        for (const child of this._clones.keys()) {
            if (child === global.window_group || child === global.top_window_group) {
                clonesAWindowGroup = true;
                break;
            }
        }
        // reportClonedWindowActors() diffs before it does any work, so the common
        // case is one comparison over the window list.
        reportClonedWindowActors(this, clonesAWindowGroup ? getWindowActors() : []);
    }
    _reportClonedSet() {
        let names = '';
        for (const actor of this._clones.keys()) {
            let n = '(unnamed)';
            try {
                n = actor.name || actor.constructor?.name || '(unnamed)';
            }
            catch (_) { }
            names += (names ? ', ' : '') + n;
        }
        if (names === this._clonedNamesLogged)
            return;
        this._clonedNamesLogged = names;
        utilsLog(`[Liquid Glass][ui-sampler:${this._label}] cloning [${names}]`);
    }
    destroy() {
        _liveSamplers.delete(this);
        DND.removeDragMonitor(this._dragMonitor);
        this._dragActor = null;
        for (const [actor, id] of this._sourceDestroyIds) {
            try {
                actor.disconnect(id);
            }
            catch (_) { }
        }
        this._sourceDestroyIds.clear();
        releaseClonedWindowActors(this);
        this._bmsStateAtClone.clear();
        if (this._uiClonesContainer) {
            try {
                this._uiClonesContainer.destroy();
            }
            catch (_) { }
        }
        this._clones.clear();
        this._driftingClones.clear();
        this._selfRoot = null;
        this._existingEffectCache.clear();
    }
}
