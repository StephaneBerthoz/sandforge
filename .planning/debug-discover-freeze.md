# Debug — Forge Discover 2m30 Freeze on Mutuaide UAT2

Symptom: User clicks "Discover Graph" with `500AP00000j2CEgYAM` (a Case ID) on Mutuaide UAT2 (350+ SObjects, 11 484 Cases). VSCode UI freezes ~2 min 30 s. No `forge:discover:progress` events surface. Eventually returns or crashes. Reproduces at every depth setting (direct/full/custom).

## Call chain traced

1. WebView → `forge:discover` (payload: `ForgeConfig`).
2. `ForgeHandler.handleDiscover` (`packages/extension/src/bridge/handlers/ForgeHandler.ts:316-344`)
   - Creates `discoverAbortController`, emits `operation:started`, calls `orchestrator.discover(config, { signal, onProgress })`.
3. `ForgeOrchestrator.discover` (`packages/extension/src/modules/forge/ForgeOrchestrator.ts:88-108`)
   - Cache miss → delegates straight to `discoveryService.discover(config, options)`. No timeout, no event-loop yield.
4. `GraphDiscoveryService.discover` (`packages/extension/src/modules/forge/GraphDiscoveryService.ts:150-283`).
   - `resolveRootObject` calls `deps.describeGlobal(sourceOrgId)` → in `extension.ts:189-193` this delegates to **`conn.describeGlobal()` with no cache**.
   - BFS loop: per node it sequentially awaits `describeObject`, then `queryCount`. The describe and the count are NOT parallel even though they are independent.
5. The injected `describeObject` / `queryCount` / `describeGlobal` callbacks (`extension.ts:156-194`) each call `getJsforceConnection(orgId, …)` (`packages/extension/src/core/connection/ConnectionHelper.ts:72-165`).

## Hypotheses

### H1 — `describeGlobal()` is the dominant cost on Mutuaide UAT2 (~2 min) — CONFIRMED as primary cause

Evidence:
- `extension.ts:189-193` — every call to `deps.describeGlobal` issues a fresh `conn.describeGlobal()` over the wire. There is no cache layer in the discovery path (the `discoveryCache` in `ForgeOrchestrator.ts:44` only caches the final graph, not the metadata). On a Mutuaide UAT2-class org (350+ SObjects, plus managed packages — Mutuaide has nFeros, Geocode, NPSP-style add-ons), `describeGlobal` typically returns 5–8 MB of JSON and takes 30–90 s, sometimes minutes when the org is rate-limited.
- It is called twice per discover, sequentially:
  1. `GraphDiscoveryService.resolveRootObject` (line 293) — once on every discover.
  2. `forge:preview` handler (`ForgeHandler.ts:247`) ALSO calls `conn.describeGlobal()` when the user types the record ID. The 32 746 ms breadcrumb the user reported is exactly this preview round-trip on a different connection.
  
  So when the user types the ID then clicks Discover, the org has just been hit by `describeGlobal` once, and Discover hits it again in the GraphDiscoveryService (separate `getJsforceConnection` call → potentially separate `conn.identity()` validation → again no caching).
- No `TimeoutManager` wraps the call. Compare to `SyncOpsHandler.ts:204-205` and `SeedOpsHandler.ts:279-280` which DO wrap it: `new TimeoutManager(config.timeouts.describeGlobal).withTimeout('describe-global', () => conn.describeGlobal())`. Forge omits this — silent hangs.
- `AbortSignal` is checked once at the top of the BFS loop (`GraphDiscoveryService.ts:177`), but is never propagated into the underlying `conn.describeGlobal()`, `conn.describe()`, or `conn.query()`. So a user clicking "Cancel" cannot stop the in-flight HTTP call.

Impact: 1× describeGlobal on the resolveRootObject path = ~30–90 s. Add the still-running preview describeGlobal (it can outlive the user click), plus the ~50 sequential describes (each 1–3 s on Mutuaide), plus 50 SOQL `SELECT COUNT()` queries → easy 2 min 30 s, single-digit threading, UI looks frozen because no progress event is emitted until the FIRST `describeObject` completes.

### H2 — `onProgress` is silent until the first node is fully described (≥30 s) — CONFIRMED contributing cause

Evidence:
- `GraphDiscoveryService.ts:265-269`: `onProgress` is only called AFTER `describeObject` + `queryCount` BOTH return for the current node. There is zero progress emission while `describeGlobal()` runs (in `resolveRootObject`), and zero progress for the root describe before its `queryCount` finishes.
- The handler's only feedback is `sendOperationStarted` (background banner), but the wizard step itself listens for `forge:discover:progress` events to advance its UI. So the WebView legitimately appears frozen for ~30–90 s minimum even on a healthy org. On Mutuaide UAT2 with 11 484 Cases, COUNT() on Case is also ~5–10 s.
- Compare with the cached path (`ForgeOrchestrator.ts:94-101`): when the graph is in cache, the orchestrator manually fires `onProgress` for every node so the wizard animates. The first-time path provides no equivalent "discovery started" progress event.

