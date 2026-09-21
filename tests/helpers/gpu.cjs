const assert = require('node:assert/strict');
const path = require('node:path');
const { createModuleLoader } = require('./load-module.cjs');
const dist = path.join(__dirname, '../../liquid-glass@thinkingcoding1231.gmail.com/dist');

function gpuFixture() {
  const textures = [], pipelines = [], layers = [], errors = [], stageHandlers = new Map();
  let failAllocation = false, nextSignal = 1;
  const texture = (w, h) => ({ get_width: () => w, get_height: () => h,
    run_dispose() { assert.fail('GJS-managed resources must not be disposed manually'); } });
  class Pipeline {
    constructor() { this.layers = new Map(); this.uniforms = new Map(); this.snippets = []; this.writes = []; pipelines.push(this); }
    copy() { const p = new Pipeline(); p.snippets = [...this.snippets]; return p; }
    set_blend(value) { this.blend = value; }
    set_layer_wrap_mode() {}
    set_layer_filters() {}
    set_layer_texture(layer, value) { this.layers.set(layer, value); }
    get_uniform_location(name) { return name; }
    set_uniform_float(name, size, count, values) { this.uniforms.set(name, [...values]); this.writes.push([name, size, count, [...values]]); }
    add_snippet(snippet) { this.snippets.push(snippet); }
    set_color(color) { this.color = color.values; }
  }
  class OffscreenEffect {
    constructor(params) { this._init(params); }
    _init(params) { Object.assign(this, params); this.repaints = 0; this.fallbacks = 0; }
    get_actor() { return this.actor; }
    get_texture() { return this.texture; }
    queue_repaint() { this.repaints++; }
    vfunc_paint() {}
    vfunc_paint_target() { this.fallbacks++; }
  }
  const context = {};
  const Clutter = {
    OffscreenEffect, Effect: OffscreenEffect, EffectPaintFlags: { ACTOR_DIRTY: 1 },
    get_default_backend: () => ({ get_cogl_context: () => context }),
    ActorBox: class { constructor(rect) { Object.assign(this, rect); } },
    LayerNode: { new_to_framebuffer(fbo, pipeline) {
      const node = { fbo, pipeline, children: [], add_child(child) { this.children.push(child); } };
      layers.push(node); return node;
    } },
    PipelineNode: { new(pipeline) { return { pipeline, add_texture_rectangle(...rect) { this.rect = rect; } }; } },
  };
  const Cogl = {
    Pipeline: { new: () => new Pipeline() },
    PipelineWrapMode: { CLAMP_TO_EDGE: 1 }, PipelineFilter: { LINEAR: 1 }, SnippetHook: { FRAGMENT: 1 },
    Snippet: { new: (_hook, decl) => ({ decl, set_replace(body) { this.body = body; } }) },
    Texture2D: { new_with_size: (_ctx, w, h) => {
      if (failAllocation) throw new Error('allocation failed');
      const result = texture(w, h); textures.push(result); return result;
    } },
    Offscreen: { new_with_texture: texture => ({ texture, orthographic() {} }) },
    Color: class { init_from_4f(...values) { this.values = values; } },
  };
  const globalThis = { global: { _lgGlass: {}, stage: {
    connect(_name, cb) { const id = nextSignal++; stageHandlers.set(id, cb); return id; },
    disconnect(id) { assert.ok(stageHandlers.delete(id)); },
  } } };
  const bindings = { Clutter, Cogl, globalThis, GObject: { registerClass: (_params, klass) => klass },
    GLib: { get_monotonic_time: () => 2e6 },
    Gio: { File: { new_for_path: () => ({
      load_contents_async(_cancel, callback) { queueMicrotask(() => callback(null, null)); },
      load_contents_finish: () => [true, new TextEncoder().encode('void main() { cogl_color_out = vec4(1.); }')],
    }) } },
    computeCaptureLayout: (_actor, sw, sh, w, h) => ({ uv: [0, 0, w / sw, h / sh], dest: [0, 0, w, h] }),
  };
  const load = createModuleLoader(bindings);
  const logger = { log() {}, warn() {}, error: message => errors.push(message) };
  const { ShaderPipelines } = load(path.join(dist, 'rendering/pipelines.js'));
  const { RenderPasses } = load(path.join(dist, 'rendering/passes.js'));
  const bases = new ShaderPipelines(logger), passes = new RenderPasses(logger);
  const root = () => ({ children: [], add_child(child) { this.children.push(child); } });
  return { bindings, load, logger, context, bases, passes, root, texture, textures, pipelines, layers, errors, stageHandlers,
    failAllocation(value) { failAllocation = value; } };
}

module.exports = { gpuFixture, dist };
