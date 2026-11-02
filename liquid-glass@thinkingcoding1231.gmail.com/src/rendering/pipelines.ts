import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import type { Logger } from '../logger.js';
import { uniformDeclarations, setUniformVector, coglContext } from '../shellVersion.js';

export interface ShaderSnippet {
  /** Everything before void main() (uniform declarations / helper functions) */
  decl: string;
  /** The body of void main(), with the surrounding braces stripped */
  body: string;
}

// A 1D Gaussian kernel for linear sampling (bilinear tap merging).
//   offsets[0] / weights[0] is the center sample (offset is always 0).
//   offsets[i] / weights[i] for i >= 1 is the combined offset/weight for a
//   symmetric left-right (or up-down) pair of taps merged into one fetch.
// Number of texture fetches = 1 (center) + 2 * (offsets.length - 1) (side pairs).
export interface GaussianKernel {
  offsets: number[];
  weights: number[];
}

/**
 * Splits a GLSL source string into { decl, body } at the "void main()" boundary.
 */
export function splitShader(src: string, warn?: (message: string) => void): ShaderSnippet {
  const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
  if (!match || match.index === undefined) {
    warn?.('[Liquid Glass] void main() not found; treating entire source as decl.');
    return { decl: src, body: '' };
  }

  const decl = src.substring(0, match.index);
  const rest = src.substring(match.index + match[0].length);

  // Find the matching closing brace.
  let depth = 1;
  let bodyEnd = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }

  return { decl, body: rest.substring(0, bodyEnd) };
}

/**
 * A linear-sampling Gaussian kernel for `sigma` (half-res texels) with
 * `fetchPairs` merged tap pairs: the center stays a single sample, and each
 * (i, i+1) pair becomes one fetch at the weighted mean offset. The shader's
 * structure depends only on fetchPairs, so a sigma change within it only
 * updates the kernel_scale uniform.
 */
export function computeGaussianKernel(sigma: number, fetchPairs: number): GaussianKernel {
  const sideTaps = Math.max(2, fetchPairs * 2);

  const raw: number[] = [];
  let sum = 0;
  for (let i = 0; i <= sideTaps; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    raw.push(w);
    sum += (i === 0) ? w : w * 2;
  }
  for (let i = 0; i <= sideTaps; i++) {
    raw[i] /= sum;
  }

  const offsets: number[] = [0];
  const weights: number[] = [raw[0]];

  for (let p = 0; p < fetchPairs; p++) {
    const i = p * 2 + 1;
    const j = i + 1;
    const w0 = raw[i] ?? 0;
    const w1 = (j <= sideTaps) ? raw[j] : 0;
    const wSum = w0 + w1;
    const offset = wSum > 0 ? (i * w0 + j * w1) / wSum : i;
    offsets.push(offset);
    weights.push(wSum);
  }

  return { offsets, weights };
}

/**
 * An unrolled GLSL snippet for `kernel`. Offsets and weights are constants;
 * kernel_scale scales the offsets at runtime.
 */
