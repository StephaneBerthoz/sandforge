# Forge Module Audit — 2026-04-30

4 Learnship agents audited the Forge module in parallel.

## Summary

| Lens | Findings | P0 | P1 | P2 | P3 |
|------|----------|----|----|----|----|
| Performance | 13 | 3 | 4 | 5 | 2 |
| Debugger (root cause) | 1 confirmed | — | — | — | — |
| Correctness | 13 | 2 | 5 | 4 | 2 |
| Adversarial | 10 | 3 | 4 | 3 | 0 |
| **TOTAL** | **37** | **8** | **13** | **12** | **4** |

## P0 — fix immediately

### Performance (root cause of the 2:30 freeze)

1. **Sequential BFS in `GraphDiscoveryService.ts:176-270`**
   - 50 nodes × 2 calls (describe + queryCount) × ~1.5s = ~150s
   - Fix: drain queue in waves of 6 with `Promise.all`

2. **Missing per-call timeout** on `queryCount` / `describeObject`
   - `SELECT COUNT() FROM Task` on big org can hang 30-90s; no timeout means freezes forever on rate-limit
   - Fix: wrap with existing `TimeoutManager.withTimeout(15s for COUNT, 30s for describe)`

3. **No describe cache**
   - `extension.ts:156-194` wires deps without memoization
   - 600+ round-trip describes per forge run on big org
   - Fix: use existing `SchemaCache` (TTL 5min, LRU 50MB)

### Security

4. **SOQL injection** at `ForgeExecutor.ts:1006`
   - `sourceRecordId` interpolated raw into WHERE Id = '...'
   - Fix: regex validate `/^[a-zA-Z0-9]{15,18}$/` + `sanitizeSoqlValue`

5. **SOQL injection** in `cli/sandforge-cleanup.ts:182`
   - `--objects`, `--since` flags flow unsanitized into SOQL + `conn.sobject().destroy()`
   - Fix: `assertSoqlIdentifier` on each object + strict regex on `--since`

6. **Webview trust boundary** in `ForgeHandler.ts`
   - No zod validation on `forge:*` payloads, just `as` casts
   - Fix: add zod schemas + `safeParse` at every payload extraction

### Correctness

7. **Upsert externalId field selection** at `ForgeExecutor.ts:768`
   - `fieldInfos.find(f => f.externalId)` non-deterministic when multiple ext IDs exist
   - Fix: filter candidates → prefer fields with non-null + unique values in batch → alphabetical fallback

8. **recordOffset desync** at `ForgeExecutor.ts:792-822`
   - Loop iterates `results.length` but `recordOffset += batch.length`
   - If API returns fewer results, IdRemapper gets cross-contamined entries
   - Fix: track `expected vs actual`, push failure samples for missing results

## P1 — fix soon

### Performance
- Per-node sequential pipeline (parallel source/target describe + parallel orphan expansion)
- O(N×E) topo sort — use adjacency map
- Progress events not throttled (>100/sec on big graphs)
- Discovery cache no TTL/eviction

### Correctness
- Silent describe failures swallow errors (3 catch blocks)
- RecordTypeId double-remap conflict
- Partial-failure threshold — 99% fail still continues to clone children
- Orphan parent expansion can dupe across nodes
- Person Account `IsPersonAccount === true` rate les valeurs string

### Security
- Unbounded OR-chain in scoped SOQL → MALFORMED_QUERY on deep graphs
- Path traversal in dead `ForgeTemplateStore`
- Webview zod validation (covered above)

## P2/P3 — backlog

See full agent transcripts in `.planning/audit-forge-2026-04-30/` (per-agent dump).

## Recommended landing order

**Phase 1 — freeze hotfix (~1h)** :
1. SchemaCache wiring in `extension.ts` (P0-3)
2. TimeoutManager wrapping (P0-2)
3. Promise.all wave-6 BFS (P0-1)
4. Early progress events

Expected: 2:30 → <30s on Mutuaide UAT2.

**Phase 2 — security hardening (~2h)** :
1. Validate `sourceRecordId` (P0-4)
2. CLI sanitization (P0-5)
3. Zod schemas for all `forge:*` payloads (P0-6)

**Phase 3 — correctness hardening (~2h)** :
1. Upsert externalId tiebreaker (P0-7)
2. recordOffset alignment (P0-8)
3. Silent describe error surfacing (P1)
4. Partial-failure threshold (P1)
