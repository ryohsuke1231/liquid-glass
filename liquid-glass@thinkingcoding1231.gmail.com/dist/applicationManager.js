// src/applicationManager.js
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableClone } from './utils.js';
const SHADER_PADDING = 20;
export class ApplicationManager {
    extensionPath;
    _states;
    _settings;
    _frameSyncId;
    _windowCreatedId;
    constructor(extensionPath, settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._states = new Map();
        this._frameSyncId = 0;
        this._windowCreatedId = 0;
    }
    setup() {
        this._buildForExistingWindows();
        this._windowCreatedId = global.display.connect('window-created', (_d, metaWindow) => {
            const obj = metaWindow.get_compositor_private();
            if (!(obj instanceof Meta.WindowActor))
                return;
            this._setupWindow(obj);
        });
        this._frameTick();
    }
    cleanup() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        if (this._frameSyncId) {
            global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
        }
        for (let state of this._states.values())
            this._cleanupState(state);
        this._states.clear();
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
        let bgActor = new St.Widget({
            reactive: false,
            clip_to_allocation: false,
            visible: false, // hidden until first valid sync
        });
        let clipBox = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
        });
        bgActor.add_child(clipBox);
        let blurEffect = new Shell.BlurEffect({
            radius: 30,
            mode: Shell.BlurMode.ACTOR,
        });
        clipBox.add_effect(blurEffect);
        // Size the clone to cover the full screen so the wallpaper fills correctly
        let monitor = Main.layoutManager.primaryMonitor;
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
        effect.setPadding(SHADER_PADDING);
        effect.setIsDock(false);
        bgActor.add_effect(effect);
        let windowsContainer = new Clutter.Actor();
        clipBox.add_child(windowsContainer);
        // Insert bgActor below the surface, inside windowActor
        windowActor.insert_child_below(bgActor, surfaceActor);
        let state = {
            windowActor,
            bgActor,
            clipBox,
            blurEffect,
            bgClone,
            windowsContainer,
            clones: new Map(),
        };
        console.log('[LiquidGlass] bgActor parent:', state.bgActor.get_parent()?.toString());
        console.log('[LiquidGlass] bgActor z index:', windowActor.get_child_at_index(0) === state.bgActor);
        console.log('[LiquidGlass] clipBox children:', state.clipBox.get_n_children());
        console.log('[LiquidGlass] bgClone source:', state.bgClone.source?.toString());
        console.log('[LiquidGlass] windowsContainer added:', state.windowsContainer.get_parent()?.toString());
        this._states.set(windowActor, state);
        this._rebuildWindowClones(state);
        windowActor.connect('destroy', () => {
            this._cleanupState(state);
            this._states.delete(windowActor);
        });
    }
    _rebuildWindowClones(state) {
        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();
        state.windowsContainer.remove_all_children();
        for (let actor of global.get_window_actors()) {
            if (actor === state.windowActor)
                continue;
            let clone = new UnpickableClone({ source: actor });
            state.windowsContainer.add_child(clone);
            state.clones.set(actor, clone);
        }
    }
    _syncState(state) {
        let actor = state.windowActor;
        if (!actor || !actor.get_stage())
            return;
        const rect = actor.get_meta_window()?.get_frame_rect();
        if (!rect) {
            console.log('[LiquidGlass] no rect for', actor.get_meta_window()?.get_title());
            return;
        }
        const { x, y, width: w, height: h } = rect;
        if (w <= 0 || h <= 0) {
            console.log('[LiquidGlass] zero size, hiding');
            state.bgActor.visible = false;
            return;
        }
        state.bgActor.set_position(0, 0);
        state.bgActor.set_size(w, h);
        state.clipBox.set_position(0, 0);
        state.clipBox.set_size(w, h);
        // Offset so the clipped region lines up with screen coords
        state.bgClone.set_position(-x, -y);
        state.windowsContainer.set_position(-x, -y);
        for (let [src, clone] of state.clones.entries()) {
            if (!src || !src.visible) {
                clone.hide();
                continue;
            }
            clone.show();
            clone.set_position(src.x, src.y);
            clone.set_size(src.width, src.height);
        }
        console.log('[LiquidGlass] bgActor size:', state.bgActor.get_width(), state.bgActor.get_height());
        console.log('[LiquidGlass] bgActor pos:', state.bgActor.get_x(), state.bgActor.get_y());
        console.log('[LiquidGlass] clipBox size:', state.clipBox.get_width(), state.clipBox.get_height());
        console.log('[LiquidGlass] bgClone pos:', state.bgClone.get_x(), state.bgClone.get_y());
        console.log('[LiquidGlass] bgClone size:', state.bgClone.get_width(), state.bgClone.get_height());
        console.log('[LiquidGlass] surfaceActor:', actor.get_first_child()?.toString());
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
        if (state.bgActor)
            state.bgActor.destroy();
    }
}
