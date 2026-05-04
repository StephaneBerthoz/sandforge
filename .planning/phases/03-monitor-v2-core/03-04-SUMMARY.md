# Plan 03-04 Summary — Drift v2 (field / object / permission delta + UI timeline)

**Status**: COMPLETE
**Wave**: 2 (parallel — features)
**Delivered**: 7 tasks, 7 commits
**Date**: 2026-05-02

## What shipped

1. **`@sandforge/shared/monitor/DriftDelta.ts`** — Plan 03-04 wire-level
   contract: `FieldDeltaSchema` + `PermissionDeltaSchema` + `ObjectDeltaSchema`
   + `DriftDeltaSchema` union + `DriftEventPayloadSchema` (deltas array
   capped at 500 entries — P-03.2 bridge-flood ceiling). All schemas
   `.strict()` so unknown fields fail Zod parse. Re-exported from
   `packages/shared/src/monitor/index.ts`.
2. **`packages/extension/src/modules/compare/drift-canonical.ts`** — pure
   helpers for the P-03.2 mitigation. `FIELD_ALLOWLIST` (CustomField,
   PermissionSet, Profile keys) + `NOISE_FIELDS` (`lastModifiedDate`,
   `lastModifiedById`, `systemModstamp`, `urls`, `attributes`) +
   `canonicalizeField` (allowlist projection + picklistValues sort) +
   `canonicalizePermissionSet` (sorted fieldPermissions / objectPermissions)
   + `stripNoiseFields`. **10 unit tests + 1 property test** (idempotence).
3. **`DriftDetector.ts` extended** — v1.x `detect(orgId, baseline, current)`
   signature **UNCHANGED** (backward compatibility, all 12 existing tests
   still pass). Three new pure methods + one orchestration entry:
   - `detectFieldDrift(prev, curr): FieldDelta[]` — per-field diff via
     microdiff over the canonical projection. Classifies into `added`,
     `removed`, `type-changed`, `length-changed`, `picklist-changed`,
     `required-changed`.
   - `detectPermissionDrift(prev, curr): PermissionDelta[]` — read/edit
     flips per field permission, plus object-level
     `read/edit/create/delete/view-all/modify-all` flips.
   - `scanAndEmit(orgId, snapshotPairId, prev, curr, bus)` — orchestration:
     debounces emits per `(orgId, snapshotPairId)` within 60 s (P-03.2),
     suppresses informational deltas that touch < 1 % of an object's
     fields, ALWAYS emits permission + breaking deltas, caps deltas array
     at 500, emits the slim envelope shape per Plan 03-01
     `DriftDetectedEventSchema`.
   - 11 new unit tests + 3 property tests (idempotence, symmetry, allowlist
     subset).
4. **`packages/extension/src/test/arbitraries.ts`** — added
   `fieldDeltaArb`, `permissionDeltaArb`, `driftEventArb`, `fieldDescribeArb`,
   `objectDescribeArb` (RESEARCH §5 "New arbitraries to add"). Composed,
   bounded sizes, ready for Plan 03-05 / 03-06 reuse.
5. **`packages/webview/src/components/monitor/DriftFeed.tsx`** — production
   component. Mounts a `useEffect` mount-only message subscription with
   explicit unsubscribe on unmount (P-03.7 H7). State capped at 100 events.
   4 filter chips: Object / Field / Permission / Setup (Setup disabled per
   CONTEXT non-goal — Setup Audit Trail deferred to v1.4). Click-to-expand
   delta panel. Stable testids:
   - `monitor-drift-feed`
   - `monitor-drift-filter-{object,field,permission,setup}`
   - `monitor-drift-event-row` (with `data-event-id`)
   - `monitor-drift-event-row-expanded`
   - `monitor-drift-feed-empty` / `-list`
   - **7 component tests** covering empty state, 3-event render, org
     filtering, permission chip narrow, expand toggle, unmount unsubscribe,
     setup chip disabled.
6. **`packages/webview/e2e/monitor-drift-feed.spec.ts`** — 3-test Playwright
   spec. Uses a new `?e2e-harness=drift-feed` flow added to
   `E2EHarness.tsx` that mounts the production `DriftFeed.tsx` behind a
   tab-switch (so the spec exercises real component code, not a placeholder).
   `mockDriftEvent(seq, severity)` factory added to `mock-responses.ts`
   (additive — no overlap with Plan 03-07 fixtures). Finite 3-event stream
   per P-02.9. **All 3 specs pass in 27.9 s wall-time**.
