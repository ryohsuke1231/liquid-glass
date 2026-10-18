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
import { clipDockBounds, dockEdges, balanceDockBounds, insetDockBounds, visibleDockSize } from './actors/dockGeometry.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;

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
        connectSetting('dock-margin-bottom', () => {
            if (this._isEffectActive)
                this._applyMargin();
            this._marginValue = this._settings.get_int('dock-margin-bottom') || 0;
        });
        connectSetting('dock-tint-color', () => {
            if (this.glass && this._isEffectActive) {
                let colorArray = hexToColorArray(this._settings.get_string('dock-tint-color'));
                this.glass.setTintColor(...colorArray);
            }
        });
        connectSetting('dock-tint-strength', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setTintStrength(this._settings.get_double('dock-tint-strength'));
            }
        });
        connectSetting('dock-blur-radius', () => {
            const radius = this._settings.get_int('dock-blur-radius');
            if (this.glass && this._isEffectActive)
                this.glass.setBlurRadius(radius);
        });
        connectSetting('dock-corner-radius', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setCornerRadius(this._settings.get_double('dock-corner-radius'));
            }
        });
        connectSetting('dock-brightness', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setBrightness(this._settings.get_double('dock-brightness'));
            }
        });
        connectSetting('dock-contrast', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setContrast(this._settings.get_double('dock-contrast'));
            }
        });
        connectSetting('dock-saturation', () => {
            if (this.glass && this._isEffectActive) {
                this.glass.setSaturation(this._settings.get_double('dock-saturation'));
            }
        });
    }

    // Moves the dock away from the screen edge it is closest to by
    // dock-margin-bottom.
    _applyMargin() {
        if (!this.targetActor)
            return;
        let marginBottom = this._settings.get_int('dock-margin-bottom');
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
        const glass = new BackdropGlass({
            extensionPath: this.extensionPath, settings: this._settings, logger: this._logger, owner: 'dock',
        });
        this.glass = glass;
        glass.set_size(1.0, 1.0);
        this._applyMargin();
        this._marginValue = this._settings.get_int('dock-margin-bottom');
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
        let blurRadius = this._settings.get_int('dock-blur-radius');
        let tintColorStr = this._settings.get_string('dock-tint-color');
        let tintStrength = this._settings.get_double('dock-tint-strength');
        let cornerRadius = this._settings.get_double('dock-corner-radius');
        let brightness = this._settings.get_double('dock-brightness');
        let contrast = this._settings.get_double('dock-contrast');
        let saturation = this._settings.get_double('dock-saturation');
        glass.setPadding(SHADER_PADDING);
        glass.setTintColor(...hexToColorArray(tintColorStr));
        glass.setTintStrength(tintStrength);
        glass.setCornerRadius(cornerRadius);
        glass.setBrightness(brightness);
        glass.setContrast(contrast);
        glass.setSaturation(saturation);
        glass.setBlurRadius(blurRadius);
        glass.setIsDock(true);
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
        this.glass.setGlassGeometry(ref.rect[0] + (nx - ref.rawX), ref.rect[1] + (ny - ref.rawY), ref.rect[2], ref.rect[3]);
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
        this._syncDockGlass(bounds, monitor);
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
        // No margin correction while the dock moves.
        let isMoving = false;
        if (this._lastAbsX !== undefined && this._lastAbsY !== undefined) {
            let diffX = Math.abs(absX - this._lastAbsX);
            let diffY = Math.abs(absY - this._lastAbsY);
            if (diffX > 1.0 || diffY > 1.0) {
                isMoving = true;
            }
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

    _syncDockGlass(bounds, monitor) {
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
        // Limit drawing to the dock plus room for its shadow (not
        // clip_to_allocation, which would cut the shadow off).
        const CLIP_PADDING = 200;
        setClipIfChanged(this.glass, localBgX - CLIP_PADDING, localBgY - CLIP_PADDING, bgW + CLIP_PADDING * 2, bgH + CLIP_PADDING * 2);
        const SHADOW_MAX_RADIUS = CLIP_PADDING - 20;
        this.glass?.setShadowMaxRadius(SHADOW_MAX_RADIUS);
        this.glass?.setResolution(screenW, screenH);
        this.glass?.setGlassGeometry(localBgX, localBgY, bgW, bgH);
        const source = this._liveSource;
        this._liveRef = source ? {
            actor: source.actor,
            rawX: source.rawX, rawY: source.rawY,
            rect: [localBgX, localBgY, bgW, bgH],
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