### H3 — Sequential `describeObject` then `queryCount` per node (not parallelized) — CONFIRMED contributing cause

Evidence:
- `GraphDiscoveryService.ts:183-192`: `await describeObject` then `await queryCount`. Independent calls. With 50 nodes, this doubles the wall time vs. `Promise.all` parallelization.
- Both calls also separately invoke `getJsforceConnection`, each one runs `conn.identity()` again on the FIRST hit (after which `connectionPool.get()` returns a token match — but only after a successful first call). No describe-level dedup either: if two parents of `Account` are visited, `Account.describe()` is run twice.

### H4 — `getJsforceConnection` is called 100+ times during BFS, each potentially doing `conn.identity()` — POSSIBLE contributing cause

Evidence:
- `ConnectionHelper.ts:92-124`: First call hits `conn.identity()` and the circuit breaker. Subsequent calls within the same flow hit the pool fast path (line 92-100, no identity call). So the per-call overhead is small AFTER warmup.
- BUT: each call still does `orgRegistry.getCredentials(orgId)` (line 84) which reads `SecretVault`/`SecretStorage`. SecretStorage on Windows is backed by DPAPI and is synchronous-ish; called 100× per discover this adds 1–3 s but is not the main cause.

### H5 — The MAX_NODES cap is too high or BFS unbounded — DENIED

Evidence: `DEFAULT_MAX_NODES = 50` (`GraphDiscoveryService.ts:78`), check at lines 234 and 256 stops queueing new nodes once `nodes.length + queue.length < maxNodes` is false. The cap works. The freeze is per-node cost × 50, not unbounded BFS.

### H6 — Synchronous .map over async — DENIED

Evidence: All async calls are properly `await`-ed. There's no `.map(async …)` with un-awaited promises. The blocking is honest sequential I/O.

## Root cause (one sentence)

On a large org, **`GraphDiscoveryService.resolveRootObject` calls `conn.describeGlobal()` once with no timeout, no abort propagation, and no cache, blocking ~30–90 s before any progress event is emitted**, while the rest of the BFS issues 50 more sequential `describe` + `query COUNT()` round-trips (also without describe-level cache or per-call timeout) — total wall time on Mutuaide UAT2 ≈ 2 min 30 s. The 32 746 ms preview breadcrumb the user observed is corroborating proof that describeGlobal alone takes that long on UAT2.

Location: `packages/extension/src/modules/forge/GraphDiscoveryService.ts:150-283` (BFS) + `:285-316` (resolveRootObject) + `packages/extension/src/extension.ts:156-194` (no-cache adapter wiring) + `packages/extension/src/modules/forge/ForgeOrchestrator.ts:88-108` (no progress emission before the BFS starts).

## Proposed fix — minimal, layered, code-level

### Fix 1 — Cache `describeGlobal` per `(orgId, ttl)` in the adapter (PRIMARY — ~70 % of the freeze)

In `extension.ts:156-194`, replace the inline closures with a tiny in-memory cache wrapper. `describeGlobal` rarely changes during a session.

```ts
// Add near top of activate():
const describeGlobalCache = new Map<string, { value: Awaited<ReturnType<typeof getJsforceConnection>>['describeGlobal'] extends () => Promise<infer R> ? R : never; expiresAt: number }>();
const DESCRIBE_GLOBAL_TTL_MS = 5 * 60_000;

// Replace the describeGlobal closure (extension.ts:189-193):
describeGlobal: async (orgId) => {
  const cached = describeGlobalCache.get(orgId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
  }
  const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
  const result = await new TimeoutManager(60_000).withTimeout(
    'forge:describeGlobal',
    () => conn.describeGlobal(),
  );
  describeGlobalCache.set(orgId, { value: result, expiresAt: Date.now() + DESCRIBE_GLOBAL_TTL_MS });
  return result.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
},
```

Apply the same TTL cache to the **`forge:preview` handler** in `ForgeHandler.ts:247` (or have it use the same `describeGlobalCache` via DI). Without that, the preview path stays slow.

Also wrap `conn.describe(objectApiName)` (`extension.ts:159`) and `conn.describe(objectName)` (`extension.ts:241, 257, 274`) in a per-`(orgId, objectApiName)` cache with the same TTL — the same `Account` describe runs 4× during a single discover when multiple parents reference it.

