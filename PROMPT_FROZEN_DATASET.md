# PROMPT — Module « Frozen Reference Dataset » (jeu de référence figé) pour SandForge

> À exécuter par un agent dans le repo `sand-forge`. Français pour le produit (i18n 6 langues pour toute UI), anglais pour le code.

## Rôle et contexte

Tu es dans `sand-forge`, l'extension VS Code Salesforce (TypeScript strict, ~8 300 tests, webview UI, modules : Seed, Sync, Monitor, Compare, DataOps, Automation, Forge).

Il existe déjà, et tu dois les **réutiliser plutôt que réinventer** :

- `ForgeOrchestrator.discover()` / `ForgeGraph` (BFS schéma), `ForgePlanGenerator.generate()` (vagues topologiques de Kahn)
- `ForgeExecutor` avec mode scope-aware : `RecordScopeCache` + `ScopedSoqlBuilder` (BFS record-level avec index des références entrantes), `RecordTypeMapper` (résolution **par DeveloperName**, jamais par label), `ReferenceDataMapper` (objets référentiels mappés par clé/nom), strip `__pc` sur Business Accounts, strip `Name` sur PersonAccounts, strip des valeurs de picklist hors whitelist cible, nullification des FK orphelins
- DataOps : `PiiDetector` (noms de champs + regex + échantillonnage), Production Guard (3 niveaux de sécurité, blocage DELETE, audit trail)

## Objectif

Ajouter un module **Frozen Reference Dataset** : un jeu de données métier **extrait une fois d'une sandbox de recette, pseudonymisé de façon déterministe, figé, versionné (manifest + empreinte de sel), rechargeable à l'identique après chaque refresh de sandbox dev, avec contrôle de non-réidentification et vérification post-chargement**.

Cas d'usage : après un refresh de sandbox Developer (métadonnées mais **zéro record**), le développeur obtient en une commande un jeu de dossiers réalistes couvrant les parcours fonctionnels — sans jamais embarquer de donnée identifiante.

## Spécifications fonctionnelles

### 1. Sélection par matrice de couverture (pas un échantillon aléatoire)

- Axes de couverture **configurables** (par client/projet) : chaque axe = une requête SOQL d'agrégat (ex. prestation, catégorie, logiciel de missionnement, donneur d'ordre, événement, cas limites).
- Énumérer les **combinaisons observées** dans l'org source ; retenir **un dossier racine par combinaison** (jamais deux), plus un par cas limite déclaré (marqueur en données). Contrôle de santé par dossier (graphe complet, pas de « dossier boiteux »).
- Budget de volumétrie plafond configurable (défaut 2 500 records), **vérifié mécaniquement** — refus au-delà.
- La liste d'Ids retenus vit **hors du dépôt** (sas local) : versionnée, elle formerait une table de correspondance réel ↔ anonymisé.

### 2. Extraction scope-aware

- Réutiliser `RecordScopeCache` + `ScopedSoqlBuilder` depuis les dossiers racines (descendance complète + référentiel nécessaire, pas de `SELECT *`).
- Gabarits de requêtes **sans aucun Id en dur** : listes d'Id injectées depuis le sas à l'exécution (jetons `{{NOM_JETON}}`).
- `RecordTypeId` exporté + `rt-map.json` (Id → SobjectType/DeveloperName/Name) produit à l'extraction.
- Le sas est **hors dépôt** par construction : refuser tout chemin de sortie situé dans le repo.

### 3. Pseudonymisation déterministe (cœur du module)

