// src/applicationManager.js
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { LiquidEffect } from './liquidEffect.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UnpickableClone, UnpickableActor, InverseCornerEffect, getWindowActors, isActorValid } from './utils.js';

const SHADER_PADDING = 10;
// Inward padding for corner rounding
const CORNER_PADDING = 3;

interface WindowState {
    windowActor: Meta.WindowActor;
    bgActor: St.Widget;
    clipBox: St.Widget;
    blurEffect: Shell.BlurEffect;
    bgClone: InstanceType<typeof UnpickableClone>;
    windowsContainer: Clutter.Actor;
    clones: Map<Meta.WindowActor, Clutter.Actor>;
    effect: LiquidEffect;
    // Unblurred base background for corners
    baseActor: St.Widget;
    baseClone: InstanceType<typeof UnpickableClone>;
    baseWindowsContainer: Clutter.Actor;
    baseClones: Map<Meta.WindowActor, Clutter.Actor>;
    // To cut window corners
    roundingEffect: InstanceType<typeof InverseCornerEffect>;
    cornerOverlay: InstanceType<typeof UnpickableActor>;
    cornerOverlayClone: InstanceType<typeof UnpickableClone>;
    signals: { obj: any, id: number }[];
    originalOpacity: number;
}

export class ApplicationManager {
    private extensionPath: string;
    private _states: Map<Meta.WindowActor, WindowState>;
    private _settings: Gio.Settings;
    private _settingsSignals: number[];
    private _frameSyncId: number;
    private _windowCreatedId: number;
    private _restackedId: number = 0;
    private _rebuildQueued: boolean = false;


    constructor(extensionPath: string, settings: Gio.Settings) {
        this.extensionPath = extensionPath;
        this._settings = settings;
        this._states = new Map();
        this._settingsSignals = [];
        this._frameSyncId = 0;
        this._windowCreatedId = 0;
        this._restackedId = 0;
    }

    setup() {
        console.log("[Liquid Glass] ApplicationManager setup starting...");
        this._bindSettings();

        this._windowCreatedId = global.display.connect('window-created', (_d, metaWindow) => {
            console.log(`[Liquid Glass] window-created event: window title = "${metaWindow.get_title()}", class = "${metaWindow.get_wm_class()}"`);
            const obj = metaWindow.get_compositor_private();
            if (!obj) {
                console.log("[Liquid Glass] get_compositor_private() returned null");
                return;
            }
            if (!(obj instanceof Meta.WindowActor)) {
                console.log("[Liquid Glass] compositor object is not instance of Meta.WindowActor");
                return;
            }
            console.log("[Liquid Glass] window compositor actor found. Connecting to first-frame.");
			obj.connect('first-frame', () => {
                console.log("[Liquid Glass] first-frame event fired for window: " + metaWindow.get_title());
            	if (this._shouldApplyToWindow(obj)) {
            	    this._setupWindow(obj);
            	    this._rebuildAllClones();
            	}
    		});
        });

        this._restackedId = global.display.connect('restacked', () => {
            this._rebuildAllClones();
        });

        console.log("[Liquid Glass] checking if effect enabled in setup: " + this._isEffectEnabled());
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
        const connectSetting = (key: string, callback: () => void) => {
            let id = this._settings.connect(`changed::${key}`, callback);
            this._settingsSignals.push(id);
        };

        connectSetting('enable-application-glass', () => {
            console.log("[Liquid Glass] enable-application-glass setting changed to: " + this._isEffectEnabled());
            if (this._isEffectEnabled())
                this._applyEffects();
            else
                this._removeAllEffects();
        });

        connectSetting('application-glass-all-windows', () => this._syncWhitelist());
        connectSetting('application-content-opacity', () => this._updateWindowOpacities());
        connectSetting('application-window-whitelist', () => this._syncWhitelist());
        connectSetting('application-tint-color', () => this._updateEffectParams());
        connectSetting('application-tint-strength', () => this._updateEffectParams());
        connectSetting('application-blur-radius', () => this._updateEffectParams());
        connectSetting('application-corner-radius', () => this._updateEffectParams());
    }

