# Phase 01: Persistence & Templates Foundation -- Research

**Researched:** 2026-03-26
**Phase goal:** Establish config persistence for sync configs and seed templates, wizard draft auto-save, and 3 pre-built seed templates. Everything else in v1.2.2 depends on this.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Config persistence backend | Use existing `ConfigStore` + `MementoConfigStoreBackend` | Already wired to VSCode `globalState`, tested, used by AlertStateStore, GovernancePolicyStore, OrgRegistry, TrendStorage, AuditTrailService. No new persistence layer needed. |
| Webview draft persistence across refresh | Use `vscode.getState()` / `vscode.setState()` via existing `useVSCodeApi` hook | Already available in the webview. This is the VSCode-native way to survive webview panel reloads. Do NOT use `localStorage`/`sessionStorage` (unreliable in webview context). Do NOT send drafts to extension-side ConfigStore (latency, complexity). |
| UUID generation | Use `crypto.randomUUID()` | Already used throughout the codebase (SeedOpsHandler, useSyncPageData). |

## Common Pitfalls

### Pitfall 1: ConfigStore key collisions between modules
**What goes wrong:** Two modules using the same key prefix will overwrite each other's data. The ConfigStore is a flat key-value store with category as metadata only.
**Why:** `ConfigStore.set(key, value, category)` uses the key as the unique identifier across ALL categories. Two entries with the same key but different categories will collide.
**How to avoid:** Use distinct, namespaced key prefixes. Follow the established pattern:
- AlertStateStore uses `alert:state:` prefix, `alerts` category
- GovernancePolicyStore likely uses `governance:` prefix
- OrgRegistry uses `org.` prefix, `orgs` category
- TrendStorage uses its own key pattern, `trends` category

Recommended: `sync:config:{id}` with category `syncConfigs`, `seed:template:{id}` with category `seedTemplates`, `sync:draft` with category `syncDrafts`.

### Pitfall 2: SeedTemplateManager is in-memory only -- data lost on extension restart
**What goes wrong:** `SeedTemplateManager` stores templates in a `Map<string, SeedTemplate>`. When the extension host restarts, all templates are gone.
**Why:** It was built as MVP with no persistence backend.
**How to avoid:** Create a `SeedTemplateStore` (thin facade over ConfigStore, same pattern as AlertStateStore) and either:
  - (a) Replace `SeedTemplateManager` internals to delegate to `SeedTemplateStore`, or
  - (b) Create a new `SeedTemplateStore` class that wraps ConfigStore and deprecate the in-memory Map in `SeedTemplateManager`

Option (b) is cleaner -- keep `SeedTemplateManager` for CRUD logic (ID generation, timestamps, duplicate) but back it with `SeedTemplateStore` for persistence.

### Pitfall 3: Wizard draft auto-save must NOT persist sensitive data
**What goes wrong:** Saving the full wizard state (including orgId tokens, connection details) to `vscode.setState()` creates a security risk.
**Why:** `setState` data is persisted in VSCode's internal state file, which can be backed up or synced.
**How to avoid:** Only save form-level state (step index, selected objects, field rules, volumes). Do NOT persist org credentials or access tokens. Org IDs are fine (they are just UUIDs).

### Pitfall 4: Pre-built templates must use correct insertOrder for parent-child relationships
**What goes wrong:** If insertOrder is wrong, child records (OpportunityLineItem, CaseComment) will be inserted before parents, causing reference failures.
**Why:** Salesforce requires parent records to exist before children can reference them via lookup/master-detail fields.
**How to avoid:** Use the correct insertion order based on SF_COMMON_RELATIONSHIPS:
- Sales Cloud Starter: Pricebook2(0) -> Product2(1) -> Account(2) -> Contact(3) -> Opportunity(4) -> OpportunityLineItem(5)
  - Note: PricebookEntry is needed between Product2 and OpportunityLineItem but is NOT in the requirements. Standard Pricebook is auto-created by SF.
- Service Cloud Starter: Account(0) -> Contact(1) -> Case(2) -> CaseComment(3) -> Knowledge__kav(4)
  - Knowledge__kav is independent (no FK to Account/Contact/Case) so its order is flexible.
- Minimal Demo: Account(0) -> Contact(1) -> Opportunity(2)

