## Connectez votre première org

SandForge s'appuie sur vos orgs Salesforce déjà authentifiées. Les deux chemins ci-dessous nécessitent la [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) installée et présente dans votre PATH : la connexion par navigateur est elle aussi exécutée par la CLI.

1. Cliquez sur **Importer depuis la Salesforce CLI** pour récupérer toutes les orgs déjà authentifiées dans la Salesforce CLI — le chemin le plus rapide.
2. Ou cliquez sur **Se connecter dans le navigateur** pour connecter une org depuis la page de connexion de Salesforce.

Une fois connectée, chaque org apparaît sous forme de carte, avec son alias, son badge de type (PROD, DEVELOPER pour une Developer Edition, SCRATCH, ou le type d'une sandbox : DEV, DEV PRO, PARTIAL, FULL) et son statut.

[Ouvrir les organisations](command:sandforge.openOrgs)

> Les sandboxes, les scratch orgs et les orgs Developer Edition fonctionnent immédiatement. Forge, les chargements Frozen Dataset, les points de contrôle et le déploiement de Compare refusent une org de production ; les suppressions y sont refusées aussi ; toute autre écriture y demande d'abord, et aucun paramètre ne lève cette question. Une sandbox qui contient des données réelles (copie complète, recette) : ouvrez sa boîte **Modifier** sur la page Organisations et cochez **Préproduction** ; Production Guard demande alors avant chaque suppression, chaque déploiement et chaque écriture de plus de 10 000 enregistrements.
