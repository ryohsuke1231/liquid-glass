import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { UIManager } from './dist/uiManager.js';
import { DashManager } from './dist/dockManager.js';
import { NotificationManager } from './dist/notificationManager.js';
import { QuickSettingsManager } from './dist/quickSettingsManager.js';
import { OsdManager } from './dist/osdManager.js';
import { Logger } from './dist/logger.js';
import GLib from 'gi://GLib';

export default class LiquidGlassExtension extends Extension {
  enable() {
    this._settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

    // Initialize the logger
    this._logger = new Logger(this._settings);

    this._logger.log(`[Liquid Glass] Enabled. UUID: ${this.uuid}`);

    // Initialize the UI manager for the top panel (e.g., Date Menu)
    // Pass the extension path so it can properly load the GLSL shader files
    this._uiManager = new UIManager(this.dir.get_path(), this._settings, this._logger);
    this._uiManager.setup();

    // Initialize the notification manager to apply effects to notifications
    this._notificationManager = new NotificationManager(this.dir.get_path(), this._settings, this._logger);
    this._notificationManager.setup();

    // Initialize the OSD manager to apply effects to on-screen displays (like volume changes)
    this._osdManager = new OsdManager(this.dir.get_path(), this._settings, this._logger);
    this._osdManager.setup();

    this._quickSettingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      this._quickSettingsManager = new QuickSettingsManager(this.dir.get_path(), this._settings, this._logger);
      this._quickSettingsManager.setup();
      this._quickSettingsTimeoutId = 0;
      return GLib.SOURCE_REMOVE;
    });

    // Variable to store the timeout ID so we can cancel it if the extension is disabled quickly
    this._timeoutId = 0;

    this._reconnectTimeoutId = 0; // Timeout ID for reconnecting to Dash to Dock signals if it's not found immediately
    this._dashDestroyId = 0;      // ID for the Dash to Dock destroy signal connection, so we can clean it up properly

    // Dash to Dock might not be fully loaded when this extension is enabled at startup.
    // We set a 2-second (2000ms) delay before searching for its UI container.
    this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      this._findDashToDock();

      // Reset the ID after execution
      this._timeoutId = 0;

      // Return SOURCE_REMOVE to ensure this timer only runs exactly once
      return GLib.SOURCE_REMOVE;
    });
  }

  _findDashToDock() {
    // A helper function to recursively search the GNOME UI tree for a specific actor name
    const findActorByName = (actor, name) => {
      if (actor.get_name && actor.get_name() === name) {
        return actor;
      }

      // Traverse through all children elements
      let children = actor.get_children();
      for (let i = 0; i < children.length; i++) {
        let found = findActorByName(children[i], name);
        if (found) return found;
      }
      return null;
    };

    // Search the entire GNOME UI group for the main Dash to Dock container
    let dashContainer = findActorByName(Main.layoutManager.uiGroup, 'dashtodockDashContainer');

    if (dashContainer) {
      this._logger.log("[Liquid Glass] Found Dash to Dock container!", dashContainer);

      // Initialize the dock manager and apply the liquid glass effect
      this._dashManager = new DashManager(this.dir.get_path(), dashContainer, this._settings, this._logger);
      this._dashManager.setup();

      this._dashDestroyId = dashContainer.connect('destroy', () => {
        this._logger.log("[Liquid Glass] Dash to Dock container destroyed (settings changed?). Restarting search...");
        this._dashDestroyId = 0; // Reset the destroy signal ID since the container is gone

        // Cleanup the existing Dash manager to avoid memory leaks or orphaned actors
        if (this._dashManager) {
          this._dashManager.cleanup();
          this._dashManager = null;
        }

        // Clear any existing reconnect timeout to prevent multiple timers from stacking up
        if (this._reconnectTimeoutId !== 0) {
          GLib.Source.remove(this._reconnectTimeoutId);
        }

        // Set a short delay before trying to find Dash to Dock again, as it might be reloaded shortly after being destroyed
        this._reconnectTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
          // Try to find Dash to Dock again after the delay. If it's found, the timer will be removed. If not, it will continue to check every 2 seconds until it is found.
          let isFound = this._findDashToDock();

          if (isFound) {
            // If found, reset the timeout ID and remove the timer
            this._reconnectTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }

          // If not found, continue the loop and check again in 2 seconds
          return GLib.SOURCE_CONTINUE;
        });

        return true; // Return true to indicate that the signal was handled
      });
      return true;

    } else {
      // Note: If it's still not found, the user might not have Dash to Dock installed,
      // or it requires a more complex monitoring system to detect late loads.
      this._logger.log("[Liquid Glass] Dash to Dock was not found.");
      return false; // Return false to indicate that Dash to Dock was not found
    }
  }

  disable() {
    this._logger.log(`[Liquid Glass] Disabling...`);

    if (this._quickSettingsTimeoutId && this._quickSettingsTimeoutId !== 0) {
      GLib.Source.remove(this._quickSettingsTimeoutId);
      this._quickSettingsTimeoutId = 0;
    }

    // Clear any pending timeouts to prevent them from executing after the extension is disabled
    if (this._timeoutId !== 0) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = 0;
    }

    if (this._reconnectTimeoutId !== 0) {
      GLib.Source.remove(this._reconnectTimeoutId);
      this._reconnectTimeoutId = 0;
    }

    // Crucial: Always restore the UI to its original state when the extension is disabled
    // Failing to clean up can result in invisible menus or memory leaks
    if (this._uiManager) {
      this._uiManager.cleanup();
      this._uiManager = null;
    }

    if (this._quickSettingsManager) {
      this._quickSettingsManager.cleanup();
      this._quickSettingsManager = null;
    }

    if (this._dashManager) {
      // Disconnect the destroy signal if it was connected
      if (this._dashDestroyId !== 0 && this._dashManager.targetActor) {
        try {
          this._dashManager.targetActor.disconnect(this._dashDestroyId);
        } catch (e) { }
        this._dashDestroyId = 0;
      }
      this._dashManager.cleanup();
      this._dashManager = null;
    }

    if (this._notificationManager) {
      this._notificationManager.cleanup();
      this._notificationManager = null;
    }

    if (this._osdManager) {
      this._osdManager.cleanup();
      this._osdManager = null;
    }

    this._settings = null;

    if (this._logger) {
      this._logger.cleanup();
      this._logger = null;
    }
  }
}
