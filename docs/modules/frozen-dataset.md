# Frozen Reference Dataset (jeu de référence figé)

Extraire **une fois** un jeu de données métier depuis une sandbox de recette, le **pseudonymiser de façon déterministe**, le figer (manifest + empreinte de sel), puis le **recharger à l'identique** après chaque refresh de sandbox dev, avec contrôle de non-réidentification avant versionnement et vérification post-chargement.

Cas d'usage : après un refresh de sandbox Developer (métadonnées mais zéro record), obtenir en une commande un jeu de dossiers réalistes couvrant les parcours fonctionnels, sans jamais embarquer de donnée identifiante.

## Démarrage rapide

1. Ouvrir **Frozen Dataset** depuis la sidebar (ou `SandForge: Open Frozen Dataset` dans la palette)
2. Onglet **Extraire** : renseigner l'objet racine, les axes de couverture et le budget, puis **Enregistrer la configuration**
3. Poser le sel : `export SANDFORGE_FROZEN_SALT="<secret-stable>"` (jamais dans le dépôt) et créer le fichier de règles de pseudonymisation
4. **Lancer la sélection** (matrice de couverture) puis **Lancer l'extraction**. Le contrôle 4 points doit être PASS pour que le jeu soit écrit
5. Onglet **Charger** : choisir la sandbox cible, option **Pilote** (1 dossier) pour un premier test, **Lancer le chargement**. La vérification post-chargement est chaînée automatiquement

## Flux d'extraction

