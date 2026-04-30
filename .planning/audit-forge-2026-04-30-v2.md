# Audit Forge — Pass 2 (2026-04-30)

**Contexte** : Audit Learnship complet post-37-fixes + 3 freeze fixes UI. 4 agents en parallèle (red-team, perf/critic, reviewer, test-coverage).

**Verdict global** : `REVISE` — Le module est solide sur 70% des chemins, mais **5 findings critiques/high** doivent passer avant publication, et le **freeze fix courant cible le mauvais root cause** (le freeze va revenir au prochain cold-start sur grosse org).

---

## TL;DR — À fixer en priorité (effort total ~4h)

| Pri | ID | Severity | Sujet | Effort |
|---|---|---|---|---|
| 1 | **PERF-001** | CRITICAL | `setImmediate` yield ne traite pas le root cause documenté (`describeGlobal` non-caché). Le freeze va revenir. | M |
| 2 | **CR-001** | Critical | Compteur `orphanExpansionsUsed++` avant `expandSingleOrphanParent` → cap signe l'effort, pas l'effet | S |
| 3 | **CR-002** | Critical | Pass-2 dedup mutable implicite — sémantique fragile, casse silencieusement si refactor | S |
| 4 | **RT-001** | High | `recordId` non regex-validé dans `forgeConfigSchema` → SOQL injection via webview compromis | S |
| 5 | **RT-003** | High | Tarjan SCC récursif → stack overflow sur graph forgé (>10K nodes) | M |
| 6 | **CR-003** | High | Root excluded en mode scoped → tous les enfants orphan-nullify silently | S |
| 7 | **CR-005** | High | `parseObjectFromSOQL` ne strip pas les parens imbriquées → wrong-root match | S |
| 8 | **CR-007** | High | Orphan expand ne push pas dans `scopeCache` → multi-hop scope mismatch | S |
| 9 | **RT-002** | High | `objectApiName` sans regex dans `forgeGraphNodeSchema` → defense-in-depth | S |

---

## 1. Sécurité (red-team) — 2 HIGH résiduels

### RT-001 [HIGH] — `recordId` non validé contre injection SOQL
**Fichier** : `packages/shared/src/schemas/forge.schema.ts:34` + `ScopedSoqlBuilder.ts:95`

`forgeConfigSchema` valide `recordId: z.string().min(1)` sans regex. La défense `sanitizeSoqlValue()` échappe `'` et `\` mais peut être bypass via backslash escape :
```
recordId = "001\\' OR Id IN (SELECT Id FROM Account) OR Id='001"
```
→ après sanitize : `001\\\' OR Id IN ...` → `WHERE Id = '001\\' OR Id IN (...)` exfiltration tout Account.

**Fix** :
```ts
recordId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/).optional(),
```

### RT-002 [HIGH] — `objectApiName` sans regex dans `forgeGraphNodeSchema`
**Fichier** : `packages/shared/src/schemas/forge.schema.ts:53`

Asymétrie : `metadataDiffRequestPayloadSchema` valide les noms avec regex `/^[A-Za-z][A-Za-z0-9_]*$/`, mais `forgeGraphNodeSchema.objectApiName` accepte n'importe quoi. Combiné avec RT-003, permet stack overflow.

**Fix** :
```ts
objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,254}$/),
```

### RT-003 [HIGH] — Tarjan SCC récursif → DoS via graph forgé
**Fichier** : `packages/extension/src/modules/forge/ForgePlanGenerator.ts:223-257`

`strongConnect(v)` est récursive. Node.js stack ~10-15K frames. Graph en chaîne avec N>10000 nodes → `RangeError: Maximum call stack size exceeded` → crash extension host.

**Fix** : convertir en boucle itérative avec stack explicite. + ajouter `.max(2000)` sur `forgeGraphSchema.nodes`/`.edges`.

### Autres findings (Medium/Low)
- **RT-004** [Med] : `cacheKeyFor` ignore `targetOrgId`, `anonymizePII`, `expandOrphanParents` → cache poisoning
- **RT-005** [Med] : `metadataDiffRequestPayloadSchema.objectApiNames` accepte 500 entrées identiques → API limit DoS
- **RT-006** [Med] : `ForgeTemplateStore` deprecated mais reste dans le code → surface latente
- **RT-007** [Low] : `IdRemapper.fromJSON` dead-code check (`typeof key !== 'string'` toujours faux)
- **RT-008** [Low] : `expandSingleOrphanParent` valide `parentObject` après `describeFields` → defense-in-depth

---

## 2. Performance — Le freeze fix actuel cible le mauvais problème

### PERF-001 [CRITICAL] — `setImmediate` yield BFS = placebo
**Fichier** : `GraphDiscoveryService.ts:218`

Le doc `.planning/debug-discover-freeze.md` identifie le bottleneck : `resolveRootObject` appelle `describeGlobal()` **une fois sans cache, sans timeout, sans abort propagation**, bloquant 30-90s avant tout progress event.

