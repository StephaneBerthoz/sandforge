## 設定を調整

SandForge の設定は 2 か所にあります。

- **設定を開く** は SandForge のページを開きます。パネルの表示言語と、任意の AI アシスタント（Anthropic の Claude を使用）を設定できます。
- **VS Code で SandForge の設定を開く** は、SandForge で絞り込んだエディターの設定を開きます。Seed と Sync の既定のバッチサイズ、各実行とともに監査ログ（レポート、`sandforge.safety.auditLogging`）に残る Production Guard の判定の記録、そして Forge が大きなグラフをどう表示するか — 25 オブジェクトまではグラフとして描き、それを超えるとテーブルに一覧表示、または 150 オブジェクトまではどちらか一方で、それを超える場合と組織全体のクローンではテーブル（`sandforge.forge.graphView`）。

[設定を開く](command:sandforge.openSettings)

[VS Code で SandForge の設定を開く](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> Forge、Frozen Dataset の読み込み、チェックポイント、Compare のデプロイは本番組織を拒否します。本番組織では削除も拒否されます。それ以外の書き込みはすべて事前に確認され、この確認を無効にする設定はありません。実データを保持する Sandbox（フルコピー、受け入れテスト用）：組織 ページでその **編集** ダイアログを開き、**ステージング** にチェックを入れると、Production Guard はすべての削除、すべてのデプロイ、10,000 件を超えるすべての書き込みの前に確認します。
