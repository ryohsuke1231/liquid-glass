import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Clutter from 'gi://Clutter';
import { BackdropGlass } from './rendering/backdropGlass.js';
import { ensureGlassAllocated } from './actors/allocation.js';
import { isActorValid } from './actors/lifecycle.js';
import { startSyncLoop, stopStageLoop } from './animation/frameLoops.js';
import { hexToColorArray } from './animation/colors.js';
import { sanitizeColorPreference } from './contrastSampler.js';
import { AdaptiveTextColor } from './adaptiveText.js';
// Room around the glass rect for the shader's edge effects.
const SHADER_PADDING = 20;
// Room below the bar for the single pill's shadow.
const SHADOW_ROOM = 48;
const SIDES = ['top', 'bottom', 'left', 'right'];

function sanitizeStyle(value) {
    return value === 'pill' || value === 'islands' ? value : 'off';
}

/**
 * Glass for the top bar itself: one pill across it, or an island behind each
 * of its three groups of buttons (activities, clock, status). The bar's own
 * background is cleared while either is on.
 */
export class TopBarManager {
    _path;
    _settings;
    _logger;
    _style = 'off';
    _glass = null;
    _settingsIds = [];
    _frameSyncId = 0;
    _frameSignalId = 0;
    _lastKey = '';
    _text;
    // The bar and its boxes, with the inline styles they had before ours.
    _savedStyles = [];
    _panelStyleId = 0;
    _margin = { top: 0, bottom: 0, left: 0, right: 0 };
    _padding = { top: 0, bottom: 0, left: 0, right: 0 };

    constructor(_path, _settings, _logger) {
        this._path = _path;
        this._settings = _settings;
        this._logger = _logger;
        this._text = new AdaptiveTextColor(() => this._textRoots(), () => (this._glass ? [this._glass] : []), _logger, 'top bar');
    }

    setup() {
        const watch = (key, fn) => this._settingsIds.push(this._settings.connect(`changed::${key}`, fn));
        watch('top-bar-style', () => this._apply());
        for (const key of ['tint-color', 'tint-strength', 'blur-radius', 'corner-radius', 'brightness', 'contrast', 'saturation'])
            watch(`top-bar-${key}`, () => this._applyMaterial());
        for (const key of ['enable-adaptive-text-color', 'sample-interval-ms', 'adaptive-text-preference'])
            watch(`top-bar-${key}`, () => this._syncText());
        for (const side of SIDES) {
            watch(`top-bar-margin-${side}`, () => this._applyLayout());
            watch(`top-bar-padding-${side}`, () => this._applyLayout());
        }
        this._apply();
    }

    _key(suffix) {
        return `top-bar-${suffix}`;
    }

    _apply() {
        const style = sanitizeStyle(this._settings.get_string('top-bar-style'));
        if (style === this._style)
            return;
        this._remove();
        this._style = style;
        if (style !== 'off')
            this._create();
    }

    _create() {
        const panel = Main.panel;
        const panelBox = Main.layoutManager.panelBox;
        panel.add_style_class_name('liquid-glass-transparent');
        const glass = new BackdropGlass({
            extensionPath: this._path, settings: this._settings, logger: this._logger, owner: 'top-bar',
        });
        this._glass = glass;
        glass.setPadding(SHADER_PADDING);
        glass.setIsDock(false);
        glass.setMultiRegionMode(this._style === 'islands');
        glass.setShadowMaxRadius(SHADOW_ROOM - 8);
        // Below the bar, so the glass reads the stage before the bar is drawn.
        Main.layoutManager.uiGroup.insert_child_below(glass, panelBox);
        this._applyMaterial();
        this._lastKey = '';
        this._savedStyles = [panel, panel._leftBox, panel._centerBox, panel._rightBox].map(actor => [actor, actor.get_style()]);
        // The theme can change the bar's height under us.
        this._panelStyleId = panel.connect('style-changed', () => this._applyLayout());
        this._applyLayout();
        startSyncLoop(this._frameSignalSlot, this._frameSlot, {
            // At shell shutdown the stage destroys the glass before we are told.
            alive: () => !!this._glass && isActorValid(this._glass),
            honourFreeze: true,
            errorTag: 'TopBarManager',
            step: () => {
                ensureGlassAllocated(this._glass);
                this._sync();
            },
        });
        this._syncText();
    }

    _applyMaterial() {
        const glass = this._glass;
        if (!glass)
            return;
        glass.setTintColor(...hexToColorArray(this._settings.get_string(this._key('tint-color'))));
        glass.setTintStrength(this._settings.get_double(this._key('tint-strength')));
        glass.setBlurRadius(this._settings.get_int(this._key('blur-radius')));
        glass.setCornerRadius(this._settings.get_double(this._key('corner-radius')));
        glass.setBrightness(this._settings.get_double(this._key('brightness')));
        glass.setContrast(this._settings.get_double(this._key('contrast')));
        glass.setSaturation(this._settings.get_double(this._key('saturation')));
    }

    _insets(kind) {
        return Object.fromEntries(SIDES.map(side => [side, this._settings.get_int(this._key(`${kind}-${side}`))]));
    }