export function buildGaussianSnippet(kernel: GaussianKernel, direction: 'h' | 'v'): ShaderSnippet {
  const decl =
    `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
    `uniform float kernel_scale; /* dynamic scale based on the sigma ratio, avoids recompiling */\n`;

  const lines: string[] = [];
  lines.push(`vec2 uv = cogl_tex_coord_in[0].st;`);
  lines.push(`vec4 col = texture2D(cogl_sampler0, uv) * ${kernel.weights[0].toFixed(8)};`);

  for (let i = 1; i < kernel.offsets.length; i++) {
    const off = kernel.offsets[i].toFixed(8);
    const w = kernel.weights[i].toFixed(8);
    const plusVec = direction === 'h'
      ? `vec2(${off} * kernel_scale * inv_size.x, 0.0)`
      : `vec2(0.0, ${off} * kernel_scale * inv_size.y)`;
    lines.push(`col += texture2D(cogl_sampler0, uv + ${plusVec}) * ${w};`);
    lines.push(`col += texture2D(cogl_sampler0, uv - ${plusVec}) * ${w};`);
  }

  lines.push(`cogl_color_out = col;`);

  return { decl, body: '\n    ' + lines.join('\n    ') + '\n' };
}

const SHADER_FILES = ['downsample.frag', 'upsample.frag', 'glass.frag'];

// The shader sources by path, read once. A glass made while an animation runs
// (a notification banner sliding in) then has them before its first frame,
// where reading them again would leave it undrawn for a few frames.
const shaderSources = new Map<string, string>();

export function clearShaderSources(): void {
  shaderSources.clear();
}

export class ShaderPipelines {
  // `shapeTexture`: the composite takes the glass's outline from a distance
  // field on layer 2 (glass text) instead of the rounded rect.
  constructor(private _logger?: Logger, private _shapeTexture = false) { }

  async load(extensionPath: string | undefined, cancellable: Gio.Cancellable | null = null): Promise<void> {
    if (!extensionPath) throw new Error('Missing extension path for shader loading');
    const sources: string[] = [];
    for (const name of SHADER_FILES) sources.push(await this._readFileAsync(`${extensionPath}/shaders/${name}`, cancellable));
    [this._downsampleSource, this._upsampleSource, this._glassSource] = sources;
  }

  /** Takes the sources another glass has read already; false while none has. */
  loadCached(extensionPath: string | undefined): boolean {
    const sources = SHADER_FILES.map(name => shaderSources.get(`${extensionPath}/shaders/${name}`));
    if (!extensionPath || sources.some(source => source === undefined)) return false;
    [this._downsampleSource, this._upsampleSource, this._glassSource] = sources as string[];
    return true;
  }

  clear(): void {
    this.downsample = null;
    this.upsample = null;
    this.composite = null;
    this.passthrough = null;
    this.boxDown = null;
  }

  // Compiled once and reused across frames. downsample/upsample are Dual Kawase.
  public downsample: Cogl.Pipeline | null = null;

  public upsample: Cogl.Pipeline | null = null;
  public composite: Cogl.Pipeline | null = null;

  // A plain one-fetch copy with a UV remap, for the Gaussian's half-res
  // pre-pass. No snippet: Cogl's default combine modulates the
  // texture by the pipeline color, which is opaque white.
  public passthrough: Cogl.Pipeline | null = null;

  // A 4x4 box filter, the first pass when glass-blur-downscale is 4.
  public boxDown: Cogl.Pipeline | null = null;

  private _downsampleSource: string | null = null;

  private _upsampleSource: string | null = null;

  private _glassSource: string | null = null;

  // load_contents_finish() throws a GError when the file cannot be read.
  private _readFileAsync(path: string, cancellable: Gio.Cancellable | null): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = Gio.File.new_for_path(path);
      file.load_contents_async(cancellable, (_, res) => {
        try {
          const [ok, bytes] = file.load_contents_finish(res);
          if (!ok) {
            reject(new Error(`load_contents_finish returned false for ${path}`));
          } else {
            const source = new TextDecoder('utf-8').decode(bytes);
            shaderSources.set(path, source);
            resolve(source);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Compiles the pipelines. Runs on the first frame, once a Cogl context
   * exists; call clear() first to recompile.
   */
  initialize(ctx: Cogl.Context): void {
    this.downsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.downsample, 0);

    if (this._downsampleSource) {
      const downSnippet = splitShader(this._downsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(downSnippet.decl), null);
      s.set_replace(downSnippet.body);
      this.downsample.add_snippet(s);
    }

    this.upsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.upsample, 0);

    if (this._upsampleSource) {
      const upSnippet = splitShader(this._upsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(upSnippet.decl), null);
      s.set_replace(upSnippet.body);
      this.upsample.add_snippet(s);
    }

    this.passthrough = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.passthrough, 0);

    // For a 4x reduction a single bilinear fetch covers only the inner 2x2 of
    // each 4x4 block and aliases. These four taps land on source texel
    // corners, so each fetch averages one 2x2 quadrant and together they
    // weigh the whole block equally.
    this.boxDown = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.boxDown, 0);
    {
      const boxSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        uniformDeclarations('uniform vec2 inv_size;\n'), null);
      boxSnip.set_replace(
        'vec2 uv = cogl_tex_coord_in[0].st;\n' +
        'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
        'cogl_color_out = c * 0.25;\n');
      this.boxDown.add_snippet(boxSnip);
    }

    // The Gaussian pipelines depend on the blur radius and are compiled by
    // BlurRenderer when needed.

    this.composite = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.composite, 0);
    if (this._shapeTexture) configureSamplerLayer(this.composite, SHAPE_LAYER);

    // Premultiplied-alpha "over", as ShaderEffect blends by default.
    this.composite.set_blend(
      'RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
    );

    this._loadCompositeShader();
  }

  /**
   * Adds glass.frag to the composite pipeline. The shader uses ShaderEffect's
   * "cogl_sampler", which becomes "cogl_sampler0", the name Cogl declares for
   * layer 0 in a fragment snippet; the shader's own declaration is dropped.
   */
  private _loadCompositeShader(): void {
    if (!this.composite || !this._glassSource) return;

    let { decl, body } = splitShader(this._glassSource, message => this._logger?.warn(message));

    decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
    body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
    if (this._shapeTexture) decl = `#define LG_SHAPE_TEXTURE 1\n${decl}`;

    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(decl), null);
    snippet.set_replace(body);
    this.composite.add_snippet(snippet);
  }
}

