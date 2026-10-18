// Redraws an St.Icon from its style map with shaders/icon-style.frag: glass
// plates under a symbol, or, while a clone draws it (the launch
// animation), the icon's own picture in the style's color. In the clear look
// the plates are glass that refracts what is behind the icon (iconBackdrop.ts).
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { rectInOffscreen } from '../rendering/contentLens.js';
import { configureSamplerLayer } from '../rendering/pipelines.js';
import { splitShader } from '../rendering/shaderSource.js';
import { coglContext } from '../shellVersion.js';
import { iconStyleUniforms } from './styleColors.js';
import { MAP_SIZE } from './styleMap.js';
// The glass settings the clear look's plates are drawn with, by glass.frag's uniform names; icon-style.frag has
// each as glass_<name>.
const MATERIAL = ['max_z', 'displacement_scale', 'edge_smoothing', 'profile_shape_n', 'ior', 'chroma_strength',
    'specular_intensity', 'shininess', 'rim_width', 'rim_intensity', 'rim_directional_power', 'rim_power',
    'rim_light_color_intensity', 'sheen_intensity', 'light_angle_deg', 'ao_intensity', 'ao_radius',
    'highlight_backdrop_color', 'surface_light_enabled', 'brightness', 'contrast', 'saturation'];

/**
 * The pipeline every icon's is copied from, so that they share one program; with `glass`, the clear look's, which
 * also reads the lens map (layer 3) and what is behind the icon (layer 4).
 */
export function iconStylePipeline(source, glass = false) {
    const pipeline = Cogl.Pipeline.new(coglContext());
    configureSamplerLayer(pipeline, 0);
    pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    // The map is drawn much smaller than it is; its mipmaps keep the symbol's edges smooth.
    pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
    const layers = glass ? [2, 3, 4] : [2];
    for (const layer of layers) {
        pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
    }
    const split = splitShader(source);
    const decl = glass ? `#define LG_ICON_GLASS 1\n${split.decl}` : split.decl;
    const body = split.body;
    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d\s*;[^\n]*/g, ''), null);
    snippet.set_replace(body);
    pipeline.add_snippet(snippet);
    return pipeline;
}

/** A style map's, its tones' or its lens map's pixels (RGBA) as a texture. */
export function iconStyleTexture(data, width = MAP_SIZE, height = MAP_SIZE) {
    // Declared premultiplied so that Cogl keeps the channels as they are: they are distances, not a color.
    return Cogl.Texture2D.new_from_data(coglContext(), width, height, Cogl.PixelFormat.RGBA_8888_PRE, width * 4, data);
}

// Where an St.Icon draws its image: in a child, centerd in its content box. While the image is still
// loading the child has no size, and the square in the middle of the content box stands for it.
function imageRect(actor) {
    const image = actor.get_first_child()?.get_allocation_box();
    if (image && image.get_width() >= 1 && image.get_height() >= 1)
        return [image.x1, image.y1, image.get_width(), image.get_height()];
    const box = actor instanceof St.Widget ? actor.get_theme_node().get_content_box(actor.get_allocation_box())
        : new Clutter.ActorBox({ x1: 0, y1: 0, x2: actor.width, y2: actor.height });
    const side = Math.min(box.get_width(), box.get_height());
    return [box.x1 + (box.get_width() - side) / 2, box.y1 + (box.get_height() - side) / 2, side, side];
}

