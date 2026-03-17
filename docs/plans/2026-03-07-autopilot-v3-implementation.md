# SandForge v3.0 "Autopilot" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 49 review issues, create the TypedEventEmitter foundation, build the Autopilot module (schema scanner, dependency graph, compliance engine, smart anonymizer, executor), and build the Tesla Control Panel WebView UI with ReactFlow live graph.

**Architecture:** Autopilot is a high-level orchestrator composing existing modules (DependencyResolver, SyncOrchestrator, PIIDetector, BatchProcessor, BulkApiManager, CheckpointManager). New types/schemas go in shared, new module in extension/modules/autopilot/, new UI pages in webview/pages/Autopilot/. TypedEventEmitter replaces manual listener patterns across 5+ classes.

**Tech Stack:** TypeScript strict, Zod, Vitest, React 18, ReactFlow 11, Zustand 4, Tailwind, Framer Motion, jsforce v3, Winston

**Design Doc:** `docs/plans/2026-03-07-autopilot-v3-design.md`

---

## Phase 1: Foundation Fixes (shared package)

### Task 1: Fix utility edge cases (sf-utils, format-utils, string-utils, validation-utils)

**Files:**
- Modify: `packages/shared/src/utils/sf-utils.ts:36-38,70-72`
- Modify: `packages/shared/src/utils/format-utils.ts:9-15`
- Modify: `packages/shared/src/utils/string-utils.ts:9-12`
- Modify: `packages/shared/src/utils/validation-utils.ts:63-66`
- Modify: `packages/shared/src/utils/sf-utils.test.ts`
- Modify: `packages/shared/src/utils/format-utils.test.ts`
- Modify: `packages/shared/src/utils/string-utils.test.ts`
- Modify: `packages/shared/src/utils/validation-utils.test.ts`

**Step 1: Write failing tests for all 5 util fixes**

```typescript
// sf-utils.test.ts — ADD these tests
describe('isValidApiName', () => {
  it('should accept namespaced custom objects', () => {
    expect(isValidApiName('ns__MyObject__c')).toBe(true);
  });
  it('should accept custom metadata types', () => {
    expect(isValidApiName('Config__mdt')).toBe(true);
  });
  it('should accept platform events', () => {
    expect(isValidApiName('OrderEvent__e')).toBe(true);
  });
  it('should accept big objects', () => {
    expect(isValidApiName('Archive__b')).toBe(true);
  });
});

describe('estimateApiCalls', () => {
  it('should throw on batchSize = 0', () => {
    expect(() => estimateApiCalls(100, 0)).toThrow('batchSize must be a positive number');
  });
  it('should throw on negative batchSize', () => {
    expect(() => estimateApiCalls(100, -5)).toThrow('batchSize must be a positive number');
  });
  it('should return 0 for recordCount <= 0', () => {
    expect(estimateApiCalls(0, 200)).toBe(0);
  });
});

// format-utils.test.ts — ADD
describe('formatBytes edge cases', () => {
  it('should handle negative values', () => {
    expect(formatBytes(-1024)).toBe('-1.0 KB');
  });
  it('should clamp index for very large values', () => {
    const result = formatBytes(1e18);
    expect(result).toMatch(/TB$/);
  });
});

// string-utils.test.ts — ADD
describe('truncate edge cases', () => {
  it('should return empty string for maxLength <= 0', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(truncate('hello', -5)).toBe('');
  });
  it('should return ellipsis for maxLength = 1', () => {
    expect(truncate('hello', 1)).toBe('\u2026');
  });
});

// validation-utils.test.ts — ADD
describe('isValidCron extended', () => {
  it('should accept named days', () => {
    expect(isValidCron('0 12 * * MON')).toBe(true);
  });
  it('should accept L/W/# characters', () => {
    expect(isValidCron('0 0 L * *')).toBe(true);
  });
  it('should accept 6 and 7 field cron (Salesforce/Quartz)', () => {
    expect(isValidCron('0 0 12 * * ?')).toBe(true);
    expect(isValidCron('0 0 12 ? * MON-FRI *')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test -- --reporter=verbose 2>&1 | head -60`
Expected: FAIL for all new tests

**Step 3: Implement fixes**

```typescript
// sf-utils.ts:36-38 — REPLACE isValidApiName
export function isValidApiName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(__[a-zA-Z][a-zA-Z0-9]*)?$/.test(name);
}

// sf-utils.ts:70-72 — REPLACE estimateApiCalls
export function estimateApiCalls(recordCount: number, batchSize: number): number {
  if (batchSize <= 0) {
    throw new Error('batchSize must be a positive number');
  }
  if (recordCount <= 0) return 0;
  return Math.ceil(recordCount / batchSize);
}

// format-utils.ts:9-15 — REPLACE formatBytes
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// string-utils.ts:9-12 — REPLACE truncate
export function truncate(str: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (str.length <= maxLength) return str;
  if (maxLength === 1) return '\u2026';
  return str.slice(0, maxLength - 1) + '\u2026';
}

// validation-utils.ts:63-66 — REPLACE isValidCron
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return (
    (parts.length >= 5 && parts.length <= 7) &&
    parts.every((p) => /^[\dA-Za-z*,\-/?LW#]+$/.test(p))
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm test -- --reporter=verbose`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/shared/src/utils/
git commit -m "$(cat <<'EOF'
fix(shared): harden utility edge cases

