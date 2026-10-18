"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SOFTWARE_PROVIDER = void 0;
exports.softwareDesktopId = softwareDesktopId;
exports.SOFTWARE_PROVIDER = 'org.gnome.Software.desktop';
/**
 * The desktop file that an application found by GNOME Software's search has once it is installed, from its result id
 * (scope/kind/origin/id/branch). Null for kinds whose desktop file is not named after the id.
 */

function softwareDesktopId(resultId) {
    const [, kind, , appId] = resultId.split('/');
    if (!appId)
        return null;
    if (kind === 'flatpak')
        return appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
    if (kind === 'package' && appId.endsWith('.desktop'))
        return appId;
    return null;
}
