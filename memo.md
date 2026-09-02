# ドラッグ時の背景遅延バグ — 調査記録と原因解説

**対象**: Liquid Glass (GNOME Shell 拡張機能)
**環境**: GNOME 50 / Clutter 18 / Mutter 18
**症状**: エフェクト適用済みウィンドウをドラッグすると、ウィンドウ内部に描かれる背景（壁紙・他ウィンドウのクローン）の位置同期が約1フレーム遅れる

---

## 1. 結論（先に要約）

### 根本原因

`Clutter.OffscreenEffect.vfunc_paint_target()` は、**ペイントノードツリーが「構築」される段階**で呼ばれる。一方、`OffscreenEffect` がアクターをキャプチャテクスチャへ描画するのは、**そのツリーが「実行」される段階**である。

本拡張機能は `vfunc_paint_target()` の中で Cogl の**即時描画API**（`draw_textured_rectangle` + `flush`）を直接呼んでいた。そのため、**まだ今フレームのキャプチャが描かれていない時点で `get_texture()` の内容をサンプリング**しており、読めていたのは常に**前フレームの内容**だった。

### なぜ一部だけ正常に見えていたか

画面フレームバッファへの即時描画は、Cogl のジャーナルに積まれて実行が後回しになる。フラッシュされる頃にはキャプチャが完了しているため、**偶然**正しい内容が読めていた。中間フレームバッファへ描く場合は `flush()` で即座に実行されるため、前フレームの内容がそのまま出た。

この「偶然の正しさ」は極めて脆く、画面フレームバッファへの描画直後に `flush()` を1行足すだけで同じ遅延が再現した（決定打となった実験）。

### 修正

1. **すべての描画をペイントノード化** — キャプチャノードの後に実行されることを保証
2. **パスごとに専用パイプライン** — 遅延実行では共有パイプラインが破綻するため
3. **パスグラフを厳密なDAGに** — 遅延実行では Cogl が依存グラフを構築するため、ピンポン再利用が閉路になる

---

## 2. なぜ難航したのか

このバグは、以下の性質が重なって切り分けを著しく困難にしていた。

| 性質 | 影響 |
|---|---|
| JS側の座標計算は完全に正しかった | 「位置計算のバグ」という最も自然な仮説が延々と生き残った |
| 変換行列もペイント時点ではライブだった | 「Mutter内部の遅れ」という仮説も否定される |
| 症状が「位置ずれ」に見える | 実際には「内容が古い」だった。現象の見え方が原因の性質を誤誘導した |
| 通常経路が偶然動いていた | 「動いている部分」と「動いていない部分」の差が、原因と無関係な軸（クロップの有無、ブラーの有無）に見えた |
| 1フレームという量 | 目視での定量比較がほぼ不可能。1 vs 2 フレームは判別できなかった |

---

## 3. 調査の全記録

### 3.1 棄却された仮説

| # | 仮説 | 検証方法 | 結果 |
|---|---|---|---|
| 1 | オフセット計算が誤っている | クローンの実測位置と理論値の差分を全フレーム記録 | **全ティックで delta=(0,0)**。誤差ゼロ |
| 2 | イージング/トランジションが効いている | `actor.get_transition('position')` を毎フレーム確認 | 常に `false` |
| 3 | GPU負荷でフレーム落ち | パイプライン処理時間を計測、blur radius 0 でも確認 | `overBudgetCount` 常に0、radius 0 でも遅延 |
| 4 | オフスクリーンFBOのキャッシュ再利用 | 毎フレーム `bgActor.queue_redraw()` を強制 | 変化なし |
| 5 | `set_position` がレイアウトフェーズ待ちになる | `translation_x/y` に変更、`Clutter.Constraint` も試行 | いずれも変化なし |
| 6 | 変換行列が1フレーム古い | ペイント時点の値を実測 | **621行すべてで `liveFrameRect − actorTransformed = (10,10)`**（＝完全にライブ） |
| 7 | キャプチャテクスチャの内容が古い | Clutter標準の転送（passthrough）に切替 | 遅延なし ＝ テクスチャは正常 |
| 8 | クロップの幾何計算ミス | サイズをログ | `srcSize=964x563 / allocSize=961x560` がドラッグ中**完全に不変**。不変な幾何は動きに連動する遅延を生めない |
| 9 | Cogl のジャーナル順序（GPU同期の問題） | 画面FBに `flush()` / `finish()` / 事前タッチ | すべて無効 |
| 10 | 往復1回ごとに1フレーム蓄積 | 中間FBの往復回数を1回と8回で比較 | **全く同じ**。蓄積しない |

