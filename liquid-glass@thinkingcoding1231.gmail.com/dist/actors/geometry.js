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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllocatedSize = getAllocatedSize;
exports.getTransformedRect = getTransformedRect;
exports.resolveMonitorGeometry = resolveMonitorGeometry;
const Main = __importStar(require("resource:///org/gnome/shell/ui/main.js"));
const lifecycle_js_1 = require("./lifecycle.js");
/**
 * An actor's allocated size. get_size() falls back to the preferred size
 * while a relayout is pending, which the per-frame syncs run into all the
 * time, and an actor sized by constraints prefers 0x0.
 */

function getAllocatedSize(actor) {
    const box = actor.get_allocation_box();
    const w = box.get_width();
    const h = box.get_height();
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
        return [w, h];
    // Not allocated yet.
    const [sw, sh] = actor.get_size();
    return [sw, sh];
}
/**
 * An actor's on-screen rectangle [x, y, w, h] with every ancestor transform
 * applied. Pairing get_transformed_position() with a size is wrong while an
 * ancestor is scaled (menu open animations, window resizes): the origin is
 * transformed but the size is not. Use this for rects in screen space only.
 */

function getTransformedRect(actor) {
    const r = actor.get_transformed_extents();
    const x = r.origin.x, y = r.origin.y;
    const w = r.size.width, h = r.size.height;
    if (Number.isFinite(x) && Number.isFinite(y) &&
        Number.isFinite(w) && Number.isFinite(h))
        return [x, y, w, h];
    const [px, py] = actor.get_transformed_position();
    const [aw, ah] = getAllocatedSize(actor);
    return [px, py, aw, ah];
}

function resolveMonitorGeometry(candidates) {
    const layoutManager = Main.layoutManager;
    for (const actor of candidates) {
        if (!actor || !(0, lifecycle_js_1.isActorValid)(actor))
            continue;
        const [width, height] = actor.get_size();
        if (!(width > 0 && height > 0))
            continue;
        const index = layoutManager.findIndexForActor(actor);
        if (index >= 0)
            return layoutManager.monitors[index] || layoutManager.primaryMonitor;
    }
    return layoutManager.monitors[layoutManager.primaryIndex] || layoutManager.primaryMonitor;
}
