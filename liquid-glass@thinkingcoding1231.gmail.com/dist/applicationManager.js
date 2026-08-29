// src/applicationManager.ts
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import GLib from 'gi://GLib';
import { UnpickableClone, UnpickableActor, InverseCornerEffect, getWindowActors, isActorValid } from './utils.js';
// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 10;
// Inward padding for corner rounding
const CORNER_PADDING = 3;
export class ApplicationManager {
    extensionPath;
    _states;
    _settings;
    _logger;
    _settingsSignals;
    _frameSyncId;
    _windowCreatedId;
    _restackedId = 0;
    _rebuildQueued = false;
    // ── Diagnostics for the focus-change "shifted texture" issue ───────────────
    // When > 0, _syncState() logs, for every tracked window, the raw actor
    // position vs. Meta's own frame/buffer rects, plus (for every "window
    // behind" clone) the clone's source actor's raw .x/.y vs its
    // get_transformed_position() and the position actually applied to the
    // clone. Armed for a few frames after every 'restacked' event so we can
    // see exactly which value diverges at the moment a focus-driven restack
    // happens, without spamming the log every frame during normal operation.
    _debugFocusLogFrames = 0;
    static DEBUG_FOCUS_LOG_FRAME_COUNT = 8;
    // [FIX] Standing (not debug-window-gated) anomaly detector for 3-2 ("behind
    // window disappears — not necessarily tied to a restacked event, and not
    // limited to full occlusion"). The has_allocation()-based hypothesis was
    // disproven (removing that check did not fix the symptom, and alloc-probe
    // showed it's chronically false for reasons unrelated to hiding — see
    // _syncState()). This instead flags, on ANY frame, any clone our own code
    // considers "should be showing" (src valid/visible/mapped, clone.visible
    // === true) that Clutter itself reports as actually unable to paint
    // (unmapped, unallocated, or a degenerate/zero size) — which is the
    // state that would make it invisible on screen despite our bookkeeping
    // saying otherwise. Logged only on state CHANGE (entering/leaving the
    // anomalous state) to avoid spamming once something gets stuck.
    _anomalousClones = new Set();
    // [FIX] Tracks the pending Meta.LaterType.BEFORE_REDRAW chain from
    // _rebuildAllClones()'s post-restack follow-up passes (see there), so
    // _removeAllEffects() can cancel it — otherwise a still-pending later
    // would fire after cleanup and touch destroyed state.
    _rebuildFollowupLaterId = 0;
    constructor(extensionPath, settings, logger) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._logger = logger;
        this._states = new Map();
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._windowCreatedId = 0;
        this._restackedId = 0;
    }
    setup() {
        this._logger.log("[Liquid Glass] ApplicationManager setup starting...");
        this._bindSettings();
        this._windowCreatedId = global.display.connect('window-created', (_d, metaWindow) => {
            this._logger.log(`[Liquid Glass] window-created event: window title = "${metaWindow.get_title()}", class = "${metaWindow.get_wm_class()}"`);
            const obj = metaWindow.get_compositor_private();
            if (!obj) {
                this._logger.log("[Liquid Glass] get_compositor_private() returned null");
                return;
            }
            if (!(obj instanceof Meta.WindowActor)) {
                this._logger.log("[Liquid Glass] compositor object is not instance of Meta.WindowActor");
                return;
            }
            this._logger.log("[Liquid Glass] window compositor actor found. Connecting to first-frame.");
            obj.connect('first-frame', () => {
                this._logger.log("[Liquid Glass] first-frame event fired for window: " + metaWindow.get_title());
                if (this._shouldApplyToWindow(obj)) {
                    this._setupWindow(obj);
                    this._rebuildAllClones();
                }
            });
        });
        this._restackedId = global.display.connect('restacked', () => {
            this._rebuildAllClones();
            // Arm the diagnostic logging for the next few frames — see
            // _debugFocusLogFrames and _logFocusDebugInfo() for the "shifted
            // texture on focus change" investigation.
            this._debugFocusLogFrames = ApplicationManager.DEBUG_FOCUS_LOG_FRAME_COUNT;
            this._logger.log('[Liquid Glass][focus-debug] ---- restacked event ----');
        });
        this._logger.log("[Liquid Glass] checking if effect enabled in setup: " + this._isEffectEnabled());
        if (this._isEffectEnabled())
            this._applyEffects();
    }
    cleanup() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = 0;
        }
        this._settingsSignals.forEach(id => this._settings.disconnect(id));
        this._settingsSignals = [];
        this._removeAllEffects();
    }
    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback);
            this._settingsSignals.push(id);
        };
        connectSetting('enable-application-glass', () => {
            this._logger.log("[Liquid Glass] enable-application-glass setting changed to: " + this._isEffectEnabled());
            if (this._isEffectEnabled())
                this._applyEffects();
            else
                this._removeAllEffects();
        });
        // Apply to every normal/dialog window, bypassing the whitelist entirely.
        connectSetting('application-glass-all-windows', () => this._syncWhitelist());
        // Opacity of the window's own content layer, so the glass underneath is visible through it.
        connectSetting('application-content-opacity', () => this._updateWindowOpacities());
        connectSetting('application-window-whitelist', () => this._syncWhitelist());
        connectSetting('application-tint-color', () => this._updateEffectParams());
        connectSetting('application-tint-strength', () => this._updateEffectParams());
        connectSetting('application-blur-radius', () => this._updateEffectParams());
        connectSetting('application-corner-radius', () => this._updateEffectParams());
        connectSetting('application-brightness', () => this._updateEffectParams());
        connectSetting('application-contrast', () => this._updateEffectParams());
        connectSetting('application-saturation', () => this._updateEffectParams());
    }
    _getContentOpacity() {
        return this._settings.get_double('application-content-opacity');
    }
    _updateWindowOpacities() {
        const targetOpacity = Math.round(this._getContentOpacity() * 255);
        this._logger.log("[Liquid Glass] Updating window content opacities to: " + targetOpacity);
        for (let state of this._states.values()) {
            // Use the cached reference, NOT windowActor.get_first_child() — after
            // _setupWindow inserts baseActor below it, get_first_child() returns
            // baseActor instead of the real surface, so it stopped being live-updated.
            if (isActorValid(state.surfaceActor)) {
                state.surfaceActor.opacity = targetOpacity;
            }
        }
    }
    _isEffectEnabled() {
        const enabled = this._settings.get_boolean('enable-application-glass');
        return enabled;
    }
    _getWhitelist() {
        let whitelist = this._settings.get_strv('application-window-whitelist');
        return whitelist;
    }
    _windowMatchesWhitelist(metaWindow) {
        const whitelist = this._getWhitelist();
        const appName = metaWindow.get_wm_class();
        if (whitelist.length === 0) {
            return false;
        }
        let ret = !!appName && whitelist.includes(appName);
        if (!ret) {
            this._logger.log("[Liquid Glass] window is not in whitelist. name = " + appName);
        }
        else {
            this._logger.log("[Liquid Glass] window is in whitelist. name = " + appName);
        }
        return ret;
    }
    _shouldApplyToWindow(windowActor) {
        if (!this._isEffectEnabled()) {
            return false;
        }
        const metaWindow = windowActor.get_meta_window();
        if (!metaWindow) {
            return false;
        }
        // "Apply to all windows" bypasses the whitelist, but is still restricted to
        // normal/dialog windows so we never touch desktop backgrounds, panels, etc.
        const applyAll = this._settings.get_boolean('application-glass-all-windows');
        if (applyAll) {
            const windowType = metaWindow.get_window_type();
            const isNormal = windowType === Meta.WindowType.NORMAL ||
                windowType === Meta.WindowType.DIALOG ||
                windowType === Meta.WindowType.MODAL_DIALOG;
            if (!isNormal) {
                this._logger.log(`[Liquid Glass] window "${metaWindow.get_title()}" has special type ${windowType}, skipping...`);
                return false;
            }
            return true;
        }
        return this._windowMatchesWhitelist(metaWindow);
    }
    _applyEffects() {
        this._logger.log("[Liquid Glass] _applyEffects called");
        this._buildForExistingWindows();
        this._startFrameSync();
    }
    _removeAllEffects() {
        if (this._frameSyncId) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._frameSyncId);
            }
            this._frameSyncId = 0;
        }
        if (this._rebuildFollowupLaterId) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._rebuildFollowupLaterId);
            }
            this._rebuildFollowupLaterId = 0;
        }
        for (let state of this._states.values())
            this._cleanupState(state);
        this._states.clear();
        this._rebuildQueued = false;
    }
    _syncWhitelist() {
        if (!this._isEffectEnabled()) {
            this._removeAllEffects();
            return;
        }
        for (let [actor, state] of [...this._states.entries()]) {
            if (!this._shouldApplyToWindow(actor)) {
                this._cleanupState(state);
                this._states.delete(actor);
            }
        }
        for (let actor of getWindowActors()) {
            if (this._shouldApplyToWindow(actor) && !this._states.has(actor))
                this._setupWindow(actor);
        }
        this._rebuildAllClones();
    }
    _updateEffectParams() {
        let tintColorStr = this._settings.get_string('application-tint-color');
        let tintStrength = this._settings.get_double('application-tint-strength');
        let blurRadius = this._settings.get_int('application-blur-radius');
        let cornerRadius = this._settings.get_double('application-corner-radius');
        let brightness = this._settings.get_double('application-brightness');
        let contrast = this._settings.get_double('application-contrast');
        let saturation = this._settings.get_double('application-saturation');
        for (let state of this._states.values()) {
            state.effect.setTintColor(...this._hexToColorArray(tintColorStr));
            state.effect.setTintStrength(tintStrength);
            state.effect.setCornerRadius(cornerRadius);
            state.effect.setBlurRadius(blurRadius);
            state.effect.setBrightness(brightness);
            state.effect.setContrast(contrast);
            state.effect.setSaturation(saturation);
            state.roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
            state.roundingEffect.setInset(this._cornerOverlayInset());
        }
    }
    // [FIX] This used to be SHADER_PADDING + CORNER_PADDING, and
    // InverseCornerEffect used it to shrink its rounded-rect cut inward by the
    // same amount on every side (straight edges included), instead of only
    // pulling the 4 actual corners inward. That revealed a uniform band of
    // raw, unblurred/unshadowed background all the way around the window —
    // see InverseCornerEffect._updateShader() in utils.ts for the full
    // explanation. The overlay now derives the window's true edge from this
    // value alone (it equals SHADER_PADDING, the outward padding this actor
    // has beyond the real window bounds), while CORNER_PADDING is applied
    // only to the radius (below) so it exclusively affects the corner arcs.
    _cornerOverlayInset() {
        return SHADER_PADDING;
    }
    _startFrameSync() {
        if (this._frameSyncId === 0)
            this._frameTick();
    }
    _rebuildAllClones() {
        if (this._rebuildQueued)
            return;
        this._rebuildQueued = true;
        // Debounce to next idle to avoid crashing during rapid restacking/creation
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._states.size === 0) {
                this._rebuildQueued = false;
                return GLib.SOURCE_REMOVE;
            }
            for (let state of this._states.values()) {
                this._rebuildWindowClones(state);
            }
            this._rebuildQueued = false;
            // [FIX] Reported symptom (two variants of the same underlying gap):
            // (a) after several quick focus switches, the window that should show
            //     behind the newly-focused one sometimes never appears until the
            //     focused window is moved; (b) a newly-focused window's outer
            //     ~SHADER_PADDING-px edge briefly shows ONLY the wallpaper (no
            //     other windows) right after the focus switch, self-correcting
            //     within well under a second. Both point at this debounced
            //     rebuild occasionally running against a stacking order Mutter
            //     hasn't fully settled yet when several 'restacked' signals fire
            //     in a tight burst (e.g. a single click emits raise + focus
            //     signals close together), with the visible gap lasting until
            //     something else catches it up.
            //
            // Previously this was a single GLib.timeout_add(..., 150, ...)
            // "safety net" — a plain wall-clock guess with no relation to actual
            // frame timing, so the visible gap could span many frames (up to
            // 150ms) before the follow-up pass ran. Replaced with a short chain
            // of Meta.LaterType.BEFORE_REDRAW laters (the same primitive
            // _frameTick() itself uses) so the follow-up passes run on the very
            // next few actual frames instead of after an arbitrary delay,
            // shrinking the visible window considerably. Still a mitigation for
            // a not-fully-confirmed race, not a verified fix for the settling
            // delay itself — please report back if either variant still
            // reproduces.
            const FOLLOWUP_FRAME_COUNT = 0;
            let followupFramesLeft = FOLLOWUP_FRAME_COUNT;
            // [FIX] Meta.Laters callbacks are GSourceFuncs and must return a
            // boolean (GLib.SOURCE_REMOVE/CONTINUE) — an implicit `undefined`
            // return was passed here before.
            const runFollowup = () => {
                followupFramesLeft--;
                if (this._states.size > 0) {
                    for (let state of this._states.values()) {
                        this._rebuildWindowClones(state);
                    }
                }
                if (followupFramesLeft > 0) {
                    this._rebuildFollowupLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runFollowup);
                }
                else {
                    this._rebuildFollowupLaterId = 0;
                }
                return GLib.SOURCE_REMOVE;
            };
            this._rebuildFollowupLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, runFollowup);
            return GLib.SOURCE_REMOVE;
        });
    }
    _buildForExistingWindows() {
        for (let actor of getWindowActors()) {
            if (this._shouldApplyToWindow(actor))
                this._setupWindow(actor);
        }
    }
    _setupWindow(windowActor) {
        if (!windowActor || !(windowActor instanceof Meta.WindowActor) || this._states.has(windowActor))
            return;
        if (!this._shouldApplyToWindow(windowActor))
            return;
        let surfaceActor = windowActor.get_first_child();
        if (!surfaceActor) {
            return;
        }
        let parent = windowActor.get_parent();
        if (!parent)
            return;
        // [FIX] 3-2 ("behind window disappears from another window's glass —
        // not tied to a restacked event, and reproduces even with the source
        // only PARTIALLY covered, not just fully hidden"). Tried so far:
        //   1. Removing the has_allocation() gate from the per-frame clone sync
        //      loop (see _syncState()) — DISPROVEN by [alloc-probe] logging AND
        //      by this not fixing the symptom.
        //   2. windowActor.inhibit_culling() here — CONFIRMED to be the actual
        //      cause of the disappearing-clone symptom: removing it (along
        //      with baseActor/bgActor's own inhibit_culling() calls below,
        //      tested together) fixed it completely. Best-effort explanation:
        //      inhibit_culling() is meant for actors that are NOT themselves
        //      the "real" live on-screen content of a window — overlays,
        //      clone-only proxies, drag icons — and forces Clutter/Mutter to
        //      treat them as always relevant regardless of geometry. Calling
        //      it on `windowActor` itself — the actual live window, whose
        //      real on-screen compositing/buffer-swap state our OWN clones
        //      then sample from — likely interfered with Mutter's normal
        //      texture-update bookkeeping for that live window in a way
        //      unrelated to (and worse than) the plain scene-graph occlusion
        //      problem it's meant to solve for overlay-only actors; the
        //      REMOVED comment's theory (Mutter suspending compositing of a
        //      fully-covered window) doesn't fully explain it either, since
        //      the symptom also happened with only partial coverage. NOT
        //      reapplying it here.
        // baseActor/bgActor below are NOT live window content (they're our own
        // overlay actors, added as children of surfaceActor's sibling) and
        // exist to fix a DIFFERENT, earlier-diagnosed problem: Clutter's own
        // scene-graph occlusion culling doesn't know surfaceActor above them
        // is translucent, and would otherwise conclude baseActor/bgActor are
        // fully covered and skip painting them. Restoring those two only.
        // Store the surface's original opacity and dial it down so the glass behind
        // it is actually visible; restored in _cleanupState when the effect is removed.
        let originalOpacity = surfaceActor.opacity;
        surfaceActor.opacity = Math.round(this._getContentOpacity() * 255);
        let baseActor = new St.Widget({
            style_class: 'liquid-glass-base-actor',
            reactive: false,
            clip_to_allocation: true,
            visible: true,
        });
        windowActor.insert_child_below(baseActor, surfaceActor);
        let bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            reactive: false,
            clip_to_allocation: false,
            visible: true,
        });
        windowActor.insert_child_above(bgActor, baseActor);
        // [FIX] Both actors sit entirely behind surfaceActor (the window's own
        // content), which is what makes the glass show "through" it once its
        // opacity is dialed down below. Clutter's own occlusion culling
        // doesn't know that surfaceActor is translucent, though -- it treats
        // it as opaque and, on a window's first paint (before anything else
        // has forced a relayout), can conclude baseActor/bgActor are fully
        // covered and skip painting them entirely. That produced a black
        // background behind the window's translucent chrome until something
        // else (resize, move, opening another window, defocusing) forced
        // Clutter to reconsider.
        //
        // This USED to be fixed with baseActor.inhibit_culling()/
        // bgActor.inhibit_culling() — but per the SAME 3-2 investigation as
        // windowActor's (see above), that inhibit_culling() call was confirmed
        // to be the actual cause of the disappearing-clone bug, and NOT just
        // on windowActor: removing baseActor/bgActor's calls too (leaving
        // windowActor's already-removed) was independently required to fully
        // fix it. Best guess at why: baseActor/bgActor are CHILDREN of
        // windowActor, so when windowActor is used as a Clutter.Clone SOURCE
        // elsewhere, they're part of what gets cloned too — inhibit_culling()
        // appears to break in this environment specifically for any actor
        // that's cloned (or descends from something cloned) via Clutter.Clone,
        // regardless of which of the three actors it's called on.
        //
        // Both calls are removed now (tested, fixes the disappearing-clone
        // bug). This risks REINTRODUCING the original black-background-on-
        // first-paint bug this was written for, since it has no other
        // mitigation right now — if a window's glass looks solid black/missing
        // right when it first opens, and only fixes itself once you move/
        // resize/refocus it, that's this old bug back; please report it so we
        // can find an inhibit_culling-free fix specifically for that case.
        let clipBox = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
        });
        bgActor.add_child(clipBox);
        // Size the clones to cover the full monitor so the wallpaper fills correctly.
        let monitor = Main.layoutManager.primaryMonitor;
        let baseClone = new UnpickableClone({
            source: Main.layoutManager._backgroundGroup,
        });
        if (monitor) {
            baseClone.set_size(monitor.width, monitor.height);
        }
        baseActor.add_child(baseClone);
        let baseWindowsContainer = new Clutter.Actor();
        baseActor.add_child(baseWindowsContainer);
        let bgClone = new UnpickableClone({
            source: Main.layoutManager._backgroundGroup,
        });
        if (monitor) {
            bgClone.set_size(monitor.width, monitor.height);
        }
        clipBox.add_child(bgClone);
        let effect = new LiquidEffect({
            extensionPath: this.extensionPath,
            settings: this._settings,
            logger: this._logger,
        });
        let tintColorStr = this._settings.get_string('application-tint-color');
        let tintStrength = this._settings.get_double('application-tint-strength');
        let cornerRadius = this._settings.get_double('application-corner-radius');
        let blurRadius = this._settings.get_int('application-blur-radius');
        let brightness = this._settings.get_double('application-brightness');
        let contrast = this._settings.get_double('application-contrast');
        let saturation = this._settings.get_double('application-saturation');
        effect.setPadding(SHADER_PADDING);
        effect.setTintColor(...this._hexToColorArray(tintColorStr));
        effect.setTintStrength(tintStrength);
        effect.setCornerRadius(cornerRadius);
        effect.setBlurRadius(blurRadius);
        effect.setBrightness(brightness);
        effect.setContrast(contrast);
        effect.setSaturation(saturation);
        effect.setIsDock(false);
        // Application windows should read as plain "drop shadow + AO" at the
        // edge (like dockManager's shadow treatment), not the dock/menu-style
        // rim + specular + sheen glass glint — that glint sits right at the
        // window's true edge and, combined with the window's own (often
        // non-opaque) content, reads as a distracting bright frame around the
        // window. Blur/tint/refraction are unaffected; only this glint group
        // is turned off, and only for this per-window effect instance — the
        // shared glass-rim-*/glass-sheen-*/glass-specular-* settings still
        // apply normally to the dock, menu, notification, quick-settings and
        // OSD glass.
        effect.setSurfaceLightEnabled(false);
        // Keep the drop-shadow within the small padded border around the window,
        // rather than the huge margin dockManager uses for its full-screen FBO.
        effect.setShadowMaxRadius(SHADER_PADDING);
        bgActor.add_effect(effect);
        let windowsContainer = new Clutter.Actor();
        clipBox.add_child(windowsContainer);
        let cornerOverlay = new UnpickableActor({
            clip_to_allocation: true,
            reactive: false,
        });
        let cornerOverlayClone = new UnpickableClone({ source: baseActor });
        cornerOverlay.add_child(cornerOverlayClone);
        let roundingEffect = new InverseCornerEffect();
        roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
        roundingEffect.setInset(this._cornerOverlayInset());
        cornerOverlay.add_effect(roundingEffect);
        windowActor.add_child(cornerOverlay);
        let state = {
            windowActor,
            surfaceActor,
            bgActor,
            clipBox,
            bgClone,
            windowsContainer,
            clones: new Map(),
            effect,
            baseActor,
            baseClone,
            baseWindowsContainer,
            baseClones: new Map(),
            roundingEffect,
            cornerOverlay,
            cornerOverlayClone,
            signals: [],
            originalOpacity,
        };
        this._states.set(windowActor, state);
        this._rebuildWindowClones(state);
        // Immediate sync connections for resize/move using allocation property
        state.signals.push({
            obj: windowActor,
            id: windowActor.connect('notify::allocation', () => this._syncState(state))
        });
        const metaWin = windowActor.get_meta_window();
        if (metaWin) {
            state.signals.push({
                obj: metaWin,
                id: metaWin.connect('size-changed', () => {
                    this._rebuildWindowClones(state);
                    this._syncState(state);
                })
            });
            state.signals.push({
                obj: metaWin,
                id: metaWin.connect('position-changed', () => {
                    this._syncState(state);
                })
            });
        }
        // Use a later to ensure the initial sync happens after actors are properly added to stage
        global.compositor.get_laters().add(Meta.LaterType.IDLE, () => {
            if (this._states.has(windowActor)) {
                this._syncState(state);
            }
            return false;
        });
        windowActor.connect('destroy', () => {
            this._cleanupState(state);
            this._states.delete(windowActor);
            this._rebuildAllClones();
        });
    }
    _hexToColorArray(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7)
            return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }
    _rebuildWindowClones(state) {
        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();
        state.windowsContainer.remove_all_children();
        state.baseClones.forEach(clone => clone.destroy());
        state.baseClones.clear();
        state.baseWindowsContainer.remove_all_children();
        const debugLog = this._debugFocusLogFrames > 0;
        if (debugLog) {
            const titles = getWindowActors().map((a) => {
                const mw = typeof a.get_meta_window === 'function' ? a.get_meta_window() : null;
                return mw ? (mw.get_title() || '(untitled)') : '(?)';
            });
            const ownTitle = (() => {
                const mw = state.windowActor.get_meta_window();
                return mw ? (mw.get_title() || '(untitled)') : '(?)';
            })();
            this._logger.log(`[Liquid Glass][focus-debug] _rebuildWindowClones for="${ownTitle}" ` +
                `stackingOrder=[${titles.join(', ')}]`);
        }
        // Get windows in stacking order (bottom to top)
        for (let actor of getWindowActors()) {
            // STOP iterating once we reach our own window.
            // This ensures we ONLY render what is actually BEHIND the app.
            if (actor === state.windowActor)
                break;
            if (!(actor instanceof Meta.WindowActor))
                continue;
            // [FIX] Skip sources with no valid size. The Clutter-WARNING spam
            // ("needs an allocation") turned out to scale with the number of
            // open glass windows rather than with the reported "missing behind
            // window" bug specifically — every window's clone list always
            // includes the SAME actor (logged as "@!0,0;BDHF", always first/
            // bottommost, always at (0,0) — almost certainly the desktop
            // background layer), suggesting THAT clone is the one perpetually
            // stuck without a resolvable allocation, independent of the other
            // issue. A clone built from a source reporting 0 or non-finite
            // size can never produce a valid allocation regardless of how many
            // times it's re-synced, so there's no point creating it.
            let [srcW, srcH] = actor.get_size();
            if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
                continue;
            }
            let clone = new UnpickableClone({ source: actor });
            // [FIX] Give the clone its correct geometry RIGHT NOW, synchronously,
            // instead of leaving it at whatever default position a freshly
            // constructed actor starts at (effectively (0,0)) until the next
            // _syncState() call happens to run on a later frame. The focus-debug
            // log confirms this gap is real: right after a 'restacked' event,
            // clone.(x,y) was logged as (0,0) for one _syncState pass before
            // snapping to the correct (e.g. (1181,134)) position on the very
            // next pass — i.e. Clutter had at least one opportunity to paint this
            // clone at the wrong (0,0) spot. That one-frame "content that belongs
            // at local (x,y) inside window A renders at screen (~0,0) instead" is
            // exactly the shape of the reported texture-shift artifact.
            clone.set_position(actor.x, actor.y);
            clone.set_size(srcW, srcH);
            clone.set_scale(actor.scale_x, actor.scale_y);
            clone.opacity = actor.opacity;
            state.windowsContainer.add_child(clone);
            state.clones.set(actor, clone);
            let baseClone = new UnpickableClone({ source: actor });
            baseClone.set_position(actor.x, actor.y);
            baseClone.set_size(srcW, srcH);
            baseClone.set_scale(actor.scale_x, actor.scale_y);
            baseClone.opacity = actor.opacity;
            state.baseWindowsContainer.add_child(baseClone);
            state.baseClones.set(actor, baseClone);
        }
    }
    // ── Counter-scale + crop compensation (open/close animation fix) ───────────
    // bgActor / baseActor / cornerOverlay are literal children of `windowActor`
    // (see _setupWindow) so they inherit ANY transform GNOME applies to
    // windowActor — including the scale_x/scale_y (and pivot_point) GNOME's
    // native map/close animation uses for its zoom effect.
    //
    // What we want: the glass's OUTER boundary should shrink/grow together
    // with the window, exactly like it did before any of this — but the
    // CONTENT sampled through it (a snapshot of the real desktop/other
    // windows behind) must never visibly stretch/squish, since that content
    // is supposed to represent fixed, 1:1 real screen pixels. A shrinking
    // pane of glass in front of a fixed backdrop should reveal LESS of that
    // backdrop as it shrinks (crop), not a squished-down copy of the whole
    // thing.
    //
    // This is done in two parts:
    //  1. Cancel windowActor's inherited scale on the child (same compensated
    //     position + inverse scale as before) so the child ALWAYS renders its
    //     content at true, undistorted 1:1 scale, anchored at the fixed
    //     position it would have at scale = 1.
    //  2. Clip the child to the window's CURRENT (shrunk) on-screen footprint,
    //     expressed in the child's own (now-true-scale) local coordinates, so
    //     only the portion of that true-scale content within the window's
    //     current visible silhouette is actually shown — this is what makes
    //     the outer boundary track the window's live size again, but as a
    //     crop of the true content rather than a squish of it.
    //
    // Math (windowActor scales by (sx,sy) around pivot P, P in LOCAL PIXELS =
    // pivot_point * windowActor's own size; windowActor.x/y — its allocation
    // position — does NOT change with scale, only its painted appearance
    // does, so it's a stable anchor for both computations):
    //   compensated local position: (lx',ly') = P + ((lx,ly) - P) / (sx,sy)
    //   current visible window rect, in the SAME "true/anchor" coordinate
    //   space the compensated child now renders in:
    //     winX = windowActor.x + P.x*(1-sx),  winW = windowActor.width * sx
    //     winY = windowActor.y + P.y*(1-sy),  winH = windowActor.height * sy
    //   child's true on-screen origin = windowActor.x + lx, windowActor.y + ly
    //   clip (in child-local coords) = winRect shifted by -childTrueOrigin
    // At sx = sy = 1 this reduces to (lx',ly') = (lx,ly) and a clip covering
    // the child's whole area — i.e. a no-op — so it's safe to call
    // unconditionally every frame.
    _applyCounterScale(child, windowActor, lx, ly, w, h) {
        let [sx, sy] = windowActor.get_scale();
        if (!Number.isFinite(sx) || sx === 0)
            sx = 1;
        if (!Number.isFinite(sy) || sy === 0)
            sy = 1;
        child.set_pivot_point(0, 0);
        if (sx === 1 && sy === 1) {
            child.set_scale(1, 1);
            child.set_position(lx, ly);
            child.remove_clip();
            return;
        }
        const [pivotFracX, pivotFracY] = windowActor.get_pivot_point();
        const [waW, waH] = windowActor.get_size();
        const pxPixels = pivotFracX * (Number.isFinite(waW) ? waW : 0);
        const pyPixels = pivotFracY * (Number.isFinite(waH) ? waH : 0);
        const compLx = pxPixels + (lx - pxPixels) / sx;
        const compLy = pyPixels + (ly - pyPixels) / sy;
        child.set_scale(1 / sx, 1 / sy);
        child.set_position(compLx, compLy);
        // Current visible window footprint and the child's true origin, both
        // expressed relative to windowActor's own (scale-independent) anchor.
        const clipX = pxPixels * (1 - sx) - lx;
        const clipY = pyPixels * (1 - sy) - ly;
        const clipW = (Number.isFinite(waW) ? waW : w) * sx;
        const clipH = (Number.isFinite(waH) ? waH : h) * sy;
        child.set_clip(clipX, clipY, clipW, clipH);
    }
    _syncState(state) {
        let actor = state.windowActor;
        if (!actor || !actor.get_stage() || !actor.mapped) {
            state.bgActor.visible = false;
            state.baseActor.visible = false;
            state.cornerOverlay.visible = false;
            return;
        }
        if (!actor.has_allocation()) {
            return;
        }
        const metaWin = actor.get_meta_window();
        if (!metaWin)
            return;
        // [PERF] Single flag, see LiquidEffect.DRAG_PERF_MODE_ENABLED — no-op
        // (both calls below become no-ops internally) unless that's true.
        // "grabbed AND this window has focus" is the same proxy used by the
        // bg-lag diagnostic logging above for "this window is the one currently
        // being dragged" (GNOME 50/Meta 18 removed get_grab_op()/
        // get_grab_window()).
        const isDraggingThisWindow = global.display.is_grabbed() && global.display.get_focus_window() === metaWin;
        state.effect.beginBatch();
        try {
            this._syncStateInner(state, actor, metaWin, isDraggingThisWindow);
        }
        finally {
            // [PERF] try/finally is load-bearing here, not defensive style: the
            // inner function has multiple early `return`s (workspace check,
            // degenerate rect check) that would otherwise leave beginBatch()
            // unmatched — a leaked, permanently-incremented _batchDepth would
            // silently swallow every future queue_repaint() call for this
            // window's effect for the rest of the session once
            // DRAG_PERF_MODE_ENABLED is on.
            state.effect.endBatch();
        }
    }
    // [PERF] Split out of _syncState() purely so the try/finally above can
    // wrap it with a single call instead of duplicating "state.effect.
    // endBatch()" before every one of the early returns already inside this
    // body — behavior is otherwise identical to before this file's
    // DRAG_PERF_MODE_ENABLED work.
    _syncStateInner(state, actor, metaWin, isDraggingThisWindow) {
        state.effect.setFastMode(isDraggingThisWindow);
        // PERFORMANCE: Only sync windows on the current active workspace.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const winWorkspace = metaWin.get_workspace();
        if (winWorkspace && winWorkspace !== activeWorkspace) {
            if (state.bgActor.visible)
                state.bgActor.visible = false;
            if (state.baseActor.visible)
                state.baseActor.visible = false;
            if (state.cornerOverlay.visible)
                state.cornerOverlay.visible = false;
            return;
        }
        if (this._debugFocusLogFrames > 0)
            this._logFocusDebugInfo(state);
        const rect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();
        if (!rect || !bufferRect || rect.width <= 0 || rect.height <= 0) {
            if (state.bgActor.visible)
                state.bgActor.visible = false;
            if (state.baseActor.visible)
                state.baseActor.visible = false;
            if (state.cornerOverlay.visible)
                state.cornerOverlay.visible = false;
            return;
        }
        if (!state.bgActor.visible)
            state.bgActor.visible = true;
        if (!state.baseActor.visible)
            state.baseActor.visible = true;
        // Local offset of the visible frame within the window actor's full buffer.
        const frameLocalX = rect.x - bufferRect.x;
        const frameLocalY = rect.y - bufferRect.y;
        // Base background (unblurred) expanded by expansion margin.
        // Positioned/clipped via _applyCounterScale() so its rendered content
        // stays true-scale (undistorted) while its outer boundary still tracks
        // the window's live (possibly animating) size — see _applyCounterScale()
        // for the full rationale.
        const baseActorW = rect.width + (SHADER_PADDING * 2);
        const baseActorH = rect.height + (SHADER_PADDING * 2);
        state.baseActor.set_size(baseActorW, baseActorH);
        this._applyCounterScale(state.baseActor, actor, frameLocalX - SHADER_PADDING, frameLocalY - SHADER_PADDING, baseActorW, baseActorH);
        // Glass background (blurred) expanded by padding.
        const bgW = rect.width + (SHADER_PADDING * 2);
        const bgH = rect.height + (SHADER_PADDING * 2);
        const localX = frameLocalX - SHADER_PADDING;
        const localY = frameLocalY - SHADER_PADDING;
        state.bgActor.set_size(bgW, bgH);
        this._applyCounterScale(state.bgActor, actor, localX, localY, bgW, bgH);
        state.clipBox.set_position(0, 0);
        state.clipBox.set_size(bgW, bgH);
        // [FIX] windowsContainer is a plain `new Clutter.Actor()` (see
        // _setupWindow) that was never explicitly sized anywhere — only the
        // CLONES placed inside it were. A plain Clutter.Actor with no layout
        // manager has no children-driven preferred size, so without an
        // explicit set_size() here its own natural size resolves to 0x0,
        // which can leave it (and therefore everything absolutely-positioned
        // inside it) without a meaningful allocation to cascade from,
        // regardless of how correctly each individual clone's own position/
        // size is set. This is a plausible root cause for clones perpetually
        // reporting "needs an allocation" independent of their own geometry
        // being correct — give the container itself a real, non-zero size
        // matching what it's meant to represent (the same area as clipBox).
        // (Its position is set separately below, alongside the existing
        // -absX/-absY offset logic — only the size was ever missing.)
        state.windowsContainer.set_size(bgW, bgH);
        // Update shader resolution/geometry with the expanded bounds. The glass
        // rect always fills the whole (small, non full-screen) bgActor here, so
        // glass geometry is simply (0, 0, bgW, bgH).
        if (state.effect) {
            state.effect.setResolution(bgW, bgH);
            state.effect.setGlassGeometry(0, 0, bgW, bgH);
        }
        // Use absolute screen coordinates for wallpaper fix
        const absX = rect.x - SHADER_PADDING;
        const absY = rect.y - SHADER_PADDING;
        // Offset for the clipped (blurred) content
        state.bgClone.set_position(-absX, -absY);
        state.windowsContainer.set_position(-absX, -absY);
        // Offset for the base (unblurred) content (baseActor is inset by SHADER_PADDING).
        const baseScreenX = rect.x - SHADER_PADDING;
        const baseScreenY = rect.y - SHADER_PADDING;
        state.baseClone.set_position(-baseScreenX, -baseScreenY);
        state.baseWindowsContainer.set_position(-baseScreenX, -baseScreenY);
        // [FIX] Same 0x0-preferred-size issue as windowsContainer above.
        state.baseWindowsContainer.set_size(baseActorW, baseActorH);
        // [FIX] 3-2 investigation history ("behind window disappears — not
        // tied to a restacked event, reproduces even with the source only
        // PARTIALLY covered"). RESOLVED — see _setupWindow() for the final
        // root cause (windowActor.inhibit_culling() was itself the bug).
        // _checkCloneAnomaly() below is left in as a standing (always-on, not
        // restack-window-gated) sanity check: it flags any frame where our
        // bookkeeping considers a clone showable (src ok, clone.visible=true)
        // but Clutter itself reports the CLONE can't actually paint (unmapped
        // or a degenerate/zero size), independent of any restack timing
        // window — useful general-purpose coverage even though it wasn't what
        // ultimately caught this particular bug. Logs only on state
        // transitions (entering/leaving the anomalous state) to avoid spam.
        // Sync blurred clones
        for (let [src, clone] of state.clones.entries()) {
            if (!isActorValid(src) || !src.visible || !src.mapped) {
                if (isActorValid(clone) && clone.visible)
                    clone.hide();
                this._clearCloneAnomaly(clone);
                continue;
            }
            if (isActorValid(clone)) {
                if (!clone.visible)
                    clone.show();
                clone.set_position(src.x, src.y);
                clone.set_size(src.width, src.height);
                clone.set_scale(src.scale_x, src.scale_y);
                clone.opacity = src.opacity;
                this._checkCloneAnomaly(clone, src, 'blurred');
            }
        }
        // Sync base clones (unblurred)
        for (let [src, clone] of state.baseClones.entries()) {
            if (!isActorValid(src) || !src.visible || !src.mapped) {
                if (isActorValid(clone) && clone.visible)
                    clone.hide();
                this._clearCloneAnomaly(clone);
                continue;
            }
            if (isActorValid(clone)) {
                if (!clone.visible)
                    clone.show();
                clone.set_position(src.x, src.y);
                clone.set_size(src.width, src.height);
                clone.set_scale(src.scale_x, src.scale_y);
                clone.opacity = src.opacity;
                this._checkCloneAnomaly(clone, src, 'base');
            }
        }
        if (!state.cornerOverlay.visible) {
            state.cornerOverlay.show();
        }
        const baseW = rect.width + (SHADER_PADDING * 2);
        const baseH = rect.height + (SHADER_PADDING * 2);
        state.cornerOverlay.set_size(baseW, baseH);
        this._applyCounterScale(state.cornerOverlay, actor, frameLocalX - SHADER_PADDING, frameLocalY - SHADER_PADDING, baseW, baseH);
        state.cornerOverlayClone.set_position(0, 0);
        state.cornerOverlayClone.set_size(baseW, baseH);
    }
    // [FIX] See the 3-2 investigation comment above _syncState()'s clone sync
    // loops. `kind` is just "blurred"/"base" for the log line. Deliberately
    // does NOT check has_allocation() — we just called set_position()/
    // set_size() on this same clone moments earlier in this same frame,
    // which (per the BEFORE_REDRAW timing already confirmed via
    // [alloc-probe]) would make has_allocation() read false unconditionally
    // regardless of whether anything is actually wrong; including it here
    // would just spam false positives every frame. `mapped` and a
    // degenerate/zero size are the only checks that don't have that problem.
    _checkCloneAnomaly(clone, src, kind) {
        let mapped = true, w = -1, h = -1;
        try {
            mapped = clone.mapped;
        }
        catch (e) { }
        try {
            [w, h] = clone.get_size();
        }
        catch (e) { }
        const degenerate = !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0;
        const anomalous = !mapped || degenerate;
        if (anomalous && !this._anomalousClones.has(clone)) {
            this._anomalousClones.add(clone);
            const srcMetaWindow = typeof src.get_meta_window === 'function' ? src.get_meta_window() : null;
            const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
            this._logger.log(`[Liquid Glass][clone-anomaly] ENTER kind=${kind} src="${srcTitle}" ` +
                `mapped=${mapped} size=(${w}x${h}) ` +
                `clone.(x,y)=(${clone.x},${clone.y}) clone.visible=${clone.visible} clone.opacity=${clone.opacity}`);
        }
        else if (!anomalous && this._anomalousClones.has(clone)) {
            this._anomalousClones.delete(clone);
            const srcMetaWindow = typeof src.get_meta_window === 'function' ? src.get_meta_window() : null;
            const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
            this._logger.log(`[Liquid Glass][clone-anomaly] EXIT kind=${kind} src="${srcTitle}"`);
        }
    }
    _clearCloneAnomaly(clone) {
        this._anomalousClones.delete(clone);
    }
    // [DIAG] "Window background lags a moment behind the real background
    // while dragging" — round 1 confirmed our own tick cadence is a rock
    // solid ~16.6ms (60Hz), so the self-rescheduling BEFORE_REDRAW chain is
    // NOT introducing irregular delay. That rules out hypothesis (1) below;
    // (2) is still open.
    //
    //  1. [RULED OUT] Our BEFORE_REDRAW later chain running irregularly.
    //     dtSinceLastTick stayed in a tight ~16-17ms band throughout an
    //     entire drag in the field log — no stalls, no catch-up bursts.
    //
    //  2. [STILL OPEN] `bgActorPos` in round 1 was useless for telling this
    //     apart — `state.bgActor` sits INSIDE `state.windowActor` and is
    //     positioned via _applyCounterScale() as a small, constant
    //     SHADER_PADDING offset (hence it read a flat (35.0, 23.0) for the
    //     entire drag: that's the padding, not the window's screen
    //     position — of course it never changes). The actor that actually
    //     determines WHICH part of "everything behind this window" gets
    //     sampled is `state.bgClone`/`state.windowsContainer` (see
    //     _syncState(): `state.bgClone.set_position(-absX, -absY)`) — THAT
    //     position, in monitor/world space, next to the window's own
    //     frameRect for the same tick, is what would actually reveal a
    //     one-step-behind background. Logging it now instead.
    //
    // Arm via _debugBgLagLogFrames. Logs only the window currently under a
    // grab, to stay readable during a real drag test.
    _debugBgLagLogFrames = 0;
    _lastTickMonoUs = 0;
    _frameTick() {
        const nowUs = GLib.get_monotonic_time();
        const deltaMs = this._lastTickMonoUs ? (nowUs - this._lastTickMonoUs) / 1000 : -1;
        this._lastTickMonoUs = nowUs;
        for (let state of this._states.values()) {
            try {
                this._syncState(state);
                if (this._debugBgLagLogFrames > 0) {
                    const metaWin = state.windowActor?.get_meta_window?.();
                    // GNOME 50 / Meta 18: get_grab_op()/get_grab_window() no longer
                    // exist — use is_grabbed() + focus-window as a proxy instead.
                    const isGrabbed = global.display.is_grabbed();
                    const isFocused = metaWin && global.display.get_focus_window() === metaWin;
                    if (isGrabbed && isFocused) {
                        const rect = metaWin.get_frame_rect();
                        // [FIX] windowsContainer/bgClone position IS the thing that
                        // decides which pixels of "what's behind this window" get
                        // sampled for the glass — logging it (in the same monitor/
                        // world space as frameRect, via -bgClone.x/-bgClone.y since
                        // it's stored negated) next to the window's own live rect on
                        // the SAME tick tells us whether they ever disagree, i.e.
                        // whether the sampled background is genuinely stale, or the
                        // lag is purely a compositor/GPU presentation artifact
                        // downstream of both being perfectly in sync on the JS side.
                        this._logger.log(`[Liquid Glass][bg-lag] t=${nowUs} dtSinceLastTick=${deltaMs.toFixed(1)}ms ` +
                            `grabbed=true win="${metaWin.get_title()}" frameRect=(${rect.x},${rect.y},${rect.width}x${rect.height}) ` +
                            `bgCloneSampleOrigin=(${(-state.bgClone.x).toFixed(1)},${(-state.bgClone.y).toFixed(1)}) ` +
                            `windowsContainerOrigin=(${(-state.windowsContainer.x).toFixed(1)},${(-state.windowsContainer.y).toFixed(1)})`);
                    }
                }
            }
            catch (e) {
                this._logger.error(`[Liquid Glass] Error in _syncState: ${e}`);
            }
        }
        if (this._debugFocusLogFrames > 0)
            this._debugFocusLogFrames--;
        if (this._debugBgLagLogFrames > 0)
            this._debugBgLagLogFrames--;
        this._frameSyncId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._frameTick();
            return false;
        });
    }
    // ── Diagnostics: focus-change "shifted texture" investigation ──────────────
    // Logs, for `state`'s own window, the raw Clutter actor position next to
    // Meta's frame_rect/buffer_rect — this is the "two sources of truth"
    // pairing _syncState() otherwise assumes always agree (see the
    // container-offset math using get_buffer_rect()/get_frame_rect() vs. each
    // behind-window clone's position using the source actor's raw .x/.y).
    // Also logs, for every "window behind" clone this state currently draws,
    // its source actor's raw .x/.y vs. get_transformed_position() (to check
    // whether that assumption itself ever diverges) and the position that
    // will actually be applied to the clone this frame.
    _logFocusDebugInfo(state) {
        const actor = state.windowActor;
        const metaWin = actor.get_meta_window();
        if (!metaWin)
            return;
        const title = metaWin.get_title() || '(untitled)';
        const [actorX, actorY] = [actor.x, actor.y];
        const [tX, tY] = actor.get_transformed_position();
        const frameRect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();
        this._logger.log(`[Liquid Glass][focus-debug] window="${title}" ` +
            `windowActor.(x,y)=(${actorX},${actorY}) ` +
            `transformedPos=(${Math.round(tX)},${Math.round(tY)}) ` +
            `frameRect=(${frameRect.x},${frameRect.y},${frameRect.width}x${frameRect.height}) ` +
            `bufferRect=(${bufferRect.x},${bufferRect.y},${bufferRect.width}x${bufferRect.height}) ` +
            `actorX-bufferRect.x=${actorX - bufferRect.x} actorY-bufferRect.y=${actorY - bufferRect.y}`);
        for (let [src, clone] of state.clones.entries()) {
            if (!isActorValid(src) || !isActorValid(clone))
                continue;
            const srcMetaWindow = typeof src.get_meta_window === 'function'
                ? src.get_meta_window() : null;
            const srcTitle = srcMetaWindow ? (srcMetaWindow.get_title() || '(untitled)') : '(?)';
            const [srcX, srcY] = [src.x, src.y];
            const [srcTX, srcTY] = src.get_transformed_position();
            this._logger.log(`[Liquid Glass][focus-debug]   behind-clone src="${srcTitle}" ` +
                `src.(x,y)=(${srcX},${srcY}) src.transformedPos=(${Math.round(srcTX)},${Math.round(srcTY)}) ` +
                `diff=(${Math.round(srcTX - srcX)},${Math.round(srcTY - srcY)}) ` +
                `clone.(x,y)=(${clone.x},${clone.y})`);
        }
    }
    _cleanupState(state) {
        if (!state)
            return;
        // Restore the original opacity of the window's own content layer.
        // Uses the cached surfaceActor reference (see WindowState) rather than
        // windowActor.get_first_child(), which no longer points at the real
        // surface once baseActor has been inserted below it.
        if (state.surfaceActor) {
            try {
                if (isActorValid(state.surfaceActor)) {
                    state.surfaceActor.opacity = state.originalOpacity;
                }
            }
            catch (e) {
                // Window actor may already be destroyed; safe to ignore.
            }
        }
        if (state.signals) {
            state.signals.forEach(sig => {
                try {
                    sig.obj.disconnect(sig.id);
                }
                catch (e) { }
            });
            state.signals = [];
        }
        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();
        state.baseClones.forEach(clone => clone.destroy());
        state.baseClones.clear();
        if (state.effect) {
            try {
                state.effect.cleanup();
            }
            catch (e) { }
        }
        if (state.bgActor)
            state.bgActor.destroy();
        if (state.baseActor)
            state.baseActor.destroy();
        if (state.cornerOverlay)
            state.cornerOverlay.destroy();
    }
}