### 3.2 決定的だった実験

#### (a) リングは遅れない — 経路の違いを発見

ユーザーの観察「ウィンドウ外側10pxのリングは遅れないが、内部は遅れる」から、この2領域が**別のアクターツリー**で描かれていることが判明した。

```
【遅延】ウィンドウ内部
  bgActor ──[ LiquidEffect = Clutter.OffscreenEffect ]
    └ clipBox ── bgClone + windowsContainer

【正常】外側10pxのリング
  cornerOverlay ──[ InverseCornerEffect: 内側をくり抜く ]
    └ cornerOverlayClone = Clutter.Clone( baseActor )
         baseActor はオフスクリーンエフェクトを持たない
```

両者には**毎フレーム同一のオフセット**が与えられている。同じ入力で片方だけが正しい ⟹ **壊れているのは入力値ではなく描画経路**。

これで仮説1・5が完全に死に、調査対象がオフスクリーン経路内部に限定された。

#### (b) 二分探索 — クロップパスの特定

Clutter標準の転送（正常）と当方の合成（異常）の間を段階的に埋めた。

| モード | 内容 | 遅延 |
|---|---|---|
| passthrough | `super.vfunc_paint_target()` | なし |
| 2 | 生キャプチャを画面へ直接転送 | なし |
| 3 | 中間FBOでクロップしてから転送 | **あり** |
| 4 | クロップをUV範囲で表現、中間FBOなし | なし |

モード3とモード4の差は**中間FBOの往復のみ**。ここで「中間FBOが怪しい」ところまで来たが、**この時点での原因説明（Coglのジャーナル順序）は誤りだった**。

#### (c) クロップ廃止後の再測定 — 一般則の確認

クロップをUV化して排除した結果、`passCount=0`（ブラーパスなし）でのみ遅延が消え、`passCount≥1` では再発した。

```
キャプチャ → 画面FBへ直接        … 遅延しない
キャプチャ → 当方のFB → 画面     … 必ず遅延する（クロップでもブラーでも）
```

#### (d) 往復回数テスト — 蓄積しないことの発見

中間FBの往復を1回と8回で比較したところ、**遅延量が全く同じ**だった。

往復2回目以降は当方自身のテクスチャを読んでいる。もし「コピーのたびに古い内容が配られる」なら8倍に積み上がるはずだった。そうならない ⟹ **古いのは `srcTex` の初回読み取りだけ**。しかも `finish()` で直らない ⟹ **GPU同期の問題ではない**。

ここで初めて「そもそもまだ描かれていない」という正しい方向へ転換できた。

#### (e) 最終確認 — フレームバッファは無関係だった

```js
global._lgDebug.hops(0, false, false)  // 往復ゼロ、通常          → 遅延なし
global._lgDebug.hops(0, false, true)   // 往復ゼロ、直後にflush   → 遅延あり
```

**両者の差はフラッシュ1行だけ。中間フレームバッファは最初から無関係だった。**

真の変数は「当方の描画が、Clutterによるキャプチャ描画の**前**に実行されるか**後**に実行されるか」であることが確定した。

---

## 4. メカニズムの詳細

### 4.1 Clutter のペイントノードアーキテクチャ

現行の Clutter は、描画を2段階で行う。

1. **構築フェーズ** — アクター階層を走査し、`ClutterPaintNode` のツリーを組み立てる
2. **実行フェーズ** — 組み上がったツリーを順に実行し、実際にGPUコマンドを発行する

`ClutterOffscreenEffect` は構築フェーズで次のことを行う。

```
clutter_offscreen_effect_paint_node():
    layer_node = LayerNode(→ キャプチャ用オフスクリーン)   ← 子アクターをここへ描画
    node.add_child(layer_node)
    klass->paint_target(effect, node, paint_context)      ← ここで我々のコードが呼ばれる
```

