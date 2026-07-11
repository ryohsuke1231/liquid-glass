// utils.ts
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Mtk from 'gi://Mtk';
/**
 * ステージの実際の合成結果（＝本物の画面に出た後のピクセル）から、
 * 指定した矩形だけを毎フレーム GPU 上でブリットして保持するクラス。
 * 対象アクターの paint() を一切呼び出さないため、
 * BMS (MetaBackgroundActor 系) のような「単一所有者」前提のアクターに対しても安全。
 *
 * 【重要】Cogl.Framebuffer.blit() は onscreen (bottom-up origin) → offscreen
 * (top-down origin) の座標系の違いにより、結果が上下反転した状態でコピーされる。
 * ここでは blit の矩形計算はそのままにし、代わりに読み出し側 (TextureBlitActor)
 * で V 座標を反転してサンプリングすることでこれを補正する
 * (setFlipY(true) を呼ぶ側の責務)。
 *
 * 代償: 常に「直前の paint-view で実際に画面に出たもの」を映すため、
 * 理論上 1 フレーム分の遅延が生じる。
 */
// ── 【診断】このプロセス内で一度だけ、Clutter.Stage に実在するシグナルを
//    machine的に確認する。過去のログで 'after-paint' が一度も発火しなかった
//    のが「シグナルが存在しないから」なのか「存在するが条件が違うから」
//    なのかを確定させる。
let _signalExistenceChecked = false;
function _debugCheckStageSignals() {
    if (_signalExistenceChecked)
        return;
    _signalExistenceChecked = true;
    try {
        const gtype = Clutter.Stage.$gtype;
        for (const name of ['paint-view', 'after-paint', 'presented', 'paint']) {
            try {
                const id = GObject.signal_lookup(name, gtype);
                console.log(`[DelayedScreenCapture][DIAG][SIGNAL] Clutter.Stage::${name} signal_lookup id=${id} (0=存在しない)`);
            }
            catch (e) {
                console.log(`[DelayedScreenCapture][DIAG][SIGNAL] ${name} 確認中に例外: ${e}`);
            }
        }
    }
    catch (e) {
        console.log(`[DelayedScreenCapture][DIAG][SIGNAL] シグナル一覧確認自体で例外: ${e}`);
    }
}
let _afterPaintExperimentDone = false;
/**
 * 【方針転換】'presented' は Mutter ソースのシグナル定義コメントに
 * `ClutterStage::presented: (skip)` という GObject-Introspection の
 * (skip) 注釈が付いている。これは「GTypeレベルのシグナルとしては実在するが、
 * GIバインディング(=GJSからのconnect)には意図的に公開しない」という意味。
 *
 * 実機ログはこれと完全に一致した:
 *   - signal_lookup() は id=161 を返す (GType上は実在するので当然ヒットする)
 *   - しかし connect() 後、シグナルが最初に発火したタイミングで
 *     「Can't convert non-null pointer to JS value」という GJS の
 *     マーシャリング失敗が2回発生し、[PRESENTED-EXP] のログは一度も
 *     出力されなかった (=ハンドラ本体に到達する前に、GJSが
 *     ClutterFrameInfo* 引数をJS値に変換できずに例外を投げて
 *     ディスパッチが中断していると考えられる)。
 *
 * → 'presented' はこの構成からは使用不可と判断し、この経路は廃止する。
 *
 * 【代わりに 'after-paint' を試す】ユーザーが提示した最新の公式ドキュメント
 * (Clutter 18) では、'after-paint' のシグネチャが
 * `after-paint(stage, view, frame)` という3引数に更新されており、
 * 「stageがペイントされた後、その結果が画面に表示される前」に発火すると
 * 明記されている。(skip)注釈も見当たらない。
 * 旧調査(§4.1 #11)で「after-paintは存在するが一度も呼ばれなかった」と
 * されていたのは、旧バージョンでの0引数シグネチャを前提にしていたためで
 * あり、現行バージョンの3引数シグネチャで改めて検証する価値がある。
 *
 * 'paint-view' と違い、'after-paint' は個々のview単位ではなく
 * 「stage全体のペイントが完了した後」に発火する設計に見えるため、
 * 引数のviewが正しく対象のパネル領域を含むviewになっているかも
 * 合わせて確認する。
 */