    _getContentOpacity(): number {
        return this._settings.get_double('application-content-opacity');
    }

    _updateWindowOpacities() {
        const targetOpacity = Math.round(this._getContentOpacity() * 255);
        console.log("[Liquid Glass] Updating window content opacities to: " + targetOpacity);
        for (let state of this._states.values()) {
            let surfaceActor = state.windowActor.get_first_child();
            if (surfaceActor) {
                surfaceActor.opacity = targetOpacity;
            }
        }
    }

    _isEffectEnabled(): boolean {
        const enabled = this._settings.get_boolean('enable-application-glass');
        console.log("[Liquid Glass] _isEffectEnabled called, returning: " + enabled);
        return enabled;
    }

    _getWhitelist(): string[] {
        let whitelist = this._settings.get_strv('application-window-whitelist');
		return whitelist
    }

    _windowMatchesWhitelist(metaWindow: Meta.Window): boolean {
        const whitelist = this._getWhitelist();
        const appName = metaWindow.get_wm_class();
        console.log(`[Liquid Glass] _windowMatchesWhitelist: appName = "${appName}", whitelist = [${whitelist.join(', ')}]`);
        if (whitelist.length === 0) {
            console.log("[Liquid Glass] whitelist is empty, so match is false");
            return false;
        }

		let ret = !!appName && whitelist.includes(appName)
		if (!ret) {
			console.log("[Liquid Glass] window is not in whitelist. name = " + appName)
		} else {
			console.log("[Liquid Glass] window is in whitelist. name = " + appName)
		}
		return ret
    }

    _shouldApplyToWindow(windowActor: Meta.WindowActor): boolean {
        if (!this._isEffectEnabled()) {
			console.log("[Liquid Glass] effect for windows is not enabled, skipping...")
            return false;
		}

        const metaWindow = windowActor.get_meta_window();
        if (!metaWindow) {
			console.log("[Liquid Glass] could not get metaWindow")
            return false;
		}

        // Check if "apply to all windows" is active
        // Comprobar si "aplicar a todas las ventanas" está activo
        const applyAll = this._settings.get_boolean('application-glass-all-windows');
        if (applyAll) {
            // Apply only to normal/dialog/modal windows, skip desktop backgrounds, panels, etc.
            // Aplicar solo a ventanas normales/diálogos/modales, omitir fondos de escritorio, paneles, etc.
            const windowType = metaWindow.get_window_type();
            const isNormal = windowType === Meta.WindowType.NORMAL || 
                             windowType === Meta.WindowType.DIALOG || 
                             windowType === Meta.WindowType.MODAL_DIALOG;
            if (!isNormal) {
                console.log(`[Liquid Glass] window "${metaWindow.get_title()}" has special type ${windowType}, skipping...`);
                return false;
            }
            return true;
        }

        return this._windowMatchesWhitelist(metaWindow);
    }

    _applyEffects() {
        console.log("[Liquid Glass] _applyEffects called");
        this._buildForExistingWindows();
        this._startFrameSync();
    }