つまり `paint_target` が呼ばれる時点では、`layer_node` は**ツリーに追加されただけで、まだ実行されていない**。キャプチャテクスチャの中身は前フレームのままである。

Clutter標準の `paint_target` 実装が即時描画ではなく**ノードの追加**で済ませているのは、まさにこのためである。追加されたノードは `layer_node` の後に実行されるため、正しい順序が保証される。

### 4.2 本拡張機能で起きていたこと

```
構築フェーズ:
  [Clutter]  layer_node をツリーに追加（まだ実行されない）
  [拡張]     vfunc_paint_target() 呼び出し
  [拡張]       srcTex = get_texture()          ← 中身は前フレーム
  [拡張]       blurFbo.draw(srcTex); flush()   ← 即座に実行 = 前フレームを読む ★
  [拡張]       screenFb.draw(...)              ← ジャーナルに積まれるだけ

実行フェーズ:
  [Clutter]  layer_node 実行 → ここで初めて今フレームのキャプチャが描かれる
  [Cogl]     画面FBのジャーナルをフラッシュ → 偶然、正しい内容が読まれる
```

★ の行が遅延の発生源。そして最後の行が「一部だけ正常に見えていた」理由である。

### 4.3 各観測との整合

| 観測 | 説明 |
|---|---|
| リングは遅れない | `cornerOverlay` の経路は当方の即時描画を通らない |
| `hops(1)` = `hops(8)` | 古いのは `srcTex` の初回読みのみ。自前テクスチャの読みは正常 |
| `finish()` が無効 | GPU同期の問題ではなく、まだ描かれていない |
| `passCount=0` で遅延なし | レイヤー1が `srcTex` 直読み（＝遅延実行される経路）になる |
| クロップ廃止で半径0のみ改善 | 即時実行パスを1本減らしただけだった |
| 変換行列はライブ | 位置は正しく、中身だけが古い |
| `hops(0)` + flush で再発 | 決定的。フレームバッファではなく実行順序が変数 |

---

## 5. 修正内容

### 5.1 すべての描画をペイントノード化

即時描画を廃止し、`_paintNode` の子としてノードを追加する形へ変更。`OffscreenEffect` が既に追加しているキャプチャ用レイヤーノードより後に実行されるため、順序が保証される。

```ts
private _addPassNode(parentNode, targetFbo, pipeline, destW, destH, uv) {
  targetFbo.orthographic(0, 0, destW, destH, -1, 1);
  const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
  parentNode.add_child(layerNode);
  const drawNode = Clutter.PipelineNode.new(pipeline);
  layerNode.add_child(drawNode);
  drawNode.add_texture_rectangle(
    new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }),
    uv[0], uv[1], uv[2], uv[3]
  );
}
```

投影行列（`orthographic`）はキュー対象の操作ではなく永続的なフレームバッファ状態なので、構築時に設定して問題ない。

### 5.2 パスごとに専用パイプライン（遅延実行に伴い新たに必要になった）

即時描画では「uniform設定 → 即描画 → 次のパス用に上書き」で成立していた。ノードは `vfunc_paint_target()` から戻った後に実行されるため、**パイプラインを共有したままだと全パスが最後のuniform値で描かれてしまう**。

Cogl のパイプラインはコピーオンワイトなので、パスごとにコピーを持たせる。ベースのオブジェクトが差し替わったとき（シェーダー再コンパイル時）だけ取り直す。

あわせて、`LayerNode` はフレームバッファをクリアしないため、従来の `clear4f()` の代わりにブレンドを置換 (`RGBA = ADD(SRC_COLOR, 0)`) に設定した。全パスが対象矩形を完全に覆うため等価であり、クリア1回分が減る。

### 5.3 パスグラフを厳密なDAGに（同じく遅延実行に伴う）

即時描画では各パスがその場で実行・フラッシュされるため、同じフレームバッファを行きと帰りで使い回す**ピンポン**が無害だった。遅延実行では Cogl が**フレームバッファ間の依存グラフを実際に構築**するため、これが閉路になる。

