# パフォーマンス改善 — フェーズ別実装計画

**対象**: Liquid Glass (GNOME Shell 拡張機能)
**環境**: GNOME 50 / Clutter 18 / Mutter 18
**起点**: dock + 3 shown windows で重くなる（複数ユーザーからの報告あり）
**方針**: 品質低下を伴う最適化は、必ずユーザーが設定から選択可能な形にする

---

## 0. 前提となる計測結果

### 計測コマンド

```bash
env CLUTTER_SHOW_FPS=1 dbus-run-session -- gnome-shell --nested
```

```js
global._lgGlass.dump()
global._lgGlass.count()
```

### 着手前のベースライン（dock + 2 windows）

```
*** Meta-0 frame timings over 1.0s: 59.97 FPS, average: 4.4ms, peak: 5.4ms
```

```json
{"actor":"liquid-box","src":"1923x1083","alloc":"1920x1080","cropRan":true,"passCount":1,
 "pool":"1920x1080","blurResult":"960x540","paintOpacity":255,"paints":1297}
{"actor":"lgw-bg","src":"864x688","alloc":"861x685","cropRan":true,"passCount":1,
 "pool":"861x685","blurResult":"430x342","paintOpacity":255,"paints":2938}
{"actor":"lgw-bg","src":"393x639","alloc":"390x636","cropRan":true,"passCount":1,
 "pool":"390x636","blurResult":"195x318","paintOpacity":255,"paints":2352}
```

### この dump から確定した事実

1. **非アプリ系ガラス（dock / menu / notification / OSD / QS）は全てフルスクリーン FBO で動いている。**
   `liquid-box` の `src=1923x1083`, `pool=1920x1080`。dock の実サイズが 800x80 程度でも、
   キャプチャ・crop・blur・composite の全てが 1920x1080 で走っている。
   `dockManager.ts` の `bgActor.set_clip()` は親に掛かっており、`LiquidEffect` が乗っている
   子の `liquidBox` には clip がないため効かない。
   全マネージャが `setResolution(screenW, screenH)` を渡している
   （`dockManager.ts:728`, `uiManager.ts:715`, `notificationManager.ts:469`,
   `osdManager.ts:569`, `quickSettingsManager.ts:2159,2315`）。

2. **入れ子による paint 増幅が実測できる。**
   heartbeat `paintCount=2889` (14:17:32.099) → dump `paints=2938` (14:17:32.505)。
   0.406 秒で 49 回 = 120.7 paint/秒 = 60FPS 換算で **2.0 paint/フレーム**。
   dock + 2 windows の時点で、あるウィンドウのガラスは 1 フレームに 2 回
   blur+composite を走らせている。

3. **dock は既にダメージ駆動でしか再描画されていない。**
   dock の `paints=1297` はセッション中の推定フレーム数（約 2900）の 45%。
   つまり「常時 60fps 再描画」は dock には当てはまらず、
   `applicationManager._frameTick()` が無条件 `setResolution()` → `queue_repaint()` を
   呼んでいるアプリウィンドウ側だけの問題。

4. **`cropRan: true` が全インスタンスで立っている。** crop パスは毎フレーム実行されている。

---

## 1. 各フェーズ共通の検証手順

各フェーズごとに以下 3 点を記録し、`git commit` を分けて退行時に二分探索できるようにする。

1. `average` / `peak` フレーム時間（ベースライン: 4.4ms / 5.4ms）
2. `dump()` の `paints` を 2 回サンプルして求めた **フレームあたりの paint 回数**
   （ベースライン: `lgw-bg` で 2.0 回/フレーム）

   フェーズ 1 以降、`dump()` の `paints` / `composited` / `snapshotAgeMs` は
   スナップショットではなく **dump 実行時点のライブ値** を返す。
   `glass-debug-diagnostics` が false だと他のフィールドは約 1 秒古くなるが、
   この 3 つは常に正確なので、上のサンプリングはそのまま使える
   （`snapshotAgeMs` が他フィールドの古さを示す）。
3. 静止画面で FPS カウンタが出続けるか（ベースライン: 出続ける = 常時再描画）

TS を編集したら必ず以下を実行する。

```bash
cd liquid-glass@thinkingcoding1231.gmail.com && npm run build
```

---

## フェーズ 1 — 出力が一切変わらないもの（まとめて実施）

数学的・意味的に等価で、目視差分が原理的に出ない変更のみ。一括で実施してよい。

| # | 項目 | 対象ファイル |
|---|---|---|
| 1 | `vec4 source = texture2D(cogl_sampler1, uv);` の死んだフェッチ削除。以降どこからも参照されていない | `shaders/glass.frag` |
| 2 | Gaussian pre-pass 専用の 1 タップパススルーパイプライン。現状は `downsample.frag` を `blur_radius=0` で使っており、同一座標を 5 回フェッチしている | `shaders/passthrough.frag`(新規), `liquidEffect.ts` |
| 3 | 色収差が無効 / 1 テクセル未満のとき RGB をまとめて 4 フェッチ（12→4）。`uvR == uvG == uvB` なので数学的に等価 | `shaders/glass.frag` |
| 4 | uniform の差分更新 + スクラッチ配列の使い回し。現状は毎 paint で全 uniform（約 60 個 + 配列 8 本）を無条件に書き戻し、`set_uniform_float(loc, 1, 1, [value])` で毎回 JS 配列を確保している | `liquidEffect.ts` |
| 5 | 診断コードを `glass-debug-diagnostics` (bool, 既定 false) でガード。`_diagLast` は OFF 時は 1 秒に 1 回だけ更新し `dump()` の実用性を維持 | `liquidEffect.ts`, `schemas/*.xml`, `prefs.js` |
| ~~6~~ | ~~`paintOpacity < 8` で `super.vfunc_paint_target()` に落とす早期 return~~ → **フェーズ 1 から除外**（下記） | — |

**期待効果**: composite のテクスチャ帯域が最大 1/3、GC 圧の大幅減。
**検証**: 目視で一切変化がないこと。変化したらどれかがバグ。

### 除外した項目 6 について

実装直前に成立しないことが判明したので、フェーズ 1 から外した。

- `paintOpacity == 0` なら `cogl_color_out = vec4(...) * cogl_color_in = 0` となり、
  プリマルチプライドの ADD ブレンド（`SRC + DST*(1-SRC.a)`）では寄与が完全にゼロ。
  よってスキップは厳密に等価。**しかしそもそも到達しない** —
  `clutter_actor_paint()` は opacity 0 のアクターを早期 return するため。
- `paintOpacity` が 0 より大きい場合、`super.vfunc_paint_target()` は
  「ガラス合成なしの生キャプチャ」を描くので、**出力は等価ではない**。
  opacity 3/255 なら見えないだろうという議論はできるが、
  フェーズ 1 の「出力が一切変わらない」という前提には反する。
- 実利も薄い。ベースラインの dump で `paintOpacity` が 3 / 25 だったインスタンスの
  `paints` は 79 / 116 で、全フレーム数（約 2900）の 4% 程度しか paint していない。

出力が変わる形でしか実装できず効果も小さいため、採用しない。
どうしても入れるならフェーズ 2 扱い（1 項目ずつ目視確認）とすること。

### 補足: なぜ #4 が効くのか

`_applyPendingUniforms()` は毎 paint で全 uniform を書き戻す。paint が 1 フレームに
2 回走る現状では 60 x 2 = 120 個の一時 JS 配列 / フレーム = 約 7,200 個/秒。
GJS の GC はコンポジタスレッドで走るため、これはフレーム落ちに直結する。

### 補足: なぜ #5 が必要か

`liquidEffect.ts` の `[DIAG]` ブロックは毎 paint で無条件に
`GLib.get_monotonic_time()` とクロージャ経由の
`get_actor().get_meta_window().get_title()` を実行している。
`_diagLast` も毎 paint でオブジェクト + `.map()` + `.toFixed()` を実行する。
ログ出力が OFF でも全て走る。

`output-logs` とは別キーにする理由: ログを見たいだけのユーザーが
paint ごとの重い診断を有効化してしまうのを避けるため。

### フェーズ 1 の計測結果（2026-09-08, `~/log__2.log`）

**機能面**: 問題なし。Cogl のエラー・`_cogl_framebuffer_add_dependency` の閉路アサーション・
`[Liquid Glass]` 由来のエラーはいずれもゼロ。全インスタンスで `blurResult` は非 NULL。
`snapshotAgeMs` / `composited` フィールドが出ているので新コードが動いていることを確認。
paint ごとの FIRST/heartbeat ログが消えているので診断ガードも効いている。

**フレーム時間**（`average` の平均値）:

| 状態 | 平均 | サンプル数 |
|---|---|---|
| dock + 2 windows（フェーズ1 前・前回セッション） | 4.30ms | 2 |
| dock + 2 windows（フェーズ1 後・15:55:31〜35） | 3.69ms | 7 |
| dock + 2 windows（フェーズ1 後・15:56:16〜23） | 3.97ms | 13 |
| **dock + 2 windows（フェーズ1 後・合算）** | **3.87ms** | **20** |
| dock + 3 windows（フェーズ1 後） | 6.50ms | 26 |

ウィンドウは前回と同一（`861x685` と `390x636`）なので同条件比較。**約 10% 改善**。
独立した 2 区間で符号が一致している。ただし比較対象のベースラインが 2 サンプルしかない。

**paint 増幅の実測（最重要）**

各インスタンスの `paints` を生成時刻で割って 60 で割ったもの。
dump1 の値は「ウィンドウが少なかった期間」も平均に含むので、実際の dock+3 時の値は
これより **高い**（保守的な見積り）。

| 状態 | dock | 最上位 win | 中間 win | 最下位 win | 合計 |
|---|---|---|---|---|---|
| dock + 2 windows | 0.99 | 1.77 | — | 5.50 | **8.3 回/フレーム** |
| dock + 3 windows | 0.99 | 1.96 | 4.58 | **10.99** | **18.5 回/フレーム** |

- dock はちょうど 1.0 回/フレーム（ダメージ駆動が効いている）。
- **スタックの下にいるほど指数的に増える。** ウィンドウを 1 枚足すと
  最下位ウィンドウの paint 回数が 5.5 → 11.0 と倍増する。
- 合計 8.3 → 18.5（2.2 倍）に対し、フレーム時間は 3.87 → 6.50ms（1.68 倍）。

この数字が意味すること:

1. **フェーズ 2 (B1) の価値は単体見積りの約 18 倍**。composite の削減は
   18.5 回すべてに掛かるため。次にやるべきはやはりフェーズ 2。
2. **フェーズ 7 (A1) の効果は当初見積り（2.0 → 1.0 回/フレーム）より遥かに大きい**。
   18.5 本走っている blur チェーンを 4 本に落とせる可能性がある。
   優先度の再検討に値する。

**`CLUTTER_SHOW_FPS` の `average` は CPU 側の時間である（ソースで確認済み）**

mutter 50.1 のソース（`clutter/clutter/clutter-stage-view.c`）で確定した。
`handle_frame_clock_frame()` が計測区間を張っている:

