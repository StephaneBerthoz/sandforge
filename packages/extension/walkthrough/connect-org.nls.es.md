## Conecte su primera org

SandForge se apoya en sus orgs de Salesforce ya autenticadas. Ambas vías de abajo necesitan la [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) instalada y en su PATH: el inicio de sesión por navegador también lo ejecuta la CLI.

1. Haga clic en **Importar desde SF CLI** para incorporar todas las orgs ya autenticadas en la Salesforce CLI: la vía más rápida.
2. O use **OAuth (Web)** para conectar una org desde su navegador.

Una vez conectada, cada org aparece como una tarjeta con su alias, su distintivo de tipo (PROD, DEVELOPER para una Developer Edition, SCRATCH o el tipo de un sandbox: DEV, DEV PRO, PARTIAL, FULL) y su estado.

[Abrir Organizaciones](command:sandforge.openOrgs)

> Los sandboxes, las scratch orgs y las orgs Developer Edition funcionan de inmediato. Forge nunca escribe en una org de producción; los demás módulos preguntan antes de escribir en ella y nunca eliminan nada allí.