function _debugTryAfterPaintSignalCapture(stage) {
    if (_afterPaintExperimentDone)
        return;
    _afterPaintExperimentDone = true;
    try {
        const handlerId = stage.connect('after-paint', (_stage, view, _frame) => {
            try {
                console.log(`[DelayedScreenCapture][DIAG][AFTER-PAINT-EXP] after-paint 発火 view=${view ? view.toString() : 'null'}`);
                const fb = view?.get_onscreen?.() ?? view?.get_framebuffer?.();
                if (!fb) {
                    console.log('[DelayedScreenCapture][DIAG][AFTER-PAINT-EXP] framebuffer取得失敗');
                    return;
                }
                const ctx = fb.get_context();
                const testW = 200, testH = 200, testX = 500, testY = 500;
                const testTex = Cogl.Texture2D.new_with_format(ctx, testW, testH, Cogl.PixelFormat.RGBA_8888);
                const testFb = Cogl.Offscreen.new_with_texture(testTex);
                fb.blit(testFb, testX, testY, 0, 0, testW, testH);
                const rowStride = testW * 4;
                const data = new Uint8Array(rowStride * testH);
                const returnedSize = testTex.get_data(Cogl.PixelFormat.RGBA_8888, rowStride, data);
                let nonZeroCount = 0;
                for (let i = 0; i < data.length; i++) {
                    if (data[i] !== 0)
                        nonZeroCount++;
                }
                console.log(`[DelayedScreenCapture][DIAG][AFTER-PAINT-EXP] 同期blit(${testX},${testY},${testW}x${testH}) ` +
                    `returnedSize=${returnedSize} nonZeroBytes=${nonZeroCount}/${data.length} ` +
                    `sample(10,10)=(${data[10 * rowStride + 10 * 4]},${data[10 * rowStride + 10 * 4 + 1]},${data[10 * rowStride + 10 * 4 + 2]},${data[10 * rowStride + 10 * 4 + 3]})`);
            }
            catch (e) {
                console.log(`[DelayedScreenCapture][DIAG][AFTER-PAINT-EXP] 例外: ${e}`);
            }
            finally {
                try {
                    stage.disconnect(handlerId);
                }
                catch (_) { /* noop */ }
            }
        });
    }
    catch (e) {
        console.log(`[DelayedScreenCapture][DIAG][AFTER-PAINT-EXP] 'after-paint' 接続で例外: ${e}`);
    }
}
export class DelayedScreenCapture {
    _tex = null;
    _destFb = null; // blit経路用に使い回すFBO
    _rectGetter;
    _afterPaintId = 0;
    _debugRedrawClipLogCount = 0;
    _stage;
    _refCount = 0;
    _loggedOnce = false; // ← 診断ログを毎フレーム出さないためのフラグ
    _loggedCycle = 0;
    constructor(stage, rectGetter) {
        this._stage = stage;
        this._rectGetter = rectGetter;
        _debugCheckStageSignals();
        _debugTryAfterPaintSignalCapture(stage);
        try {
            // 修正: 引数として _stage と view を受け取る
            this._afterPaintId = this._stage.connect_after('paint-view', (_stage, view, redrawClip) => {
                // console.log(`[DelayedScreenCapture][DIAG] paint-view シグナルが発火`);
                try {
                    // ── 【新規診断・damage/redraw_clip仮説】───────────────────
                    // 'after-paint' で"同期"読み取りに変えても依然として完全ゼロ
                    // だったことから、「読み取りタイミング」自体はもはや原因では
                    // ないと判断する。次に疑うべきは、Mutter/Cogl が
                    // ダメージベース(部分)描画をしており、paint-view の第3引数
                    // redraw_clip (Mtk.Region) で示された領域"だけ"が今回実際に
                    // 塗られ、それ以外の領域はこのフレームでは全く描画命令が
                    // 発行されていない可能性があること。
                    // もしテスト対象領域(パネル/画面中央)が redraw_clip の外に
                    // あるなら、そもそも「今読んでいるものが正しいかどうか」以前に
                    // 「今回描かれてすらいない」ことになり、ゼロという結果は
                    // むしろ当然、ということになる。
                    if (this._debugRedrawClipLogCount === undefined)
                        this._debugRedrawClipLogCount = 0;
                    if (this._debugRedrawClipLogCount < 8) {
                        this._debugRedrawClipLogCount++;
                        try {
                            const panelTestRect = { x: 0, y: 0, width: 1920, height: 32 };
                            let containsPanel = 'n/a';
                            let extents = 'n/a';
                            let isEmpty = 'n/a';
                            try {
                                isEmpty = typeof redrawClip?.is_empty === 'function' ? redrawClip.is_empty() : 'n/a';
                            }
                            catch (_) { }
                            try {
                                extents = typeof redrawClip?.get_extents === 'function' ? JSON.stringify(redrawClip.get_extents()) : 'n/a';
                            }
                            catch (_) { }
                            try {
                                if (typeof redrawClip?.contains_rectangle === 'function') {
                                    containsPanel = redrawClip.contains_rectangle(panelTestRect);
                                }
                                else if (typeof redrawClip?.contains_point === 'function') {
                                    containsPanel = redrawClip.contains_point(960, 16);
                                }
                            }
                            catch (_) { }
                            console.log(`[DelayedScreenCapture][DIAG][REDRAW-CLIP] redrawClip=${redrawClip ? redrawClip.toString() : 'null'} ` +
                                `isEmpty=${isEmpty} extents=${extents} パネル領域を含むか=${containsPanel}`);
                        }
                        catch (e) {
                            console.log(`[DelayedScreenCapture][DIAG][REDRAW-CLIP] ログ出力で例外: ${e}`);
                        }
                    }
                    // ── 【重要】ここで同期的に読み取らない ──────────────────────
                    // paint-view のコールバックは、まだ Clutter/Cogl の
                    // 描画呼び出しスタックの "内側" (＝そのビューのフレームバッファが
                    // 描画先としてまだアクティブな可能性がある状態) である。
                    // 多くのGPUドライバでは、描画先としてバインド中のフレームバッファを
                    // 同時に読み取ろうとすると未定義動作 (多くの場合ゼロ埋め) になる。
                    // 実機検証で「blit/read_pixelsのどちらも、画面のどこを指定しても
                    // 常に完全ゼロ」という結果が出たのはこれと一致する……はずだったが、
                    // 'after-paint' での完全同期読み取りでも同じくゼロだったため、
                    // タイミング説はこれで否定的。redraw_clip仮説の検証結果待ち。
                    //
                    // 対策: 実際の読み取りは GLib.idle_add で「現在のメインループの
                    // 処理が完全に終わった後」まで遅延させる。これにより、GPU側の
                    // レンダーパスが確実に終了・フラッシュされた状態で読み取れる。
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        try {
                            this._capture(view);
                        }
                        catch (e) {
                            console.log(`[DelayedScreenCapture][DIAG] idle経由のcaptureで例外: ${e}`);
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
                catch (e) {
                    console.log(`[DelayedScreenCapture][DIAG] paint-view ハンドラ内で例外: ${e}`);
                }
            });
        }
        catch (e) {
            console.log(`[DelayedScreenCapture][DIAG] paint-view ハンドラで例外: ${e}`);
        }
    }
    retain() { this._refCount++; }
    release() {
        this._refCount--;
        if (this._refCount <= 0) {
            this.destroy();
            return true;
        }
        return false;
    }
    _capture(view) {
        const [sx, sy, sw, sh] = this._rectGetter();
        // console.log(`[DelayedScreenCapture][DIAG] rectGetter -> sx=${sx}, sy=${sy}, sw=${sw}, sh=${sh}`); // Panel: [DelayedScreenCapture][DIAG] rectGetter -> sx=0, sy=0, sw=1920, sh=32
        if (sw <= 0 || sh <= 0) {
            console.log('[DelayedScreenCapture][DIAG] 早期リターン: サイズが0以下');
            return;
        }
        const rect = new Mtk.Rectangle();
        view.get_layout(rect);
        const scale = view.get_scale();
        const viewX = rect.x, viewY = rect.y;
        const viewWidth = rect.width, viewHeight = rect.height;
        const interX = Math.max(sx, viewX);
        const interY = Math.max(sy, viewY);
        const interW = Math.min(sx + sw, viewX + viewWidth) - interX;
        const interH = Math.min(sy + sh, viewY + viewHeight) - interY;
        if (interW <= 0 || interH <= 0)
            return;
        // ── 【§4.2 続報】get_framebuffer() が返すのは "描画先" (native/KMS
        // バックエンドでは色管理/HDR等の理由で介在する中間 Cogl.Offscreen である
        // 可能性が高いことが Mutter ソース調査で判明した。ClutterStageView には
        // これとは別に、実際のスキャンアウト用 CoglOnscreen (native backend では
        // MetaOnscreenNative) を返す get_onscreen() が存在する
        // (src/backends/native/meta-renderer-native.c で
        //  `clutter_stage_view_get_onscreen()` として実際に使われているのを確認済み)。
        // get_framebuffer() 側の中間バッファは「ペイント→内部で本物の
        // onscreen へブリット→(推測)次フレーム用にすぐ使い回される」実装に
        // なっている可能性があり、これが「常に完全ゼロ」の最有力候補。
        // まずは get_onscreen() が使えるかどうかと、get_framebuffer() との
        // 実体差を診断ログで確認する。
        let onscreenFb = null;
        let usedGetOnscreen = false;
        try {
            if (typeof view.get_onscreen === 'function') {
                onscreenFb = view.get_onscreen();
                usedGetOnscreen = !!onscreenFb;
            }
        }
        catch (e) {
            console.log(`[DelayedScreenCapture][DIAG][GET-ONSCREEN] get_onscreen() 呼び出しで例外: ${e}`);
        }
        if (!this._loggedOnce) {
            try {
                const fb2 = view.get_framebuffer();
                let shadowfb = 'n/a';
                try {
                    shadowfb = typeof view.has_shadowfb === 'function' ? view.has_shadowfb() : 'n/a';
                }
                catch (_) { }
                console.log(`[DelayedScreenCapture][DIAG][GET-ONSCREEN] get_onscreen()の有無=${typeof view.get_onscreen === 'function'} ` +
                    `get_onscreen()結果=${onscreenFb ? onscreenFb.toString() : 'null'} ` +
                    `get_framebuffer()結果=${fb2 ? fb2.toString() : 'null'} ` +
                    `同一実体か=${onscreenFb === fb2} ` +
                    `has_shadowfb()=${shadowfb} ` +
                    `get_onscreen()はCogl.Onscreenか=${onscreenFb ? Cogl.Onscreen && onscreenFb instanceof Cogl.Onscreen : 'n/a'}`);
            }
            catch (e) {
                console.log(`[DelayedScreenCapture][DIAG][GET-ONSCREEN] 比較ログ出力で例外: ${e}`);
            }
        }
        // get_onscreen() が取れなかった場合のみ、従来通り get_framebuffer() に
        // フォールバックする（退行防止。これまでの「常にゼロ」という結果自体は
        // このフォールバック経路でも変わらないはずなので、実害はない）。
        if (!onscreenFb) {
            onscreenFb = view.get_framebuffer();
        }
        if (!onscreenFb)
            return;
        const srcX = Math.round((interX - viewX) * scale);
        const srcY = Math.round((interY - viewY) * scale);
        const blitW = Math.round(interW * scale);
        const blitH = Math.round(interH * scale);
        try {
            const ctx = onscreenFb.get_context();
            // ── 【方針転換】CPU read_pixels_into_bitmap は、paint-view ハンドラ内
            // から呼ぶ限り screenのどの座標を指定しても常に (0,0,0,0) を返すことが
            // 実機検証で確定した (画面中央付近をハードコードで読んでも同様)。
            // 一方 get_data() (テクスチャ→CPU方向) は毎回要求バイト数ぴったりを
            // 返しており機構自体は生きている。疑いは read_pixels_into_bitmap に
            // 絞られたため、CPU読み戻しを諦め、GPU間コピーである
            // Cogl.Framebuffer.blit() に戻す。以前 blit を試した際は白くなったが、
            // あれはコピー先を FP16 で当て推量していたことが原因と判明済みなので、
            // 今回は両側とも RGBA_8888 に揃えて再検証する。
            // 【決定的な切り分け実験】まずは画面中央付近をハードコードでblitし、
            // 非ゼロが取れるかを確認する。read_pixels同様の「常にゼロ」問題が
            // blitでも再現するかどうかで、原因が read_pixels 特有のものか、
            // paint-view タイミングそのものの問題かを切り分けられる。
            if (!this._loggedOnce) {
                try {
                    const testW = 200, testH = 200, testX = 500, testY = 500;
                    // オブジェクトの素性を確認 (毎回同じ実体か、pointerらしき情報が出るか)
                    console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] usedGetOnscreen=${usedGetOnscreen} onscreenFb.toString()=${onscreenFb.toString()}`);
                    console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] view.toString()=${view.toString()}`);
                    // 明示的なフラッシュ/待機を試す (未実行のGPUコマンドキューが
                    // 残っていて、blit/read_pixelsの時点でまだ描画が完了していない
                    // 可能性を潰すため)。存在しなければ何もしない。
                    try {
                        ctx.flush?.();
                    }
                    catch (_) { }
                    try {
                        onscreenFb.finish?.();
                    }
                    catch (_) { }
                    const testTex = Cogl.Texture2D.new_with_format(ctx, testW, testH, Cogl.PixelFormat.RGBA_8888);
                    const testFb = Cogl.Offscreen.new_with_texture(testTex);
                    onscreenFb.blit(testFb, testX, testY, 0, 0, testW, testH);
                    const rowStride = testW * 4;
                    const data = new Uint8Array(rowStride * testH);
                    const returnedSize = testTex.get_data(Cogl.PixelFormat.RGBA_8888, rowStride, data);
                    let nonZeroCount = 0;
                    for (let i = 0; i < data.length; i++) {
                        if (data[i] !== 0)
                            nonZeroCount++;
                    }
                    console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] blit(${testX},${testY},${testW}x${testH}) ` +
                        `returnedSize=${returnedSize} nonZeroBytes=${nonZeroCount}/${data.length} ` +
                        `sample(10,10)=(${data[10 * rowStride + 10 * 4]},${data[10 * rowStride + 10 * 4 + 1]},${data[10 * rowStride + 10 * 4 + 2]},${data[10 * rowStride + 10 * 4 + 3]}) ` +
                        `sample(100,100)=(${data[100 * rowStride + 100 * 4]},${data[100 * rowStride + 100 * 4 + 1]},${data[100 * rowStride + 100 * 4 + 2]},${data[100 * rowStride + 100 * 4 + 3]})`);
                    // ── さらに: blit先を「テクスチャ→FBO」ではなく、単純な
                    // オンスクリーンとして自分自身に対してblitしてみる (自己コピー)。
                    // これが成功する(=何か非ゼロが出る)なら、onscreenFb自体は
                    // 生きたバッファであり、"別のFBOへのblit"の組み合わせにのみ
                    // 問題があることになる。逆にこれも失敗するなら、onscreenFb
                    // そのものが実体を持たないダミーであることが濃厚になる。
                    try {
                        const selfTestTex = Cogl.Texture2D.new_with_format(ctx, 50, 50, Cogl.PixelFormat.RGBA_8888);
                        const selfTestFb = Cogl.Offscreen.new_with_texture(selfTestTex);
                        // まず一度オフスクリーンへ既知のダミー値を書いておき、
                        // blit後にそれが上書きされているかどうかで判定する手もあるが、
                        // ここでは単純化のため同じ blit をもう一度呼ぶだけに留める。
                        onscreenFb.blit(selfTestFb, 0, 0, 0, 0, 50, 50);
                        const rs2 = 50 * 4;
                        const d2 = new Uint8Array(rs2 * 50);
                        selfTestTex.get_data(Cogl.PixelFormat.RGBA_8888, rs2, d2);
                        let nz2 = 0;
                        for (let i = 0; i < d2.length; i++) {
                            if (d2[i] !== 0)
                                nz2++;
                        }
                        console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] 左上50x50 blit nonZeroBytes=${nz2}/${d2.length}`);
                    }
                    catch (e3) {
                        console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] 左上blit実験で例外: ${e3}`);
                    }
                }
                catch (e) {
                    console.log(`[DelayedScreenCapture][DIAG][SANITY-BLIT] blit切り分け実験で例外: ${e}`);
                }
            }
            // ── 切り分け実験ここまで ─────────────────────────────────────
            // 本番のパネル領域を GPU blit でキャプチャする
            if (!this._tex || this._tex.get_width() !== blitW || this._tex.get_height() !== blitH) {
                this._tex = Cogl.Texture2D.new_with_format(ctx, blitW, blitH, Cogl.PixelFormat.RGBA_8888);
                this._destFb = Cogl.Offscreen.new_with_texture(this._tex);
                console.log(`[DelayedScreenCapture][DIAG] テクスチャ/FBO再確保(blit経路, RGBA_8888): ${blitW}x${blitH}`);
            }
            if (this._destFb) {
                onscreenFb.blit(this._destFb, srcX, srcY, 0, 0, blitW, blitH);
            }
            if (!this._loggedOnce) {
                this._loggedOnce = true;
                console.log(`[DelayedScreenCapture][DIAG] blit経路(usedGetOnscreen=${usedGetOnscreen}): src=(${srcX},${srcY}) size=${blitW}x${blitH}`);
                try {
                    const rowStride = blitW * 4;
                    const data = new Uint8Array(rowStride * blitH);
                    const returnedSize = this._tex.get_data(Cogl.PixelFormat.RGBA_8888, rowStride, data);
                    const dump = (label, px, py) => {
                        const off = py * rowStride + px * 4;
                        console.log(`[DelayedScreenCapture][DIAG][PIXEL] ${label}=(${px},${py}) ` +
                            `RGBA=(${data[off]},${data[off + 1]},${data[off + 2]},${data[off + 3]}) returnedSize=${returnedSize}`);
                    };
                    dump('topLeft', 2, 2);
                    dump('center', Math.floor(blitW / 2), Math.floor(blitH / 2));
                }
                catch (e) {
                    console.log(`[DelayedScreenCapture][DIAG][PIXEL] get_data失敗: ${e}`);
                }
            }
        }
        catch (e) {
            console.log(`[DelayedScreenCapture][DIAG] blit経路で例外: ${e}`);
        }
    }
    getTexture() {
        return this._tex;
    }
    destroy() {
        if (this._afterPaintId) {
            try {
                this._stage.disconnect(this._afterPaintId);
            }
            catch (_) { }
            this._afterPaintId = 0;
        }
        this._tex = null;
        this._destFb = null;
    }
}
/**
 * Looking Glassのピッカーを透過するClutter.Clone
 */
export const UnpickableClone = GObject.registerClass(class UnpickableClone extends Clutter.Clone {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * 自分自身と子要素すべてをLooking Glassのピッカーから透過するコンテナアクター
 * ※ St.WidgetのCSS余白干渉を排除するため、すべて純粋な Clutter.Actor を使用
 */
export const UnpickableActor = GObject.registerClass(class UnpickableActor extends Clutter.Actor {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
/**
 * Looking Glassのピッカーを透過するSt.Widget
 */
export const UnpickableWidget = GObject.registerClass(class UnpickableWidget extends St.Widget {
    vfunc_pick(_pickContext) {
        // No-op
    }
});
// ─── 【DEBUG-BMS】検証用: 同一フレーム内の多重ペイント検出プローブ ────────────
//
// 仮説: BMS (Blur My Shell) のパネルブラー用アクター (bg_manager.backgroundActor)
// は、GNOME Shell の通常のコンポジタパスで直接ペイントされるのに加えて、
// UILayerSampler が生成する Clutter.Clone 経由でも「同じ Actor インスタンス」が
// 同一フレーム内にもう一度ペイントされてしまっている可能性がある。
// Clutter.OffscreenEffect のFBOサイズ・パディング計算がペイント時の
// アンビエントなコンテキスト（現在アクティブな描画先フレームバッファや
// クリップ・変換行列）に依存するとすれば、この「1フレーム2回ペイント」こそが
// ズレの直接原因である可能性が高い。
//
// このプローブは通常の Clutter.Effect (OffscreenEffect ではない) として
// 対象アクターに追加する。vfunc_paint は「そのアクターが何らかの経路で
// ペイントされるたび」に呼ばれるため、直接パスと Clone 経由パスの
// 両方をカウントできる。実際の描画内容には一切手を加えず、
// continue_paint() で素通しするだけの完全に非破壊的なプローブ。
//
// 【拡張】呼び出し回数のブレ (2回だったり4回だったりする) が観測されたため、
// 単純な回数だけでなく「その時点でアクティブな描画先フレームバッファの
// サイズ」も記録するようにした。これにより:
//   - 毎回ほぼ同じ (モニター解像度に近い) サイズ  → 本物の画面パス
//   - 毎回 liquidBox 内部の小さいFBOサイズ        → 私たち自身のパイプライン
//     内部での再キャプチャ
// のどちらが多重ペイントの正体かを切り分けられる。
export const PaintProbeEffect = GObject.registerClass(class PaintProbeEffect extends Clutter.Effect {
    // 同一フレームとみなす時間窓 (us)。60Hz で 1 フレーム ≈ 16666us。
    // 直接パスと Clone 経由パスは同一 JS コールスタック内 (同一フレームの
    // stage paint) で呼ばれるはずなので、これよりずっと小さい間隔で
    // 連続ペイントされていれば「同一フレーム内の多重ペイント」と判定する。
    static _FRAME_WINDOW_US = 8000;
    _init(params) {
        super._init(params);
        if (params && params.label)
            this._label = params.label;
        this._windowStartUs = 0;
        this._windowSamples = [];
        this._totalCalls = 0;
    }
    setLabel(label) {
        this._label = label;
    }
    // 【要確認】Clutter.Effect.vfunc_paint のシグネチャは Clutter のバージョンに
    // よって (node, paint_context) か (paint_context) のどちらかになり得る。
    // 実行時に GJS が "too few/many arguments" 系の警告を出す場合は、
    // 引数リストをもう一方の形に合わせて修正すること。
    vfunc_paint(_node, paintContext) {
        const nowUs = GLib.get_monotonic_time();
        this._totalCalls++;
        let fbW = -1;
        let fbH = -1;
        try {
            const fb = paintContext.get_framebuffer();
            fbW = fb.get_width();
            fbH = fb.get_height();
        }
        catch (_) { /* noop */ }
        if (this._windowStartUs === 0 ||
            (nowUs - this._windowStartUs) > PaintProbeEffect._FRAME_WINDOW_US) {
            // 新しい「フレームウィンドウ」の開始。直前のウィンドウで2回以上
            // ペイントされていた場合は、そのウィンドウを多重ペイントとして報告する。
            if (this._windowSamples.length > 1) {
                const detail = this._windowSamples
                    .map(s => `fb=${s.fbW}x${s.fbH}@+${s.offsetUs}us`)
                    .join(', ');
                console.log(`[Liquid Glass][DEBUG-BMS-PROBE][${this._label}] ` +
                    `★ 同一フレーム内で ${this._windowSamples.length} 回ペイントされました ` +
                    `(累計 ${this._totalCalls} 回) 詳細: [${detail}]`);
            }
            this._windowStartUs = nowUs;
            this._windowSamples = [];
        }
        this._windowSamples.push({ offsetUs: nowUs - this._windowStartUs, fbW, fbH });
        // 素通し: 実際の描画内容には一切影響を与えない
        const actor = this.get_actor();
        if (actor && typeof actor.continue_paint === 'function') {
            actor.continue_paint(paintContext);
        }
    }
});
// ─── 恒久対策: 「二重評価」を避けるためのキャプチャ＆ブリット機構 ────────────
//
// 【背景】DEBUG-BMS プローブにより、BMS のパネルブラー対象アクターが
// 1フレームに2回ペイントされていること (直接パス + Clutter.Clone パス) を
// 確認済み。さらに Clone パスを無効化すると実機のズレが解消することも
// 確認済み。つまり Clutter.Clone が source の "生きた" ペイント
// (＝エフェクトチェーンの再評価) を毎フレーム強制してしまうことが直接原因。
//
// 【対策の要点】
//   Clutter.OffscreenEffect は、何も vfunc をオーバーライドせずに actor へ
//   追加するだけで「その actor の本物のペイント結果」を内部 FBO に
//   キャプチャしてそのまま描画する (＝見た目は一切変わらない)。
//   これを clone 対象の child 自身に 1 枚だけ追加しておけば、
//   GNOME Shell の通常のコンポジタパス (1フレームにつき本来1回だけの
//   本物のペイント) の結果を get_texture() で安全に読み出せる。
//
//   私たちの側では、この child を Clutter.Clone で "再ペイント" する代わりに、
//   キャプチャ済みテクスチャをただ Cogl で貼り付けるだけの軽量アクター
//   (TextureBlitActor) を使う。これは source の paint を一切トリガーしない
//   ため、他拡張の OffscreenEffect が二重に (＝異なるアンビエントコンテキストで)
//   評価されることが原理的に起こらなくなる。
//
//   liquidEffect.ts の調査で判明した「Cogl の OffscreenEffect が返す FBO は
//   論理サイズより数px大きく、パディングは中央に均等分配される」という
//   知見をここでも踏まえ、テクスチャサイズと論理サイズが食い違う場合は
//   中央アンカーでクロップしてから描画する。
/**
 * 【現在は不使用・参考として残置】
 * v1 の恒久修正 (BMSのアクターに直接このエフェクトを追加する方式) は、
 * BMSにとって未知の追加ネストコンテキストになり、本物のブラーを壊すことが
 * 判明したため撤回した (v2 = _findExistingOffscreenEffect による非侵襲な
 * 既存エフェクト読み取り方式に置き換え済み)。
 *
 * 何もオーバーライドしない、素の OffscreenEffect。
 * 対象アクターへ追加するだけで、その本物のペイント結果を
 * get_texture() 経由で安全に読み出せるようになる「キャプチャ用タップ」。
 */
export const PassthroughCaptureEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassPassthroughCaptureEffect',
}, class PassthroughCaptureEffect extends Clutter.OffscreenEffect {
});
/**
 * PassthroughCaptureEffect が保持するテクスチャを、自分自身の allocation
 * いっぱいに描画するだけの軽量アクター。Clutter.Clone と違い、source の
 * paint (＝エフェクトチェーンの再評価) を一切トリガーしない。
 */
export const TextureBlitActor = GObject.registerClass({
    GTypeName: 'LiquidGlassTextureBlitActor',
}, class TextureBlitActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        this._getTexture = null;
        this._sourceActor = null;
        this._pipeline = null;
        this._flipY = false;
        this._opaqueBlend = false;
    }
    /**
  * true にすると、テクスチャのアルファ値を完全に無視し、
  * サンプリングした色でそのまま上書きするブレンドモードに固定する。
  * DelayedScreenCapture (=画面の最終フレームバッファをキャプチャしたもの、
  * アルファに意味がない) を貼る場合に指定する。
  */
    setOpaqueBlend(opaque) {
        this._opaqueBlend = opaque;
    }
    vfunc_pick(_pickContext) { }
    setTextureGetter(fn) {
        this._getTexture = fn;
    }
    setSourceActor(actor) {
        this._sourceActor = actor;
    }
    /**
     * true にすると、テクスチャの V 座標を反転してサンプリングする。
     * DelayedScreenCapture が生成するテクスチャ (onscreen → offscreen の
     * blit に起因する上下反転) を貼る場合に指定する。
     * 通常の Clutter.OffscreenEffect の get_texture() は反転していないため、
     * 既存の用途 (BMS以外のOffscreenEffect読み取り) では false のままでよい。
     */
    setFlipY(flip) {
        this._flipY = flip;
    }
    _getCoglContext() {
        try {
            const backend = Clutter.get_default_backend();
            return backend.get_cogl_context();
        }
        catch (e) {
            console.error(`[Liquid Glass][TextureBlitActor] Cogl コンテキスト取得失敗: ${e}`);
            return null;
        }
    }
    vfunc_paint(paintContext) {
        if (!this._getTexture)
            return;
        const tex = this._getTexture();
        if (!tex)
            return;
        try {
            if (!this._pipeline) {
                const ctx = this._getCoglContext();
                if (!ctx)
                    return;
                this._pipeline = Cogl.Pipeline.new(ctx);
                this._pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
                this._pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
                if (this._opaqueBlend) {
                    try {
                        // アルファをブレンド係数として一切使わず、サンプリングした色を
                        // そのまま書き込む (= 通常の "上書き" 合成)。
                        this._pipeline.set_blend('RGBA = ADD(SRC_COLOR, 0)');
                    }
                    catch (e) {
                        console.log(`[Liquid Glass][TextureBlitActor] set_blend失敗: ${e}`);
                    }
                }
            }
            const texW = tex.get_width();
            const texH = tex.get_height();
            let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
            const src = this._sourceActor;
            if (src) {
                const [rawW, rawH] = src.get_size();
                const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
                const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;
                if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
                    const padW = texW - allocW;
                    const padH = texH - allocH;
                    uMin = (padW / 2) / texW;
                    vMin = (padH / 2) / texH;
                    uMax = Math.min(1.0, uMin + allocW / texW);
                    vMax = Math.min(1.0, vMin + allocH / texH);
                }
            }
            this._pipeline.set_layer_texture(0, tex);
            const [w, h] = this.get_size();
            if (!(w > 0) || !(h > 0))
                return;
            const fb = paintContext.get_framebuffer();
            // flipY の場合は V 座標の上下を入れ替えて描画するだけで補正できる
            const ty1 = this._flipY ? vMax : vMin;
            const ty2 = this._flipY ? vMin : vMax;
            fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, ty1, uMax, ty2);
        }
        catch (e) {
            console.error(`[Liquid Glass][TextureBlitActor] paint失敗: ${e}`);
        }
    }
});
const _delayedCaptureRegistry = new Map();
/**
 * sourceActor に対応する DelayedScreenCapture を取得する。無ければ生成する。
 * 複数の UILayerSampler (常設ドックの用・開閉メニュー用など) が同じ
 * panelBox を毎フレーム別々にブリットする無駄を避けるための共有プール。
 * 呼び出し側は必ず releaseDelayedCapture() で解放すること。
 */
function acquireDelayedCapture(sourceActor, rectGetter) {
    let capture = _delayedCaptureRegistry.get(sourceActor);
    if (!capture) {
        capture = new DelayedScreenCapture(global.stage, rectGetter);
        _delayedCaptureRegistry.set(sourceActor, capture);
    }
    capture.retain();
    return capture;
}
function releaseDelayedCapture(sourceActor) {
    const capture = _delayedCaptureRegistry.get(sourceActor);
    if (!capture)
        return;
    if (capture.release()) {
        _delayedCaptureRegistry.delete(sourceActor);
    }
}
/**
 * 汎用UIレイヤーサンプラー
 */
export class UILayerSampler {
    _selfActor;
    _container;
    _extraExclusions;
    _selfRoot = null;
    _clones = new Map();
    // WindowCloneManager に見習った単一のクローン格納用コンテナ
    _uiClonesContainer;
    // ─── 【DEBUG-BMS】検証用フィールド ────────────────────────────────────────
    // Main.panel との干渉調査: BMS のパネルブラー対象アクターを特定し、
    //   (a) 多重ペイント検出プローブを取り付ける
    //   (b) 実験的にそのクローンだけを非表示にして症状が消えるか確認する
    // ための状態。検証が終わったら _debugBmsProbeEnabled を false に戻すこと。
    _debugBmsProbeEnabled = true;
    // true の間、BMS対象アクターに対応する sourceClone を強制的に非表示にする。
    // これで「クローン経由の二重ペイントを止めたら本物の Main.panel の
    // ブラーずれが直るか」をA/Bテストできる。
    _debugDisableBmsClone = false;
    // 取り付けたプローブ (destroy時の後始末用。"すでに付いているか" の判定は
    // インスタンス跨ぎでアクター自身にスタンプするので、このMapはあくまで
    // 「このインスタンスが実際に追加したもの」の記録に過ぎない。
    _debugProbedActors = new Map();
    // ── 恒久対策 (v2): BMS 側のアクターツリーには一切何も追加しない ────────
    // v1 (PassthroughCaptureEffect を追加する方式) は、BMSにとって未知の
    // 追加ネストコンテキストになってしまい、Clutter.Clone のときと同じ理由で
    // 本物のブラーを壊してしまうことが判明したため撤回。
    // 代わりに、BMSが元々自分で付けている OffscreenEffect を「探すだけ」にし、
    // その get_texture() を横から読む。アクターツリーには一切手を加えない。
    // (actor, effect) の探索結果はただの読み取りキャッシュなので、
    // 複数の UILayerSampler インスタンスが同時に存在しても副作用は起きない。
    _existingEffectCache = new Map();
    // true の間、BMS対象を含む child は Clutter.Clone ではなく、
    // 既存の OffscreenEffect のテクスチャを読むだけの TextureBlitActor で
    // 描画する (恒久修正)。
    // 【注記】BMS (blur-my-shell) の実際のブラー実装は "NativeDynamicBlurEffect"
    // というネイティブ(C)実装で、Clutter.OffscreenEffect を継承していない
    // ことが判明したため、BMSに対しては常に Clone にフォールバックする。
    // この仕組み自体は「Clutter.OffscreenEffect を継承したJS実装の他拡張」
    // に対しては有効な可能性があるため、無効化はせず残してある。
    _useCaptureFixForBms = true;
    _delayedCaptureOwners = new Map(); // clone-key -> sourceActor
    constructor(selfActor, container, extraExclusions = [], cloneContainer = null) {
        this._selfActor = selfActor;
        this._container = container;
        this._extraExclusions = new Set(extraExclusions);
        this._selfRoot = this._findUiGroupAncestor(selfActor);
        this._uiClonesContainer = new UnpickableActor();
        this._uiClonesContainer.set_name("ui-clones-container");
        // 絶対座標 0,0 起点のコンテナを作成して追加
        if (cloneContainer) {
            cloneContainer.add_child(this._uiClonesContainer);
        }
        else {
            this._container.add_child(this._uiClonesContainer);
        }
    }
    _findUiGroupAncestor(actor) {
        const uiGroup = Main.layoutManager.uiGroup;
        let current = actor;
        while (current) {
            if (current.get_parent() === uiGroup)
                return current;
            current = current.get_parent();
        }
        return null;
    }
    // 任意のActorを除外リストに追加する関数
    addExclusion(actor) {
        if (!actor)
            return;
        this._extraExclusions.add(actor);
    }
    // ─── 【DEBUG-BMS】検証用API ─────────────────────────────────────────────
    /**
     * Main.extensionManager 経由で BMS のパネルブラー対象アクターを解決する。
     * BMS が無効・未インストール・内部構造が変わっている場合は null を返す
     * (すべて try-catch でガードし、失敗しても本体機能には影響させない)。
     */
    _resolveBmsTargetActor() {
        try {
            const ext = Main.extensionManager?.lookup?.('blur-my-shell@aunetx');
            const actor = ext?.stateObj?._panel_blur?.actors_list?.[0]?.bg_manager?.backgroundActor;
            return actor ?? null;
        }
        catch (_) {
            return null;
        }
    }
    /**
     * uiGroup の直接の子 `child` が、BMS対象アクターそのもの、または
     * その祖先 (＝クローン対象として一緒に描画される) であるかを判定する。
     */
    _findBmsDescendant(child) {
        const target = this._resolveBmsTargetActor();
        if (!target)
            return null;
        if (child === target)
            return target;
        try {
            if (typeof child.contains === 'function' && child.contains(target)) {
                return target;
            }
        }
        catch (_) { /* noop */ }
        return null;
    }
    /**
     * 検証用A/Bテストの切り替え。true にすると BMS対象アクターに対応する
     * クローンを強制的に非表示にする。これで本物の Main.panel 側のズレが
     * 消えれば「クローン経由の二重ペイントが原因」という仮説が裏付けられる。
     */
    setDebugDisableBmsClone(disabled) {
        this._debugDisableBmsClone = disabled;
        console.log(`[Liquid Glass][DEBUG-BMS] setDebugDisableBmsClone(${disabled})`);
    }
    setDebugBmsProbeEnabled(enabled) {
        this._debugBmsProbeEnabled = enabled;
    }
    /**
     * DelayedScreenCapture を使った BMS 対象用の TextureBlitActor を作る。
     * 見つからなかった（何らかの理由で作れなかった）場合は null を返し、
     * 呼び出し側で Clutter.Clone にフォールバックする。
     */
    _createDelayedCaptureBlitActor(child) {
        try {
            const stage = child.get_stage();
            if (!stage)
                return null;
            const rectGetter = () => {
                const [x, y] = child.get_transformed_position();
                const [w, h] = child.get_size();
                if (Number.isNaN(x) || Number.isNaN(y) || w <= 0 || h <= 0) {
                    return [0, 0, 0, 0];
                }
                return [x, y, w, h];
            };
            const capture = acquireDelayedCapture(child, rectGetter);
            const blit = new TextureBlitActor();
            blit.setSourceActor(child);
            blit.setFlipY(true); // ← DelayedScreenCapture 由来なので反転補正が必要
            blit.setOpaqueBlend(true);
            blit.setTextureGetter(() => capture.getTexture());
            this._delayedCaptureOwners.set(blit, child);
            blit.connect('destroy', () => {
                const src = this._delayedCaptureOwners.get(blit);
                if (src) {
                    releaseDelayedCapture(src);
                    this._delayedCaptureOwners.delete(blit);
                }
            });
            return blit;
        }
        catch (e) {
            console.error(`[Liquid Glass] DelayedScreenCapture Blit生成失敗: ${e}`);
            return null;
        }
    }
    /**
     * 恒久修正の切り戻し用トグル (旧名を維持)。
     */
    setUseCaptureFixForBms(enabled) {
        this._useCaptureFixForBms = enabled;
    }
    /**
     * root 以下のサブツリーを探索し、すでに付いている
     * Clutter.OffscreenEffect (BMSのブラー等) を見つける。
     * 私たち自身が追加したデバッグ用エフェクト (GTypeName が "LiquidGlass"
     * で始まるもの) は除外する。見つからなければ null。
     *
     * 【重要】ここでは actor.add_effect 等、書き込み系の操作は一切行わない。
     * 完全に読み取り専用の探索。
     */
    _findExistingOffscreenEffect(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const effects = actor.get_effects?.() ?? [];
                for (const effect of effects) {
                    if (!(effect instanceof Clutter.OffscreenEffect))
                        continue;
                    const gtypeName = effect.constructor?.$gtype?.name ?? '';
                    if (gtypeName.startsWith('LiquidGlass'))
                        continue; // 自前のデバッグ用は除外
                    return { actor, effect: effect };
                }
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return null;
    }
    /**
     * 恒久修正 (v2・非侵襲): child (uiGroup 直下の子。BMS対象を含む) の
     * サブツリーから、BMS自身がすでに付けている OffscreenEffect を探し、
     * その get_texture() を横から読むだけの TextureBlitActor を作る。
     * アクターツリーには一切書き込みを行わないため、v1で起きた
     * 「本物のブラーが消える」問題は原理的に起こらない。
     *
     * 見つからなかった場合は null を返す (呼び出し側で Clone にフォールバック)。
     */
    _createExistingEffectBlitActor(child) {
        let found = this._existingEffectCache.get(child);
        if (found === undefined) {
            found = this._findExistingOffscreenEffect(child);
            this._existingEffectCache.set(child, found);
            if (found) {
                const gtypeName = found.effect.constructor?.$gtype?.name ?? '(unknown)';
                console.log(`[Liquid Glass] 既存の OffscreenEffect を発見 (非侵襲で読み取り専用利用): ` +
                    `actor=${found.actor.name || found.actor}, effectType=${gtypeName}`);
            }
            else {
                console.warn(`[Liquid Glass] ${child.name || child} 以下に既存の OffscreenEffect が` +
                    `見つかりませんでした。Clutter.Clone にフォールバックします。`);
            }
        }
        if (!found)
            return null;
        const { actor: effectOwner, effect } = found;
        const blit = new TextureBlitActor();
        blit.setSourceActor(effectOwner);
        blit.setTextureGetter(() => effect.get_texture());
        return blit;
    }
    rebindSelf() {
        this._selfRoot = this._findUiGroupAncestor(this._selfActor);
    }
    /**
     * 【新規・再帰的クローン問題への対策】
     *
     * 【観測された症状】メニュー(通知/カレンダー等のポップアップ)を開いている間、
     * ガラスの中に「自分自身に似た、縮小したガラス」が数個入れ子になって
     * 映り込み、時間とともに一番深い(＝一番小さい)入れ子から順に真っ白に
     * なっていく現象が実機で確認された。GNOME Shellのクラッシュ等は伴わない。
     *
     * 【原因の特定】既存の「他のLiquid Glassインスタンスを除外する」ロジックは
     * 2箇所に存在するが、どちらも "浅い" チェックだった:
     *   - uiManager.ts の buildClones(): uiGroup直下の子について、その名前が
     *     'liquid-glass-bg-actor' であるか、"直接の子(1階層だけ)" に
     *     'liquid-box' という名前のものがあるかしか見ていない。
     *   - utils.ts (このファイル) の refresh(): uiGroup直下の子 "自身の" 名前が
     *     'liquid-glass-bg-actor' かどうかしか見ていない (0階層)。
     *
     * つまり、あるLiquid Glassインスタンスのルート(bgActor)が、uiGroupの
     * 直接の子から見て2階層以上ネストした位置にある場合 (例: 複数の
     * ポップアップが同時に開いている、他の拡張機能やGNOME Shell自体の
     * コンテナでもう1段ラップされている、等)、このチェックは静かに
     * すり抜けてしまい、そのインスタンス全体 (＝すでに他のUI要素を
     * クローンして描画済みの、ガラス越しの映像) を丸ごと自分のガラスの
     * 中に取り込んでしまう。これが「自分に似た入れ子のガラス」の正体。
     *
     * 「段階的に一番深い入れ子から白くなっていく」のは、この取り込まれた
     * 側のインスタンスがさらにBMS等の単一所有者モデルの奪い合いに
     * 巻き込まれ、再帰の深い(＝評価が後回しになりやすい)側から順に
     * 描画内容を失っていくため、と考えられる。
     *
     * 【対策】uiGroup直下の子を除外判定する際、"その子孫のどこかに"
     * Liquid Glassのルートアクター (名前が 'liquid-glass-bg-actor' または
     * 'liquid-box') が存在するかどうかを、深さ制限なしで再帰的に探索する。
     * 見つかった時点で早期リターンするため、通常のUI要素(そういったものを
     * 一切含まない)に対するコストはほぼ無視できる。
     */
    _containsOtherLiquidGlassRoot(root) {
        const stack = [root];
        const visited = new Set();
        while (stack.length > 0) {
            const actor = stack.pop();
            if (visited.has(actor))
                continue;
            visited.add(actor);
            try {
                const name = actor.name;
                if (name === 'liquid-glass-bg-actor' || name === 'liquid-box')
                    return true;
                const children = actor.get_children?.() ?? [];
                for (const c of children)
                    stack.push(c);
            }
            catch (_) { /* noop */ }
        }
        return false;
    }
    refresh() {
        if (!this._selfRoot)
            this._selfRoot = this._findUiGroupAncestor(this._selfActor);
        const uiGroup = Main.layoutManager.uiGroup;
        const children = uiGroup.get_children();
        const seen = new Set();
        for (const child of children) {
            // 1. 【追加】ループ冒頭での破棄チェック
            // C++側で破棄済みの場合は処理をスキップする
            if (child._isDisposed)
                continue;
            if (child === this._selfActor || child === this._selfRoot)
                continue;
            if (child === Main.layoutManager._backgroundGroup)
                continue;
            if (this._extraExclusions.has(child))
                continue;
            if (!child.visible || !child.mapped)
                continue;
            // 【修正】0階層(自分自身の名前)だけでなく、子孫のどこかに他の
            // Liquid Glass インスタンスのルートが存在するかを再帰的に確認する。
            // (旧: if (child.name === 'liquid-glass-bg-actor') continue; ← 浅すぎた)
            if (this._containsOtherLiquidGlassRoot(child))
                continue;
            seen.add(child);
            if (!this._clones.has(child)) {
                // 2. 【追加】オリジナルの child 自体の破棄を監視する
                child.connect('destroy', () => {
                    // JS側のラッパーにフラグを立てる（TypeScriptの型エラー回避のため any キャスト）
                    child._isDisposed = true;
                    // 大元のActorが消えたら、即座にクローンも破棄してMapから消す
                    const clone = this._clones.get(child);
                    if (clone) {
                        this._clones.delete(child);
                        try {
                            clone.destroy();
                        }
                        catch (_) { }
                    }
                });
                // BMS対象を含む child かどうかを先に判定しておく
                // (恒久修正の適用可否・プローブ取り付けの両方で使う)
                const bmsTarget = this._findBmsDescendant(child);
                let sourceClone = null;
                if (bmsTarget) {
                    // 1st try: 既存の OffscreenEffect を非侵襲に読む (BMS以外の
                    //          将来的な拡張機能向け。BMS自体は必ず失敗する)
                    if (this._useCaptureFixForBms) {
                        sourceClone = this._createExistingEffectBlitActor(child);
                    }
                    // 2nd try: 1フレーム遅延スクリーンキャプチャ (BMSに対する本命)
                    if (!sourceClone) {
                        sourceClone = this._createDelayedCaptureBlitActor(child);
                    }
                }
                // 3rd (fallback)
                if (!sourceClone) {
                    // clipper は廃止し、直接コンテナに UnpickableClone を追加する
                    sourceClone = new UnpickableClone({ source: child });
                }
                sourceClone.set_name(`${child.name}-sourceClone`);
                sourceClone.connect('destroy', () => {
                    this._clones.delete(child);
                });
                this._uiClonesContainer.add_child(sourceClone);
                this._clones.set(child, sourceClone);
                // ── 【DEBUG-BMS】多重ペイント検出プローブを一度だけ取り付ける。
                //    "すでに付いているか" はアクター自身にスタンプして判定する。
                //    複数の UILayerSampler インスタンス (例: 常設ドックのガラスと
                //    開閉式メニューのガラス) が同時に存在していても、二重に
                //    プローブが積み重なるのを防ぐため。
                if (this._debugBmsProbeEnabled && bmsTarget && !bmsTarget._liquidGlassProbeAttached) {
                    try {
                        const probe = new PaintProbeEffect();
                        probe.setLabel('BMS_TARGET');
                        bmsTarget.add_effect_with_name('liquid-glass-debug-bms-probe', probe);
                        bmsTarget._liquidGlassProbeAttached = true;
                        this._debugProbedActors.set(bmsTarget, probe);
                        console.log('[Liquid Glass][DEBUG-BMS] BMS対象アクターにペイントプローブを取り付けました: ' +
                            `${bmsTarget}`);
                    }
                    catch (e) {
                        console.error(`[Liquid Glass][DEBUG-BMS] プローブ取り付け失敗: ${e}`);
                    }
                }
            }
        }
        for (const [actor, sourceClone] of this._clones) {
            if (!seen.has(actor)) {
                try {
                    sourceClone.destroy();
                }
                catch (_) { }
            }
        }
    }
    static _stageToLocal(actor, stageX, stageY) {
        try {
            const res = actor.transform_stage_point(stageX, stageY);
            if (Array.isArray(res) && res[0] === true) {
                return [res[1], res[2]];
            }
        }
        catch (_) { }
        try {
            const [cx, cy] = actor.get_transformed_position();
            return [
                stageX - (Number.isNaN(cx) ? 0 : cx),
                stageY - (Number.isNaN(cy) ? 0 : cy),
            ];
        }
        catch (_) {
            return [stageX, stageY];
        }
    }
    syncProperties(source, sourceClone, containerW, containerH, cX, cY) {
        if (!source || !sourceClone)
            return;
        try {
            const [absX, absY] = source.get_transformed_position();
            const [w, h] = source.get_size();
            if (Number.isNaN(absX) || Number.isNaN(absY) || w <= 0 || h <= 0) {
                sourceClone.visible = false;
                return;
            }
            const scaleX = source.scale_x;
            const scaleY = source.scale_y;
            // 【バグ修正】get_transformed_position() は "source のローカル原点 (0,0)" を
            // source 自身の scale/pivot も含めた累積変換後にステージ座標へ写した値。
            // つまり absX/absY にはすでに「pivot を中心とした scale」の影響が
            // 織り込み済みである。
            //
            // 以前の実装は、この absX/absY をそのまま sourceClone の position に設定した
            // "上で"、さらに sourceClone 自身にも同じ scale/pivot を再度適用していたため、
            // pivot・scale による原点シフト ( pivot * size * (1 - scale) ) が二重に
            // 加算されてしまっていた。
            // scale が 1 かつ pivot が (0,0) の要素では誤差が出ないため気付きにくいが、
            // ホバー/プレス時に scale アニメーションする St.Button 等（カレンダーの
            // today ハイライト、パネルボタン等）では実際に数ピクセルのズレとして
            // 現れる。これが「UI要素のクローンが常に右下（またはpivot方向）に
            // 数ピクセルズレる」症状の一因。
            //
            // 修正方針: clone 側では scale を再適用せず、代わりに
            // 「source の変換後の見かけ上のサイズ (w*scaleX, h*scaleY)」を
            // clone の size にそのまま設定する。position は absX/absY（すでに
            // pivot+scale 込みの絶対原点）をそのまま使う。これにより
            // pivot によるシフトを二重計算せずに、source の見た目と1:1で一致する。
            const scaledW = w * scaleX;
            const scaledH = h * scaleY;
            sourceClone.set_position(absX, absY);
            sourceClone.translation_x = 0;
            sourceClone.translation_y = 0;
            sourceClone.set_size(scaledW, scaledH);
            // clone 自身は scale を持たない（すでに size に折り込み済み）
            sourceClone.set_scale(1.0, 1.0);
            sourceClone.set_pivot_point(0, 0);
            sourceClone.opacity = source.opacity;
            // 交差判定（既存ロジックの維持）
            const localX = absX - cX;
            const localY = absY - cY;
            const isVisible = source.visible && source.mapped;
            if (isVisible && containerW > 0 && containerH > 0) {
                const isIntersecting = localX < containerW &&
                    (localX + scaledW) > 0 &&
                    localY < containerH &&
                    (localY + scaledH) > 0;
                sourceClone.visible = isIntersecting;
            }
            else {
                sourceClone.visible = isVisible;
            }
            // ── 【DEBUG-BMS】A/Bテスト: 有効な間は BMS対象を含むクローンを
            //    強制的に非表示にする。他の可視性ロジックより後で上書きすることで
            //    確実に効かせる。
            if (this._debugDisableBmsClone && this._findBmsDescendant(source) !== null) {
                sourceClone.visible = false;
            }
        }
        catch (_) { }
    }
    // Repositions the UI-clone container and culls off-screen clones.
    //
    // [CHANGED] In the new full-screen FBO architecture, dockManager calls this as:
    //   sync(monitor.x, monitor.y, screenW, screenH)
    // instead of the old sync(bgX, bgY, bgW, bgH).
    //
    // Effect: _uiClonesContainer is placed at (-monitor.x, -monitor.y) so that
    // a clone at absolute position (absX, absY) ends up at screen position
    //   monitor.x + (-monitor.x + absX) = absX  ✓
    // The wider container dimensions (screenW, screenH) relax the cull frustum
    // to the full monitor; the actual rendering is still limited to the dock area
    // by the set_clip applied to liquidBox and blurBox in dockManager.
    sync(cX, cY, cW, cH) {
        let contW = cW ?? 0;
        let contH = cH ?? 0;
        let contAbsX = cX ?? 0;
        let contAbsY = cY ?? 0;
        if (cX === undefined || cY === undefined) {
            try {
                const [cw, ch] = this._container.get_size();
                if (!Number.isNaN(cw))
                    contW = cw;
                if (!Number.isNaN(ch))
                    contH = ch;
                const [tx, ty] = this._container.get_transformed_position();
                contAbsX = Number.isNaN(tx) ? 0 : tx;
                contAbsY = Number.isNaN(ty) ? 0 : ty;
            }
            catch (_) { }
        }
        if (this._uiClonesContainer.get_parent() === this._container) {
            this._container.set_child_above_sibling(this._uiClonesContainer, null);
        }
        // WindowCloneManager の setOffset(x, y) と正負が逆の cX, cY が渡るため、
        // ここでマイナスにしてコンテナの位置を設定する
        this._uiClonesContainer.set_position(-contAbsX, -contAbsY);
        for (const [actor, sourceClone] of this._clones) {
            this.syncProperties(actor, sourceClone, contW, contH, contAbsX, contAbsY);
        }
    }
    destroy() {
        if (this._uiClonesContainer) {
            try {
                this._uiClonesContainer.destroy();
            }
            catch (_) { }
        }
        this._clones.clear();
        this._selfRoot = null;
        // ── 恒久修正 (v2) は読み取り専用なので、BMS側のアクターに追加した
        //    ものは何もない。キャッシュをクリアするだけで良い。
        this._existingEffectCache.clear();
        for (const [actor, effect] of this._debugProbedActors) {
            try {
                if (!actor._isDisposed) {
                    actor.remove_effect(effect);
                    actor._liquidGlassProbeAttached = false;
                }
            }
            catch (_) { /* すでに破棄済みなら無視 */ }
        }
        this._debugProbedActors.clear();
    }
}
export class WindowCloneManager {
    windowClonesContainer = null;
    _windowClones;
    bgClone = null;
    container = null;
    cloneContainer = null;
    constructor(container, cloneContainer = null) {
        this.container = container;
        this._windowClones = new Map();
        this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
        this.windowClonesContainer = new UnpickableActor();
        this.cloneContainer = cloneContainer;
        // 【バグ修正】以前はここで windowClonesContainer を cloneContainer に
        // add_child() した直後、下の insert_child_at_index() で container にも
        // 追加しようとしていた。Clutter の Actor は同時に2つの親を持てないため、
        // 2回目の追加は失敗（またはコンソールに critical 警告を出しつつ無視）し、
        // 実際の親がどちらになるかが Clutter のバージョン・実装依存で不定になっていた。
        // 「bgClone を先、windowClonesContainer を後」という z-order 上の意図は
        // cloneContainer が container 内で bgClone より後ろに追加されている限り
        // 自然に満たされるため、二重追加は不要。cloneContainer が渡されなかった
        // 場合のみ container 直下に追加するフォールバックにする。
        if (this.cloneContainer) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        // bgClone（壁紙）は常に container の最背面（index 0）に挿入する
        this.container.insert_child_at_index(this.bgClone, 0);
    }
    rebuildClones() {
        if (!this.container)
            return;
        if (this.bgClone) {
            this.bgClone.destroy();
            this.bgClone = null;
        }
        if (this.windowClonesContainer) {
            this.windowClonesContainer.destroy();
            this.windowClonesContainer = null;
        }
        this.bgClone = new UnpickableClone({ source: Main.layoutManager._backgroundGroup });
        this.windowClonesContainer = new UnpickableActor();
        if (this.cloneContainer) {
            this.cloneContainer.add_child(this.windowClonesContainer);
        }
        else {
            this.container.add_child(this.windowClonesContainer);
        }
        this.container.insert_child_at_index(this.bgClone, 0);
        this._windowClones.clear();
        // クローン生成ロジックの重複を排除し、sync() に委譲
        this.sync();
    }
    // Shifts the entire clone subtree within the full-screen FBO.
    //
    // [CHANGED] In the new full-screen FBO architecture, the caller (dockManager)
    // passes (-monitor.x, -monitor.y) instead of the old (-bgX, -bgY).
    //
    // Rationale: clones are placed at their absolute screen coordinates (w.x, w.y).
    // blurBox/liquidBox start at (0,0) inside bgActor which is positioned at
    // (monitor.x, monitor.y).  Offsetting the container by (-monitor.x, -monitor.y)
    // makes each clone's net screen position:
    //   monitor.x + 0 + (-monitor.x + w.x) = w.x  ✓
    setOffset(x, y) {
        this.windowClonesContainer?.set_position(x, y);
        this.bgClone?.set_position(x, y);
    }
    sync() {
        let windows = global.get_window_actors();
        let activeWindows = new Set();
        let zIndex = 0;
        for (let w of windows) {
            let metaWindow = w.get_meta_window();
            if (!metaWindow || metaWindow.minimized || !w.visible)
                continue;
            // 【修正点】重い行列計算(get_transformed_position)をやめ、プロパティを直接取得
            let width = w.width;
            let height = w.height;
            if (width <= 0 || height <= 0)
                continue;
            activeWindows.add(w);
            let clone;
            if (!this._windowClones.has(w)) {
                clone = new UnpickableClone({ source: w });
                this.windowClonesContainer?.add_child(clone);
                this._windowClones.set(w, clone);
            }
            else {
                clone = this._windowClones.get(w);
            }
            clone.remove_transition('position');
            clone.remove_transition('size');
            // 【修正点】直接 x, y をコピー
            clone.set_position(w.x, w.y);
            clone.set_size(width, height);
            clone.remove_transition('scale-x');
            clone.remove_transition('scale-y');
            clone.set_scale(w.scale_x, w.scale_y);
            // 【修正点】translationも直接コピーし、アニメーションの補間を即座に反映させる
            clone.translation_x = w.translation_x;
            clone.translation_y = w.translation_y;
            let pX = w.pivot_point ? w.pivot_point.x : 0;
            let pY = w.pivot_point ? w.pivot_point.y : 0;
            clone.set_pivot_point(pX, pY);
            this.windowClonesContainer?.set_child_at_index(clone, zIndex);
            zIndex++;
        }
        // 使われなくなったクローン（閉じたウィンドウ、またはOverview起動時の全ウィンドウ）を削除
        for (let [w, clone] of this._windowClones.entries()) {
            if (!activeWindows.has(w)) {
                clone.destroy();
                this._windowClones.delete(w);
            }
        }
    }
    destroy() {
        if (this.windowClonesContainer) {
            this.windowClonesContainer.destroy();
            this.windowClonesContainer = null;
        }
        this._windowClones.clear();
        if (this.bgClone) {
            this.bgClone.destroy();
            this.bgClone = null;
        }
        this.container = null;
    }
}
// Custom shader effect class for the pass-through shader.
export const PassThroughEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassPassThroughEffect',
}, class PassThroughEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
        super._init(params);
        // 入力テクスチャを1:1でそのまま出力するだけのパススルーシェーダー
        this.set_shader_source(`
      uniform sampler2D tex;
      void main() {
        cogl_color_out = texture2D(tex, cogl_tex_coord_in[0].st);
      }
    `);
    }
});
