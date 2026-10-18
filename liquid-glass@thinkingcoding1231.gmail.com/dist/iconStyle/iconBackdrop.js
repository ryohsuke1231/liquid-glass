// What is behind the icons of one dock, app grid, folder or launcher, for the
// glass of clear icons (iconEffect.ts). It is copied from the stage once for
// all of them, just before the actor that holds them is painted, so it holds
// that surface's own glass, and blurred once. Relays (relays.ts) redraw the
// whole copied area whenever anything behind it changes, so the copy follows
// a backdrop that moves or plays.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { startSyncLoop, stopStageLoop } from '../animation/frameLoops.js';
import { GlassRenderer } from '../rendering/glassRenderer.js';
import { RelaySet, SAMPLE_MARGIN, relayHolder } from '../rendering/relays.js';
import { StageCopier } from '../rendering/stageCopy.js';
import { coglContext } from '../shellVersion.js';
const EFFECT_NAME = 'liquid-glass-icon-backdrop';
// Room (px) around the icons for the samples spread around each pixel.
const MARGIN = 8;
// The copy's size is rounded up to this (px), so that icons coming and going do not make new textures every frame.
const QUANTUM = 32;

export const IconBackdrop = GObject.registerClass(class IconBackdrop extends Clutter.Effect {
    _init(params) {
        super._init();
        this._params = params;
        this._host = null;
        this._relays = null;
        this._loaded = false;
        this._shaderLoad = new Gio.Cancellable();
        this._mapId = 0;
        this._signalId = 0;
        this._firstId = 0;
        this._signalSlot = { get: () => this._signalId, set: id => { this._signalId = id; } };
        this._firstSlot = { get: () => this._firstId, set: id => { this._firstId = id; } };
        this._area = null;
        this._paintedRect = null;
        this._serialAtMap = 0;
        this.materialSerial = 0;
        this._copier = new StageCopier(params.logger);
        this._renderer = new GlassRenderer({
            settings: params.settings, logger: params.logger, repaint: () => this._materialChanged(), setDiagnostics: () => { },
        });
        this._holder = relayHolder();
        this._holder.hide();
        Main.layoutManager.uiGroup.add_child(this._holder);
        const prefix = params.prefix;
        const s = params.settings;
        const apply = () => {
            this._renderer.setBlurRadius(s.get_int(`${prefix}-blur-radius`));
            this._renderer.setBrightness(s.get_double(`${prefix}-brightness`));
            this._renderer.setContrast(s.get_double(`${prefix}-contrast`));
            this._renderer.setSaturation(s.get_double(`${prefix}-saturation`));
        };
        this._settingsIds = ['blur-radius', 'brightness', 'contrast', 'saturation']
            .map(key => s.connect(`changed::${prefix}-${key}`, apply));
        apply();
        this._loadShaders();
    }

    async _loadShaders() {
        try {
            await this._renderer.pipelines.load(this._params.extensionPath, this._shaderLoad);
        }
        catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                this._params.logger.error(`[Liquid Glass] Failed to load the icon glass's shaders: ${e}`);
            return;
        }
        this._loaded = true;
        // The relays are hidden until now, so the host is what asks for the frame that copies.
        this._host?.queue_redraw();
    }

    /** Goes on `host`, the actor painted right over what the icons' glass shows. */
    attach(host) {
        this._host = host;
        host.add_effect_with_name(EFFECT_NAME, this);
        this._relays = new RelaySet(host, () => false, this._holder);
        this._mapId = host.connect('notify::mapped', () => this._syncMapped());
        this._syncMapped();
    }

    _syncMapped() {
        if (!this._host?.mapped) {
            stopStageLoop(this._signalSlot, this._firstSlot);
            this._holder.hide();
            this._area = null;
            this._paintedRect = null;
            return;
        }
        this._serialAtMap = this._copier.lastCopy?.serial ?? 0;
        startSyncLoop(this._signalSlot, this._firstSlot, {
            alive: () => !!this._host?.mapped,
            honourFreeze: true,
            errorTag: 'IconBackdrop',
            step: () => this._sync(),
        });
    }

    // The rect to copy, [x0, y0, x1, y1] on the stage: around the icons, inside the host, which leaves out the
    // icons of an app grid's other pages. Inside the host, a redraw of the host redraws all of it.
    _rect() {
        const r = this._params.rect();
        const box = this._host?.get_transformed_extents();
        if (!r || !box)
            return null;
        const [bx0, by0] = [Math.floor(box.get_x()), Math.floor(box.get_y())];
        const [bx1, by1] = [Math.ceil(box.get_x() + box.get_width()), Math.ceil(box.get_y() + box.get_height())];
        const x0 = Math.max(Math.floor(r[0] - MARGIN), bx0), y0 = Math.max(Math.floor(r[1] - MARGIN), by0);
        const x1 = Math.min(x0 + Math.ceil((r[2] + MARGIN - x0) / QUANTUM) * QUANTUM, bx1);
        const y1 = Math.min(y0 + Math.ceil((r[3] + MARGIN - y0) / QUANTUM) * QUANTUM, by1);
        return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1, y1] : null;
    }

    // Before every frame: the relays follow what is behind the icons, and the area is redrawn whole when it moves,
    // so that the copy is taken again in that frame.
    _sync() {
        const rect = this._loaded ? this._paintedRect ?? this._rect() : null;
        const relays = this._relays;
        if (!rect || !relays) {
            if (this._holder.visible)
                this._holder.hide();
            this._area = null;
            return;
        }
        if (!this._holder.visible)
            this._holder.show();
        const m = SAMPLE_MARGIN;
        const area = [rect[0] - m, rect[1] - m, rect[2] - rect[0] + 2 * m, rect[3] - rect[1] + 2 * m];
        const moved = !this._area || area.some((v, i) => v !== this._area[i]);
        this._area = area;
        if (relays.sync(area) || moved)
            relays.redrawArea();
        this._copier.prune(this._host.peek_stage_views());
    }

    vfunc_pre_paint(node, paintContext) {
        const host = this._host;
        const rect = host && this._loaded ? this._rect() : null;
        this._paintedRect = rect;
        if (!host || !rect)
            return true;
        const ctx = coglContext();
        this._renderer.prepare(ctx);
        const serial = this._copier.lastCopy?.serial;
        const { copy, missed } = this._copier.take(host, node, paintContext, rect);
        // Nothing to draw with yet; the next frame redraws the whole area. The relays may not be shown yet.
        if (missed)
            host.queue_redraw();
        if (copy && copy.serial !== serial)
            this._params.copied();
        const blur = this._renderer.blur;
        if (!copy?.rect || blur.passCount <= 0)
            return true;
        const w = Math.max(1, Math.round(copy.rect[2] - copy.rect[0]));
        const h = Math.max(1, Math.round(copy.rect[3] - copy.rect[1]));
        const key = [copy.texture, copy.serial];
        if (blur.width === w && blur.height === h && blur.canReuse(key))
            return true;
        if (blur.width !== w || blur.height !== h)
            blur.resize(ctx, w, h);
        if (blur.ready)
            blur.render(node, copy.texture, [0, 0, 1, 1], key);
        return true;
    }

    /** What is behind the icons now, or null until it has been copied since the host was last shown. */
    current() {
        const copy = this._copier.lastCopy;
        if (!copy?.rect || copy.serial <= this._serialAtMap)
            return null;
        const blur = this._renderer.blur;
        return { texture: blur.passCount > 0 && blur.result ? blur.result : copy.texture, rect: copy.rect };
    }

    /** The glass settings and this surface's color adjustments, by glass.frag's uniform names. */
    material() {
        return this._renderer.uniforms.values;
    }

    _materialChanged() {
        this.materialSerial++;
        this._host?.queue_redraw();
    }

    cleanup() {
        stopStageLoop(this._signalSlot, this._firstSlot);
        this._shaderLoad.cancel();
        for (const id of this._settingsIds)
            this._params.settings.disconnect(id);
        this._settingsIds = [];
        if (this._host && this._mapId)
            this._host.disconnect(this._mapId);
        this._mapId = 0;
        this.get_actor()?.remove_effect(this);
        this._host = null;
        this._relays?.clear();
        this._relays = null;
        this._holder.destroy();
        this._copier.clear();
        this._renderer.cleanup();
    }
});