```
【修正前・ガウシアン】
pre : capture     → blurFbo[0]
H   : blurTex[0]  → tempFbo[0]      ... temp が blur に依存
V   : tempTex[0]  → blurFbo[0]      ... blur が temp に依存  ← 閉路
```

Dual Kawase も、ダウンサンプルが `blurFbo[i]` に書き、アップサンプルが `blurFbo[i-1]` に書き戻すため、隣接レベル間で相互依存していた。

Cogl は閉路を検出すると依存関係の登録を拒否し（`_cogl_framebuffer_add_dependency: assertion '!find_cycle (dependency, framebuffer)' failed`）、パスの実行順序が失われる。結果として合成パスは**一度も書き込まれていないブラーテクスチャ**をサンプリングし、**背景が完全に欠落してティント一色**になった。リムライトだけが正常に見えたのは、それがブラーレイヤーを読まないためである。

修正後は、レベルごとに専用の出力ターゲットを設け、**どのパスも先行パスが読んだフレームバッファには書き込まない**構成にした。

```
ガウシアン:  capture → blur0 → temp0 → up0          (結果 = up0)
Kawase n=1:  capture → blur0                        (結果 = blur0)
Kawase n≥2:  capture → blur0 → … → blur[n-1]
             blur[n-1] → up[n-2] → … → up0          (結果 = up0)
```

コストは半解像度テクスチャがレベルごとに1枚増えるだけ（961x560 の場合で約0.5MB）。

### 5.4 付随する修正

**クロップパスの復活（ノードとして）**

一度はUV化して排除したが、レイヤー0（生キャプチャ）とレイヤー1（プールテクスチャ）で異なるUV範囲が必要になり、`Clutter.PaintNode.add_multitexture_rectangle()` を要した。しかしこのAPIは**GJSから安全に呼べない**（後述）。クロップをノードとして戻せば全レイヤーが `0..1` に統一され、この問題自体が消える。

クロップを最初に削除した理由（中間FBOが前フレームの内容を配る）は、真の原因が判明した今では当てはまらない。ノードとして実行される限り正しい内容を読む。

---

## 6. 途中で踏んだ地雷

### 6.1 `add_multitexture_rectangle` による SIGSEGV

```
(method) Clutter.PaintNode.add_multitexture_rectangle(
  rect: Clutter.ActorBox, text_coords: number, text_coords_len: number): void
```

`text_coords` が **配列ではなく単一の `number`** として公開されている。GIR のアノテーションが実際に壊れている。

TSエラー `Argument of type 'number[]' is not assignable to parameter of type 'number'` を `as unknown as number` で黙らせた結果、GJS がJS配列を float ポインタとして native 側へ渡し、GNOME Shell が SIGSEGV でクラッシュした。

紛らわしいことに、**`Cogl.Framebuffer.draw_multitextured_rectangle` の方は `tex_coords: number[]` と正しくアノテートされている**。Clutter の PaintNode 版だけが壊れているため、即時描画版をそのまま移植することができなかった。

**教訓**: GJS バインディングにおける型エラーは、しばしば「バインディング自体が壊れている」ことを示す正当な警告である。キャストで黙らせるべきではない。

### 6.2 効かなかった同期の試み

`flush()` / `finish()` を試したが、いずれも **`paintContext.get_framebuffer()`（画面フレームバッファ）**に対する操作だった。問題の書き込みが行われるのは `OffscreenEffect` 内部のフレームバッファであり、JSからは到達できない。

そもそも同期の問題ではなかったため、正しい対象を同期できたとしても解決しなかった。

---

## 7. 残された診断ツール

再発時の切り分け用に、`global._lgDebug` として以下を残してある（Looking Glass から実行可能）。

| コマンド | 用途 |
|---|---|
| `effect(bool)` | オフスクリーンエフェクトの有効/無効 |
| `bg(bool)` / `base(bool)` / `overlay(bool)` | 各アクターの表示切替（経路の切り分け） |
| `drawMode(n)` | 0=通常, 1=passthrough, 2=生転送, 3=旧クロップ経路, 4=UVクロップ |
| `hops(n, finish, earlyFlush)` | 中間FBの往復回数を強制。`earlyFlush` が今回の決定打 |
| `syncMode(n)` | 各種同期の試行 |
| `geom(bool)` | `[fbo-geom]` ログ（サイズ・UV・変換行列）の出力 |
| `reset()` | 全オーバーライド解除 |

