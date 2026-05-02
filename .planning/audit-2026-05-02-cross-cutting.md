# Cross-cutting audit — 2026-05-02

**Trigger:** Phase 02 verify-work + user "detect any incoherence/bug/optimization/improvement" directive.
**Mode:** 4 parallel agents (reviewer / agent-shield-redteam / oh-my-claudecode-critic / fast-scout) on the post-v1.2.5 codebase.
**Total findings:** ~50 across reviewer (25) + red-team (12) + perf-critic (15) + fast-scout (30, low-severity surface scan).

## Closed during Phase 02 verify-work (Sprint 1 quick wins)

| ID | Source | Severity | Fix |
|---|---|---|---|
| C3 | Reviewer | CRITICAL | Math.random nonce → `crypto.randomBytes(24).toString('base64url')` in `WebviewPanelManager.ts` + `SidebarViewProvider.ts` |
| C4 | Reviewer | CRITICAL | `currentVersion = '1.0.0'` hardcoded → `context.extension.packageJSON.version` in `extension.ts` |
| L1 | Reviewer | LOW | `nextControlId` Math.random → `crypto.randomUUID()` in `MessageBroker.ts` |
| M6 | Reviewer | MEDIUM | `JSON.parse(JSON.stringify(...))` → `structuredClone(...)` in `SyncExecutionLogger.ts` + `PipelineVersioning.ts` |
| C2 | Reviewer + perf #2 | CRITICAL | HMR-safe CDC listener in `useCDCMetricsStore.ts` (idempotent registration + Vite hot dispose) |
| perf #8 | Perf-critic | HIGH | `addLog` cap at 500 entries in `useForgeStore.ts` (prevents O(N²) memory growth on long runs) |
| RT-#2 | Red-team | HIGH | SOQL identifier injection in `CloneRecordFetcher.ts` — wrapped object name in `assertSoqlIdentifier`, where clause in new `assertSafeWhereClause` (rejects `--`, `/*`, `*/`, trailing `;`, length cap 512) |
| RT-#5 | Red-team | HIGH | `--remap-csv` path traversal in `sandforge-clone.ts` — added cwd containment check, `.csv` extension enforcement, refuse-overwrite-existing-file |
| Test | (test fail discovered during verify) | BLOCKER | `MonitorPage.test.tsx:342` regex `/12/` matched multiple elements — narrowed to `/12[,\s ]?450/` |
| Lint | (lint errors before fix sweep) | LOW | TelemetryAdapter Sentry require eslint-disable widened; ForgeExecutor `let` → `const`; 4 intentional `console.*` calls eslint-disabled inline |
| Cleanup | fast-scout | NOISE | Deleted 2 stale `CLAUDE.md.bak.*` files at repo root + duplicate `phases/phase-00-bootstrap.md` |

**Total closed:** 11 items (covers all CRITICAL nonce/version/listener leaks + 2 HIGH SOQL/path-traversal + Sprint 1 cleanups + test-blocking bug).

## Slotted into Phase 03 (Monitor v2)

| ID | Source | Why Phase 03 |
|---|---|---|
| Perf #1 | Perf-critic | `describeFields` cache miss on target org — naturally folds into TimeSeriesStore / Probe scheduling refactor |
| M1 | Reviewer | CDC polling without `document.visibilitychange` pause — fix ship-along with MetricBus tab-aware subscriptions |
| M5 (subset) | Reviewer | `useGrappeStore.partitions` Map → Record — Monitor stores get the same treatment during fleet-overview work |
| H7 | Reviewer | `BridgeProvider` `useEffect` mount-only effects — converge with `monitor:fleet:summary` boot batching |

## Slotted into Phase 06 (Best Practices & Polish)

