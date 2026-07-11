// shaders/gaussian_v.frag
// 分離型 Gaussian Blur — 垂直方向パス (Vertical Pass) — Cogl snippet source
//
// このファイルは LiquidEffect._loadShaderSnippet() によって実行時に読み込まれ、
// Cogl.Pipeline の FRAGMENT フックとして使用される。
//
// このファイルは「垂直パス」を担当する。
//   入力: gaussian_h.frag による水平ぼかし済み中間テクスチャ
//   出力: 完全な 2D ガウスぼかしテクスチャ (次の Glass Composite パスへ)
//
// 水平パスと対になって使用されるため、カーネル定数・構造は同一。
// 唯一の違いは inv_size のスケール方向が垂直 (y) であること。
//
// サンプラー: cogl_sampler0 (layer 0, Cogl が自動宣言)
//
// 詳細は gaussian_h.frag のコメントを参照。

uniform vec2 inv_size;    /* 1/width, 1/height of the SOURCE texture */
uniform float blur_radius; /* ガウス標準偏差のスケール。大きいほど強いぼけ */

const float GAUSSIAN_OFFSET_1 = 1.3846153846;
const float GAUSSIAN_OFFSET_2 = 3.2307692308;
const float GAUSSIAN_WEIGHT_0 = 0.2270270270;
const float GAUSSIAN_WEIGHT_1 = 0.3162162162;
const float GAUSSIAN_WEIGHT_2 = 0.0702702703;

void main() {
    vec2 uv = cogl_tex_coord_in[0].st;

    float o1 = GAUSSIAN_OFFSET_1 * blur_radius;
    float o2 = GAUSSIAN_OFFSET_2 * blur_radius;

    // 垂直方向のオフセットベクトル
    vec2 v1 = vec2(0.0, o1 * inv_size.y);
    vec2 v2 = vec2(0.0, o2 * inv_size.y);

    // 中心サンプル
    vec4 col = texture2D(cogl_sampler0, uv) * GAUSSIAN_WEIGHT_0;

    // 上下ペア1
    col += texture2D(cogl_sampler0, uv + v1) * GAUSSIAN_WEIGHT_1;
    col += texture2D(cogl_sampler0, uv - v1) * GAUSSIAN_WEIGHT_1;

    // 上下ペア2
    col += texture2D(cogl_sampler0, uv + v2) * GAUSSIAN_WEIGHT_2;
    col += texture2D(cogl_sampler0, uv - v2) * GAUSSIAN_WEIGHT_2;

    cogl_color_out = col;
}
