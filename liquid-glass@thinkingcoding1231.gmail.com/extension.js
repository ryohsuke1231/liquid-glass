import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { UIManager } from './dist/uiManager.js';
import { DashManager } from './dist/dockManager.js';
import { NotificationManager } from './dist/notificationManager.js';
import { QuickSettingsManager } from './dist/quickSettingsManager.js';
import { OsdManager } from './dist/osdManager.js';
import { ApplicationManager } from './dist/applicationManager.js';
import { WindowListService } from './dist/windowListService.js';
import { Logger } from './dist/logger.js';
import { setUtilsLogger } from './dist/utils.js';
import GLib from 'gi://GLib';

export default class LiquidGlassExtension extends Extension {
  // [FIX] enable() must never throw, and enable/disable must be strictly paired.
  //
  // Two things in gnome-shell's ExtensionManager make this load-bearing:
  //
  // 1. If enable() throws, logExtensionError() sets the extension's state to
  //    ERROR — and _callExtensionEnable() starts with
  //        if (extension.state !== ExtensionState.INACTIVE) return;
  //    so from that moment on every attempt to switch the extension back on
  //    is a SILENT no-op for the rest of the session. That is exactly the
  //    "it can no longer be enabled" symptom, and it leaves no trace beyond
  //    the one error line.
  // 2. _callExtensionDisable() "rebases" the extension order: when ANY
  //    extension before us in that order is switched off, it calls our
  //    stateObj.disable() and then our stateObj.enable() DIRECTLY, without
  //    going through the state machine at all. So enable() runs far more
  //    often than the user ever toggles anything, and an unbalanced pair
  //    there would silently stack a second set of managers, signal handlers
  //    and per-frame later chains on top of the live ones.
  //
  // So: re-entrancy guard, plus a catch that tears the partial state back
  // down and reports loudly instead of propagating.
  enable() {
    if (this._active) {
      console.warn('[Liquid Glass] enable() called while already enabled — ignoring (this would have stacked a second set of managers).');
      return;
    }
    this._active = true;

    try {
      this._enableInner();
    } catch (e) {
      console.error(`[Liquid Glass] enable() failed: ${e}\n${e?.stack ?? ''}`);
      // Undo whatever got built before the throw. Without this the shell
      // would mark us ERROR and never call enable() again, while our
      // half-built actors and later chains stayed on screen.
      try {
        this.disable();
      } catch (e2) {
        console.error(`[Liquid Glass] cleanup after a failed enable() also failed: ${e2}`);
      }
    }
  }