### Pitfall 5: OpportunityLineItem requires PricebookEntry + Pricebook on the Opportunity
**What goes wrong:** Inserting OpportunityLineItem fails with "FIELD_INTEGRITY_EXCEPTION" if the Opportunity has no Pricebook2Id, or if no PricebookEntry exists for the Product2.
**Why:** OpportunityLineItem.PricebookEntryId is a required lookup. The Opportunity itself must have Pricebook2Id set to reference the standard Pricebook2.
**How to avoid:** The Sales Cloud Starter template MUST:
1. Include a static field rule on Pricebook2 to create or reference the Standard Pricebook (IsStandard=true is read-only; use a reference rule)
2. Create PricebookEntry records linking Product2 to Pricebook2
3. Set Opportunity.Pricebook2Id to reference the created Pricebook2
4. Set OpportunityLineItem.PricebookEntryId via reference rule

This is the most complex template. Consider adding PricebookEntry as a 6th object (the requirements list 6 objects but not PricebookEntry explicitly -- the planner should clarify or include it implicitly).

### Pitfall 6: Knowledge__kav requires specific field handling
**What goes wrong:** Knowledge__kav articles require `Title`, `UrlName` (unique slug), and must be published via a separate API call or specific field values.
**Why:** Knowledge articles have a publishing lifecycle (Draft -> Published). Simply inserting records creates drafts only.
**How to avoid:** Use `PublishStatus = 'Online'` and `Language = 'en_US'` as static field rules. Generate unique `UrlName` values with sequence rule (e.g., `kb-article-{n}`).

### Pitfall 7: vscode.setState() replaces state entirely (no merging)
**What goes wrong:** Calling `setState({ syncDraft: ... })` loses previously stored seed draft data.
**Why:** `setState` is a wholesale replacement, not a merge.
**How to avoid:** Always read current state with `getState()` first, spread the existing state, then set the updated version: `setState({ ...getState(), syncDraft: newDraft })`. Consider a helper hook `useWebviewState<T>(key)` that handles this merge pattern.

### Pitfall 8: SyncConfig has orgId UUIDs that become stale
**What goes wrong:** A saved sync config references `sourceOrgId` and `targetOrgId`. If the user disconnects that org, loading the config will fail at execution time.
**Why:** Org connections are ephemeral; configs are persistent.
**How to avoid:** When loading a saved config, validate that referenced orgIds still exist in OrgRegistry. Show a warning in the UI if an org is missing, don't silently fail at execution time.

## Existing Patterns in This Codebase

- **AlertStateStore** (`packages/extension/src/modules/monitor/AlertStateStore.ts`): Exact pattern to follow for domain-specific stores. Thin facade over ConfigStore with dedicated key prefix and category. Constructor takes `ConfigStore`, methods are `save*()/load*()`. Already tested.

- **GovernancePolicyStore** (`packages/extension/src/modules/monitor/GovernancePolicyStore.ts`): Same facade pattern. Confirms this is the established convention.

- **OrgRegistry** (`packages/extension/src/core/connection/OrgRegistry.ts`): Uses `getByCategory('orgs')` to list all entries, `set('org.{id}', org, 'orgs')` to save. Good model for list/get/set/delete operations.

- **ConfigStore.getByCategory()** (`packages/extension/src/core/storage/ConfigStore.ts:64`): Returns `Record<string, unknown>` -- all entries in a category. This is how `list()` operations should work (get all entries in the `syncConfigs` or `seedTemplates` category).

- **ConfigStore.getKeysByPrefix()** (`packages/extension/src/core/storage/ConfigStore.ts:85`): Alternative to `getByCategory()` for listing. Can use `getKeysByPrefix('sync:config:')` to find all sync configs.

- **DomainHandler pattern** (`packages/extension/src/bridge/handlers/`): All bridge handlers implement `DomainHandler { handle(msg): Promise<boolean> }`. New message types for sync config CRUD and seed template CRUD should follow this pattern. Can either extend `SyncOpsHandler`/`SeedOpsHandler` or create new handlers.

- **useBridgeMutation** (`packages/webview/src/hooks/useBridgeMutation.ts`): The webview hook for sending messages and waiting for responses. Used for all write operations. Auto-generates response type as `{requestType}:response`.

