import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
// What differs between the supported GNOME Shell versions (46 to 51).
export const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);
// PopupMenu.open() and close() take {animate} from GNOME 51 on, and a
// BoxPointer.PopupAnimation (0 for none) before.
export const MENU_NO_ANIMATION = SHELL_MAJOR >= 51 ? { animate: false } : 0;
// BoxPointer.PopupAnimation.FULL is ~0.
export const MENU_ANIMATION = SHELL_MAJOR >= 51 ? { animate: true } : ~0;
// GNOME 51 has no Clutter.get_default_backend(); the stage's context, which
// the shell itself uses from 48 on, does not exist in 46.
export function coglContext() {
    const backend = SHELL_MAJOR >= 48
        ? global.stage.context.get_backend()
        : Clutter.get_default_backend();
    return backend.get_cogl_context();
}
// A RootNode that draws into `framebuffer` and does not clear it. The color
// state argument came with GNOME 48; before, the clear color was a Cogl.Color
// (47) or a Clutter.Color (46). `colorState` is unused before 48.
export function newRootNode(framebuffer, colorState) {
    if (SHELL_MAJOR >= 48)
        return Clutter.RootNode.new(framebuffer, colorState, new Cogl.Color(), 0);
    const clearColor = SHELL_MAJOR >= 47 ? new Cogl.Color() : new Clutter.Color();
    return Clutter.RootNode.new(framebuffer, clearColor, 0);
}
// A snapshot of the stage rect `rect` at `scale`, without the cursor. GNOME 50
// added the color state to paint in, which is the stage's when null.
export function paintStageToContent(rect, scale) {
    if (SHELL_MAJOR >= 50)
        return global.stage.paint_to_content(rect, scale, null, Clutter.PaintFlag.NO_CURSORS);
    return global.stage.paint_to_content(rect, scale, Clutter.PaintFlag.NO_CURSORS);
}
// The pixel format of an offscreen's texture, for a texture its pixels are
// blitted into. GNOME 46 cannot report it, but every offscreen it draws the
// stage or an effect into has the default format, which null stands for.
export function offscreenFormat(framebuffer) {
    return SHELL_MAJOR >= 47 ? framebuffer.get_texture().get_format() : null;
}
// The accent color and its foreground, or null where St has none (GNOME 46).
export function accentColors() {
    if (SHELL_MAJOR < 47)
        return null;
    const [accent, accentFg] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
    return accent && accentFg ? [accent, accentFg] : null;
}
// Calls `callback` whenever the accent color changes; returns what stops that. GNOME 46 has none.
export function watchAccentColor(callback) {
    if (SHELL_MAJOR < 47)
        return () => { };
    const context = St.ThemeContext.get_for_stage(global.stage);
    const id = context.connect('notify::accent-color', callback);
    return () => context.disconnect(id);
}
// Until mutter 46.3.1, which Ubuntu 24.04 does not have, a Clutter.Clone
// scaled its whole transform by its size over its source's, not only what it
// paints. A paint volume set in the clone's own coordinates is then scaled too.
// Divides that scale back out of `volume`; it is 1 with any later mutter.
export function undoCloneScale(clone, volume) {
    if (SHELL_MAJOR >= 47)
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
export function verticalBoxParams() {
    return SHELL_MAJOR >= 48 ? { orientation: Clutter.Orientation.VERTICAL } : { vertical: true };
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
export function setHoverCursor(actor, shape) {
    if (SHELL_MAJOR >= 50) {
        actor.set_cursor_type(Clutter.CursorType[CLUTTER_CURSORS[shape]]);
        return;
    }
    const cursor = Meta.Cursor[META_CURSORS[shape]];
    actor.connect('enter-event', () => {
        global.display.set_cursor(cursor);
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', () => {
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        return Clutter.EVENT_PROPAGATE;
    });
}
// The pointer's own cursor again, for when actors given one by
// setHoverCursor() go away under it (GNOME 49 and older).
export function resetHoverCursor() {
    if (SHELL_MAJOR < 50)
        global.display.set_cursor(Meta.Cursor.DEFAULT);
}
// The Quick Settings toggle with a menu arrow: `.quick-menu-toggle` until
// GNOME 47, `.quick-toggle-has-menu` from 48 on.
export const QS_MENU_TOGGLE_CLASS = SHELL_MAJOR >= 48 ? 'quick-toggle-has-menu' : 'quick-menu-toggle';
// On GNOME 46 a notification banner with a zero-width border is stretched
// across the monitor and its content gets no width, so there the banner's
// border is only made transparent.
export const BANNER_TRANSPARENT_CLASS = SHELL_MAJOR >= 47
    ? 'liquid-glass-transparent' : 'liquid-glass-transparent-keep-border';
// Cogl.Pipeline.set_uniform_float() takes its values as an array from GNOME 48
// on. Before, the binding passes a single float where the call expects a
// pointer, which crashes the shell, so only set_uniform_1f() is usable there:
// arrays are set one element at a time and vectors are declared as one float
// per component (see uniformDeclarations()).
const UNIFORM_ARRAYS = SHELL_MAJOR >= 48;
// Sets `name`, a float array uniform (`uniform float name[N]`) whose location
// is `location`.
export function setUniformArray(pipeline, location, name, values) {
    if (UNIFORM_ARRAYS) {
        pipeline.set_uniform_float(location, 1, values.length, values);
        return;
    }
    for (let i = 0; i < values.length; i++)
        pipeline.set_uniform_1f(pipeline.get_uniform_location(`${name}[${i}]`), values[i]);
}
// Sets `name`, a vec2, vec3 or vec4 uniform.
export function setUniformVector(pipeline, name, values) {
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
export function uniformDeclarations(decl) {
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
export function paintNodeWithContext(klass) {
    if (SHELL_MAJOR >= 47)
        return klass;
    const proto = klass.prototype;
    const paintNode = proto.vfunc_paint_node;
    delete proto.vfunc_paint_node;
    const parentPaint = Object.getPrototypeOf(proto).vfunc_paint;
    proto.vfunc_paint = function (paintContext) {
        // A ClipNode without rectangles changes nothing; it only groups.
        const root = Clutter.ClipNode.new();
        paintNode.call(this, root, paintContext);
        root.paint(paintContext);
        parentPaint.call(this, paintContext);
    };
    return klass;
}
