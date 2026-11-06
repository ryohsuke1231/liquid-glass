# GNOME Shell Extension Development Guidelines

## 返答の言語
- ユーザーへの返答・途中経過・最終報告は、常に日本語で書く。ツールの出力やコードが英語でも、長い作業の後の最終報告でも同じ。
- 最終報告を書く前に、毎回 yomiyasu スキル（Skill ツールで `yomiyasu`）を読み込み、その決まりに沿って読みやすい日本語に整える。ユーザーに言われなくても毎回行う。

## 開発環境
- GNOME 50 / Clutter 18 環境向けの TypeScript 拡張機能開発。
- メインのソースコードやビルド設定は `liquid-glass@thinkingcoding1231.gmail.com/` 配下にあります。
- 基本的には`dev`ブランチで作業してください。コード編集などを行う際は`dev`ブランチにいることを確認してください。

## プロンプトの短縮形
ユーザーのプロンプトに次の短縮形が含まれていたら、それに従う。指定がない項目は (default) の挙動にする。
ただし、プロンプト中の自然言語による指示のほうが短縮形・既定値より優先される。
- `git:c` — コミットのみ。merge・push はしない (default)
- `git:cmp` — commit・merge・push する
- `git:cm` — commit・merge する。push はしない
- `git:mp` — 新たなコミットはせず、これまでのコミットを merge・push する
- `do:all` — 与えられたタスクをすべて一度にやる (default)
- `do:step` — step by step で進める（1 ターンですべてはやらず、区切りごとにユーザーに確認する）
- `mode:plan` — 原因分析や実装計画立てのみ行い、コード編集はしない
- `mode:auto` — 原因分析からコード編集まですべて行う (default)

## コマンド実行ルール
- `npm` やビルド関連のコマンドを実行する際は、`liquid-glass@thinkingcoding1231.gmail.com` ディレクトリ内で実行すること。（例: `cd liquid-glass@thinkingcoding1231.gmail.com && npm run build`）
- TSファイルを修正・編集した後は、`npm run build` を実行してビルドエラーが出ないかチェックすること。
- `npm run build:dev` は開発者専用の「Tune Defaults」ウィンドウ（`tools/dev-tune/`）を付けてビルドする。通常の `npm run build`・`npm run pack` は外した状態に戻す。`prefs.js` が差分に出ている間は付いている状態なので、コミットに含めない。

## ファイル読み取りの許可
- `memo.md`: 今まで踏んだ地雷や罠、教訓などを示したMarkdownファイル。読み取りや書き込みを自由に許可します。
- ローカルにある、GNOME関連のソースコードなど: バグ原因特定などで必要ならば許可を取らずに自由に読んでください。

## タスクの進め方
1. 原因の分析を行う。
2. 原因が確定した場合: コードを直接編集・修正し、そのまま `npm run build` を実行してビルドを確認する。
3. 原因が仮説段階の場合: テスト用スクリプト作成、または検証用ログを仕込む。
4. 状況が明確でない場合: ユーザーに質問する。
- 作業中に不明点や、ユーザーが決めるべき判断（機能を消すか残すか、対応バージョン、挙動が変わる修正など）が出てきたら、推測で押し通さずに質問すること。

## README.md の更新
- コードを編集したら、その変更で `README.md` の記述が古くならないか確認し、必要なら同じ作業の中で更新する。
  - 機能の追加・削除・名前変更 → Features や設定の説明、スクリーンショットの注記など該当箇所。
  - 対応 GNOME バージョン（`metadata.json` の `shell-version`）の変更 → 対応バージョンの記述。
  - 設定項目（GSettings スキーマ・設定画面）の追加・削除・既定値の変更 → 設定の説明。
- Roadmap セクションは `### Done`（`- [x]`）と `### Next`（`- [ ]`）で管理する。
  Next の項目を終えたら Done に移し、まとまった新機能や対応を入れたら Done に 1 行追加する。
  Next に新しい予定を足す・消すときはユーザーに確認する。
- バグ修正やリファクタリングなど、README の記述に影響しない変更では README を触らない。
- README は英語で書き、既存の文体・粒度に合わせる。

## コメントの書き方
extensions.gnome.org (EGO) のレビューでは「AI 生成らしさ」が却下理由になるため、コード内コメントは次のとおりに書く。
- 英語で書く（`src/`・`extension.js`・`preferences/`・`shaders/`・`stylesheet.css` すべて）。
- 「なぜそうするか」を短く（基本は 1〜3 行）書く。コードを読めばわかる「何をしているか」の逐語訳や、
  構文の説明は書かない。名前で伝わるならコメントを書かない。