```c
if (clutter_context_get_show_fps (context))
  begin_frame_timing_measurement (view);          // ← 開始

_clutter_run_repaint_functions (PRE_PAINT);
clutter_stage_emit_before_update (...);
clutter_stage_maybe_relayout (...);               // レイアウト
clutter_stage_finish_layout (...);
_clutter_stage_window_prepare_frame (...);
...
_clutter_stage_window_redraw_view (...);          // ペイントノード構築＋GL コマンド発行
clutter_frame_clock_record_flip_time (...);
clutter_stage_emit_after_paint (...);
if (clutter_context_get_show_fps (context))
  end_frame_timing_measurement (view);            // ← 終了
```

`end_frame_timing_measurement()` は `draw_time_us = now - began_draw_time_us` を
累積して平均・最大を出す。つまり **レイアウト＋ペイントノード構築＋GL コマンド発行＋
フリップまでの CPU 実時間**であって、GPU の実行完了は待っていない。

**したがってシェーダーのフェッチ／ALU 削減はこの数字にはほとんど表れない。**
GPU 側は別に測る必要がある。

**GPU 使用率の実測（2026-09-08）**

```bash
while true; do echo -n "$(date '+[%H:%M:%S]') "; cat /sys/class/drm/card1/device/gpu_busy_percent; sleep 1; done
```

| 状態 | GPU 使用率 | CPU 側 average |
|---|---|---|
| アイドル（シェル起動前） | 1% | — |
| dock のみ | 5〜11% | 〜2.6ms |
| dock + 2 windows | 41〜46% | 〜3.5ms |
| dock + 3 windows | 54〜66% | 〜6.3ms |

**統合 GPU (Radeon 780M) の 6 割を、デスクトップを描くためだけに使っている。**
CPU 側 3.5〜6.3ms という数字からは見えなかったコストがここにある。
以後、フレーム時間と GPU 使用率の **両方** を記録すること。

---

## フェーズ 2 — 描画コストの本丸

1 項目ずつコミットして目視確認する。

| # | 項目 | 状態 |
|---|---|---|
| 7 | **B1 早期リターン**（内部・外部の 2 経路） | 実装済み |
| 8 | ~~**B6 4σ→3σ**~~ | **中止**（下記） |

### #7 実装した内容

`glass.frag` の `main()` に、マスク算出直後の 2 つの早期リターンを追加。

**Exit 1 — 影の届かない外側** (`d >= max(shadowReach, edgeFeather)`)

`shadowReach = multi_region_mode ? 0.0 : max(shadow_max_radius, 5.0)`。
`maxRadius` を超えると影ブロックは `1.0 - step(maxRadius, d)` で 0 になり、
`d >= edgeFeather` で `insideMask` も 0。つまり `alpha` も
`shadowContribution` も `finalRgb` も厳密に 0 で、書き得るのは
パネルフォールバックの塗りだけ。Toggles モードは `shadowAlpha` を
無条件に 0 にするので、そこでは `edgeFeather` から抜けられる。

**フルスクリーン FBO のサーフェス（dock / menu / notification / OSD / QS）では
これが画面の大半を占める。** dock なら 1920x1080 のうちガラス＋影が
占めるのは 1200x480 程度なので、残り約 7 割が丸ごとこのパスに落ちる。

**Exit 2 — 平坦な内部** (`-d >= interiorThreshold`)

```glsl
interiorThreshold = max(
    max(corner_radius + gradientStep(resolution) + max(edge_smoothing, 1.0),
        edgeFeather * 4.0),
    max(ao_radius, rim_width));
```

高さプロファイルがプラトーに達していて `heightGradient() == 0`、
したがって `normal == (0,0,1)`、`refract()` は `(0,0,-1)` を返し変位 0。
法線が平坦なので `rimDot = 1 - dot(N, viewDir) = 0` でフレネルリムも 0、
`edgeBand` は `rim_width` を超えて 0、AO 帯も `ao_radius` を超えて 0、
`insideMask == 1` なので影も寄与せず、パネル塗りも `(1 - finalAlpha) == 0` で消える。

残るのは `N = (0,0,1)` で評価したスペキュラとシーンの 2 項だけで、
これは領域全体で**定数**。`specMask` は `mix(0.25,1,1) * clamp(0 + 0.65, 0, 1) = 0.65`
に、`specularDot` と `sheenFacing` はどちらも `lightDir.z` に潰れる。

閾値は SDF が 1-リプシッツであることを使い、勾配の有限差分近傍
（`gradientStep()` 幅）も込みで全項を同時にクリアするように取っている。

**数値検証**: スライダーの全レンジ（`corner_radius` 0〜200、`edge_smoothing` 0〜20、
`ao_radius` 0〜50、`rim_width` 0〜50、`max_z` 0〜100、`profile_shape_n` 1.01〜10、
解像度 5 種）をランダムに振り、閾値ちょうど／わずかに内側の
**66,746 点**で以下を確認した。すべて**偏差 0.000e+00**（誤差ではなく厳密一致）。

| 検証項目 | 最大偏差 |
|---|---|
| `heightGradient()` が 0 | 0.000e+00 |
| `rimDot` が 0 | 0.000e+00 |
| `aoMask` が 0 | 0.000e+00 |
| `edgeBand` が 0 | 0.000e+00 |
| `insideMask` が 1 | 0.000e+00 |
| `specMask` が 0.65 | 0.000e+00 |

検証スクリプトはスクラッチに置いてある（`verify_b1.py`）。

### #8 B6 を中止した理由

`liquidEffect.ts` の該当行にコメントが残っていた。

```ts
// Number of one-sided taps needed to satisfy the 4-sigma rule (changed from 3
// to prevent abrupt truncation ringing/grid artifacts at integer multiples),
const sideTaps = Math.max(2, Math.ceil(kernelSigma * 4));
```

**3σ → 4σ は「整数倍のところで打ち切りリンギング／格子状アーティファクトが出る」
のを直すための変更だった。** 3σ に戻すのは、その修正を取り消すことになる。

効果も小さい。実測環境の `targetRadius: 7` では
`sigmaTexel = 3.5` → `sideTaps = 14` → `fetchPairs = 7` → **15 フェッチ**、
3σ にしても `ceil(10.5) = 11` → `pairs = 6` → **13 フェッチ**で、H/V パスが 13% 減るだけ。

**リンギングを再発させずに短くしたいなら、カーネルに窓関数を掛ける**
（ハン窓等でテーパーさせて打ち切りを滑らかにする）のが正攻法。
`_computeGaussianKernel()` で重みを生成する際に窓を乗じて再正規化すれば、
3σ 相当の長さでもリンギングは出ない。これは別項目として扱うべき。

### #7 の根拠

ガラスの深い内部では数学的に `gradH == 0` → `normal == (0,0,1)` → `disp == 0` になり、
結果は「ブラー済みテクスチャを 1 回サンプルして SCB/tint を掛けただけ」と同一。
ウィンドウのガラスは面積の 85〜95% がこの領域。
分岐は空間的にコヒーレントなので GPU の warp はほぼ分岐しない。

**期待効果**: フェーズ 1・2 合計で `average` が半分程度まで落ちるのが目標。
**検証**: 閾値の境界に継ぎ目（縞・段差）が出ないこと。
角丸部分と `ao_radius` 最大時が最も出やすい。

---

## フェーズ 3 — 再描画の駆動を直す

| # | 項目 | 状態 |
|---|---|---|
| 9 | **A2** 無条件 `queue_repaint()` の撤廃 | 実装済み |
| 10 | **C3** `_syncStateInner` のジオメトリ半分をスキップ | 実装済み（範囲を縮小） |

### #9 実装した内容

`_setFloat()` / `_setFloatArray()` を「値が実際に変わったときだけ」
`_uniformsDirty` を立てるようにし、純粋に uniform を書くだけの
setter 14 個の `queue_repaint()` を `_queueRepaintIfDirty()` に置換した。

置換した setter: `setSurfaceLightEnabled` / `setTintColor` /
`setPanelBackgroundColor` / `setPanelRect` / `setTintStrength` /
`setCornerRadius` / `setAnimationScale` / `setResolution` /
`setGlassGeometry` / `setMultiRegionMode` / `setGlassRegions` /
`setBrightness` / `setContrast` / `setSaturation`。

**無条件のまま残した**もの（uniform 以外の副作用があるため）:
`reloadShaders` / `setBlurMethod` / `setBlurRadius` の各経路 / シェーダー非同期ロード完了時。

`_setFloatArray` は配列の中身を要素ごとに比較し、**コピーを保持する**ようにした。
呼び出し側は配列を使い回して書き換えるので、渡されたオブジェクトをそのまま
持つと「自分自身と比較」して永久に変化を検出できなくなるため。

### #10 実装した内容と、意図的に縮小した範囲

当初案は「全入力が同値なら `_syncStateInner` を丸ごと return」だったが、
**クローン同期は毎フレーム走らせる形に縮小**した。

理由: 背後ウィンドウは、このウィンドウ自身のジオメトリが一切変わらないまま
移動・リサイズ・フェード・アンマップし得る。クローンが古い位置に取り残されるのは
このファイルが最も繰り返し踏んできた失敗であり（memo.md 3.2 参照）、
そこを賭けの対象にする価値はない。

スキップするのは**トップレベルのジオメトリ書き込みだけ**:
`_applyCounterScale` x3、`clipBox` / 各コンテナの `set_size`、
`setResolution` / `setGlassGeometry`、`_syncAnimatedCornerRadius`、
4 本の `constraint.setOffset`、コーナーオーバーレイの配置。

**毎フレーム走らせ続けるもの**:
- `_syncClones()`（上記の理由でインライン展開から関数に切り出し、両経路から呼ぶ）
- `_checkContainerAnchor()` — サブツリーがアロケーションを失った検出器。
  ジオメトリが不変でも起こり得るので、その判定結果が
  「fast path を取ってよいか」のゲートになっている
- `ensureGlassAllocated()`（`_frameTick()` 側、この関数の外）

比較はハッシュではなく **17 要素の `Float64Array` による厳密比較**。
ハッシュ衝突は 1 フレーム分のジオメトリ更新を落とすことになり、
それはこのファイルの既知バグとまったく同じ形をしているため。
初回は `NaN` で埋めてあるので（NaN は自分自身と等しくない）必ずミスする。

**実装中に見つけて塞いだ穴**: グラスを隠す 4 箇所
（ワークスペース不一致 / 縮退した矩形 / アンカー異常 / ステージ外・未マップ）は
書き込み半分を実行せずに return する。署名を残したままだと、
同一ジオメトリで戻ってきたときに fast path が成立してしまい、
**二度と再表示されない**。4 箇所すべてで `state.geomSig = undefined` する。

### A2 が安全である根拠

`Clutter.Effect.queue_repaint()` は「アクターの中身は変わっていないがエフェクトの
パラメータが変わった」ときのための API。中身が変わったケースは別経路で処理される。