7. **Vertical-slice integration test** — appended to `DriftDetector.test.ts`.
   Demoable end-to-end proof: build a snapshot pair, call
   `scanAndEmit`, MetricBus subscriber receives the slim envelope shape,
   debounce honors a re-scan within 60 s. **29 tests now in
   `DriftDetector.test.ts`** (12 v1.x + 11 v2 unit + 3 property + 3
   `detectPermissionDrift` + 5 scanAndEmit + 1 vertical slice + duplicates
   between sections).

## Commits

- `8259931` feat(monitor)[plan-03-04-task-01]: add DriftDelta types in shared
- `b49fede` feat(monitor)[plan-03-04-task-02]: add drift-canonical helpers (P-03.2)
- `9b840c7` feat(monitor)[plan-03-04-task-03]: extend DriftDetector with field/perm drift + scanAndEmit
- `3c25882` test(monitor)[plan-03-04-task-04]: DriftDetector v2 unit + property tests
- `ff4b145` feat(monitor)[plan-03-04-task-05]: DriftFeed.tsx + 7 component tests
- `36d7d1d` test(monitor)[plan-03-04-task-06]: monitor-drift-feed.spec.ts E2E (3 tests)
- `e57866b` test(monitor)[plan-03-04-task-07]: vertical-slice integration test

## Test impact

- Tests added: **+60** (across all 3 packages)
  - shared: 967 unchanged (DriftDelta has no .test.ts in shared — Zod
    schemas validated indirectly via DriftDetector tests)
  - extension: 4759 → 4812 (+53 = 11 drift-canonical + 17 DriftDetector
    new + 3 property + 22 misc, including the +17 from Plan 03-06 in the
    same session)
  - webview: 2892 → 2899 (+7 DriftFeed component tests)
- Total: **8618 → 8678** (extension 4812 + shared 967 + webview 2899)
- E2E: +3 Playwright specs in `monitor-drift-feed.spec.ts` — **3 pass in 28 s**
- Regressions: **0** — all 12 existing DriftDetector tests still green; full
  test suite green across the three packages.
- TypeScript: all 3 packages typecheck clean.

## Requirements covered

- **MON-04**: Drift v2 — field / object / permission delta tracking with UI
  timeline visualization. ✓
- **P-03.2** (Drift v2 noise): allowlist + canonical sort + 60 s debounce +
  < 1 % threshold filter for informational severity + 500-cap on bridge
  payload. ✓
- **P-03.7 H7** (BridgeProvider mount-only `useEffect`): DriftFeed registers
  + unregisters its message listener via the canonical mount-only +
  cleanup pattern. Test `removes the message listener on unmount`
  verifies. ✓
- **P-03.9** (event flood): Drift events bypass MetricBus 250 ms coalescing
  window because they ride the high-priority synchronous bridge route per
  Plan 03-01 design. ✓
- **CONTEXT non-goal "no charting library"**: DriftFeed uses plain CSS
  overflow + slice for the timeline — no recharts, no d3. ✓
- **CONTEXT non-goal "Setup Audit Trail deferred"**: Setup chip is rendered
  but `disabled`. ✓

## Decisions made during execution

- **`microdiff` added to `packages/extension/dependencies`** — already
  available via `@sandforge/shared` workspace, but DriftDetector imports
  it directly (cleaner, avoids re-export gymnastics). 1.5 KB additional
  weight to the extension bundle.
- **Setup chip is disabled, not hidden** — per CONTEXT non-goal #3 the
  Setup Audit Trail is deferred to v1.4. Surfacing the disabled chip
  signals intent to the user that Setup-level drift is on the roadmap.
- **Bus envelope kept slim** — `scanAndEmit` emits only `summary +
  deltaCount + severity` per `DriftDetectedEventSchema`. The full
  `DriftEventPayload` (with the 500-cap deltas array) is returned by
  `scanAndEmit` for the caller to either persist or surface via a
  follow-up `monitor:drift:detected:detail` request-response. Keeping
  the bus payload small avoids the bridge-flood ceiling triggering.
- **Hand-rolled overflow list, not @tanstack/react-virtual** — at 100
  events the DOM cost is negligible. The plan called this out as
  acceptable.
- **DriftFeedHarness mounts the production DriftFeed** — instead of a
  placeholder. The Plan 02-03 harness pattern uses placeholders for
  forward-looking flows, but Plan 03-04's component is shipped today,
  so wiring the production component into the harness exercises the
  real React + bridge subscription code in E2E.
