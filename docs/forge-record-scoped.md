# Forge: Record-Scoped Clone

> Cloner un graphe de records cohérents depuis une sandbox source (partial-copy / full-copy) vers une sandbox dev sans cloner toutes les rangées de toutes les tables.

## Pourquoi

Avant : `Forge` avec `inputMode: 'record'` *découvrait* le graphe à partir d'un record racine puis exécutait `SELECT * FROM Object` (sans `WHERE`) pour chaque node. Sur SOURCE-UAT partant d'un Case, ça représentait **261 858 records** copiés (Case ×11k, Account ×12k, Contact ×15k, InsurancePolicyCoverage ×155k…). Pas viable comme "jeu de données dev".

Après : l'exécution est *scope-aware* : depuis le record racine, le moteur suit la transitive closure (parents via FK, enfants via reverse-lookup) et n'exécute que des SOQL avec `WHERE Id = …` ou `WHERE FK IN (cachedParentIds)`. Sur le même Case, **358 records** clonés au lieu de 261 858 (−99.86 %).

## Pipeline

```
ForgeOrchestrator.discover()  →  ForgeGraph (BFS schema)
ForgePlanGenerator.generate() →  ForgePlan  (Kahn's topo waves)
ForgeOrchestrator.execute(graph, config)
  └ ForgeExecutor.execute(graph, source, target, onProgress, options)
       │
       ├─ if rootRecordId provided → scope-aware mode
       │    RecordScopeCache + ScopedSoqlBuilder
       │
       ├─ for each node (root-first, then topo):
       │    1. isObjectCreatable check (target)
       │    2. describeFields (source + target → intersect createable)
       │    3. ScopedSoqlBuilder.build → SOQL with WHERE
       │    4. queryRecords(source)
       │    5. (if reference-data object) ReferenceDataMapper.resolve(target by Name)
       │    6. seed cache (own IDs + FK values from results)
       │    7. clean records:
       │         - strip non-createable
       │         - strip Person Account __pc on Business Accounts
       │         - strip Name on Person Accounts (auto-computed)
       │         - strip picklist values not in target whitelist
       │         - omit nullified orphan FKs (don't send `null`)
       │         - apply RecordType mapping (DeveloperName)
       │    8. batch insert into target
       │
       └─ summary { successCount, failedCount, skippedCount, errors[] }
```

## ExecuteOptions

| Option | Default | Effect |
|---|---|---|
| `rootRecordId` | — | enables scope-aware mode |
| `rootObjectApiName` | — | resolved from `recordId` keyPrefix; required with `rootRecordId` |
| `dryRun` | `false` | runs every step except `insertRecords`, used by the recipe |
| `referenceFallback` | `'nullify'` (scoped) / `'keep'` (legacy) | what to do with FK fields whose value isn't in the IdRemapper |
| `recordTypeMappings` | — | array of `{ sourceId, targetId, developerName }`; built via `RecordTypeMapper` |
| `maxRecordsPerObject` | — (no cap) | append `LIMIT N` to every scoped query |
| `referenceDataObjects` | `['BusinessHours', 'OperatingHours']` | objects to map by Name instead of cloning |

## Error structure

`ForgeExecutionResult.errors: ForgeExecutionError[]` is populated whenever any
record or object failed. Shape:

```ts
interface ForgeExecutionError {
  objectApiName: string;
  stage: 'query' | 'insert' | 'scope';
  failedCount: number;
  attemptedCount: number;
  samples: Array<{
    recordSummary: string;          // first ~4 fields key=value
    messages: string[];             // STATUS_CODE: message
  }>;
}
```

The wizard webview consumes this via `forge:execute:response` and renders a
grouped error panel (see `ForgeResults.tsx`).

## Recipe

`packages/extension/tools/recipe-forge-grappe.ts` replays the production
pipeline against real orgs (sf CLI tokens). Configure `SCENARIO`:

```ts
const SCENARIO = {
  sourceAlias: 'SOURCE-UAT',
  targetAlias: 'TARGET-DEV',
  recordId: '500XX00000000001AAA',
  depth: 'custom',
  customDepth: 5,
  anonymizePII: true,
  skipEmpty: true,
  apiVersion: '66.0',
  dryRun: true,        // flip to false to run Wave 3 against the target
  maxRecordsPerObject: 5,
};
```

Run with:

```bash
pnpm --filter @sandforge/extension exec tsx tools/recipe-forge-grappe.ts
```

## Known limitations

- **IN clause chunking**: at 4 000+ IDs per IN, Salesforce rejects the
  query. Not a concern for typical record-graph clones (rarely >200 IDs
  per object) but to be added before raw-graph mode.
- **FLS profile awareness**: `Asset.RecordType ID not valid for the user`
  errors come from the running user's profile lacking access. The cloner
  reports them; resolution is org-side (assign permission set).
