# Phase 4: Robustness -- Research

**Researched:** 2026-03-18
**Phase goal:** Handle real-world scale and failure modes gracefully.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Retry logic | Use existing `RetryStrategy` + `ErrorClassifier` from core/engine/ | Already implements exponential backoff with jitter, configurable params, and SF error classification. Do NOT rewrite. |
| Bulk API job lifecycle | Use existing `BulkApiManager` from core/engine/ | Already tracks jobs, handles concurrent limits, polls for completion. Wrap it, don't replace it. |
| Field validation | Use existing `SchemaValidator` from modules/sync/ | Already validates required fields, max length, picklist values, type checks. Extend for type compatibility, don't rebuild. |
| Timeout with abort | Use `AbortController` + `Promise.race` pattern | Standard JS/Node pattern. jsforce supports abort signals on connections. |

## Common Pitfalls

### Pitfall 1: BulkApiManager expects CSV, jsforce Bulk 2.0 expects records
**What goes wrong:** BulkApiManager.upload() might expect CSV strings, but jsforce Bulk 2.0 API can accept JSON records directly.
**How to avoid:** Check jsforce v2 Bulk API interface. Use `job.open()` → `job.uploadData(records)` → `job.close()` → poll. Let jsforce handle serialization.

### Pitfall 2: RetryStrategy wraps entire batch, not individual records
**What goes wrong:** If a batch of 200 records fails due to UNABLE_TO_LOCK_ROW on one record, retrying the entire batch is inefficient and may hit the same lock.
**How to avoid:** For record-level errors, extract failed records from SaveResult, retry only those. For connection-level errors (SERVER_UNAVAILABLE), retry the entire batch.

### Pitfall 3: AbortController not propagated to jsforce
**What goes wrong:** Creating a timeout with setTimeout + reject doesn't actually cancel the HTTP request. The SF API call continues running server-side.
**How to avoid:** Pass AbortSignal to jsforce connection options if supported, or at minimum cancel the Promise and clean up resources. Check jsforce docs for abort support.

### Pitfall 4: SchemaValidator expects FieldSchema[], handlers have SObjectField[]
**What goes wrong:** SchemaValidator uses its own FieldSchema type. The describe results from jsforce return a different shape.
**How to avoid:** Create a mapping function: `toFieldSchema(describeField: DescribeSObjectResult.Field): FieldSchema`. Map apiName, type, length, nillable, picklistValues.

### Pitfall 5: Bulk API polling blocks the event loop
**What goes wrong:** Tight polling loop for bulk job status (while loop with await) blocks other message handling.
**How to avoid:** Use setTimeout-based polling with configurable interval (default 5s). Send progress updates to webview between polls.

### Pitfall 6: Timeout config not validated before use
**What goes wrong:** User sets timeout to 0 or negative number via ConfigStore, causing immediate timeout on all operations.
**How to avoid:** Zod schema with `.min(1000)` for all timeout values. Fallback to defaults on invalid config.

## Existing Patterns in This Codebase

- **DomainHandler pattern:** All handlers implement `handle(msg: BaseMessage): Promise<boolean>` with type-set dispatch
- **buildResponse():** Standard response builder with correlationId propagation
- **ConfigStore categories:** 'forge', 'ai', 'settings' -- add 'robustness' for timeout/retry config
- **Operation progress:** `operation:started` / `operation:completed` / `operation:failed` dual dispatch pattern
- **Winston logger:** `this.deps.logger.info/warn/error()` for all logging

## Key Files by Requirement

| Requirement | Primary files to modify | New files to create |
|-------------|------------------------|---------------------|
| ROB-01 (Bulk API) | SeedOpsHandler.ts, SyncOpsHandler.ts | BulkApiExecutor.ts, BulkApiExecutor.test.ts |
| ROB-02 (Retry) | SeedOpsHandler.ts, SyncOpsHandler.ts | RetryableOperation.ts, RetryableOperation.test.ts |
| ROB-03 (Timeout) | SeedOpsHandler.ts, SyncOpsHandler.ts, ConnectionHelper.ts | TimeoutManager.ts, TimeoutManager.test.ts, robustness-config.schema.ts |
| ROB-04 (Field validation) | SyncOpsHandler.ts, DataSync.ts | FieldTypeValidator.ts, FieldTypeValidator.test.ts |

## Recommended Approach

Phase 4 is primarily an integration phase -- the building blocks exist. Two natural plans:

**Plan 01 (Infrastructure):** Create the 3 new utilities (RetryableOperation, TimeoutManager, BulkApiExecutor) + Zod schema + FieldTypeValidator. All are independent of each other and testable in isolation.

**Plan 02 (Integration):** Wire all 4 utilities into SeedOpsHandler, SyncOpsHandler, and DataSync. This depends on Plan 01 since it uses the new utilities.

Plans are sequential (Wave 1 → Wave 2) because integration depends on infrastructure.

---
*Phase: 04-robustness*
*Research completed: 2026-03-18*