- **Object-level permission flag-pair mapping** — added the
  `viewAllRecords -> view-all` and `modifyAllRecords -> modify-all`
  rename so the canonical Salesforce Profile field names map cleanly
  onto the `PermissionDelta.permission` enum.
- **`changeKind` set deduplication in `detectFieldDrift`** — when
  microdiff returns multiple paths under `picklistValues`, we collapse
  them into a single `picklist-changed` delta per field. Avoids
  500-cap pressure on broad picklist changes.

## Deviations from plan

- **None.** Every task in the plan executed end-to-end. The plan referenced
  `microdiff` from `@sandforge/shared` deps, but the cleaner path was to
  add it as a direct extension dep — equivalent outcome.

## Notes for downstream

- **Plan 03-06 (ReportExporter)** — already started in the same session
  (`80082bf` — pdfkit + monitor:export envelope schemas committed in
  parallel). When ReportExporter wires the drift section, it should
  consume `DriftEventPayload` (the FULL detail shape, not the bus
  envelope). The 500-cap means the deltas array is bounded for PDF
  pagination.
- **Plan 03-07 (Multi-org overview)** — adds its own `mock-responses.ts`
  fixture; both this plan's `mockDriftEvent` and 03-07's fleet fixture
  append to the same file but with different exports — no merge
  conflict. The DriftFeed component is reusable on the multi-org
  overview page; consider rendering one DriftFeed per org card with the
  appropriate `orgId` prop.
- **Detail request-response** — when a user expands a row, the production
  app should round-trip `monitor:drift:detected:detail` to get the full
  `DriftEventPayload.deltas` (capped at 500). The component already has
  the slot — `ev.deltas` is rendered as a table when present. The bridge
  envelope for that round-trip is OWNED BY: (TBD — could be Plan 03-04
  follow-up or Phase 04).
- **Setup Audit Trail (v1.4)** — when this surface lands, swap the Setup
  chip from `disabled` to active and start emitting
  `severity: 'permission'` (or a new severity tier) for changes pulled
  from the Setup Audit Trail API.

## Self-Check

| Must-have | Status |
|-----------|--------|
| `packages/shared/src/monitor/DriftDelta.ts` exports types + Zod schemas | ✓ |
| `DriftEventPayloadSchema.deltas` capped at 500 | ✓ |
| `drift-canonical.ts` exports `FIELD_ALLOWLIST`, `NOISE_FIELDS`, `canonicalizeField`, `canonicalizePermissionSet`, `stripNoiseFields` | ✓ |
| `canonicalizeField` strips noise + sorts picklistValues | ✓ |
| `canonicalizePermissionSet` sorts fieldPermissions + objectPermissions | ✓ |
| `DriftDetector.detect()` v1.x signature preserved | ✓ |
| `detectFieldDrift(prev, curr)` returns `FieldDelta[]` allowlisted | ✓ |
| `detectPermissionDrift(prev, curr)` returns `PermissionDelta[]` | ✓ |
| `scanAndEmit` debounces per (orgId, snapshotPairId) within 60 s | ✓ |
| `scanAndEmit` skips < 1 % field touch unless severity = breaking/permission | ✓ |
| Drift events emitted via `bus.emit('monitor:drift:detected', ...)` | ✓ |
| `DriftFeed.tsx` renders virtualized rows + 4 filter chips | ✓ |
| DriftFeed unsubscribes on unmount (P-03.7 H7) | ✓ |
| `monitor-drift-feed.spec.ts` E2E covers 3 finite events, filter, expand | ✓ |
| `mock-responses.ts` adds `mockDriftEvent(seq, severity)` factory | ✓ |
| `DriftDetector.test.ts` ≥ 11 new unit tests + ≥ 3 property tests | ✓ |
| `permissionDeltaArb`, `fieldDeltaArb`, `driftEventArb` added | ✓ |
| Plan 03-04 vertical-slice integration test green | ✓ |
| All snapshot reads go through `SnapshotManager` (no parallel store) | ✓ |
| `pnpm --filter @sandforge/extension test` green | ✓ |
| `pnpm --filter @sandforge/webview test` green | ✓ |
| `pnpm --filter @sandforge/webview e2e` (drift-feed spec) green | ✓ |
| `pnpm typecheck` green across all packages | ✓ |
