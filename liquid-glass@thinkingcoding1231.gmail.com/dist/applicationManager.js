// src/applicationManager.js
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import GLib from 'gi://GLib';
import { UnpickableClone, RoundingEffect } from './utils.js';
const SHADER_PADDING = 20;
export class ApplicationManager {
    extensionPath;
    _states;
    _settings;
    _frameSyncId;
    _windowCreatedId;
    _restackedId = 0;
    _rebuildQueued = false;
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._states = new Map();
        this._frameSyncId = 0;
        this._windowCreatedId = 0;
        this._restackedId = 0;
    }
    setup() {
        this._buildForExistingWindows();
        this._windowCreatedId = global.display.connect('window-created', (_d, metaWindow) => {
            const obj = metaWindow.get_compositor_private();
            if (!(obj instanceof Meta.WindowActor))
                return;
            this._setupWindow(obj);
            this._rebuildAllClones();
        });
        this._restackedId = global.display.connect('restacked', () => {
            this._rebuildAllClones();
        });
        this._frameTick();
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
        if (this._frameSyncId) {
            global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        for (let state of this._states.values())
            this._cleanupState(state);
        this._states.clear();
        this._rebuildQueued = false;
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
            return GLib.SOURCE_REMOVE;
        });
    }
    _buildForExistingWindows() {
        for (let actor of global.get_window_actors())
            this._setupWindow(actor);
    }
    _setupWindow(windowActor) {
        if (!windowActor || this._states.has(windowActor))
            return;
        let surfaceActor = windowActor.get_first_child();
        if (!surfaceActor) {
            console.log('[LiquidGlass] surface actor doesn\'t exist');
            return;
        }
        let parent = windowActor.get_parent();
        if (!parent)
            return;
        // Defer until actor has valid dimensions
        if (windowActor.width <= 0 || windowActor.height <= 0) {
            let id = windowActor.connect('notify::allocation', () => {
                if (windowActor.width > 0 && windowActor.height > 0) {
                    windowActor.disconnect(id);
                    this._setupWindow(windowActor);
                }
            });
            return;
        }
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
        let clipBox = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
        });
        bgActor.add_child(clipBox);
        let blurRadius = this._settings.get_int('menu-blur-radius');
        let blurEffect = new Shell.BlurEffect({
            radius: blurRadius,
            mode: Shell.BlurMode.ACTOR,
        });
        clipBox.add_effect(blurEffect);
        // Size the clone to cover the full screen so the wallpaper fills correctly
        let monitor = Main.layoutManager.primaryMonitor;
        // --- Added: Unblurred base background for corners ---
        let baseClone = new UnpickableClone({
            source: Main.layoutManager._backgroundGroup,
        });
        if (monitor) {
            baseClone.set_size(monitor.width, monitor.height);
        }
        baseActor.add_child(baseClone);
        let baseWindowsContainer = new Clutter.Actor();
        baseActor.add_child(baseWindowsContainer);
        // ---------------------------------------------------
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
        });
        let tintColorStr = this._settings.get_string('menu-tint-color');
        let tintStrength = this._settings.get_double('menu-tint-strength');
        // Rounded corners for the glass effect as requested
        let cornerRadius = 30;
        effect.setPadding(SHADER_PADDING);
        effect.setTintColor(...this._hexToColorArray(tintColorStr));
        effect.setTintStrength(tintStrength);
        effect.setCornerRadius(cornerRadius);
        effect.setIsDock(false);
        bgActor.add_effect(effect);
        let windowsContainer = new Clutter.Actor();
        clipBox.add_child(windowsContainer);
        // --- Added: Rounding effect for the window surface itself ---
        let roundingEffect = new RoundingEffect();
        roundingEffect.setRadius(cornerRadius);
        surfaceActor.add_effect(roundingEffect);
        // -------------------------------------------------------------
        let state = {
            windowActor,
            bgActor,
            clipBox,
            blurEffect,
            bgClone,
            windowsContainer,
            clones: new Map(),
            effect,
            baseActor,
            baseClone,
            baseWindowsContainer,
            baseClones: new Map(),
            roundingEffect,
        };
        this._states.set(windowActor, state);
        this._rebuildWindowClones(state);
        // Initial sync to prevent uninitialized black frames
        this._syncState(state);
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
        // Get windows in stacking order (bottom to top)
        for (let actor of global.get_window_actors()) {
            // STOP iterating once we reach our own window.
            // This ensures we ONLY render what is actually BEHIND the app.
            if (actor === state.windowActor)
                break;
            let clone = new UnpickableClone({ source: actor });
            state.windowsContainer.add_child(clone);
            state.clones.set(actor, clone);
            let baseClone = new UnpickableClone({ source: actor });
            state.baseWindowsContainer.add_child(baseClone);
            state.baseClones.set(actor, baseClone);
        }
    }
    _syncState(state) {
        let actor = state.windowActor;
        if (!actor || !actor.get_stage() || !actor.mapped || !actor.has_allocation()) {
            if (state.bgActor.visible)
                state.bgActor.visible = false;
            if (state.baseActor.visible)
                state.baseActor.visible = false;
            return;
        }
        const metaWin = actor.get_meta_window();
        if (!metaWin)
            return;
        // CRITICAL PERFORMANCE: Only sync windows on the current active workspace.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const winWorkspace = metaWin.get_workspace();
        if (winWorkspace && winWorkspace !== activeWorkspace) {
            if (state.bgActor.visible)
                state.bgActor.visible = false;
            if (state.baseActor.visible)
                state.baseActor.visible = false;
            return;
        }
        const rect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();
        if (!rect || !bufferRect || rect.width <= 0 || rect.height <= 0) {
            if (state.bgActor.visible)
                state.bgActor.visible = false;
            if (state.baseActor.visible)
                state.baseActor.visible = false;
            return;
        }
        if (!state.bgActor.visible)
            state.bgActor.visible = true;
        if (!state.baseActor.visible)
            state.baseActor.visible = true;
        // Local offset of the visible frame within the window actor's full buffer.
        const frameLocalX = rect.x - bufferRect.x;
        const frameLocalY = rect.y - bufferRect.y;
        // Base background (unblurred) matches the window size exactly.
        state.baseActor.set_position(frameLocalX, frameLocalY);
        state.baseActor.set_size(rect.width, rect.height);
        // Glass background (blurred) expanded by padding.
        const bgW = rect.width + (SHADER_PADDING * 2);
        const bgH = rect.height + (SHADER_PADDING * 2);
        const localX = frameLocalX - SHADER_PADDING;
        const localY = frameLocalY - SHADER_PADDING;
        state.bgActor.set_position(localX, localY);
        state.bgActor.set_size(bgW, bgH);
        state.clipBox.set_position(0, 0);
        state.clipBox.set_size(bgW, bgH);
        // Update shader resolution with the expanded bounds
        if (state.effect) {
            state.effect.setResolution(bgW, bgH);
        }
        // Offset the background content so it stays fixed to screen coordinates.
        let [absX, absY] = state.bgActor.get_transformed_position();
        // Offset for the clipped (blurred) content
        state.bgClone.set_position(-absX + SHADER_PADDING, -absY + SHADER_PADDING);
        state.windowsContainer.set_position(-absX + SHADER_PADDING, -absY + SHADER_PADDING);
        // Offset for the base (unblurred) content
        // baseActor is at rect.x, rect.y in screen space
        state.baseClone.set_position(-rect.x, -rect.y);
        state.baseWindowsContainer.set_position(-rect.x, -rect.y);
        // Sync blurred clones
        for (let [src, clone] of state.clones.entries()) {
            if (!src || !src.visible || !src.mapped) {
                if (clone.visible)
                    clone.hide();
                continue;
            }
            if (!clone.visible)
                clone.show();
            clone.set_position(src.x, src.y);
            clone.set_size(src.width, src.height);
            clone.set_scale(src.scale_x, src.scale_y);
            clone.opacity = src.opacity;
        }
        // Sync base clones (unblurred)
        for (let [src, clone] of state.baseClones.entries()) {
            if (!src || !src.visible || !src.mapped) {
                if (clone.visible)
                    clone.hide();
                continue;
            }
            if (!clone.visible)
                clone.show();
            clone.set_position(src.x, src.y);
            clone.set_size(src.width, src.height);
            clone.set_scale(src.scale_x, src.scale_y);
            clone.opacity = src.opacity;
        }
    }
    _frameTick() {
        for (let state of this._states.values()) {
            try {
                this._syncState(state);
            }
            catch (_e) { }
        }
        this._frameSyncId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._frameTick();
            return false;
        });
    }
    _cleanupState(state) {
        if (!state)
            return;
        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();
        state.baseClones.forEach(clone => clone.destroy());
        state.baseClones.clear();
        if (state.bgActor)
            state.bgActor.destroy();
        if (state.baseActor)
            state.baseActor.destroy();
        if (state.roundingEffect) {
            let child = state.windowActor.get_first_child();
            if (child)
                child.remove_effect(state.roundingEffect);
        }
    }
}