- **useSyncPageData** (`packages/webview/src/pages/Sync/useSyncPageData.ts`): All wizard state is `useState` hooks. No persistence. The `setCurrentStep` callback is where auto-save should trigger.

- **useSeedWizardState** (`packages/webview/src/pages/Seed/useSeedWizardState.ts`): Composite hook delegating to 5 sub-hooks. State is entirely in-memory. Same auto-save opportunity on `setCurrentStep`.

- **useFavoritesStore** (`packages/webview/src/stores/useFavoritesStore.ts`): Uses `sessionStorage` for webview-local persistence. This is the WRONG pattern for wizard drafts (sessionStorage is cleared on webview dispose). Use `vscode.setState()` instead.

- **SeedTemplateManager** (`packages/extension/src/modules/seed/SeedTemplateManager.ts`): Has CRUD + `duplicate()` + auto-ID/timestamp generation. Good API shape to preserve, just needs ConfigStore backing.

- **HandlerDeps.configStore** (`packages/extension/src/bridge/handlers/HandlerTypes.ts`): ConfigStore is already injected into ALL handlers via `HandlerDeps`. No additional wiring needed to access it from SyncOpsHandler or SeedOpsHandler.

- **buildResponse / sendHandlerError** (`packages/extension/src/bridge/handlers/HandlerTypes.ts`): Standard response builders. Use these for all new message handlers.

## Key Type Shapes

**SyncConfig** (sync.types.ts): Full config with `id`, `name`, `description`, `sourceOrgId`, `targetOrgId`, `direction`, `mode`, `objects[]`, `conflictStrategy`, `enableRollback`, `dryRun`, `createdAt`, `updatedAt`. This is what gets saved/loaded. No schema changes needed.

**SeedTemplate** (seed.types.ts): Has `id`, `name`, `description`, `version`, `strategy`, `objects[]`, `aiPersona?`, `tags[]`, `createdAt`, `updatedAt`. Each object has `objectApiName`, `recordCount`, `fieldRules[]`, `excludedFields[]`, `insertOrder`, `batchSize`. No schema changes needed.

**FieldRule** (seed.types.ts): `fieldApiName`, `ruleType` (static/random/sequence/formula/reference/picklist_random/ai_generate/faker/regex/from_csv), `config` (FieldRuleConfig with optional values for each rule type). Templates define field rules per object.

## Bridge Message Types Needed

Currently NO CRUD message types exist for sync configs or seed templates. New types needed:

| Message type | Response type | Purpose |
|---|---|---|
| `sync:config:save` | `sync:config:save:response` | Save a named SyncConfig |
| `sync:config:load` | `sync:config:load:response` | Load a SyncConfig by ID |
| `sync:config:list` | `sync:config:list:response` | List all saved SyncConfig summaries |
| `sync:config:delete` | `sync:config:delete:response` | Delete a SyncConfig by ID |
| `seed:template:save` | `seed:template:save:response` | Save a SeedTemplate |
| `seed:template:load` | `seed:template:load:response` | Load a SeedTemplate by ID |
| `seed:template:list` | `seed:template:list:response` | List all SeedTemplate summaries |
| `seed:template:delete` | `seed:template:delete:response` | Delete a SeedTemplate by ID |

These can be added to SyncOpsHandler and SeedOpsHandler respectively (add to their `_TYPES` Sets).

## Recommended Approach

Create two thin store facades (`SyncConfigStore` and `SeedTemplateStore`) following the AlertStateStore pattern, backed by ConfigStore with namespaced keys and dedicated categories. Add CRUD bridge message handling to the existing SyncOpsHandler and SeedOpsHandler. For wizard auto-save, create a `useWebviewPersistedState` hook wrapping `vscode.getState()/setState()` with key-based merging, and integrate it into useSyncPageData and useSeedWizardState to save draft state on step change. Pre-built templates should be defined as static const objects in a new file in `packages/shared/src/constants/` (since they are reusable content) with correct insertOrder, realistic field rules using faker methods, and proper reference rules for parent-child relationships. The Pricebook2/PricebookEntry dependency chain in Sales Cloud Starter is the hardest part and needs careful field rule design.
