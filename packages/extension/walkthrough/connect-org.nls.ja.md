## 最初の組織に接続

SandForge は、認証済みの Salesforce 組織の上で動作します。以下のどちらの方法でも、[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)（`sf`）がインストールされ、PATH に含まれている必要があります。ブラウザでのログインも CLI が実行します。

1. **Salesforce CLI からインポート** をクリックすると、Salesforce CLI で認証済みの組織をまとめて取り込めます — 最も速い方法です。
2. または **ブラウザでログイン** をクリックし、Salesforce のログインページから組織に接続します。

接続すると、各組織は別名・種別バッジ（PROD、Developer Edition なら DEVELOPER、SCRATCH、または Sandbox の種類 DEV・DEV PRO・PARTIAL・FULL）・状態を備えたカードとして表示されます。

[組織を開く](command:sandforge.openOrgs)

> Sandbox、スクラッチ組織、Developer Edition 組織はそのまま利用できます。Forge、Frozen Dataset の読み込み、チェックポイント、Compare のデプロイは本番組織を拒否します。本番組織では削除も拒否されます。それ以外の書き込みはすべて事前に確認され、この確認を無効にする設定はありません。実データを保持する Sandbox（フルコピー、受け入れテスト用）：組織 ページでその **編集** ダイアログを開き、**ステージング** にチェックを入れると、Production Guard はすべての削除、すべてのデプロイ、10,000 件を超えるすべての書き込みの前に確認します。