- `[FIX]`・`[FIX round 12]`・`[FIX-5]`・`[PERF B1]`・`[DIAG]`・`[NEW]`・`[CHANGED]` などのタグを付けない。
- 変更の経緯（「以前は〜だった」「This used to…」「round N で〜」）は書かない。経緯はコミットメッセージと memo.md に書く。
- `memo.md`・`performance-plan.md`・`追記N`・`地雷N`・`①〜⑤` など、リポジトリに無い資料や内部の番号を参照しない。
- `IMPORTANT:`・`CRITICAL:`・`NOTE:`・`DO NOT …` のような、LLM への指示に見える書き方をしない。強調のための全大文字も避ける。
- 装飾的な区切り線（`// ─── Section ───`・`/* ===== */`）や絵文字を使わない。
- 1 行は 200 文字以内（EGO のベストプラクティス）。

## 指示がなくても毎回やる整理
コメントとコードの整理は、ユーザーに頼まれるのを待たずに、すべてのタスクで行う。
- 自分が書いた・触ったコードは、コミットの前に `git diff` を読み直し、「コメントの書き方」と「EGO 提出用コードのルール」に
  合っているか確かめて、合わないところを同じタスクの中で直す。
- 触ったファイルの中で、すでにある違反（逐語訳のコメント、経緯の説明、例外を投げない API を囲む try-catch、
  確実にある API への `?.`・`typeof` チェック、使っていない変数や import、ライフサイクル用のフラグなど）に気づいたら、
  その場で直す。直したものは最終報告に一言書く。
- 挙動が変わる整理（機能の削除、エラー処理の方針の変更など）は勝手にせず、ユーザーに確認する。

## EGO 提出用コードのルール
- `destroy()`・`disconnect()`・`GLib.Source.remove()` など、通常は例外を投げない API を try-catch で囲まない。
  try-catch は GError を投げる API（ファイル読み込み、D-Bus、JSON.parse など）にだけ使う。
  例外は毎フレーム回るループで、1 つの失敗が他を止めないよう catch して `reportFrameLoopError()`（5 秒に 1 回に間引き）に渡す。
- GNOME 50 に確実に存在する API を `typeof x.foo === 'function'`・`x.foo?.()`・`if (x.foo)` で確認しない。
- `_destroyed`・`_active` のようなライフサイクルのガード用フラグを作らない。後始末はソースの削除とシグナルの切断で完結させる。
- `enable()` で作ったもの（`global` に置いたオブジェクトも含む）は `disable()` で必ず消す。
- `this.getSettings()` は引数なしで呼ぶ（スキーマ ID は `metadata.json` の `settings-schema`）。
- ログは `output-logs` 設定でゲートした logger を通す。無条件の `console.log` は置かない。
- GNOME 公式の「GNOME Extension Best Practices」（gjs.guide の review-guidelines/best-practices）に従う。上の項目に加えて次を守る。
  - 自前の `destroy()` は「タイマーと GLib ソースの削除 → シグナルの切断 → 子や資源の解放 → 最後に `super.destroy()`」の順にする。
    破棄したインスタンスは null にして二度と使わない。
  - タイマーを作り直しうる関数では、作成の直前の行で古いソースを消す（消す処理を離れた場所や別関数だけに置かない）。
  - シグナル・タイマー・`Gio.Cancellable`・Soup セッションは、作ったクラス自身が後始末する。作るクラスと消すクラスを分けない。
  - エントリーポイント（`extension.js`）は小さく保つ。機能ごとの処理は `src/` のクラスに分け、`enable()` と `disable()` は隣に置いて
    作成と後始末だけを並べる。必要のないメソッドの別名を作らない。1 ファイルに詰め込まず、責務ごとのモジュールに分ける。
  - `extension.js` と `prefs.js` の両方から読む共有モジュールでは `St`・`Clutter`・`Gtk`・`Gdk`・`Adw` を読み込まない。
    設定画面だけで使うモジュールは `preferences/` に置く。
  - 同じ処理を貼り付けて増やさず、ヘルパー関数にまとめる。
  - アイコンはシェルでは `St.Icon`（`icon_name`）、設定画面では `Gtk.Image` を使う。絵文字をアイコン代わりにしない。
    進み具合は文字（`█░░`）ではなくシェルの部品（`BarLevel` など）で表す。
  - シェルのコマンドを外部プロセスで起動しない。システムのサービスとは D-Bus で話す。重い処理は別プロセスに任せる（このリポジトリでは
    `src/workers/` の gjs ワーカー）。
  - 中身のない `enable()`・`disable()` や、作りかけの機能を残さない。
  - 文書にある「Generated with AI for personal use…」の注記コメントは書かない（作者の判断による）。