// The composite's layer for the distance field of a shape-texture glass.
export const SHAPE_LAYER = 2;

// Bilinear filtering and clamp-to-edge on one layer.
export function configureSamplerLayer(pipeline: Cogl.Pipeline, layer: number): void {
  pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
}

export class RenderPasses {
  // Per-pass pipeline copies; see pipeline().
  private _passPipelines = new Map<string, { base: Cogl.Pipeline; copy: Cogl.Pipeline }>();

  clear(): void {
    this._passPipelines.clear();
  }

  /**
   * A copy of `base` for one pass. Paint nodes run after the paint that
   * queued them returns, so passes sharing a pipeline would all draw with the
   * last pass's uniforms. Copies are copy-on-write and are replaced only when
   * `base` is (a shader recompile). Blending is plain replace: a LayerNode
   * does not clear, and every pass covers its whole target.
   */
  pipeline(key: string, base: Cogl.Pipeline): Cogl.Pipeline {
    const cached = this._passPipelines.get(key);
    if (cached && cached.base === base) return cached.copy;

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
   * Queues the final composite as a paint node, after the copy and the blur
   * passes. Every layer is drawn with the same UV range:
   * add_multitexture_rectangle()'s introspection is broken and crashes the
   * shell.
   */
  composite(parentNode: any, pipeline: Cogl.Pipeline, dest: number[], uv: number[]): void {
    const drawNode = Clutter.PipelineNode.new(pipeline);
    parentNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }),
      uv[0], uv[1], uv[2], uv[3]
    );
  }
}

// Cogl caches uniform locations, so these are cheap to call every frame.
export function setPipelineVec2(
  pipeline: Cogl.Pipeline, name: string, x: number, y: number
): void {
  setUniformVector(pipeline, name, [x, y]);
}

export function setPipelineFloat(
  pipeline: Cogl.Pipeline, name: string, value: number
): void {
  pipeline.set_uniform_1f(pipeline.get_uniform_location(name), value);
}

// 0: separable Gaussian (shader generated from the kernel), 1: Dual Kawase.
export type BlurMethod = 0 | 1;
// Cogl.Offscreen is a Cogl.Framebuffer; the type definitions need the cast.
type CoglFB = Cogl.Framebuffer;

export class BlurRenderer {
  constructor(
    private _pipelines: ShaderPipelines, private _passes: RenderPasses,
    private _repaint: () => void,
  ) {}

  get radius(): number { return this._targetRadius; }
  get downscale(): number { return this._blurDownscale; }
  get passCount(): number { return this.PASS_COUNT; }
  get result(): Cogl.Texture | null { return this._blurResultTex; }
  get width(): number { return this._poolWidth; }
  get height(): number { return this._poolHeight; }
  get ready(): boolean { return this.PASS_COUNT === 0 || this._blurFbos.length > 0; }
  get needsCompile(): boolean { return this._gaussianPipelineDirty && this._pendingGaussianKernel !== null; }

