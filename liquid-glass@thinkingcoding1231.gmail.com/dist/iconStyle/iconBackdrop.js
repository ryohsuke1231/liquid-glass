"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconBackdrop = void 0;
// What is behind the icons of one dock, app grid, folder or launcher, for the
// glass of clear icons (iconEffect.ts). It is copied from the stage once for
// all of them, just before the actor that holds them is painted, so it holds
// that surface's own glass, and blurred once. Relays (relays.ts) redraw the
// whole copied area whenever anything behind it changes, so the copy follows
// a backdrop that moves or plays.
const 4 = __importDefault(require("gi://Clutter"));
const 5 = __importDefault(require("gi://Gio"));
const 6 = __importDefault(require("gi://GLib"));
const 7 = __importDefault(require("gi://GObject"));
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const frameLoops_js_1 = require("../animation/frameLoops.js");
const glassRenderer_js_1 = require("../rendering/glassRenderer.js");
const relays_js_1 = require("../rendering/relays.js");
const stageCopy_js_1 = require("../rendering/stageCopy.js");
const shellVersion_js_1 = require("../shellVersion.js");
const EFFECT_NAME = 'liquid-glass-icon-backdrop';
// Room (px) around the icons for the samples spread around each pixel.
const MARGIN = 8;
// The copy's size is rounded up to this (px), so that icons coming and going do not make new textures every frame.
const QUANTUM = 32;
exports.IconBackdrop = 7.default.registerClass(class IconBackdrop extends 4.default.Effect {
    _init(params) {
        super._init();
        this._params = params;
        this._host = null;
        this._relays = null;
        this._loaded = false;
        this._shaderLoad = new 5.default.Cancellable();
        this._mapId = 0;
        this._signalId = 0;
        this._firstId = 0;
        this._signalSlot = { get: () => this._signalId, set: id => { this._signalId = id; } };
        this._firstSlot = { get: () => this._firstId, set: id => { this._firstId = id; } };
        this._area = null;
        this._paintedRect = null;
        this._serialAtMap = 0;
        this.materialSerial = 0;
        this._copier = new stageCopy_js_1.StageCopier(params.logger);
        this._renderer = new glassRenderer_js_1.GlassRenderer({
            settings: params.settings, logger: params.logger, repaint: () => this._materialChanged(), setDiagnostics: () => { },
        });
        this._holder = (0, relays_js_1.relayHolder)();
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
            if (!(e instanceof 6.default.Error && e.matches(5.default.IOErrorEnum, 5.default.IOErrorEnum.CANCELLED)))
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
        this._relays = new relays_js_1.RelaySet(host, () => false, this._holder);
        this._mapId = host.connect('notify::mapped', () => this._syncMapped());
        this._syncMapped();
    }
    _syncMapped() {
        if (!this._host?.mapped) {
            (0, frameLoops_js_1.stopStageLoop)(this._signalSlot, this._firstSlot);
            this._holder.hide();
            this._area = null;
            this._paintedRect = null;
            return;
        }
        this._serialAtMap = this._copier.lastCopy?.serial ?? 0;
        (0, frameLoops_js_1.startSyncLoop)(this._signalSlot, this._firstSlot, {
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
        const m = relays_js_1.SAMPLE_MARGIN;
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
        const ctx = (0, shellVersion_js_1.coglContext)();
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
        (0, frameLoops_js_1.stopStageLoop)(this._signalSlot, this._firstSlot);
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