- isValidApiName: accept namespace, __mdt, __e, __b suffixes
- estimateApiCalls: throw on batchSize <= 0, return 0 for recordCount <= 0
- formatBytes: handle negatives, clamp index for huge values
- truncate: handle maxLength <= 0
- isValidCron: support 5-7 fields, named days, L/W/# chars

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Align Zod schemas with types (pipeline, sync, seed, grappe, settings)

**Files:**
- Modify: `packages/shared/src/schemas/pipeline.schema.ts:4-15,29-36,47-53`
- Modify: `packages/shared/src/schemas/sync-config.schema.ts:47-55`
- Modify: `packages/shared/src/schemas/seed-config.schema.ts:4-20`
- Modify: `packages/shared/src/schemas/grappe.schema.ts:4-11`
- Modify: `packages/shared/src/schemas/settings.schema.ts:36-42,53-60`
- Modify: `packages/shared/src/schemas/pipeline.schema.test.ts`
- Modify: `packages/shared/src/schemas/sync-config.schema.test.ts`
- Modify: `packages/shared/src/schemas/seed-config.schema.test.ts`
- Modify: `packages/shared/src/schemas/grappe.schema.test.ts`
- Modify: `packages/shared/src/schemas/settings.schema.test.ts` (create if missing)

**Step 1: Write failing tests**

```typescript
// pipeline.schema.test.ts — ADD
describe('pipelineStepTypeEnum alignment', () => {
  it('should accept all PipelineStepType values', () => {
    const types = ['seed','sync','backup','restore','anonymize','delete','compare','precheck','script','notification','approval','delay','condition','loop','parallel'];
    for (const t of types) {
      expect(pipelineStepTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it('should reject old removed values', () => {
    expect(pipelineStepTypeEnum.safeParse('query').success).toBe(false);
    expect(pipelineStepTypeEnum.safeParse('transform').success).toBe(false);
  });
});

describe('pipelineTriggerTypeEnum alignment', () => {
  it('should accept all TriggerType values', () => {
    const types = ['manual','schedule','event','webhook','sandbox_refresh','deployment_complete'];
    for (const t of types) {
      expect(pipelineTriggerTypeEnum.safeParse(t).success).toBe(true);
    }
  });
});

describe('pipelineVariableTypeEnum alignment', () => {
  it('should accept secret', () => {
    expect(pipelineVariableTypeEnum.safeParse('secret').success).toBe(true);
  });
  it('should reject removed values', () => {
    expect(pipelineVariableTypeEnum.safeParse('date').success).toBe(false);
    expect(pipelineVariableTypeEnum.safeParse('json').success).toBe(false);
  });
});

// grappe.schema.test.ts — ADD
describe('backPressureConfigSchema refinement', () => {
  it('should reject lowWaterMark >= highWaterMark', () => {
    const result = backPressureConfigSchema.safeParse({
      enabled: true, maxQueueDepth: 3, highWaterMark: 10, lowWaterMark: 90,
      strategy: 'pause', monitoringInterval: 5000,
    });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm test -- --reporter=verbose 2>&1 | head -80`

**Step 3: Implement schema fixes**

```typescript
// pipeline.schema.ts:4-15 — REPLACE pipelineStepTypeEnum
export const pipelineStepTypeEnum = z.enum([
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'compare',
  'precheck',
  'script',
  'notification',
  'approval',
  'delay',
  'condition',
  'loop',
  'parallel',
]);

// pipeline.schema.ts:29-36 — REPLACE pipelineTriggerTypeEnum
export const pipelineTriggerTypeEnum = z.enum([
  'manual',
  'schedule',
  'event',
  'webhook',
  'sandbox_refresh',
  'deployment_complete',
]);

// pipeline.schema.ts:47-53 — REPLACE pipelineVariableTypeEnum
export const pipelineVariableTypeEnum = z.enum([
  'string',
  'number',
  'boolean',
  'secret',
]);

// sync-config.schema.ts:47-55 — REPLACE syncObjectConfigSchema
export const syncObjectConfigSchema = z.object({
  objectApiName: z.string().min(1),
  externalIdField: z.string().optional(),
  operation: z.enum(['insert', 'update', 'upsert', 'delete']),
  query: z.string().optional(),
  fieldMappings: z.array(fieldMappingSchema),
  transformRules: z.array(transformRuleSchema),
  excludedFields: z.array(z.string()),
  addOnFields: z.array(z.object({
    fieldApiName: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
    overwriteExisting: z.boolean(),
  })).default([]),
  batchSize: z.number().int().positive().default(200),
  orderBy: z.string().optional(),
  where: z.string().optional(),
  insertOrder: z.number().int().nonnegative().default(0),
});

// seed-config.schema.ts:4-20 — ADD minLength/maxLength after maxValue line
// Insert after line 17 (maxValue):
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),

// grappe.schema.ts:4-11 — ADD .refine() after closing })
export const backPressureConfigSchema = z.object({
  enabled: z.boolean(),
  maxQueueDepth: z.number().int().positive().default(3),
  highWaterMark: z.number().min(0).max(100).default(80),
  lowWaterMark: z.number().min(0).max(100).default(60),
  strategy: z.enum(['pause', 'throttle', 'drop_priority']),
  monitoringInterval: z.number().positive().default(5000),
}).refine(
  (data) => data.lowWaterMark < data.highWaterMark,
  { message: 'lowWaterMark must be less than highWaterMark', path: ['lowWaterMark'] },
);

// settings.schema.ts:36-42 — ADD 'merge' to conflictStrategy
// Change line with defaultConflictStrategy to:
defaultConflictStrategy: z.enum(['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge']).default('source_wins'),

// settings.schema.ts:53-60 — ADD missing sections (monitor, cli, resilience, onboarding)
// Add before settingsSchema:
export const monitorSettingsSchema = z.object({
  refreshInterval: z.number().int().positive().default(60000),
  alertCooldownMinutes: z.number().int().positive().default(15),
  maxHistoryDays: z.number().int().positive().default(90),
});

export const cliSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  defaultOutputFormat: z.enum(['json', 'table', 'csv', 'html']).default('table'),
  colorOutput: z.boolean().default(true),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('normal'),
});

export const resilienceSettingsSchema = z.object({
  offlineMode: z.boolean().default(false),
  checkpointInterval: z.number().int().positive().default(30000),
  checkpointRetention: z.number().int().positive().default(7),
  autoRecoveryPrompt: z.boolean().default(true),
});

export const onboardingSettingsSchema = z.object({
  showWelcome: z.boolean().default(true),
  showTips: z.boolean().default(true),
  completedSteps: z.array(z.string()).default([]),
});

// REPLACE settingsSchema
export const settingsSchema = z.object({
  general: generalSettingsSchema.default({}),
  connection: connectionSettingsSchema.default({}),
  seed: seedSettingsSchema.default({}),
  sync: syncSettingsSchema.default({}),
  monitor: monitorSettingsSchema.default({}),
  security: securitySettingsSchema.default({}),
  grappe: grappeConfigSchema.optional(),
  cli: cliSettingsSchema.default({}),
  resilience: resilienceSettingsSchema.default({}),
  onboarding: onboardingSettingsSchema.default({}),
});
```