| ID | Source | Why Phase 06 |
|---|---|---|
| C1 | Reviewer | `aiProvider` stub returns prompt verbatim — needs `services.aiProvider` factory wiring (BP-01) |
| C5 | Reviewer | `BulkApiManager` re-instanced per message — singleton in `services` (BP-01) |
| H1 | Reviewer | DI ordering (`set*Services` mutable post-construct) — refactor to constructor injection (BP-01) |
| H2 | Reviewer | `WebviewStateSync.dispose()` missing — clean lifecycle pass (BP-02) |
| H3 | Reviewer | `deactivate()` doesn't await `backgroundRegistry` — abort propagation (BP-03) |
| H5 | Reviewer | Per-route `ErrorBoundary` instead of single-root (BP-02) |
| H6 | Reviewer | Bridge nominal types — `BridgeErrorMessage extends BaseMessage` (BP-01 type tightening) |
| H8 | Reviewer | AI auto-resolve throttle + module enrichment (BP-04) |
| RT-#3,#4 | Red-team | `objectConfig.where` schema-level sanitization in Zod — single-source validation (BP-01) |
| RT-#6,#7,#12 | Red-team | CLI runs `forgeConfigSchema.parse` — defense in depth (BP-01) |
| RT-#8 | Red-team | `exec` → `execFile` in `ConnectionHelper.refreshTokenViaCli` (BP-04 hardening) |
| RT-#9 | Red-team | Login URL host whitelist (`*.salesforce.com`, `*.force.com`, ...) (BP-04) |
| Perf #3 | Perf-critic | 2.1 MB IIFE bundle splitting (BP-04 perf pass) |
| Perf #4 | Perf-critic | `bootstrap:hydrate` batched boot — cuts ~150 ms off cold open (BP-04) |
| Perf #6 | Perf-critic | `pendingFkUpdates` cap + incremental flush in Forge (BP-04) |
| Perf #11 | Perf-critic | `useGrappeStore.partitions` Map → Record (cf M5 above; same fix two domains) |
| Perf #13 | Perf-critic | Vitest pool config (`pool: 'threads', isolate: false`) — saves 30-60s on test runs (BP-04) |

## Slotted into Phase 04 (AI Integration)

| ID | Source | Why Phase 04 |
|---|---|---|
| RT-#10 | Red-team | AI prompt injection defense — context delimiters around user-derived record content. Phase 04 builds the AI surface; defense ships with the surface. |
| RT-#11 | Red-team | AI response Zod-validation — `parseAIResponse` regex extract + JSON.parse without schema (NL2SOQL, ErrorResolver, AIPersonaManager, AIDataGenerator). Same plan as #10. |

## Defer / not addressed

- Files >500 lines (fast-scout #12-22): refactor candidates, not bugs. v1.4 backlog.
- 54 `any` occurrences (fast-scout #23-27): incremental, not blocking. v1.4 backlog.
- `audit-fixes.regression.test.ts` kebab-case naming drift (fast-scout #29): cosmetic. Skipped.
- 366 `as unknown as` casts (M5 reviewer): incremental tightening, top-3 files only would be Phase 06 BP-01 scope.

## Verification

- `pnpm -r typecheck`: PASS (post-fix, see verify-work 02)
- `pnpm lint`: PASS (post-fix sweep — 0 errors, 0 warnings on touched files)
- `pnpm test`: PASS (post-test-regex-fix — 8432+ tests, 0 fail)
- Verify-work 02 verdict: **PASS-AUTO** (recorded in `.planning/phases/02-test-hardening/02-VERIFICATION.md`)

## Files modified during the audit fix sweep

```
packages/extension/src/providers/WebviewPanelManager.ts       (nonce crypto)
packages/extension/src/providers/SidebarViewProvider.ts       (nonce crypto)
packages/extension/src/extension.ts                            (currentVersion from packageJSON)
packages/extension/src/bridge/MessageBroker.ts                 (nextControlId crypto.randomUUID)
packages/extension/src/modules/sync/SyncExecutionLogger.ts     (structuredClone)
packages/extension/src/modules/automation/PipelineVersioning.ts (structuredClone)
packages/extension/src/modules/seed/CloneRecordFetcher.ts      (assertSoqlIdentifier + assertSafeWhereClause)
packages/extension/cli/sandforge-clone.ts                      (path traversal containment + .csv enforcement)
packages/extension/src/adapters/telemetry/TelemetryAdapter.ts  (eslint-disable widened)
packages/extension/src/modules/forge/ForgeExecutor.ts          (let→const + 3 console eslint-disable)
packages/extension/src/modules/forge/GraphDiscoveryService.ts  (1 console eslint-disable)
packages/webview/src/stores/useCDCMetricsStore.ts              (HMR-safe listener)
packages/webview/src/stores/useForgeStore.ts                   (addLog cap 500)
packages/webview/src/pages/Monitor/MonitorPage.test.tsx        (regex narrowing)
.planning/phases/02-test-hardening/02-03-SUMMARY.md            (NEW: normalization)
.planning/phases/02-test-hardening/02-VERIFICATION.md          (NEW: auto verify-work)
.planning/phases/03-monitor-v2-core/03-CONTEXT.md              (NEW: discuss-phase 03)
.planning/audit-2026-05-02-cross-cutting.md                    (NEW: this file)
```

Plus deletions: `CLAUDE.md.bak.1774862959`, `CLAUDE.md.bak.1774862961`, `phases/phase-00-bootstrap.md`, `phases/` (empty after the file removal).
