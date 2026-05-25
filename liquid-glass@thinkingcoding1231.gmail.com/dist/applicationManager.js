// src/applicationManager.js
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import { UnpickableClone } from './utils.js';
const SHADER_PADDING = 20;
export class WindowGlassManager {
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
            let actor = metaWindow.get_compositor_private();
            if (actor)
                this._setupWindow(actor);
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
        let parent = windowActor.get_parent();
        if (!parent)
            return;
        // Background glass actor
        let bgActor = new St.Widget({
            reactive: false,
            clip_to_allocation: false,
        });
        let clipBox = new St.Widget({
            clip_to_allocation: true,
            reactive: false,
        });
        bgActor.add_child(clipBox);
        // Blur
        let blurEffect = new Shell.BlurEffect({
            radius: 30,
            mode: Shell.BlurMode.ACTOR,
        });
        clipBox.add_effect(blurEffect);
        // Wallpaper clone
        let bgClone = new UnpickableClone({
            source: Main.layoutManager._backgroundGroup,
        });
        clipBox.add_child(bgClone);
        let effect = new LiquidEffect({ extensionPath: this.extensionPath, settints: this._settings });
        effect.setPadding(SHADER_PADDING);
        effect.setIsDock(false);
        bgActor.add_effect(effect);
        // Window clones (other windows)
        let windowsContainer = new Clutter.Actor();
        clipBox.add_child(windowsContainer);
        parent.insert_child_below(bgActor, windowActor);
        let state = {
            windowActor,
            bgActor,
            clipBox,
            blurEffect,
            bgClone,
            windowsContainer,
            clones: new Map(),
        };
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
        if (!actor)
            return;
        let [x, y] = actor.get_transformed_position();
        let [w, h] = actor.get_size();
        if (w <= 0 || h <= 0)
            return;
        state.bgActor.set_position(x, y);
        state.bgActor.set_size(w, h);
        state.clipBox.set_position(0, 0);
        state.clipBox.set_size(w, h);
        // Shift clones so the clipped region lines up with screen coords
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
        state.bgActor.visible = actor.visible;
        state.bgActor.opacity = actor.opacity;
    }
    _frameTick() {
        for (let state of this._states.values())
            this._syncState(state);
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