**Step 4: Run tests**

Run: `cd packages/shared && pnpm test -- --reporter=verbose`
Expected: ALL PASS

**Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: no errors

**Step 6: Commit**

```bash
git add packages/shared/src/schemas/
git commit -m "$(cat <<'EOF'
fix(shared): align all Zod schemas with TypeScript types

- pipeline: sync stepType/triggerType/variableType enums with automation.types
- sync-config: add 5 missing fields (query, addOnFields, orderBy, where, insertOrder)
- seed-config: add minLength/maxLength to fieldRuleConfig
- grappe: add lowWaterMark < highWaterMark refinement
- settings: add monitor/cli/resilience/onboarding schemas, add 'merge' conflict strategy

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Extension Core Fixes

### Task 3: Create TypedEventEmitter + refactor emit patterns

**Files:**
- Create: `packages/extension/src/core/common/TypedEventEmitter.ts`
- Create: `packages/extension/src/core/common/TypedEventEmitter.test.ts`
- Modify: `packages/extension/src/core/connection/OrgManager.ts:31-35`
- Modify: `packages/extension/src/core/notifications/NotificationCenter.ts:33,142-146`
- Modify: `packages/extension/src/core/engine/ExecutionPipeline.ts:228-232`

**Step 1: Write TypedEventEmitter test**

```typescript
// TypedEventEmitter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from './TypedEventEmitter.js';

type TestEvents = {
  added: { id: string };
  removed: { id: string };
};

class TestEmitter extends TypedEventEmitter<TestEvents> {
  fire<K extends keyof TestEvents>(type: K, event: TestEvents[K]): void {
    this.emit(type, event);
  }
}

