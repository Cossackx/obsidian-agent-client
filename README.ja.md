<h1 align="center">Agent Client Plugin for Obsidian</h1>

<p align="center">
  <img src="https://img.shields.io/github/downloads/RAIT-09/obsidian-agent-client/total" alt="GitHub Downloads">
  <img src="https://img.shields.io/github/license/RAIT-09/obsidian-agent-client" alt="License">
  <img src="https://img.shields.io/github/v/release/RAIT-09/obsidian-agent-client" alt="GitHub release">
  <img src="https://img.shields.io/github/last-commit/RAIT-09/obsidian-agent-client" alt="GitHub last commit">
  <a href="https://github.com/RAIT-09/obsidian-agent-client/discussions"><img src="https://img.shields.io/github/discussions/RAIT-09/obsidian-agent-client" alt="GitHub Discussions"></a>
</p>

<p align="center">
  <a href="README.md">English is here</a>
</p>

<p align="center">
  <a href="https://community.obsidian.md/plugins/agent-client" target="_blank"><img src="https://img.shields.io/badge/Add%20to%20Obsidian-7c3aed?logo=obsidian&logoColor=white&style=for-the-badge" alt="Add to Obsidian"></a>
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/rait09" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="180" height="50" ></a>
</p>

Claude Code、Codex、Gemini CLI をはじめとする ACP エージェントと、Obsidian の中でそのままチャット。`@` でノートをメンションすれば、エージェントが Vault のノートを直接読み書きします。コピペは不要です。

MCP サーバー、Agent Skills、スラッシュコマンド、権限プロンプト — エージェントができることは、追加設定なしでそのまま動きます。

Zed の [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol/agent-client-protocol) の上に構築されています。

**このフォークの開発版:** [Note Companion](docs/usage/note-companion.md) ではノートや選択範囲の送信内容を確認でき、回答を差分の確認後にノートへ反映できます。書き込み結果の照合、注釈付きレビュー、出典付きの統合、ノートに関連する会話の再開にも対応します。マニフェストは `0.13.2` のままです。上流のバッジやインストール手順は Note Companion のリリースを示すものではありません。

