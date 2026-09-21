import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import type { Logger } from '../logger.js';
import { splitShader } from './shaderSource.js';

/** Owns shader sources and the base pipelines rebuilt on shader reload. */
export class ShaderPipelines {
  constructor(private _logger?: Logger) {}

  async load(extensionPath: string | undefined): Promise<void> {
    if (!extensionPath) throw new Error('Missing extension path for shader loading');
    this._downsampleSource = await this._readFileAsync(extensionPath + '/shaders/downsample.frag');
    this._upsampleSource = await this._readFileAsync(extensionPath + '/shaders/upsample.frag');
    this._glassSource = await this._readFileAsync(extensionPath + '/shaders/glass.frag');
  }

  clear(): void {
    this.downsample = null;
    this.upsample = null;
    this.composite = null;
    this.passthrough = null;
    this.boxDown = null;
  }


  // ── Compiled pipelines, reused across frames ──
  // Dual Kawase
  public downsample: Cogl.Pipeline | null = null;

  public upsample: Cogl.Pipeline | null = null;
 // vertical pass
  public composite: Cogl.Pipeline | null = null;

  // [PERF] Plain 1-tap resample. Two passes only ever needed a straight copy
  // with a UV remap — the crop, and the Gaussian's half-res pre-pass — and
  // both got it by running downsample.frag with blur_radius = 0, which
  // collapses that shader's 5-tap Kawase kernel onto the center sample. The
  // maths is right but the cost is not: the four collapsed taps still issue
  // four texture fetches at the same coordinate. A pipeline with no fragment
  // snippet at all does exactly one fetch — Cogl's default layer combine for
  // layer 0 is MODULATE(pipeline color, texture), and the pipeline color is
  // opaque white — so it is the same passthrough for a quarter of the
  // bandwidth. The crop pass runs at FULL resolution, so this is the larger
  // of the two savings.
  public passthrough: Cogl.Pipeline | null = null;

  // [PERF] Exact 4x4 box filter, used as the first pass when
  // glass-blur-downscale is 4. See _initPipelines().
  public boxDown: Cogl.Pipeline | null = null;


  // ── Shader Sources ──
  private _downsampleSource: string | null = null;

  private _upsampleSource: string | null = null;

  private _glassSource: string | null = null;


  /**
  * Gio.File を使ってファイルを非同期で読み込み、文字列として返すPromise関数
  */
  private _readFileAsync(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = Gio.File.new_for_path(path);
      file.load_contents_async(null, (_, res) => {
        try {
          const [ok, bytes] = file.load_contents_finish(res);
          if (!ok) {
            reject(new Error(`load_contents_finish returned false for ${path}`));
          } else {
            resolve(new TextDecoder('utf-8').decode(bytes));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }


  // ─── Pipeline initialization (deferred until the first frame, once a Cogl context exists) ──

  /**
   * Compiles and caches the downsample / upsample / composite Cogl.Pipeline
   * objects. Call only once.
   */
  initialize(ctx: Cogl.Context): void {
    // ── Downsample pipeline ──────────────────────────────────────────────────
    this.downsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.downsample, 0);

    if (this._downsampleSource) {
      const downSnippet = splitShader(this._downsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
      s.set_replace(downSnippet.body);
      this.downsample.add_snippet(s);
    }

    // ── Upsample pipeline ────────────────────────────────────────────────────
    this.upsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.upsample, 0);

    if (this._upsampleSource) {
      const upSnippet = splitShader(this._upsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, upSnippet.decl, null);
      s.set_replace(upSnippet.body);
      this.upsample.add_snippet(s);
    }
    // ── Passthrough pipeline ─────────────────────────────────────────────────
    // Deliberately has NO fragment snippet: Cogl's default processing for a
    // pipeline with one layer is a single texture fetch modulated by the
    // pipeline color (opaque white by default), i.e. exactly a 1-tap copy.
    // Used by the crop pass and the Gaussian pre-pass; see the field comment.
    this.passthrough = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.passthrough, 0);

    // ── 4x4 box downsample pipeline ─────────────────────────────────────────
    // [PERF] The correct minification filter for a 4x reduction, used as the
    // first blur pass when glass-blur-downscale is 4.
    //
    // Why not the passthrough (which IS correct at 2x): a destination texel
    // covers a 4x4 source block, and one bilinear fetch at its centre averages
    // only the inner 2x2 — it point-samples one texel in four and aliases hard
    // on text and on anything moving.
    //
    // Why not downsample.frag: its kernel is centre*4 + four corners, all /8,
    // which leaves the inner 2x2 weighted five times as heavily as the outer
    // ring — better than one tap, still not flat.
    //
    // These four taps land exactly on source texel corners (the destination
    // texel centre maps to source position 4i+2, and +-1 from there is 4i+1 /
    // 4i+3), so each bilinear fetch averages one 2x2 quadrant and the four
    // quadrants tile the 4x4 block with equal weight — a true box filter, in
    // four fetches instead of five.
    this.boxDown = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.boxDown, 0);
    {
      const boxSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        'uniform vec2 inv_size;\n', null);
      boxSnip.set_replace(
        'vec2 uv = cogl_tex_coord_in[0].st;\n' +
        'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
        'cogl_color_out = c * 0.25;\n');
      this.boxDown.add_snippet(boxSnip);
    }

    // ── Gaussian H/V pipelines ───────────────────────────────────────────────
    // Not precompiled here: the separable Gaussian blur builds its shader
    // source dynamically from the kernel computed in setBlurRadius(), and
    // _compileGaussianPipelines() compiles it lazily inside
    // vfunc_paint_target (see _computeGaussianKernel / _buildGaussianSnippet).

    // ── Composite pipeline (glass.frag) ──────────────────────────────────────
    this.composite = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.composite, 0);

    // Standard premultiplied-alpha blending, equivalent to ShaderEffect's default:
    // "src.rgb + dst.rgb * (1 - src.a)"
    this.composite.set_blend(
      'RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
    );

    this._loadCompositeShader();


  }


  /**
   * Loads glass.frag, rewrites its "cogl_sampler" (the uniform name used by
   * the old ShaderEffect) to "cogl_sampler0" (the name Cogl auto-declares for
   * a FRAGMENT-hook layer 0), and adds it to the composite pipeline as a
   * snippet.
   *
   * The original "uniform sampler2D cogl_sampler;" declaration is stripped
   * since cogl_sampler0 is already declared automatically by Cogl.
   */
  private _loadCompositeShader(): void {
    if (!this.composite || !this._glassSource) return;

    let { decl, body } = splitShader(this._glassSource, message => this._logger?.warn(message));

    // Rewrite the ShaderEffect-style sampler name to the FRAGMENT-hook name.
    decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
    body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');

    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
    snippet.set_replace(body);
    this.composite.add_snippet(snippet);
  }
}


/**
 * Shared helper: sets bilinear filtering and clamp-to-edge wrapping on
 * layer 0 of a pipeline.
 */
export function configureSamplerLayer(pipeline: Cogl.Pipeline, layer: number): void {
  pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  pipeline.set_layer_filters(
    layer,
    Cogl.PipelineFilter.LINEAR,     // minification
    Cogl.PipelineFilter.LINEAR      // magnification
  );
}