    _removeAllEffects() {
        if (this._frameSyncId) {
            global.compositor.get_laters().remove(this._frameSyncId);
            this._frameSyncId = 0;
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

        for (let state of this._states.values()) {
            state.effect.setTintColor(...this._hexToColorArray(tintColorStr));
            state.effect.setTintStrength(tintStrength);
            state.effect.setCornerRadius(cornerRadius);
            state.blurEffect.radius = blurRadius;
            state.roundingEffect.setRadius(cornerRadius + CORNER_PADDING);
            state.roundingEffect.setInset(this._cornerOverlayInset());
        }
    }

    _cornerOverlayInset(): number {
        return SHADER_PADDING + CORNER_PADDING;
    }

    _startFrameSync() {
        if (this._frameSyncId === 0)
            this._frameTick();
    }

    _rebuildAllClones() {
        if (this._rebuildQueued) return;
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
        for (let actor of getWindowActors()) {
            if (this._shouldApplyToWindow(actor))
                this._setupWindow(actor);
        }
    }

    _setupWindow(windowActor: any) {
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

        // Store original opacity and apply the configured glass opacity
        // Almacenar la opacidad original y aplicar la opacidad de cristal configurada
        let originalOpacity = surfaceActor.opacity;
        surfaceActor.opacity = Math.round(this._getContentOpacity() * 255);

        // Defer until actor has valid dimensions and allocation
        //if (windowActor.width <= 0 || windowActor.height <= 0 || !windowActor.has_allocation()) {
        //    let id = windowActor.connect('notify::allocation', () => {
        //        if (windowActor.width > 0 && windowActor.height > 0 && windowActor.has_allocation()) {
        //            windowActor.disconnect(id);
        //            this._setupWindow(windowActor);
        //        }
        //    });
        //    return;
        //}

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

        let blurRadius = this._settings.get_int('application-blur-radius');
        let blurEffect = new Shell.BlurEffect({
            radius: blurRadius,
            mode: Shell.BlurMode.ACTOR,
        });
        clipBox.add_effect(blurEffect);

        // Size the clone to cover the full screen so the wallpaper fills correctly
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
        } as any);


        let tintColorStr = this._settings.get_string('application-tint-color');
        let tintStrength = this._settings.get_double('application-tint-strength');
        let cornerRadius = this._settings.get_double('application-corner-radius');

        effect.setPadding(SHADER_PADDING);
        effect.setTintColor(...this._hexToColorArray(tintColorStr));
        effect.setTintStrength(tintStrength);
        effect.setCornerRadius(cornerRadius);
        effect.setIsDock(false);
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

