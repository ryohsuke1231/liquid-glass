// src/liquidEffect.ts
//
// ─── 設計概要 ──────────────────────────────────────────────────────────────────
//
//  旧実装: Clutter.ShaderEffect を継承し、glass.frag 1 本で
//          屈折・リムライト・シャドウをすべて処理。
//          ブラーは ShaderEffect の cogl_sampler に依存した
//          単純なテクスチャサンプリングのみ。
//
//  新実装: Clutter.OffscreenEffect を継承し、vfunc_paint_target を
//          オーバーライドして自前の FBO マルチパスを実行。
//
//  レンダリングパイプライン (1 フレーム):
//
//    ┌──────────────────────────────────────────────────────┐
//    │  OffscreenEffect が自動的にアクターの描画内容を       │
//    │  内部 FBO に取り込む (get_texture() で取得可能)       │
//    └────────────────────┬─────────────────────────────────┘
//                         │ srcTex (フルモニター解像度)
//                         ▼
//    ┌──────────────── Downsample ──────────────────────────┐
//    │  Pass 0: srcTex    → _blurFbos[0]  (w/2  × h/2)    │
//    │  Pass 1: _tex[0]   → _blurFbos[1]  (w/4  × h/4)    │
//    │  Pass 2: _tex[1]   → _blurFbos[2]  (w/8  × h/8)    │
//    │  Pass 3: _tex[2]   → _blurFbos[3]  (w/16 × h/16)   │
//    │  (shaders/downsample.frag – Dual Kawase 5-tap)       │
//    └────────────────────┬─────────────────────────────────┘
//                         │
//    ┌──────────────── Upsample ────────────────────────────┐
//    │  Pass 3→2: _tex[3] → _blurFbos[2]                   │
//    │  Pass 2→1: _tex[2] → _blurFbos[1]                   │
//    │  Pass 1→0: _tex[1] → _blurFbos[0]  (w/2 × h/2)     │
//    │  (shaders/upsample.frag – Dual Kawase tent 8-tap)    │
//    └────────────────────┬─────────────────────────────────┘
//                         │ _blurTextures[0] (ぼかし済み w/2 × h/2)
//                         ▼
//    ┌──────────────── Glass Composite ────────────────────┐
//    │  shaders/glass.frag を実行時パース → Cogl snippet   │
//    │  cogl_sampler0 = ぼかし済みテクスチャ               │
//    │  → 屈折 / 色収差 / リムライト / シャドウを適用      │
//    │  → screenFb (Clutter が準備した画面 FB) へ描画      │
//    └─────────────────────────────────────────────────────┘
//
//  テクスチャプールは解像度変更時に作り直す。
//  Cogl パイプラインは初回フレームで 1 度だけコンパイルし再利用。
//
// ─────────────────────────────────────────────────────────────────────────────
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
// ─── メインクラス ─────────────────────────────────────────────────────────────
export const LiquidEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassEffect',
}, class LiquidEffect extends Clutter.OffscreenEffect {
    // ─── _init ──────────────────────────────────────────────────────────────────
    _init(params) {
        const extensionPath = params.extensionPath;
        const settings = params.settings;
        delete params.extensionPath;
        delete params.settings;
        super._init(params);
        this._blurTextures = [];
        this._blurFbos = [];
        this._gaussianTempTextures = [];
        this._gaussianTempFbos = [];
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compositePipeline = null;
        this._compUniforms = new Map();
        this._pendingUniforms = new Map();
        this._poolWidth = 0;
        this._poolHeight = 0;
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
        this._debugCropAnchor = 1;
        this._debugH1FrameCounter = 0;
        this._debugH1Enabled = true; // 検証が終わったら false に
        this.PASS_COUNT = 4;
        this._blurRadiusDown = 0.5;
        this._blurRadiusUp = 1.0;
        this._blurMethod = 1; // デフォルト: Dual Kawase
        this._targetRadius = 15.0;
        this._gaussianKernel = null;
        this._pendingGaussianKernel = null;
        this._gaussianPipelineDirty = false;
        this._gaussianBaseSigma = 0;
        this._gaussianScale = 1.0;
        this._gaussianFetchPairs = 0;
        this._extensionPath = extensionPath;
        this._settings = settings;
        console.log(`[Liquid Glass] Initing LiquidEffect (OffscreenEffect). path: ${this._extensionPath}`);
        // ── コンポジットシェーダー用ユニフォームのデフォルト値を設定 ──
        // パイプラインはまだ存在しないため _pendingUniforms に蓄積される。
        this._setFloat('resolution_x', 0.0);
        this._setFloat('resolution_y', 0.0);
        this._setFloat('pointer_x', -100.0);
        this._setFloat('pointer_y', -100.0);
        this._setFloat('intensity', 0.0);
        this._setFloat('corner_radius', 60.0);
        this._setFloat('brightness', 1.0);
        this._setFloat('contrast', 1.0);
        this._setFloat('saturation', 1.0);
        this._setFloat('padding', 20.0);
        this._setFloat('isDock', 0.0);
        // フルスクリーン FBO モード用: ドック位置をシェーダーに伝える
        this._setFloat('dock_x', 0.0);
        this._setFloat('dock_y', 0.0);
        this._setFloat('dock_w', 0.0);
        this._setFloat('dock_h', 0.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            // GSettings が無い場合のフォールバックデフォルト
            this._setFloat('max_z', 25.0);
            this._setFloat('displacement_scale', 78.5);
            this._setFloat('edge_smoothing', 2.0);
            this._setFloat('profile_shape_n', 7.0);
            this._setFloat('ior', 2.40);
            this._setFloat('chroma_strength', 0.006);
            this._setFloat('specular_intensity', 0.0);
            this._setFloat('shininess', 42.0);
            this._setFloat('rim_width', 5.0);
            this._setFloat('rim_intensity', 0.6);
            this._setFloat('rim_directional_power', 2.7);
            this._setFloat('rim_power', 6.0);
            this._setFloat('rim_light_color_intensity', 1.4);
            this._setFloat('sheen_intensity', 0.32);
            this._setFloat('light_angle_deg', 0.0);
            this._setFloat('shadow_radius', 8.0);
            this._setFloat('shadow_intensity', 0.55);
            this._setFloat('tint_strength', 0.0);
            this._setFloat('tint_r', 1.0);
            this._setFloat('tint_g', 1.0);
            this._setFloat('tint_b', 1.0);
        }
    }
    // ─── パイプライン初期化 (遅延実行 – 初回フレームで Cogl コンテキストが利用可能になってから) ──
    /**
     * ダウンサンプル / アップサンプル / コンポジット の 3 つの
     * Cogl.Pipeline をコンパイルしてキャッシュする。
     * 一度だけ呼び出すこと。
     */
    _initPipelines(ctx) {
        // ── Downsample pipeline ──────────────────────────────────────────────────
        this._downsamplePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._downsamplePipeline, 0);
        const downSnippet = this._loadShaderSnippet(`${this._extensionPath}/shaders/downsample.frag`);
        if (downSnippet) {
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
            s.set_replace(downSnippet.body);
            this._downsamplePipeline.add_snippet(s);
        }
        // ── Upsample pipeline ────────────────────────────────────────────────────
        this._upsamplePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._upsamplePipeline, 0);
        const upSnippet = this._loadShaderSnippet(`${this._extensionPath}/shaders/upsample.frag`);
        if (upSnippet) {
            const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, upSnippet.decl, null);
            s.set_replace(upSnippet.body);
            this._upsamplePipeline.add_snippet(s);
        }
        // ── Gaussian H/V pipeline ────────────────────────────────────────────────
        // 注: 分離型 Gaussian Blur のパイプラインはここでは事前コンパイルしない。
        // setBlurRadius() で算出されたカーネル (フェッチ数・重み・オフセット) に基づき、
        // _compileGaussianPipelines() が vfunc_paint_target 内で遅延コンパイルする
        // (動的シェーダー生成方式。詳細は _computeGaussianKernel / _buildGaussianSnippet 参照)。
        // ── Composite pipeline (glass.frag) ──────────────────────────────────────
        this._compositePipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._compositePipeline, 0);
        // Clutter / Cogl の標準プリマルチプライドα合成
        // "src.rgb + dst.rgb * (1 - src.a)"
        // (ShaderEffect のデフォルトと同等)
        this._compositePipeline.set_blend('RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))');
        this._loadCompositeShader();
        // パイプライン生成前にバッファされていたユニフォームを一括適用
        this._applyPendingUniforms();
    }
    /**
     * パイプラインのレイヤー 0 にバイリニアフィルタリングと
     * クランプラッピングを設定する共通ヘルパー。
     */
    _configureSamplerLayer(pipeline, layer) {
        pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        pipeline.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, // minification
        Cogl.PipelineFilter.LINEAR // magnification
        );
    }
    /**
     * シェーダーファイルを読み込んで ShaderSnippet に解析する。
     * GLSL の "void main()" の前後で分割し、
     *   decl = 宣言部 (uniform / 関数定義)
     *   body = main() の本体
     * を返す。失敗した場合は null を返す。
     */
    _loadShaderSnippet(path) {
        const file = Gio.File.new_for_path(path);
        let bytes;
        try {
            const [ok, b] = file.load_contents(null);
            if (!ok)
                throw new Error('load_contents returned false');
            bytes = b;
        }
        catch (e) {
            console.error(`[Liquid Glass] Failed to load shader: ${path}\n${e}`);
            return null;
        }
        const src = new TextDecoder('utf-8').decode(bytes);
        return this._splitShader(src);
    }
    /**
     * GLSL ソースを "void main()" の境界で
     * { decl, body } に分割する。
     */
    _splitShader(src) {
        const match = src.match(/void\s+main\s*\(\s*\)\s*\{/);
        if (!match || match.index === undefined) {
            console.warn('[Liquid Glass] void main() not found; treating entire source as decl.');
            return { decl: src, body: '' };
        }
        const decl = src.substring(0, match.index);
        const rest = src.substring(match.index + match[0].length);
        // 対応する閉じ括弧を探す
        let depth = 1;
        let bodyEnd = 0;
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === '{')
                depth++;
            else if (rest[i] === '}') {
                depth--;
                if (depth === 0) {
                    bodyEnd = i;
                    break;
                }
            }
        }
        return { decl, body: rest.substring(0, bodyEnd) };
    }
    /**
     * glass.frag を読み込み、ShaderEffect 用の "cogl_sampler" を
     * FRAGMENT フック用の "cogl_sampler0" に書き換えてから
     * コンポジットパイプラインにスニペットとして追加する。
     *
     * cogl_sampler0 は Cogl が layer 0 用に自動宣言するため、
     * glass.frag の "uniform sampler2D cogl_sampler;" 宣言は削除する。
     */
    _loadCompositeShader() {
        if (!this._compositePipeline)
            return;
        const snippetData = this._loadShaderSnippet(`${this._extensionPath}/shaders/glass.frag`);
        if (!snippetData)
            return;
        let { decl, body } = snippetData;
        // ShaderEffect の sampler 名 → FRAGMENT フック用の sampler 名に変換
        /*
        decl = decl.replace('uniform sampler2D cogl_sampler;\n', '');
        decl = decl.replace('uniform sampler2D cogl_sampler;', '');
        decl = decl.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
        */
        decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
        body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
        snippet.set_replace(body);
        this._compositePipeline.add_snippet(snippet);
    }
    // ─── 動的 Gaussian カーネル計算・シェーダー生成 ───────────────────────────
    /**
     * 半解像度 texel 空間における標準偏差 (σ) と必要フェッチペア数から、
     * 線形サンプリング最適化済みの 1D ガウスカーネルを算出する。
     *
     * 算出方法:
     *   1. i = 0..(fetchPairs*2) の離散ガウス重みを計算し正規化する。
     *   2. i = 0 (中心) はそのまま単独サンプルとして扱う。
     *   3. i, i+1 のペアを 1 フェッチに合成する (線形サンプリング最適化):
     *        合成重み  = w(i) + w(i+1)
     *        合成オフセット = (i・w(i) + (i+1)・w(i+1)) / 合成重み
     *
     * fetchPairs を固定すれば、生成される offsets/weights の "形" (= シェーダー
     * コードの構造) は一意に決まる。σ が変化しても fetchPairs が変わらない限り
     * シェーダーの再生成は不要 — 呼び出し側は kernel_scale ユニフォームのみを
     * 更新すればよい (setBlurRadius 参照)。
     */
    _computeGaussianKernel(sigma, fetchPairs) {
        const sideTaps = Math.max(2, fetchPairs * 2);
        // 離散ガウス重み (i = 0..sideTaps) を算出して正規化する
        const raw = [];
        let sum = 0;
        for (let i = 0; i <= sideTaps; i++) {
            const w = Math.exp(-(i * i) / (2 * sigma * sigma));
            raw.push(w);
            sum += (i === 0) ? w : w * 2;
        }
        for (let i = 0; i <= sideTaps; i++) {
            raw[i] /= sum;
        }
        const offsets = [0];
        const weights = [raw[0]];
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
     * GaussianKernel から GLSL フラグメントシェーダーのスニペット文字列を
     * 動的に組み立てる (アンロール展開型 — for ループを使用しない)。
     *
     * オフセットは GLSL 側の定数として埋め込み、実行時には kernel_scale
     * ユニフォームを乗算することで σ の微調整 (再コンパイル無し) を可能にする。
     * 重みはカーネル形状そのもの (フェッチ数) を表すため、再コンパイルが
     * 必要な場合のみ更新される定数として埋め込む。
     */
    _buildGaussianSnippet(kernel, direction) {
        const decl = `uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */\n` +
            `uniform float kernel_scale; /* sigma 比に基づく動的スケール (再コンパイル回避用) */\n`;
        const lines = [];
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
    /**
     * 動的生成された GaussianKernel から H/V 両パイプラインをコンパイルする。
     * 既存のパイプライン参照は呼び出し側で破棄しておくこと
     * (run_dispose() は呼ばず、GJS の GC に解放を任せる)。
     */
    _compileGaussianPipelines(ctx, kernel) {
        this._gaussianHPipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._gaussianHPipeline, 0);
        const hSnippet = this._buildGaussianSnippet(kernel, 'h');
        const hSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, hSnippet.decl, null);
        hSnip.set_replace(hSnippet.body);
        this._gaussianHPipeline.add_snippet(hSnip);
        this._gaussianVPipeline = Cogl.Pipeline.new(ctx);
        this._configureSamplerLayer(this._gaussianVPipeline, 0);
        const vSnippet = this._buildGaussianSnippet(kernel, 'v');
        const vSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, vSnippet.decl, null);
        vSnip.set_replace(vSnippet.body);
        this._gaussianVPipeline.add_snippet(vSnip);
        this._gaussianKernel = kernel;
        this._gaussianPipelineDirty = false;
        this._pendingGaussianKernel = null;
        console.log(`[Liquid Glass] Gaussian シェーダー再生成: fetchPairs=${this._gaussianFetchPairs} ` +
            `(taps=${1 + 2 * (kernel.offsets.length - 1)})`);
    }
    // ─── テクスチャプール管理 ─────────────────────────────────────────────────
    /**
     * 解像度 (w, h) に対応したブラー用テクスチャ + FBO のペアを生成する。
     *
     * インデックスと解像度の対応:
     *   [0]: w>>1 × h>>1  (= w/2)
     *   [1]: w>>2 × h>>2  (= w/4)
     *   ...
     *   [PASS_COUNT-1]: w >> PASS_COUNT
     */
    _buildTexturePool(ctx, w, h) {
        this._destroyTexturePool();
        let pw = Math.max(w >> 1, 1);
        let ph = Math.max(h >> 1, 1);
        for (let i = 0; i < this.PASS_COUNT; i++) {
            try {
                // Dual Kawase / Gaussian 共用のメインバッファ
                const tex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const fbo = Cogl.Offscreen.new_with_texture(tex);
                this._blurTextures.push(tex);
                this._blurFbos.push(fbo);
                // Gaussian 水平パス用の中間バッファ (同解像度)
                const tmpTex = Cogl.Texture2D.new_with_size(ctx, pw, ph);
                const tmpFbo = Cogl.Offscreen.new_with_texture(tmpTex);
                this._gaussianTempTextures.push(tmpTex);
                this._gaussianTempFbos.push(tmpFbo);
            }
            catch (e) {
                console.error(`[Liquid Glass] テクスチャプール生成失敗 pass ${i} (${pw}x${ph}): ${e}`);
                this._destroyTexturePool();
                return;
            }
            pw = Math.max(pw >> 1, 1);
            ph = Math.max(ph >> 1, 1);
        }
        this._poolWidth = w;
        this._poolHeight = h;
        console.log(`[Liquid Glass] テクスチャプール構築完了: ` +
            `${w}x${h} → ${this.PASS_COUNT} パス`);
    }
    /**
     * テクスチャプールを解放し、メンバーをリセットする。
     * GJS の GC が Cogl オブジェクトのファイナライズを担うが、
     * 参照をクリアすることで即座に GC 候補にできる。
     */
    /**
     * Dual Kawase Blur を実行する。
     *
     *   ダウンサンプルフェーズ: srcTex → [0] → [1] → ... → [PASS_COUNT-1]
     *   アップサンプルフェーズ: [PASS_COUNT-1] → ... → [0]
     *
     * 結果は _blurTextures[0] に格納される。
     */
    _runDualKawaseBlur(srcTex) {
        let currentSrc = srcTex;
        // ── ダウンサンプルフェーズ ──────────────────────────────────────────
        for (let i = 0; i < this.PASS_COUNT; i++) {
            const destFbo = this._blurFbos[i];
            const destTex = this._blurTextures[i];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / currentSrc.get_width();
            const invH = 1.0 / currentSrc.get_height();
            this._downsamplePipeline.set_layer_texture(0, currentSrc);
            this._setPipelineVec2(this._downsamplePipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(this._downsamplePipeline, 'blur_radius', this._blurRadiusDown);
            destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
            destFbo.orthographic(0, 0, destW, destH, -1, 1);
            destFbo.draw_textured_rectangle(this._downsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
            // パス後に即フラッシュして FBO の依存関係チェーンをクリアする。
            destFbo.flush();
            currentSrc = destTex;
        }
        // ── アップサンプルフェーズ ──────────────────────────────────────────
        for (let i = this.PASS_COUNT - 1; i > 0; i--) {
            const srcTexture = this._blurTextures[i];
            const destFbo = this._blurFbos[i - 1];
            const destTex = this._blurTextures[i - 1];
            const destW = destTex.get_width();
            const destH = destTex.get_height();
            const invW = 1.0 / srcTexture.get_width();
            const invH = 1.0 / srcTexture.get_height();
            this._upsamplePipeline.set_layer_texture(0, srcTexture);
            this._setPipelineVec2(this._upsamplePipeline, 'inv_size', invW, invH);
            this._setPipelineFloat(this._upsamplePipeline, 'blur_radius', this._blurRadiusUp);
            destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
            destFbo.orthographic(0, 0, destW, destH, -1, 1);
            destFbo.draw_textured_rectangle(this._upsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
            destFbo.flush();
        }
    }
    /**
     * 分離型 Gaussian Blur を実行する。
     *
     * 方式A (動的シェーダー生成) では PASS_COUNT は常に 1 に固定され、
     * テクスチャプールも w/2 × h/2 の 1 階層のみを使用する
     * (半径変更によるプール再構築・パス数変動は発生しない)。
     *
     *   srcTex → [gaussianTemp[0]] (水平パス) → [blurTextures[0]] (垂直パス)
     *
     * H/V パイプラインは setBlurRadius() で算出されたカーネルに基づき
     * 動的に生成・コンパイルされたものを使用する (アンロール展開済み)。
     * 結果は _blurTextures[0] に格納される。
     */
    _runGaussianBlur(srcTex) {
        const tempFbo = this._gaussianTempFbos[0];
        const tempTex = this._gaussianTempTextures[0];
        const destFbo = this._blurFbos[0];
        const destTex = this._blurTextures[0];
        const destW = destTex.get_width();
        const destH = destTex.get_height();
        const srcW = srcTex.get_width();
        const srcH = srcTex.get_height();
        // ── 0. プリパス: srcTex (フル解像度) → destTex (半解像度) ──────────────
        // 単純なバイリニアダウンサンプルを行い、H/V パスが同一の半解像度空間で
        // 動作できるようにする。（Dual Kawase用のパイプラインを半径0で流用）
        this._downsamplePipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(this._downsamplePipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        this._setPipelineFloat(this._downsamplePipeline, 'blur_radius', 0.0);
        destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        destFbo.orthographic(0, 0, destW, destH, -1, 1);
        destFbo.draw_textured_rectangle(this._downsamplePipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        destFbo.flush();
        // ── 1. 水平パス: destTex (半解像度) → tempTex (半解像度) ──────────────
        // 入力がすでに半解像度になったため、以前の RES_SCALE (=2.0) の補正は削除。
        // inv_size も destW, destH (半解像度) を基準にする。
        this._gaussianHPipeline.set_layer_texture(0, destTex);
        this._setPipelineVec2(this._gaussianHPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(this._gaussianHPipeline, 'kernel_scale', this._gaussianScale);
        tempFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        tempFbo.orthographic(0, 0, destW, destH, -1, 1);
        tempFbo.draw_textured_rectangle(this._gaussianHPipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        tempFbo.flush();
        // ── 2. 垂直パス: tempTex (半解像度) → destTex (半解像度) ───────────────
        this._gaussianVPipeline.set_layer_texture(0, tempTex);
        this._setPipelineVec2(this._gaussianVPipeline, 'inv_size', 1.0 / destW, 1.0 / destH);
        this._setPipelineFloat(this._gaussianVPipeline, 'kernel_scale', this._gaussianScale);
        destFbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        destFbo.orthographic(0, 0, destW, destH, -1, 1);
        destFbo.draw_textured_rectangle(this._gaussianVPipeline, 0, 0, destW, destH, 0, 0, 1, 1);
        destFbo.flush();
    }
    _destroyTexturePool() {
        // run_dispose() は GJS 管理下の GObject に対して呼ぶと
        // GJS の GC が後から同じオブジェクトを再度 unref しようとして
        // 二重解放になり "free(): invalid size" → SIGABRT を引き起こす。
        // 参照をクリアするだけで GC に任せれば安全に VRAM が回収される。
        this._blurFbos = [];
        this._blurTextures = [];
        this._gaussianTempFbos = [];
        this._gaussianTempTextures = [];
        this._poolWidth = 0;
        this._poolHeight = 0;
    }
    // ─── クロップパス (OffscreenEffect FBO パディング対策) ─────────────────────
    //
    // 【背景】DEBUG-H1 ログにより、get_texture() が返す FBO テクスチャの実サイズが
    // アクターの論理サイズ (actor.get_size()) より常に数 px 大きいことが判明した
    // (例: alloc=1920x1080 に対し tex=1923x1083)。この差はユーザー設定・BMS の
    // sigma 等いずれとも相関せず、Cogl/Clutter 内部で OffscreenEffect の FBO が
    // アクターの論理サイズより大きく確保されるために生じる固定的なパディングと
    // 考えられる。
    //
    // vfunc_paint_target がこのパディング込みのサイズをそのまま
    // "本当の解像度" として扱っていたため、
    //   - 最終コンポジットの描画先矩形
    //   - ブラーテクスチャプールの解像度計算 (半解像度チェーンの基準)
    // の両方にパディング分の余剰が混入し、パディング領域のゴミ (未定義内容)
    // が右下方向に描画されたり、奇数サイズに対するビットシフト (w >> 1) の
    // 丸め誤差がブラーパスを重ねるごとに蓄積し、raw レイヤーと blur レイヤーの
    // 間に数 px のズレを生む、という一連の症状につながっていたと考えられる。
    //
    // 【対策】get_texture() のサイズを信用せず、常に actor.get_size() を正とする。
    // 差がある場合は、有効領域だけを切り出した専用テクスチャ (_cropTexture) を
    // 1 パスだけ生成し、以降のブラー・コンポジットは全てこちらを入力として使う。
    // 追加シェーダーは不要 — downsample.frag を blur_radius = 0 で使うと
    // 5-tap Kawase カーネルの全オフセットが中心画素に収束するため、
    // 単純なパススルー (かつ UV 範囲の変換) として流用できる。
    /**
     * クロップ用 FBO/テクスチャを (w, h) に合わせて確保し直す。
     * サイズが変わらない限り再利用する。
     */
    _ensureCropTarget(ctx, w, h) {
        if (this._cropTexture && this._cropFbo &&
            this._cropPoolW === w && this._cropPoolH === h) {
            return true;
        }
        // 古い参照はクリアするだけ (GJS GC に解放を任せる。理由は _destroyTexturePool と同様)
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
            console.error(`[Liquid Glass] クロップ用テクスチャ生成失敗 (${w}x${h}): ${e}`);
            return false;
        }
    }
    /**
     * srcTex (パディングを含む可能性のある OffscreenEffect の生テクスチャ) から、
     * アクターの論理サイズ (allocW x allocH) ぶんだけを正確に切り出した
     * テクスチャを返す。切り出しが不要 (パディング無し) の場合は srcTex を
     * そのまま返す。
     */
    _cropSourceTexture(ctx, srcTex, srcW, srcH, allocW, allocH) {
        if (allocW === srcW && allocH === srcH) {
            return srcTex;
        }
        if (!this._downsamplePipeline) {
            // パイプライン未初期化ならクロップできないので諦めて生テクスチャを返す
            return srcTex;
        }
        if (!this._ensureCropTarget(ctx, allocW, allocH)) {
            return srcTex;
        }
        // srcTex の有効領域 (パディングを除いた本当のコンテンツ) の UV 範囲。
        //
        // 【未検証だった前提】これまで「パディングは常に右下側に付与され、
        // 有効なコンテンツは原点 (0,0) アンカーである」という仮定のもとで
        // (0,0)-(uMax,vMax) を切り出していた。しかしこの仮定を裏付ける直接
        // 証拠 (ピクセル読み出し等) は取れていなかった。marker 実験で形状計算
        // (dock_x/y/w/h 周り) は完全に正しいと確定した一方、背景コンテンツの
        // 数pxズレが残っていることから、この「アンカー位置の仮定」自体が
        // 誤っている可能性が高い。
        //
        // _debugCropAnchor で切り出し位置を切り替えられるようにし、
        // 実機でどのアンカーが正しいかを実験的に確定させる:
        //   0 = 左上アンカー (これまでの仮定。パディングは右下に付与)
        //   1 = 中央アンカー (パディングは全周に均等分配)
        //   2 = 右下アンカー (パディングは左上に付与)
        const padW = srcW - allocW;
        const padH = srcH - allocH;
        let offX = 0;
        let offY = 0;
        switch (this._debugCropAnchor) {
            case 1: // 中央アンカー
                offX = padW / 2;
                offY = padH / 2;
                break;
            case 2: // 右下アンカー (有効領域は srcTex の "末尾" にあると仮定)
                offX = padW;
                offY = padH;
                break;
            default: // 0: 左上アンカー
                offX = 0;
                offY = 0;
                break;
        }
        const uMin = offX / srcW;
        const vMin = offY / srcH;
        const uMax = Math.min(1.0, (offX + allocW) / srcW);
        const vMax = Math.min(1.0, (offY + allocH) / srcH);
        const fbo = this._cropFbo;
        const pipeline = this._downsamplePipeline;
        pipeline.set_layer_texture(0, srcTex);
        this._setPipelineVec2(pipeline, 'inv_size', 1.0 / srcW, 1.0 / srcH);
        // blur_radius = 0 → 5-tap カーネルの全オフセットが中心画素に収束し、
        // 実質的なパススルー (単純な UV リサンプル) として機能する。
        this._setPipelineFloat(pipeline, 'blur_radius', 0.0);
        fbo.clear4f(Cogl.BufferBit.COLOR, 0.0, 0.0, 0.0, 0.0);
        fbo.orthographic(0, 0, allocW, allocH, -1, 1);
        // 出力は全面 (0,0)-(allocW,allocH) に描画しつつ、入力側の UV を
        // (uMin,vMin)-(uMax,vMax) に制限することで「パディングを除いた領域を
        // ぴったり引き伸ばす」= 実質的なクロップを実現する。
        fbo.draw_textured_rectangle(pipeline, 0, 0, allocW, allocH, uMin, vMin, uMax, vMax);
        fbo.flush();
        return this._cropTexture;
    }
    _destroyCropTarget() {
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
    }
    /**
     * Clutter.OffscreenEffect のフックをオーバーライドする。
     *
     * このメソッドは OffscreenEffect がアクターの内容を内部 FBO に
     * レンダリングした後、その FBO テクスチャを画面に合成する
     * タイミングで呼び出される。
     *
     * デフォルトの super.vfunc_paint_target() は FBO を
     * そのまま画面に描画するだけだが、ここではその代わりに
     * Dual Kawase ブラー → Glass コンポジット のパイプラインを実行する。
     *
     * @param _paintNode   Clutter の描画ノード (GNOME 45+ の新しい signature)
     * @param paintContext 現在のペイントコンテキスト (画面 FB への参照を含む)
     */
    vfunc_paint_target(_paintNode, paintContext) {
        // ── 遅延パイプライン初期化 ────────────────────────────────────────────
        if (!this._compositePipeline) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Cogl コンテキストを取得できません');
                this._initPipelines(ctx);
            }
            catch (e) {
                console.error(`[Liquid Glass] パイプライン初期化失敗: ${e}`);
                // フォールバック: OffscreenEffect のデフォルト描画を使用
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        // ── ガードチェック ────────────────────────────────────────────────────
        // Gaussian H/V パイプラインは方式A (動的シェーダー生成) では半径が
        // 設定されるまで存在しないため、ここでの必須チェックには含めない。
        if (!this._compositePipeline || !this._downsamplePipeline || !this._upsamplePipeline) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ── Gaussian シェーダーの遅延コンパイル ───────────────────────────────
        // setBlurRadius() でフェッチ数 (タップ構成) が変化した場合のみ、
        // ここで安全に (Cogl コンテキストが確実に利用可能なタイミングで)
        // 新しい H/V パイプラインをコンパイルする。
        // 古いパイプライン参照は run_dispose() せず GC に解放を任せる。
        if (this._gaussianPipelineDirty && this._pendingGaussianKernel) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Cogl コンテキストを取得できません');
                this._gaussianHPipeline = null;
                this._gaussianVPipeline = null;
                this._compileGaussianPipelines(ctx, this._pendingGaussianKernel);
            }
            catch (e) {
                console.error(`[Liquid Glass] Gaussian パイプライン生成失敗: ${e}`);
            }
        }
        // OffscreenEffect がキャプチャしたアクターの FBO テクスチャを取得
        const srcTex = this.get_texture();
        if (!srcTex) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        const srcW = srcTex.get_width();
        const srcH = srcTex.get_height();
        // ── 【DEBUG-H1】診断ログ (frac=0 だったためサブピクセル説は否定済み。
        //    代わりに tex-alloc diff が一貫して非ゼロであることを確認済み) ──────
        if (this._debugH1Enabled) {
            this._logH1DebugInfo(srcTex, srcW, srcH);
        }
        // ── アクターの論理サイズを正とする ────────────────────────────────────
        // DEBUG-H1 の検証により、get_texture() の実サイズ (srcW, srcH) が
        // アクターの論理サイズ (actor.get_size()) より常に数 px 大きい
        // (Cogl 内部パディング混入) ことが判明した。以降は srcW/srcH を
        // "本当の解像度" として信用せず、actor.get_size() を正とする。
        const actor = this.get_actor();
        let allocW = srcW;
        let allocH = srcH;
        if (actor) {
            const [aw, ah] = actor.get_size();
            if (Number.isFinite(aw) && aw > 0)
                allocW = Math.round(aw);
            if (Number.isFinite(ah) && ah > 0)
                allocH = Math.round(ah);
        }
        // ── パディング混入時のみクロップパスを実行 ────────────────────────────
        // (サイズが一致していれば _cropSourceTexture は srcTex をそのまま返す
        //  ため、通常時のオーバーヘッドは分岐チェック 1 回のみ)
        let effectiveTex = srcTex;
        let effectiveW = srcW;
        let effectiveH = srcH;
        if (allocW !== srcW || allocH !== srcH) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Cogl コンテキストを取得できません');
                effectiveTex = this._cropSourceTexture(ctx, srcTex, srcW, srcH, allocW, allocH);
                // クロップに成功した場合のみ有効寸法を更新する
                // (失敗時は _cropSourceTexture が srcTex をそのまま返すため据え置き)
                if (effectiveTex !== srcTex) {
                    effectiveW = allocW;
                    effectiveH = allocH;
                }
            }
            catch (e) {
                console.error(`[Liquid Glass] クロップパス失敗、パディング込みのテクスチャで続行: ${e}`);
            }
        }
        // ── 【DEBUG-H1-CROP】クロップが実際に適用されたかどうかを確認するログ ──
        // _logH1DebugInfo は生の srcTex しか見ないため、クロップ処理自体が
        // 実行されたか・effectiveTex に切り替わったかはここで別途確認する。
        if (this._debugH1Enabled &&
            this._debugH1FrameCounter % LiquidEffect._DEBUG_H1_LOG_INTERVAL_FRAMES === 0) {
            console.log(`[Liquid Glass][DEBUG-H1-CROP] wasCropped=${effectiveTex !== srcTex} ` +
                `anchor=${this._debugCropAnchor} ` +
                `effective=(${effectiveW}x${effectiveH}) alloc=(${allocW}x${allocH}) ` +
                `cropPool=(${this._cropPoolW}x${this._cropPoolH})`);
        }
        // ── 解像度変更時にテクスチャプールを再構築 ───────────────────────────
        // (クロップ後の "本当の" 解像度を基準にする — パディング込みのサイズを
        //  基準にすると、奇数値へのビットシフト (w >> 1) で丸め誤差が段階的に
        //  蓄積し、raw レイヤーと blur レイヤーの間にズレが生じていた)
        if (effectiveW !== this._poolWidth || effectiveH !== this._poolHeight) {
            try {
                const ctx = this._getCoglContext();
                if (!ctx)
                    throw new Error('Cogl コンテキストを取得できません');
                this._buildTexturePool(ctx, effectiveW, effectiveH);
            }
            catch (e) {
                console.error(`[Liquid Glass] テクスチャプール再構築失敗: ${e}`);
                super.vfunc_paint_target(_paintNode, paintContext);
                return;
            }
        }
        if (this.PASS_COUNT > 0 && !this._blurFbos.length) {
            super.vfunc_paint_target(_paintNode, paintContext);
            return;
        }
        // ─────────────────────────────────────────────────────────────────────
        // ブラーパス: _blurMethod に応じてぼかし方式を切り替える
        //   0: 分離型 Gaussian Blur
        //   1: Dual Kawase Blur (従来実装)
        // 入力は必ず effectiveTex (クロップ済み、パディング無し) を使う。
        // ─────────────────────────────────────────────────────────────────────
        if (this.PASS_COUNT > 0) {
            if (this._blurMethod === 0) {
                if (this._gaussianHPipeline && this._gaussianVPipeline) {
                    this._runGaussianBlur(effectiveTex);
                }
            }
            else {
                this._runDualKawaseBlur(effectiveTex);
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        // 最終パス: Glass Composite
        //   _blurTextures[0] (ブラー済み w/2 × h/2) を cogl_sampler0 にバインドし、
        //   glass.frag で屈折・リムライト・シャドウを適用して画面へ描画する。
        //
        //   Clutter がアクターのモデルビュー変換を screenFb に設定済みなので、
        //   アクターローカル座標 (0, 0)〜(effectiveW, effectiveH) で描くだけでよい。
        //   ここを (0,0,srcW,srcH) にしていたことが、パディング分を画面に
        //   はみ出させていた直接の原因だった。
        // ─────────────────────────────────────────────────────────────────────
        const compFb = paintContext.get_framebuffer();
        const compPipeline = this._compositePipeline;
        // Layer 0: ぼけていない生のキャプチャテクスチャ (屈折計算の基準用)
        // — クロップ済みテクスチャを使うことで UV (0,0)-(1,1) が
        //   ぴったりアクターの論理サイズに一致する。
        compPipeline.set_layer_texture(0, effectiveTex);
        this._configureSamplerLayer(compPipeline, 0);
        // Layer 1: Dual Kawase で極限までぼかしたテクスチャ (背景ブラー用)
        // 変更後: ブラー処理を行った場合のみ blurTextures[0] を渡し、ブラー無しなら effectiveTex を渡す
        if (this.PASS_COUNT > 0 && this._blurTextures.length > 0) {
            compPipeline.set_layer_texture(1, this._blurTextures[0]);
        }
        else {
            compPipeline.set_layer_texture(1, effectiveTex);
        }
        this._configureSamplerLayer(compPipeline, 1);
        // 【修正箇所②】Coglパイプラインへのユニフォーム手動同期
        // （これが無いと dock_x 等がすべて 0 になり、画面全体がマスク内だと誤判定されます）
        this._applyPendingUniforms();
        compFb.push_matrix();
        const screenFb = paintContext.get_framebuffer();
        screenFb.draw_textured_rectangle(this._compositePipeline, 0, 0, effectiveW, effectiveH, 0, 0, 1, 1);
        compFb.pop_matrix();
    }
    // ─── 【DEBUG】仮説1検証用ヘルパー ───────────────────────────────────────
    // LOG_INTERVAL_FRAMES 毎に1回だけ、以下を出力する:
    //   1. actor.get_transformed_position() — アクターの「真の」絶対位置
    //      (浮動小数点)。その小数部 (frac) が非ゼロであれば、OffscreenEffect の
    //      デフォルト実装が本来吸収するはずのサブピクセル残差が存在する証拠。
    //   2. actor.get_paint_box() — Clutter が実際に計算した (おそらく整数
    //      スナップ済みの) ペイントボックス。真の位置との差分が
    //      「基底クラスが内部で保持しているはずのオフセット量」の推定値。
    //   3. get_texture() のサイズ vs アクターの論理サイズ (allocation) — 差分が
    //      あれば FBO 側でも丸め・パディングが発生している証拠。
    //
    // 使い方: journalctl -f -o cat /usr/bin/gnome-shell (または looking glass) で
    // "[Liquid Glass][DEBUG-H1]" を grep しながらメニューを開閉し、
    //   - frac の値
    //   - paintBox 由来のオフセット
    //   - 画面上で目視/スクリーンショットで測定したズレ量 (px)
    // の3つが一致した傾向で変動するかを確認する。一致すれば仮説1はほぼ確定。
    static _DEBUG_H1_LOG_INTERVAL_FRAMES = 60;
    _logH1DebugInfo(srcTex, srcW, srcH) {
        this._debugH1FrameCounter++;
        if (this._debugH1FrameCounter % LiquidEffect._DEBUG_H1_LOG_INTERVAL_FRAMES !== 0) {
            return;
        }
        const actor = this.get_actor();
        if (!actor)
            return;
        try {
            // 1. アクターの「真の」絶対位置 (浮動小数点、サブピクセル成分を含む)
            const [absX, absY] = actor.get_transformed_position();
            const [allocW, allocH] = actor.get_size();
            const fracX = absX - Math.floor(absX);
            const fracY = absY - Math.floor(absY);
            // 2. Clutter が実際に使っているペイントボックス (バージョンによって
            //    API が無い場合があるため防御的に取得する)
            //    【修正】このGNOME/Clutterバインディングの get_paint_box() は
            //    引数を取らず、ActorBox を戻り値として返す (out引数版ではない)。
            //    以前の実装は ActorBox を引数として渡していたため
            //    "Too many arguments: expected 0, got 1" の JS 警告が出ていた。
            let paintBoxStr = 'N/A';
            try {
                const anyActor = actor;
                if (typeof anyActor.get_paint_box === 'function') {
                    const box = anyActor.get_paint_box()[1];
                    if (box) {
                        const bx1 = box.get_x();
                        const by1 = box.get_y();
                        const bw = box.get_width();
                        const bh = box.get_height();
                        paintBoxStr =
                            `x1=${bx1.toFixed(4)} y1=${by1.toFixed(4)} w=${bw.toFixed(4)} h=${bh.toFixed(4)} ` +
                                `(vs absPos diff: dx=${(bx1 - absX).toFixed(4)} dy=${(by1 - absY).toFixed(4)})`;
                    }
                }
            }
            catch (e) {
                paintBoxStr = `取得失敗: ${e}`;
            }
            // 3. FBO テクスチャの物理サイズ vs アクターの論理サイズ (allocation) の差
            const texVsAllocW = srcW - allocW;
            const texVsAllocH = srcH - allocH;
            console.log(`[Liquid Glass][DEBUG-H1] frame=${this._debugH1FrameCounter} ` +
                `absPos=(${absX.toFixed(4)}, ${absY.toFixed(4)}) ` +
                `frac=(${fracX.toFixed(4)}, ${fracY.toFixed(4)}) ` +
                `alloc=(${allocW.toFixed(4)}x${allocH.toFixed(4)}) ` +
                `tex=(${srcW}x${srcH}) ` +
                `tex-alloc diff=(${texVsAllocW.toFixed(4)}, ${texVsAllocH.toFixed(4)}) ` +
                `paintBox=[${paintBoxStr}]`);
        }
        catch (e) {
            console.error(`[Liquid Glass][DEBUG-H1] ログ取得失敗: ${e}`);
        }
    }
    // ─── ユニフォームヘルパー ─────────────────────────────────────────────────
    /**
     * パイプラインに vec2 ユニフォームを設定する。
     * ロケーション取得は Cogl が内部でキャッシュするため、毎フレーム呼んでも安全。
     */
    _setPipelineVec2(pipeline, name, x, y) {
        const loc = pipeline.get_uniform_location(name);
        // set_uniform_float(loc, n_components, count, values[])
        pipeline.set_uniform_float(loc, 2, 1, [x, y]);
    }
    /**
     * パイプラインに float スカラーユニフォームを設定する。
     */
    _setPipelineFloat(pipeline, name, value) {
        const loc = pipeline.get_uniform_location(name);
        pipeline.set_uniform_float(loc, 1, 1, [value]);
    }
    /**
     * コンポジットパイプラインに float ユニフォームをセットする。
     * パイプライン未生成時は _pendingUniforms にバッファし、
     * 生成後 (_applyPendingUniforms) に一括適用される。
     */
    _setFloat(name, value) {
        this._pendingUniforms.set(name, value);
        if (this._compositePipeline) {
            this._applyUniform(name, value);
        }
    }
    _applyUniform(name, value) {
        if (!this._compositePipeline)
            return;
        // ロケーションをキャッシュして毎フレームの get_uniform_location 呼び出しを削減
        let loc = this._compUniforms.get(name);
        if (loc === undefined) {
            loc = this._compositePipeline.get_uniform_location(name);
            this._compUniforms.set(name, loc);
        }
        // set_uniform_float(loc, 1 component, 1 element, [value])
        this._compositePipeline.set_uniform_float(loc, 1, 1, [value]);
    }
    _applyPendingUniforms() {
        for (const [name, value] of this._pendingUniforms) {
            this._applyUniform(name, value);
        }
    }
    // ─── Cogl コンテキスト取得 ───────────────────────────────────────────────
    _getCoglContext() {
        try {
            // Clutter.get_default_backend() は GJS で利用可能。
            // GNOME 50 では get_cogl_context() は Cogl.Context を返す。
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            console.error(`[Liquid Glass] Cogl コンテキスト取得失敗: ${e}`);
            return null;
        }
    }
    // ─── GSettings バインディング ─────────────────────────────────────────────
    _bindSettings() {
        const mappings = [
            { key: 'glass-max-z', uniform: 'max_z' },
            { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
            { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
            { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
            { key: 'glass-ior', uniform: 'ior' },
            { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
            { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
            { key: 'glass-shininess', uniform: 'shininess' },
            { key: 'glass-rim-width', uniform: 'rim_width' },
            { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
            { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
            { key: 'glass-rim-power', uniform: 'rim_power' },
            { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
            { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
            { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
            { key: 'shadow-radius', uniform: 'shadow_radius' },
            { key: 'shadow-intensity', uniform: 'shadow_intensity' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            // 初回反映
            this._setFloat(map.uniform, settings.get_double(map.key));
            // 変更監視
            const id = settings.connect(`changed::${map.key}`, () => {
                this._setFloat(map.uniform, settings.get_double(map.key));
            });
            this._settingsIds.push(id);
        });
        // ── blur-method (int): 0 = Gaussian, 1 = Dual Kawase ──────────────────
        // GSettings の int キーとして定義されていることを前提とする。
        // get_int() で読み込み、0 か否かで BlurMethod にマップする。
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
    }
    // ─── 公開 API (呼び出し側から見た互換インターフェース) ──────────────────
    cleanup() {
        // GSettings シグナル切断
        if (this._settings && this._settingsIds) {
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
            this._settingsIds = [];
        }
        // テクスチャプール解放 (参照クリアのみ。run_dispose() は二重解放になるため禁止)
        this._destroyTexturePool();
        this._destroyCropTarget();
        // パイプライン参照クリア (GJS GC が VRAM を解放する)
        // run_dispose() は呼ばない – GJS 管理オブジェクトへの二重 unref を防ぐため
        this._downsamplePipeline = null;
        this._upsamplePipeline = null;
        this._gaussianHPipeline = null;
        this._gaussianVPipeline = null;
        this._compositePipeline = null;
        this._compUniforms.clear();
        this._pendingUniforms.clear();
        // 動的 Gaussian シェーダー生成の状態もリセットする
        this._gaussianKernel = null;
        this._pendingGaussianKernel = null;
        this._gaussianPipelineDirty = false;
        this._gaussianBaseSigma = 0;
        this._gaussianScale = 1.0;
        this._gaussianFetchPairs = 0;
    }
    setIsDock(isDock) {
        this._setFloat('isDock', isDock ? 1.0 : 0.0);
    }
    setPadding(pad) {
        this._setFloat('padding', pad);
    }
    setTintColor(r, g, b) {
        this._setFloat('tint_r', r);
        this._setFloat('tint_g', g);
        this._setFloat('tint_b', b);
        this.queue_repaint();
    }
    setTintStrength(strength) {
        this._setFloat('tint_strength', strength);
        this.queue_repaint();
    }
    setCornerRadius(radius) {
        this._setFloat('corner_radius', radius);
        this.queue_repaint();
    }
    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return;
        this._setFloat('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._setFloat('max_z', settings.get_double('glass-max-z') * scale);
        this._setFloat('chroma_strength', settings.get_double('glass-chroma-strength') * scale);
        this.queue_repaint();
    }
    setPointerPosition(x, y, intensity) {
        this._setFloat('pointer_x', x);
        this._setFloat('pointer_y', y);
        this._setFloat('intensity', intensity);
    }
    /**
     * アクターの論理サイズをシェーダーの resolution ユニフォームに同期する。
     *
     * テクスチャプールの再構築は vfunc_paint_target で get_texture() のサイズを
     * 見て自動的に行われるため、ここでは不要。
     */
    setResolution(width, height) {
        this._setFloat('resolution_x', width);
        this._setFloat('resolution_y', height);
        this.queue_repaint();
    }
    /**
     * フルスクリーン FBO モード: ドックのモニター相対座標をシェーダーに渡す。
     * (詳細は glass.frag の dock_x/y/w/h コメント参照)
     */
    setGlassGeometry(x, y, w, h) {
        this._setFloat('dock_x', x);
        this._setFloat('dock_y', y);
        this._setFloat('dock_w', w);
        this._setFloat('dock_h', h);
        this.queue_repaint();
    }
    setBrightness(brightness) {
        this._setFloat('brightness', brightness);
        this.queue_repaint();
    }
    setContrast(contrast) {
        this._setFloat('contrast', contrast);
        this.queue_repaint();
    }
    setSaturation(saturation) {
        this._setFloat('saturation', saturation);
        this.queue_repaint();
    }
    /**
     * ブラー方式を動的に変更する。
     *
     * @param method 0: 分離型 Gaussian Blur, 1: Dual Kawase Blur
     *
     * Dual Kawase 用パイプラインは _initPipelines で初回フレームにコンパイル済み。
     * Gaussian 用パイプラインは方式A (動的シェーダー生成) のため、setBlurRadius()
     * 経由で半径に応じたカーネルが算出され、必要な場合のみ次フレームの
     * vfunc_paint_target で遅延コンパイルされる。
     * テクスチャプールも両方式で共用できる構造 (_buildTexturePool 参照) のため、
     * 方式切り替え時の手動再構築は不要。queue_repaint() のみで安全に次フレームから
     * 新方式が適用される。
     */
    setBlurMethod(method) {
        if (this._blurMethod === method)
            return;
        this._blurMethod = method;
        console.log(`[Liquid Glass] blur-method → ${method === 0 ? 'Gaussian' : 'Dual Kawase'}`);
        this.setBlurRadius(this._targetRadius);
        this.queue_repaint();
    }
    /**
     * ブラー半径を動的に設定する。
     * 方式（Gaussian / Dual Kawase）に応じて計算を分岐する。
     */
    setBlurRadius(radius) {
        this._targetRadius = radius;
        if (this._blurMethod === 0) {
            this._setGaussianBlurRadius(radius);
            return;
        }
        this._setDualKawaseBlurRadius(radius);
    }
    /**
     * 分離型 Gaussian Blur (方式A: 動的シェーダー生成) の半径設定。
     *
     * 基本方針:
     *   - PASS_COUNT は常に 1 に固定。テクスチャプールは w/2 × h/2 の
     *     1 階層のみを使用し、半径変更によるプール破棄・再構築は行わない
     *     (ガクつきの排除)。
     *   - 半径 (= 元解像度ピクセル単位のσ) に応じてサンプリングのフェッチ数
     *     (タップペア数) を動的に決定する。フェッチ数が変化しない限り、
     *     既存のコンパイル済みシェーダーをそのまま再利用し、kernel_scale
     *     ユニフォームの更新のみで対応する (再コンパイル抑制による最適化)。
     *
     * 算出方法:
     *   1. 半解像度空間における実質的な標準偏差 σ を算出する:
     *        σ = radius / RES_SCALE   (RES_SCALE = 2.0; 半解像度では 1 texel = 2 元ピクセル)
     *   2. 最大半径 30px (半解像度空間で 15 texel) を上限にクランプする。
     *   3. ガウス重みが十分にゼロへ収束する範囲 (3σ ルール) をカバーするために
     *      必要な片側タップ数を求め、フェッチペア数 (2 タップ = 1 フェッチ) を決定する。
     *   4. フェッチペア数が前回と同一であれば、シェーダー文字列の再生成・
     *      パイプラインの再コンパイルをスキップし、kernel_scale = σ / 基準σ の
     *      比率のみを更新する。
     *      フェッチペア数が変化した場合は新しいカーネルを _pendingGaussianKernel
     *      にセットし、次回 vfunc_paint_target で安全にコンパイルする。
     */
    _setGaussianBlurRadius(radius) {
        const RES_SCALE = 2.0; // 半解像度: 1 texel = 2 元ピクセル
        const MAX_SIGMA_TEXEL = 15.0; // 物理上限 30px (= 半解像度空間で 15 texel)
        // ── 最小 σ の保証 ──────────────────────────────────────────────────────
        // 半解像度へのダウンサンプル (bilinear 2x) は本質的に幅 2px のボックスフィルターと
        // 等価であり、文字のような高周波成分に対してエイリアシングを生じさせる。
        // このエイリアシングを打ち消すには、H/V カーネルの実効幅が 1.0 half-res texel
        // (= 2 元ピクセル) を超えている必要がある。
        // したがって σ の下限を MIN_SIGMA_TEXEL = 1.0 に設定し、
        // 指定 radius が極小であっても最低限の平滑化を保証する。
        // radius が小さいほど kernel_scale < 1.0 になるが、タップが中心に寄ることで
        // 単純に「弱いぼかし」として機能する (エイリアシングは除去できる)。
        const MIN_SIGMA_TEXEL = 1.0;
        if (radius <= 0) {
            if (this.PASS_COUNT !== 0) {
                this.PASS_COUNT = 0;
                this._destroyTexturePool();
            }
            this._gaussianScale = 0.0;
            this.queue_repaint();
            return;
        }
        const sigmaTexel = Math.min(radius / RES_SCALE, MAX_SIGMA_TEXEL);
        // カーネル形状 (フェッチペア数) の決定には MIN_SIGMA_TEXEL 以上の σ を使用する。
        // これにより、小半径でも十分な幅のカーネルがコンパイルされる。
        const kernelSigma = Math.max(sigmaTexel, MIN_SIGMA_TEXEL);
        // 3σ ルールでカバーすべき片側タップ数 → フェッチペア数 (2 タップ/フェッチ) を算出
        // 最低 2 ペア (5-tap 相当) を保証して bilinear ダウンサンプルのエイリアシングを確実に吸収する
        const sideTaps = Math.max(2, Math.ceil(kernelSigma * 3));
        const fetchPairs = Math.max(2, Math.ceil(sideTaps / 2));
        const needsRecompile = this._gaussianFetchPairs !== fetchPairs ||
            (!this._gaussianKernel && !this._pendingGaussianKernel);
        if (needsRecompile) {
            const kernel = this._computeGaussianKernel(kernelSigma, fetchPairs);
            this._pendingGaussianKernel = kernel;
            this._gaussianPipelineDirty = true;
            this._gaussianFetchPairs = fetchPairs;
            this._gaussianBaseSigma = kernelSigma;
            // kernel_scale: 実際の σ / コンパイル時の σ。
            // sigmaTexel < kernelSigma のとき scale < 1.0 となり、弱いぼかしとして機能する。
            this._gaussianScale = sigmaTexel / kernelSigma;
        }
        else {
            // フェッチ数 (シェーダー構造) は変化なし — kernel_scale のみ更新し
            // 再コンパイルを回避する。
            this._gaussianScale = this._gaussianBaseSigma > 0
                ? sigmaTexel / this._gaussianBaseSigma
                : 1.0;
        }
        // Gaussian は常に 1 階層 (w/2 × h/2) のみ使用する。
        // PASS_COUNT が 0 → 1 へ遷移する場合のみプール構築が必要 (ブラー無効状態からの復帰)。
        if (this.PASS_COUNT !== 1) {
            this.PASS_COUNT = 1;
            // プールが未構築 (または前回 Dual Kawase で異なる階層数だった) 場合のみ再構築させる。
            // vfunc_paint_target 側の解像度差分チェックにより、実際の構築は次フレームで行われる。
            this._destroyTexturePool();
        }
        this.queue_repaint();
    }
    /**
     * Dual Kawase Blur (従来実装) の半径設定。ロジックは変更なし。
     */
    _setDualKawaseBlurRadius(radius) {
        let newPassCount = 0;
        let offsetDown = 0.0;
        let offsetUp = 0.0;
        if (radius > 0) {
            // 1. 物理半径 R から最適な整数パス数 P を決定 (固有ボケモデル)
            let p = Math.floor(Math.log2(radius + 1));
            // パス数をシェーダーおよびFBO上限 [1, 4] の範囲にクランプ
            newPassCount = Math.max(1, Math.min(4, p));
            // 2. パス区間内における線形な正規化進行度 t を算出
            let baseR = (newPassCount === 1) ? 0 : Math.pow(2, newPassCount) - 1;
            let nextR = Math.pow(2, newPassCount + 1) - 1;
            let t = (radius - baseR) / (nextR - baseR);
            t = Math.max(0.0, Math.min(1.0, t));
            // 3. C1連続性を保証する区分的3次エルミートスプライン
            let s = 0.25 * Math.pow(t, 3) - 0.75 * Math.pow(t, 2) + 1.5 * t;
            // 4. アンチエイリアスを保証するオフセット・マッピング
            let minOffset = (newPassCount === 1) ? 0.0 : 0.5;
            let maxOffset = 1.0;
            let r = minOffset + s * (maxOffset - minOffset);
            offsetDown = r;
            offsetUp = r * 1.5;
        }
        // 状態に変更があるかチェック
        if (this.PASS_COUNT !== newPassCount ||
            this._blurRadiusDown !== offsetDown ||
            this._blurRadiusUp !== offsetUp) {
            const passCountChanged = this.PASS_COUNT !== newPassCount;
            this.PASS_COUNT = newPassCount;
            this._blurRadiusDown = offsetDown;
            this._blurRadiusUp = offsetUp;
            // パス数が変更された場合は FBO プールの再構築が必要
            if (passCountChanged) {
                this._destroyTexturePool();
            }
            this.queue_repaint();
        }
    }
});
