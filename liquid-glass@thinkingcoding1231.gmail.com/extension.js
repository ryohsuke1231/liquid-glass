import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {UIManager} from './dist/uiManager.js';
import {PanelMenuManager, ExtraDateMenuManager} from './dist/panelMenuManager.js';
import {BlurMyShellWatch} from './dist/blurMyShell.js';
import {DockWatcher} from './dist/dockManager.js';
import {NotificationManager} from './dist/notificationManager.js';
import {QuickSettingsManager} from './dist/quickSettingsManager.js';
import {OsdManager} from './dist/osdManager.js';
import {ApplicationManager} from './dist/applicationManager.js';
import {WindowListService} from './dist/windowListService.js';
import {TopBarManager, ExtraTopBarManager} from './dist/topBarManager.js';
import {DesktopLayer} from './dist/desktop/desktopLayer.js';
import {Launcher} from './dist/launcherManager.js';
import {IconStyler} from './dist/iconStyle/iconStyler.js';
import {Logger, setUtilsLogger} from './dist/logger.js';
import {adaptiveColorTweener} from './dist/animation.js';
import {installGlassDiagnostics, removeGlassDiagnostics, DumpShortcut} from './dist/diagnostics.js';
import {trackViewPaints, untrackViewPaints} from './dist/rendering/backdropGlass.js';
import {clearShaderSources} from './dist/rendering/pipelines.js';

const QUICK_SETTINGS_DELAY_MS = 1500;

export default class LiquidGlassExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._logger = new Logger(this._settings);
    // Modules without settings of their own log through the same
    // `output-logs`-gated logger.
    setUtilsLogger(this._logger);
    installGlassDiagnostics();
    trackViewPaints();

    const path = this.dir.get_path();

    this._uiManager = new UIManager(path, this._settings, this._logger);
    this._uiManager.setup();

    this._extraDateMenuManager = new ExtraDateMenuManager(path, this._settings, this._logger);
    this._extraDateMenuManager.setup();

    this._panelMenuManager = new PanelMenuManager(path, this._settings, this._logger);
    this._panelMenuManager.setup();

    this._topBarManager = new TopBarManager(path, this._settings, this._logger);
    this._topBarManager.setup();

    this._extraTopBarManager = new ExtraTopBarManager(path, this._settings, this._logger);
    this._extraTopBarManager.setup();

    this._desktopLayer = new DesktopLayer(path, this._settings, this._logger, () => this.openPreferences());
    this._desktopLayer.setup();

    this._iconStyler = new IconStyler(path, this._settings, this._logger);
    this._iconStyler.setup();

    this._launcher = new Launcher(path, this._settings, this._logger, this._iconStyler);
    this._launcher.setup();

    this._blurMyShellWatch = new BlurMyShellWatch(this._settings, this._logger);
    this._blurMyShellWatch.setup();

    this._notificationManager = new NotificationManager(path, this._settings, this._logger);
    this._notificationManager.setup();

    this._osdManager = new OsdManager(path, this._settings, this._logger);
    this._osdManager.setup();

    this._applicationManager = new ApplicationManager(path, this._settings, this._logger);
    this._applicationManager.setup();

    // Lets the preferences window, which cannot use Meta or Shell, offer a
    // picker of the open windows.
    this._windowListService = new WindowListService(this._logger);
    this._windowListService.setup();

    // The shell adds some Quick Settings items asynchronously at startup, so
    // the menu is styled once they are in place.
    this._quickSettingsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUICK_SETTINGS_DELAY_MS, () => {
      this._quickSettingsTimeoutId = 0;
      this._quickSettingsManager = new QuickSettingsManager(path, this._settings, this._logger);
      this._quickSettingsManager.setup();
      return GLib.SOURCE_REMOVE;
    });

    this._dockWatcher = new DockWatcher(path, this._settings, this._logger, this._iconStyler);
    this._dockWatcher.setup();

    this._dumpShortcut = new DumpShortcut(this._settings);
    this._dumpShortcut.setup();
  }

  disable() {
    this._dumpShortcut.cleanup();
    this._dumpShortcut = null;

    // Shared state that no single manager owns.
    adaptiveColorTweener.stopAll();

    if (this._quickSettingsTimeoutId) {
      GLib.Source.remove(this._quickSettingsTimeoutId);
      this._quickSettingsTimeoutId = 0;
    }

    this._panelMenuManager.cleanup();
    this._panelMenuManager = null;

    this._topBarManager.cleanup();
    this._topBarManager = null;

    this._extraTopBarManager.cleanup();
    this._extraTopBarManager = null;

    this._desktopLayer.cleanup();
    this._desktopLayer = null;

    this._launcher.cleanup();
    this._launcher = null;

    this._blurMyShellWatch.cleanup();
    this._blurMyShellWatch = null;

    this._uiManager.cleanup();
    this._uiManager = null;

    this._extraDateMenuManager.cleanup();
    this._extraDateMenuManager = null;

    this._quickSettingsManager?.cleanup();
    this._quickSettingsManager = null;

    // Before the icon styler, which the docks' icons are watched by.
    this._dockWatcher.cleanup();
    this._dockWatcher = null;

    this._iconStyler.cleanup();
    this._iconStyler = null;

    this._notificationManager.cleanup();
    this._notificationManager = null;

    this._osdManager.cleanup();
    this._osdManager = null;

    this._applicationManager.cleanup();
    this._applicationManager = null;

    this._windowListService.cleanup();
    this._windowListService = null;

    untrackViewPaints();
    clearShaderSources();
    removeGlassDiagnostics();
    setUtilsLogger(null);
    this._logger.cleanup();
    this._logger = null;
    this._settings = null;
  }
}
