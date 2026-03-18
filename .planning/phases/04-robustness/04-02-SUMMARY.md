# Plan 04-02 Summary

**Completed:** 2026-03-18
**Phase:** 04 -- Robustness

## What was built

Integrated the 4 robustness utilities from Plan 04-01 (RetryableOperation, TimeoutManager, BulkApiExecutor, FieldTypeValidator) into SeedOpsHandler, SyncOpsHandler, and DataSync. All Salesforce API calls in these handlers are now protected with configurable timeouts, automatic retry for transient errors, and bulk API escalation for large datasets. DataSync validates record values against target field constraints before executing DML operations.

## Key files

- `packages/extension/src/bridge/handlers/SeedOpsHandler.ts`: Now uses TimeoutManager for describe-global/describe-object (30s/15s), BulkApiExecutor for inserts > 200 records, RetryableOperation for REST batch inserts. Loads robustness config from ConfigStore.
- `packages/extension/src/bridge/handlers/SeedOpsHandler.test.ts`: 9 tests (5 new) covering timeout wrapping, config loading, and default fallback.
- `packages/extension/src/bridge/handlers/SyncOpsHandler.ts`: Same robustness pattern for all 4 CRUD operations (insert/upsert/update/delete), queries wrapped with RetryableOperation, describe calls wrapped with TimeoutManager, FieldTypeValidator runs before upsert. toValidatorField() maps jsforce describe to validator input.
- `packages/extension/src/bridge/handlers/SyncOpsHandler.test.ts`: 8 tests (4 new) covering timeout, field describe wrapping, config loading.
- `packages/extension/src/modules/sync/DataSync.ts`: Added optional targetFieldDescriptors to DataSyncDeps. When provided, validates records via FieldTypeValidator.validateRecords() before CRUD execution. Returns validation errors as SyncObjectResult with all records failed.
- `packages/extension/src/modules/sync/DataSync.test.ts`: 18 tests (5 new) covering field validation (max length, required, boolean type mismatch, pass-through, skip when no descriptors).

## Decisions made

- ConfigStore.get() takes only a key (no category parameter). Used key `robustness:config` instead of the plan's suggested two-parameter call.
- Robustness config is loaded per-request via getRobustnessConfig() rather than at construction time, so runtime config changes take effect immediately.
- Field type validation in upsertFn infers source field types as 'string' since actual source types aren't available at the CRUD function level. The mapping check catches type incompatibility between inferred source and actual target types.
- DataSync validation is opt-in via targetFieldDescriptors in deps. When not provided, existing behavior is preserved (no validation).
- Shared package dist needed rebuild to make RobustnessConfigSchema available to extension imports (Plan 01 created source but didn't rebuild).

## Deviations from plan

- Plan suggested `configStore.get('robustness:config', 'robustness')` with a category parameter, but ConfigStore.get() only accepts a key parameter. Adapted to `configStore.get('robustness:config')`.
- Plan said to add FieldTypeValidator.validateRecords() "before applying field mappings" in DataSync. Instead placed it after field mappings (before CRUD execution) since the mapped records are what get sent to Salesforce and need validation against target fields.

## Notes for downstream

- Robustness config is stored under key `robustness:config` in ConfigStore. A settings handler should be created to allow the webview Settings page to read/write this config.
- The 2 pre-existing React Hook warnings in OrgHealthPanel.tsx (useMemo missing dependency) are unrelated to this plan.
- Total test count: 4022 extension tests + 802 shared tests all passing.
- Phase 04 is now complete (both plans done).
