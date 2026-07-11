// shaders/downsample.frag
// Dual Kawase Downsample Pass — Cogl snippet 
//
// このファイルは LiquidEffect._loadShaderSnippet() によって実行時に読み込まれ、
// "void main()" の前半部をスニペットの declarations に、
// main() の本体部分を snippet.set_replace() に渡すことで
// Cogl.Pipeline の FRAGMENT フックとして使用される。
//
// サンプラー: cogl_sampler0 (layer 0, Cogl が自動宣言)
// 入力テクスチャ: 直前パスの高解像度テクスチャ
// 出力: 半解像度のダウンサンプル済みテクスチャ

uniform vec2 inv_size; /* 1/width, 1/height of the SOURCE texture */
uniform float blur_radius; /* サンプリングオフセットのスケール (デフォルト 0.5) */

// 5-tap Kawase カーネル
//   中心ピクセル (重み 4) ＋ blur_radius テクセルずらした 4 点 (重み 1 each)
//   合計重み = 8 → 平均化
//
// blur_radius を大きくするほどぼけが強くなる。
// 各パスで解像度を半分に落とすため、出力 FBO は
// 入力テクスチャの (width/2, height/2) サイズで生成すること。
void main() {
    vec2 uv = cogl_tex_coord_in[0].st;
    float r = blur_radius;

    vec4 col  = texture2D(cogl_sampler0, uv) * 4.0;
    col += texture2D(cogl_sampler0, uv + vec2( r,  r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2( r, -r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2(-r,  r) * inv_size);
    col += texture2D(cogl_sampler0, uv + vec2(-r, -r) * inv_size);

    cogl_color_out = col / 8.0;
}
