import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { reportFrameLoopError } from './diagnostics/logging.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isFrameSyncFrozen, SAME_FRAME_WINDOW_US } from './animation/frameSync.js';
import { startStageLoop, stopStageLoop } from './animation/frameLoops.js';
import { setClipIfChanged } from './actors/writes.js';
import { isActorValid } from './actors/lifecycle.js';
import { hexToColorArray } from './animation/colors.js';
import { clipDockBounds, dockEdges, dockSide, balanceDockBounds, insetDockBounds, visibleDockSize, attachRectToEdge } from './actors/dockGeometry.js';
// Room around the glass rect for the shader's edge effects.
export const SHADER_PADDING = 20;
// The dock glass's look, from the dock-* settings, for every kind of dock.
const DOCK_MATERIAL = [
    ['dock-tint-color', (g, s) => g.setTintColor(...hexToColorArray(s.get_string('dock-tint-color')))],
    ['dock-tint-strength', (g, s) => g.setTintStrength(s.get_double('dock-tint-strength'))],
    ['dock-blur-radius', (g, s) => g.setBlurRadius(s.get_int('dock-blur-radius'))],
    ['dock-corner-radius', (g, s) => g.setCornerRadius(s.get_double('dock-corner-radius'))],
    ['dock-brightness', (g, s) => g.setBrightness(s.get_double('dock-brightness'))],
    ['dock-contrast', (g, s) => g.setContrast(s.get_double('dock-contrast'))],
    ['dock-saturation', (g, s) => g.setSaturation(s.get_double('dock-saturation'))],
];

export function createDockGlass(extensionPath, settings, logger, owner) {
    const glass = new BackdropGlass({ extensionPath, settings, logger, owner, outline: 'dock' });
    glass.setPadding(SHADER_PADDING);
    for (const [, apply] of DOCK_MATERIAL)
        apply(glass, settings);
    glass.setIsDock(true);
    return glass;
}

/** Keeps the glass `glass()` returns, if any, in the dock's look. Returns the ids of the signals on `settings`. */
export function followDockMaterial(settings, glass) {
    const ids = DOCK_MATERIAL.map(([key, apply]) => settings.connect(`changed::${key}`, () => {
        const current = glass();
        if (current)
            apply(current, settings);
    }));
    // The attachment is applied with the geometry on the next frame, which a redraw brings.
    for (const key of ['dock-attach-to-edge', 'dock-edge-radius'])
        ids.push(settings.connect(`changed::${key}`, () => glass()?.queue_redraw()));
    return ids;
}

/**
 * Grows `glass` out of `side` when the dock is attached. Returns `rect` (monitor-local, padded by SHADER_PADDING)
 * reaching that edge and the side, or `rect` unchanged and null while the dock floats.
 */
export function attachDockGlass(glass, settings, rect, side, monitorW, monitorH) {
    const attached = settings.get_boolean('dock-attach-to-edge');
    glass.setAttachedEdge(attached ? side : 'none', settings.get_double('dock-edge-radius'));
    return attached
        ? { rect: attachRectToEdge(rect, side, monitorW, monitorH, SHADER_PADDING), side }
        : { rect, side: null };
}

export class DashManager {
    extensionPath;
    targetActor;
    _settings;
    // Monitor-sized; see _syncDockGlass().
    glass = null;
    _lastScreenW;
    _lastScreenH;
    _glassExpand;
    _signals;
    _settingsSignals;
    _frameSyncId;
    _frameSignalId = 0;
    _lastTickUs = 0;
    _isEffectActive;
    _originalStyle;
    _currentMarginStyle;
    _dockParent = null;
    _lastAbsX;
    _lastAbsY;
    _lastTW;
    _lastTH;
    _stableDeltaW;
    _stableDeltaH;
    _lastBgW;
    _lastBgH;
    _lastBgX;
    _lastBgY;
    _lastBaseW;
    _lastBaseH;
    // dock-margin-bottom, or 0 while the glass grows out of the screen edge.
    _marginValue = 0;
    // Tracks the hide/show transition so the reason is logged once, not per frame.
    _lastHidden;
    // What the last _syncGeometry() based the glass rect on; see
    // _syncGlassGeometryLive().
    _liveRef = null;
    _logger;