describe('TypedEventEmitter', () => {
  it('should notify all listeners for a specific event type', () => {
    const emitter = new TestEmitter();
    const l1 = vi.fn();
    const l2 = vi.fn();
    emitter.on('added', l1);
    emitter.on('added', l2);
    emitter.fire('added', { id: '1' });
    expect(l1).toHaveBeenCalledWith({ id: '1' });
    expect(l2).toHaveBeenCalledWith({ id: '1' });
  });

  it('should not cross-notify different event types', () => {
    const emitter = new TestEmitter();
    const addedListener = vi.fn();
    const removedListener = vi.fn();
    emitter.on('added', addedListener);
    emitter.on('removed', removedListener);
    emitter.fire('added', { id: '1' });
    expect(addedListener).toHaveBeenCalledTimes(1);
    expect(removedListener).not.toHaveBeenCalled();
  });

  it('should isolate listener errors', () => {
    const emitter = new TestEmitter();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const safe = vi.fn();
    emitter.on('added', throwing);
    emitter.on('added', safe);
    emitter.fire('added', { id: '1' });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(safe).toHaveBeenCalledTimes(1);
  });

  it('should support unsubscribe via returned function', () => {
    const emitter = new TestEmitter();
    const listener = vi.fn();
    const unsub = emitter.on('added', listener);
    unsub();
    emitter.fire('added', { id: '1' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('should support removeAllListeners', () => {
    const emitter = new TestEmitter();
    const l1 = vi.fn();
    emitter.on('added', l1);
    emitter.on('removed', l1);
    emitter.removeAllListeners();
    emitter.fire('added', { id: '1' });
    emitter.fire('removed', { id: '1' });
    expect(l1).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- TypedEventEmitter --reporter=verbose`
Expected: FAIL (file doesn't exist)

**Step 3: Implement TypedEventEmitter**

```typescript
// TypedEventEmitter.ts
import { logger } from '../../logger.js';

type Listener<T> = (event: T) => void;

/**
 * Type-safe event emitter with listener isolation.
 * Listeners that throw do not prevent subsequent listeners from executing.
 */
export class TypedEventEmitter<TEventMap extends Record<string, unknown>> {
  private readonly listenerMap = new Map<keyof TEventMap, Set<Listener<never>>>();

  /** Subscribe to an event type. Returns an unsubscribe function. */
  on<K extends keyof TEventMap>(type: K, listener: Listener<TEventMap[K]>): () => void {
    let listeners = this.listenerMap.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listenerMap.set(type, listeners);
    }
    listeners.add(listener as Listener<never>);
    return () => {
      listeners!.delete(listener as Listener<never>);
    };
  }

  /** Emit an event to all listeners of that type. Errors are isolated. */
  protected emit<K extends keyof TEventMap>(type: K, event: TEventMap[K]): void {
    const listeners = this.listenerMap.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        (listener as Listener<TEventMap[K]>)(event);
      } catch (err) {
        logger.warn('Event listener threw an error', {
          eventType: String(type),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Remove all listeners for all event types. */
  removeAllListeners(): void {
    this.listenerMap.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- TypedEventEmitter --reporter=verbose`
Expected: ALL PASS

**Step 5: Refactor OrgManager to use TypedEventEmitter**

Read OrgManager.ts first, then replace the manual emit pattern. Change the `listeners` array and `emit` method to use `TypedEventEmitter`. Update `onEvent` to delegate to `on`. Update `clear()` to emit `removed` events.

```typescript
// OrgManager.ts — Replace emit (lines 31-35) with TypedEventEmitter
// Replace clear() (lines 84-86) with:
clear(): void {
  const orgIds = Array.from(this.orgs.keys());
  this.orgs.clear();
  for (const orgId of orgIds) {
    this.emit('removed', { type: 'removed', orgId });
  }
}
```

**Step 6: Refactor NotificationCenter and ExecutionPipeline similarly**

Apply the same pattern: extend TypedEventEmitter, remove manual listener arrays and emit methods, change `idCounter` to static in NotificationCenter.

**Step 7: Run all extension tests**

Run: `cd packages/extension && pnpm test -- --reporter=verbose`
Expected: ALL PASS

**Step 8: Commit**

```bash
git add packages/extension/src/core/
git commit -m "$(cat <<'EOF'
refactor(extension): introduce TypedEventEmitter, fix listener isolation

- New TypedEventEmitter with try/catch isolation + type-safe events
- Refactor OrgManager, NotificationCenter, ExecutionPipeline to extend it
- OrgManager.clear() now emits 'removed' events
- NotificationCenter.idCounter now static
- ExecutionPipeline.addStep() blocked after start

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Fix SecretVault, BatchProcessor, ExecutionPipeline

**Files:**
- Modify: `packages/extension/src/core/storage/SecretVault.ts:45-51`
- Modify: `packages/extension/src/core/engine/BatchProcessor.ts:54-59`
- Modify: `packages/extension/src/core/engine/ExecutionPipeline.ts:76-78,103-130`
- Modify: corresponding test files

**Step 1: Write regression tests**

```typescript
// SecretVault.test.ts — ADD
it('should return undefined for corrupted JSON', async () => {
  await vault.storeSecret('bad', 'not{valid}json');
  const result = await vault.getObject<{ foo: string }>('bad');
  expect(result).toBeUndefined();
});

// BatchProcessor.test.ts — ADD
it('should handle processor exceptions gracefully in parallel', async () => {
  let callCount = 0;
  const results = await processor.processParallel(
    [1, 2, 3, 4],
    async (batch, index) => {
      callCount++;
      if (index === 0) throw new Error('Simulated failure');
      return { batchIndex: index, totalRecords: batch.length, successCount: batch.length, failureCount: 0, errors: [] };
    },
    2,
  );
  expect(results[0].failureCount).toBe(results[0].totalRecords);
  expect(results[0].errors).toContain('Simulated failure');
});

// ExecutionPipeline.test.ts — ADD
it('should reject addStep after start', () => {
  pipeline.addStep(mockStep);
  pipeline.start();
  expect(() => pipeline.addStep(anotherStep)).toThrow('Cannot add steps');
});
```

**Step 2: Implement fixes**

```typescript
// SecretVault.ts:45-51 — REPLACE getObject
async getObject<T>(key: string): Promise<T | undefined> {
  const raw = await this.getSecret(key);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// BatchProcessor.ts:54-59 — REPLACE runWorker
async function runWorker(): Promise<void> {
  while (nextIndex < batches.length) {
    const index = nextIndex++;
    try {
      results[index] = await processor(batches[index], index);
    } catch (err) {
      results[index] = {
        batchIndex: index,
        totalRecords: batches[index].length,
        successCount: 0,
        failureCount: batches[index].length,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
}

// ExecutionPipeline.ts:76-78 — REPLACE addStep
addStep(step: PipelineStep): void {
  if (this.status !== 'idle') {
    throw new Error('Cannot add steps to a pipeline that has already started');
  }
  this.steps.push(step);
}

// ExecutionPipeline.ts:108-111 — REPLACE inside completeCurrentStep
// Change the forced counts to accept real values:
completeCurrentStep(counts?: { processed: number; success: number; failure: number }): boolean {
  // ... existing guard ...
  const step = this.steps[this.currentStepIndex];
  step.status = 'completed';
  if (counts) {
    step.processedCount = counts.processed;
    step.successCount = counts.success;
    step.failureCount = counts.failure;
  } else {
    step.processedCount = step.recordCount;
    step.successCount = step.recordCount;
  }
  // ... rest unchanged ...
}
```

**Step 3: Run tests, commit**

Run: `cd packages/extension && pnpm test -- --reporter=verbose`

```bash
git add packages/extension/src/core/
git commit -m "$(cat <<'EOF'
fix(extension): SecretVault JSON safety, BatchProcessor error isolation, Pipeline guards

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Fix RetryStrategy, RateLimiter, CircuitBreaker, DependencyResolver, ObjectGraph

**Files:**
- Modify: `packages/extension/src/core/engine/RetryStrategy.ts:37-44`
- Modify: `packages/extension/src/core/engine/RateLimiter.ts` (full rewrite)
- Modify: `packages/extension/src/core/connection/CircuitBreaker.ts:32-35,38-47`
- Modify: `packages/extension/src/core/engine/DependencyResolver.ts:52-57`
- Modify: `packages/extension/src/core/metadata/ObjectGraph.ts:104`
- Modify: `packages/extension/src/core/i18n/I18nManager.ts:18-20`
- Modify: `packages/extension/src/core/engine/BulkApiManager.ts:35`
- Modify: corresponding test files

**Step 1: Write failing tests for each fix**

Tests for: equal jitter (min 50%), sliding window rate limiter, half-open permit counter, Tarjan SCC cycle decomposition, index-based dequeue, locale merge, job purge.

**Step 2: Implement all fixes**

```typescript
// RetryStrategy.ts:37-44 — REPLACE calculateDelay
calculateDelay(attempt: number): number {
  const baseDelay =
    this.config.initialDelay *
    Math.pow(this.config.backoffMultiplier, attempt);
  const capped = Math.min(baseDelay, this.config.maxDelay);
  if (!this.config.jitter) return capped;
  const half = capped / 2;
  return Math.floor(half + Math.random() * half);
}

// RateLimiter.ts — FULL REWRITE with sliding window
export class RateLimiter {
  private timestamps: number[] = [];
  private maxRequestsPerWindow: number;
  private readonly windowMs: number;

  constructor(maxRequestsPerWindow: number = 100, windowMs: number = 60_000) {
    this.maxRequestsPerWindow = maxRequestsPerWindow;
    this.windowMs = windowMs;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  canProceed(): boolean {
    this.pruneExpired();
    return this.timestamps.length < this.maxRequestsPerWindow;
  }

  recordRequest(): void {
    this.pruneExpired();
    this.timestamps.push(Date.now());
  }

  getRemainingRequests(): number {
    this.pruneExpired();
    return Math.max(0, this.maxRequestsPerWindow - this.timestamps.length);
  }

  getUsagePercent(): number {
    this.pruneExpired();
    if (this.maxRequestsPerWindow === 0) return 100;
    return (this.timestamps.length / this.maxRequestsPerWindow) * 100;
  }

  getTimeUntilReset(): number {
    this.pruneExpired();
    if (this.timestamps.length === 0) return 0;
    const oldest = this.timestamps[0];
    return Math.max(0, (oldest + this.windowMs) - Date.now());
  }

  getDelay(): number {
    if (this.canProceed()) return 0;
    return this.getTimeUntilReset();
  }

  async waitForSlot(): Promise<void> {
    const delay = this.getDelay();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  reset(): void {
    this.timestamps = [];
  }

  updateLimits(maxRequests: number): void {
    this.maxRequestsPerWindow = maxRequests;
  }
}

// CircuitBreaker.ts — ADD halfOpenInFlight
private halfOpenInFlight = 0;

canExecute(): boolean {
  const currentState = this.getState();
  if (currentState === 'half_open') {
    return this.halfOpenInFlight < this.config.halfOpenRequests;
  }
  return currentState === 'closed';
}

recordSuccess(): void {
  if (this.state === 'half_open') {
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.halfOpenSuccesses++;
    if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
      this.reset();
    }
  } else {
    this.failureCount = 0;
  }
}

// Add acquirePermit() method and reset halfOpenInFlight in reset()

// DependencyResolver.ts:52-57 — Replace cycle detection with SCC
// Replace: const cycles = remaining.size > 0 ? [Array.from(remaining.keys()).sort()] : [];
// With: const cycles = remaining.size > 0 ? this.findStronglyConnectedComponents(remaining) : [];
// Add private findStronglyConnectedComponents method using iterative DFS

// ObjectGraph.ts:104 — Replace shift() with index
// Replace queue.shift() with index-based iteration:
let qi = 0;
while (qi < queue.length) {
  const current = queue[qi++];
  // ... rest unchanged
}

// I18nManager.ts:18-20 — Merge instead of overwrite
registerLocale(locale: string, translations: TranslationMap): void {
  const existing = this.translations.get(locale);
  this.translations.set(locale, existing ? { ...existing, ...translations } : translations);
}

// BulkApiManager.ts — Add auto-purge
private readonly maxCompletedJobs = 50;
private purgeCompletedJobs(): void {
  const completed = Array.from(this.activeJobs.entries())
    .filter(([, job]) => ['JobComplete', 'Failed', 'Aborted'].includes(job.state));
  if (completed.length > this.maxCompletedJobs) {
    const toPurge = completed.slice(0, completed.length - this.maxCompletedJobs);
    for (const [id] of toPurge) {
      this.activeJobs.delete(id);
    }
  }
}
// Call purgeCompletedJobs() at end of recordRequest()
```

**Step 3: Run tests, typecheck, commit**

Run: `cd packages/extension && pnpm test && pnpm typecheck`

```bash
git add packages/extension/src/core/
git commit -m "$(cat <<'EOF'
fix(extension): RetryStrategy jitter, RateLimiter sliding window, CircuitBreaker half-open guard, DependencyResolver SCCs, ObjectGraph perf, I18nManager merge, BulkApiManager purge

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: WebView Fixes

### Task 6: Fix all React bugs (SeedPage, FloatingToasts, Dialog, hooks, stores)

**Files:**
- Modify: `packages/webview/src/pages/Seed/SeedPage.tsx:235-253`
- Modify: `packages/webview/src/components/ui/FloatingToasts.tsx:23-41`
- Modify: `packages/webview/src/hooks/useKonamiCode.ts` (full rewrite)
- Modify: `packages/webview/src/layouts/StatusFooter/StatusFooter.tsx:20-21`
- Modify: `packages/webview/src/components/ui/Dialog.tsx:56-65`
- Modify: `packages/webview/src/pages/OrgManager/OrgManagerPage.tsx:62-75`
- Modify: `packages/webview/src/hooks/useVSCodeApi.ts:36`
- Modify: `packages/webview/src/stores/useSettingsStore.ts:98-120`
- Modify: `packages/webview/src/bridge/messageHelpers.ts:3,20`
- Modify: `packages/webview/src/components/ui/DataTable.tsx:184-189`
- Modify: `packages/webview/src/router.tsx:41-43`
- Modify: `packages/webview/src/pages/Sync/SoqlBuilder.tsx:119-132`
- Modify: `packages/webview/src/stores/useOrgStore.ts:57-68`
- Modify: `packages/webview/src/stores/useNotificationStore.ts:100-102`

**Step 1: Fix SeedPage infinite loop (CRITICAL)**

```typescript
// SeedPage.tsx — Before the useEffect blocks (around line 233), extract stable refs:
const describeFieldsMutate = describeFieldsMutation.mutate;
const piiScanMutate = piiScanMutation.mutate;

// Line 245: Replace describeFieldsMutation.mutate with describeFieldsMutate
// Line 245 dep array: Replace describeFieldsMutation with describeFieldsMutate
// Line 251: Replace piiScanMutation.mutate with piiScanMutate
// Line 253 dep array: Replace piiScanMutation with piiScanMutate
```

**Step 2: Fix FloatingToasts cleanup**

```typescript
// FloatingToasts.tsx — Split into two useEffects:
// Effect 1: Set up timers + clean orphans (NO cleanup function)
useEffect(() => {
  for (const n of visible) {
    if (n.autoDismissMs && !timersRef.current.has(n.id)) {
      const timer = setTimeout(() => {
        removeNotification(n.id);
        timersRef.current.delete(n.id);
      }, n.autoDismissMs);
      timersRef.current.set(n.id, timer);
    }
  }
  const visibleIds = new Set(visible.map((n) => n.id));
  for (const [id, timer] of timersRef.current.entries()) {
    if (!visibleIds.has(id)) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }
}, [visible, removeNotification]);

// Effect 2: Unmount-only cleanup
useEffect(() => {
  const timers = timersRef.current;
  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}, []);
```

**Step 3: Fix useKonamiCode with refs**

```typescript
// useKonamiCode.ts — Full rewrite
import { useEffect, useRef } from 'react';

const KONAMI_SEQUENCE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
];

export function useKonamiCode(callback: () => void): void {
  const indexRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.code === KONAMI_SEQUENCE[indexRef.current]) {
        indexRef.current += 1;
        if (indexRef.current === KONAMI_SEQUENCE.length) {
          callbackRef.current();
          indexRef.current = 0;
        }
      } else {
        indexRef.current = e.code === KONAMI_SEQUENCE[0] ? 1 : 0;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
```

**Step 4: Fix Dialog IDs**

```typescript
// Dialog.tsx — Add useId import, generate unique IDs
import React, { useEffect, useRef, useId } from 'react';
// Inside component:
const dialogId = useId();
const titleId = `${dialogId}-title`;
const descId = `${dialogId}-desc`;
// Replace all "dialog-title" with titleId, "dialog-desc" with descId
```

**Step 5: Fix StatusFooter, OrgManagerPage, stores, messageHelpers, DataTable, router, SoqlBuilder, useVSCodeApi**

Apply all remaining fixes as described in the review. Each one is a small targeted change.

**Step 6: Run all webview tests + typecheck**

Run: `cd packages/webview && pnpm test && pnpm typecheck`

**Step 7: Commit**

```bash
git add packages/webview/src/
git commit -m "$(cat <<'EOF'
fix(webview): fix all 16 React issues

- SeedPage: extract .mutate refs to prevent infinite useEffect loop
- FloatingToasts: split cleanup into visible-aware + unmount-only
- useKonamiCode: useRef instead of useState to prevent re-subscription
- Dialog: useId() for unique aria IDs
- StatusFooter: inline Zustand selector instead of computed method
- OrgManagerPage: stabilize .mutate in useCallback deps
- useVSCodeApi: remove console.warn
- useSettingsStore: type validation in importSettings
- messageHelpers: timestamp prefix for unique IDs across HMR
- DataTable: Tailwind hover class instead of inline style
- router: remove dead registerRoute function
- SoqlBuilder: basic SOQL sanitization
- Zustand stores: external selectors for computed values

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Fix i18n hardcoded labels

**Files:**
- Modify: `packages/webview/src/pages/OrgManager/OrgEditDialog.tsx:25-39,110-117`
- Modify: `packages/webview/src/pages/OrgManager/OrgConnectDialog.tsx:27-38`
- Modify: `packages/webview/src/pages/Sync/SoqlBuilder.tsx` (labels)
- Modify: i18n translation files (en.json, fr.json at minimum)

**Step 1: Replace hardcoded labels with t() calls**

Move tierOptions, colorOptions, authOptions, loginUrlOptions inside the component and use `t()`.

**Step 2: Add translation keys to en.json and fr.json**

**Step 3: Run tests + typecheck, commit**

```bash
git commit -m "$(cat <<'EOF'
fix(webview): replace all hardcoded labels with i18n t() calls

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Autopilot Types & Schemas (shared)

### Task 8: Create autopilot.types.ts and compliance.types.ts

**Files:**
- Create: `packages/shared/src/types/autopilot.types.ts`
- Create: `packages/shared/src/types/autopilot.types.test.ts`
- Create: `packages/shared/src/types/compliance.types.ts`
- Create: `packages/shared/src/types/compliance.types.test.ts`
- Modify: `packages/shared/src/types/messages.types.ts` (add autopilot messages)

**Step 1: Write type tests**

Test that all types compile, that enums have correct values, that interfaces are structurally valid.

**Step 2: Implement types**

```typescript
// autopilot.types.ts — Full types for AutopilotGraph, AutopilotNode, AutopilotEdge,
// ExecutionPlan, ExecutionWave, CycleResolution, GraphStats, AutopilotConfig,
// AutopilotNodeStatus, AutopilotExecutionEvent, etc.
// See design doc Section 5 for all interfaces.

// compliance.types.ts — ComplianceFramework, ComplianceProfile, ComplianceRule,
// ComplianceReport, AnonymizationMethod, AnonymizedPersona, PIIFieldDetection,
// AnonymizationOverride, AnonymizationSummary, ComplianceReportEntry
// See design doc Section 7 for all interfaces.
```

**Step 3: Add autopilot messages to messages.types.ts**

Add all 14 new message types from design doc Section 9.

**Step 4: Run tests + typecheck, commit**

---

### Task 9: Create autopilot.schema.ts and compliance.schema.ts

**Files:**
- Create: `packages/shared/src/schemas/autopilot.schema.ts`
- Create: `packages/shared/src/schemas/autopilot.schema.test.ts`
- Create: `packages/shared/src/schemas/compliance.schema.ts`
- Create: `packages/shared/src/schemas/compliance.schema.test.ts`

**Step 1: Write Zod schemas matching the types exactly**

**Step 2: Tests with valid/invalid data, commit**

---

## Phase 5: Autopilot Extension Module

### Task 10: SchemaScanner

**Files:**
- Create: `packages/extension/src/modules/autopilot/SchemaScanner.ts`
- Create: `packages/extension/src/modules/autopilot/SchemaScanner.test.ts`

Scans source + target orgs via MetadataReader. Returns describe results for all selected objects + their dependencies.

### Task 11: DependencyGraphBuilder

**Files:**
- Create: `packages/extension/src/modules/autopilot/DependencyGraphBuilder.ts`
- Create: `packages/extension/src/modules/autopilot/DependencyGraphBuilder.test.ts`

Builds AutopilotGraph from describe results. Uses Tarjan SCC for cycle detection. Computes topological order and levels for layout. Critical tests: self-ref, mutual, complex cycles, polymorphic lookups.

### Task 12: ComplianceEngine

**Files:**
- Create: `packages/extension/src/modules/autopilot/ComplianceEngine.ts`
- Create: `packages/extension/src/modules/autopilot/ComplianceEngine.test.ts`

4 built-in profiles (GDPR/CCPA/HIPAA/PCI-DSS). Takes PIIDetector results, maps to anonymization rules per profile. Generates ComplianceReport.

### Task 13: SmartAnonymizer + PersonaRegistry

**Files:**
- Create: `packages/extension/src/modules/autopilot/SmartAnonymizer.ts`
- Create: `packages/extension/src/modules/autopilot/SmartAnonymizer.test.ts`

Cross-object coherent anonymization. PersonaRegistry generates deterministic fake personas per source record. Implements all 10 anonymization methods.

### Task 14: ExecutionPlanGenerator

**Files:**
- Create: `packages/extension/src/modules/autopilot/ExecutionPlanGenerator.ts`
- Create: `packages/extension/src/modules/autopilot/ExecutionPlanGenerator.test.ts`

Takes AutopilotGraph + ComplianceProfile, generates ordered ExecutionWaves. Estimates duration and API calls. Handles cycle resolution strategies.

### Task 15: RecordIdRemapper

**Files:**
- Create: `packages/extension/src/modules/autopilot/RecordIdRemapper.ts`
- Create: `packages/extension/src/modules/autopilot/RecordIdRemapper.test.ts`

Maps source record IDs to target record IDs after insertion. Used to remap lookup fields in dependent objects.

### Task 16: AutopilotExecutor

**Files:**
- Create: `packages/extension/src/modules/autopilot/AutopilotExecutor.ts`
- Create: `packages/extension/src/modules/autopilot/AutopilotExecutor.test.ts`

Executes the plan wave by wave. Extends TypedEventEmitter for real-time progress events. Supports pause/resume/skip. Uses CheckpointManager for crash recovery. Delegates to BatchProcessor + BulkApiManager.

### Task 17: AutopilotGrappeAdapter

**Files:**
- Create: `packages/extension/src/modules/autopilot/AutopilotGrappeAdapter.ts`
- Create: `packages/extension/src/modules/autopilot/AutopilotGrappeAdapter.test.ts`

Adapts AutopilotExecutor for Grappe parallel processing when record count exceeds threshold.

### Task 18: AutopilotOrchestrator

**Files:**
- Create: `packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts`
- Create: `packages/extension/src/modules/autopilot/AutopilotOrchestrator.test.ts`

Entry point. Orchestrates the full flow: SchemaScanner -> DependencyGraphBuilder -> ComplianceEngine -> ExecutionPlanGenerator -> AutopilotExecutor. Handles all autopilot message types from the bridge.

### Task 19: Wire Autopilot into ExtensionHandlers

**Files:**
- Modify: `packages/extension/src/bridge/ExtensionHandlers.ts`

Add handlers for all 14 autopilot message types. Route to AutopilotOrchestrator.

**Commit after each task in Phase 5.**

---

## Phase 6: Autopilot WebView UI

### Task 20: Autopilot Zustand store

**Files:**
- Create: `packages/webview/src/stores/useAutopilotStore.ts`
- Create: `packages/webview/src/stores/useAutopilotStore.test.ts`

State: graph, plan, execution status, selected node, compliance profile, live stats.

### Task 21: AutopilotWizard (Steps 1-4)

**Files:**
- Create: `packages/webview/src/pages/Autopilot/AutopilotWizard/AutopilotWizard.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotWizard/Step1_Connect.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotWizard/Step2_Objects.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotWizard/Step3_Compliance.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotWizard/Step4_Review.tsx`
- Create: test files for each

### Task 22: ObjectNode + RelationEdge (ReactFlow custom components)

**Files:**
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/ObjectNode.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/RelationEdge.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/CycleOverlay.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/GraphControls.tsx`
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/GraphLegend.tsx`

ObjectNode: progress bar, record count, status colors, pulse animation, PII lock icon.
RelationEdge: solid/dashed/curved by type, animated dash on active, diamond for polymorphic.

### Task 23: AutopilotGraph (main ReactFlow canvas)

**Files:**
- Create: `packages/webview/src/pages/Autopilot/AutopilotGraph/AutopilotGraph.tsx`
- Create: test file

Uses dagre layout for automatic node positioning. Subscribes to store for real-time updates.

### Task 24: ControlPanel (Tesla-style side panel)

**Files:**
- Create: `packages/webview/src/pages/Autopilot/ControlPanel/ControlPanel.tsx`
- Create: `packages/webview/src/pages/Autopilot/ControlPanel/NodeDetail.tsx`
- Create: `packages/webview/src/pages/Autopilot/ControlPanel/LiveStats.tsx`
- Create: `packages/webview/src/pages/Autopilot/ControlPanel/AnonymizationPreview.tsx`
- Create: `packages/webview/src/pages/Autopilot/ControlPanel/ComplianceStatus.tsx`

### Task 25: ComplianceReport

**Files:**
- Create: `packages/webview/src/pages/Autopilot/ComplianceReport/ComplianceReport.tsx`
- Create: `packages/webview/src/pages/Autopilot/ComplianceReport/ComplianceTimeline.tsx`

Exportable report (HTML/JSON). Shows all anonymized fields, methods applied, audit trail.

### Task 26: AutopilotPage (main layout)

**Files:**
- Create: `packages/webview/src/pages/Autopilot/AutopilotPage.tsx`
- Create: test file

Combines wizard (steps 1-4) and graph+control panel (step 4 execution view). Routing integration.

### Task 27: Wire into router + navigation

**Files:**
- Modify: `packages/webview/src/router.tsx`
- Modify: `packages/webview/src/pages/Home/HomePage.tsx` (add Autopilot card)
- Modify: navigation/sidebar components

Add '/autopilot' route. Add Autopilot module card on home page with icon + description.

### Task 28: i18n keys for Autopilot

**Files:**
- Modify: all translation files (en.json, fr.json, de.json, es.json, ja.json, pt-BR.json)

Add all autopilot.* translation keys.

**Commit after each task in Phase 6.**

---

## Phase 7: Integration & Polish

### Task 29: Full integration test

Run: `pnpm validate` (typecheck + lint + test + build)

Fix any issues that arise from the full build.

### Task 30: Update CHANGELOG.md

Add v3.0.0 entry with all changes.

### Task 31: Update package.json version

Bump to 3.0.0 in root + all 3 packages.

### Task 32: Final commit + tag

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: SandForge v3.0.0 Autopilot

- New Autopilot module: zero-config sandbox seeding with dependency resolution
- ComplianceEngine: GDPR/CCPA/HIPAA/PCI-DSS profiles with AI PII detection
- SmartAnonymizer: cross-object coherent anonymization with PersonaRegistry
- Tesla Control Panel: interactive ReactFlow graph with real-time execution
- TypedEventEmitter: type-safe event system with listener isolation
- 49 bug fixes across all packages
- Schema/type alignment across all Zod schemas

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
git tag v3.0.0
```

---

## Task Dependency Graph

```
Phase 1 (Tasks 1-2): shared fixes → no deps
Phase 2 (Tasks 3-5): extension fixes → depends on Task 2 (schema alignment)
Phase 3 (Tasks 6-7): webview fixes → no deps on Phase 2
Phase 4 (Tasks 8-9): autopilot types → depends on Task 2
Phase 5 (Tasks 10-18): autopilot module → depends on Tasks 3-5 (TypedEventEmitter, core fixes)
Phase 5 Task 19: wire handlers → depends on Task 18
Phase 6 (Tasks 20-28): webview UI → depends on Tasks 8-9 (types) + Task 6 (webview fixes)
Phase 7 (Tasks 29-32): integration → depends on everything

Parallelizable: Phase 1 + Phase 3 can run in parallel.
Parallelizable: Tasks 10-17 within Phase 5 can mostly run in parallel.
Parallelizable: Tasks 20-26 within Phase 6 can mostly run in parallel.
```

## Estimated Total: 32 tasks across 7 phases