`drawMode(3)` は**意図的に旧クロップ経路（即時描画）を叩く**ようにしてあり、修正後の状態と元のバグをその場でA/B比較できる。

---

## 8. 教訓

### 技術的な教訓

1. **`vfunc_paint_target()` の中で Cogl の即時描画APIを使ってはいけない。** ペイントノードとして組み立てること。即時描画は構築フェーズで実行され、キャプチャより前になる。

2. **即時描画から遅延実行へ移行すると、暗黙の前提が3つ同時に壊れる。**
   - パイプラインの共有（uniformが最後の値になる）
   - フレームバッファのピンポン再利用（依存グラフの閉路になる）
   - `clear` のタイミング（`LayerNode` はクリアしない）

3. **偶然動いているコードは、症状を原因から遠ざける。** 画面FBへの描画が正しく見えていたせいで、「中間FBOが悪い」という誤った軸に長時間留まった。

### 調査手法の教訓

1. **同じ入力で結果が異なる2つの経路を見つけたら、入力側の調査は打ち切ってよい。** リングと内部の比較がそれにあたり、ここが転換点だった。

2. **1 vs 2 の比較は目視できない。増幅せよ。** 「往復2回は1回の2倍遅れるか」は判別不能だったが、「1回 vs 8回」にした途端に答えが出た（＝蓄積しない）。

3. **仮説と修正を混同しない。** 本調査では機構の説明を2回外した（キャッシュ再利用、ジャーナル順序）。いずれも観測とは整合していたが、予言が外れて棄却された。「全観測を説明できる」ことは正しさの証明にならない。

4. **決定的な実験は、差分が最小のものを設計する。** 最終的な決め手は `hops(0, false, false)` と `hops(0, false, true)` の比較で、**差はフラッシュ1行のみ**だった。これ以上小さくできない差分が、原因を一意に確定させた。

---

## 9. 副次的に解決した問題

`blur-radius = 0` のときにウィンドウのクローンが消失する問題も、本修正により解消した。同じ根本原因（レイヤー1が未書き込み/古いテクスチャを参照する経路）に由来していたものと考えられる。

---

# 追記: テクスチャの -3px オフセット — 原因と修正

**症状**: dock / menu / notification / application / OSD のすべてで、ガラス内部に描かれる内容が
左上に約 3px ずれる。

## 結論

`vfunc_paint_target()` は **アクターのローカル座標系では動いていない**。

`clutter_offscreen_effect_paint_texture()` は、`paint_target` を呼ぶ前に
`translate(fbo_offset_x, fbo_offset_y)` を持つ `ClutterTransformNode` を挟む。
そのうえで Clutter 標準の `paint_target` は、**テクスチャ全体**を
`(0, 0, texWidth, texHeight)` に描いている。

つまり `paint_target` の座標系は

- 単位 = キャプチャテクスチャの **1テクセル**
- 原点 = テクスチャの左上（アクターのローカル原点ではない）

本拡張は合成パスを `(0, 0, allocW, allocH)` に描いていたため、
ガラス全体が `fbo_offset` の分だけ左上へずれていた。

## fbo_offset の値

`clutter_offscreen_effect_pre_paint()` → `_clutter_actor_box_enlarge_for_effects()`:

```c
width = CLUTTER_NEARBYINT (box->x2 - box->x1);
box->x2 = ceilf (box->x2 + 0.75f);
box->x1 = box->x2 - width - 3;      /* ← パディング合計は常に 3px */
priv->fbo_offset_x = (int) box->x1;
```

整数サイズ・整数位置のアクターなら `x1 = -2`, `x2 = w + 1`。すなわち

| 辺 | パディング |
|---|---|
| 左 / 上 | **2px** |
| 右 / 下 | **1px** |

`961x560` のアクターで `964x563` のキャプチャという既知の実測値と一致する。