  invalidate(): void { this._destroyTexturePool(); }

  compilePending(ctx: Cogl.Context): void {
    if (!this.needsCompile) return;
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._compileGaussianPipelines(ctx, this._pendingGaussianKernel!);
  }

  render(parent: any, source: Cogl.Texture, uv: number[], inputKey?: readonly unknown[]): void {
    this._blurResultTex = null;
    this._renderedKey = null;
    if (this.PASS_COUNT <= 0) return;
    if (this._blurMethod === 0) {
      if (this._gaussianHPipeline && this._gaussianVPipeline) this._runGaussianBlur(parent, source, uv);
    } else this._runDualKawaseBlur(parent, source, uv);
    // Only a chain that actually produced a result may be reused later, and
    // the key records the configuration it was produced with.
    if (inputKey && this._blurResultTex !== null) this._renderedKey = [...inputKey, ...this._configKey()];
  }

  canReuse(inputKey: readonly unknown[]): boolean {
    const stored = this._renderedKey;
    if (stored === null || this._blurResultTex === null || this.PASS_COUNT <= 0) return false;
    const config = this._configKey();
    if (stored.length !== inputKey.length + config.length) return false;
    for (let i = 0; i < inputKey.length; i++) if (stored[i] !== inputKey[i]) return false;
    for (let i = 0; i < config.length; i++) if (stored[inputKey.length + i] !== config[i]) return false;
    return true;
  }

  private _renderedKey: unknown[] | null = null;

  private _configKey(): unknown[] {
    const p = this._pipelines;
    return [this._blurFbos[0] ?? null, this._blurMethod, this.PASS_COUNT, this._blurDownscale,
      this._blurRadiusDown, this._blurRadiusUp, this._gaussianScale,
      this._gaussianHPipeline, this._gaussianVPipeline,
      p.downsample, p.upsample, p.passthrough, p.boxDown];
  }

  setDownscale(factor: number): void {
    if (factor === this._blurDownscale) return;
    this._blurDownscale = factor;
    // Level 0 changes size; the next paint rebuilds the pool.
    this._destroyTexturePool();
    this.setBlurRadius(this._targetRadius);
    this._repaint();
  }

  reload(): void {
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._gaussianKernel = null;
    this._gaussianFetchPairs = 0;
    this.setBlurRadius(this._targetRadius);
  }

  clear(): void {
    this._destroyTexturePool();
    this._gaussianHPipeline = null;
    this._gaussianVPipeline = null;
    this._gaussianKernel = null;
    this._pendingGaussianKernel = null;
    this._gaussianPipelineDirty = false;
    this._gaussianBaseSigma = 0;
    this._gaussianScale = 1;
    this._gaussianFetchPairs = 0;
  }

  describe() {
    const result = this._blurResultTex;
    return {
      blurMethod: this._blurMethod, passCount: this.PASS_COUNT,
      pool: this._poolWidth + 'x' + this._poolHeight, poolLevels: this._blurFbos.length,
      blurResult: result ? result.get_width() + 'x' + result.get_height() : 'NULL (layer 1 falls back to the unblurred copy)',
      radiusDown: this._blurRadiusDown, radiusUp: this._blurRadiusUp, targetRadius: this._targetRadius,
      gaussianPipelines: !!(this._gaussianHPipeline && this._gaussianVPipeline),
    };
  }

  // The texture pool; see resize() for the sizes.
  private _blurTextures: Cogl.Texture2D[] = [];

  private _blurFbos: Cogl.Offscreen[] = [];

  // The Gaussian horizontal pass output, per level.
  private _gaussianTempTextures: Cogl.Texture2D[] = [];

  private _gaussianTempFbos: Cogl.Offscreen[] = [];