**Fixes appliqués** :
1. `setImmediate` au début de chaque wave BFS — **inutile** : `await Promise.all(...)` juste avant yield déjà naturellement à l'event loop pendant l'I/O HTTP.
2. Skip `JSON.stringify` dans `SchemaCache.set()` — **utile mais marginal** : 50-200ms × 50 sets = quelques secondes max.
3. Single `__resolving_root__` event — **utile UX seul** : empêche la dialog "window not responding" mais pas le wall-time perçu.

**Fixes manquants (Fix 1, 4, 5 du doc)** :
- Cache `describeGlobal` au connect (HAUT ROI)
- AbortSignal propagation jsforce v3
- Timeout par appel describe (60s)

**Diagnostic mesurable** : Le freeze va revenir presque identique sur le prochain cold-start Mutuaide UAT2.

**Fix recommandé** :
1. Ajouter breadcrumbs `console.log` `Date.now()` à l'entrée/sortie de chaque adapter call dans `extension.ts:184-243`
2. Implémenter Fix 1 du doc (cache `describeGlobal` au niveau adapter)
3. Implémenter Fix 4 (AbortSignal forwarding)

### PERF-002 [HIGH] — `maxSizeBytes: Number.POSITIVE_INFINITY` → risque OOM
**Fichier** : `extension.ts:170-176` + `SchemaCache.ts:69-85`

`describeCache` configuré avec maxSize=200 et byte tracking désactivé. 200 entries × 5 MB = **1 GB**. VSCode extension host bridé à 1024-2048 MB heap.

**Fix** : remplacer `estimateSize` par heuristique O(1) :
```ts
private estimateSize(value: T): number {
  if (value && typeof value === 'object' && 'fields' in value) {
    const desc = value as unknown as { fields?: unknown[]; childRelationships?: unknown[] };
    return (desc.fields?.length ?? 0) * 250 + (desc.childRelationships?.length ?? 0) * 100;
  }
  return 1024;
}
```
Et garder `maxSizeBytes: 200 * 1024 * 1024` (200 MB).

### Autres findings perf
- **PERF-003** [Med] : `discoveryCache` (Orchestrator) garde `maxSizeBytes=5MB` avec estimateSize ACTIF → même bug que les fixes prétendent éviter, juste à plus petite échelle
- **PERF-004** [Med] : `handleDiscover.catch()` n'appelle pas `throttledProgress.flush()` → UI peut rester sur état stale après abort
- **PERF-005** [Low] : `topologicalSort` 100% sync — OK pour 350 nodes (1-3ms) mais pas de garantie sur graphes 1000+
- **PERF-006** [High] : `getJsforceConnection` rappelé à chaque adapter call → 1-3s cumulés DPAPI Windows
- **PERF-008** [Low] : commentaires `extension.ts:160-166` mentent (`capped at 50MB` mais code dit `POSITIVE_INFINITY`)

---

## 3. Code correctness — 2 Critical + 5 High

### CR-001 [Critical] — Compteur `orphanExpansionsUsed` faux
**Fichier** : `ForgeExecutor.ts:712`

```ts
orphanExpansionsUsed++;  // ← AVANT l'expansion
try {
  const newId = await this.expandSingleOrphanParent(...);
  // ↑ peut retourner null (parent introuvable) → compté quand même
}
```
Avec maxOrphanExpansions=20, si 10 parents échouent, on a 10 succès au lieu des 20 attendus.

**Fix** : incrémenter **après** `if (newId)`.

### CR-002 [Critical] — Pass-2 dedup mutable implicite
**Fichier** : `ForgeExecutor.ts:1025`

```ts
const existing = perObj.get(upd.newId) ?? { Id: upd.newId };
```
Sémantique mutable par référence. Casse silencieusement si quelqu'un fait `{ ...existing, Id }` clone.

**Fix** : pattern explicite `current = perObj.get(...)` ; build-then-set.

### CR-003 [High] — Root excluded en mode scoped → données déconnectées
**Fichier** : `ForgeExecutor.ts:1308-1318`

Si l'utilisateur exclut le root (Account) via UI mais inclut les enfants (Cases), `bringRootToFront` passe le root devant mais le node est skipped. Tous les enfants orphan-nullify leur AccountId silently.

**Fix** : guard explicite + erreur si `rootNode.included === false` en mode scoped.

### CR-005 [High] — `parseObjectFromSOQL` parens imbriquées
**Fichier** : `GraphDiscoveryService.ts:396-406`

`replace(/\([^()]*\)/g, '')` ne strip qu'un niveau. Sur subqueries imbriquées, le regex `\bFROM\s+(\w+)` matche le mauvais object.

**Fix** : boucle jusqu'à fixed point.

### CR-007 [High] — Orphan expand ne push pas dans scopeCache
**Fichier** : `ForgeExecutor.ts:1224`

Quand orphan parent A est expandé, son sourceId est mis dans `remapper` mais pas dans `scopeCache`. Multi-hop : un autre node B qui dépend de A en scope cache va voir A out-of-scope et être skippé.

**Fix** : `scopeCache?.add(entry.object, [entry.sourceId])` après `remapper.add`.

### CR-004 [High] — `pickUpsertField` non-unique → DUPLICATE_VALUE en prod
**Fichier** : `ForgeExecutor.ts:1133-1166`