    // The bar grows by the margin and padding so the buttons keep the theme's
    // height, and its boxes are padded to put the buttons inside the pills.
    _applyLayout() {
        if (!this._glass)
            return;
        const panel = Main.panel;
        const margin = this._margin = this._insets('margin');
        const padding = this._padding = this._insets('padding');
        const top = margin.top + padding.top, bottom = margin.bottom + padding.bottom;
        const rtl = panel.get_text_direction() === Clutter.TextDirection.RTL;
        const [first, last] = rtl ? [panel._rightBox, panel._leftBox] : [panel._leftBox, panel._rightBox];
        const islands = this._style === 'islands';
        for (const [actor, original] of this._savedStyles) {
            let style;
            if (actor === panel) {
                // A theme height caps the bar's natural height before St adds the padding;
                // without one, the padded boxes already make the bar tall enough.
                if (panel.get_theme_node().get_height() < 0)
                    continue;
                style = `padding-top: ${top}px; padding-bottom: ${bottom}px;`;
            }
            else {
                const left = actor === first ? margin.left + padding.left : islands ? padding.left : 0;
                const right = actor === last ? margin.right + padding.right : islands ? padding.right : 0;
                style = `padding: ${top}px ${right}px ${bottom}px ${left}px;`;
            }
            const own = original?.trim().replace(/;$/, '');
            actor.set_style(own ? `${own}; ${style}` : style);
        }
    }

    _syncText() {
        if (!this._glass || !this._settings.get_boolean(this._key('enable-adaptive-text-color'))) {
            this._text.clear();
            return;
        }
        this._text.start(this._settings.get_int(this._key('sample-interval-ms')), sanitizeColorPreference(this._settings.get_string(this._key('adaptive-text-preference'))));
    }

    _textRoots() {
        const panel = Main.panel;
        return [panel._leftBox, panel._centerBox, panel._rightBox].filter(box => box && box.mapped);
    }

    // The visible buttons of one of the bar's boxes, [x0, x1] in bar coordinates.
    _boxExtent(box) {
        let x0 = Infinity, x1 = -Infinity;
        const [bx] = box.get_position();
        for (const child of box.get_children()) {
            if (!child.visible || child.width < 1)
                continue;
            const alloc = child.get_allocation_box();
            x0 = Math.min(x0, bx + alloc.x1);
            x1 = Math.max(x1, bx + alloc.x2);
        }
        return x1 > x0 ? [x0, x1] : null;
    }

    // Every frame: places the glass under the bar, or hides it with the bar.
    _sync() {
        const glass = this._glass;
        const panelBox = Main.layoutManager.panelBox;
        const panel = Main.panel;
        const shown = panelBox.visible && panelBox.mapped && panel.mapped;
        if (!shown) {
            if (glass.visible)
                glass.hide();
            return;
        }
        if (!glass.visible)
            glass.show();
        glass.opacity = Math.round(panelBox.opacity * panel.opacity / 255);
        const [x, y] = panelBox.get_transformed_position();
        const width = Math.round(panelBox.width);
        const height = Math.round(panel.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || width < 1 || height < 1)
            return;
        const { top, bottom } = this._margin;
        const pillHeight = height - top - bottom;
        const left = this._margin.left, right = width - this._margin.right;
        const rects = [];
        if (this._style === 'pill') {
            rects.push([left, top, right - left, pillHeight]);
        }
        else {
            for (const box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
                const extent = this._boxExtent(box);
                if (!extent)
                    continue;
                const x0 = Math.max(extent[0] - this._padding.left, left);
                const x1 = Math.min(extent[1] + this._padding.right, right);
                if (x1 > x0)
                    rects.push([x0, top, x1 - x0, pillHeight]);
            }
        }
        const key = `${x},${y},${width},${height},${rects.flat().join(',')}`;
        if (key !== this._lastKey) {
            this._lastKey = key;
            glass.set_position(x, y);
            glass.set_size(width, height + SHADOW_ROOM);
            glass.setResolution(width, height + SHADOW_ROOM);
            const p = SHADER_PADDING;
            if (this._style === 'pill') {
                const [rx, ry, rw, rh] = rects[0];
                glass.setGlassGeometry(rx - p, ry - p, rw + p * 2, rh + p * 2);
            }
            else {
                const regions = rects.map(([rx, ry, rw, rh]) => ({
                    x: rx - p, y: ry - p, w: rw + p * 2, h: rh + p * 2, tintR: 1, tintG: 1, tintB: 1,
                }));
                glass.setGlassRegions(regions);
                glass.setGlassGeometry(0, 0, width, height);
            }
            this._text.invalidate();
        }
        glass.syncSources();
    }

    _remove() {
        stopStageLoop(this._frameSignalSlot, this._frameSlot);
        this._text.clear();
        const glass = this._glass;
        this._glass = null;
        if (glass) {
            glass.cleanup();
            // At shell shutdown the stage may have destroyed it already.
            if (isActorValid(glass))
                glass.destroy();
            Main.panel.remove_style_class_name('liquid-glass-transparent');
        }
        if (this._panelStyleId)
            Main.panel.disconnect(this._panelStyleId);
        this._panelStyleId = 0;
        for (const [actor, style] of this._savedStyles)
            if (isActorValid(actor))
                actor.set_style(style);
        this._savedStyles = [];
        this._style = 'off';
    }

    cleanup() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._remove();
    }

    get _frameSlot() {
        return { get: () => this._frameSyncId, set: (id) => { this._frameSyncId = id; } };
    }

    get _frameSignalSlot() {
        return { get: () => this._frameSignalId, set: (id) => { this._frameSignalId = id; } };
    }
}
