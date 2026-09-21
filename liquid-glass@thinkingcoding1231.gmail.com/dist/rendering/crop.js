import Cogl from 'gi://Cogl';
/** Owns the optional padding-removal target and its reuse across paints. */
export class CropPass {
    _pipelines;
    _passes;
    _logger;
    constructor(_pipelines, _passes, _logger) {
        this._pipelines = _pipelines;
        this._passes = _passes;
        this._logger = _logger;
    }
    // ── Crop texture pool ── see the crop pass section below.
    _cropTexture = null;
    _cropFbo = null;
    _cropPoolW = 0;
    _cropPoolH = 0;
    /**
     * (Re)allocates the crop FBO/texture at size (w, h), reusing the existing
     * one if the size hasn't changed.
     */
    _ensureCropTarget(ctx, w, h) {
        if (this._cropTexture && this._cropFbo &&
            this._cropPoolW === w && this._cropPoolH === h) {
            return true;
        }
        // Just clear the old references and let the GC handle them (same
        // reasoning as _destroyTexturePool).
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
        try {
            const tex = Cogl.Texture2D.new_with_size(ctx, w, h);
            const fbo = Cogl.Offscreen.new_with_texture(tex);
            this._cropTexture = tex;
            this._cropFbo = fbo;
            this._cropPoolW = w;
            this._cropPoolH = h;
            return true;
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
            return false;
        }
    }
    /**
     * [FIX round 11] Node-based crop pass.
     *
     * Round 10 removed the crop entirely and expressed the capture's padding as
     * a UV sub-rect instead, which meant layer 0 (the raw capture) and layer 1
     * (a padding-free pool texture) needed different coordinate ranges in the
     * composite. That required Clutter.PaintNode.add_multitexture_rectangle(),
     * which is NOT safely callable from GJS on this build: its introspection
     * annotation types text_coords as a plain number rather than an array, so
     * passing an array makes the native side read a JS object as a float
     * pointer. That is what crashed the shell with SIGSEGV.
     *
     * (Note Cogl.Framebuffer.draw_multitextured_rectangle IS annotated
     * correctly — only the Clutter PaintNode variant is broken, so the fix
     * cannot simply mirror the old immediate-mode call.)
     *
     * So the crop comes back, but as a paint node like every other pass. The
     * original reason for removing it — that its intermediate FBO served
     * last frame's content — no longer applies: that was never about the crop
     * itself, it was about immediate-mode drawing running before the capture
     * had been rendered. As a node it executes after the capture, so it reads
     * current content.
     *
     * With a padding-free full-resolution texture available again, every
     * downstream consumer (blur input and both composite layers) uses the plain
     * 0..1 range, and no multitexture coordinates are needed anywhere.
     *
     * Costs one full-resolution pass per frame per window. If that ever matters,
     * the way to avoid it is a per-layer texture matrix
     * (Cogl.Pipeline.set_layer_matrix) on layer 0, which would let the padding
     * be expressed without either an extra pass or multitexture coordinates —
     * worth trying only once the current path is confirmed correct.
     */
    render(parentNode, ctx, srcTex, srcW, srcH, allocW, allocH, uv) {
        if (allocW === srcW && allocH === srcH)
            return srcTex;
        if (!this._pipelines.passthrough)
            return srcTex;
        if (!this._ensureCropTarget(ctx, allocW, allocH))
            return srcTex;
        // Snippet-less 1-tap copy; see _passthroughPipeline.
        const pipeline = this._passes.pipeline('crop', this._pipelines.passthrough);
        pipeline.set_layer_texture(0, srcTex);
        this._passes.add(parentNode, this._cropFbo, pipeline, allocW, allocH, uv);
        return this._cropTexture;
    }
    clear() {
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
    }
}
