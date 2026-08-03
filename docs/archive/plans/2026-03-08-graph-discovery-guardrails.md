# Graph Discovery Guardrails Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent graph discovery from running indefinitely by adding exclusion lists, max node cap, abort signal, and progress reporting.

**Architecture:** Add `DiscoveryOptions` to `GraphDiscoveryService.discover()` for abort signal, max nodes, and progress callback. Add `EXCLUDED_OBJECTS` and `EXCLUDED_SUFFIXES` constants to filter system/hub objects during BFS. Wire abort through `ForgeOrchestrator` and `ForgeHandler`.

**Tech Stack:** TypeScript, Vitest, AbortController/AbortSignal

---

### Task 1: Add exclusion list and max nodes cap to GraphDiscoveryService

**Files:**
- Modify: `packages/extension/src/modules/forge/GraphDiscoveryService.ts`
- Modify: `packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`

**Step 1: Write failing tests for exclusion and max nodes**

Add to `GraphDiscoveryService.test.ts`:

```typescript
describe('guardrails', () => {
  it('should exclude system objects from traversal', async () => {
    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      if (objectName === 'Account') {
        return makeAccountDescribe([
          { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', isCascadeDelete: false },
          { childSObject: 'AccountHistory', field: 'AccountId', relationshipName: 'Histories', isCascadeDelete: false },
          { childSObject: 'AccountFeed', field: 'ParentId', relationshipName: 'Feeds', isCascadeDelete: false },
          { childSObject: 'AccountShare', field: 'AccountId', relationshipName: 'Shares', isCascadeDelete: false },
        ]);
      }
      return makeContactDescribe();
    });

    const config = createConfig({ depth: 'direct' });
    const graph = await service.discover(config);

    const objectNames = graph.nodes.map((n) => n.objectApiName);
    expect(objectNames).toContain('Contact');
    expect(objectNames).not.toContain('AccountHistory');
    expect(objectNames).not.toContain('AccountFeed');
    expect(objectNames).not.toContain('AccountShare');
  });

  it('should exclude hub objects like User and RecordType from traversal', async () => {
    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      if (objectName === 'Account') {
        return {
          name: 'Account',
          fields: [
            { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
            { name: 'OwnerId', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', isMasterDetail: false },
            { name: 'RecordTypeId', type: 'reference', referenceTo: ['RecordType'], relationshipName: 'RecordType', isMasterDetail: false },
          ],
          childRelationships: [],
        };
      }
      return { name: objectName, fields: [], childRelationships: [] };
    });

    const config = createConfig({ depth: 'direct' });
    const graph = await service.discover(config);

    const objectNames = graph.nodes.map((n) => n.objectApiName);
    expect(objectNames).toContain('Account');
    expect(objectNames).not.toContain('User');
    expect(objectNames).not.toContain('RecordType');
  });

  it('should still create edges to excluded objects without visiting them', async () => {
    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      if (objectName === 'Account') {
        return {
          name: 'Account',
          fields: [
            { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
            { name: 'OwnerId', type: 'reference', referenceTo: ['User'], relationshipName: 'Owner', isMasterDetail: false },
          ],
          childRelationships: [],
        };
      }
      return { name: objectName, fields: [], childRelationships: [] };
    });

    const config = createConfig({ depth: 'direct' });
    const graph = await service.discover(config);

    const userEdge = graph.edges.find((e) => e.targetObject === 'User');
    expect(userEdge).toBeDefined();
    expect(graph.nodes.find((n) => n.objectApiName === 'User')).toBeUndefined();
  });

  it('should stop discovering when max nodes cap is reached', async () => {
    // Create a chain: Obj0 -> Obj1 -> Obj2 -> ... -> Obj60
    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      const idx = parseInt(objectName.replace('Obj', ''), 10);
      const nextObj = `Obj${idx + 1}`;
      return {
        name: objectName,
        fields: [
          { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
        ],
        childRelationships: [{
          childSObject: nextObj,
          field: 'ParentId',
          relationshipName: 'Children',
          isCascadeDelete: false,
        }],
      };
    });

    // Use a prefix that resolves to our first object
    const config = createConfig({ depth: 'full', recordId: '001XXXXXXXXXX' });
    // Override resolveRootObject by mocking first describe to return 'Obj0' as Account
    vi.mocked(deps.describeObject).mockImplementationOnce(async () => ({
      name: 'Account',
      fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
      childRelationships: [{
        childSObject: 'Obj1',
        field: 'ParentId',
        relationshipName: 'Children',
        isCascadeDelete: false,
      }],
    }));

    // Override subsequent calls to create an infinite chain
    for (let i = 1; i <= 60; i++) {
      vi.mocked(deps.describeObject).mockResolvedValueOnce({
        name: `Obj${i}`,
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [{
          childSObject: `Obj${i + 1}`,
          field: 'ParentId',
          relationshipName: 'Children',
          isCascadeDelete: false,
        }],
      });
    }

    const graph = await service.discover(config);
    expect(graph.nodes.length).toBeLessThanOrEqual(50);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`
Expected: FAIL — excluded objects are still traversed, no max nodes cap

