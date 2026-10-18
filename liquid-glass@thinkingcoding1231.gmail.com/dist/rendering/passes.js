import Clutter from 'gi://Clutter';
import { setUniformVector } from '../shellVersion.js';

export class RenderPasses {
    // Per-pass pipeline copies; see pipeline().
    _passPipelines = new Map();

    clear() {
        this._passPipelines.clear();
    }

    /**
     * A copy of `base` for one pass. Paint nodes run after the paint that
     * queued them returns, so passes sharing a pipeline would all draw with the
     * last pass's uniforms. Copies are copy-on-write and are replaced only when
     * `base` is (a shader recompile). Blending is plain replace: a LayerNode
     * does not clear, and every pass covers its whole target.
     */
    pipeline(key, base) {
        const cached = this._passPipelines.get(key);
        if (cached && cached.base === base)
            return cached.copy;
        const copy = base.copy();
        copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        this._passPipelines.set(key, { base, copy });
        return copy;
    }

    /**
     * Queues a render-to-texture pass as a paint node. An actor builds its
     * node tree first and runs it afterwards, so the backdrop copy queued in the
     * same tree has not reached its texture yet; drawing immediately would read
     * the previous copy. As a paint node the pass runs after it. The
     * projection is framebuffer state, so setting it at build time is fine.
     */
    add(parentNode, targetFbo, pipeline, destW, destH, uv) {
        targetFbo.orthographic(0, 0, destW, destH, -1, 1);
        const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
        parentNode.add_child(layerNode);
        const drawNode = Clutter.PipelineNode.new(pipeline);
        layerNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }), uv[0], uv[1], uv[2], uv[3]);
    }

    /**
     * Queues the final composite as a paint node, after the copy and the blur
     * passes. Every layer is drawn with the same UV range:
     * add_multitexture_rectangle()'s introspection is broken and crashes the
     * shell.
     */
    composite(parentNode, pipeline, dest, uv) {
        const drawNode = Clutter.PipelineNode.new(pipeline);
        parentNode.add_child(drawNode);
        drawNode.add_texture_rectangle(new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }), uv[0], uv[1], uv[2], uv[3]);
    }
}

// Cogl caches uniform locations, so these are cheap to call every frame.
export function setPipelineVec2(pipeline, name, x, y) {
    setUniformVector(pipeline, name, [x, y]);
}

export function setPipelineFloat(pipeline, name, value) {
    pipeline.set_uniform_1f(pipeline.get_uniform_location(name), value);
}