1. **Sélection par matrice de couverture** (pas d'échantillon aléatoire) : chaque axe est une requête SOQL d'agrégat configurable ; le module énumère les **combinaisons observées** dans l'org source et retient **un dossier racine sain par combinaison** (graphe complet via le discovery Forge, pas de dossier boiteux), plus un par cas limite déclaré. Le budget de volumétrie (défaut 2 500 records) est **vérifié mécaniquement** : refus au-delà.
2. **Extraction scope-aware** : réutilise `RecordScopeCache` + `ScopedSoqlBuilder` (descendance complète + référentiel nécessaire, pas de `SELECT *`), avec une borne de date figée (`CreatedDate <= asOf`) et `rt-map.json` produit dans le sas.
3. **Pseudonymisation déterministe** : `HMAC-SHA256(sel, "générateur|valeur")` : la même valeur produit la même sortie quel que soit l'objet porteur, donc les jointures inter-objets survivent. `RecordTypeId` est remplacé par le **Name** du RecordType (résolution côté cible par **DeveloperName**, jamais par label).
4. **Contrôle de non-réidentification (gate)** : 4 points. Substitution effective (y compris fuite transversale dans un autre champ du même record), champs `clear` vides, formats conservés (SIV, E.164, email, CP généralisé), zéro Id source résiduel (checksum Salesforce 18 caractères). **Un FAIL = rien n'est écrit ni versionné.**
5. **Manifest** : version semver, `status: frozen`, source (org + date de décision), empreinte du sel (SHA-256, 12 hex, jamais le sel), version des règles, volumétrie (plafond + mesuré), résultats des contrôles.

## Flux de chargement (rejouable)

Gardes d'entrée (refus actionnables, jamais de DML sur la source) :

- **sandbox uniquement** (tier Production Guard) ;
- **environnements protégés** configurés refusés, ainsi que l'org source du manifest ;
- **callouts mockés** : détection par custom metadata (`mockDetection`) : quand elle n'est pas configurée, la garde est explicitement désactivée et signalée dans l'onglet ;
- **jeu vide** refusé.

Puis : alignement de schéma (champs absents retirés **en les listant**, picklists restreintes y compris écarts d'affectation par RecordType via l'UI API), **placeholders techniques** pour les lookups devenus requis (jamais d'exclusion silencieuse), insert en 2 passes (FK de cycle), **post-load PersonContact** (sidecar `referenceId → referenceId` résolu en updates ciblés), et persistance du mapping `referenceId → Id` dans le sas.

**Rechargement sans refresh** : clés d'identité par objet (ExternalId, nom, paires composites) pour réutiliser l'existant, purge des résidus **enfants avant parents**, objets indélétables **désactivés** (champ configuré). Les rejets anti-doublon natifs de la cible sont un mode dégradé explicite : records **ignorés et listés**.

**Pilote** : un seul dossier racine (~2 min) avant le chargement complet.

## Vérification post-chargement

Lecture seule, chaînée au chargement (ou relancée via **Re-vérifier**) : comptages par objet vs **contrat de comptage**, orphelins des lookups obligatoires, présence par clé (ExternalId), liens PersonContact restaurés. Robustesse : re-mesure jusqu'à **deux relevés identiques** avant verdict (`passed` / `failed` / `unstable`). Le verdict est consigné dans le manifest (`controls.dryRunLoad`).

## Configuration

Configuration par projet persistée par l'extension (clés principales) :

| Clé | Rôle |
|---|---|
| `rootObject` | Objet racine (« dossier ») |
| `axes` | Axes de couverture (`name`, `label`, `filterField`, `valuesSoql` agrégat avec alias `axisValue`) |
| `edgeCases` | Cas limites (`whereFragment`, marqueur en données) |
| `budgetMaxRecords` | Plafond de volumétrie (défaut 2 500) |
| `expectedObjects` | Objets exigés dans le graphe pour qu'un dossier soit sain |
| `excludedFields` | Champs exclus du SELECT par objet |
| `sasDir` / `datasetDir` / `rulesFilePath` | Chemins (défauts : `~/.sandforge-sas`, `<sas>/dataset`, `<sas>/rules.json`) |
| `datasetVersion` | Semver du prochain jeu figé |
| `protectedOrgIds` | Environnements protégés (refusés au chargement) |
| `identityKeys` | Clés d'identité par objet (réutilisation au rechargement) |
| `undeletableObjects` | Objet → champ de désactivation (résidus désactivés, pas supprimés) |
| `requiredLookupPlaceholders` | Placeholders `Object.field` (lookup requis absent du jeu) |
| `requiredFieldDefaults` | Valeurs par défaut déclarées `Object.field` |
| `picklistRules` / `defaultPicklistRule` | Retrait ou remplacement déclaré des valeurs refusées |
| `duplicateErrorPatterns` | Marqueurs d'erreurs anti-doublon natives |
| `mockDetection` | Custom metadata + champ booléen `IsMocked` |
| `mandatoryLookups` / `presenceKeys` | Lookups obligatoires et clés de présence pour la vérification |

L'onglet **Extraire** édite `rootObject`, le budget, les axes et les cas limites en formulaire ; tout le reste passe par la zone **Configuration avancée** (JSON).

## Sécurité et sas

- Le **sas** (`~/.sandforge-sas` par défaut) est **hors dépôt par construction** : `SasPathGuard` refuse tout chemin de sortie situé dans le repo. La sélection (IDs source), `rt-map.json`, les tokens `{{JETON}}` (`tokens.json`) et le mapping `referenceId → Id` n'y quittent jamais.
- Le **sel** vient uniquement de `SANDFORGE_FROZEN_SALT` ; seule son **empreinte** (12 hex) est consignée. Ne jamais régénérer un second sel en silence : le déterminisme inter-versions serait perdu.
- Le bridge **redacte** : la sélection remontée à l'UI ne contient aucun Id source, et les détails de violations `clear-empty` (qui peuvent embarquer une valeur résiduelle) sont rédigés côté extension.
- Toute la DML passe par le **Production Guard** existant (tier check + audit trail).

## Limites

- La sélection mesure la volumétrie en exécutant une **passe d'extraction réelle** sur les racines retenues (bornée par le budget), opération interactive, pas batch.
- Sans `mockDetection` configuré, la garde « callouts mockés » est désactivée (affiché comme avertissement). La déployer avant tout chargement sur une org avec des callouts.
- Le rechargement sans refresh exige des clés d'identité exploitables sur la cible (ExternalId recommandé).
- Les valeurs de picklist hors affectation RecordType nécessitent l'**UI API** sur la cible (disponible sur les orgs récentes).
