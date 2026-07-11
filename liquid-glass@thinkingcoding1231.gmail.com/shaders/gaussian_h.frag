// shaders/gaussian_h.frag
// 分離型 Gaussian Blur — 水平方向パス (Horizontal Pass) — Cogl snippet source
//
// このファイルは LiquidEffect._loadShaderSnippet() によって実行時に読み込まれ、
// Cogl.Pipeline の FRAGMENT フックとして使用される。
//
// 分離型 (Separable) Gaussian Blur の概要:
//   2D ガウスカーネルは水平1Dカーネルと垂直1Dカーネルの積に分解できる。
//   これにより O(r^2) のサンプル数を O(r) に削減できる。
//   水平パス → 垂直パス の 2 段階で完全なガウスぼかしを実現する。
//
// このファイルは「水平パス」を担当する。
//   入力: 前段テクスチャ (Downsample 済みの半解像度テクスチャ)
//   出力: 水平方向のみぼかしたテクスチャ (中間バッファへ)
//
// サンプラー: cogl_sampler0 (layer 0, Cogl が自動宣言)
//
// カーネル: 線形サンプリングによる最適化 Gaussian
//   バイリニアフィルタリングを利用して 2 つの隣接タップを 1 回のフェッチで取得。
//   TAP_COUNT = 5 の場合、9-tap ガウスカーネルを 5 フェッチで近似する。
//   (中心 1 + 両側 4 フェッチ × 2方向 = 9タップ相当、フェッチ回数は 5)

uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */
uniform float blur_radius; /* ガウス標準偏差のスケール。大きいほど強いぼけ */

// ─── ガウス重みの定数 (線形サンプリング最適化済み) ─────────────────────────
//
// 元の 9-tap ガウス重み (sigma ≈ 2.0 に相当):
//   w = [0.0625, 0.125, 0.25, 0.25, 0.125, 0.0625] (正規化後の代表値)
//
// 線形サンプリング最適化: 隣接ペアの重み w0, w1 を合成し、
//   offset = (i*w0 + (i+1)*w1) / (w0 + w1)
//   weight = w0 + w1
// で 1 フェッチにまとめる。
//
// ここでは blur_radius でオフセットをスケールし、動的ぼかし強度を実現する。
// 重みは固定 (カーネル形状を維持)、オフセットのみ blur_radius でスケール。
//
// 4 ペア分のオフセットと重み (中心から外側へ):
//   Pair 1 (tap 1, 2): offset ≈ 1.3846, weight ≈ 0.3162
//   Pair 2 (tap 3, 4): offset ≈ 3.2308, weight ≈ 0.0702
// (参考: "Efficient Gaussian Blur with Linear Sampling" — Real-Time Rendering)

const float GAUSSIAN_OFFSET_1 = 1.3846153846;
const float GAUSSIAN_OFFSET_2 = 3.2307692308;
const float GAUSSIAN_WEIGHT_0 = 0.2270270270; /* 中心ピクセル */
const float GAUSSIAN_WEIGHT_1 = 0.3162162162; /* ペア1 の合成重み × 2 (左右対称) */
const float GAUSSIAN_WEIGHT_2 = 0.0702702703; /* ペア2 の合成重み × 2 (左右対称) */

void main() {
    vec2 uv = cogl_tex_coord_in[0].st;

    // blur_radius でオフセットをスケール (0 の場合は中心のみサンプル → ぼかしなし)
    float o1 = GAUSSIAN_OFFSET_1 * blur_radius;
    float o2 = GAUSSIAN_OFFSET_2 * blur_radius;

    // 水平方向のオフセットベクトル
    vec2 h1 = vec2(o1 * inv_size.x, 0.0);
    vec2 h2 = vec2(o2 * inv_size.x, 0.0);

    // 中心サンプル
    vec4 col = texture2D(cogl_sampler0, uv) * GAUSSIAN_WEIGHT_0;

    // 左右ペア1
    col += texture2D(cogl_sampler0, uv + h1) * GAUSSIAN_WEIGHT_1;
    col += texture2D(cogl_sampler0, uv - h1) * GAUSSIAN_WEIGHT_1;

    // 左右ペア2
    col += texture2D(cogl_sampler0, uv + h2) * GAUSSIAN_WEIGHT_2;
    col += texture2D(cogl_sampler0, uv - h2) * GAUSSIAN_WEIGHT_2;

    cogl_color_out = col;
}