  _enableInner() {
    // [DIAG] Pairs with the marker at the end of disable(). Printed before
    // anything can throw, so a journal always shows how far a failed enable
    // got.
    console.log('[Liquid Glass] Enabling...');

    this._settings = this.getSettings("org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com");

    // Initialize the logger
    this._logger = new Logger(this._settings);
    // utils.ts has no settings of its own; hand it the shared, gated logger
    // so UILayerSampler's diagnostics obey `output-logs` like everything else.
    setUtilsLogger(this._logger);

    this._logger.log(`[Liquid Glass] Enabled. UUID: ${this.uuid}`);

    // [FIX] One manager failing to start must not abort enable().
    //
    // An exception out of enable() puts the extension into the shell's ERROR
    // state; the shell then calls disable() and the toggle refuses to turn it
    // back on until the session is restarted. A single manager that cannot
    // find its target (the shell moved a widget, another extension replaced
    // it) is not a reason to lose the other five — and the failure is louder
    // here, not quieter, because the line below is not gated on `output-logs`.
    const start = (name, fn) => {
      try {
        fn();
      } catch (e) {
        console.error(`[Liquid Glass] ${name} setup failed during enable(): ${e}\n${e?.stack ?? ''}`);
      }
    };

    // Initialize the UI manager for the top panel (e.g., Date Menu)
    // Pass the extension path so it can properly load the GLSL shader files
    start('uiManager', () => {
      this._uiManager = new UIManager(this.dir.get_path(), this._settings, this._logger);
      this._uiManager.setup();
    });

    // Initialize the notification manager to apply effects to notifications
    start('notificationManager', () => {
      this._notificationManager = new NotificationManager(this.dir.get_path(), this._settings, this._logger);
      this._notificationManager.setup();
    });

    // Initialize the OSD manager to apply effects to on-screen displays (like volume changes)
    start('osdManager', () => {
      this._osdManager = new OsdManager(this.dir.get_path(), this._settings, this._logger);
      this._osdManager.setup();
    });

    // Initialize the Application manager to apply effects to whitelisted (or all) application windows
    start('applicationManager', () => {
      this._applicationManager = new ApplicationManager(this.dir.get_path(), this._settings, this._logger);
      this._applicationManager.setup();
    });

    // Publishes the list of open windows over D-Bus so the preferences window —
    // which runs in a separate process with no access to Meta/Shell — can offer a
    // live picker instead of asking the user to type WM_CLASS values by hand.
    start('windowListService', () => {
      this._windowListService = new WindowListService(this._logger);
      this._windowListService.setup();
    });

    this._quickSettingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      this._quickSettingsTimeoutId = 0;
      start('quickSettingsManager', () => {
        this._quickSettingsManager = new QuickSettingsManager(this.dir.get_path(), this._settings, this._logger);
        this._quickSettingsManager.setup();
      });
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
    this._active = false;

    // [FIX] disable() must be idempotent and must never throw.
    //
    // The last thing this method does is drop `this._logger`, so a second
    // disable() — the shell issues one on a session-mode change, on the lock
    // screen, and after an enable() that threw — used to die on this very
    // first line with "this._logger is null". A disable() that throws leaves
    // the extension in the shell's ERROR state, and from there the toggle
    // will not turn it back on: that is the "it can no longer be enabled"
    // symptom, and it is reached without a single line of ours in the log.
    this._logger?.log(`[Liquid Glass] Disabling...`);

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
    //
    // [FIX] Every manager is torn down inside its own try/catch.
    //
    // These calls used to run bare, one after another, so the FIRST one that
    // threw took the rest of disable() with it: the remaining managers kept
    // their signal handlers, their actors and their effects, and the next
    // enable() built a second set on top of the leftovers — which is the
    // "the extension can no longer be enabled" symptom. Disabling is exactly
    // the moment when a throw is most likely, because the shell is tearing
    // down the same actors we are, and a cleanup step that cannot finish is
    // still far better than one that never starts.
    const teardown = (name, fn) => {
      try {
        fn();
      } catch (e) {
        // The logger may itself be half gone by now; never let reporting a
        // failed teardown abort the teardown.
        try {
          this._logger?.error(`[Liquid Glass] ${name} cleanup failed during disable(): ${e}`);
        } catch (_) {
          console.error(`[Liquid Glass] ${name} cleanup failed during disable(): ${e}`);
        }
      }
    };

    teardown('uiManager', () => {
      if (this._uiManager) {
        this._uiManager.cleanup();
        this._uiManager = null;
      }
    });

    teardown('quickSettingsManager', () => {
      if (this._quickSettingsManager) {
        this._quickSettingsManager.cleanup();
        this._quickSettingsManager = null;
      }
    });

    teardown('dashManager', () => {
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
    });

    teardown('notificationManager', () => {
      if (this._notificationManager) {
        this._notificationManager.cleanup();
        this._notificationManager = null;
      }
    });

    teardown('osdManager', () => {
      if (this._osdManager) {
        this._osdManager.cleanup();
        this._osdManager = null;
      }
    });

    teardown('applicationManager', () => {
      if (this._applicationManager) {
        this._applicationManager.cleanup();
        this._applicationManager = null;
      }
    });

    teardown('windowListService', () => {
      if (this._windowListService) {
        this._windowListService.cleanup();
        this._windowListService = null;
      }
    });

    // Dropped unconditionally: whatever happened above, this instance must
    // not keep the shell's settings object or the module-level logger hook
    // alive, or the next enable() starts from a polluted state.
    this._settings = null;
    this._uiManager = null;
    this._quickSettingsManager = null;
    this._dashManager = null;
    this._notificationManager = null;
    this._osdManager = null;
    this._applicationManager = null;
    this._windowListService = null;

    teardown('logger', () => {
      if (this._logger) {
        setUtilsLogger(null);
        this._logger.cleanup();
        this._logger = null;
      }
    });
    setUtilsLogger(null);
    this._logger = null;

    // [DIAG] Not gated on `output-logs`, and deliberately console.log: this
    // is the one line that proves the teardown reached its end. If a journal
    // shows "Disabling..." without this line following it, disable() threw
    // somewhere the per-manager guards above do not cover, and the next
    // enable() is starting from a polluted state.
    console.log('[Liquid Glass] Disabled (teardown reached the end).');
  }
}