**パディングは中央寄せではない。** 従来の `padW / 2 = 1.5px` という仮定は
サンプリング位置も 0.5px ずらしていた。

## 修正

`utils.ts` に `computeCaptureLayout(actor, srcW, srcH, allocW, allocH)` を新設。
アクターのペイントボリュームから Clutter と同じ計算を再現し、

- `uv`  … キャプチャ内でアクター自身の画素が占める範囲
- `dest` … テクセル座標系での合成クアッドの矩形（= `[-off*s, ..., (alloc-off)*s, ...]`）

を返す。`liquidEffect.ts` の合成ノードは `dest` で描くようになった。
再現結果がテクスチャの実サイズと合わない場合（Clutter の変更、回転アクター、
ペイントボリュームが取れない場合）は従来の中央寄せ計算にフォールバックする。

`utils.ts` の `TextureBlitActor` も同じ中央寄せの誤りを持っていたので同関数に統一した。

## 副次的に判明したこと

- `ClutterLayerNode.pre_draw()` は **フレームバッファを clear4f している**。
  memo 本文 5.2 の「LayerNode はクリアしない」という記述は現行の Clutter では誤り
  （置換ブレンドのままでも実害はない）。
- `clutter_stage_paint_to_framebuffer()` は `CLUTTER_PAINT_FLAG_CLEAR` を渡さない限り
  オフスクリーンをクリアしない。`paint_to_content()` が確保するテクスチャは未初期化なので、
  ステージが塗らない領域はゴミになる。`SelfExcludingSnapshotCapture` に CLEAR を追加した。

## 残っている診断ツール

| コマンド | 用途 |
|---|---|
| `global._lgGlass.dump()` | 生存中の各 LiquidEffect の最終フレーム状態（uv / dest / プール / `blurResult`）|
| `global._lgGlass.count()` | インスタンス数 |

`glass.frag` は本体に **`cogl_sampler1`（ブラー済み）しか使っていない**
（`cogl_sampler0` と `blur_strength` は宣言だけで未使用）。
したがって「ブラーが効かずシャープに見える」場合、`dump()` の `blurResult` が
`NULL` になっているかどうかが決定的な切り分けになる。

---

# 追記2: Quick Settings の3件 — 原因と修正

`global._lgGlass.dump()` と `[snapshot:qs-panel]` ログで3件とも原因が確定した。

## A. Toggles の base color が ON/OFF に追従しない（MacTahoe のみ）

サブメニューの有無に関係なく発生する。**RGB は両状態とも純白で、違いはアルファだけだった。**

`_compositeOverAncestors()` は最後に **アンプリマルチプライ**（`outR / outA`）して返す。
MacTahoe の standalone `.quick-toggle` では:

```
OFF: rgba(255,255,255,0.15) → {r:1, g:1, b:1, a:0.15}
ON:  #ffffff                → {r:1, g:1, b:1, a:1.00}
```

[FIX-8] が「色はすでに画面上の見た目そのものだから」とアルファ重み付けを撤廃していたため、
**両状態でまったく同じ白**が渡っていた。

Adwaita で問題が出なかった理由は2つあり、どちらも「たまたま」である。

1. Adwaita は状態差を **RGB** で出す（無彩色の薄膜 vs アクセント色）。
2. Adwaita の `.popup-menu-content` は `#36363a`（**完全不透明**）なので、
   祖先合成が必ず coverage 1.0 に到達し、アルファの違い自体が発生しない。

MacTahoe は `.quick-settings { background: none }` でその `.popup-menu-content` を打ち消すため、
祖先を辿り切っても透明のまま = pod 自身のアルファが残る。

**修正**: base レイヤーの強度を coverage で重み付け（`baseStrength * baseAlpha`）。
祖先が不透明なテーマ（＝Adwaita のすべての pod）では完全な no-op。
[FIX-8] が本来直したかった「base とカスタムティントを独立レイヤーにする」点はそのまま。

また、MacTahoe の has-menu pod はラッパも内側ボタンも状態を持たず、
`.quick-toggle-icon` だけが動く（`rgba(255,255,255,.15)` → `white`）ため、
サンプリング候補にアイコンチップを追加した。
Adwaita の `.quick-toggle-icon` は背景を持たない（alpha 0）ので影響しない。