  // Separate output targets per level, so no pass writes a framebuffer that
  // an earlier pass read. Deferred paint nodes make Cogl track dependencies
  // between framebuffers, and ping-ponging is a cycle it rejects; the passes
  // then lose their order and the composite reads an unwritten blur.
  private _upTextures: Cogl.Texture2D[] = [];

  private _upFbos: Cogl.Offscreen[] = [];

  // This frame's finished blur, read by the composite.
  private _blurResultTex: Cogl.Texture | null = null;

  private _gaussianHPipeline: Cogl.Pipeline | null = null;
  private _gaussianVPipeline: Cogl.Pipeline | null = null;

  private _blurMethod: BlurMethod = 1;

  // The kernel compiled into the H/V pipelines, and one waiting to be
  // compiled on the next paint.
  private _gaussianKernel: GaussianKernel | null = null;
  private _pendingGaussianKernel: GaussianKernel | null = null;
  private _gaussianPipelineDirty: boolean = false;

  // The sigma the compiled kernel was built for; radius changes that keep
  // the tap count only change kernel_scale = sigma / _gaussianBaseSigma.
  private _gaussianBaseSigma: number = 0;
  private _gaussianScale: number = 1.0;
  private _gaussianFetchPairs: number = 0;

  private _poolWidth: number = 0;

  private _poolHeight: number = 0;

  // glass-blur-downscale: 2 = half resolution (default), 4 = quarter.
  private _blurDownscale: number = 2;

  // Passes per direction. With 4: 1/2 → 1/4 → 1/8 → 1/16 → 1/8 → 1/4 → 1/2.
  private PASS_COUNT: number = 4;

  // The Kawase shaders' blur_radius uniforms.
  private _blurRadiusDown: number = 0.5;

  private _blurRadiusUp: number = 1.0;

  // The requested radius, before the per-method mapping.
  private _targetRadius: number = 15.0;

