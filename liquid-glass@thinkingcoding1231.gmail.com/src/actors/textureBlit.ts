import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import { getAllocatedSize, computeCaptureLayout } from './geometry.js';
/**
 * Paints a captured texture stretched to fill its own allocation, without
 * ever triggering the source actor's own paint. Used for the "read an
 * existing OffscreenEffect's texture" fallback path (see
 * UILayerSampler._createExistingEffectBlitActor): unlike Clutter.Clone,
 * this never re-evaluates the source's effect chain, so it can't cause the
 * "two consumers" ownership conflict described on SelfExcludingSnapshotCapture.
 */
export const TextureBlitActor = GObject.registerClass({
  GTypeName: 'LiquidGlassTextureBlitActor',
}, class TextureBlitActor extends Clutter.Actor {

  declare private _getTexture: (() => Cogl.Texture2D | null) | null;
  declare private _sourceActor: Clutter.Actor | null;
  declare private _pipeline: Cogl.Pipeline | null;

  _init(params: any = {}) {
    super._init(params);
    Shell.util_set_hidden_from_pick(this, true);
    this._getTexture = null;
    this._sourceActor = null;
    this._pipeline = null;
  }

  vfunc_pick(_pickContext: any): void { }

  setTextureGetter(fn: () => Cogl.Texture2D | null): void {
    this._getTexture = fn;
  }

  setSourceActor(actor: Clutter.Actor): void {
    this._sourceActor = actor;
  }

  private _getCoglContext(): Cogl.Context | null {
    try {
      const backend = Clutter.get_default_backend();
      return backend.get_cogl_context() as Cogl.Context;
    } catch (e) {
      return null;
    }
  }

  vfunc_paint(paintContext: Clutter.PaintContext): void {
    if (!this._getTexture) return;
    const tex = this._getTexture();
    if (!tex) return;

    try {
      if (!this._pipeline) {
        const ctx = this._getCoglContext();
        if (!ctx) return;
        this._pipeline = Cogl.Pipeline.new(ctx);
        this._pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        this._pipeline.set_layer_filters(
          0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR
        );
      }

      const texW = tex.get_width();
      const texH = tex.get_height();

      // A ClutterOffscreenEffect's captured texture is a few pixels larger
      // than the actor's logical size, and — contrary to what this used to
      // assume — that padding is NOT centred: it is 2px on the left/top and
      // 1px on the right/bottom (see computeCaptureLayout()). Sample only
      // the sub-rectangle that actually holds the source's own pixels.
      let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
      const src = this._sourceActor;
      if (src) {
        const [rawW, rawH] = getAllocatedSize(src);
        const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
        const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;

        if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
          const uv = computeCaptureLayout(src, texW, texH, allocW, allocH).uv;
          uMin = uv[0]; vMin = uv[1]; uMax = uv[2]; vMax = uv[3];
        }
      }

      this._pipeline.set_layer_texture(0, tex);

      const [w, h] = this.get_size();
      if (!(w > 0) || !(h > 0)) return;

      const fb = paintContext.get_framebuffer() as unknown as Cogl.Framebuffer;
      fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, vMin, uMax, vMax);
    } catch (e) {
    }
  }
});
export type TextureBlitActor = InstanceType<typeof TextureBlitActor>;
