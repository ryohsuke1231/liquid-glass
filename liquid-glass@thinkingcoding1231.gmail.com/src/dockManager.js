// src/dockManager.js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import { LiquidEffect } from './liquidEffect.js';

// Padding to allow the shader to draw effects (like refraction and blur) outside the actor's strict bounds.
const SHADER_PADDING = 20;

export class DashManager {
    constructor(extensionPath, targetActor) {
        this.extensionPath = extensionPath;
        this.targetActor = targetActor;
        this.bgActor = null;
        this.blurEffect = null;
        this.effect = null;
        
        this.bgClone = null;
        this.windowClonesContainer = null;
        
        // Map to keep track of active windows and their corresponding clone actors.
        this._windowClones = new Map();

        this._signals = [];
        this._frameSyncId = 0;
    }

    setup() {
        if (!this.targetActor) return;
        
        // Remove the default styling to make the original dock container completely transparent.
        this.targetActor.add_style_class_name('liquid-glass-transparent');

        // Apply transparency to the parent container as well to ensure no background blocks the effect.
        this._dockParent = this.targetActor.get_parent();
        if (this._dockParent) {
            this._dockParent.add_style_class_name('liquid-glass-transparent');
        }

        // Create the main background actor that will render the custom shader.
        // clip_to_allocation is false so the shader can draw slightly outside its bounds if needed.
        this.bgActor = new St.Widget({
            style_class: 'liquid-glass-bg-actor',
            clip_to_allocation: false,
            reactive: false
        });
        
        // Set an initial size of 1x1. Passing a 0x0 size to the Cogl engine 
        // while applying a shader will immediately crash the GNOME Shell.
        this.bgActor.set_size(1.0, 1.0); 

        // Internal box to hold the desktop/window clones and clip them perfectly.
        this.clipBox = new St.Widget({ clip_to_allocation: true });
        this.clipBox.set_size(1.0, 1.0);
        this.bgActor.add_child(this.clipBox);

        // Pivot points for scaling and positioning.
        this.targetActor.set_pivot_point(0.5, 0.5);
        this.bgActor.set_pivot_point(0.0, 0.0);

        // Save the original inline style and append a bottom margin.
        // This shifts the inner content of the dock slightly upwards without interfering 
        // with Dash to Dock's translation_y hide/show animations.
        this._originalStyle = this.targetActor.get_style() || '';
        this.targetActor.set_style(this._originalStyle + ' margin-bottom: 8px;');
        
        // Find the root actor of the dock to avoid layout conflicts.
        // We move our custom background to the global uiGroup and place it behind the dock.
        let dockRoot = this.targetActor;
        while (dockRoot && dockRoot.get_parent() !== Main.layoutManager.uiGroup) {
            let p = dockRoot.get_parent();
            if (!p) break;
            dockRoot = p;
        }

        if (dockRoot && dockRoot.get_parent() === Main.layoutManager.uiGroup) {
            Main.layoutManager.uiGroup.insert_child_below(this.bgActor, dockRoot);
        } else {
            Main.layoutManager.uiGroup.add_child(this.bgActor);
        }

        // Apply native GNOME blur to the internal clipBox (which contains the clones).
        this.blurEffect = new Shell.BlurEffect({ radius: 5, mode: Shell.BlurMode.ACTOR });
        this.clipBox.add_effect(this.blurEffect);

        // Apply our custom GLSL liquid glass shader to the outer background actor.
        this.effect = new LiquidEffect({ extensionPath: this.extensionPath });
        this.effect.setPadding(SHADER_PADDING);
        this.effect.setTintColor(1.0, 1.0, 1.0); // Pure white/transparent base
        this.effect.setTintStrength(0.12); // Subtle tint overlay for the frosted glass look
        this.effect.setCornerRadius(30.0);
        
        // Inform the shader that this is the dock, enabling specific anti-aliasing bounds.
        this.effect.setIsDock(true);
        this.bgActor.add_effect(this.effect);

        this.bgActor.show();

        // Helper functions to hook into GNOME's render pipeline.
        const laterAdd = (laterType, callback) => {
            return global.compositor?.get_laters?.().add(laterType, callback) ??
                   Meta.later_add(laterType, callback);
        };
        
        // Hook into the frame right before it is painted to the screen.
        const frameLaterType = Meta.LaterType.BEFORE_REDRAW ?? Meta.LaterType.BEFORE_PAINT;

        // Function to create clones of the desktop wallpaper and all visible windows.
        let buildClones = () => {
            if (!this.bgActor) return;
            
            // Clean up old clones before creating new ones.
            if (this.bgClone) { this.bgClone.destroy(); this.bgClone = null; }
            if (this.windowClonesContainer) { this.windowClonesContainer.destroy(); this.windowClonesContainer = null; }

            // Clone the desktop background.
            this.bgClone = new Clutter.Clone({ source: Main.layoutManager._backgroundGroup });
            this.clipBox.add_child(this.bgClone);

            // Create a container for the window clones.
            this.windowClonesContainer = new Clutter.Actor();
            this.clipBox.add_child(this.windowClonesContainer);

            this._windowClones.clear();

            // Iterate through all windows managed by the compositor.
            let windows = global.get_window_actors();
            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                
                // Skip minimized or hidden windows to save performance.
                if (!metaWindow || metaWindow.minimized || !w.visible) continue;
                
                let clone = new Clutter.Clone({ source: w });
                clone.set_position(w.x, w.y);
                this.windowClonesContainer.add_child(clone);
                this._windowClones.set(w, clone);
            }
        };

