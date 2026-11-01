## Ajustez vos paramètres

SandForge range ses paramètres à deux endroits :

- **Ouvrir les paramètres** ouvre la page de SandForge : la langue de ses panneaux, et l'assistant IA optionnel, propulsé par Anthropic (Claude).
- **Ouvrir les paramètres de SandForge dans VS Code** ouvre les paramètres de l'éditeur, filtrés sur SandForge : les tailles de lots par défaut de Seed et de Sync, la trace des décisions de Production Guard gardée avec chaque exécution dans le journal d’audit (Rapports, `sandforge.safety.auditLogging`), et la façon dont Forge montre un grand graphe — dessiné jusqu'à 25 objets et listé dans un tableau au-delà, ou toujours d'une seule façon (`sandforge.forge.graphView`).

[Ouvrir les paramètres](command:sandforge.openSettings)

[Ouvrir les paramètres de SandForge dans VS Code](command:workbench.action.openSettings?%5B%22%40ext%3AStephaneBerthoz.sandforge%22%5D)

> Forge, les chargements Frozen Dataset, les points de contrôle et le déploiement de Compare refusent une org de production ; les suppressions y sont refusées aussi ; toute autre écriture y demande d'abord, et aucun paramètre ne lève cette question. Une sandbox qui contient des données réelles (copie complète, recette) : ouvrez sa boîte **Modifier** sur la page Organisations et cochez **Préproduction** ; Production Guard demande alors avant chaque suppression, chaque déploiement et chaque écriture de plus de 10 000 enregistrements.