```
ソースウィンドウの内容が変化
  → MetaWindowActor がダメージ → queue_redraw
  → Clutter.Clone は source の 'queue-redraw' を購読しており自身も queue_redraw
  → 親（windowsContainer → clipBox → bgActor）へ伝播
  → bgActor が dirty = CLUTTER_EFFECT_PAINT_ACTOR_DIRTY
  → LiquidEffect がキャプチャからやり直され vfunc_paint_target が走る
```

実測面でも dock は既に 45% のフレームでしか paint しておらず、それで見た目は正しい。

**検証（最重要）**: 以下が全て追従することを個別に確認する。
- 背後ウィンドウの内容変化（動画再生、端末のカーソル点滅）
- ウィンドウの移動 / リサイズ / 最大化アニメーション
- 壁紙変更、ワークスペース切替
- 設定変更（blur radius スライダーを動かす）

**中断ポイント**: 追従しないものが 1 つでもあれば A2 を戻し、C3 だけ残す。

**備考**: C1（フェーズ1）と A2 が入ると `beginBatch`/`endBatch` はほぼ no-op になるが、
害はないのでこの時点では触らない。

---

## フェーズ 4 — 法線の作り直し

| # | 項目 | 内容 |
|---|---|---|
| 11 | **B3 解析勾配** | `∇h = g'(d)·∇d`。`∇d` は `heightGradientFast` の `dir` をそのまま流用、`g'(d)` は `profileHeight` の閉形式微分。`getHeight` 4 回→0 回、`pow` 8 個→2 個 |
| 12 | **fast_mode 廃止** | `glass.frag` の `fast_mode` uniform と `heightGradientFast()`、`liquidEffect.setFastMode()`、`applicationManager.ts` の呼び出し、`glass.frag` の影の `fast_mode` 分岐 |

### 根拠

`getHeight(p) = g(sdRoundRect(p))` であり、p に依存するのは d 経由だけなので
`∇h = g'(d)·∇d` と厳密に書ける。`∇d`（丸角矩形 SDF の勾配）の解析式は
`heightGradientFast` が既に `dir` として計算済み。
つまり `heightGradientFast` は解析勾配の片側差分版であり、完全版の方が速くて正確。
`fast_mode` 分岐が存在する意味がなくなる。

**期待効果**: 内部を除いたエッジ帯の ALU が大幅減。法線精度は中央差分より向上
（`gradientStep` のスケール依存が消える）。
**検証**: リムライト・スペキュラ・屈折の見え方。
`glass-profile-shape-n` と `glass-max-z` を両端まで振って旧実装と比較。
ドラッグ中と静止中で見た目が変わらなくなることも確認。

---

## フェーズ 5 — crop パス削除（実装済み・2026-09-09）

### 削除できた理由

crop パスは**キャプチャをパディングなしのテクスチャに全解像度でコピーするだけ**の
パスで、全画面サーフェスなら 1920x1080 を 1 paint につき 1 回。

存在理由は composite の 2 レイヤーのテクスチャ座標範囲を揃えることだけだった。
レイヤー1（プールテクスチャ）はパディングなしで 0..1、
レイヤー0（生キャプチャ）は `ClutterOffscreenEffect` が付けるパディング込みで
サブ矩形が要る。`add_texture_rectangle()` は座標を 1 組しか運べず、
レイヤーごとに渡す `add_multitexture_rectangle()` は
**GJS から安全に呼べない**（座標配列がスカラーと誤注釈されていて SIGSEGV、memo.md 6.1）。
だから差を消すために crop があった。

差はタダで消せる。**`glass.frag` は `cogl_sampler1` しか読まない**ので
レイヤー0 の中身は無関係で、**両レイヤーにブラー結果を束ねれば 1 つの範囲で足りる**。
ブラーチェーン側も crop は不要だった —— 初段は既に `srcUV` で
キャプチャの有効サブ矩形をサンプリングしている
（`_runGaussianBlur` / `_runDualKawaseBlur`）。

### 新しい経路ではない

**A1 の再利用パスが、まさにこの経路を大多数の paint で既に通っていた**
（crop スキップ + レイヤー0 にブラー結果）。実機で正常動作を確認済み。
memo.md 3.2(c) の「クロップを UV 化したら遅延が再発した」は即時描画時代の話で、
A1 の検証時にドラッグ・動画再生とも遅延なしを確認している。
今回はそれを唯一の経路にしただけ。

### 削除したもの

`_addCropPassNode` / `_ensureCropTarget` / `_destroyCropTarget` /
`_cropTexture` / `_cropFbo` / `_cropPoolW` / `_cropPoolH`、
および dump の `cropRan` フィールド。

`_passthroughPipeline`（フェーズ1で追加した 1 タップコピー）は
Gaussian の pre-pass が使い続けるので残る。

### 効果

- **フルサイズのレンダーパスが 1 本、1 チェーンにつき消える**
  （全画面サーフェスなら 1920x1080 の書き込み + `ClutterLayerNode` の clear）
- VRAM: フルサイズ RGBA テクスチャ 1 枚分をインスタンスごとに解放
  （1920x1080 なら 8.3MB）

A1 により 1 フレームあたりのチェーン数は既に 4 なので、
削減量は「4 パス分のフル解像度書き込み/フレーム」。

## 退行: テクスチャ遅延の再発（2026-09-09）

B2（crop 削除）と A1（ブラー再利用）が**両方有効になった状態**で、
memo.md 冒頭のテクスチャ遅延（ドラッグ中にガラス内部の背景が 1 フレーム遅れる）が
再発した。

消去法での切り分け:

| 状態 | 遅延 |
|---|---|
| A1 のみ（B2 なし） | なし |
| B2 のみ（A1 はフレームバッファキーのバグで無効化されていた） | なし |
| **A1 + B2 の両方** | **あり** |

**単独では両方とも問題なく、組み合わせでのみ出る。**

### ⚠ 追試の結果、この推測は否定された

crop を A/B トグル付きで復活させたあと実測したところ:

- crop 有効 → 遅延なし
- **`global._lgGlass.cropPass(false)`（＝ B2 とまったく同じ描画構成）→ 遅延なし**

**crop は変数ではなかった。** 「A1 と B2 の相互作用」という推測は成り立たない。
ユーザーからも「遅延は前の段階から起きていた可能性がある（未確認）」との補足。

つまり**この遅延の原因は未特定のまま**であり、現時点で再現もしていない。
「crop を戻したら直った」とは言えない —— 戻す前の構成でも今は出ない。

考えられること:
- 特定の操作パターン（ドラッグの速度・対象ウィンドウ・重なり方）でのみ出る間欠的な現象
- 別の要因（BMS の有効/無効、ウィンドウ構成など）との組み合わせ
- 観測の誤り

**次に見えたときは、再現手順（どのウィンドウをどう動かしたか、
BMS の状態、`cropPass` の状態）を記録すること。**
それがないと切り分けようがない。

### 対応（暫定）

**crop を復活させ、既定で ON。** 原因が特定できていない以上、
memo.md が「復活させた」と記録している側の構成に寄せておく。 ただし単純な revert ではなく
`LiquidEffect.USE_CROP_PASS`（既定 true）＋
`global._lgGlass.cropPass(bool)` の A/B トグル付きにした。
**計画に「A/B 切替フラグ必須」と書いておきながら初回実装で省いたのが
そもそもの落ち度**で、あれば 1 セッションで切り分けられていた。

crop 自体は 1 タップのパススルーパイプラインを使う版のまま
（フェーズ1 の改善は保持）。

### B2 を将来やり直すなら

- 遅延の再現手順が手に入るまで既定を変えない
- `cropPass(true/false)` を**同一セッション・同一場面**で切り替えて
  GPU 使用率の差を取る。crop 1 本ぶんの実コストがまだ数字になっていない
- A3（FBO 実サイズ化）で全画面 FBO が小さくなれば、
  crop 1 本のコスト自体が下がるので、B2 の価値も相対的に下がる

---

## フェーズ 6 — 常駐コストの掃除（互いに独立、まとめて可）

| # | 項目 | 対象ファイル |
|---|---|---|
| 14 | **C4** contrastSampler を `stage.paint_to_buffer(rect, scale, buf, stride, RGBA_8888, null, NO_CURSORS\|CLEAR)` に。`scale` で 16x24 程度に縮小して描かせる。PNG / ディスク往復を全廃。**サンプル間隔は 200ms のまま** | `contrastSampler.ts` |
| 15 | バネアニメ・色トゥイーンを `GLib.timeout_add(16/32ms)` から `Meta.LaterType.BEFORE_REDRAW` / `add_tick_callback()` に | `uiManager.ts`, `quickSettingsManager.ts`, `notificationManager.ts`, `osdManager.ts` |
| 16 | `UILayerSampler.refresh()` の毎フレーム全スキャンを `uiGroup` の `actor-added`/`actor-removed` シグナル駆動に | `utils.ts` |
| 17 | `SelfExcludingSnapshotCapture` の `FRAME_SKIP=1` 見直し（BMS 併用時のみ発動） | `utils.ts` |
| 18 | `glass-blur-downscale` (i, 2 or 4, 既定 2) 追加。`_buildTexturePool` の初段を `w>>2` に、`_setGaussianBlurRadius` の `RES_SCALE` を 4.0 に | `liquidEffect.ts`, schema, prefs |

### C4 の根拠と注意

現状は `Shell.Screenshot.screenshot_area` → PNG エンコード → `/tmp` へ書き込み →
`GdkPixbuf.new_from_file` → PNG デコード → 間引きサンプル → `unlink`。
`Clutter.Stage.paint_to_buffer()` は Clutter 18 に存在し、
`node_modules/@girs/clutter-18` の型定義でも `data: Uint8Array` と
正しくアノテートされている（memo.md 6.1 の `add_multitexture_rectangle` とは逆のケース）。

`scale` を渡せば低解像度で描かせられる。既存の `sampleLuminance()` も
`step = max(1, min(w,h)/48)` で 48x48 相当に間引いているので、
最初から低解像度で描かせるのは品質的に等価（GPU のダウンサンプルの方がむしろ安定）。

- `PaintFlag.CLEAR` を必ず付ける（memo.md 追記1: 付けないと未初期化テクスチャのゴミを読む）
- `hide()` は使わない（memo.md 追記3 失敗3: ホスト側の実 UI の可視性を毎フレーム
  切り替えると map / relayout / damage / 入力の帳簿すべてが壊れる）
- `samplePerElement: true` にすると要素数ぶん連続で呼ぶことになるので既定の `false` を維持

### #18 の注意

これは唯一の明示的な品質低下オプションなので、prefs の説明文に
「ブラーが粗くなる代わりに大幅に軽くなる」と明記する。

---

## フェーズ 7 — 入れ子描画（実装済み・2026-09-08）

### 実装した内容

**フレームシリアル**: `global.stage` の `'after-paint'` でモジュールスコープの
カウンタを進める。同一フレーム内の paint は同じシリアルを持つ。
マルチモニタはシグナルがステージビューごとに発火するので、
特別扱いせずに「各ビューの初回 paint でチェーンを走らせる」形に自然に落ちる。

**再利用の判定**: そのフレームで**初回の paint だけ**が
crop → downsample → H → V を実行し、2 回目以降は `_blurResultTex` を
そのまま使って composite だけ行う。

