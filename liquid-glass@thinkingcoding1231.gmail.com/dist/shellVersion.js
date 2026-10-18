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
exports.BANNER_TRANSPARENT_CLASS = exports.QS_MENU_TOGGLE_CLASS = exports.MENU_ANIMATION = exports.MENU_NO_ANIMATION = exports.SHELL_MAJOR = void 0;
exports.coglContext = coglContext;
exports.newRootNode = newRootNode;
exports.paintStageToContent = paintStageToContent;
exports.offscreenFormat = offscreenFormat;
exports.accentColors = accentColors;
exports.watchAccentColor = watchAccentColor;
exports.undoCloneScale = undoCloneScale;
exports.verticalBoxParams = verticalBoxParams;
exports.setHoverCursor = setHoverCursor;
exports.resetHoverCursor = resetHoverCursor;
exports.setUniformArray = setUniformArray;
exports.setUniformVector = setUniformVector;
exports.uniformDeclarations = uniformDeclarations;
exports.paintNodeWithContext = paintNodeWithContext;
const 1 = __importDefault(require("gi://Clutter"));
const 2 = __importDefault(require("gi://Cogl"));
const 3 = __importDefault(require("gi://Meta"));
const 4 = __importDefault(require("gi://St"));
const Config = __importStar(require("resource:///org/gnome/shell/misc/config.js"));
// What differs between the supported GNOME Shell versions (46 to 51).
exports.SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);
// PopupMenu.open() and close() take {animate} from GNOME 51 on, and a
// BoxPointer.PopupAnimation (0 for none) before.
exports.MENU_NO_ANIMATION = exports.SHELL_MAJOR >= 51 ? { animate: false } : 0;
// BoxPointer.PopupAnimation.FULL is ~0.
exports.MENU_ANIMATION = exports.SHELL_MAJOR >= 51 ? { animate: true } : ~0;
// GNOME 51 has no Clutter.get_default_backend(); the stage's context, which
// the shell itself uses from 48 on, does not exist in 46.

function coglContext() {
    const backend = exports.SHELL_MAJOR >= 48
        ? global.stage.context.get_backend()
        : 1.default.get_default_backend();
    return backend.get_cogl_context();
}
// A RootNode that draws into `framebuffer` and does not clear it. The color
// state argument came with GNOME 48; before, the clear color was a Cogl.Color
// (47) or a Clutter.Color (46). `colorState` is unused before 48.

function newRootNode(framebuffer, colorState) {
    if (exports.SHELL_MAJOR >= 48)
        return 1.default.RootNode.new(framebuffer, colorState, new 2.default.Color(), 0);
    const clearColor = exports.SHELL_MAJOR >= 47 ? new 2.default.Color() : new 1.default.Color();
    return 1.default.RootNode.new(framebuffer, clearColor, 0);
}
// A snapshot of the stage rect `rect` at `scale`, without the cursor. GNOME 50
// added the color state to paint in, which is the stage's when null.

function paintStageToContent(rect, scale) {
    if (exports.SHELL_MAJOR >= 50)
        return global.stage.paint_to_content(rect, scale, null, 1.default.PaintFlag.NO_CURSORS);
    return global.stage.paint_to_content(rect, scale, 1.default.PaintFlag.NO_CURSORS);
}
// The pixel format of an offscreen's texture, for a texture its pixels are
// blitted into. GNOME 46 cannot report it, but every offscreen it draws the
// stage or an effect into has the default format, which null stands for.

function offscreenFormat(framebuffer) {
    return exports.SHELL_MAJOR >= 47 ? framebuffer.get_texture().get_format() : null;
}
// The accent color and its foreground, or null where St has none (GNOME 46).

function accentColors() {
    if (exports.SHELL_MAJOR < 47)
        return null;
    const [accent, accentFg] = 4.default.ThemeContext.get_for_stage(global.stage).get_accent_color();
    return accent && accentFg ? [accent, accentFg] : null;
}
// Calls `callback` whenever the accent color changes; returns what stops that. GNOME 46 has none.

function watchAccentColor(callback) {
    if (exports.SHELL_MAJOR < 47)
        return () => { };
    const context = 4.default.ThemeContext.get_for_stage(global.stage);
    const id = context.connect('notify::accent-color', callback);
    return () => context.disconnect(id);
}
// Until mutter 46.3.1, which Ubuntu 24.04 does not have, a Clutter.Clone
// scaled its whole transform by its size over its source's, not only what it
// paints. A paint volume set in the clone's own coordinates is then scaled too.
// Divides that scale back out of `volume`; it is 1 with any later mutter.

function undoCloneScale(clone, volume) {
    if (exports.SHELL_MAJOR >= 47)
        return;
    const transform = clone.get_transform();
    const sx = transform.get_x_scale();
    const sy = transform.get_y_scale();
    if (sx > 0 && sy > 0 && (sx !== 1 || sy !== 1)) {
        volume.set_width(volume.get_width() / sx);
        volume.set_height(volume.get_height() / sy);
    }
}
// The properties that make an St.BoxLayout stack its children vertically:
// `orientation` from GNOME 48 on; before, `vertical`, which GNOME 51 removed.

