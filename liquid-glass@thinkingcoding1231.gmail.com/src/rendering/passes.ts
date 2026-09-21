import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import type { Logger } from '../logger.js';

/** Builds deferred paint nodes and owns the pipeline copy for each pass. */
export class RenderPasses {
  private _passPipelines = new Map<string, { base: Cogl.Pipeline; copy: Cogl.Pipeline }>();
  private _uvMismatchWarned = false;

  constructor(private _logger?: Logger) {}

  clear(): void {
    this._passPipelines.clear();
  }


  /**
   * [FIX round 10] Returns a private copy of `base` dedicated to one pass.
   *
   * Immediate-mode drawing let every pass share one pipeline object: set the
   * uniforms, draw, then overwrite the uniforms for the next pass. Paint
   * nodes execute AFTER vfunc_paint_target returns, so a shared pipeline
   * would have every pass drawn with whatever uniform values the LAST pass
   * happened to leave behind. Each pass therefore needs its own pipeline.
   *
   * Cogl pipelines are copy-on-write, so the copies are cheap, and they are
   * cached and only re-copied when the base pipeline object itself is
   * replaced (which is what happens when a shader is recompiled — a radius
   * change that only updates kernel_scale keeps the same object, and the
   * uniform is set on the copy every frame anyway).
   *
   * Blending is forced to plain replace so each pass overwrites its target
   * rather than compositing onto the previous frame's contents. The
   * immediate-mode code got that from an explicit clear before every draw;
   * a LayerNode does no clearing, and since every pass covers its whole
   * target rect, replace-blending achieves the same result without one.
   */
  pipeline(key: string, base: Cogl.Pipeline): Cogl.Pipeline {
    const cached = this._passPipelines.get(key);
    if (cached && cached.base === base) return cached.copy;

    const copy = base.copy();
    try {
      copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
    } catch (e) {
      this._logger?.error(`[Liquid Glass] set_blend failed for pass '${key}': ${e}`);
    }
    this._passPipelines.set(key, { base, copy });
    return copy;
  }


  /**
   * [FIX round 10] Queues one render-to-texture pass as a paint node instead
   * of drawing it immediately.
   *
   * This is the core of the drag-lag fix. vfunc_paint_target() runs while the
   * paint node tree is being BUILT; ClutterOffscreenEffect renders the actor
   * into its capture texture when that tree is later EXECUTED. Immediate-mode
   * Cogl calls therefore sampled the capture before it had been drawn for
   * this frame, yielding the previous frame's contents — the one-frame lag.
   *
   * Adding the pass as a child of the effect's node instead makes it execute
   * after the capture layer node that OffscreenEffect already put there, so
   * it samples this frame's content. The projection is set on the target
   * framebuffer here; that is persistent framebuffer state rather than a
   * queued operation, so setting it at build time is fine.
   */
  add(
    parentNode: any, targetFbo: any, pipeline: Cogl.Pipeline,
    destW: number, destH: number, uv: number[]
  ): void {
    (targetFbo as unknown as Cogl.Framebuffer).orthographic(0, 0, destW, destH, -1, 1);

    const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
    parentNode.add_child(layerNode);

    const drawNode = Clutter.PipelineNode.new(pipeline);
    layerNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }),
      uv[0], uv[1], uv[2], uv[3]
    );
  }


  /**
   * [FIX] Queues the final composite as a paint node.
   *
   * It has to be a node, like every other pass, so it executes after the
   * capture layer node and after the blur passes queued above it. Immediate
   * drawing here only looked correct because Cogl happened to defer it far
   * enough — adding a single flush() was enough to reproduce the same
   * one-frame lag on this path too.
   *
   * Both layers share one coordinate range by construction: the crop pass
   * guarantees layer 0 is padding-free whenever layer 1 is, so
   * add_texture_rectangle is sufficient. This deliberately does NOT use
   * add_multitexture_rectangle — that call segfaults the shell on this build
   * (memo.md 6.1), which is why both layers share one coordinate range.
   */
  composite(
    parentNode: any, pipeline: Cogl.Pipeline, dest: number[], layer0UV: number[], layer1UV: number[]
  ): void {
    if (layer0UV[0] !== layer1UV[0] || layer0UV[1] !== layer1UV[1] ||
      layer0UV[2] !== layer1UV[2] || layer0UV[3] !== layer1UV[3]) {
      // Should be unreachable: the crop pass exists precisely so the two
      // layers always agree. Log once rather than silently misdrawing, since
      // the only remedy available here is to favour layer 0.
      if (!this._uvMismatchWarned) {
        this._uvMismatchWarned = true;
        this._logger?.error(
          '[Liquid Glass] composite layers disagree on UV range ' +
          `(layer0=[${layer0UV}] layer1=[${layer1UV}]); drawing with layer 0's range. ` +
          'This means the crop pass did not run when it was needed.'
        );
      }
    }

    const drawNode = Clutter.PipelineNode.new(pipeline);
    parentNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }),
      layer0UV[0], layer0UV[1], layer0UV[2], layer0UV[3]
    );
  }
}


// ─── Uniform helpers ─────────────────────────────────────────────────────────

/**
 * Sets a vec2 uniform on a pipeline. Cogl caches the uniform location
 * internally, so calling this every frame is safe.
 */
export function setPipelineVec2(
  pipeline: Cogl.Pipeline, name: string, x: number, y: number
): void {
  const loc = pipeline.get_uniform_location(name);
  // set_uniform_float(loc, n_components, count, values[])
  pipeline.set_uniform_float(loc, 2, 1, [x, y]);
}


/**
 * Sets a scalar float uniform on a pipeline.
 */
export function setPipelineFloat(
  pipeline: Cogl.Pipeline, name: string, value: number
): void {
  const loc = pipeline.get_uniform_location(name);
  pipeline.set_uniform_float(loc, 1, 1, [value]);
}