**Step 3: Implement exclusion list and max nodes in GraphDiscoveryService**

In `GraphDiscoveryService.ts`, add constants after the existing heuristic constants:

```typescript
/** Default maximum number of nodes to discover. */
const DEFAULT_MAX_NODES = 50;

/** Hub/system objects excluded from BFS traversal (still referenced in edges). */
const EXCLUDED_OBJECTS = new Set([
  'User',
  'Group',
  'Profile',
  'UserRole',
  'RecordType',
  'Organization',
  'BusinessProcess',
  'CurrencyType',
  'DandBCompany',
  'DuplicateRecordItem',
  'DuplicateRecordSet',
  'ProcessInstance',
]);

/** Suffix patterns excluded from BFS traversal. */
const EXCLUDED_SUFFIXES = [
  'History',
  'Feed',
  'Share',
  'ChangeEvent',
  '__hd',
  '__Tag',
];

/** Check whether an object should be excluded from BFS traversal. */
function isExcludedObject(objectName: string): boolean {
  if (EXCLUDED_OBJECTS.has(objectName)) {
    return true;
  }
  return EXCLUDED_SUFFIXES.some((suffix) => objectName.endsWith(suffix));
}
```

Modify the BFS loop to check exclusion and node cap:

```typescript
// In the BFS loop, before pushing to queue for parent relationships:
if (!visitedObjects.has(targetObject) && !isExcludedObject(targetObject)) {
  visitedObjects.add(targetObject);
  if (nodes.length + queue.length < DEFAULT_MAX_NODES) {
    queue.push([targetObject, depth + 1]);
  }
}

// Same for child relationships:
if (!visitedObjects.has(child.childSObject) && !isExcludedObject(child.childSObject)) {
  visitedObjects.add(child.childSObject);
  if (nodes.length + queue.length < DEFAULT_MAX_NODES) {
    queue.push([child.childSObject, depth + 1]);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/extension/src/modules/forge/GraphDiscoveryService.ts packages/extension/src/modules/forge/GraphDiscoveryService.test.ts
git commit -m "feat(forge): add exclusion list and max nodes cap to graph discovery"
```

---

### Task 2: Add AbortSignal and progress callback to GraphDiscoveryService

**Files:**
- Modify: `packages/extension/src/modules/forge/GraphDiscoveryService.ts`
- Modify: `packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`

**Step 1: Write failing tests for abort and progress**

Add to `GraphDiscoveryService.test.ts`:

```typescript
describe('abort signal', () => {
  it('should stop discovery when signal is aborted', async () => {
    const controller = new AbortController();
    let describeCallCount = 0;

    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      describeCallCount++;
      if (describeCallCount === 1) {
        // Abort after first describe
        controller.abort();
      }
      return {
        name: objectName,
        fields: [{ name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false }],
        childRelationships: [{
          childSObject: `Child${describeCallCount}`,
          field: 'ParentId',
          relationshipName: 'Children',
          isCascadeDelete: false,
        }],
      };
    });

    const config = createConfig({ depth: 'full' });
    const graph = await service.discover(config, { signal: controller.signal });

    // Should have returned early with partial graph
    expect(graph.nodes.length).toBe(1);
  });
});

describe('progress callback', () => {
  it('should call onProgress for each discovered node', async () => {
    vi.mocked(deps.describeObject).mockImplementation(async (_orgId, objectName) => {
      if (objectName === 'Account') {
        return makeAccountDescribe([{
          childSObject: 'Contact',
          field: 'AccountId',
          relationshipName: 'Contacts',
          isCascadeDelete: false,
        }]);
      }
      return makeContactDescribe();
    });

    const onProgress = vi.fn();
    const config = createConfig({ depth: 'direct' });
    await service.discover(config, { onProgress });

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ objectApiName: 'Account', discoveredCount: 1 }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ objectApiName: 'Contact', discoveredCount: 2 }),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`
Expected: FAIL — discover() does not accept options

**Step 3: Implement abort signal and progress callback**

Add types and modify `discover()` signature:

```typescript
/** Progress event emitted during graph discovery. */
export interface DiscoveryProgressEvent {
  objectApiName: string;
  discoveredCount: number;
  queueRemaining: number;
}

/** Options for the discover method. */
export interface DiscoveryOptions {
  signal?: AbortSignal;
  onProgress?: (event: DiscoveryProgressEvent) => void;
  maxNodes?: number;
}
```

Update `discover()` to accept options and check abort + emit progress:

```typescript
async discover(config: ForgeConfig, options?: DiscoveryOptions): Promise<ForgeGraph> {
  const rootObject = this.resolveRootObject(config);
  const maxDepth = this.resolveMaxDepth(config);
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

  // ... existing setup ...

  while (queue.length > 0) {
    if (options?.signal?.aborted) {
      break;
    }

    const [objectName, depth] = queue.shift()!;

    // ... existing describe/count/PII ...

    nodes.push(node);

    options?.onProgress?.({
      objectApiName: objectName,
      discoveredCount: nodes.length,
      queueRemaining: queue.length,
    });

    if (depth < maxDepth) {
      // ... existing traversal with maxNodes cap ...
    }
  }

  // ... existing return ...
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/extension/src/modules/forge/GraphDiscoveryService.ts packages/extension/src/modules/forge/GraphDiscoveryService.test.ts
git commit -m "feat(forge): add abort signal and progress callback to graph discovery"
```

