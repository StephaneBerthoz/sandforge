## Conecte sua primeira org

O SandForge trabalha sobre as suas orgs do Salesforce já autenticadas. Os dois caminhos abaixo exigem a [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) instalada e no seu PATH: o login pelo navegador também é executado pela CLI.

1. Clique em **Importar do SF CLI** para trazer todas as orgs já autenticadas na Salesforce CLI — o caminho mais rápido.
2. Ou use **OAuth (Web)** para conectar uma org pelo navegador.

Depois de conectada, cada org aparece como um cartão com o alias, o selo de tipo (PROD/SBX) e o status.

[Abrir Organizações](command:sandforge.openOrgs)

> Sandboxes, scratch orgs e orgs Developer Edition funcionam de imediato. O Forge nunca grava em uma org de produção; os outros módulos perguntam antes de gravar nela e nunca excluem nada lá.