L'unicité testée est dans le batch source, pas dans la target org. Si target a déjà des rows partageant le champ, `DUPLICATE_VALUE` à coup sûr.

**Fix** : logger explicitement le champ choisi + fallback insert si non-unique.

### Autres findings
- **CR-008** à **CR-024** : voir détail dans le rapport reviewer agent (Med/Low)

---

## 4. Tests — 6.5/10 — ForgeExecutor sous-couvert

### Verdict
- **ForgeExecutor.ts** (1405 LOC) : **5/10** coverage estimé ~55-60%
- **0 property test** sur Forge alors que les arbitraries existent
- **Sanitize SOQL mocké identity** dans ForgeHandler.test.ts (lignes 19-30) → désactive la défense en tests

### Top 10 tests manquants
1. Person Account branches (`IsPersonAccount` true/'true'/1/false/null)
2. Pass-2 partial update failure (`updateRecords` retourne mixed success/fail)
3. Discovery cycle in metadata (Account → Contact → Account)
4. Concurrent `forge:execute` back-to-back
5. SOQL injection sur `forge:preview` non-mocké
6. `workspacePath` traversal (`../../../etc/passwd`)
7. Picklist value strip cross-org (valeur absente target)
8. Freeze regression test (mesure event-loop responsive)
9. Property-based `IdRemapper` round-trip toJSON/fromJSON
10. Bulk 2000+ records via queryMore pagination

### Tests suspects à muscler
- `ForgeOrchestrator.test.ts:170-178` — assertions tautologiques
- `ForgeExecutor.test.ts:357-386` — `setTimeout` race flaky
- `ForgeExecutor.test.ts:851` — `toBeLessThanOrEqual(2)` au lieu de `toBe(2)`
- `ForgeHandler.test.ts:19-30` — sanitizeSoqlValue mocké identity
- `SchemaCache.test.ts:195-205` — pas d'assertion sur le compteur d'accès

---

## 5. Plan d'action priorisé

### Sprint immédiat (~4h ciblé)
- [ ] **CR-001** : découpler tentatives/succès dans cap orphan (S)
- [ ] **CR-002** : pass-2 dedup explicit (S)
- [ ] **CR-003** : guard root excluded en mode scoped (S)
- [ ] **CR-005** : fix parseObjectFromSOQL fixed-point (S)
- [ ] **CR-007** : push orphan expanded dans scopeCache (S)
- [ ] **RT-001** : regex `recordId` dans forgeConfigSchema (S)
- [ ] **RT-002** : regex `objectApiName` dans forgeGraphNodeSchema (S)

### Sprint suivant (~1 jour)
- [ ] **PERF-001** : breadcrumbs timing + cache `describeGlobal` + AbortSignal jsforce (M)
- [ ] **PERF-002** : heuristique O(1) estimateSize + cap 200MB (S)
- [ ] **RT-003** : Tarjan itératif + `.max(2000)` sur arrays Zod (M)
- [ ] **CR-004** : surface upsertField + fallback insert (M)
- [ ] Tests prioritaires #1, #2, #3, #5, #8 (M)

### Backlog
- [ ] Centraliser `EXCLUDED_OBJECTS` dans `@sandforge/shared` (CR-018)
- [ ] Drop dead code `ForgeTemplateStore` (CR-022 / RT-006)
- [ ] Property tests pour `IdRemapper` + `ForgePlanGenerator` (test #9)
- [ ] Wirer `upsertRecords` dans CLI (CR-016)
- [ ] Corriger commentaires périmés (PERF-008)

---

## 6. Points forts du module (à préserver)

- ✅ **Validation SOQL** : `sanitizeSoqlValue` + `assertSoqlIdentifier` partout (sauf gaps RT-001/002)
- ✅ **Defense-in-depth** : `__proto__` filter, intersect creatable sets src/tgt, picklist whitelist
- ✅ **Error handling explicite** : 3 ex-silent describe catches surfacés en `ExecutionObjectError`
- ✅ **Documentation inline** : commentaires expliquent le *pourquoi* (Wave 2 v3, Mutuaide UAT2 freeze, Person Account)
- ✅ **CLI hardening** : SF_ALIAS_RE, SINCE_LITERAL_RE, SF_ID_RE strict
- ✅ **Type safety** : peu de `any`, peu de `as` non-justifiés
- ✅ **Topo sort O(N+E)** : passage adjacency map fait correctement

---

## Verdict synthèse

| Axe | Score |
|---|---|
| Sécurité | 7/10 — 2 HIGH validation Zod résiduels |
| Performance | 5/10 — fix actuel cible mauvais root cause, OOM risk introduit |
| Correctness | 7/10 — 2 critical + 5 high data-integrity bugs latents |
| Tests | 6.5/10 — ForgeExecutor sous-couvert, 0 property test |
| **Global** | **6.5/10** — Solide à 70%, ne pas merger sans Sprint immédiat |

**Action immédiate** : appliquer les 7 fixes du sprint immédiat (~4h) pour passer à 8/10 et mergeable.
