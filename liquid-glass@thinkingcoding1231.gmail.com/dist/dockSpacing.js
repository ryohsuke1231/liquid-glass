import { GeneratedStylesheet } from './generatedStylesheet.js';
const KEYS = ['dock-space-edge', 'dock-space-far'];
const SIDES = ['top', 'bottom', 'left', 'right'];
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
// The padding the theme gives a dock icon.
const ICON_ROOM = 6;

/** Whether the settings give the room around the dock's apps, rather than leaving it to Dash to Dock. */
export function dockSpacingSet(settings) {
    return KEYS.every(key => settings.get_int(key) >= 0);
}

/**
 * The rules that leave `edge` px between the apps of a dock with glass and the screen edge, and `far` px on their
 * other side. Each is the whole space from the icon to the dock's side. The icon's own box, which its highlight
 * fills, is forced square by the shell: uneven padding would shrink the icon. So it takes the smaller space on all
 * four sides, the tile around it takes what is left of each, and side margins keep the icons as far apart as the
 * theme has them.
 */
export function dockSpacingCss(edge, far) {
    const icon = Math.min(edge, far, ICON_ROOM);
    return SIDES.map(side => {
        const across = side === 'top' || side === 'bottom' ? ['left', 'right'] : ['top', 'bottom'];
        const item = `#dashtodockContainer.${side} #dash #dashtodockDashContainer.liquid-glass-transparent .dash-item-container`;
        return `${item} .overview-tile, ${item} .app-well-app, ${item} .show-apps {\n` +
            `  padding-${side}: ${edge - icon}px !important;\n` +
            `  padding-${OPPOSITE[side]}: ${far - icon}px !important;\n}\n` +
            `${item} .overview-tile .overview-icon, ${item} .show-apps .overview-icon {\n` +
            `  padding: ${icon}px !important;\n` +
            across.map(a => `  margin-${a}: ${ICON_ROOM - icon}px !important;\n`).join('') + '}\n';
    }).join('');
}

/** Sets the room around the apps of the docks with glass, which with the icon size is the dock's thickness. */
export class DockSpacing {
    _settings;
    _style;
    _settingsIds = [];

    constructor(_settings, logger) {
        this._settings = _settings;
        this._style = new GeneratedStylesheet('liquid-glass-dock-spacing.css', logger);
    }

    setup() {
        this._settingsIds = KEYS.map(key => this._settings.connect(`changed::${key}`, () => this._apply()));
        this._apply();
    }

    _apply() {
        this._style.set(dockSpacingSet(this._settings)
            ? dockSpacingCss(this._settings.get_int(KEYS[0]), this._settings.get_int(KEYS[1])) : null);
    }

    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._style.cleanup();
    }
}