    constructor(extensionPath, targetActor, settings, logger) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this._settings = settings;
        this._logger = logger;
        // Pixels added around the dock's own rect.
        this._glassExpand = 0;
        this._signals = [];
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._isEffectActive = false;
    }

    setup() {
        if (!this.targetActor || !this._settings)
            return;
        this._bindSettings();
        if (this._settings.get_boolean('enable-dock-glass')) {
            this._applyEffect();
        }
    }

    _bindSettings() {
        const connectSetting = (key, callback) => {
            let id = this._settings.connect(`changed::${key}`, callback.bind(this));
            this._settingsSignals.push(id);
        };
        connectSetting('enable-dock-glass', () => {
            let enabled = this._settings.get_boolean('enable-dock-glass');
            if (enabled && !this._isEffectActive) {
                this._applyEffect();
            }
            else if (!enabled && this._isEffectActive) {
                this._removeEffect();
            }
        });
        connectSetting('dock-glass-expand', () => {
            if (this.glass && this._isEffectActive) {
                this._glassExpand = this._settings.get_int('dock-glass-expand');
                this.glass?.queue_redraw();
            }
        });
        const remargin = () => {
            if (this._isEffectActive)
                this._applyMargin();
            this._marginValue = this._effectiveMargin();
        };
        connectSetting('dock-margin-bottom', remargin);
        connectSetting('dock-attach-to-edge', remargin);
        this._settingsSignals.push(...followDockMaterial(this._settings, () => this.glass));
    }

    _effectiveMargin() {
        return this._settings.get_boolean('dock-attach-to-edge') ? 0 : this._settings.get_int('dock-margin-bottom') || 0;
    }

    // Moves the dock away from the screen edge it is closest to by
    // dock-margin-bottom.
    _applyMargin() {
        if (!this.targetActor)
            return;
        let marginBottom = this._effectiveMargin();
        let [w, h] = this.targetActor.get_size();
        let [x, y] = this.targetActor.get_transformed_position();
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        let distLeft = x - monitor.x;
        let distRight = (monitor.x + monitor.width) - (x + w);
        let distTop = y - monitor.y;
        let distBottom = (monitor.y + monitor.height) - (y + h);
        let minEdge = Math.min(distLeft, distRight, distTop, distBottom);
        let marginStyle = '';
        if (minEdge === distBottom || minEdge === distTop) {
            if (minEdge === distBottom)
                marginStyle = `margin-bottom: ${marginBottom}px;`;
            else
                marginStyle = `margin-top: ${marginBottom}px;`;
        }
        else {
            if (minEdge === distRight)
                marginStyle = `margin-right: ${marginBottom}px;`;
            else
                marginStyle = `margin-left: ${marginBottom}px;`;
        }
        if (this._originalStyle === undefined) {
            this._originalStyle = this.targetActor.get_style() || '';
        }
        this._currentMarginStyle = marginStyle;
        this.targetActor.set_style(`${this._originalStyle} ${marginStyle}`);
    }

    _applyEffect() {
        if (this._isEffectActive)
            return;
        this._isEffectActive = true;
        this._lastScreenW = this._lastScreenH = undefined;
        this._lastBgW = this._lastBgH = undefined;
        this._lastBgX = this._lastBgY = undefined;
        this._lastBaseW = this._lastBaseH = undefined;
        this._lastAbsX = this._lastAbsY = undefined;
        this._lastTW = this._lastTH = undefined;
        this._stableDeltaW = this._stableDeltaH = undefined;
        this._lastHidden = undefined;
        this.targetActor.add_style_class_name('liquid-glass-transparent');
        this._dockParent = this.targetActor.get_parent();
        if (this._dockParent) {
            this._dockParent.add_style_class_name('liquid-glass-transparent');
        }
        const glass = createDockGlass(this.extensionPath, this._settings, this._logger, 'dock');
        this.glass = glass;
        glass.set_size(1.0, 1.0);
        this._applyMargin();
        this._marginValue = this._effectiveMargin();
        this._glassExpand = this._settings.get_int("dock-glass-expand");
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
            if (!p)
                break;
            dockRoot = p;
        }
        // Below the dock, so the glass reads the stage before the dock is drawn.
        if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(glass, dockRoot);
        }
        else {
            Main.layoutManager.uiGroup.add_child(glass);
        }
        // Dash to Dock slides by relayout, so the frame tick sees last frame's
        // position; the paint-time hook corrects it.
        glass.setLiveGeometryHook(() => this._syncGlassGeometryLive());
        glass.show();
        // Follows the stage's own frames (startStageLoop()), so it costs nothing
        // while nothing changes. Errors are reported rate-limited instead of
        // logged every frame; SAME_FRAME_WINDOW_US keeps two stage views from
        // stepping it twice in one frame.
        let frameTick = () => {
            if (!this._isEffectActive || !this.glass || !this.targetActor.mapped)
                return;
            if (isFrameSyncFrozen())
                return;
            const nowUs = GLib.get_monotonic_time();
            if (nowUs - this._lastTickUs < SAME_FRAME_WINDOW_US)
                return;
            this._lastTickUs = nowUs;
            try {
                // Checked before this frame's sync dirties anything.
                ensureGlassAllocated(this.glass);
                this._syncGeometry();
            }
            catch (e) {
                reportFrameLoopError('DockManager', e);
            }
        };
        let startFrameSync = () => {
            if (this._frameSignalId !== 0)
                return;
            startStageLoop(this._frameSignalSlot, this._frameSlot, frameTick);
        };
        // The glass is the dock's sibling, so it stays up when the dock is
        // hidden as a whole (for instance over a fullscreen window).
        let mapSignalId = this.targetActor.connect('notify::mapped', () => {
            if (this.targetActor.mapped) {
                startFrameSync();
            }
            else {
                this._stopFrameSync();
                this._hideGlass();
            }
        });
        this._signals.push(mapSignalId);
        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }

    // Runs at paint time (see GlassActor.setLiveGeometryHook()), when the
    // dock's allocation is current. _syncGeometry() keeps per-frame state and
    // must run once per frame, so only the glass rect's position is corrected
    // here, by how far the dock moved since the tick.
    _syncGlassGeometryLive() {
        const ref = this._liveRef;
        if (!ref || !this.glass)
            return;
        if (!ref.actor?.mapped)
            return;
        const [nx, ny] = ref.actor.get_transformed_position();
        if (!Number.isFinite(nx) || !Number.isFinite(ny))
            return;
        let rect = [ref.rect[0] + (nx - ref.rawX), ref.rect[1] + (ny - ref.rawY), ref.rect[2], ref.rect[3]];
        // The dock's move must not lift the attached side off the edge.
        if (ref.side)
            rect = attachRectToEdge(rect, ref.side, ref.monitorW, ref.monitorH, SHADER_PADDING);
        this.glass.setGlassGeometry(rect[0], rect[1], rect[2], rect[3]);
    }

    _syncGeometry() {
        if (!this.glass || !this.targetActor || !this.targetActor.mapped)
            return;
        let bounds = this._readDockBounds();
        if (!bounds)
            return;
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        const edges = dockEdges(bounds, monitor);
        bounds = this._stabilizeDockBounds(bounds, edges);
        const refActor = this._findReferenceActor(this.targetActor);
        if (refActor)
            bounds = balanceDockBounds(bounds, this._actorBounds(refActor), edges);
        bounds = this._applyDockMargin(bounds, monitor, edges);
        const { baseW, baseH } = bounds;
        if (baseW <= 9 || baseH <= 9) {
            this._hideGlass();
            return;
        }
        this.glass.show();
        this.glass.opacity = this.targetActor.opacity;
        this._syncDockVisibility(bounds, monitor);
        this._syncDockGlass(bounds, monitor, dockSide(edges));
    }

    _actorBounds(actor) {
        const [baseW, baseH] = actor.get_size();
        const [absX, absY] = actor.get_transformed_position();
        return { absX, absY, baseW, baseH };
    }

    _liveSource = null;

    _readDockBounds() {
        let sourceActor = this.targetActor;
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 0;
                sourceActor = children[i];
            }
        }
        let [baseW, baseH] = sourceActor.get_size();
        let [absX, absY] = sourceActor.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY))
            return null;
        // The uncorrected position, which _syncGlassGeometryLive() compares against.
        this._liveSource = { actor: sourceActor, rawX: absX, rawY: absY };
        const bounds = { absX, absY, baseW, baseH };
        return sourceActor === this.targetActor ? bounds : clipDockBounds(bounds, this._actorBounds(this.targetActor));
    }

    _stabilizeDockBounds(bounds, edges) {
        let { baseW, baseH } = bounds;
        const { minCenterDist, distTopCenter, distBottomCenter } = edges;
        if (this._lastBaseW !== undefined && this._lastBaseH !== undefined) {
            let isHorizontalDock = (minCenterDist === distTopCenter || minCenterDist === distBottomCenter);
            // The dock's thickness can jump by exactly the margin for a frame;
            // such a jump is ignored.
            if (isHorizontalDock) {
                if (Math.abs(Math.abs(baseH - this._lastBaseH) - this._marginValue) <= 1)
                    baseH = this._lastBaseH;
            }
            else {
                if (Math.abs(Math.abs(baseW - this._lastBaseW) - this._marginValue) <= 1)
                    baseW = this._lastBaseW;
            }
        }
        this._lastBaseW = baseW;
        this._lastBaseH = baseH;
        return { ...bounds, baseW, baseH };
    }

    _applyDockMargin(bounds, monitor, edges) {
        const marginValue = this._marginValue || 0;
        if (!monitor || !(marginValue > 0))
            return bounds;
        const { absX, absY, baseW, baseH } = bounds;
        // No margin correction while the dock slides in or out from its screen edge. A move along the edge
        // is a centered dock growing or shrinking as icons come and go, which still needs it.
        let isMoving = false;
        if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
            const horizontal = edges.minCenterDist === edges.distTopCenter || edges.minCenterDist === edges.distBottomCenter;
            isMoving = horizontal ? Math.abs(absY - this._lastAbsY) > 1.0 : Math.abs(absX - this._lastAbsX) > 1.0;
        }
        this._lastAbsX = absX;
        this._lastAbsY = absY;
        let [tW, tH] = this.targetActor.get_size();
        if (this._stableDeltaW === undefined || this._lastTW !== tW) {
            this._stableDeltaW = baseW - tW;
            this._lastTW = tW;
        }
        if (this._stableDeltaH === undefined || this._lastTH !== tH) {
            this._stableDeltaH = baseH - tH;
            this._lastTH = tH;
        }
        let stableBaseW = tW + this._stableDeltaW;
        let stableBaseH = tH + this._stableDeltaH;
        return isMoving ? bounds : insetDockBounds(bounds, monitor, edges, marginValue, stableBaseW, stableBaseH);
    }

    _syncDockVisibility(bounds, monitor) {
        const { absX, absY, baseW, baseH } = bounds;
        const [visibleW, visibleH] = visibleDockSize(bounds, monitor);
        // Only a degenerate box hides the glass: a dock flush against the screen
        // edge is only a few pixels wide on screen. Logged on transition.
        if (visibleW <= 1 || visibleH <= 1) {
            if (this._lastHidden !== true) {
                this._lastHidden = true;
                this._logger.log(`[Liquid Glass][dock] hiding the glass: visible=(${visibleW.toFixed(1)}x${visibleH.toFixed(1)}) ` +
                    `base=(${baseW.toFixed(1)}x${baseH.toFixed(1)}) abs=(${absX.toFixed(1)},${absY.toFixed(1)}) ` +
                    `monitor=(${monitor?.x},${monitor?.y},${monitor?.width}x${monitor?.height}) ` +
                    `margin=${this._marginValue}`);
            }
            this.glass.opacity = 0;
        }
        else {
            if (this._lastHidden === true) {
                this._lastHidden = false;
                this._logger.log('[Liquid Glass][dock] glass visible again');
            }
            this.glass.opacity = this.targetActor.opacity;
        }
    }

    _syncDockGlass(bounds, monitor, side) {
        const { absX, absY, baseW, baseH } = bounds;
        const w = Math.max(1.0, baseW), h = Math.max(1.0, baseH);
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2) + (this._glassExpand * 2));
        let bgX = absX - SHADER_PADDING - this._glassExpand;
        let bgY = absY - SHADER_PADDING - this._glassExpand;
        // The glass covers the whole monitor; the shader draws only the glass
        // rect, in monitor-local coordinates.
        let screenW = monitor.width;
        let screenH = monitor.height;
        // Monitor-local, as the shader uses them.
        let localBgX = bgX - monitor.x;
        let localBgY = bgY - monitor.y;
        if (this._lastBgW !== bgW || this._lastBgH !== bgH ||
            this._lastBgX !== bgX || this._lastBgY !== bgY ||
            this._lastScreenW !== screenW || this._lastScreenH !== screenH ||
            this.glass.x !== monitor.x || this.glass.y !== monitor.y) {
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            this.glass.set_position(monitor.x, monitor.y);
            this.glass.set_size(screenW, screenH);
            this.glass.remove_transition('size');
            this.glass.remove_transition('position');
            this._lastBgW = bgW;
            this._lastBgH = bgH;
            this._lastBgX = bgX;
            this._lastBgY = bgY;
            this._lastScreenW = screenW;
            this._lastScreenH = screenH;
        }
        const attachment = attachDockGlass(this.glass, this._settings, [localBgX, localBgY, bgW, bgH], side, screenW, screenH);
        const [rectX, rectY, rectW, rectH] = attachment.rect;
        // Limit drawing to the dock plus room for its shadow (not
        // clip_to_allocation, which would cut the shadow off).
        const CLIP_PADDING = 200;
        setClipIfChanged(this.glass, rectX - CLIP_PADDING, rectY - CLIP_PADDING, rectW + CLIP_PADDING * 2, rectH + CLIP_PADDING * 2);
        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.glass?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
        this.glass?.setResolution(screenW, screenH);
        this.glass?.setGlassGeometry(rectX, rectY, rectW, rectH);
        const source = this._liveSource;
        this._liveRef = source ? {
            actor: source.actor,
            rawX: source.rawX, rawY: source.rawY,
            rect: [rectX, rectY, rectW, rectH],
            side: attachment.side, monitorW: screenW, monitorH: screenH,
        } : null;
        // After the geometry setters, so the relays cover this frame's rect.
        this.glass.syncSources();
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }

    // The next sync shows it again and updates everything.
    _hideGlass() {
        this.glass?.hide();
        this._lastBgW = undefined;
        this._lastBgH = undefined;
        this._lastBgX = undefined;
        this._lastBgY = undefined;
    }

    _stopFrameSync() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
    }

    _removeEffect() {
        if (!this._isEffectActive)
            return;
        this._isEffectActive = false;
        this._currentMarginStyle = undefined;
        this._stopFrameSync();
        // The dock may already have been destroyed by Dash to Dock.
        const dockAlive = isActorValid(this.targetActor);
        for (const id of this._signals) {
            if (dockAlive)
                this.targetActor.disconnect(id);
        }
        this._signals = [];
        if (dockAlive) {
            this.targetActor.remove_style_class_name('liquid-glass-transparent');
            if (this._originalStyle !== undefined)
                this.targetActor.set_style(this._originalStyle);
            for (const child of this.targetActor.get_children()) {
                if (child.has_style_class_name('dash-background'))
                    child.opacity = 255;
            }
        }
        this._originalStyle = undefined;
        if (isActorValid(this._dockParent))
            this._dockParent.remove_style_class_name('liquid-glass-transparent');
        this._dockParent = null;
        const glass = this.glass;
        this.glass = null;
        if (glass) {
            glass.cleanup();
            if (isActorValid(glass))
                glass.destroy();
        }
    }

    cleanup() {
        this._liveRef = null;
        this._stopFrameSync();
        this._removeEffect();
        for (let id of this._settingsSignals)
            this._settings.disconnect(id);
        this._settingsSignals = [];
    }

    // The first running-app indicator inside the dock (Dash to Dock's
    // IndicatorDrawingArea), used to balance the gaps around the icons.
    _findReferenceActor(actor) {
        if (!actor)
            return null;
        if (actor.toString().includes('IndicatorDrawingArea'))
            return actor;
        for (const child of actor.get_children()) {
            const found = this._findReferenceActor(child);
            if (found)
                return found;
        }
        return null;
    }
}
