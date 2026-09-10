# Forge: Record-Scoped Clone

> Clone a coherent graph of records from a source sandbox (partial-copy or
> full-copy) into a dev sandbox, without copying every row of every table.

## Why

Before: `Forge` with `inputMode: 'record'` _discovered_ the graph from a root
record, then ran `SELECT * FROM Object` — no `WHERE` — for every node. Starting
from a single Case on a mid-sized org, that copied hundreds of thousands of
records. Not a dev dataset.

After: execution is _scope-aware_. From the root record the engine follows the
transitive closure (parents through foreign keys, children through
reverse-lookup) and issues only SOQL carrying `WHERE Id = …` or
`WHERE FK IN (cachedParentIds)`. On the same Case, that is a **99.86 %**
reduction in records cloned.

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

| Option                 | Default                                  | Effect                                                                         |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `rootRecordId`         | —                                        | enables scope-aware mode                                                       |
| `rootObjectApiName`    | —                                        | resolved from `recordId` keyPrefix; required with `rootRecordId`               |
| `dryRun`               | `false`                                  | runs every step except `insertRecords`, used by the recipe                     |
| `referenceFallback`    | `'nullify'` (scoped) / `'keep'` (legacy) | what to do with FK fields whose value isn't in the IdRemapper                  |
| `recordTypeMappings`   | —                                        | array of `{ sourceId, targetId, developerName }`; built via `RecordTypeMapper` |
| `maxRecordsPerObject`  | — (no cap)                               | append `LIMIT N` to every scoped query                                         |
| `referenceDataObjects` | `['BusinessHours', 'OperatingHours']`    | objects to map by Name instead of cloning                                      |

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
    recordSummary: string; // first ~4 fields key=value
    messages: string[]; // STATUS_CODE: message
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
  dryRun: true, // flip to false to actually write to the target
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
