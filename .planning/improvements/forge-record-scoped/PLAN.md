# Forge — Record-Scoped Clone

> Status: **VALIDATED** — Wave 1 in progress (2026-04-29)
> Created: 2026-04-29
> Owner: Stephane Berthoz + Claude
> Type: Ad-hoc improvement (hors phase 02)
>
> **Décisions tranchées 2026-04-29** :
> 1. Reverse-lookup minimal — exclure `vlocity_*` namespaces, garder Case-standard (CaseHistory, CaseComment, EmailMessage, Attachment)
> 2. Reference data (BusinessHours, OperatingHours, ServiceOffer__c) — si existe dans target, map par DeveloperName/Name au lieu de cloner
> 3. AnonymizePII — toggle gardé
> 4. UI Preview écran SOQL+count → Wave 2

## Goal

Faire que `Forge` avec `inputMode='record'` produise un clone *scopé* au record root et à sa transitive closure (parents + enfants reliés), au lieu de cloner intégralement chaque table du graphe.

Forme cible :

> Un dev pointe un Case dans MUT-UAT2 (partial copy), clique **Discover** → **Execute**, et obtient sur sa sandbox dev (MUT-SBER) ce Case + ~5 Account, ~10 Contact, ~5 InsurancePolicy, ~50 InsurancePolicyCoverage, ~20 CaseHistory, etc. — soit ~100 records cohérents au lieu de 261 858.

## Why

Use case validé en Phase A (recette `tools/recipe-forge-grappe.ts`) : un dev veut un jeu de données *viable* sur sa sandbox dev à partir d'une sandbox de type partial/full copy.

Le code actuel exécute pour chaque node :

```ts
const soql = `SELECT ${queryFields.join(', ')} FROM ${node.objectApiName}`;
```

→ aucun WHERE. Sur Mutuaide UAT2, l'execution ferait 11 383 Cases + 11 974 Accounts + 15 539 Contacts + 155 541 InsurancePolicyCoverage = 261 858 records cloués vers SBER. Goverlor limits + temps + non-viable pour le use case dev.

`config.recordId` n'est utilisé qu'à un seul endroit : `GraphDiscoveryService.resolveRootObject` pour résoudre l'objet via keyPrefix. **Il n'est jamais utilisé pour filtrer les queries d'exécution.** C'est le trou conceptuel.

## Approach

Pendant l'exécution topologique (par wave), propager les IDs collectés via les FK pour ne cloner que la transitive closure.

```
Wave 0: Reference data (BusinessHours, OperatingHours, ServiceOffer__c) → all
Wave 1: Case WHERE Id = '500AP00000fXeQsYAK'
        Account WHERE Id IN (Case.AccountIds)
Wave 2: Contact WHERE AccountId IN (cachedAccountIds)
        InsurancePolicy WHERE AccountId IN (cachedAccountIds)
        CaseHistory2 WHERE CaseId IN (cachedCaseIds)
        EmailMessage WHERE ParentId IN (cachedCaseIds)
        ...
```

Trois nouvelles primitives :

1. **`RecordScopeCache`** — `Map<objectApiName, Set<recordId>>` mémorise les IDs cloués au fur et à mesure.
2. **`ScopedSoqlBuilder`** — construit le `WHERE` pour un node à partir des edges entrantes (parent IDs cachés) et des edges sortantes inverses (child rels du root pour les enfants type CaseHistory).
3. **`ForgeExecutor`** modifié — initialise le cache avec le record root, query scopée par node, met à jour le cache avec les nouveaux IDs avant la wave suivante.

## Waves

### Wave 1 — POC minimal (~2h, ~150 LOC, 8-10 tests)

**Objectif** : valider que le concept tient face au graphe réel Mutuaide UAT2 sans casser l'existant. **Pas d'écriture sur SBER.**

| Task | Description | Critère |
|---|---|---|
| T1.1 | Créer `RecordScopeCache.ts` — add(obj, ids) / get(obj) / has(obj). | Tests unitaires verts. |
| T1.2 | Créer `ScopedSoqlBuilder.ts` — `build(node, fieldInfos, cache, edges, rootRecordId)` retourne `{ soql, scoped: boolean }`. Pour root → `WHERE Id = ?`. Pour autres → `WHERE` en utilisant les FK fields qui pointent vers parents cachés. Si aucune scope possible (parents pas dans cache) → fallback `included = false` plutôt que query all. | Builder retourne SOQL correct pour scenarios test (root, child via lookup, child via reverse lookup). |
| T1.3 | Modifier `ForgeExecutor.execute` pour initialiser cache avec `{rootObject: [recordId]}` quand `inputMode='record'`, puis pour chaque node utiliser `ScopedSoqlBuilder` au lieu du SOQL actuel. **Mode dry-run** : récupère les IDs mais n'insère pas. | ForgeExecutor.test.ts existant + 3 nouveaux tests scoped pass. |
| T1.4 | Étendre `tools/recipe-forge-grappe.ts` avec une "Phase B preview" : pour chaque node du plan, afficher le SOQL scopé qui *serait* exécuté + l'estimation de records (via `SELECT COUNT()`). | Recette imprime ~50 SOQL avec WHERE clauses cohérentes. Total records estimé < 1 000 (vs 261 858 avant). |
| T1.5 | Lancer la recette Phase B sur MUT-UAT2 (record `500AP00000fXeQsYAK`) et valider le rapport. | Visual review : SOQL sensés, volumes raisonnables, pas de query "WHERE 1=0" délirante. |