- 提出用 zip は `npm run pack`（`liquid-glass@thinkingcoding1231.gmail.com` 内で実行）で作る。TS ソース・`gschemas.compiled`・
  未使用のアイコンは含めない。作ったら `shexli <zip の絶対パス>` で確認する
  （shexli は tree-sitter 0.26 と組み合わせるとセグフォルトするので、`uv tool install --python 3.12 shexli --with 'tree-sitter==0.25.2'` で入れる）。

## 古い GNOME（46〜49）・51 での確認
- 対応版は `metadata.json` の `shell-version`（46〜51）。版による API の違いは `src/shellVersion.ts` に `SHELL_MAJOR` で分けてまとめる。
  ほかのファイルに版の分岐を散らさない。分岐を足したら `tests/shell-version.test.cjs` にも足す。
- 各版の GNOME Shell は distrobox `gnome46`〜`gnome49`・`gnome51`（home は `~/gnomeNN-home`）に入っている。作り直しは `tools/gnome-versions/setup.sh NN`。
  46 = Ubuntu 24.04（mutter 46.2）、47 = Fedora 41、48 = Debian 13、49 = Fedora 43、51 = Fedora 45。50 はホスト。
- 上流のソース（mutter・gnome-shell・gjs の各版のタグ）は `~/clones/gnome-src/` にある（例: `gnome-shell-46.10/`、`mutter-46.9/`）。
  ただし 46 の利用者の多くは Ubuntu 24.04 の mutter 46.2 で、上流の最新の点リリースとは挙動が違うことがある。ソースの照合だけで判断せず、ボックスで動かして確かめる。
- 自動テスト（headless）: `npm run build` のあと、
  `distrobox enter gnomeNN -- env LG_DTD_DIR=$HOME/.local/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com LG_DRV_SCENARIO=<ui|dock|toggles|lifecycle|window> LG_SHELL_TIMEOUT=150 $PWD/tools/backdrop-spike/run-glass.sh ~/gnomeNN-home/lgtest/<シナリオ>`
  （リポジトリのルートで実行）。`shell.log` の `[drv] ... audit ... OK/NG` と `JS ERROR` を見る。46〜48 は `LG_X11=1` で X11 セッションも回せる。
  監査は背面の追従しか見ないので、レイアウトの崩れは `shots/*.png` を版どうし・変更前後で見比べて確かめる。ホスト（50）では `distrobox enter` なしで同じスクリプトを回す。
- 200 % 表示の確認: `LG_DRV_SCENARIO=features LG_DRV_FEATURES=scale LG_SPIKE_MONITOR=2256x1504 LG_MONITORS_XML=$PWD/tools/backdrop-spike/monitors-200.xml` を足して回す
  （論理 1128x752 の画面）。メニューが画面に収まるか・ランチャーがデスクトップウィジェットと重ならないかが `[drv] scale:` の行に出る。
  `LG_DRV_LIGHT=1` で明るいシェルテーマ、`LG_DRV_LIGHT=default` で GNOME 設定の「デフォルト」（シェルは暗いまま）。ランチャーのピン留めページと検索結果の収まりは `LG_DRV_FEATURES=launcherlayout`（`LG_SPIKE_MONITOR=1920x1080 LG_MONITORS_XML=$PWD/tools/backdrop-spike/monitors-200-small.xml` で論理 960x540 の画面）。UI のサイズや余白に触れた変更は、このシナリオも回して `shots/*.png` を見る。
- 目で見る確認（入れ子のシェル）: `tools/gnome-versions/run.sh NN`（alias `gnome46` など。`--pack` で zip を作り直してから起動）。ログは `~/gnomeNN-home/gNN.log`。
- シェルが落ちたら `coredumpctl` で core を取り、ボックスの中の gdb ＋ debuginfod でバックトレースを見る（Fedora のボックス）。
- 調べた版の違いと地雷は memo.md の追記40・追記41 にある。

## Looking Glass スクリプト作成ルール
- `Clutter` や `Cogl` などを明示的にインポートしない。`imports.gi`でインポートもしない。`Clutter`のように、最初からそのまま使う。
- トップレベルのベタ書きスタイルで記述すること。
- **結果は必ず最後に `log()` で出力すること。** 末尾に `<変数名>;` と書くだけでは不可
  （Looking Glass の結果欄には出ても journal には残らず、あとから追えないため）。
  複数行にまとめるときは `log([...].join('\n'))` のように 1 回の `log()` にする。
- **必ず「1行版」も併せて作成すること。** 改行なしでそのまま Looking Glass の
  入力欄に貼れる形。コメント・整形・余分な変数は削り、複数文は `;` で繋ぐ。
  複数行版（読む用）と 1行版（貼る用）の両方を必ず提示する。ファイルとして保存する必要はなく、チャット内で示すこと。

## その他
- ユーザーが示した観察を、その時点でうまく説明することができなくても、それをユーザーの視覚的な誤解として扱わない。
