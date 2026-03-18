# Plan 04-01 Summary

**Completed:** 2026-03-18
**Phase:** 04 -- Robustness

## What was built

Created 4 standalone robustness utilities that wrap existing but unused building blocks (RetryStrategy, ErrorClassifier, BulkApiManager, SchemaValidator) into handler-ready composable tools. Also created a Zod configuration schema for user-configurable robustness settings (timeouts, retry, bulk thresholds). All utilities are independently testable without Salesforce connections and ready for Plan 02 integration into handlers.

## Key files

- `packages/extension/src/core/engine/RetryableOperation.ts`: Combines RetryStrategy + ErrorClassifier. execute() auto-retries transient errors, fails fast on non-retryable. executeBatch() retries only failed records, not the entire batch.
- `packages/extension/src/core/engine/TimeoutManager.ts`: AbortController-based timeout wrapper. Provides TimeoutError with operation name and duration metadata. Clean promise-based pattern without unhandled rejections.
- `packages/extension/src/core/engine/BulkApiExecutor.ts`: Selects REST vs Bulk API 2.0 based on record count threshold (200). Uses BulkApiManager for job lifecycle tracking. Typed jsforce abstraction for testability.
- `packages/extension/src/modules/sync/FieldTypeValidator.ts`: Type compatibility matrix for 20+ SF field types. Validates field mappings (errors + warnings for lossy conversions) and record values (type, length, required, picklist).
- `packages/shared/src/schemas/robustness-config.schema.ts`: Zod schema with min/max constraints preventing zero/negative timeouts. Defaults applied via parse({}). Exported from shared barrel.

## Decisions made

- RetryableOperation.execute() implements its own retry loop (using RetryStrategy.calculateDelay) instead of delegating to RetryStrategy.execute(), so it can short-circuit non-retryable errors without the outer loop retrying.
- BulkApiExecutor defines typed interfaces (BulkJobHandle, BulkApiConnection) to abstract jsforce internals, making tests fully mockable without jsforce dependency.
- FieldTypeValidator defines its own FieldDescriptor/TargetFieldDescriptor types (per Pitfall 4) instead of depending on SchemaValidator's FieldSchema, keeping the two validators independent.
- TimeoutManager uses a single-promise pattern (not Promise.race with two concurrent promises) to avoid unhandled rejection warnings in test environments.

## Deviations from plan

- Plan suggested RetryableOperation.execute() delegate to RetryStrategy.execute() with classification inside the callback. This caused non-retryable errors to still be retried by the outer loop. Changed to manual retry loop using RetryStrategy.calculateDelay() for correct short-circuit behavior.
- Plan's must-have says "FieldTypeValidator uses SchemaValidator for record-level validation". Per Pitfall 4 from research, FieldTypeValidator defines its own simpler input types and implements its own record validation to avoid coupling to SchemaValidator's FieldSchema type. Both validators can be used independently.
- BulkApiExecutor does not import BulkJobOptions type from BulkApiManager (it doesn't exist as an export used for operation type). Instead defines its own BulkOperation type alias.

## Notes for downstream

- Plan 02 should wire these utilities into SeedOpsHandler and SyncOpsHandler.
- RetryableOperation.executeBatch expects the batch function to return { successes, failures } with SalesforceApiError-shaped errors for classification.
- BulkApiExecutor.executeBulk expects a BulkApiConnection interface -- the handler will need to wrap jsforce.Connection to match this interface.
- RobustnessConfigSchema should be stored in ConfigStore under category 'robustness'.
- FieldTypeValidator.validateMapping produces both errors (blocking) and warnings (lossy conversions) -- the handler should surface warnings to the user but not block execution.
