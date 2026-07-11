// shaders/upsample.frag
// Dual Kawase Upsample Pass (Tent Filter) — Cogl snippet source
//
// このファイルは LiquidEffect._loadShaderSnippet() によって実行時に読み込まれ、
// Cogl.Pipeline の FRAGMENT フックとして使用される。
//
// サンプラー: cogl_sampler0 (layer 0, Cogl が自動宣言)
// 入力テクスチャ: 直前パスの低解像度テクスチャ
// 出力: 倍解像度のアップサンプル済みテクスチャ
//
// テント (Tent) フィルターとは:
//   ピラミッド形の重みを持つ線形補間フィルター。
//   最近傍 × bilinear より滑らかで、ガウシアンに近い結果を低コストで得られる。

uniform vec2 inv_size; /* 1/width, 1/height of the SOURCE (低解像度側) texture */
uniform float blur_radius; /* サンプリングオフセットのスケール (デフォルト 1.0) */

// 8-tap テントフィルター (blur_radius スケール付き)
//   上下左右 (重み 2 each): 4 tap × 2 = 8
//   斜め 4 方向 (重み 1 each): 4 tap × 1 = 4
//   合計重み = 12
//
// blur_radius を大きくするほどアップサンプル時のブレンド範囲が広がり、
// より滑らかな(強い)ぼけになる。
// inv_size は入力(低解像度)テクスチャのテクセルサイズ。
// 出力 FBO は入力テクスチャの 2 倍サイズで生成すること。
void main() {
    vec2 uv = cogl_tex_coord_in[0].st;
    float r = blur_radius;

    // 上下左右 (重み 2)
    vec4 col;
    col  = texture2D(cogl_sampler0, uv + vec2(-r,  0.0) * inv_size) * 2.0;
    col += texture2D(cogl_sampler0, uv + vec2( r,  0.0) * inv_size) * 2.0;
    col += texture2D(cogl_sampler0, uv + vec2( 0.0, -r) * inv_size) * 2.0;
    col += texture2D(cogl_sampler0, uv + vec2( 0.0,  r) * inv_size) * 2.0;

    // 斜め方向 (重み 1)
    col += texture2D(cogl_sampler0, uv + vec2(-r, -r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2( r, -r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2(-r,  r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2( r,  r) * inv_size);

    cogl_color_out = col / 12.0;
}