        let state: WindowState = {
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
            cornerOverlay,
            cornerOverlayClone,
            signals: [],
            originalOpacity
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

    _hexToColorArray(hex: string): [number, number, number] {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return [1.0, 1.0, 1.0];
        let r = parseInt(hex.slice(1, 3), 16) / 255.0;
        let g = parseInt(hex.slice(3, 5), 16) / 255.0;
        let b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [r, g, b];
    }

    _rebuildWindowClones(state: WindowState) {
        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();
        state.windowsContainer.remove_all_children();

        state.baseClones.forEach(clone => clone.destroy());
        state.baseClones.clear();
        state.baseWindowsContainer.remove_all_children();

        // Get windows in stacking order (bottom to top)
        for (let actor of getWindowActors()) {
            // STOP iterating once we reach our own window.
            // This ensures we ONLY render what is actually BEHIND the app.
            if (actor === state.windowActor)
                break;

            if (!(actor instanceof Meta.WindowActor))
                continue;

            let clone = new UnpickableClone({ source: actor });
            state.windowsContainer.add_child(clone);
            state.clones.set(actor, clone);

            let baseClone = new UnpickableClone({ source: actor });
            state.baseWindowsContainer.add_child(baseClone);
            state.baseClones.set(actor, baseClone);
        }
    }

    _syncState(state: WindowState) {
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
        if (!metaWin) return;

        // PERFORMANCE: Only sync windows on the current active workspace.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const winWorkspace = metaWin.get_workspace();
        if (winWorkspace && winWorkspace !== activeWorkspace) {
            if (state.bgActor.visible) state.bgActor.visible = false;
            if (state.baseActor.visible) state.baseActor.visible = false;
            if (state.cornerOverlay.visible) state.cornerOverlay.visible = false;
            return;
        }

    	const rect = metaWin.get_frame_rect();
        const bufferRect = metaWin.get_buffer_rect();

    	if (!rect || !bufferRect || rect.width <= 0 || rect.height <= 0) {
    	    if (state.bgActor.visible) state.bgActor.visible = false;
            if (state.baseActor.visible) state.baseActor.visible = false;
            if (state.cornerOverlay.visible) state.cornerOverlay.visible = false;
    	    return;
    	}

        if (!state.bgActor.visible) state.bgActor.visible = true;
        if (!state.baseActor.visible) state.baseActor.visible = true;
        
        // Local offset of the visible frame within the window actor's full buffer.
        const frameLocalX = rect.x - bufferRect.x;
        const frameLocalY = rect.y - bufferRect.y;

        // Base background (unblurred) expanded by expansion margin.
        state.baseActor.set_position(frameLocalX - SHADER_PADDING, frameLocalY - SHADER_PADDING);
        state.baseActor.set_size(rect.width + (SHADER_PADDING * 2), rect.height + (SHADER_PADDING * 2));

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

        // Sync blurred clones
        for (let [src, clone] of state.clones.entries()) {
            if (!isActorValid(src) || !src.visible || !src.mapped || !src.has_allocation()) {
                if (isActorValid(clone) && clone.visible) clone.hide();
                continue;
            }
            if (isActorValid(clone)) {
                if (!clone.visible) clone.show();

                clone.set_position(src.x, src.y);
                clone.set_size(src.width, src.height);
                clone.set_scale(src.scale_x, src.scale_y);
                clone.opacity = src.opacity;
            }
        }

        // Sync base clones (unblurred)
        for (let [src, clone] of state.baseClones.entries()) {
            if (!isActorValid(src) || !src.visible || !src.mapped || !src.has_allocation()) {
                if (isActorValid(clone) && clone.visible) clone.hide();
                continue;
            }
            if (isActorValid(clone)) {
                if (!clone.visible) clone.show();

                clone.set_position(src.x, src.y);
                clone.set_size(src.width, src.height);
                clone.set_scale(src.scale_x, src.scale_y);
                clone.opacity = src.opacity;
            }
        }

        if (!state.cornerOverlay.visible) {
            state.cornerOverlay.show();
        }

        const baseW = rect.width + (SHADER_PADDING * 2);
        const baseH = rect.height + (SHADER_PADDING * 2);

        state.cornerOverlay.set_position(
            frameLocalX - SHADER_PADDING,
            frameLocalY - SHADER_PADDING,
        );
        state.cornerOverlay.set_size(baseW, baseH);
        
        state.cornerOverlayClone.set_position(0, 0);
        state.cornerOverlayClone.set_size(baseW, baseH);
    }

    _frameTick() {
        //if (!this._isEffectEnabled() || this._states.size === 0) {
        //    this._frameSyncId = 0;
        //    return;
        //}

        for (let state of this._states.values()) {
            try {
                this._syncState(state);
            } catch (e) {
                console.error(`[Liquid Glass] Error in _syncState: ${e}`);
            }
        }

        this._frameSyncId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW,
            () => {
                this._frameTick();
                return false;
            }
        );
    }

    _cleanupState(state: WindowState) {
        if (!state) return;

        // Restore original window content layer's opacity
        // Restaurar la opacidad original del contenido de la ventana
        if (state.windowActor) {
            let surfaceActor = state.windowActor.get_first_child();
            if (surfaceActor) {
                surfaceActor.opacity = state.originalOpacity;
            }
        }

        if (state.signals) {
            state.signals.forEach(sig => {
                try {
                    sig.obj.disconnect(sig.id);
                } catch (e) {}
            });
            state.signals = [];
        }

        state.clones.forEach(clone => clone.destroy());
        state.clones.clear();

        state.baseClones.forEach(clone => clone.destroy());
        state.baseClones.clear();

        if (state.bgActor)
            state.bgActor.destroy();
            
        if (state.baseActor)
            state.baseActor.destroy();

        if (state.cornerOverlay)
            state.cornerOverlay.destroy();

        if (state.roundingEffect) {
            // No need to manually remove from cornerOverlay as it's destroyed
        }
    }
}