---

### Task 3: Wire abort and progress through ForgeOrchestrator

**Files:**
- Modify: `packages/extension/src/modules/forge/ForgeOrchestrator.ts`
- Modify: `packages/extension/src/modules/forge/ForgeOrchestrator.test.ts`

**Step 1: Write failing test**

```typescript
it('should pass options through to discoveryService.discover', async () => {
  const controller = new AbortController();
  const onProgress = vi.fn();
  const config = createMockConfig();

  await orchestrator.discover(config, { signal: controller.signal, onProgress });

  expect(deps.discoveryService.discover).toHaveBeenCalledWith(config, {
    signal: controller.signal,
    onProgress,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/extension/src/modules/forge/ForgeOrchestrator.test.ts`
Expected: FAIL

**Step 3: Update ForgeOrchestrator.discover() to pass options**

```typescript
import type { DiscoveryOptions } from './GraphDiscoveryService.js';

async discover(config: ForgeConfig, options?: DiscoveryOptions): Promise<ForgeGraph> {
  return this.deps.discoveryService.discover(config, options);
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/extension/src/modules/forge/ForgeOrchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/extension/src/modules/forge/ForgeOrchestrator.ts packages/extension/src/modules/forge/ForgeOrchestrator.test.ts
git commit -m "feat(forge): pass discovery options through ForgeOrchestrator"
```

---

### Task 4: Wire abort and progress in ForgeHandler

**Files:**
- Modify: `packages/extension/src/bridge/handlers/ForgeHandler.ts`
- Modify: `packages/extension/src/bridge/handlers/ForgeHandler.test.ts`

**Step 1: Write failing tests**

```typescript
describe('forge:discover abort', () => {
  it('should abort discovery when forge:abort is called during discover', async () => {
    let resolveDiscover: ((value: ForgeGraph) => void) | undefined;
    vi.mocked(deps.orchestrator.discover).mockImplementation(
      () => new Promise<ForgeGraph>((resolve) => { resolveDiscover = resolve; }),
    );

    const discoverPromise = handler.handle('forge:discover', { config: createMockConfig() });

    await handler.handle('forge:abort', {});

    // Resolve to complete the promise
    resolveDiscover!(createMockGraph());
    await discoverPromise;

    // Verify orchestrator.discover was called with an abort signal
    expect(deps.orchestrator.discover).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('forge:discover progress', () => {
  it('should post discovery progress events to webview', async () => {
    vi.mocked(deps.orchestrator.discover).mockImplementation(
      async (_config, options) => {
        options?.onProgress?.({
          objectApiName: 'Account',
          discoveredCount: 1,
          queueRemaining: 3,
        });
        return createMockGraph();
      },
    );

    await handler.handle('forge:discover', { config: createMockConfig() });

    expect(deps.postMessage).toHaveBeenCalledWith({
      type: 'forge:discover:progress',
      payload: {
        objectApiName: 'Account',
        discoveredCount: 1,
        queueRemaining: 3,
      },
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/extension/src/bridge/handlers/ForgeHandler.test.ts`
Expected: FAIL

**Step 3: Update ForgeHandler**

Key changes to `handleDiscover`:

```typescript
private discoverAbortController: AbortController | null = null;

private async handleDiscover(payload: DiscoverPayload): Promise<boolean> {
  this.discoverAbortController = new AbortController();
  try {
    logger.info('Forge discover started');
    const graph = await this.deps.orchestrator.discover(payload.config, {
      signal: this.discoverAbortController.signal,
      onProgress: (event) => {
        this.deps.postMessage({ type: 'forge:discover:progress', payload: event });
      },
    });
    this.deps.postMessage({ type: 'forge:discover:response', payload: { graph } });
  } catch (error) {
    logger.error('Forge discover failed', { error: String(error) });
    this.deps.postMessage({
      type: 'forge:discover:error',
      payload: { message: String(error) },
    });
  }
  this.discoverAbortController = null;
  return true;
}
```

Update `handleAbort` to abort both discover and execute:

```typescript
private handleAbort(): boolean {
  this.discoverAbortController?.abort();
  this.abortController?.abort();
  logger.info('Forge aborted');
  return true;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/extension/src/bridge/handlers/ForgeHandler.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/extension/src/bridge/handlers/ForgeHandler.ts packages/extension/src/bridge/handlers/ForgeHandler.test.ts
git commit -m "feat(forge): wire abort signal and progress to ForgeHandler"
```

---

### Task 5: Full validation

**Step 1: Run full validation pipeline**

Run: `pnpm validate`
Expected: All checks pass (typecheck + lint + test + build)

**Step 2: Fix any issues**

Address typecheck/lint/test failures if any.

**Step 3: Final commit if needed**

```bash
git commit -m "fix(forge): address validation issues from discovery guardrails"
```
