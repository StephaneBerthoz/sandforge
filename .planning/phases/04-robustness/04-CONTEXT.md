# Phase 4: Robustness - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Handle real-world scale and failure modes gracefully. Bulk API 2.0 for large datasets, retry with exponential backoff for transient errors, configurable timeouts for long operations, field-type validation before Sync upsert.

</domain>

<decisions>
## Implementation Decisions

### ROB-01: Bulk API 2.0 for > 200 Records
- BulkApiManager already exists (core/engine/BulkApiManager.ts) but is never called
- Create a BulkApiExecutor utility that selects REST vs Bulk API based on record count
- Threshold: 200 records (matches SF REST API max batch size from sf-limits.ts)
- Integrate into SeedOpsHandler (insert path) and SyncOpsHandler (all CRUD paths)
- BulkApiExecutor wraps jsforce Bulk API 2.0: createJob → upload CSV → close → poll → results
- Track progress via existing operation:progress messages for UI feedback
- Respect SF_LIMITS: max 150M records, 100 concurrent jobs, 10MB per batch

### ROB-02: Retry with Exponential Backoff
- RetryStrategy (core/engine/RetryStrategy.ts) and ErrorClassifier (core/engine/ErrorClassifier.ts) already exist
- Create RetryableOperation utility that combines RetryStrategy + ErrorClassifier
- Wrap ALL jsforce CRUD calls in handlers: create, upsert, update, destroy, query
- Also wrap describe-global and describe calls (can fail transiently)
- Retryable errors from ErrorClassifier: UNABLE_TO_LOCK_ROW, REQUEST_LIMIT_EXCEEDED, SERVER_UNAVAILABLE
- Non-retryable: INVALID_FIELD, REQUIRED_FIELD_MISSING, etc. -- fail fast
- Max 3 retries, initial delay 1s, max delay 30s, multiplier 2x (already defaults in RetryStrategy)
- Log retry attempts via Winston logger

### ROB-03: Configurable Timeout
- No per-operation timeout exists currently
- Create TimeoutManager utility with AbortController pattern
- Default timeouts: describe-global 30s, describe 15s, CRUD batch 60s, bulk job 300s
- Store timeout config in ConfigStore with category 'robustness'
- Zod schema for validation in shared package
- Expose via settings message type so webview Settings page can configure
- Fallback to defaults when no user config

### ROB-04: Field-Type Validation Before Upsert
- SchemaValidator (modules/sync/SchemaValidator.ts) exists but is never called in Sync flow
- Create FieldTypeValidator that checks source-to-target field compatibility
- Validate before upsert: type compatibility (string→number fails), length constraints, picklist values
- Pre-flight check in SyncOpsHandler before executing CRUD
- Return validation errors to webview so user sees what's wrong before data is sent
- Use SF_FIELD_TYPES constants for type compatibility matrix

### Claude's Discretion
- RetryableOperation internal API design
- TimeoutManager abort signal propagation pattern
- BulkApiExecutor CSV serialization approach
- Field compatibility matrix specifics

</decisions>

<code_context>
## Existing Code Insights

### Ready to Use (Just Need Integration)
- `RetryStrategy` -- exponential backoff with jitter, configurable, returns RetryResult<T>
- `ErrorClassifier` -- 25+ SF error codes mapped with retryable flag and strategy hints
- `BulkApiManager` -- job lifecycle tracking (create/upload/close/poll/results), 5 concurrent limit
- `SchemaValidator` -- record validation: required fields, max length, picklist, type checks
- `CircuitBreaker` -- 3 failures → open for 30s, prevents cascading failures
- `RateLimiter` -- sliding window (100 req/min default)
- `ConfigStore` -- key-value persistence with categories, JSON serialization

### Integration Points
- `SeedOpsHandler.ts` lines 140-163: insert loop with manual batching, no retry/bulk
- `SyncOpsHandler.ts` lines 168-213: all CRUD operations, manual batching, no retry/bulk
- `DataSync.ts` lines 72-95: applies field mappings, no validation
- `ConnectionHelper.ts`: creates jsforce connections, no per-operation timeout

### Constants Available
- `SF_LIMITS.REST_API_BATCH_SIZE = 200`
- `SF_LIMITS.BULK_API_MAX_RECORDS = 150_000_000`
- `SF_FIELD_TYPES`: 25+ field types with metadata
- `error-codes.ts`: 25 error codes with classifications

</code_context>

<deferred>
## Deferred Ideas

- Real-time retry progress in webview (visual retry counter) -- v1.2
- Per-org timeout profiles -- v1.2
- Bulk API 2.0 streaming for very large datasets (> 10M) -- v2.0

</deferred>

---
*Phase: 04-robustness*
*Context gathered: 2026-03-18*