  // The caller drops the previous pipelines first.
  private _compileGaussianPipelines(ctx: Cogl.Context, kernel: GaussianKernel): void {
    this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this._gaussianHPipeline, 0);
    const hSnippet = buildGaussianSnippet(kernel, 'h');
    const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(hSnippet.decl), null);
    hSnip.set_replace(hSnippet.body);
    this._gaussianHPipeline.add_snippet(hSnip);

    this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this._gaussianVPipeline, 0);
    const vSnippet = buildGaussianSnippet(kernel, 'v');
    const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, uniformDeclarations(vSnippet.decl), null);
    vSnip.set_replace(vSnippet.body);
    this._gaussianVPipeline.add_snippet(vSnip);

    this._gaussianKernel = kernel;
    this._gaussianPipelineDirty = false;
    this._pendingGaussianKernel = null;
  }

  /**
   * Allocates the pool for a (w, h) source. Level i is w >> (i + 1) wide
   * (level 0 at half resolution); glass-blur-downscale = 4 shifts every level
   * down one more step.
   */
  resize(ctx: Cogl.Context, w: number, h: number): void {
    this._destroyTexturePool();

    const shift = this._blurDownscale >= 4 ? 2 : 1;
    let pw = Math.max(w >> shift, 1);
    let ph = Math.max(h >> shift, 1);

    for (let i = 0; i < this.PASS_COUNT; i++) {
      const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
      this._blurTextures.push(tex);
      this._blurFbos.push(Cogl.Offscreen.new_with_texture(tex));

      const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
      this._gaussianTempTextures.push(tmpTex);
      this._gaussianTempFbos.push(Cogl.Offscreen.new_with_texture(tmpTex));

      const upTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
      this._upTextures.push(upTex);
      this._upFbos.push(Cogl.Offscreen.new_with_texture(upTex));

      pw = Math.max(pw >> 1, 1);
      ph = Math.max(ph >> 1, 1);
    }

    this._poolWidth = w;
    this._poolHeight = h;
  }

  // Dual Kawase: downsample srcTex through every level, then upsample back
  // into the _up* targets.
  private _runDualKawaseBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    let currentSrc: Cogl.Texture = srcTex;

    for (let i = 0; i < this.PASS_COUNT; i++) {
      const destFbo = this._blurFbos[i] as unknown as CoglFB;
      const destTex = this._blurTextures[i];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / currentSrc.get_width();
      const invH = 1.0 / currentSrc.get_height();

      // Only the first pass reads the source, through srcUV.
      const uv = (i === 0) ? srcUV : [0, 0, 1, 1];

      // At downscale 4 the first pass is a 4x reduction, which Kawase's
      // kernel does not filter properly; the box filter does.
      const boxFirst = i === 0 && this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
      const pipeline = boxFirst
        ? this._passes.pipeline('kawase-down-0-box', this._pipelines.boxDown!)
        : this._passes.pipeline(`kawase-down-${i}`, this._pipelines.downsample!);
      pipeline.set_layer_texture(0, currentSrc);
      setPipelineVec2(pipeline, 'inv_size', invW, invH);
      if (!boxFirst)
        setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusDown);

      this._passes.add(parentNode, destFbo, pipeline, destW, destH, uv);

      currentSrc = destTex;
    }

    if (this.PASS_COUNT <= 1) {
      this._blurResultTex = this._blurTextures[0];
      return;
    }

    for (let i = this.PASS_COUNT - 1; i > 0; i--) {
      const srcTexture = (i === this.PASS_COUNT - 1)
        ? this._blurTextures[i]
        : this._upTextures[i];
      const destFbo = this._upFbos[i - 1] as unknown as CoglFB;
      const destTex = this._upTextures[i - 1];
      const destW = destTex.get_width();
      const destH = destTex.get_height();

      const invW = 1.0 / srcTexture.get_width();
      const invH = 1.0 / srcTexture.get_height();

      const pipeline = this._passes.pipeline(`kawase-up-${i}`, this._pipelines.upsample!);
      pipeline.set_layer_texture(0, srcTexture);
      setPipelineVec2(pipeline, 'inv_size', invW, invH);
      setPipelineFloat(pipeline, 'blur_radius', this._blurRadiusUp);

      this._passes.add(parentNode, destFbo, pipeline, destW, destH, [0, 0, 1, 1]);
    }

    this._blurResultTex = this._upTextures[0];
  }

  // Separable Gaussian on pool level 0 only: a downsampling pre-pass into
  // _blurTextures[0], the horizontal pass into the temp texture, and the
  // vertical pass into _upTextures[0].
  private _runGaussianBlur(parentNode: any, srcTex: Cogl.Texture, srcUV: number[]): void {
    const tempFbo = this._gaussianTempFbos[0] as unknown as CoglFB;
    const tempTex = this._gaussianTempTextures[0];
    const destFbo = this._blurFbos[0] as unknown as CoglFB;
    const destTex = this._blurTextures[0];
    const destW = destTex.get_width();
    const destH = destTex.get_height();

    // At downscale 2 one bilinear fetch averages the 2x2 footprint exactly;
    // at 4 the box filter is needed.
    const wideDownsample = this._blurDownscale >= 4 && this._pipelines.boxDown !== null;
    const prePipeline = wideDownsample
      ? this._passes.pipeline('gauss-pre-box', this._pipelines.boxDown!)
      : this._passes.pipeline('gauss-pre', this._pipelines.passthrough!);
    prePipeline.set_layer_texture(0, srcTex);
    if (wideDownsample) {
      setPipelineVec2(prePipeline, 'inv_size',
        1.0 / srcTex.get_width(), 1.0 / srcTex.get_height());
    }

    this._passes.add(parentNode, destFbo, prePipeline, destW, destH, srcUV);

    const hPipeline = this._passes.pipeline('gauss-h', this._gaussianHPipeline!);
    hPipeline.set_layer_texture(0, destTex);
    setPipelineVec2(hPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    setPipelineFloat(hPipeline, 'kernel_scale', this._gaussianScale);

    this._passes.add(parentNode, tempFbo, hPipeline, destW, destH, [0, 0, 1, 1]);

    // Not back into destFbo, which the horizontal pass read (see _upTextures).
    const vPipeline = this._passes.pipeline('gauss-v', this._gaussianVPipeline!);
    vPipeline.set_layer_texture(0, tempTex);
    setPipelineVec2(vPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
    setPipelineFloat(vPipeline, 'kernel_scale', this._gaussianScale);

    const outFbo = this._upFbos[0] as unknown as CoglFB;
    this._passes.add(parentNode, outFbo, vPipeline, destW, destH, [0, 0, 1, 1]);

    this._blurResultTex = this._upTextures[0];
  }

  // Dropping the references frees the textures; GJS owns them, so
  // run_dispose() would free them twice.
  private _destroyTexturePool(): void {
    this._blurFbos = [];
    this._blurTextures = [];
    this._gaussianTempFbos = [];
    this._gaussianTempTextures = [];
    this._upFbos = [];
    this._upTextures = [];
    this._blurResultTex = null;
    // The reuse key holds the old source texture.
    this._renderedKey = null;
    this._poolWidth = 0;
    this._poolHeight = 0;
  }

  // Both methods share the pool, and the Gaussian kernel is compiled on the
  // next paint, so a repaint is all a switch needs.
  setBlurMethod(method: BlurMethod): void {
    if (this._blurMethod === method) return;
    this._blurMethod = method;
    this.setBlurRadius(this._targetRadius);
    this._repaint();
  }

  setBlurRadius(radius: number): void {
    this._targetRadius = radius;

    if (this._blurMethod === 0) {
      this._setGaussianBlurRadius(radius);
      return;
    }

    this._setDualKawaseBlurRadius(radius);
  }

  /**
   * The Gaussian uses one pool level, so a radius change never rebuilds the
   * pool. The tap count follows a 4-sigma cutoff; while it stays the same,
   * only kernel_scale changes and nothing is recompiled.
   */
  private _setGaussianBlurRadius(radius: number): void {
    // The radius is in screen pixels; one texel is RES_SCALE of them. The
    // sigma cap is in texels, so quarter resolution reaches twice as far.
    const RES_SCALE = this._blurDownscale >= 4 ? 4.0 : 2.0;
    const MAX_SIGMA_TEXEL = 15.0;

    // The kernel is at least one texel wide so it absorbs the downsample's
    // aliasing; a smaller radius only lowers kernel_scale.
    const MIN_SIGMA_TEXEL = 1.0;

    if (radius <= 0) {
      if (this.PASS_COUNT !== 0) {
        this.PASS_COUNT = 0;
        this._destroyTexturePool();
      }
      this._gaussianScale = 0.0;
      this._repaint();
      return;
    }

    const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);

    const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);

    // A 4-sigma cutoff (3 sigma truncated visibly), two taps per fetch, and
    // at least two pairs.
    const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
    const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));

    const needsRecompile =
      this._gaussianFetchPairs !== fetchPairs ||
      (!this._gaussianKernel && !this._pendingGaussianKernel);

    if (needsRecompile) {
      const kernel = computeGaussianKernel(kernelSigma, fetchPairs);
      this._pendingGaussianKernel = kernel;
      this._gaussianPipelineDirty = true;
      this._gaussianFetchPairs = fetchPairs;
      this._gaussianBaseSigma = kernelSigma;
      this._gaussianScale = sigmaTexel / kernelSigma;
    } else {
      this._gaussianScale = this._gaussianBaseSigma > 0
        ? sigmaTexel / this._gaussianBaseSigma
        : 1.0;
    }

    // Coming from no blur or from Dual Kawase: the next paint rebuilds the pool.
    if (this.PASS_COUNT !== 1) {
      this.PASS_COUNT = 1;
      this._destroyTexturePool();
    }

    this._repaint();
  }

  // An empirical mapping (the preferences say a Dual Kawase radius is not
  // pixel-accurate). It is not scaled for glass-blur-downscale, since that
  // would also change the pass count; at quarter resolution the same value
  // gives a wider blur.
  private _setDualKawaseBlurRadius(radius: number): void {
    let newPassCount = 0;
    let offsetDown = 0.0;
    let offsetUp = 0.0;

    if (radius > 0) {
      let p = Math.floor(Math.log2(radius + 1));
      newPassCount = Math.max(1, Math.min(4, p));

      // Position within this pass count's radius range, eased with a cubic
      // Hermite (C1 continuous) and mapped onto the tap offset.
      let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
      let nextR = Math.pow(2, newPassCount + 1) - 1;

      let t = (radius - baseR) / (nextR - baseR);
      t = Math.max(0.0, Math.min(1.0, t));

      let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;

      let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
      let maxOffset = 1.0;

      let r = minOffset + s * (maxOffset - minOffset);

      offsetDown = r;
      offsetUp = r * 1.5;
    }

    if (this.PASS_COUNT !== newPassCount ||
      this._blurRadiusDown !== offsetDown ||
      this._blurRadiusUp !== offsetUp) {
      const passCountChanged = this.PASS_COUNT !== newPassCount;

      this.PASS_COUNT = newPassCount;
      this._blurRadiusDown = offsetDown;
      this._blurRadiusUp = offsetUp;

      if (passCountChanged)
        this._destroyTexturePool();

      this._repaint();
    }
  }
}