正しさの根拠は 2 点:

1. **入力が同一**。同一フレーム内のどの paint も、同じアクターのサブツリーを
   同じキャプチャテクスチャに描く。そのブラーが違う値になりようがない。
2. **初回 paint のノードが先に実行される**。ペイントノードは木の順に実行され、
   `Clutter.Clone` は必ずソースより後に描かれる（dock はウィンドウより上、
   ウィンドウはその下のウィンドウより上）。したがってプールは
   どの再利用よりも先に書かれる。**同一フレーム内の再利用であって
   前フレームの使い回しではない**ので、背景の変化は 0 フレーム遅延で反映される。

### 塞いだ失敗モード

`'after-paint'` の接続に失敗すると `_frameSerial` は 0 のまま凍結する。
そのとき素朴に実装すると **2 回目以降の paint が全て「同一フレーム」と誤判定され、
ブラーが 1 回だけ計算されて永久に使い回される** ——
ガラスが最初のフレームの内容で凍る。

`_frameSerialIsLive()` を導入し、カウンタが生きていないときは
**全 paint を初回扱い**（＝この最適化を入れる前と同じ挙動）にした。
その間 `_blurFrameSerial` は更新しないので、
後からフックが張れたときに古い値と衝突することもない。
フックの接続は `_init()` だけでなく paint 時にも再試行する
（`global.stage` に届く前に生成されるインスタンスがあるため）。

### composite のレイヤー整合

再利用時は crop を飛ばすので `effectiveTex` はパディング付きの生キャプチャになり
`srcUV` が必要になる。一方レイヤー1（プールテクスチャ）は 0..1 が必要。
`add_texture_rectangle()` はテクスチャ座標を 1 組しか運べないので両者は一致が要る。

**再利用時はレイヤー0 にもブラー結果を束ねる**ことで一致させた。
`glass.frag` は `cogl_sampler1` しか読まない（`cogl_sampler0` は宣言のみ、
memo.md にも明記）ので、レイヤー0 に何を束ねてもサンプラー状態以外に影響しない。
将来レイヤー0 を「シャープなキャプチャ」として読み始めるなら、
この束ね方と crop のスキップを見直す必要がある——その旨をコードに明記した。

### 設定

`glass-nested-glass` (bool, 既定 true)。false にすると、
2 回目以降の paint は `super.vfunc_paint_target()` に落ちて
**ガラスなしのキャプチャ内容をそのまま描く**。
内側のウィンドウは自分のガラスを失うが、さらに軽くなる。
prefs の Glass タブに Performance グループを新設して配置した。

### 計測用

`dump()` に `blurRuns` / `blurSkips` を追加。
`blurRuns` が実際に実行されたチェーン数、`blurSkips` が再利用された回数。
**`paints` は減らないが `blurRuns` が 1/フレームに張り付くはず。**

期待値（dock + 3 windows、実測 22.63 paints/フレーム）:
`blurRuns` の合計が 22.63 → **4** 前後に落ちる。

### 計測結果（2026-09-09, dock + 3 windows）

**`blurRuns` は完全に 1 チェーン/フレームに張り付いた。**
2 つの dump の差分（40.43 秒間）:

| インスタンス | blurRuns の増加 |
|---|---|
| dock | **1330** |
| application (1053x877) | **1330** |
| application (852x788) | **1330** |
| application (582x828) | **1330** |

4 インスタンスすべてが**完全に同じ 1330**。
その間にシェルが描いたフレーム数がちょうど 1330（40.43 秒で平均 32.9 FPS ——
A2 により静止フレームは再描画されないので 60 を下回る）。
つまり**どのインスタンスも、自分が描かれるフレームごとにチェーンを厳密に 1 回**しか
走らせていない。

合計ブラーチェーン数: **22.63 → 4.0 回/フレーム（5.7 分の 1）**

**GPU 使用率**:

| 状態 | GPU |
|---|---|
| 施策前（フェーズ1〜3 まで適用済み） | **68%** |
| コーナーリビール無効 + baseActor 停止 + A1 | **38〜40%** |
| ↑ に加えて `glass-nested-glass` = off | 35〜37% |

**68% → 39%。約 43% 削減。**
CPU 側 `average` も dock+3 で 6.5ms → 3.4ms。

`_cogl_framebuffer_add_dependency` のアサーションは出ていない。
ドラッグ・動画再生での遅延も報告なし（0 フレーム遅延の設計どおり）。

### `glass-nested-glass` 設定の価値は下がった

A1 が高価な部分（ブラーチェーン）を先に取り除いてしまったので、
この設定を off にして追加で得られるのは **2.5 ポイント程度**（39% → 36.5%）しかない。
残っているのは composite だけで、それは B1 の早期リターンで既に安い。

見た目の代償（入れ子のウィンドウがガラスを失う）に対して見合うかは微妙。
残してあるが、削除する判断もあり得る。

### 実装中に見つけて直したバグ: オフフレームのステージ paint

`glass-nested-glass` を off にしてメニューを開くと、
**約 0.4 秒ごとに全ガラスのブラーが一瞬消える**症状が報告された。

原因は `clutter_stage_paint_to_framebuffer()`。
`Shell.Screenshot` と `paint_to_content()` が使うこの関数は
**ステージ全体を（したがって全ガラスエフェクトを）描くが、
`'after-paint'` を発火しない**（mutter 50.1 のソースで確認）。

```c
paint_context = clutter_paint_context_new_for_framebuffer (framebuffer, ...);
...
clutter_actor_paint (CLUTTER_ACTOR (stage), paint_context);
```

そのためこの paint は**周囲のフレームと同じシリアル**を持つ。
それが画面 paint より先に来ると「そのフレームの初回 paint」の枠を奪い、
本物の画面 paint が「繰り返し」と誤判定される。
nested-glass off ではその繰り返しが `super.vfunc_paint_target()` に落ちるので
**画面からガラスが消える**。周期 0.4 秒は
`menu-sample-interval-ms` の既定値そのもの（適応テキスト色のサンプラー）。

**修正**: 判定キーをシリアル単独から
**(シリアル, ペイントコンテキストのフレームバッファ)** の組に変えた。

- `ClutterOffscreenEffect` の `paint_node` は構築中にフレームバッファを push しない
  （ソース確認済み。LayerNode を足すだけ）ので、
  **入れ子のクローン paint は本物と同じ fb を見る** → 引き続き「繰り返し」と判定される
- オフフレームのステージ paint は自前の fb を持つ → 別物として扱われ、
  枠を奪わないしフルチェーンを走らせる（スクリーンショットにも正しいガラスが写る）

`Cogl.Framebuffer` は GObject なので GJS のラッパー同一性比較が使える。

### 重大な取りこぼし: フレームバッファキーが A1 を完全に無効化していた

B2 の検証で `blurSkips` が**全インスタンスで 0** になっているのを発見。
A1 の再利用が一切効いていなかった。

原因は、その前の「オフフレーム paint」対策で導入した
**(シリアル, ペイントコンテキストのフレームバッファ)** の複合キー。
前提が誤っていた。

`ClutterActorNode` の draw ハンドラ
（`clutter/clutter/clutter-paint-nodes.c`）:

```c
clutter_actor_node_draw (...) {
  clutter_actor_continue_paint (actor_node->actor, paint_context);
}
```

**子アクターの描画は draw、つまり実行フェーズで行われる。**
その時点では外側の `LayerNode` が既に自分のオフスクリーンを
ペイントコンテキストに push しているので、
**入れ子の paint は外側のオフスクリーンを見る** —— 画面のフレームバッファではない。
「入れ子は本物と同じ fb を見るはず」という前提が逆だった。

結果、すべての入れ子 paint が「別フレーム」と判定され、フルチェーンが走っていた。

**修正**: シリアル単独のキーに戻した（そちらは実測で正しく動いていた）。

### 同時に判明した、より強い順序保証

上記の調査で、A1 の正しさの根拠が当初考えていたものより強いことが分かった。

当初の根拠は「クローンはソースより後に描かれる」（z 順の議論）だったが、
実際には**ステージのノードツリーは完全に構築されてから実行される**のであり、
エフェクト自身の `paint_target` は構築フェーズで走る。したがって

**1 回のステージ paint の中では、すべての本物の paint_target が
すべての入れ子の paint_target より先に実行される。**

プールが再利用より先に書かれることは、z 順に依存せず保証される。

### `glass-nested-glass` 設定は削除した

この設定だけが「繰り返し paint」と「入れ子 paint」を厳密に区別する必要を生んでいた。
しかしその区別に必要な情報が introspection から取れない。

- `clutter_paint_context_get_stage_view()` … `(skip)` で非公開
- `clutter_paint_context_is_drawing_off_stage()` … 同じく `(skip)`
  （まさにこの判定をする関数）
- フレームバッファでは、入れ子とオフフレームのステージ paint を区別できない
  （どちらも画面 fb とは異なる）

加えて実測での価値が **GPU 2.5 ポイント**しかなく（39% → 36.5%）、
バグ（メニューを開くと全ガラスのブラーが 0.4 秒周期で消える）の唯一の原因でもあった。

設定・スキーマキー・prefs の行・コード経路をすべて削除。
これによりオフフレームのステージ paint は完全に無害になる——
再利用は内容として正しく、「ガラスなしで描く」経路がもう存在しないため。

### 実機で確認すべきリスク（memo.md 5.3）

Cogl は FB 間の依存グラフを実際に構築する。
「dock のキャプチャ用 LayerNode の内側にある composite が、
その外側で書かれたプール FBO を読む」形が閉路判定に触れないか。
触れた場合はログに

```
_cogl_framebuffer_add_dependency: assertion '!find_cycle (...)' failed
```

が出て、**背景が抜けてティント一色になる**。出たら即撤退。

## フェーズ 8 — FBO を実サイズに（最後）

| # | 項目 | 対象 |
|---|---|---|
| 21 | **A3** | `dockManager`, `uiManager`, `notificationManager`, `osdManager`, `quickSettingsManager` |

`liquidBox` をモニタ全面ではなく「ガラス矩形 + CLIP_PADDING」のサイズにし、
クローンコンテナのオフセットをその矩形の原点基準に切り替える。

```
現行: liquidBox = (monitor.x, monitor.y, monitor.width, monitor.height)
      setResolution(screenW, screenH)
      setGlassGeometry(localBgX, localBgY, bgW, bgH)
      _windowCloneManager.setOffset(-monitor.x, -monitor.y)
      _uiSampler.sync(monitor.x, monitor.y, screenW, screenH)

新案: fboX = bgX - CLIP_PADDING,  fboY = bgY - CLIP_PADDING
      fboW = bgW + CLIP_PADDING*2, fboH = bgH + CLIP_PADDING*2
      liquidBox = (fboX, fboY, fboW, fboH)
      setResolution(fboW, fboH)
      setGlassGeometry(CLIP_PADDING, CLIP_PADDING, bgW, bgH)
      _windowCloneManager.setOffset(-fboX, -fboY)
      _uiSampler.sync(fboX, fboY, fboW, fboH)
```