## B. blur が効いていないように見える（MacTahoe のみ）

**ブラーは正常に動いていた。** dump が `blurResult: 960x540`（null ではない）と示し、
`glass.frag` の領域内アルファも `float alpha = insideMask;` = 1.0（不透明）だった。

原因は `TOGGLE_GLASS_OVERLAY_OPACITY = 0.7` — **bgActor 自体の 30% 透過**。

この 0.7 は [FIX-2] 時代の遺物で、当時は bgActor が実パネルの**上**に描かれており、
実トグルのアイコン/ラベルを透かすために必要だった。
[FIX-STRUCTURAL-3] で構造が反転し、グラスホストは animActor の**最背面の子**になった
（`set_child_below_sibling` を毎フレーム再適用）ので、実トグルは自動的に手前に描かれる。
0.7 だけが残り、単にガラスを 30% 透けさせていた。

Adwaita ではその 30% の向こうが不透明な `#36363a` のパネル地なので気づかない。
MacTahoe は `.quick-settings { background: none }` でパネル地が完全に透明なため、
**30% の生デスクトップ（ブラーなし）** がそのまま見えていた。

**修正**: `TOGGLE_GLASS_OVERLAY_OPACITY = 1.0`。

> 補足: `glass.frag` の `panel_bg_*` / `panel_rect_*` uniform
> （Toggles モード用のパネル地フォールバック塗り）は
> `setPanelBackgroundColor()` / `setPanelRect()` がどこからも呼ばれておらず、
> `panel_bg_a = 0` の完全な no-op のままである。

## C. Toggles の背景クローンにパネルが含まれない（両テーマ）

ログが決定的だった。

```
[snapshot:qs-panel] empty capture rect (failures=1): x=NaN y=NaN w=0 h=0
[snapshot:qs-panel] empty capture rect (failures=2): x=0 y=0 w=0 h=0
[qs-panel-clone] no panel texture: capture has no content yet
```

`_menuRoot`（`menu.actor` の uiGroup 直下の祖先）が**セッション中ずっと 0x0**を返していた。
矩形が空だと `_captureOnce()` は `paint_to_content()` を呼ぶ前に return するため、
content は永遠に null、`TextureBlitActor` は何も描かず、
下に重なっている壁紙/ウィンドウのクローンだけが見える。

**修正**: 単一のアクターに依存せず、`_menuRoot` → `targetActor` → `animActor` の順で
使える geometry を返す最初の候補を採用する（`_resolvePanelActor()` / `_resolvePanelRect()`）。
スナップショットの矩形と blit の位置/サイズは必ず同じ関数から取る。
どれも使えない場合は各アクターの素性を1回だけログに出す。

**あわせて修正した性能問題**: `SelfExcludingSnapshotCapture` は `after-paint` 毎に
「hide → ステージ全体を paint_to_content → show」を実行しており、
`hide()/show()` が再描画をキューするため**自己持続的な全画面再描画ループ**になっていた。
しかもメニューが閉じていても止まらない。`activeCheck`（メニューが開いている間だけ動作）を追加した。

## D. 文字・アイコンが二重に見える（C の修正に付随）

C を直してスナップショットが機能し始めた結果、**パネルが描かれたまま丸ごと**
（トグルのラベル・アイコン込みで）キャプチャされるようになった。
グラスホストは animActor の最背面の子なので実トグルはグラスの手前にも描かれ、
同じ内容がグラス内にも屈折して現れる ＝ 二重表示。

**グラスの向こうに見えるべきものはパネルの「素材」**
（自身の背景 / border-image と、その向こうに透けるデスクトップ）
**であって、パネルの中身ではない。**

**修正**: `SelfExcludingSnapshotCapture` に毎キャプチャ評価される動的 hide リスト
（`extraHideProvider`）を追加し、`paint_to_content()` の1回の同期描画のあいだだけ
`animActor` の実子（グラスホスト以外の全部）を隠す。
animActor 自身の背景は描かれたまま残る。