// A menu's items seen through the glass they sit in while it changes shape:
// cut to its rounded outline and, when they are deep in it, refracted by its
// rim the way the glass refracts what is behind it. At no depth it only cuts
// round corners (the media card's cover art).
//
// Note: this implementation is inspired by and adapted from:
// https://github.com/AndrewPrifer/liquid-dom
// Big thanks to the original author (@AndrewPrifer) for the elegant solution.

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
export function rectInOffscreen(actor: Clutter.Actor, rect: number[]): { box: number[], width: number, height: number } | null {
  const volume = actor.get_paint_volume();
  if (!volume) return null;
  const origin = volume.get_origin();
  const w = Math.round(volume.get_width()) + 3, h = Math.round(volume.get_height()) + 3;
  const x0 = Math.ceil(origin.x + volume.get_width() + 0.75) - w;
  const y0 = Math.ceil(origin.y + volume.get_height() + 0.75) - h;
  const [cx, cy, cw, ch] = rect;
  return { box: [(cx - x0) / w, (cy - y0) / h, (cx + cw - x0) / w, (cy + ch - y0) / h], width: w, height: h };
}

/** Put on the actor that holds the items, clipped to the glass's box. */
export const ContentLens = GObject.registerClass(
  class ContentLens extends Clutter.OffscreenEffect {
    declare private _pipeline: Cogl.Pipeline | null;
    declare private _uniforms: {
      box: number[], px: number[], radius: number, band: number, depth: number,
      ior: number
    };
    // The glass in the actor's own px, and screen px per actor px.
    declare private _clip: number[];
    declare private _scale: number;

    _init(): void {
      super._init();
      this._pipeline = null;
      this._uniforms = { box: [0, 0, 1, 1], px: [1, 1], radius: 0, band: 1, depth: 0, ior: IOR };
      this._clip = [0, 0, 1, 1];
      this._scale = 1;
    }

    // Draws the offscreen as ClutterOffscreenEffect does, through the lens.
    vfunc_paint_target(node: Clutter.PaintNode, _paintContext: Clutter.PaintContext): void {
      const texture = this.get_texture();
      if (!texture) return;
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
    shape(clip: number[], scale: number, radius: number, depth: number): void {
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

    private _locate(): void {
      const box = rectInOffscreen(this.get_actor(), this._clip);
      if (!box) return;
      const u = this._uniforms;
      u.box = box.box;
      u.px = [box.width * this._scale, box.height * this._scale];
      this._apply();
    }

    private _apply(): void {
      const p = this._pipeline;
      if (!p) return;
      const u = this._uniforms;
      setUniformVector(p, 'lens_box', u.box);
      setUniformVector(p, 'lens_px', u.px);
      p.set_uniform_1f(p.get_uniform_location('lens_radius'), u.radius);
      p.set_uniform_1f(p.get_uniform_location('lens_band'), u.band);
      p.set_uniform_1f(p.get_uniform_location('lens_depth'), u.depth);
      p.set_uniform_1f(p.get_uniform_location('lens_ior'), u.ior);
    }
  }
);