export const IconStyleEffect = GObject.registerClass(class IconStyleEffect extends Clutter.OffscreenEffect {
    _init() {
        super._init();
        this._pipeline = null;
        this._locations = new Map();
        this._values = new Map();
        this._behind = null;
        this._map = null;
        this._backdrop = null;
        this._materialSerial = -1;
    }

    /**
     * @param pipeline A copy of iconStylePipeline(), for this effect alone.
     * @param backdrop For a glass pipeline, what is behind the icon.
     */
    prepare(pipeline, textures, colors, backdrop = null) {
        this._pipeline = pipeline;
        this._locations.clear();
        this._values.clear();
        this._behind = null;
        this._map = textures.map;
        this._backdrop = backdrop;
        this._materialSerial = -1;
        pipeline.set_layer_texture(1, textures.map);
        pipeline.set_layer_texture(2, textures.tone);
        if (backdrop) {
            pipeline.set_layer_texture(3, textures.lens);
            this._setBehind(textures.map);
        }
        this.setColors(colors);
    }

    setColors(colors) {
        for (const [name, value] of iconStyleUniforms(colors))
            this._set(name, value);
        this.queue_repaint();
    }

    _set(name, value) {
        const pipeline = this._pipeline;
        if (!pipeline || this._values.get(name) === value)
            return;
        this._values.set(name, value);
        let location = this._locations.get(name);
        if (location === undefined) {
            location = pipeline.get_uniform_location(name);
            this._locations.set(name, location);
        }
        pipeline.set_uniform_1f(location, value);
    }

    _setBehind(texture) {
        if (texture === this._behind)
            return;
        this._behind = texture;
        this._pipeline.set_layer_texture(4, texture);
    }

    vfunc_paint_target(node, _paintContext) {
        const texture = this.get_texture();
        const pipeline = this._pipeline;
        if (!texture || !pipeline)
            return;
        const actor = this.get_actor();
        const image = imageRect(actor);
        const at = rectInOffscreen(actor, image);
        if (!at)
            return;
        const [x0, y0, x1, y1] = at.box;
        this._set('box_x0', x0);
        this._set('box_y0', y0);
        this._set('box_x1', x1);
        this._set('box_y1', y1);
        // The offscreen is in the actor's px, which its scale enlarges on screen.
        this._set('map_px', MAP_SIZE / Math.max((x1 - x0) * texture.get_width() * actor.scale_x, 1));
        this._set('clone', actor.is_in_clone_paint() ? 1 : 0);
        this._set('opacity', actor.get_paint_opacity() / 255);
        if (this._backdrop)
            this._bindBackdrop(this._backdrop, actor, image);
        pipeline.set_layer_texture(0, texture);
        const drawNode = Clutter.PipelineNode.new(pipeline);
        node.add_child(drawNode);
        drawNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texture.get_width(), y2: texture.get_height() }));
    }

    // Where the icon's square is in what is behind it, or the look without glass while that is not known there:
    // before it is first copied, and while the icon is drawn away from it (being dragged). An icon partly off the
    // screen, where the copy stops, reads its edge.
    _bindBackdrop(backdrop, actor, [x, y, w, h]) {
        const current = backdrop.current();
        // Icons are only moved and scaled, so their extents on the stage say where the image is.
        const ext = actor.get_transformed_extents();
        const kx = ext.get_width() / Math.max(actor.get_width(), 1), ky = ext.get_height() / Math.max(actor.get_height(), 1);
        const sx0 = ext.get_x() + x * kx, sy0 = ext.get_y() + y * ky, sx1 = sx0 + w * kx, sy1 = sy0 + h * ky;
        const r = current?.rect;
        const ready = !!r && sx0 < r[2] && sy0 < r[3] && sx1 > r[0] && sy1 > r[1] && sx1 - sx0 >= 1;
        this._set('glass_ready', ready ? 1 : 0);
        if (!ready) {
            this._setBehind(this._map);
            return;
        }
        const [rx0, ry0, rx1, ry1] = r;
        this._set('bd_x0', (sx0 - rx0) / (rx1 - rx0));
        this._set('bd_y0', (sy0 - ry0) / (ry1 - ry0));
        this._set('bd_x1', (sx1 - rx0) / (rx1 - rx0));
        this._set('bd_y1', (sy1 - ry0) / (ry1 - ry0));
        this._set('box_w_px', sx1 - sx0);
        this._set('box_h_px', sy1 - sy0);
        this._set('bd_w_px', rx1 - rx0);
        this._set('bd_h_px', ry1 - ry0);
        this._set('bd_tex_w', current.texture.get_width());
        this._set('bd_tex_h', current.texture.get_height());
        this._setBehind(current.texture);
        if (backdrop.materialSerial === this._materialSerial)
            return;
        this._materialSerial = backdrop.materialSerial;
        const material = backdrop.material();
        for (const name of MATERIAL)
            this._set(`glass_${name}`, material.get(name) ?? 0);
    }
});