- `HMAC-SHA256(sel, "générateur|valeur")` : **la même valeur produit la même sortie quel que soit l'objet/champ porteur** — c'est ce qui fait survivre les jointures inter-objets (dédup et recherche bénéficiaire se comportent comme en prod).
- Le sel n'est **jamais dans le dépôt** (variable d'environnement / gestionnaire de secrets) ; son **empreinte** (SHA-256, 12 hex) se consigne dans le manifest. Ne jamais régénérer un second sel en silence : le déterminisme inter-versions serait perdu.
- Générateurs : `keep`, `clear` (vidage d'office de tout champ sans règle — jamais de clair en sortie), `firstName`, `lastName`, `companyName`, `phoneE164` (plage fictive ARCEP +3363998xxxx), `email` (@example.invalid), `registrationSIV` (format conservé AA-123-BB), `contractNumber` (forme conservée : chiffre→chiffre, lettre→lettre), `postalCodeGeneralize` (2 premiers chiffres + zéros **à longueur**, CP étrangers 4 chiffres inclus), `dateMonthStart` (naissances uniquement), **`dateShift`** (décalage **uniforme** de tout le jeu, offset dérivé du sel, 200–400 jours — casse la datation absolue, préserve toutes les durées), `geoRound1` (~11 km), `kmRound10`.
- Fichier de règles `objet.champ → générateur` comme **source de vérité** (aucune règle en dur dans le code). Un générateur de propositions par pattern (nom/type/longueur) aide à couvrir les champs nouveaux, mais `keep` exige une validation humaine.
- **Balayage anti-Id-mort** au niveau record : toute chaîne validant le **checksum Salesforce 18 caractères** (3 derniers caractères = checksum de casse des 15 premiers) restante après transformation est vidée — c'est le discriminant fiable (ni la longueur seule ni le marqueur de pod : les Ids de RecordType portent un pod différent des Ids de records).
- `RecordTypeId` → `RecordType.Name` à l'anonymisation, résolution côté chargement **par DeveloperName** (les labels diffèrent d'une org à l'autre, mojibake compris).

### 4. Manifest du jeu figé

`version` (semver, humaine), `status: frozen`, `frozenAt`, `source` (org, date de décision), `saltFingerprint`, `rulesVersion`, `volumetry` (plafond, mesuré par objet, date), `controls` (résultat du contrôle 4 points, chargement à blanc, auteur/date).

### 5. Contrôle de non-réidentification — GATE avant versionnement

1. **Substitution effective** : record à record, champ à champ (appariement par referenceId), la valeur d'origine n'apparaît nulle part — **y compris dans un autre champ du même record** (fuite transversale : ex. immatriculation saisie dans un champ « marque »).
2. **Champs `clear` vides** : zéro résidu.
3. **Formats conservés** : SIV, E.164, email, CP généralisé.
4. **Zéro Id source résiduel** : discriminant = checksum Salesforce 18 car. (cf. §3).

Résultat consigné dans le manifest. **Un FAIL = rien n'est versionné.**

### 6. Chargement rejouable (avec Production Guard)

- Garde-fous : refuse une org non-sandbox ; refuse une **liste configurable d'environnements partagés** (la source n'est jamais une cible) ; refuse des callouts non mockés (détection configurable, ex. custom metadata `IsMocked`) ; refuse un jeu vide. Remédiation = déploiement de config, jamais de DML sur la source.
- Alignement de schéma cible : champs absents retirés **en les listant** ; picklists restreintes et **écarts d'affectation par RecordType** (une valeur active au global peut être non affectée au RT — détectable via UI API `picklist-values/{recordTypeId}/{field}`) : retrait ou remplacement déclaré, listé.
- **Champs requis absents du jeu** (ex. lookup rendu requis après la création des données sources) : pattern « placeholder technique » explicite (création d'un record de rattachement nommé et record-typé correctement), jamais d'exclusion silencieuse.
- **Cycles** : gestion 2-pass existante + **post-load des liens PersonContact** (`Account.PersonContactId` n'existe qu'après insert : sidecar `referenceId → referenceId` produit à l'anonymisation, résolu après import, posé en updates ciblés).
- **Réutilisation/rechargement sans refresh** : clés d'identité (ExternalId, nom, paires composites), réutilisation du référentiel indélétable ; suppression des résidus **enfants avant parents** (les lookups bloquent la suppression parent) ; certains objets sont indélétables → désactivation.
- **Pilote** : un dossier racine seul (~2 min) avant le chargement complet — le scope-aware existant couvre l'essentiel ; prévoir le mode dégradé explicite pour les records non appairables (anti-doublon natif de la cible).

### 7. Vérification post-chargement (lecture seule, chaînée au chargement)

- Comptages par objet vs **contrat de comptage** écrit au chargement (fichiers moins exclusions).
- Intégrité des liens : orphelins de lookups obligatoires du graphe, pointeurs de rappel restaurés.
- Présence par clé (ExternalId) pour le référentiel partagé avec l'org.
- **Robustesse** : après une grosse tempête DML, la lecture org peut être transitoirement incohérente — re-mesurer jusqu'à deux relevés identiques avant verdict.

## Contraintes d'implémentation

- TypeScript strict ; architecture existante respectée — **pas de refactor de Forge** ; le module vit en packages/ avec son orchestrateur et sa webview si UI (i18n 6 langues).
- **Tests requis** (le repo en a ~8 300) : générateurs (déterminisme, formats, jointures inter-objets), checksum Salesforce, contrôle 4 points (cas passants et chacun des 4 échecs), sélection matrice (1 dossier/combinaison, budget), balayage anti-Id-mort.
- Production Guard : chargement/suppression en sandbox uniquement, audit trail.
- Aucune valeur spécifique à un client en dur : axes de couverture, règles, envs protégés, détection de mocks = **configuration**.
- Docs : `docs/modules/frozen-dataset.md` + entrée CHANGELOG + README (table des modules).

## Pièges transférés d'une exécution réelle (à ne pas réapprendre)

1. Le matching RecordType par **label** échoue (labels différents entre orgs, mojibake) — DeveloperName, toujours.
2. Une picklist peut être active au global et **non affectée au RT** — invisible au describe ; seul l'UI API par (RT, champ) la voit.
3. Un lookup peut devenir **requis après coup** : les vieux records sources n'en ont pas, l'insert échoue — pattern placeholder.
4. Les CP étrangers à 4 chiffres passent à travers une généralisation prévue pour 5.
5. Un champ texte libre peut contenir une immatriculation (qualité de la donnée source) → `clear`, et le contrôle transversal l'attrape.
6. Les exports tree **omettent les champs null** — ne pas confondre absence et vide.
7. Les referenceId du plugin d'export sont **stables** entre deux exports identiques — réutilisable pour diffs/sidecars.
8. L'org source bouge pendant l'extraction : figer une borne de date.
9. L'automatisation de la cible peut **réécrire des identifiants fonctionnels à l'insert** — persister le mapping `referenceId → Id` (seule adresse fiable d'un record chargé).
10. Suppression en vrac : toujours **enfants avant parents** ; certains objets (FSL ServiceResource) sont indélétables → désactiver.

## Critères d'acceptation

- [ ] Une extraction complète produit un jeu pseudonymisé dont le contrôle 4 points passe (0 valeur d'origine résiduelle, 0 Id mort, formats valides) et le manifest est consigné.
- [ ] Deux générations à sel égal sur la même source figée produisent des records **identiques** (diff = 0 hors dérive de la source).
- [ ] Un chargement complet sur sandbox dev fraîche passe, post-loads compris, et la vérification post-chargement est verte.
- [ ] Un rechargement sur la même sandbox (sans refresh) réutilise le référentiel et refuse/purge les résidus dans l'ordre enfants → parents, sans doublon.
- [ ] Le pilote d'un dossier se charge en ~2 min et sa vérification est verte.
- [ ] Tests unitaires des générateurs et du contrôle au vert ; aucune donnée identifiante ne quitte le sas (test de non-fuite).