「フルスクリーン FBO モード」が導入された理由（BMS のブラーオフセットとキャッシュ汚染）は
座標系が絶対スクリーン座標であることが要件だった。上記は原点をずらすだけなので要件は保たれる。

### やってはいけないこと

`liquidBox.set_clip()` による近道。その場合 `srcW`（縮んだキャプチャ）と
`allocW`（= `get_size()` = フルスクリーン）が食い違い、
`computeCaptureLayout()` の

```ts
if (!(padLeft >= 0) || !(padTop >= 0) ||
    padLeft + contentW > srcW || padTop + contentH > srcH) return centredFallback();
```

に引っかかって中央寄せフォールバックへ落ち、memo.md 追記1 で直した -3px オフセットが
（今度は数百 px 規模で）再発する。
アクターのサイズ自体を変える形なら `allocW == 意図したサイズ` が保たれ、この関数は正しく動く。

**検証**: BMS 併用時のオフセット、マルチモニタ、dock の位置変更（上下左右）、
`dump()` の `src` が縮むこと。
**期待効果**: dock で 3.6x、OSD で 20〜50x のピクセル削減。

---

## 追加する設定キー（3 本のみ）

曖昧なプリセット（高品質/バランス/パフォーマンス）は採用しない。
「バランスを選んだつもりで入れ子描画が切れていた」という事故を避けるため、
個別キーのみとする。

| キー | 型 | 既定 | フェーズ | 内容 |
|---|---|---|---|---|
| `glass-debug-diagnostics` | b | false | 1 | paint ごとの診断コードの有効化（開発用、品質とは無関係） |
| `glass-blur-downscale` | i (2 or 4) | 2 | 6 | blur を 1/4 解像度で行う。**明確な品質低下あり** |
| `glass-nested-glass` | b | true | 7 | false でガラスの入れ子描画を無効化。**明確な見た目の変化あり** |

承認済みの他の項目は品質低下を伴わないため、設定化しない。
`glass-sigma-cutoff`（4σ→3σ）は視覚差が事実上検知不能なので定数変更とする。
`glass-max-behind-windows`（背後ウィンドウ数の上限）は却下。

---

## 却下 / 撤回した案

| 案 | 理由 |
|---|---|
| `baseWindowsContainer` を `surfaceActor` のクローンにする | base 側も「他の背後ウィンドウのガラス」は映っているべき。前提が誤っていた |
| `glass-max-behind-windows` | 却下 |
| 高品質/バランス/パフォーマンスのプリセット | 曖昧な束ね方で意図しない機能が切れる事故を招く |
| メニュー背景サンプリングの間隔を延ばす | 方針として採らない。代わりに 1 サンプルのコストを下げる（C4） |
| `liquidBox.set_clip()` で FBO を縮める近道 | -3px オフセットバグが数百 px 規模で再発する |
| 入れ子時に `super.vfunc_paint_target()` へ落とす | ガラスの見た目が失われる |

---

## ★ 方針転換: composite シェーダーはボトルネックではない（2026-09-08 実測）

### 決定的な実験

`global._lgGlass.earlyExit(false/true)` を同一セッション・同一構成
（dock + 3 windows）で切り替え、GPU 使用率を比較した。

| 状態 | 区間 | GPU 使用率 |
|---|---|---|
| earlyExit = **true**（早期リターン有効） | 17:03:41〜17:03:55 | 平均 **68.3%** |
| earlyExit = **false**（全画素でフル計算） | 17:04:20〜17:04:45 | 平均 **68.7%** |

**差はない。**

`false` のときは全画素が 12 テクスチャフェッチ + `pow` 8 個 + `refract` +
リム/スペキュラ/シーン/影の全計算を通る。`true` のときは 7〜8 割の画素が
数命令で抜ける。**それで GPU 使用率が動かない** ということは、
composite フラグメントシェーダーの中身は全体コストのごく一部でしかない。

フェーズ 1 の crop 5→1 フェッチ、色収差 12→4 フェッチが
GPU 使用率に表れなかったことも、同じ結論を裏付けている。

### では何が支配的か — paint 増幅の精密実測

`glass-debug-diagnostics` を有効にして heartbeat を 2 秒間隔で 5 点取り、
差分から求めた正確な値（dock + 3 windows）:

| インスタンス | paints/秒 | **paints/フレーム** |
|---|---|---|
| dock | 59.0 | **0.98** |
| 最上位 window (660x596) | 118.0 | **1.97** |
| 中間 window (390x636) | 354.0 | **5.90** |
| 最下位 window (861x685) | 826.6 | **13.78** |
| **合計** | | **22.63** |

1 → 2 → 6 → 14。**スタックを 1 段下がるごとに倍以上**になる、
入れ子クローンによる乗算的増幅。

1 チェーンあたり capture / crop / gauss pre / H / V / composite の
約 6 パスなので、**1 フレームあたり約 135 レンダーパス**。
うち dock と全画面 FBO 系はフルスクリーン (1920x1080)。

各パスは `ClutterLayerNode.pre_draw()` が `clear4f` するため
（memo.md 追記1 参照）、クリア + 書き込みで最低 2 回のフルスクリーン
書き込み帯域を消費する。**支配的なのはパス数 × 画素数 × paint 回数**であって、
画素あたりの演算量ではない。

### 優先順位の再設定

この結果を受けて、残りのフェーズを次のように組み替える。

### 確定した実施順（ユーザー決定, 2026-09-08）

| 順 | 項目 | 種別 | 状態 |
|---|---|---|---|
| 1 | 影非表示問題 | バグ修正 | **解決済み**（原因は `fast_mode` シード。B3 で修正） |
| 2 | B3 解析勾配 / fast_mode 廃止 | 品質・簡素化 | **実装済み・未検証** |
| 3 | C4 contrastSampler の PNG/ディスク往復全廃 | 性能（CPU） | **実装済み・自己テスト付きで再実装** |
| 4 | A1 入れ子の blur スキップ | 性能（最大） | 未着手 |
| 5 | B2 crop パス削除 | 性能 | 未着手 |
| 6 | A3 FBO 実サイズ化 | 性能 | 未着手 |
| 7 | `glass-blur-downscale` | 性能（品質トレードオフ） | 未着手 |

**B3 は性能施策ではなく品質・簡素化施策として実施した。**
GPU 使用率が下がることは期待しないこと。

---

## 影に関する調査（2026-09-08）

報告: 「影が全く現れない（dock / menu）。application では radius に対して
とても小さい範囲にだけ影が出て、〈ウィンドウの端〉〈薄い・ない影〉〈正常な影〉
という見え方になる」

### 結論: B1 の早期リターンは影を消していない

実設定（`shadow-radius=46.97`, `shadow-intensity=0.2576`,
`glass-edge-smoothing=1.18`）で `glass.frag` の影の数式をそのまま数値計算した
（`shadow_check.py`）。**B1 が抜ける位置では、元のコードでも影の寄与が既に厳密に 0**。

| d (px) | glass alpha | shadowAlpha | 寄与 | |
|---|---|---|---|---|
| \*\*dock 系\*\* (`shadow_max_radius = CLIP_PADDING - 20 = 180`) | | | | |
| 1 | 0.017 | 0.331 | **0.326** | |
| 5 | 0 | 0.291 | **0.291** | |
| 20 | 0 | 0.090 | 0.090 | |
| 40 | 0 | 0.004 | 0.004 | |
| 47 | 0 | 0.000 | 0.000 | |
| 180 | 0 | 0.000 | 0.000 | ← B1 はここから |
| \*\*application\*\* (`setShadowMaxRadius(SHADER_PADDING)` = 10) | | | | |
| 1 | 0.017 | 0.290 | **0.285** | |
| 5 | 0 | 0.071 | 0.071 | |
| 8 | 0 | 0.008 | 0.008 | |
| 10 | 0 | 0.000 | 0.000 | ← B1 はここから |

B1 の閾値は `max(shadow_max_radius, 5.0)` で、これは元のコードが
`shadowAlpha *= 1.0 - step(maxRadius, d)` で影をゼロにしていた位置と**同一**。
定義上、削れる影は存在しない。

### 判明した実際の原因（application）

`applicationManager.ts` が `effect.setShadowMaxRadius(SHADER_PADDING)` を渡している。
`SHADER_PADDING` は 10 で、これは屈折・ブラー用の光学マージンであって
影の描画余白ではない。結果、**スライダーが 47px でも影は 10px で頭打ち**になる。
`setShadowMaxRadius()` の doc コメント自身が
「dockManager の CLIP_PADDING（安全マージンを引いた値）と同期させること」と
書いており、まさにその警告どおりの取り違え。報告の
「radius と比べてとても小さい範囲」はこれで完全に説明できる。

ただし **単に値を上げても直らない**。application のグラスアクターは
`visW + 2*SHADER_PADDING` しかなく、物理的に 10px 分の余白しか存在しない。
まともな影を出すには余白そのものを広げる必要があり、
`SHADER_PADDING` を変えると `_frameLocalOffset` / constraint オフセット /
`computeCaptureLayout` の全部に波及する。**別タスクとして扱うべき。**

### dock / menu で影が見えない件

上表のとおり dock 系は d=1〜20px で寄与 0.33〜0.09 あり、
色 (0.03,0.04,0.08) なら十分見えるはずの値。B1 では説明できない。
**B1 より前から出ていなかった可能性が高いが、確定していない。**

### 切り分け用に追加した A/B トグル

`early_exit_enabled` uniform（既定 1.0、`_init()` で明示的にシード）を追加し、
Looking Glass から切り替えられるようにした。

```js
global._lgGlass.earlyExit(false)   // 早期リターンを無効化（B1 導入前の挙動）
global._lgGlass.earlyExit(true)    // 戻す
```

**同一セッション内で影の有無を A/B できる。** これで消えるなら B1 のバグ、
変わらないなら B1 より前からの問題と確定する。

### A/B の結果（2026-09-08）

`earlyExit(false)` / `earlyExit(true)` のどちらでも
**dock / menu の影は現れなかった**。

→ **B1 は無罪。dock / menu の影が出ないのは B1 以前からの問題**と確定。
数値計算（上表）では出るはずの値なので、
uniform が届いていないか、シェーダー以外の要因（重なり順など）が疑わしい。

次の切り分けのため、`dump()` に影関連の uniform を出すようにした
（`u.shadowRadius` / `u.shadowIntensity` / `u.shadowMaxRadius` /
`u.edgeSmoothing` / `u.cornerRadius` / `u.padding` / `u.isDock` /
`u.multiRegion` / `u.earlyExit` / `u.dockRect`）。
これらは `_pendingUniforms` の実値、すなわち最後にパイプラインへ渡した値そのもの。

- 値がおかしければ JS 側の問題
- 値が正しいのに影が出ないなら、シェーダー内部か、上に描かれている何かの問題

---

## 解決: 影が表示されない問題 — 原因は `fast_mode` の初期化ミス（既存バグ）

### 原因

`liquidEffect.ts` の `_init()`:

```ts
this._setFloat('fast_mode', LiquidEffect.DRAG_PERF_MODE_ENABLED ? 1.0 : 0.0);
static DRAG_PERF_MODE_ENABLED = true;   // → 常に 1.0 でシードされる
```