        // Render loop function, called every frame.
        let frameTick = () => {
            this._frameSyncId = 0;
            if (!this.bgActor || !this.targetActor.mapped) return GLib.SOURCE_REMOVE;

            this._syncGeometry();
            this._frameSyncId = laterAdd(frameLaterType, frameTick);
            return GLib.SOURCE_REMOVE;
        };

        // Starts the render loop and builds fresh clones.
        let startFrameSync = () => {
            if (this._frameSyncId === 0) {
                buildClones();
                this._frameSyncId = laterAdd(frameLaterType, frameTick);
            }
        };

        // Listen for visibility changes to pause the render loop when hidden.
        this._signals.push(this.targetActor.connect('notify::mapped', () => {
            if (this.targetActor.mapped) {
                startFrameSync();
            } else {
                if (this._frameSyncId !== 0) {
                    this._frameSyncId = 0;
                }
            }
        }));

        if (this.targetActor.mapped) {
            startFrameSync();
        }
    }

    // Calculates and synchronizes the position/size of the glass background every frame.
    _syncGeometry() {
        if (!this.bgActor || !this.targetActor || !this.targetActor.mapped) return;

        // Find the actual visible background element inside the dock container to get accurate dimensions.
        let sourceActor = this.targetActor;
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 0; // Hide the original background
                sourceActor = children[i];
            }
        }

        let [baseW, baseH] = sourceActor.get_size();

        // Math.max guarantees the size never drops below 1px.
        // A size of 0x0 will crash the Cogl engine when a custom shader is applied.
        let w = Math.max(1.0, baseW);
        let h = Math.max(1.0, baseH);

        // Skip rendering if the dock is essentially collapsed.
        if (baseW <= 9 || baseH <= 9) {
            this.bgActor.hide();
            return;
        } else {
            this.bgActor.show(); 
        }

        this.bgActor.opacity = this.targetActor.opacity;

        let [absX, absY] = sourceActor.get_transformed_position();
        if (Number.isNaN(absX) || Number.isNaN(absY)) return;

        // Calculate how much of the dock is actually visible on the screen.
        // This is necessary because Dash to Dock hides itself by moving off-screen.
        let monitorIndex = Main.layoutManager.findIndexForActor(this.targetActor);
        if (monitorIndex < 0) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        let monitor = Main.layoutManager.monitors[monitorIndex] || Main.layoutManager.primaryMonitor;
        
        let visibleW = baseW;
        let visibleH = baseH;
        if (monitor) {
            // Subtract the portions of the dock that are outside the monitor boundaries.
            if (absX < monitor.x) visibleW -= (monitor.x - absX);
            if (absY < monitor.y) visibleH -= (monitor.y - absY);
            if (absX + baseW > monitor.x + monitor.width) visibleW -= ((absX + baseW) - (monitor.x + monitor.width));
            if (absY + baseH > monitor.y + monitor.height) visibleH -= ((absY + baseH) - (monitor.y + monitor.height));
        }

        // If less than 5px is visible, consider it hidden. 
        // This prevents the glass effect from rendering when only the hover trigger is active.
        if (visibleW <= 5 || visibleH <= 5) {
            this.bgActor.opacity = 0;
        } else {
            this.bgActor.opacity = this.targetActor.opacity;
        }

        // Add the padding required by the shader to the final dimensions.
        let bgW = Math.max(1.0, w + (SHADER_PADDING * 2));
        let bgH = Math.max(1.0, h + (SHADER_PADDING * 2));
        let bgX = absX - SHADER_PADDING;
        let bgY = absY - SHADER_PADDING;

        // Only update positions/sizes if they actually changed to save CPU cycles.
        if (this._lastBgW !== bgW || this._lastBgH !== bgH || this._lastBgX !== bgX || this._lastBgY !== bgY) {
            this.bgActor.set_size(bgW, bgH);
            this.bgActor.set_position(bgX, bgY);
            
            this.clipBox.set_size(bgW, bgH);
            this.clipBox.set_position(0, 0);

            // Update the shader with the new resolution.
            this.effect.setResolution(bgW, bgH);

            this._lastBgW = bgW; this._lastBgH = bgH;
            this._lastBgX = bgX; this._lastBgY = bgY;
        }

        // Apply a negative offset to the clones inside the clipBox.
        // This ensures the cloned background matches the real desktop coordinates perfectly.
        if (this.bgClone && this.windowClonesContainer) {
            this.bgClone.set_position(-bgX, -bgY);
            this.windowClonesContainer.set_position(-bgX, -bgY);
            
            // Efficient window synchronization logic.
            let windows = global.get_window_actors();
            let activeWindows = new Set();
            let zIndex = 0; // Tracks the stacking order

            for (let w of windows) {
                let metaWindow = w.get_meta_window();
                if (!metaWindow || metaWindow.minimized || !w.visible) continue;

                activeWindows.add(w);

                let clone;
                if (!this._windowClones.has(w)) {
                    // Create a clone for newly opened windows.
                    clone = new Clutter.Clone({ source: w });
                    this.windowClonesContainer.add_child(clone);
                    this._windowClones.set(w, clone);
                } else {
                    // Retrieve existing clone.
                    clone = this._windowClones.get(w);
                }
                
                // Keep the position synchronized with the real window.
                clone.set_position(w.x, w.y);

                // Update the Z-index dynamically to reflect window focus changes.
                this.windowClonesContainer.set_child_at_index(clone, zIndex);
                zIndex++;
            }

            // Destroy clones for windows that have been closed or minimized.
            for (let [w, clone] of this._windowClones.entries()) {
                if (!activeWindows.has(w)) {
                    clone.destroy();
                    this._windowClones.delete(w);
                }
            }
        }
    }

    cleanup() {
        if (!this.targetActor) return;

        // Disconnect all event listeners.
        for (let sigId of this._signals) {
            this.targetActor.disconnect(sigId);
        }
        this._signals = [];

        // Remove transparent CSS overrides.
        this.targetActor.remove_style_class_name('liquid-glass-transparent');
        
        if (this._dockParent) {
            this._dockParent.remove_style_class_name('liquid-glass-transparent');
            this._dockParent = null;
        }

        // Restore the original inline style to remove the custom margin.
        if (this._originalStyle !== undefined) {
            this.targetActor.set_style(this._originalStyle);
            this._originalStyle = undefined;
        }

        // Restore visibility to the original background elements.
        let children = this.targetActor.get_children();
        for (let i = 0; i < children.length; i++) {
            if (children[i].has_style_class_name('dash-background')) {
                children[i].opacity = 255;
            }
        }

        // Stop the render frame loop safely.
        // Using global.compositor avoids crashing the Cogl context.
        if (this._frameSyncId !== 0) {
            if (global.compositor?.get_laters) {
                global.compositor.get_laters().remove(this._frameSyncId);
            } else {
                Meta.later_remove(this._frameSyncId);
            }
            this._frameSyncId = 0;
        }

        // Destroy all injected actors and clear memory.
        if (this.bgActor) { 
            this.bgActor.destroy(); 
            this.bgActor = null; 
        }
        this.effect = null;
        this.blurEffect = null;
        this.bgClone = null;
        this.windowClonesContainer = null;
        this._windowClones.clear();
    }
}