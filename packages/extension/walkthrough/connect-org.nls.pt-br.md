## Conecte sua primeira org

O SandForge trabalha sobre as suas orgs do Salesforce já autenticadas. Os dois caminhos abaixo exigem a [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) instalada e no seu PATH: o login pelo navegador também é executado pela CLI.

1. Clique em **Importar da Salesforce CLI** para trazer todas as orgs já autenticadas na Salesforce CLI — o caminho mais rápido.
2. Ou clique em **Entrar pelo navegador** para conectar uma org pela página de login do Salesforce.

Depois de conectada, cada org aparece como um cartão com o alias, o selo de tipo (PROD, DEVELOPER para uma Developer Edition, SCRATCH ou o tipo de uma sandbox: DEV, DEV PRO, PARTIAL, FULL) e o status.

[Abrir Organizações](command:sandforge.openOrgs)

> Sandboxes, scratch orgs e orgs Developer Edition funcionam de imediato. O Forge, as cargas do Frozen Dataset, os pontos de verificação e a implantação do Compare recusam uma org de produção; as exclusões também são recusadas lá; qualquer outra gravação lá pergunta antes, e nenhuma configuração desativa isso. Uma sandbox com dados reais (cópia completa, homologação): abra a caixa **Editar** dela na página Organizações e marque **Staging**; o Production Guard passa a perguntar antes de cada exclusão, cada implantação e cada gravação de mais de 10.000 registros.
