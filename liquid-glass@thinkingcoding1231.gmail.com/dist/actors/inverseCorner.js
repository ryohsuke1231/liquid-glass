import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
/**
 * A ShaderEffect that punches a rounded-rectangle hole out of whatever it's
 * attached to, leaving only the (inset) corner regions visible.
 *
 * Used by ApplicationManager: real application windows have square surfaces,
 * but the liquid-glass background behind them is rendered with rounded
 * corners (via LiquidEffect's corner_radius uniform). Without this effect the
 * window's own opaque content would square off the corners again, breaking
 * the illusion. Applied to a small overlay actor stacked above the window's
 * content and fed a clone of the true (unblurred) background, it reveals
 * exactly the true corner pixels while leaving the rest of the window alone.
 */
export const InverseCornerEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassInverseCornerEffect',
}, class InverseCornerEffect extends Clutter.ShaderEffect {
    _radius = 0;
    _inset = 0;
    // The glass shape's OWN corner radius. _radius is that plus a couple of
    // pixels (CORNER_PADDING) so the cut safely over-reveals past the glass's
    // antialiased corner; keeping both lets the shader tell the two arcs
    // apart, which is what confines the reveal to the corners.
    _glassRadius = 0;
    setRadius(radius) {
        this._radius = radius;
        this._updateShader();
    }
    setGlassRadius(radius) {
        this._glassRadius = radius;
        this._updateShader();
    }
    setInset(inset) {
        this._inset = inset;
        this._updateShader();
    }
    _updateShader() {
        const shader = `
        uniform sampler2D cogl_sampler;
        uniform float radius;
        uniform float glass_radius;
        uniform float inset;
        uniform float width;
        uniform float height;

        float sdRoundRect(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b + vec2(r);
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
        }

        void main() {
          vec2 st = cogl_tex_coord_in[0].st;
          vec2 resolution = vec2(width, height);
          vec2 p = (st * resolution) - (resolution * 0.5);

          // [FIX] Box half-size at the window's TRUE edge, not shrunk by
          // "inset" on every side. This overlay's actor is padded by
          // SHADER_PADDING beyond the real window bounds on all sides, and
          // "inset" here is exactly that padding — so windowHalf lands
          // precisely on the real window edge.
          //
          // Previously this used (resolution - inset*2)*0.5 with
          // inset = SHADER_PADDING + CORNER_PADDING, which shrank the box by
          // the SAME amount on every side, not just near the corners. Per
          // sdRoundRect's construction, its straight-edge (non-corner)
          // zero-crossing sits exactly at the box half-size regardless of
          // "radius" — only points within "radius" of an actual corner get
          // pulled inward. So shrinking the box itself (rather than only
          // widening "radius") revealed a uniform band along the ENTIRE
          // perimeter — straight edges included — instead of just the 4
          // corners. That band unconditionally painted this overlay's raw,
          // unblurred/untinted/un-shadowed source at full alpha, erasing the
          // drop shadow right next to the window on every edge (reported as
          // an unnatural halo/"frame" around the window), and — since its
          // width is a fixed pixel count independent of actor scale — became
          // sharply more visible whenever GNOME Shell's open/close animation
          // scaled the window down (the same fixed-pixel band read as a much
          // larger fraction of the shrunk window).
          //
          // "radius" (cornerRadius + CORNER_PADDING, set by the caller) is
          // intentionally a couple pixels larger than the glass shape's own
          // corner_radius so the cut safely over-reveals past the glass's
          // own antialiased corner — but that over-cut should only pull the
          // 4 corners inward, not shift the straight edges too.
          vec2 windowHalf = max(resolution * 0.5 - vec2(inset), vec2(1.0));

          // [FIX] This overlay redraws the raw, sharp background on top of the
          // glass, so every pixel it covers is a pixel of drop shadow that
          // cannot be seen. It must therefore cover the corner arcs and
          // NOTHING else. Three terms, each removing one way it used to
          // overreach:
          //
          //   1. outside the cut arc          — the original test
          //   2. still inside the glass shape — stops it reaching outward into
          //                                     the shadow at all
          //   3. only where the two arcs differ — zero along the straight
          //                                     edges, so no seam there
          //
          // History: with only term 1, sdRoundRect is positive everywhere
          // outside the box, so the overlay painted the ENTIRE margin ring and
          // erased the whole drop shadow. Bounding it by the window's square
          // bounds fixed the straight edges but not the corners: the notch
          // between the rounded arc and the square corner is precisely where
          // the shadow wraps around, and the overlay was still sitting on it.
          // Bounding by the glass shape instead is what actually separates
          // "erase the glass's corner" from "do not touch the shadow".
          float dCut = sdRoundRect(p, windowHalf, radius);
          float dGlass = sdRoundRect(p, windowHalf, max(glass_radius, 0.0));

          // 1. Outside the cut arc.
          float alpha = smoothstep(-0.5, 0.5, dCut);

          // 2. Inside the glass, plus a small outward guard so the glass's own
          //    antialiased boundary is covered rather than left as a fringe.
          //    Term 3 keeps this guard from eating shadow along the edges.
          alpha *= 1.0 - smoothstep(-0.5, 0.5, dGlass - 1.5);

          // 3. Corner-only. A rounded rect with a larger radius is a subset of
          //    one with a smaller radius, and the two coincide exactly along
          //    the straight sides — so this difference is 0 there and grows to
          //    about 0.41 * (radius - glass_radius) at the square corner.
          alpha *= smoothstep(0.15, 0.6, dCut - dGlass);

          // Fade out at the very edges of the overlay actor to ensure it blends seamlessly
          // with the background and hides any potential window shadow cutoff.
          // (With the notch restriction above this is normally already 1
          // throughout the painted region — the notches sit at least "inset"
          // px in from the actor edge — but it still guards a degenerate
          // inset smaller than the fade distance.)
          vec2 edgeDist = min(st, 1.0 - st) * resolution;
          float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));
          alpha *= edgeFade;

          cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
        }
      `;
        this.set_shader_source(shader);
        this._updateUniforms();
    }
    _setUniform(name, value) {
        let gval = new GObject.Value();
        gval.init(GObject.TYPE_FLOAT);
        gval.set_float(value);
        this.set_uniform_value(name, gval);
    }
    _updateUniforms() {
        let actor = this.get_actor();
        if (!actor)
            return;
        let w = actor.width;
        let h = actor.height;
        if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0)
            return;
        this._setUniform('radius', this._radius);
        this._setUniform('glass_radius', this._glassRadius);
        this._setUniform('inset', this._inset);
        this._setUniform('width', w);
        this._setUniform('height', h);
    }
    vfunc_paint_target(node, paint_context) {
        this._updateUniforms();
        super.vfunc_paint_target(node, paint_context);
    }
});
