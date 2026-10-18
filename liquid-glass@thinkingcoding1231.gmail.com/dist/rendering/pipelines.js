"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHAPE_LAYER = exports.ShaderPipelines = void 0;
exports.configureSamplerLayer = configureSamplerLayer;
const 1 = __importDefault(require("gi://Cogl"));
const 2 = __importDefault(require("gi://Gio"));
const shaderSource_js_1 = require("./shaderSource.js");
const shellVersion_js_1 = require("../shellVersion.js");

class ShaderPipelines {
    _logger;
    _shapeTexture;
    // `shapeTexture`: the composite takes the glass's outline from a distance
    // field on layer 2 (glass text) instead of the rounded rect.
    constructor(_logger, _shapeTexture = false) {
        this._logger = _logger;
        this._shapeTexture = _shapeTexture;
    }
    async load(extensionPath, cancellable = null) {
        if (!extensionPath)
            throw new Error('Missing extension path for shader loading');
        this._downsampleSource = await this._readFileAsync(extensionPath + '/shaders/downsample.frag', cancellable);
        this._upsampleSource = await this._readFileAsync(extensionPath + '/shaders/upsample.frag', cancellable);
        this._glassSource = await this._readFileAsync(extensionPath + '/shaders/glass.frag', cancellable);
    }
    clear() {
        this.downsample = null;
        this.upsample = null;
        this.composite = null;
        this.passthrough = null;
        this.boxDown = null;
    }
    // Compiled once and reused across frames. downsample/upsample are Dual Kawase.
    downsample = null;
    upsample = null;
    composite = null;
    // A plain one-fetch copy with a UV remap, for the Gaussian's half-res
    // pre-pass. No snippet: Cogl's default combine modulates the
    // texture by the pipeline color, which is opaque white.
    passthrough = null;
    // A 4x4 box filter, the first pass when glass-blur-downscale is 4.
    boxDown = null;
    _downsampleSource = null;
    _upsampleSource = null;
    _glassSource = null;
    // load_contents_finish() throws a GError when the file cannot be read.
    _readFileAsync(path, cancellable) {
        return new Promise((resolve, reject) => {
            const file = 2.default.File.new_for_path(path);
            file.load_contents_async(cancellable, (_, res) => {
                try {
                    const [ok, bytes] = file.load_contents_finish(res);
                    if (!ok) {
                        reject(new Error(`load_contents_finish returned false for ${path}`));
                    }
                    else {
                        resolve(new TextDecoder('utf-8').decode(bytes));
                    }
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
    /**
     * Compiles the pipelines. Runs on the first frame, once a Cogl context
     * exists; call clear() first to recompile.
     */
    initialize(ctx) {
        this.downsample = 1.default.Pipeline.new(ctx);
        configureSamplerLayer(this.downsample, 0);
        if (this._downsampleSource) {
            const downSnippet = (0, shaderSource_js_1.splitShader)(this._downsampleSource, message => this._logger?.warn(message));
            const s = 1.default.Snippet.new(1.default.SnippetHook.FRAGMENT, (0, shellVersion_js_1.uniformDeclarations)(downSnippet.decl), null);
            s.set_replace(downSnippet.body);
            this.downsample.add_snippet(s);
        }
        this.upsample = 1.default.Pipeline.new(ctx);
        configureSamplerLayer(this.upsample, 0);
        if (this._upsampleSource) {
            const upSnippet = (0, shaderSource_js_1.splitShader)(this._upsampleSource, message => this._logger?.warn(message));
            const s = 1.default.Snippet.new(1.default.SnippetHook.FRAGMENT, (0, shellVersion_js_1.uniformDeclarations)(upSnippet.decl), null);
            s.set_replace(upSnippet.body);
            this.upsample.add_snippet(s);
        }
        this.passthrough = 1.default.Pipeline.new(ctx);
        configureSamplerLayer(this.passthrough, 0);
        // For a 4x reduction a single bilinear fetch covers only the inner 2x2 of
        // each 4x4 block and aliases. These four taps land on source texel
        // corners, so each fetch averages one 2x2 quadrant and together they
        // weigh the whole block equally.
        this.boxDown = 1.default.Pipeline.new(ctx);
        configureSamplerLayer(this.boxDown, 0);
        {
            const boxSnip = 1.default.Snippet.new(1.default.SnippetHook.FRAGMENT, (0, shellVersion_js_1.uniformDeclarations)('uniform vec2 inv_size;\n'), null);
            boxSnip.set_replace('vec2 uv = cogl_tex_coord_in[0].st;\n' +
                'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
                'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
                'cogl_color_out = c * 0.25;\n');
            this.boxDown.add_snippet(boxSnip);
        }
        // The Gaussian pipelines depend on the blur radius and are compiled by
        // BlurRenderer when needed.
        this.composite = 1.default.Pipeline.new(ctx);
        configureSamplerLayer(this.composite, 0);
        if (this._shapeTexture)
            configureSamplerLayer(this.composite, exports.SHAPE_LAYER);
        // Premultiplied-alpha "over", as ShaderEffect blends by default.
        this.composite.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        this._loadCompositeShader();
    }
    /**
     * Adds glass.frag to the composite pipeline. The shader uses ShaderEffect's
     * "cogl_sampler", which becomes "cogl_sampler0", the name Cogl declares for
     * layer 0 in a fragment snippet; the shader's own declaration is dropped.
     */
    _loadCompositeShader() {
        if (!this.composite || !this._glassSource)
            return;
        let { decl, body } = (0, shaderSource_js_1.splitShader)(this._glassSource, message => this._logger?.warn(message));
        decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
        body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
        if (this._shapeTexture)
            decl = `#define LG_SHAPE_TEXTURE 1\n${decl}`;
        const snippet = 1.default.Snippet.new(1.default.SnippetHook.FRAGMENT, (0, shellVersion_js_1.uniformDeclarations)(decl), null);
        snippet.set_replace(body);
        this.composite.add_snippet(snippet);
    }
}
exports.ShaderPipelines = ShaderPipelines;
// The composite's layer for the distance field of a shape-texture glass.
exports.SHAPE_LAYER = 2;
// Bilinear filtering and clamp-to-edge on one layer.

function configureSamplerLayer(pipeline, layer) {
    pipeline.set_layer_wrap_mode(layer, 1.default.PipelineWrapMode.CLAMP_TO_EDGE);
    pipeline.set_layer_filters(layer, 1.default.PipelineFilter.LINEAR, 1.default.PipelineFilter.LINEAR);
}
