## 最初の組織に接続

SandForge は、認証済みの Salesforce 組織の上で動作します。以下のどちらの方法でも、[Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)（`sf`）がインストールされ、PATH に含まれている必要があります。ブラウザーでのログインも CLI が実行します。

1. **SF CLIからインポート** をクリックすると、Salesforce CLI で認証済みの組織をまとめて取り込めます — 最も速い方法です。
2. または **OAuth（Web）** を使い、ブラウザ経由で組織に接続します。

接続すると、各組織は別名・種別バッジ（PROD/SBX）・状態を備えたカードとして表示されます。

[組織を開く](command:sandforge.openOrgs)

> サンドボックス、スクラッチ組織、Developer Edition 組織はそのまま利用できます。Forge は本番組織に書き込みません。その他のモジュールは本番組織に書き込む前に確認し、そこでは削除を行いません。
