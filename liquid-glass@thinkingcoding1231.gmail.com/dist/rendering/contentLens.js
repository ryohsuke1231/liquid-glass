// A menu's items seen through the glass they sit in while it changes shape:
// cut to its rounded outline and, when they are deep in it, refracted by its
// rim the way the glass refracts what is behind it. At no depth it only cuts
// round corners (the media card's cover art).
//
// Note: this implementation is inspired by and adapted from:
// https://github.com/AndrewPrifer/liquid-dom
// Big thanks to the original author (@AndrewPrifer) for the elegant solution.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import { coglContext, setUniformVector, uniformDeclarations } from '../shellVersion.js';
import { configureSamplerLayer } from './pipelines.js';
const DECL = `
// The glass's box in the offscreen (texture coordinates), and px on screen per
// texture width and height.
uniform vec4 lens_box;
uniform vec2 lens_px;
uniform float lens_radius;
uniform float lens_band;
uniform float lens_depth;
uniform float lens_ior;
uniform float lens_opacity;

float lensBox(vec2 p) {
    vec2 q = abs(p) - (lens_box.zw - lens_box.xy) * lens_px * 0.5 + lens_radius;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - lens_radius;
}

// A round rim rising over lens_band px from the outline, flat inside it.
float lensHeight(vec2 p) {
    float t = clamp(-lensBox(p) / lens_band, 0.0, 1.0);
    return sqrt(1.0 - (1.0 - t) * (1.0 - t)) * lens_band;
}
`;
const BODY = `
vec2 uv = cogl_tex_coord_in[0].st;
vec2 p = (uv - (lens_box.xy + lens_box.zw) * 0.5) * lens_px;
vec2 slope = vec2(lensHeight(p + vec2(0.5, 0.0)) - lensHeight(p - vec2(0.5, 0.0)),
                  lensHeight(p + vec2(0.0, 0.5)) - lensHeight(p - vec2(0.0, 0.5)));
vec3 ray = refract(vec3(0.0, 0.0, -1.0), normalize(vec3(-slope, 1.0)), 1.0 / max(lens_ior, 1.001));
vec2 shift = ray.xy / max(-ray.z, 0.15) * lens_depth;
vec4 color = texture2D(cogl_sampler0, clamp(uv + shift / lens_px, lens_box.xy, lens_box.zw));
float inside = 1.0 - smoothstep(-0.5, 0.5, lensBox(p));
cogl_color_out = color * (lens_opacity * inside);
`;
// liquid-dom's showcase menu: content 80 px deep in glass of index 1.5 under a
// 70 px rim.
const DEPTH = 80;
const IOR = 1.5;
const BAND = 70;

/**
 * Where `rect` [x, y, w, h] (the actor's own px) is in an offscreen effect's
 * texture, as texture coordinates [x0, y0, x1, y1], and the size of what the
 * texture covers. The texture covers the actor's paint volume as
 * _clutter_actor_box_enlarge_for_effects() pads it.
 */
export function rectInOffscreen(actor, rect) {
    const volume = actor.get_paint_volume();
    if (!volume)
        return null;
    const origin = volume.get_origin();
    const w = Math.round(volume.get_width()) + 3, h = Math.round(volume.get_height()) + 3;
    const x0 = Math.ceil(origin.x + volume.get_width() + 0.75) - w;
    const y0 = Math.ceil(origin.y + volume.get_height() + 0.75) - h;
    const [cx, cy, cw, ch] = rect;
    return { box: [(cx - x0) / w, (cy - y0) / h, (cx + cw - x0) / w, (cy + ch - y0) / h], width: w, height: h };
}

/** Put on the actor that holds the items, clipped to the glass's box. */
export const ContentLens = GObject.registerClass(class ContentLens extends Clutter.OffscreenEffect {
    _init() {
        super._init();
        this._pipeline = null;
        this._uniforms = { box: [0, 0, 1, 1], px: [1, 1], radius: 0, band: 1, depth: 0, ior: IOR };
        this._clip = [0, 0, 1, 1];
        this._scale = 1;
    }

    // Draws the offscreen as ClutterOffscreenEffect does, through the lens.
    vfunc_paint_target(node, _paintContext) {
        const texture = this.get_texture();
        if (!texture)
            return;
        if (!this._pipeline) {
            this._pipeline = Cogl.Pipeline.new(coglContext());
            configureSamplerLayer(this._pipeline, 0);
            const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(DECL), null);
            snippet.set_replace(BODY);
            this._pipeline.add_snippet(snippet);
            this._apply();
        }
        this._locate();
        const pipeline = this._pipeline;
        pipeline.set_layer_texture(0, texture);
        pipeline.set_uniform_1f(pipeline.get_uniform_location('lens_opacity'), this.get_actor().get_paint_opacity() / 255);
        const drawNode = Clutter.PipelineNode.new(pipeline);
        node.add_child(drawNode);
        drawNode.add_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: texture.get_width(), y2: texture.get_height() }));
    }

    /**
     * The glass is `clip` [x, y, w, h] in the actor's own px, which are
     * `scale` px on screen, with corners of `radius` (on screen). `depth` (0
     * to 1) is how deep in it the content looks.
     */
    shape(clip, scale, radius, depth) {
        const u = this._uniforms;
        this._clip = clip;
        this._scale = scale;
        const half = Math.min(clip[2], clip[3]) * scale / 2;
        u.radius = Math.min(Math.max(radius, 0), half);
        u.band = Math.max(Math.min(BAND, half), 1);
        u.depth = DEPTH * depth;
        u.ior = 1 + (IOR - 1) * depth;
        this._apply();
        this.queue_repaint();
    }

    _locate() {
        const box = rectInOffscreen(this.get_actor(), this._clip);
        if (!box)
            return;
        const u = this._uniforms;
        u.box = box.box;
        u.px = [box.width * this._scale, box.height * this._scale];
        this._apply();
    }

    _apply() {
        const p = this._pipeline;
        if (!p)
            return;
        const u = this._uniforms;
        setUniformVector(p, 'lens_box', u.box);
        setUniformVector(p, 'lens_px', u.px);
        p.set_uniform_1f(p.get_uniform_location('lens_radius'), u.radius);
        p.set_uniform_1f(p.get_uniform_location('lens_band'), u.band);
        p.set_uniform_1f(p.get_uniform_location('lens_depth'), u.depth);
        p.set_uniform_1f(p.get_uniform_location('lens_ior'), u.ior);
    }
});