`glass.frag`:

```glsl
if (fast_mode > 0.5) {
    shadowAlpha = 0.0;
}
```

**マスター有効フラグ（`DRAG_PERF_MODE_ENABLED`）と、
「このウィンドウを今ドラッグ中か」という毎フレームのフラグを取り違えている。**
その結果、全インスタンスが `fast_mode = 1.0` で開始する。

`setFastMode()` を呼ぶのは `applicationManager` だけ
（`setFastMode(isDraggingThisWindow)` を毎フレーム）。したがって:

| 対象 | fast_mode | 影 |
|---|---|---|
| dock / menu / notification / OSD / quick-settings | **1.0 のまま永久に** | **常に消える** |
| application windows | ドラッグ中以外は 0.0 | 出る（ただし 10px で頭打ち、下記） |

同じ理由で、これらのサーフェスは常に `heightGradientFast()`（片側差分の近似）
を使っていた。

### 修正

B3 で `fast_mode` を一式削除したことで直った。ユーザー確認済み:
「影はなぜか正常に表示されるようになりました(dock/menu/その他)」。

### 切り分けの経緯（記録）

1. B1 早期リターンを疑った → **数値計算で無罪を証明**
   （早期リターンの開始位置では元コードでも影の寄与が厳密に 0）
2. `earlyExit(false/true)` の A/B → **影は変わらず**。B1 は無関係と確定
3. `dump()` に影関連 uniform を追加 → **全て正常値**。JS 側の入力は健全と確定
4. → 残るはシェーダー内部。`fast_mode` によるゼロ潰しが該当した

**教訓**: uniform を「マスター有効フラグ」でシードしてはいけない。
シード値は「その機能が働いていない状態」でなければならない。
`early_exit_enabled` を明示的に 1.0 でシードしたのは同じ理由の裏返し
（あちらは未設定 = 0 が「無効」になるので明示が必要だった）。

### 残る別バグ: application の影が 10px で頭打ち

`applicationManager.ts` が `effect.setShadowMaxRadius(SHADER_PADDING)` を渡している。
`SHADER_PADDING` は 10 で、屈折・ブラー用の光学マージンであって影の余白ではない。
スライダーが 100px でも影は 10px までしか出ない。
グラスアクター自体が `visW + 2*SHADER_PADDING` しかないので、
値を上げるだけでは直らず、余白の拡張が必要（`_frameLocalOffset` /
constraint オフセット / `computeCaptureLayout` に波及）。**別タスク。**

---

## 実施済み: B3 解析勾配 + fast_mode 廃止（2026-09-08）

### 何をしたか

`sdRoundRectDir(p, b, r)` を新設。丸角矩形 SDF の勾配（＝「形状の外向き」方向）を
閉形式で返す。距離関数自身と同じ構成:
交差領域（q の両成分が負）では最近傍が直線辺なので勾配はその軸、
角領域では距離が `length(max(q,0))` なのでその正規化ベクトル。

`heightGradient()` はこれを使う形に置き換えた。高さは符号付き距離のみの関数
（`getHeight(p) = profileHeight(t(d)) * fade(d)`）なので連鎖律で

```
grad(H) = H'(d) * grad(d)
```

`grad(d)` は上記の閉形式。残るスカラー `H'(d)` を、
**その方向に沿った中心差分 1 本**で求める（軸ごとに 2 本ではなく）。

- `getHeight()` 4 回 → 2 回、`pow()` 8 個 → 4 個、`sdRoundRect()` 5 回 → 3 回
- `heightGradientFast()`、`fast_mode` uniform、`setFastMode()`、
  `applicationManager` の呼び出し、影の `fast_mode` バイパスをすべて削除
- 併せて `isDraggingThisWindow`（`global.display.is_grabbed()` を
  ウィンドウ毎・フレーム毎に呼んでいた）も不要になったので削除

### なぜ閉形式で `H'(d)` まで求めないのか

求まりはする。しかし超楕円プロファイルは `t = 0`（ガラスの縁ちょうど）で
**傾きが無限大**になる（`profileHeight` の `inner^(1/n)` の微分が n > 1 で発散）。
有限差分はこれを `gradientStep()` に紐づいた大きさで打ち切っており、
その平滑化が現在の見た目を成立させている。閉形式にすると縁で法線が
水平に振り切れて屈折が最大になり、見た目が変わる。

### 旧実装との差（数値検証）

勾配が非自明な帯（縁から `corner_radius + smoothZone` 以内）で
パラメータをランダムに振り 14,641 点を比較。

| 指標 | 中央値 | p95 | 最大 |
|---|---|---|---|
| 方向の差 | 0.000° | 0.077° | 38.6° |
| 大きさの相対差 | 0.0000 | 0.0015 | 1.0000 |

**99.3% の点で大きさの差は 10% 未満。** 乖離する 0.7% は角の丸み部分で、
そこは旧実装（軸ごとの差分）がステップ間の曲率を拾って
`grad(d)` と平行でないベクトルを返していた箇所 ——
**新実装の方が正しい**（法線が傾かない）。

---

## 実施済み: C4 contrastSampler の脱ディスク（2026-09-08, 結論修正）

### 判明したこと: GJS から GPU のピクセル読み出しはできない

当初 `clutter_stage_paint_to_buffer()` で実装したが、**実機で動かなかった**。
渡した `Uint8Array` が書き換えられずに戻ってくる:

```
[Liquid Glass][contrast] stage.paint_to_buffer() left the buffer untouched
  — GJS marshalled it as an input copy; using the screenshot fallback
```

原因は introspection の注釈。mutter 50.1 `clutter/clutter/clutter-stage.c`:

```c
 * @data: (array) (element-type guint8): a pointer to the data
```

**方向指定がない ＝ `in`**。GJS は入力配列を一時コピーとしてマーシャルしてよく、
実際そうしている。ピクセルはそのコピーに書かれて解放される。

代替候補の `cogl_texture_get_data()` も `cogl/cogl/cogl-texture.h` で

```c
 * @data: (array) (nullable): memory location to write the @texture's contents,
```

と、やはり `in`。**このスタックには GJS から到達できる GPU 読み出し経路が存在しない。**

到達不能な分岐をコードに残しても価値がないので削除した
（将来 mutter が `(out caller-allocates)` を付けたら再訪する価値がある、
という注記だけソースに残してある）。

### 実装した内容

```
旧: Shell.Screenshot → PNG → /tmp へ書き込み → 読み直し → デコード → unlink
新: Shell.Screenshot → PNG → Gio.MemoryOutputStream → steal_as_bytes()
    → Gio.MemoryInputStream → GdkPixbuf.new_from_stream()
```

**ディスク往復（書き込み・読み出し・unlink）が完全に消えた。**
PNG コーデックは残る（読み出し経路がない以上避けられない）。
サンプル間隔 200ms は方針どおり変更していない。

`Shell.Screenshot` インスタンスは初回サンプル時に遅延生成するようにした
（全マネージャがサンプラーを先に作るが、メニュー等を一度も開かない
セッションでは不要なため）。

失敗時は `[Liquid Glass][contrast]` で 1 回だけ理由を出す。
以前は静かに null を返しており、
「エラーは出ないが適応テキスト色が変わらない」という切り分け不能な状態になっていた。

### 教訓

**GIR の配列引数は方向注釈を必ず確認すること。**
`(array)` だけなら `in` で、出力バッファとしては使えない。
memo.md 6.1 は同じ問題の別の顔（配列がスカラーと誤注釈されていて SIGSEGV）。
今回は静かに失敗する側で、**そのぶん見つけにくかった**
（例外もエラーも出ず、値だけが返ってこない）。

---

## 実施済み: application ウィンドウの余白拡張（2026-09-08）

### 直した問題

`applicationManager.ts` の `SHADER_PADDING = 10` が 2 つの役割を兼ねていた:

1. 屈折・ブラーが窓の縁の外側を参照するためのサンプリング余白
2. **ドロップシャドウが外向きに描ける唯一の空間**

そして `effect.setShadowMaxRadius(SHADER_PADDING)` にその 10 をそのまま渡していた。
結果、`shadow-radius` を 100 にしても影は 10px 幅で頭打ち。
`setShadowMaxRadius()` の doc コメント自身が
「dockManager が `CLIP_PADDING - 20` を渡すように、アクターの実際の外向き余白を渡せ」
と警告していた箇所そのもの。

### なぜ固定値を大きくしなかったか

アクターは (ウィンドウ + 2*余白) で、そのサイズが
**キャプチャ・crop・blur プール・composite の全部に流れる**。
固定で 120 にすると 861x685 のウィンドウで 1101x925 ＝ **画素数 1.64 倍**が常時かかる。
今やっている性能改善と正面から衝突する。

### 実装

余白を影の設定から導出する。

```ts
const GLASS_MIN_MARGIN = 10;            // 従来値。屈折・ブラー用の光学余白
const SHADOW_MARGIN_HEADROOM = 20;      // dockManager の CLIP_PADDING - 20 と同じ余裕
const GLASS_MAX_MARGIN = 100 + 20;      // prefs の shadow-radius 上限 100 + 余裕

_computeGlassMargin() {
  if (!(radius > 0) || !(intensity > 0)) return GLASS_MIN_MARGIN;
  return clamp(ceil(radius) + SHADOW_MARGIN_HEADROOM, GLASS_MIN_MARGIN, GLASS_MAX_MARGIN);
}
```

- 影を使わない（radius 0 または intensity 0）ウィンドウは **従来どおり 10px**。
  余計なコストは一切増えない
- 影を使う場合だけ、その半径ぶんの余白を確保する。
  **ユーザーが払うコストと得るものが一致する**
- `setShadowMaxRadius(margin - HEADROOM)` にしたので、
  スライダーの値がそのまま使えるようになった

`shadow-radius` / `shadow-intensity` の変更を `applicationManager` でも購読し、
変わったら全ウィンドウの `setPadding` / `setShadowMaxRadius` /
`roundingEffect.setInset` を更新し、**`state.geomSig` を破棄**する。
C3 の高速パスが署名する入力（frame rect / scale / translation …）は
余白が変わっても全て同じままなので、破棄しないと古いアクターサイズのまま固定される。

`InverseCornerEffect` は `windowHalf = resolution*0.5 - inset` で窓の実エッジを求めるので、
inset に余白を渡せば余白が変わっても正しく追従する（確認済み）。

### 続き: 余白を広げても影が出なかった — `InverseCornerEffect` が上から塗り潰していた

余白拡張だけでは影は出なかった。`debugView(1)` のスクリーンショットが決定的で、

- dock: 緑（本体）＋ 赤（影）＋ その外 200px の黒 …… 正常
- application: ウィンドウ端の数 px だけ赤。その外は**壁紙が見えている**（＝ガラスの合成結果が
  出ていない）。アクター最外周の約 10px だけ黒く、内側に向かって薄くなる

`utils.ts` の `InverseCornerEffect` のシェーダー:

```glsl
float d = sdRoundRect(p, windowHalf, radius);
float alpha = smoothstep(-0.5, 0.5, d);          // 角丸矩形の「外側」全部が 1
vec2 edgeDist = min(st, 1.0 - st) * resolution;
float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));  // 最外周 10px だけフェード
alpha *= edgeFade;
cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
```

SDF は箱の外側では常に正なので、**`alpha` は余白リング全域で 1**。
このオーバーレイは `Clone(baseActor)`（ブラーなしの生の背景）で、
ガラスの合成結果の**上**に描かれる。つまり影が描かれる場所を
生の背景で塗り潰していた。最外周 10px だけ `edgeFade` で抜けるので、
そこだけガラス側（debugView では黒）が見えていた ——
観察された見え方と完全に一致する。

余白が固定 10px だった頃も同じことが起きていたが、
影自体も 10px で頭打ちだったため「ほとんど何も覆っていない」状態で目立たなかった。
余白を広げて本来の影を出せるようにした途端、オーバーレイも一緒に広がって全部消した。

### 修正

オーバーレイの本来の仕事は**4 つの角のノッチだけ**だった
（ガラスの角丸半径はウィンドウ自身のそれと一致するとは限らないので、
ガラスが角からはみ出したぶんを生の背景で描き直す）。
ウィンドウの**矩形バウンズの内側**という条件を追加する。

```glsl
float dSquare = sdRoundRect(p, windowHalf, 0.0);
alpha *= 1.0 - smoothstep(-0.5, 0.5, dSquare);
```

数値検証（ウィンドウ 640x570 / 余白 77 / カット半径 26.2）:

| 位置 | 旧 alpha | 新 alpha |
|---|---|---|
| 余白リング中央（影が出る場所） | 1.000 | **0.000** |
| ウィンドウ端の 1px 外 | 1.000 | **0.000** |
| ウィンドウ端の 40px 外 | 1.000 | **0.000** |
| **角のノッチ** | 1.000 | **1.000** |
| ウィンドウ内部 | 0.000 | 0.000 |

**余白リングの 100% がオーバーレイから解放され、角のノッチだけが従来どおり残る。**

`edgeFade` は残した。ノッチは必ずアクター端から `inset` px 以上内側にあるので
通常は常に 1 だが、`inset` がフェード距離より小さい退化ケースを守る。

### さらに続き: 角丸部分の影が欠ける — オーバーレイの範囲を 3 条件に

矩形バウンズで囲う修正では**直線部の影は出たが角丸部分が欠けた**。
影は角丸のアーチに沿って回り込むので、その領域（丸いアーチと四角い角の間のノッチ）
こそが影の出る場所であり、そこをまだオーバーレイが覆っていた。
`debugView(1)` でもその領域は黒も赤も出ていない（＝オーバーレイの生背景が上に乗っている）。

オーバーレイの painted 領域を 3 条件の積にした。

```glsl
float dCut   = sdRoundRect(p, windowHalf, radius);                  // glass 半径 + CORNER_PADDING
float dGlass = sdRoundRect(p, windowHalf, max(glass_radius, 0.0));  // glass 自身の半径（新 uniform）

float alpha = smoothstep(-0.5, 0.5, dCut);              // 1. カット弧の外側
alpha *= 1.0 - smoothstep(-0.5, 0.5, dGlass - 1.5);     // 2. ガラス形状の内側（+1.5px の余裕）
alpha *= smoothstep(0.15, 0.6, dCut - dGlass);          // 3. 2 つの弧が実際に食い違う場所だけ
```

条件 3 が肝。半径の大きい角丸矩形は小さい方の**部分集合**で、
**直線部では両者が完全に一致する**ので `dCut - dGlass` は直線部で 0、
角に向かって最大 `0.41 * CORNER_PADDING` まで増える。
つまり「角だけ」を数式で表現できる。

対角線に沿った alpha の走査（`t` = ガラスのアーチからの距離 px）:

| t | 旧 | 新 | |
|---|---|---|---|
| -2.0 | 0.000 | 0.000 | ガラス内部、カット弧の内側 |
| -1.5 | 0.148 | **0.148** | ← |
| -1.0 | 0.835 | **0.835** | ← 従来と同一 |
| -0.5 〜 +1.0 | 1.000 | **1.000** | ← **オーバーリビール帯は完全保持** |
| +1.5 | 1.000 | 0.500 | |
| +2.0 以上 | 1.000 | **0.000** | **影が解放された** |

直線部（top edge）:

| 外向き距離 | 旧 | 新 |
|---|---|---|
| 0 | 0.500 | **0.000** |
| 1〜50px | 1.000 | **0.000** |

**ガラスのアンチエイリアス境界を覆う帯（-1.5〜+1.0px）は旧実装と数値まで同一**、
そこから 2px 外は全て解放、直線部は完全に不干渉。
`corner-radius` 0 / 22.2 / 60 のいずれでも同じプロファイルを確認した。

`InverseCornerEffect` に `glass_radius` uniform と `setGlassRadius()` を追加し、
`applicationManager` の 3 箇所（初期化・設定変更・開閉アニメーションのスケール追従）
から渡すようにした。

### 決着: コーナーリビールは無効化した（幾何学的に両立しない）

角丸部分にも影は回り込むようになったが、**常時 3px 程度の「影なし・ウィンドウがあっても
背景が透ける」帯**が角に出た。角丸半径をウィンドウと完全に一致させても出る
＝ 補正すべきものが何もない場合でも出る。

#### なぜ調整で解決できないか

オーバーリビール帯は「カット弧の外」かつ「ガラス形状の内側寄り」に置く必要がある。
ところが角の対角線上で 2 つの弧の差は最大 `0.41 * CORNER_PADDING` しかない。

| CORNER_PADDING | 角での最大差 | 帯が始まれる位置 |
|---|---|---|
| 1 | 0.41px | dGlass > +0.09px |
| 3 | 1.24px | dGlass > -0.74px |
| 6 | 2.49px | dGlass > -1.99px |

ガラスのアンチエイリアス境界（約 ±1px）を覆うだけの幅を持たせると、
**帯は必ずその境界をまたぐ**。境界の内側はウィンドウ、外側は影。
`CORNER_PADDING` を上げても帯は**両側に**広がるだけで、分離できない。

つまりこのオーバーレイは「ウィンドウに穴を開ける」か
「影を消す」かのどちらかしかできない。

#### 対応

`CORNER_REVEAL_ENABLED = false` を導入し、
`cornerOverlay` を非表示・非レイアウトにした。
アクターとエフェクトはツリーに残してあるので、
将来より良い角処理を設計したらフラグ 1 つで戻せる。

**失うもの**: `application-corner-radius` をウィンドウ自身の角丸半径より
**小さく**設定した場合、ウィンドウの角丸からガラスがはみ出して見える。
これは設定ミス時の見た目の問題であり、実害はない。

**同時に得たもの**: `cornerOverlayClone` は `Clone(baseActor)`、すなわち
**壁紙クローン＋背後ウィンドウの全クローンをもう 1 回描いていた**。
それがウィンドウ 1 枚につき毎フレーム消える。A1 と同じ方向の削減。

---

## 実施済み: `baseActor`（非ブラーのベース層）の描画停止（2026-09-08）

`baseActor` の存在理由は WindowState のコメントによれば
「Unblurred base background, used to reveal the true corners
（see InverseCornerEffect below）」——
つまり **`cornerOverlayClone` のソースになること**。
そのオーバーレイを止めた今、`baseActor` を描く必要があるのかを確認する価値がある。

- `bgActor` の合成結果は領域内で alpha = 1 なので、ウィンドウ内側では `baseActor` は完全に隠れている
- 余白リングでは `baseActor` の内容（壁紙クローン＋背後ウィンドウクローン）が見えており、
  その上に影が乗る
- `baseActor` を隠せば、影は**実際のデスクトップ**の上に直接合成される。
  こちらの方が**正しい**（クローンとのズレが原理的に起こらない）

得られるもの: ウィンドウ 1 枚につき毎フレーム、
壁紙クローン＋背後ウィンドウクローンの描画がもう 1 回消える。
さらに `baseClones` の毎フレーム同期も不要になる。

### 実装

`BASE_LAYER_ENABLED = false` を導入し、

- `baseActor` を非表示（`_setupWindow` で 1 回、以後 `_syncStateInner` でも false）
- `baseWindowsContainer` 向けの**背後ウィンドウクローンを生成しない**
  （`_rebuildWindowClones`）
- そのクローンの毎フレーム同期をスキップ（`_syncClones`）
- `_applyCounterScale` / `set_size` / `constraints.base*` の
  毎フレーム更新もスキップ

アクター自体はツリーに残す。`_setupWindow` が `baseActor` を
`surfaceActor` の下に挿入する構造に他のコードが依存している
（`get_first_child()` が `baseActor` を返すようになるため
`surfaceActor` をキャッシュしている、等）ので、そこは触らない。

### 既知バグとの関係（重要な区別）

「フォーカス切替直後に外周が壁紙だけになる」既知の症状は
**余白リングの話** ＝ `baseActor` の領域。
リングからクローンが消えたので、**追いつくべきクローンがそもそも存在しなくなり
この症状は原理的に起こらない**。

ただし同じ報告のもう半分、
**「背後ウィンドウがガラスの内側に出てこない」方は直らない**。
ガラスはクローンをサンプリングしないとブラー・屈折ができないので、
内側は引き続きクローン依存のまま。

### 削減量

ウィンドウ 1 枚につき毎フレーム:

- 壁紙クローン（モニタ全面）1 枚の描画
- 背後ウィンドウクローン (n-1) 枚の描画
- 同 (n-1) 枚の生成・破棄・毎フレーム同期
- コーナーオーバーレイ経由でさらにもう 1 セット（先に無効化済み）

**リスク/要確認**: 余白リングに `baseActor` がクローンしていないもの
（トップパネル等）が入る場合の見え方。ただし z 順では panel が後に描かれるため
上書きされるはず。要実機確認。

`_checkContainerAnchor()` は `windowsContainer`（ブラー側、`bgActor` の中）
しか読まないので、`baseActor` を隠しても誤検知でガラスが消えることはない（確認済み）。

**余白拡張の副作用としての注意**: この `baseActor` のリングは
従来 10px だったものが影を有効にすると 77px 等になる。
クローンと実際の画面がズレるケース（既知: フォーカス切替直後に
背後ウィンドウのクローンが一瞬追いつかない）があると、
**そのズレが 7.7 倍の幅で見える**ことになる。

### 性能上の注意

**影を有効にしているウィンドウは FBO が大きくなる。**
`shadow-radius = 47` なら余白 67 で 861x685 → 995x819（画素数 1.31 倍）。
`shadow-radius = 100` なら余白 120 で 1101x925（1.64 倍）。
影を切れば従来と同じ。この事実は prefs の説明文にも書くべきかもしれない。

---

## BMS 連携: 有効化順序による症状の分岐（2026-09-09, Native セッションで実測）

### ユーザーによる切り分け

両方 OFF の状態から順に有効化する:

| 順序 | 症状 |
|---|---|
| **BMS → Liquid Glass** | ウィンドウのテクスチャ遅延あり / dock のアイコンが二重に見える |
| **Liquid Glass → BMS** | 遅延なし / 二重表示なし / ただし **dock とパネルが重なるときだけ、実パネルのテクスチャが約 10px ずれる**（blur radius とは無関係）。重ならなければずれない。メニュー(uiManager)ではクローン・実物とも重なってもずれない |

BMS 設定: application blur = 無効 / **panel blur = dynamic, 有効** / dash-to-dock blur = 無効。

### これが意味すること

`UILayerSampler` は、uiGroup の子の下に BMS のターゲットが**見つかったかどうか**で
供給方法を変える。そしてその判定は**クローンを最初に作った 1 回だけ**だった。
つまり有効化順序がそのまま経路の違いになる。

| 経路 | いつ選ばれるか | 症状 |
|---|---|---|
| **SNAPSHOT**（`SelfExcludingSnapshotCapture`） | BMS を先に有効化 → 検出成功 | dock ゴースト＋テクスチャ遅延 |
| **CLONE**（素の `Clutter.Clone`） | LG を先に有効化 → 検出失敗 | BMS 側のパネルが 10px ずれる |

**症状が経路と一対一に対応している。** これは非常に強い切り分け。

- SNAPSHOT の害: スナップショットは**ステージ全体をその矩形で切り出す**ので、
  重なっている物も一緒に入る。dock を上に置くとパネル矩形と重なり、
  dock のアイコンが dock 自身のガラスに写る。
- CLONE の害: BMS の `Shell.BlurEffect` は background モードで
  **アクターの下のフレームバッファをサンプリング**する
  （`components/panel.js` の dynamic 分岐は `background.x = panel.x` 等で
  パネルに重ねるだけの実装）。それを我々のオフスクリーンの中でもう一度描くと、
  位置の異なる 2 人目の消費者ができる。memo.md が
  「BMS のターゲットを直接クローンすると BMS がブラーを失う」と
  記録しているのと同じ現象で、今回は 10px のずれとして出た。

### 対応 1（コミット済み）: 判定を作り直す

`f9f21b7` — BMS ターゲットを refresh のたびに解決し、
前回と変わっていたら該当するクローンを破棄して作り直す。
これで**順序依存はなくなる**（どちらの順でも SNAPSHOT に収束する）。

ただし収束先が SNAPSHOT なので、**ゴーストと遅延の側に倒れる**。

### 対応 2: 経路そのものを実行時に選べるようにした

```js
global._lgGlass.bmsMode(0)   // SNAPSHOT（既定）
global._lgGlass.bmsMode(1)   // CLONE
global._lgGlass.bmsMode(2)   // SKIP —— BMS ターゲットをガラスに入れない
```

`SKIP` は 3 つ目の選択肢。ゴーストも遅延も起こさず BMS にも触らない。
代償は「ガラスの向こうにパネルが映らない」だけ。

**次に確定させるべきこと**:
1. `bmsMode(0)` ↔ `bmsMode(1)` を**同一セッションで切り替えて**、
   遅延とゴーストが SNAPSHOT に、10px ずれが CLONE に紐づくことを確認する
2. `bmsMode(2)` で 3 つとも消えるか
3. その上で既定をどれにするか決める

### 3 モードの実測（ユーザー確認済み）

| mode | 結果 |
|---|---|
| 0 SNAPSHOT | 遅延あり・dock ゴーストあり |
| 1 CLONE | 遅延なし・ゴーストなし / **パネルが 10px ずれる** |
| 2 SKIP | 遅延なし・ゴーストなし・ずれなし / **パネルのクローンが消える** |

**推論どおり、症状は経路と一対一で対応していた。**

SKIP は採用しない方針（ユーザー判断）。dock を上端に置くと
dock のガラスは panelBox より**上**に描かれるので、
ガラスに入っていないパネルはその領域で画面から消えることになる。

### 実装した解: `BMS_MODE.REPLICATE`（既定）

望む挙動は「ガラス内に **BMS のぼかしが普通にかかった**パネルがあり、
パネルはズレず、ウィンドウの遅延も出ない」。

成立するのは BMS の構造的な一点による:

```js
// blur-my-shell/components/panel.js
let panel_box = panel.get_parent();
...
panel_box.insert_child_at_index(background_group, 0);
```

**BMS のブラーウィジェットは panel の「兄弟」であって子ではない。**
したがって「BMS のブラーを含まないパネル」はクローンからフィルタするものではなく、
**単に別のアクターをクローンするだけ**で得られる。

REPLICATE が作るもの（この z 順）:

1. `St.Widget` ＋ **我々自身の** `Shell.BlurEffect`（`mode: BACKGROUND`）。
   BMS がブラーウィジェットを置くのと同じ矩形に置き、
   **半径と明度は BMS の生きているエフェクトから毎フレーム読む**
2. `panel_box` の**残りの子**（＝ panel 本体）のクローン

これで:

- BMS のエフェクトは**二度描かれない** → CLONE の 10px ずれが起きない
- スナップショットを撮らない → SNAPSHOT の遅延とゴーストが起きない
- 我々のブラーはオフスクリーン内で「自分の後ろ」＝クローン済みの壁紙・ウィンドウを
  ぼかす。BMS が実フレームバッファに対して持つのとまったく同じ関係なので、
  **近似ではなく再現**になる
- その上に我々のガラスのブラー／屈折が乗る（他のすべてと同じ）

BMS が使うエフェクトクラスは
`effects/native_dynamic_gaussian_blur.js` で確認済み ——
`Shell.BlurEffect` の `mode: BACKGROUND`、`radius = 2 * sigma * scale_factor`、
`brightness`。同じクラス・同じ値を使う。

**構築に失敗した場合は素のクローンに落とさない**（それは BMS を壊す経路）。
その子をガラスから外し、理由をログに出す。

### 検証で見るべき点

- パネルがガラス内に、BMS のぼかしが効いた状態で見えるか
- 実パネルがズレないか
- ウィンドウのテクスチャ遅延が出ないか
- dock を上端に置いてもゴーストが出ないか
- `Shell.BlurEffect` の BACKGROUND モードが**入れ子のオフスクリーン内で機能するか**
  ← ここだけは実機でしか確かめられない。効かない場合、
  ブラーウィジェットは何も描かず、パネルは我々のガラスのブラーだけを背景に見える
  （＝ 破綻はせず、ぼかしの見た目だけが変わる）

---

## 別件で見つかったバグ（パフォーマンスとは無関係）

### 色収差（chroma）がスライダー全域で不可視 — **修正済み**

`glass-chroma-strength` は既定 0.006、UI レンジ 0.0〜0.1。
`glass.frag` では

```glsl
vec2 chromaVec = chromaDir * (chroma_strength / minRes) * edgeDampen;
```

で、`chromaDir` は単位ベクトル、`minRes = min(resolution.x, resolution.y)`。
これをピクセルに直すと **チャンネル分離量 = chroma_strength × (resolution / minRes)** ピクセル。

| 対象 | スライダー最大 (0.1) | 既定 (0.006) |
|---|---|---|
| dock (1920x1080) | 0.18 px | 0.011 px |
| window (861x685) | 0.13 px | 0.008 px |

**最大にしても 0.2 ピクセル未満**。しかもサンプル先はブラー済みテクスチャなので、
知覚できる差は原理的に出ない。

同じ `/ minRes` 正規化を使う `glass-displacement-scale` は既定 78.5 / レンジ 0〜200 で
数十ピクセルの変位を生む。つまり `chroma_strength` のレンジだけが約 2000 倍小さい。
単位の取り違えと考えられる。

**フェーズ 1 の変更が原因ではない。** 分岐の閾値は 0.01 px で、
可視域（おおよそ 0.5 px 以上）よりはるかに手前でしか高速パスに落ちない。
そもそも到達可能な最大値が 0.18 px なので、変更前から見えていない。

**適用した修正**（フェーズ 2 と同時、2026-09-08）:

```glsl
// chroma_strength をピクセル単位にする。resolution はベクトルなので軸ごとに割る
vec2 chromaVec = chromaDir * (chroma_strength / resolution) * edgeDampen;
```

`chromaDir` は単位ベクトルなので、オフセットはちょうど `chroma_strength` ピクセルになる。
あわせて:

- schema 既定値 `0.006` → `1.5`（ピクセル）
- prefs のレンジ `0.0〜0.1 / step 0.001` → `0.0〜5.0 / step 0.1`
- schema の description に単位と再調整が必要な旨を明記

**⚠ 既存ユーザーの dconf 値は自動移行されない。**
実機の値は `0.0077777...` が保存済みだったので、schema 既定値を変えても
そのまま 0.0078px（＝不可視）が使われる。一度リセットが必要:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/schemas \
  reset org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com glass-chroma-strength
```

（旧スケールでは何も見えていなかったので、既存ユーザーにとって
「不可視 → 不可視」であり体感上の退行はない。ただしリリース時は
リセットを促すか、旧値を検出して移行する処理を入れるのが望ましい。）

---

## 診断ツールの改善 — **実装済み**

`dump()` の行は全ポップアップ系ガラスが `"actor":"liquid-box"` になるため、
dock / menu / notification / OSD / quick settings のどれなのか区別できなかった。
実際、ログ解析ではインスタンスの同定に生成時刻との突き合わせが必要だった。

`LiquidEffectParams` に `owner` を追加し、各マネージャから渡すようにした
（`'dock'` / `'menu'` / `'notification'` / `'osd'` / `'quick-settings'` /
`'quick-settings-toggles'` / `'application'`）。
`dump()` の各行の先頭フィールドになり、`(never painted)` の行にも付く。

---

## 調査項目（提案ではない）

- `baseActor` はそれ自身も可視であり、加えて `cornerOverlayClone = Clone(baseActor)` が
  同じサブツリーをもう一度描いている。`bgActor` の composite は領域内で
  `alpha = insideMask = 1.0`（不透明）なので、`baseActor` の可視部分は
  外周パディングのリング以外は完全に隠れる。
  `baseActor` 自身を不可視にできれば 1 回分減るが、
  リングの描画経路（memo.md 3.2(a) で「遅れない正常な経路」として重要な役割を持っていた部分）
  を壊すリスクがあるため、実装前に「baseActor 自身を hide したときにリングが消えないか」を
  単発で確認すること。

---

## 進捗

- [x] フェーズ 1 — 出力が一切変わらないもの（項目 6 は不成立のため除外）— 実装済み・**未検証**
- [x] フェーズ 2 — 描画コストの本丸（B1 のみ。B6 は中止）— 実装済み・**未検証**
- [x] フェーズ 3 — 再描画の駆動を直す — 実装済み・**未検証**
- [x] フェーズ 4 — 法線の作り直し（B3 + fast_mode 廃止）— 実装済み・**未検証**
- [!] フェーズ 5 — crop パス削除（B2）— **差し戻し**（A1 と併用でテクスチャ遅延再発。`USE_CROP_PASS` で A/B 可能）
- [~] フェーズ 6 — 常駐コストの掃除（C4 のみ実装済み・**未検証**）
- [x] フェーズ 7 — 入れ子描画（A1）— 実装済み・**未検証**
- [ ] フェーズ 8 — FBO を実サイズに
