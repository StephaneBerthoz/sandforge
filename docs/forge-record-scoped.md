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
`WHERE FK IN (cachedParentIds)`. In a dry run on an internal test dataset
built around one Case, the scoped plan read under 1 000 records where the
unscoped one read about 262 000. That is one measurement on one dataset, not
a guaranteed ratio: the reduction depends on how wide the root's graph is.

The catalog is the exception to "children through reverse-lookup". A price
book, a product, a selling model or a price that the clone only reaches
through a lookup (an opportunity's price book, a line item's price) is cloned
for what points at it and brings none of the rows under it: it is read once
those records have been read, and the clone takes the prices its line items
use, the standard price of each of their products under the same selling
model, those products and their selling model options, the selling models
and the books the prices belong to. It writes them in the order the platform
takes them: products and selling models, their options, standard prices,
custom prices, then the lines. A clone rooted at a price book or a product
still reads the prices under it.

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
       ├─ before the node loop: isObjectCreatable for every included object
       │    (target), six describes in flight at a time. An object the target
       │    refuses is skipped and reported; a check that failed is reported
       │    for that object, which is still attempted.
       │
       ├─ for each node (root-first, then topo):
       │    1. describeFields (source + target → intersect createable)
       │    2. ScopedSoqlBuilder.build → SOQL with WHERE (split into several
       │       statements when the ID lists outgrow one query URI)
       │    3. queryRecords(source) per statement, rows merged by Id
       │    4. (if reference-data object) ReferenceDataMapper.resolve(target by Name)
       │    5. seed cache (own IDs + FK values from results)
       │    6. clean records:
       │         - strip non-createable
       │         - strip Person Account __pc on Business Accounts
       │         - strip Name on Person Accounts (auto-computed)
       │         - strip picklist values not in target whitelist
       │         - omit nullified orphan FKs (don't send `null`)
       │         - apply RecordType mapping (DeveloperName)
       │    7. batch insert into target
       │
       ├─ with `files`: before the first write, the files of the records read
       │    (the latest version of each document linked to one, and the
       │    attachments under them) are chosen, and their total checked
       │    against the target's FileStorageMB; after the records, each file
       │    is read and written in one request of its own (FileCopier)
       │
       └─ summary { successCount, failedCount, skippedCount, errors[], files?,
                    fileContentFieldsLeftOut?, writtenBetween? }
```

A run asked to copy files reads every object before it writes one, whatever
its input mode: the files are measured against the target before anything is
written, which needs every record read. A file is published on the first
cloned record it hangs on and linked to the others; a file over the cap, one
kept outside Salesforce, or one hanging only on records the run did not create
is left out and listed. Each copied file is recorded under its document
(`ContentDocument`) or as an `Attachment`, so removing the run's records
removes it. While the run anonymizes, `files.acceptedAsIs` must say the files
are copied as they are, or the run is refused before it reads anything.

A field whose describe type is `base64` holds a file's content, and a read gives
the address of that content instead. No such field is read or written, on any
object, including an optional parent fetched from outside the graph; the ones
createable on an object with records to write are listed per object in
`fileContentFieldsLeftOut`. Files and attachments never reach the graph: their
content is the files stage's.

Once the run has written, it reads back from the target the `CreatedDate` and
`LastModifiedDate` of every record it created, and keeps the earliest creation
and the latest stamp as `writtenBetween`, a stopped run included. Removing the
run's records compares the org's dates with those, and with the org's time as
the removal starts, never with this machine's clock.

## ExecuteOptions

| Option                 | Default                                  | Effect                                                                         |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| `rootRecordId`         | —                                        | enables scope-aware mode                                                       |
| `rootObjectApiName`    | —                                        | resolved from `recordId` keyPrefix; required with `rootRecordId`               |
| `dryRun`               | `false`                                  | runs every step except `insertRecords`, used by the recipe                     |
| `referenceFallback`    | `'nullify'` (scoped) / `'keep'` (legacy) | what to do with FK fields whose value isn't in the IdRemapper                  |
| `recordTypeMappings`   | built by the extension before each run   | array of `{ sourceId, targetId, developerName }`; built via `RecordTypeMapper` |
| `maxRecordsPerObject`  | — (no cap)                               | append `LIMIT N` to every scoped query                                         |
| `referenceDataObjects` | `['BusinessHours', 'OperatingHours']`    | objects to map by Name instead of cloning                                      |
| `files`                | — (no file read)                         | `{ maxFileBytes, acceptedAsIs }`: copy the files of the cloned records         |

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

- **Large scopes are read in several queries**: a scoped query travels in
  the request URI, which holds roughly 500 quoted IDs. When an object's
  scope is larger — 1 300 Contacts under one Account, or one parent list
  repeated across several FK fields — `ScopedSoqlBuilder` splits the IDs
  over as many statements as needed (each kept under the URI budget, at
  most 500 IDs apiece) and the executor merges the rows, keeping one per
  `Id`. `maxRecordsPerObject` still caps the merged total. The one case
  still refused is an object whose field list alone leaves no room for an
  ID; exclude fields from that object to clone it.
- **Excluded objects**: discovery and orphan-parent expansion share one
  list (`excludedObjects.ts`) — system and hub objects such as `User`,
  `RecordType`, `Queue`, job and log tables (`AsyncApexJob`, `CronTrigger`,
  `LoginHistory`), history / feed / share / change-event variants, and
  every Vlocity package object (`vlocity_*` namespaces). Files are never
  nodes either: `Attachment`, `ContentVersion`, `Document`,
  `ContentDocument` and `ContentDocumentLink` are left out, and the `files`
  option copies files in a stage of its own.
- **FLS profile awareness**: `Asset.RecordType ID not valid for the user`
  errors come from the running user's profile lacking access. The cloner
  reports them; resolution is org-side (assign permission set).