function verticalBoxParams() {
    return exports.SHELL_MAJOR >= 48 ? { orientation: 1.default.Orientation.VERTICAL } : { vertical: true };
}
const CLUTTER_CURSORS = {
    n: 'N_RESIZE', s: 'S_RESIZE', e: 'E_RESIZE', w: 'W_RESIZE',
    ne: 'NE_RESIZE', nw: 'NW_RESIZE', se: 'SE_RESIZE', sw: 'SW_RESIZE', move: 'MOVE',
};
const META_CURSORS = {
    n: 'NORTH_RESIZE', s: 'SOUTH_RESIZE', e: 'EAST_RESIZE', w: 'WEST_RESIZE',
    ne: 'NE_RESIZE', nw: 'NW_RESIZE', se: 'SE_RESIZE', sw: 'SW_RESIZE', move: 'MOVE_OR_RESIZE_WINDOW',
};
// Shows `shape` while the pointer is over `actor`. From GNOME 50 on an actor
// has a cursor of its own; before, the display's cursor is set on entering it.

function setHoverCursor(actor, shape) {
    if (exports.SHELL_MAJOR >= 50) {
        actor.set_cursor_type(1.default.CursorType[CLUTTER_CURSORS[shape]]);
        return;
    }
    const cursor = 3.default.Cursor[META_CURSORS[shape]];
    actor.connect('enter-event', () => {
        global.display.set_cursor(cursor);
        return 1.default.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', () => {
        global.display.set_cursor(3.default.Cursor.DEFAULT);
        return 1.default.EVENT_PROPAGATE;
    });
}
// The pointer's own cursor again, for when actors given one by
// setHoverCursor() go away under it (GNOME 49 and older).

function resetHoverCursor() {
    if (exports.SHELL_MAJOR < 50)
        global.display.set_cursor(3.default.Cursor.DEFAULT);
}
// The Quick Settings toggle with a menu arrow: `.quick-menu-toggle` until
// GNOME 47, `.quick-toggle-has-menu` from 48 on.
exports.QS_MENU_TOGGLE_CLASS = exports.SHELL_MAJOR >= 48 ? 'quick-toggle-has-menu' : 'quick-menu-toggle';
// On GNOME 46 a notification banner with a zero-width border is stretched
// across the monitor and its content gets no width, so there the banner's
// border is only made transparent.
exports.BANNER_TRANSPARENT_CLASS = exports.SHELL_MAJOR >= 47
    ? 'liquid-glass-transparent' : 'liquid-glass-transparent-keep-border';
// Cogl.Pipeline.set_uniform_float() takes its values as an array from GNOME 48
// on. Before, the binding passes a single float where the call expects a
// pointer, which crashes the shell, so only set_uniform_1f() is usable there:
// arrays are set one element at a time and vectors are declared as one float
// per component (see uniformDeclarations()).
const UNIFORM_ARRAYS = exports.SHELL_MAJOR >= 48;
// Sets `name`, a float array uniform (`uniform float name[N]`) whose location
// is `location`.

function setUniformArray(pipeline, location, name, values) {
    if (UNIFORM_ARRAYS) {
        pipeline.set_uniform_float(location, 1, values.length, values);
        return;
    }
    for (let i = 0; i < values.length; i++)
        pipeline.set_uniform_1f(pipeline.get_uniform_location(`${name}[${i}]`), values[i]);
}
// Sets `name`, a vec2, vec3 or vec4 uniform.

function setUniformVector(pipeline, name, values) {
    if (UNIFORM_ARRAYS) {
        pipeline.set_uniform_float(pipeline.get_uniform_location(name), values.length, 1, values);
        return;
    }
    for (let i = 0; i < values.length; i++)
        pipeline.set_uniform_1f(pipeline.get_uniform_location(`${name}_${i}`), values[i]);
}
// A snippet's declarations as this version can set them: before GNOME 48 each
// `uniform vecN name;` becomes N float uniforms and a macro that rebuilds the
// vector, so the shader code itself is unchanged.

function uniformDeclarations(decl) {
    if (UNIFORM_ARRAYS)
        return decl;
    return decl.replace(/uniform\s+vec([234])\s+(\w+)\s*;/g, (_match, size, name) => {
        const parts = Array.from({ length: Number(size) }, (_unused, i) => `${name}_${i}`);
        return `uniform float ${parts.join(', ')};\n#define ${name} vec${size}(${parts.join(', ')})\n`;
    });
}
// GNOME 46 calls Clutter.Actor's paint_node vfunc without the paint context,
// which these actors need. There the class draws from the paint vfunc, which
// has it: paint_node fills a node of its own that is painted at once, as
// Clutter does with the node it passes, and then the children are painted.
// Applied to the class before GObject.registerClass().

function paintNodeWithContext(klass) {
    if (exports.SHELL_MAJOR >= 47)
        return klass;
    const proto = klass.prototype;
    const paintNode = proto.vfunc_paint_node;
    delete proto.vfunc_paint_node;
    const parentPaint = Object.getPrototypeOf(proto).vfunc_paint;
    proto.vfunc_paint = function (paintContext) {
        // A ClipNode without rectangles changes nothing; it only groups.
        const root = 1.default.ClipNode.new();
        paintNode.call(this, root, paintContext);
        root.paint(paintContext);
        parentPaint.call(this, paintContext);
    };
    return klass;
}