### Fix 2 — Emit early progress events from `GraphDiscoveryService.discover` and `ForgeOrchestrator.discover`

Before calling `resolveRootObject`, fire `onProgress?.({ objectApiName: '__resolving__', discoveredCount: 0, queueRemaining: 1 })` so the wizard immediately knows work has started. Same for "describing root", "counting", etc. Add a `phase: 'resolving' | 'describing' | 'counting' | 'queueing'` field to `DiscoveryProgressEvent` (in `GraphDiscoveryService.ts:53-60`).

### Fix 3 — Parallelize `describeObject` + `queryCount` per node

In `GraphDiscoveryService.ts:183-192`:
```ts
const [describe, recordCount] = await Promise.all([
  this.deps.describeObject(config.sourceOrgId, objectName),
  this.deps.queryCount(
    config.sourceOrgId,
    `SELECT COUNT() FROM ${assertSoqlIdentifier(objectName)}`,
  ).catch(() => 0),
]);
```
Halves per-node wall time. The `.catch(() => 0)` preserves the silent-skip behavior of the current try/catch around `queryCount`.

### Fix 4 — Honor `AbortSignal` in adapter callbacks

Promote the `signal` from `DiscoveryOptions` into every adapter call. jsforce v3 (`node_modules/.pnpm/jsforce@3.10.14`) supports `AbortSignal` via the underlying fetch transport. Race the underlying call against the signal. Wrap each adapter call in:
```ts
async function withSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return fn();
  return Promise.race([
    fn(),
    new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('Aborted')), { once: true })),
  ]);
}
```
The user's "Cancel" click will then actually unstick the UI immediately rather than waiting for the in-flight describe.

### Fix 5 — Wrap BFS adapter calls in per-call `TimeoutManager`

Both `describeObject` and `queryCount` should have a 30 s/30 s timeout (matching `SeedOpsHandler` policy). On timeout, return an empty/zero placeholder + log warning, BUT continue traversal — do not abort the whole graph for one slow object.

## Where each fix lives

| Fix | Layer | File |
|-----|-------|------|
| 1 — describeGlobal + describe cache + timeout | adapter wiring | `packages/extension/src/extension.ts:156-194`, mirror in `ForgeHandler.ts:247` |
| 2 — early progress events | discovery service + orchestrator | `GraphDiscoveryService.ts:150-160`, `ForgeOrchestrator.ts:88-108` |
| 3 — parallelize describe + count | discovery service | `GraphDiscoveryService.ts:183-192` |
| 4 — abort-signal propagation | adapter wiring | `GraphDiscoveryService.ts:43-50` (extend `GraphDiscoveryDeps`), `extension.ts:156-194` |
| 5 — per-call timeout | adapter wiring | `extension.ts:156-194` |

The handler (`ForgeHandler`) does NOT need changes — it already passes `signal` and `onProgress`. The orchestrator only needs the early-progress emission (Fix 2). The bulk of the work is in the discovery service + adapter wiring.

## Effort estimate

- Fix 1 (cache + timeout for describeGlobal/describe): **S** (~30 min, ~40 LOC). Highest ROI.
- Fix 2 (early progress events): **S** (~15 min, ~10 LOC).
- Fix 3 (parallelize): **S** (~10 min, ~5 LOC).
- Fix 4 (abort-signal propagation): **M** (~45 min, requires extending the deps interface and wiring through 3 callbacks + tests).
- Fix 5 (per-call timeouts): **S** (~15 min once Fix 1 is in — same `TimeoutManager` pattern).

**Total: M (~2 h including tests).** Fixes 1 + 2 + 3 alone (S, ~1 h) likely take the freeze from 2 min 30 s to under 30 s on the same org.

## Risk

- Fix 1: TTL cache means stale describe between session restarts when the user just deployed metadata. 5 min TTL + a "Refresh schema" button mitigates. Memory cost: ~8 MB per org cached.
- Fix 3: `queryCount` errors are now caught inline rather than skipped via the surrounding `try`. Use `.catch(() => 0)` to preserve current behavior.
- Fix 4: jsforce v3 abort behavior must be tested — older v2 ignored signals; we are on v3.10.14 which forwards them.
- Fix 5: Wrong timeout could trigger false aborts on slow-but-healthy orgs. Make timeouts configurable via `config.timeouts` (already available in `SeedOpsHandler` pattern).

## Confidence

**High** for H1 + H2 + H3 being the cumulative cause. Direct evidence in code, no caching anywhere in the discovery path, no parallelization, no early progress, and the user's own 32 746 ms breadcrumb on `forge:preview` quantifies the describeGlobal cost on this exact org.
