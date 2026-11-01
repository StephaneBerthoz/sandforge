## Conecte su primera org

SandForge se apoya en sus orgs de Salesforce ya autenticadas. Ambas vías de abajo necesitan la [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) instalada y en su PATH: el inicio de sesión por navegador también lo ejecuta la CLI.

1. Haga clic en **Importar desde la Salesforce CLI** para incorporar todas las orgs ya autenticadas en la Salesforce CLI: la vía más rápida.
2. O haga clic en **Iniciar sesión en el navegador** para conectar una org desde la página de inicio de sesión de Salesforce.

Una vez conectada, cada org aparece como una tarjeta con su alias, su distintivo de tipo (PROD, DEVELOPER para una Developer Edition, SCRATCH o el tipo de un sandbox: DEV, DEV PRO, PARTIAL, FULL) y su estado.

[Abrir Organizaciones](command:sandforge.openOrgs)

> Los sandboxes, las scratch orgs y las orgs Developer Edition funcionan de inmediato. Forge, las cargas de Frozen Dataset, los puntos de control y el despliegue de Compare rechazan una org de producción; allí también se rechazan las eliminaciones; cualquier otra escritura allí pregunta antes, y ningún ajuste lo desactiva. Un sandbox con datos reales (copia completa, pruebas de aceptación): abra su diálogo **Editar** en la página Organizaciones y marque **Staging**; Production Guard pregunta entonces antes de cada eliminación, cada despliegue y cada escritura de más de 10.000 registros.