![ノートの隣のサイドバーでエージェントとチャット](https://raw.githubusercontent.com/RAIT-09/obsidian-agent-client/master/docs/public/images/readme-hero-sidebar.webp)

## Vault をエージェントのフロントエンドに

**並べて使う。** 複数のエージェントを同時に実行できます — サイドバータブ、エディタタブ、フローティングウィンドウで、それぞれが独立したセッションとモデルを持ちます。全ビューへのプロンプト一斉送信や、ホットキーでのフォーカス巡回も。

![エディタタブで3つのエージェントを並列実行](https://raw.githubusercontent.com/RAIT-09/obsidian-agent-client/master/docs/public/images/readme-multi-session.webp)

**どのフォルダでも。** 「New chat in directory」でチャットを任意のディレクトリに向けられます — コードプロジェクトでも、執筆プロジェクトでも、エージェントが普段働いている場所ならどこでも。エージェントはそのフォルダの context file やプロジェクト設定を読み込み、Vault のノートは `@` メンションで渡せます。

**ノートの中に。** コードブロックでノートに直接チャットを埋め込めます — エージェントを固定したり、`persist` で会話を再起動後も引き継いだり。用意したプロンプトをワンクリックで送るエージェントボタンも置けます。

**管制室。** Session Manager が、サイドバー・タブ・フローティング・ノート内に開いている全会話をステータスアイコン付きで一覧します（権限待ちも見えます）。クリックでその場へジャンプ。

**どの ACP エージェントでも。** 11のプリセット — Claude Code、Codex、Gemini CLI、Mistral Vibe、OpenCode、Kiro、Hermes Agent、Pi、Grok Build、IBM Bob、Antigravity CLI — に加えて、ACP 互換エージェントならカスタムエージェントとして追加できます。明日新しいエージェントが ACP 対応しても、カスタムエージェントに登録するだけ — プラグインの更新を待つ必要はありません。

## 機能

- **ノートメンション**: `@` でノートを参照 — 名前・パス・エイリアスをファジー検索。アクティブノートは選択した行の範囲まで含めて自動メンション
- **Obsidian に馴染む回答**: `[[wikilink]]`・`$LaTeX$`・整った Markdown テーブルで回答するようエージェントに指示（設定可）
- **Wikilink コンテキスト**: メンションしたノート内の `[[リンク]]` をパスとして提示し、どれを読むかはエージェントが判断
- **MCP & スキル**: エージェントに設定済みの MCP サーバーやスキルがそのまま動作 — プラグイン側の設定は不要
- **スラッシュコマンド**: エージェントの `/` コマンドを引数ヒント付きで
- **画像・ファイル添付**: チャットにペーストまたはドラッグ&ドロップ
- **モード・モデル・設定の切り替え**: 入力ツールバーからセッション中に変更。コンテキスト使用量インジケーター付き
- **編集の可視化**: ノートの編集は単語レベルの diff としてチャットに表示 — 何が変わったかが正確にわかります
- **権限プロンプト**: エージェントの操作をバナーまたはホットキーで承認・拒否。自動許可はオプトイン
- **セッション履歴**: 会話はローカルに保存 — 過去のセッションを再開・フォーク（エージェントの対応による）
- **チャットエクスポート**: 会話を frontmatter 付きの Markdown ノートとして保存（手動・自動）
- **ターミナル統合**: エージェントのコマンド実行をライブ出力でチャットに表示
- **フローティングチャット**: ワークスペースから独立したドラッグ可能なチャットウィンドウ — サイズと位置を記憶します
- **WSL モード**: Windows で WSL 内のエージェントを実行

## インストール

1. **設定 → コミュニティプラグイン → 閲覧** を開く
2. **「Agent Client」** を検索
3. **インストール** → **有効化** をクリック

## はじめる

1. 使いたいエージェントをセットアップガイドに従ってインストール・認証します:

   [Claude Code](https://rait-09.github.io/obsidian-agent-client/agent-setup/claude-code.html) · [Codex](https://rait-09.github.io/obsidian-agent-client/agent-setup/codex.html) · [Gemini CLI](https://rait-09.github.io/obsidian-agent-client/agent-setup/gemini-cli.html) · [Mistral Vibe](https://rait-09.github.io/obsidian-agent-client/agent-setup/mistral-vibe.html) · [OpenCode](https://rait-09.github.io/obsidian-agent-client/agent-setup/opencode.html) · [Kiro](https://rait-09.github.io/obsidian-agent-client/agent-setup/kiro.html) · [Hermes Agent](https://rait-09.github.io/obsidian-agent-client/agent-setup/hermes.html) · [Pi](https://rait-09.github.io/obsidian-agent-client/agent-setup/pi.html) · [Grok Build](https://rait-09.github.io/obsidian-agent-client/agent-setup/grok-build.html) · [IBM Bob](https://rait-09.github.io/obsidian-agent-client/agent-setup/bob.html) · [Antigravity CLI](https://rait-09.github.io/obsidian-agent-client/agent-setup/antigravity-cli.html) · [カスタムエージェント](https://rait-09.github.io/obsidian-agent-client/agent-setup/custom-agents.html)

2. **設定 → Agent Client** でエージェントのパスを確認します — **Auto-detect** でほとんどの場合見つかります
3. リボンのロボットアイコンをクリックしてチャット開始

このフォークの開発ビルドでは **Note companion** を開き、**Add selection** または **Add open note** を選びます。**Preview next send** で送信する内容を確認できます。詳しくは [使い方ガイド（英語）](docs/usage/note-companion.md) を参照してください。

**[ドキュメント全文](https://rait-09.github.io/obsidian-agent-client/)**

## セキュリティと権限

Agent Client はデスクトップ専用です。ローカルのエージェントを子プロセスとして起動し、ACP のターミナル要求に対応します。Note Companion は Obsidian の Vault API を使い、ACP のテキストファイル読み書き機能は公開しません。

ツールがアクセスできる範囲はプロセスや設定、OS の権限で決まり、トレイで選んだ範囲には制限されません。プラグインが表示するのはエージェントが送信した権限要求です。**Auto-allow permissions**（既定はオフ）は選択肢に「今回のみ許可」がある場合にそれを選びます。送信プレビューや **Apply this change** はツール操作の許可とは別です。

プラグインが管理する API キーは Obsidian の Keychain に保存されます。プレビューで確認できるのはプラグインからエージェントへ送る内容であり、エージェントやツール、プロバイダーが読み取り、送信し、保存するすべての内容ではありません。

## その他のインストール方法

### BRAT経由（プレリリース版）

コミュニティプラグインに公開される前のプレリリース版を試すには:

1. [BRAT](https://github.com/TfTHacker/obsidian42-brat) プラグインをインストール
2. **設定 → BRAT → Add Beta Plugin** に移動
3. 貼り付け: `https://github.com/RAIT-09/obsidian-agent-client`
4. プラグインリストから **Agent Client** を有効化

### 手動インストール

1. [リリース](https://github.com/RAIT-09/obsidian-agent-client/releases)から `main.js`、`manifest.json`、`styles.css` をダウンロード
2. `VaultFolder/.obsidian/plugins/agent-client/` に配置
3. **設定 → コミュニティプラグイン** でプラグインを有効化

## 開発

```bash
npm install
npm run dev
```

プロダクションビルド:
```bash
npm run build
```

## ライセンス

Apache License 2.0 - 詳細は [LICENSE](https://github.com/RAIT-09/obsidian-agent-client/blob/master/LICENSE) を参照。

## コントリビューター

コントリビュートしてくださった皆さんに感謝します！

<a href="https://github.com/RAIT-09/obsidian-agent-client/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=RAIT-09/obsidian-agent-client" alt="Contributors" />
</a>