副次的に、スナップショットの存在価値は「パネル素材」だけになった
（パネルより後ろにあるものは、この blit の下にある `_uiSampler` のクローンが既に供給している）。

### 確認したこと

`clutter_actor_paint()` に `needs_allocation` のガードは無い（GNOME 50 で確認済み）。
`hide()` は親に `queue_relayout()` をキューするが、実際の再配置はメインループまで走らないので、
隠す→描く→戻すの同期処理中は既存の（古いが妥当な）アロケーションでそのまま描画される。
したがってパネル背景はスナップショットに正しく残る。

なお `clutter_actor_paint()` は **opacity 0 のアクターを早期 return する**ので、
再配置を一切キューしたくない場合は `hide()` の代わりに `set_opacity(0)` も使える。

---

# 追記3: パネル素材レイヤー — 3つの失敗と最終形

Toggles モードでグラスの向こうに見せるべきものは
**パネルの「素材」**（自身の背景色 / グラデーション / border-image と、その向こうに透けるデスクトップ）
であって、パネルの**中身**ではない。中身はグラスの手前にシャープに描かれているため。

パネルより後ろにあるものは `_uiSampler` の（uiGroup の他の子すべての）クローンが既に供給しているので、
`_cloneContainer` に足りないのはその素材レイヤー1枚だけである。

## 失敗1: `Clutter.Clone(_menuRoot)`

bgActor は（animActor 経由で）`_menuRoot` の子孫。
Clone はソースの paint を再実行するため、ソースの paint がクローン自身のコンテナに戻ってくる。
同一フレーム内の無限再帰 → JS スタックオーバーフローで GNOME Shell がクラッシュ。

## 失敗2: `stage.paint_to_content()` スナップショット

`after-paint` ごとに bgActor を隠してパネル矩形をキャプチャ。再帰はなく、動作した。
しかし**描かれたままのパネル**を撮るので、ラベル・アイコンが二重に見える
（実物がグラスの手前 ＋ 同じものがグラス内に屈折して）。

## 失敗3: 失敗2 ＋ キャプチャ中だけ animActor の実子を hide

二重表示は消えたが、**同時に4つ壊れた**。すべて
「生きた・操作可能な・レイアウト済みのウィジェットの可視性を毎秒60回切り替える」ことの帰結である。

| 症状 | 原因 |
|---|---|
| quick settings 内のどこをクリックしてもメニューが閉じる | `hide()` はサブツリーを unmap する → キーフォーカスが外れる |
| パネル背景もクローンから消える | `hide()` は親に `queue_relayout()` をキューする |
| ある垂直線を境に左だけガラスが出る（位置はテーマ依存・再現手順不明） | ステージのダメージ領域の帳簿が壊れる。ハードな境界＝ダメージ矩形の縁 |
| 開閉アニメーションの最初・最後だけガラスが全部出る | アニメ中はパネル全体が毎フレーム damage されるので全域が再描画される（上と同じ原因の裏返し） |

**教訓**: ホスト側の実 UI の可視性を毎フレーム切り替えてはいけない。
Clutter の map / relayout / damage / 入力の帳簿すべてに触ってしまう。

## 最終形: テーマ背景だけを別ウィジェットに描かせる

`UnpickableStyledWidget`（`vfunc_pick` を no-op にした `St.Widget`）に
**実パネルの style class をコピーする**だけ。
St が同じ背景（背景色・グラデーション・border-image・角丸）を解決して描いてくれる。
クローンもスナップショットも無く、実パネルには一切触れない。

- 配置は実パネルの**アロケーション**に合わせる。
  St はウィジェットの背景を CSS margin の分だけ内側に描くので、
  テーマの margin をそのまま効かせれば実背景と同じ位置に落ちる
  （MacTahoe の `.popup-menu-content { margin: 4px 12px 17px 12px }`）。インラインスタイルで潰さないこと。
- style class は毎フレーム比較して変化時のみ設定（テーマ変更に追従、無駄な再スタイルなし）。
- 制約: クラス自身にマッチするセレクタしか効かない。
  実ウィジェットの祖先を前提にした子孫セレクタは適用されない
  （MacTahoe / Adwaita の該当ルールはいずれも素のクラスセレクタなので実害なし）。