**Sortie de Wave 1** : un mode `dryRun=true` validé qui montre exactement ce qui serait fait, sans rien écrire.

### Wave 2 — Hardening (~2h, ~200 LOC, 15+ tests)

| Task | Description | Critère |
|---|---|---|
| T2.1 | IN clause chunking — Salesforce limite à 4 000 IDs par IN. Splitter en sous-queries et merger résultats. | Test : 5 000 IDs → 2 queries chunkées. |
| T2.2 | Reverse-lookup propagation — pour chaque node enfant du root (CaseHistory.CaseId, EmailMessage.ParentId, CaseComment.ParentId, …), construire WHERE depuis les IDs cachés du parent. | Test : CaseHistory contient un edge `Case → CaseHistory2`, builder produit `WHERE CaseId IN (cachedCaseIds)`. |
| T2.3 | Cycle handling (`Account ↔ Contact`) — vérifier que la stratégie `nullable_lookup` du PlanGenerator est cohérente avec le scope : insérer Account puis Contact puis UPDATE Account.PrimaryContactId. | Test E2E sur 2-cycle. |
| T2.4 | Records orphelins — quand un FK pointe vers un objet exclu (User, RecordType) ou non cloué, décision config : `keepSourceId` / `nullify` / `mapToCurrentUser`. Default : `nullify` pour User/Owner, `keepSourceId` pour RecordType (matché par DeveloperName côté target via `metadataDiff`). | 3 tests par stratégie. |
| T2.5 | Volumétrie cap — si scoped query estime > N records pour un node (ex: InsurancePolicyCoverage qui peut exploser), proposer un sampling `LIMIT N` configurable via `ForgeConfig.maxRecordsPerObject`. | Default : pas de cap. Configurable. |

### Wave 3 — Execution réelle (à valider après Waves 1+2)

Une fois la dry-run confirmée par revue humaine, on lance vraiment :
- `ForgeExecutor.execute` non-dry sur SBER, scope au Case `500AP00000fXeQsYAK`.
- Abort hook en place.
- Reporting des erreurs réelles (FLS, validation rules MUT, missing required fields, etc.).
- Itération sur les fix nécessaires.

## Success criteria

- **Wave 1** : recette dry-run produit < 1 000 records au lieu de 261 858, SOQL générés inspectables, 0 régression sur tests existants Forge (160/160).
- **Wave 2** : recette dry-run gère les 4 cas adversariaux (cycle Account↔Contact, IN > 4k, records orphelins, reverse-lookup CaseHistory).
- **Wave 3** : Case 500AP00000fXeQsYAK plus closure cloué intégralement vers SBER en < 5 min, < 100 records écrits, tous validés visuellement dans SBER.

## Risks

- **Vlocity custom objects** : leurs lookups peuvent avoir des comportements particuliers (formula refs, polymorphic fields). À découvrir.
- **Polymorphic lookups** (`Task.WhatId`, `Event.WhatId`) : le scoping doit suivre les bons objets cibles selon le record-type. À gérer dans `PolymorphicHandler` existant.
- **Self-reference** (Account.ParentId, Contact.ReportsToId) : déjà géré par `SelfReferenceHandler` existant — vérifier interop avec scope cache.
- **WHERE clause length limit** Salesforce (~20 000 chars) : dépend du nombre d'IDs et de la longueur des field names. Peut nécessiter chunking parallèle de queries si > 200 IDs.
- **Schema drift entre source et target** : si SBER a un schema plus récent / plus ancien, certains champs custom n'existent pas. `ForgeMetadataDiff` existant à brancher sur le scope query.

## Open questions

1. **Reverse-lookup scope** : pour un Case root, on veut clairement les CaseHistory, CaseComment, EmailMessage. Mais aussi les `vlocity_ins__Statement__c` qui pointent vers le Case ? Et les InsurancePolicyCoverage ? Probablement oui mais à confirmer use case.
2. **Reference data objects** (BusinessHours, OperatingHours, ServiceOffer__c) : existent-ils déjà sur SBER ? Si oui, on doit *mapper* les IDs (par `DeveloperName` ou `Name`) au lieu de cloner. Si non, cloner intégralement.
3. **`AnonymizePII`** : avec scope, on traite ~10 records par node — l'anonymization perd de son intérêt sur petits volumes. Garder le toggle mais le comportement est inchangé.
4. **UI** : l'utilisateur clique sur **Discover Graph** dans le wizard, voit le graphe. Ensuite il faut un **Preview** qui montre les SOQL scopés + le compte estimé avant **Execute**. À ajouter ?

## Out of scope

- Modifications du wizard webview (cette amélioration est côté backend seulement, le wizard utilise déjà `inputMode='record'`).
- Cache persistant entre sessions (`RecordScopeCache` reset par execution).
- Bidirectional clone (SBER → UAT2). Toujours UAT2 → SBER pour ce plan.
- Refactoring du module Sync (séparé).

## Definition of Done

- 4 fichiers nouveaux : `RecordScopeCache.ts` + test, `ScopedSoqlBuilder.ts` + test
- ~3 fichiers modifiés : `ForgeExecutor.ts`, `tools/recipe-forge-grappe.ts`, `ForgeConfig` schema (si on ajoute `maxRecordsPerObject` ou `dryRun` en Wave 2)
- Tests forge : ≥ 180/180 verts (160 actuels + 20 nouveaux)
- Recette Phase B (dry-run) : SOQL inspectables, < 1 000 records estimés
- Phase C (execution réelle) optionnelle, à déclencher après revue
