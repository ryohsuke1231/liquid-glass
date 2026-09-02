# GNOME Shell Extension Development Guidelines

## 開発環境
- GNOME 50 / Clutter 18 環境向けの TypeScript 拡張機能開発。
- メインのソースコードやビルド設定は `liquid-glass@thinkingcoding1231.gmail.com/` 配下にあります。

## コマンド実行ルール
- `npm` やビルド関連のコマンドを実行する際は、`liquid-glass@thinkingcoding1231.gmail.com` ディレクトリ内で実行すること。（例: `cd liquid-glass@thinkingcoding1231.gmail.com && npm run build`）
- TSファイルを修正・編集した後は、`npm run build` を実行してビルドエラーが出ないかチェックすること。

## タスクの進め方
1. 原因の分析を行う。
2. 原因が確定した場合: コードを直接編集・修正し、そのまま `npm run build` を実行してビルドを確認する。
3. 原因が仮説段階の場合: テスト用スクリプト作成、または検証用ログを仕込む。
4. 状況が明確でない場合: ユーザーに質問する。

## Looking Glass スクリプト作成ルール
- `Clutter` や `Cogl` などを明示的にインポートしない。
- トップレベルのベタ書きスタイルで記述すること。
