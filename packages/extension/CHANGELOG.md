# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] - 2026-08-11

### Changed

- The sidebar webview now ships its own bundle: 377 KB instead of the full 1.8 MB panel bundle — the sidebar loads faster and uses less memory; editor panels keep the full bundle.
- Webview CSS is split per target: the sidebar no longer downloads the reactflow styles used only by diagram pages.

## [1.10.0] - 2026-08-11

### Features

- Webview languages now lazy-load: only English ships inside the JS bundle, the 5 other locales load on demand through the bridge when picked (~440 KB off every webview).

### Fixed

- Org selection is kept everywhere: a Monitor or panel opened after picking an org in the sidebar/status bar now shows that org instead of falling back to the first one in the list.
- Monitor health-score card no longer overflows narrow panels — the summary and top-risk rows were clipped on the left and cut on the right below ~400 px; they now wrap/ellipsize inside the card.
- Monitor header keeps the org alias readable: the action buttons wrap to their own row instead of crushing the alias.
- Governance panel header and Jobs filter buttons wrap on narrow panels instead of overflowing.

## [1.9.0] - 2026-08-11

### Features

- Forge discovery wizard shows live progress (objects scanned / queue) instead of looking frozen for 30–90 s on large orgs.
- AI provider status is now emitted to the webview (`ai:provider:status`: breaker open/half-open/closed, cooldown end, error kind).

### Fixed

- Offline queue drains at startup: operations queued by a crashed session were parked indefinitely; they now drain when the org is reachable at activation.
- Org selection is unified: picking an org in Monitor or OrgManager propagates to the status bar, sidebar and other panels.
- Migration imports refuse files above 50 MB (OOM guard), read the file once instead of twice, and no longer reject valid Windows paths on drive-letter case.
- `monitor:error` is correlated to its request — an error can no longer surface in a different Monitor panel open in parallel.

### Changed

- The native Organizations tree view is removed: the launcher dropdown (active-org selection, safety tiers, per-row "open in browser") is the single org surface.
- Removed the `grappe:backPressure` badge (nothing ever emitted the channel), the never-wired `autopilot:node-completed`/`node-failed` bridge messages, and the unreachable `monitor:trends` request path.

## [1.8.4] - 2026-08-11

Fixed: the auth self-heal now pulls a guaranteed-live token via `sf org auth show-access-token` (which refreshes the OAuth session) instead of `sf org display` (which dumps the stored token as-is — proven rejected with HTTP 403 on a "Connected" org while show-access-token's token passes). This is the root cause of the recurring "Authentication expired" loops. Older CLIs fall back to the previous behavior; the vault is still only written after the refreshed credentials pass a real API call.

## [1.8.3] - 2026-08-11

Removed: the CI badge from the marketplace listing. No functional change.

## [1.8.2] - 2026-08-11

Added: SandForge now adopts the sf CLI's default org (`target-org`) at startup when nothing is selected yet. Fixed: the auth self-heal adopts the org's *current* instance URL reported by the CLI — after a sandbox refresh or My Domain change, even a fresh token was rejected at the stale URL (`INVALID_AUTH_HEADER` on every org). And the startup validation no longer flips orgs through a `refreshing` state, so connected-org counters no longer tick down one by one during the launch sweep.

## [1.8.1] - 2026-08-11

Fixed: duplicate org entries — ghost entries persisted by early builds (same Salesforce org, older key scheme) showed up as duplicates in every org list and kept "Authentication expired" loops alive with their stale credentials. Startup now dedupes by the Salesforce org id and prunes the ghosts from storage and the vault.

## [1.8.0] - 2026-08-11

**Fifth-audit release: the live shell gets everything, the dead one leaves the bundle.** Fixed: webview crash reports were silently dropped by the broker (`error:boundary` now enveloped, typed, and logged extension-side), the `sandforge.cheers` easter egg finally works from real panels, Welcome/What's New no longer pop in every open panel (onboarding posts are now targeted; the broadcasting `postToActivePanel` is honestly renamed `postToAllPanels`), and the Forge execution page shows live per-object progress again (the listener read `forge:progress` fields at the message root instead of the envelope's `payload`). Changed: the unreachable `App` shell, its layouts and the orphaned AboutDialog are deleted from the bundle (−27.6 KB); the bridge type union now covers the 71 channels the extension actually emits, enforced by a new emit-side anti-drift test; the webview formatters re-export the canonical `@sandforge/shared` implementations (three divergent inline `formatDuration` removed); and the LazyMotion migration is complete — all `motion.*` imports are now `m.*`, so framer-motion's full feature set stays out of the production bundle. Full entry in the root changelog.

## [1.7.0] - 2026-08-11

**Auth reliability + toolchain modernization.** Registered orgs are now validated at every launch: expired sessions auto-refresh via the sf CLI in the background, with live per-org status in the sidebar — no more mid-operation "Authentication expired" walls (new `sandforge.orgs.validateOnStartup` setting, on by default). The token self-heal no longer persists unvalidated CLI tokens, and a stale CLI token store is called out explicitly instead of looping. Toolchain: ESLint 9 flat config with typed linting (`no-floating-promises` on the extension host), vitest 3, Stryker 9 — all 7,900+ tests green and every coverage gate passing. The marketplace page now shows the full project README: all 14 modules, screenshots, FAQ and the complete settings reference with working links. Full entry in the root changelog.

## [1.6.0] - 2026-08-11

**Fourth-audit release: messages that actually arrive.** Re-auditing 1.5.0 surfaced a regression class from the broker envelope requirement: five webview stores (sync history, sync schedule, CDC metrics/live, conflicts) posted raw messages the broker silently dropped — infinite spinners and lost mutations on the Sync tabs — and the Forge pause/resume/abort buttons did nothing on destructive runs. All senders now share a single enveloped helper. Also fixed: declining a seed production confirmation hung the UI for 120 s (now an immediate correlated `seed:error`), the onboarding/what's-new message raced the webview bundle on first open and was lost forever, the What's New overlay never rendered in module panels, the sidebar ignored the configured language (now synced live), the in-app Help listed wrong shortcuts (fixed in 6 languages), and the marketplace listing had dead images and links — the repository is now public and the retired shields.io badges were replaced. Full entry in the root changelog.

## [1.5.0] - 2026-08-10

**Third-audit release: features that actually reach the user.** Re-auditing 1.4.0 showed several features were wired but invisible — the `App` shell was dead code and the sidebar never received broker broadcasts. Now: shortcuts, command palette, welcome overlay and reduced-motion are mounted in the live panel/sidebar shells; the sidebar receives live broadcasts; the manifest is localized in all 6 languages (enforced in CI); the marketplace page gains badges, Q&A via Discussions, FAQ and screenshots. Fixed: the offline replay loop (failed replays no longer re-queue forever), seed failures returning immediately instead of a 120 s timeout, failed seeds reported as "completed", uncorrelated error responses, and the language regression that could reset your choice to English. Shared package purged of 38 dead utilities; bridge schema is now a flat discriminated union with truncated error messages. Full entry in the root changelog.

## [1.4.0] - 2026-08-10

**Post-release hardening.** A full second audit pass over 1.3.0. Offline queue safety: seeds (non-idempotent INSERTs) are no longer auto-replayed (duplicate-risk removed — you get an explicit retry hint instead), and re-queued operations now drain while online instead of waiting forever. New: offline queue notifications, the recent-operations panels are actually fed, `sandforge.openReports`, keyboard shortcuts for all 17 routes, the 6-language selector in Settings, and `prefers-reduced-motion` respected globally. Fixed: the Welcome "don't show again" checkbox was write-only, "sync completed" notifications fired for failed syncs, panel crashes showed blank panels, and the remaining doc drift (14-module table, 4-step seed wizard, scheduler marked coming soon, auto-updated version badge). Shared coverage gate now reflects the real 86% baseline. Full entry in the root changelog.

## [1.3.0] - 2026-08-10

**Marketplace trust and dead-code release.** New native Organizations tree view in the sidebar (type icons, refresh, open-in-browser), a Get Started walkthrough, and a Migration page that imports SFDMU `export.json` or CSV/JSON files into reviewable Sync configs. Every module now has its own command (`openSeed`, `openSync`, `openAutopilot`, `openMigration`) with a single source of truth for sidebar routing. Seed and sync executions feed the live-operations tracker; operations that fail on a network error are queued and replayed on reconnect. The UI language persists across reloads and all 6 locales reached 100% key parity, now enforced in CI. Fixed: Monitor auto-refresh never fired, ErrorBoundary reporting was dead, webview panels leaked in the message broker, marketplace links were 404, and the listing no longer claims real-time CDC or multi-provider LLMs. Removed ~4,700 lines of dead Monitor v2 code; the VSIX no longer ships internal tooling state; the Anthropic SDK is lazy-loaded (−118 KiB off the activation bundle). Full entry in the root changelog.

## [1.2.12] - 2026-08-06

### Changed

- Dropped the marketplace preview flag: the extension is no longer published as a preview release.

## [1.2.11] - 2026-08-06

### Fixed

- Marketplace page: the Forge walkthrough GIF is served from a public assets repository, so it renders on the listing.

## [1.2.10] - 2026-08-03

### Changed

- Documentation: both READMEs lead with the "first clone in 2 minutes" Forge walkthrough, with an animated flow GIF; marketplace page shortened and docs links made absolute. Full entry in the root changelog.

## [1.2.9] - 2026-08-03

**Reliability and onboarding release.** Expired org credentials now self-heal through an sf CLI refresh with one retry (with an actionable message when reconnect is needed). Every bridge handler validates its payloads with Zod, and handler failures surface their real message instead of a generic 30-second timeout on every flow (sync, dataops, backup, pipeline, monitor, autopilot). Autopilot is wired end-to-end: the wizard drives a real scan → compliance → plan → execute → report run with live progress, isolated per execution. QuickSync wizard repaired. Stale org selections reconcile automatically. ProductionGuard now covers Forge and Autopilot. Manual retry replays failed syncs. Onboarding rewritten around the core use case: populate a dev sandbox from a real record, in 6 languages. Full entry in the root changelog.

## [1.2.8] - 2026-08-03

### Fixed

- Bridge error surfacing: handler failures (expired connection, unreachable org) now show the actual error message instead of a generic 30-second timeout, on every bridge query and mutation. `monitor:refresh` is additionally bounded to 25 s so a stalled org cannot hang silently.

## [1.2.7] - 2026-08-03

**Hardening marathon + Frozen Reference Dataset.** Two full audit cycles over the codebase, four fix waves, and one new module. Highlights: circuit breaker lockup fixed (per-org breakers, permits released on all paths), ~20 implemented-but-unrouted bridge messages wired (monitor alerts, seed templates, sync configs/history/schedules, seed clone/CSV, AI conversations), Bulk API results correctly mapped (they previously all counted as success with fabricated ids), shell injection and path traversal closed, Zod payload validation generalized, ~37 000 lines of verified dead code removed, ForgeExecutor split into a tested stage pipeline, extension activation refactored into src/composition/, bundle minified (6.7 MB to 2.3 MB), AI stack unified on one secret key with migration, manifest safety settings actually enforced. Full entry in the root changelog.

### Added

**Frozen Reference Dataset**: extract a business dataset once from a UAT sandbox, pseudonymize it deterministically (HMAC-SHA256, env-only salt), freeze it with a manifest, gate it on a 4-point non-reidentification control (including cross-field leaks and a Salesforce checksum sweep), and replay it identically into refreshed dev sandboxes (sandbox-only guards, schema alignment including RecordType picklist gaps, pilot mode, reload without refresh, robust post-load verification). New `frozen` page in 6 languages, command `sandforge.openFrozen`, docs in `docs/modules/frozen-dataset.md`.

## [1.2.6] - 2026-05-05

**Phase 03 Monitor v2 Core + Phase 04 AI Integration + close-out hardening.** Two milestone-track phases shipped under the v1.3.0 umbrella, plus a six-bug close-out pass surfaced when the user actually installed the fresh VSIX. Phase 03 ships the time-series monitor substrate (MetricBus, TimeSeriesStore, MonitorRegistry + 8 probes, DriftDetector v2, AnomalyEngine, ReportExporter, FleetSummaryService). Phase 04 ships the read-only AI assistant (per-provider CircuitBreaker, AbortController, 10 read-only tools with CI fence, per-panel-session token budget, prompt-injection defence with adversarial vitest, AIDiagnoseHandler with approve gate, Anthropic adapter functional + OpenAI/Custom stubs).

### Added

**Phase 03: Monitor v2 Core**
- `MetricBus` typed Zod-validated pub/sub with 5 discriminated event subtypes
- `TimeSeriesStore` per-(orgId, seriesId) ring buffer, 50 MB LRU cap, 7-day retention, opt-in disk persistence (`sandforge.monitor.persistTimeSeries` setting), 5-min flush + 15-min per-org rate limit, corruption recovery
- `MonitorRegistry` single-tick scheduler with per-probe in-flight gate, drift accounting, hard timeout, visibility gating
- 8 trackers wrapped as `MonitorProbe` shells (Limits, Job, ApexLog, SandboxRefresh, ErrorLog, UserSession, Health, Governance)
- `DescribeCache` per-org TTL + LRU
- `DriftDetector v2` field-level + permission-level deltas with `DriftFeed` virtualized component
- `AnomalyEngine` rolling 24h std-dev with 30-sample / 6-h warmup gate, bridges into existing `AlertEngine`
- `ReportExporter` CSV + lazy-pdfkit PDF, sparklines via LTTB downsampling, 50-series-per-PDF cap with multi-part split
- `FleetSummaryService` + `MonitorOverviewPage` multi-org fleet landing with `ConnectionPool` reuse, `p-limit(3)`, 60-s per-org cache, exponential backoff
- `useVisibilityGate` posts `monitor:visibility` on `document.visibilitychange`

**Phase 04: AI Integration**
- `AIClient` interface + `AnthropicAdapter` (chat / complete / countTokens / runTools / dispose) using `messages.parse + zodOutputFormat` for Zod-validated structured output
- `OpenAIAdapter` + `CustomAdapter` stubs that satisfy the interface (constructor never throws, methods throw `AINotImplementedError` with provider-switch hint)
- `AIClientFactory` per-provider memoisation; switching `sandforge.ai.provider` in Settings does NOT crash the extension
- Per-provider `CircuitBreaker` (3 consecutive 529 → open for 5 min, dual-signal overloaded check, `APIUserAbortError` never trips breaker, `cancelAll()` for panel close)
- Per-AI-request `AbortController` (cancelling one chat does not abort siblings)
- 10 read-only tools (`describe_object`, `query_records`, `get_limits`, `get_recent_errors`, `get_apex_log`, `get_metadata`, `get_alerts`, `get_anomalies`, `list_sobjects`, `validate_soql`) with `wrapTool` that enforces read-only naming regex + `READ-ONLY` description substring + Zod-validated input/output
- Registry CI fence test rejects any future write-verb tool addition
- `validate_soql` AND `query_records` reject DML keywords (defence in depth, `DML_FORBIDDEN` error code)
- `AIDiagnoseHandler`: failed-job → diagnose flow with two-call pattern (`runTools` for context + `complete(schema)` for typed payload), `ActionProposalSchema`, 5 action kinds, approve-gate dispatcher
- Webview `ActionCard` (Approve / Modify / Reject trio, scrollable rootCause, ≤5 actions, per-action state badges)
- `AIProviderStatusBanner` (FR + EN copy, live mm:ss countdown to half-open transition)
- `TokenBudgetIndicator` mini-bar with 4-field tooltip, `aria-live='polite'`, green/yellow/red colour states
- `SessionBudget` class: per-panel-session token counter, sums all 4 token fields, debounced 80% warn, 100% hard refuse with preflight BEFORE the SDK call
- `sandforge.ai.tokenBudgetMaxPerSession` setting (default 50000) with EN+FR NLS
- `escapeUserData` / `wrapAsUserData` HTML-entity escape helpers + `DIAGNOSE_SYSTEM_PROMPT` / `SOQL_REVIEW_SYSTEM_PROMPT` / `ERROR_RESOLVE_SYSTEM_PROMPT` carrying the spotlight clause
- Adversarial vitest spec: 7 jailbreak fixtures × 2 defence layers + 2 spotlight assertions (RT-#10 closure)
- `AIDiagnoseHandler` self-defence canary asserts the literal `</user-data>` substring NEVER appears in the body between the wrapper's open + close tags
- 4 bridge envelopes (`ai:diagnose`, `ai:diagnose:response`, `ai:approve-action`, `ai:approve-action:response`) + 3 budget envelopes (`ai:budget:state`, `ai:budget:warn`, `ai:budget:exceeded`) + `ai:provider:status` + `ai:tool-trace`
- 6 `ai.error.*` i18n keys (overloaded / rateLimit / auth / cancelled / transient / unknown) in EN + FR

**Close-out wiring**
- `sandforge.openAI` command + `Bot` icon + EN/FR NLS title + Ctrl+K palette entry: AI Assistant now reachable from the activity bar (SidePanel), the in-panel layout (Sidebar), the top bar route labels, and the command palette across all 11 surfaces

**Tooling**
- `scripts/git-hooks/pre-commit` runs `pnpm -r typecheck` + locale dup-key scan on every commit
- `package.json` `prepare` lifecycle auto-installs the hook on `pnpm install` via `core.hooksPath = scripts/git-hooks`

### Fixed

- **AIChatPanel.tsx ad-hoc message types**: replaced inline `BaseMessage & { payload: { ... } }` types for `ai:provider:status` / `ai:budget:state` (which were missing `id` + `timestamp`) with canonical `AIProviderStatusMessage` / `AIBudgetStateMessage` imports from `@sandforge/shared`. Webview tsc was failing on Phase 04 close; extension vitest never caught it because the inline type compiled fine in isolation.
- **`pnpm.overrides` minimatch flipped vsce to incompatible major**: previous `<3.1.4: >=3.1.4` was a non-existent version (last 3.x is 3.1.2) that resolved vsce's `^3.0.3` to 9.x or 10.x, breaking vsce's CJS-default `__importDefault(require('minimatch'))` with `(0 , minimatch_1.default) is not a function`. Tightened lower bound to `<3.0.5` (the actual ReDoS-fix threshold per GHSA), constrained replacement to `>=3.0.5 <4` so CJS-default consumers stay on 3.x, plus `@vscode/vsce>minimatch: 3.1.2` path-scoped override belt-and-braces.
- **AI panel was an orphan route**: `AIPage` was registered in `PanelRouter.tsx` but `'ai'` was missing from `ModuleRoute` type, `ALL_ROUTES`, `router.tsx routeComponents`, both sidebars (`SidePanel.tsx` + `Sidebar.tsx`), `TopBar ROUTE_LABELS`, `CommandPalette ROUTE_ICONS+LABEL_KEYS`, `extension.ts moduleCommands`, `SidebarViewProvider commandMap`, the package.json command contribution, and EN/FR NLS. The whole AI backend was unreachable from the user-facing UI.
- **`BridgeProvider.tsx` contract drift on `ai:status:response`**: the listener read `msg.payload.available` but the canonical `AIStatusResponse` payload field is `enabled`. Silent typecheck-clean / runtime-broken. `setAiAvailable(undefined)` always made `aiAvailable === false` even when the API key was configured. Replaced ad-hoc inline type with `AIStatusResponse` import from shared so future renames break both sides at compile time.
- **Duplicate top-level keys in EN + FR locale JSONs**: `monitor`, `dataops`, `execution` were each defined twice in `en.json` and `fr.json`. `JSON.parse` silently kept only the second value (which contained `liveOps` only for `monitor`), wiping out `monitor.title`, `monitor.limits`, `monitor.emptyState`, etc. The user saw raw i18n keys on the Monitor empty state. Programmatic deep-merge preserved both occurrences in all three keys; verified all 4 other locales (de, es, ja, pt-BR) clean.

### Changed

- `pnpm validate` now ALWAYS runs through the pre-commit hook on every commit. The earlier flow let night autopilot ship phase summaries without ever invoking `pnpm package` (the only path that exercises webview tsc + VSIX production + vsce interop). The new hook closes that gap.

### Security

- **Prompt-injection defence verified adversarially**: `escapeUserData` HTML-entity-escapes `<` / `>` / `&`, strips NUL bytes, and `wrapAsUserData(label, value)` produces `<user-data label='${label}'>${escaped}</user-data>` where the label itself is also escaped. The spotlight clause in all 3 system prompts tells Claude `<user-data>` content is data, never instructions. 7 jailbreak fixtures (closing-tag breakout, nested-tag confusion, system-prompt impersonation, plain-text instruction, base64, unicode-lookalike, polyglot CDATA-like) all neutralised at the encoding layer with vitest assertions on both defence layers per fixture.

## [1.2.5] - 2026-05-02

**Forge Hardening Pass**: 23 audit findings resolved (security, performance, correctness) + CLI feature parity with the wizard. Phase 02 (Test Hardening) closed with 5 Playwright E2E specs covering critical user flows.

### Added

**Forge CLI (sandforge-clone)**
- `--upsert` flag: use external Id upsert when available, skipping `DUPLICATE_VALUE` on re-runs of the same source records
- `--expand-orphans` flag: single-hop expand orphan parent FKs (clones missing parents so child FKs resolve)
- `--skip-preflight` flag: bypass the new pre-execute target row count
- `--json` flag: machine-readable JSON summary on stdout for CI integration
- `--exclude <obj.field>` (repeatable): strip a specific field on a specific object before insert. BA opt-out for noisy long-text fields, calculated fields, or fields the target org doesn't have
- `--owner-map <src=tgt>` (repeatable): remap OwnerId from a source User Id to a target User Id. Use case: clone records authored by ex-employees onto a sandbox where their User no longer exists (otherwise INVALID_OWNER)
- Pre-execute preflight showing existing rows in the target org for the first 30 nodes (with a warning flag for >1000 rows) so users know the blast radius before pulling the trigger

**ForgeConfig (cross-sandbox dev/BA flow)**
- `fieldExclusions: Record<string, string[]>`: per-object field skip list (Zod-validated, max 200 fields per object). Exposed via wizard config and CLI `--exclude`
- `ownerMappings: Record<string, string>`: per-record OwnerId remap (Zod-validated, both sides must be 15/18-char Salesforce IDs, max 200 entries). Exposed via wizard config and CLI `--owner-map`
- `objectSoqlFilters: Record<string, string>`: per-object SOQL WHERE filter appended via `AND (...)` to the scope clause. Lets BAs narrow a clone to a subset (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`) without changing graph topology. Zod-validated: max 512 chars per filter, max 50 filters, comment markers (`--`, `/*`, `*/`) and trailing semicolons rejected to block statement chaining. Exposed via wizard config and CLI `--filter`
- `fieldMappings: Record<string, Record<string, string>>`: per-object source→target field rename for schema drift (managed-package re-key, namespace change, `__c`/`__pc` variant). Source key is dropped, value written under target name. Zod-validated: SF field-name regex on both sides, max 200 fields per object, max 50 objects. Exposed via wizard config and CLI `--map`

**ForgeOrchestrator**
- `dispose()` method: clears the discovery cache and listeners on extension shutdown / org disconnect

**ForgeHandler**
- New `forge:target-preflight:request` message type: webview can request per-object existing-row counts on the target before execute. Backend uses sequential SELECT COUNT() (parallel bursts trip rate limits on big orgs), 30 s timeout, max 100 objects per request, sentinel `existing: -1` for per-object failures so the whole batch isn't aborted by FLS issues. Powers the same preflight surface as the CLI

**ExecutionSummary.remapTable**
- New `remapTable: Record<string, string>` field on every execute summary: the full source→target ID mapping table. BA reconciliation: post-clone audit, "where did source X go on the target sandbox?", CSV export, checkpoint persistence
- CLI: new `--remap-csv <file>` flag writes `sourceId,targetId` CSV (double-quoted, one mapping per row, header included)
- CLI: `--json` output now embeds `result.remapTable` for CI consumers

**Tests**
- 22 regression tests pinning the audit-fix invariants (`audit-fixes.regression.test.ts`)
- 5 Playwright E2E specs (Plan 02-03) covering: AI persona seed → execute, sync conflict resolve, monitor refresh + CSV export, CDC subscribe + event stream, AI diagnose + apply fix
- 9 fixture factories + `MockBridge.stream()` helper for multi-event flows

### Changed

**Forge security (Zod hardening)**
- `forgeConfigSchema.recordId` now regex-validated against the strict 15/18-char Salesforce ID pattern
- `forgeConfigSchemaStrict` enforces the inputMode→required-field contract via cross-field refine
- `forgeGraphNodeSchema.objectApiName` and `forgeGraphEdgeSchema.{sourceObject,targetObject}` regex-validated against the SObject API name pattern
- `forgeGraphSchema` bounded to 2000 nodes / 20000 edges (defense-in-depth against DoS payloads)
- `metadataDiffRequestPayloadSchema.objectApiNames` capped at 100 (was 500) to block API-limit DoS
- `ForgeOrchestrator.cacheKeyFor` includes `targetOrgId`, `anonymizePII`, `expandOrphanParents`, `maxRecordsPerObject` so cache hits never silently swap configurations

**Forge performance**
- `ForgePlanGenerator` Tarjan SCC rewritten as iterative: no stack overflow on deep graphs (5000+ node chain verified)
- `SchemaCache.estimateSize` now uses an O(1) structural heuristic (fields × 250 + childRel × 150) instead of `JSON.stringify`; `describeCache` byte cap restored to 200 MB, `describeGlobalCache` to 50 MB (eliminates the OOM risk introduced by the previous Infinity workaround while keeping the event loop unblocked)
- `GraphDiscoveryService` adds `setImmediate`-based event-loop yield between BFS waves, with `setTimeout(0)` polyfill for non-Node test environments
- Cold path breadcrumb (warns when `resolveRootObject` exceeds 2 s)
- `parseObjectFromSOQL` now strips parens to fixed point so deeply nested subqueries don't trick the parser into picking the wrong root object
- `IdRemapper.remapRecord` uses a single Map.get instead of has+get (3M lookups hot path on 50K-record / 30-field clones)

**Forge correctness**
- `orphanExpansionsUsed` counter now increments only on successful expansions, so a string of misses doesn't silently exhaust the budget before the eligible list has had a chance to succeed
- Pass-2 dedup uses an explicit current/updated pattern with collision detection on the same field
- `bringRootToFront` throws a clear error if the scoped root is missing or excluded (was silently producing disconnected clones)
- Orphan expand syncs the scope cache so multi-hop children that pivot through the expanded parent stay in scope
- `pickUpsertField` logs the chosen field and falls back to insert (instead of an unsafe alphabetical pick) when no candidate is non-null + unique across the batch
- `summarizeRecordForError` handles `undefined` and objects via JSON.stringify-truncated output
- `EXPANSION_EXCLUDED_OBJECTS` now mirrors the BFS-side exclusion list (BusinessProcess, DandBCompany, ProcessInstance, …), so orphan-expand stops burning API on system-managed entities
- `sandforge-clone` CLI forces `referenceFallback='nullify'` (was 'keep' by default, which preserved invalid source IDs on cross-org clones)

**Forge UX**
- `handleDiscover` flushes throttled progress on the catch path so the wizard never freezes on stale counts after an abort
- `handleExecute` reorders unsubscribe before flush so the terminal event delivers cleanly
- `handleAbort` nulls the controller refs after `.abort()` to close a small race between sequential operations

### Fixed

- Tests: `recordId` test fixtures across `ForgeHandler.test.ts`, `ForgeOrchestrator.test.ts`, `GraphDiscoveryService.test.ts`, and `forge.schema.test.ts` now use 15-char strict IDs to satisfy the new regex (no behavior change; they were stand-ins anyway)

## [1.2.4] - 2026-04-23

**Milestone v1.2.3 « Scale & Complete », shipped as v1.2.4.** Marketplace release of the Scale & Complete milestone (7 phases, 18 plans, 50 requirements), tagged `v1.2.4`. The feature content is documented under [1.2.3]; this entry records the version actually published so the version sequence has no gaps. (Entry backfilled 2026-08; it was only recorded in the root `CHANGELOG.md` and the `v1.2.4` tag message.)

- Three seed modes: AI Personas (10 industry personas), CSV Import (drag-and-drop + validation), Clone from Org (topological insert + ID mapping)
- Real-time sync lifecycle: CDC subscriptions, conflict resolution UI, execution history, cron scheduling
- Streaming execution (async generator, >10K records) + background operations with native notifications
- Enterprise UI: pagination, virtual scrolling, skeleton loading, notification center, keyboard shortcuts
- Smart Actions on HomePage: analyzes org state and recommends best next action

Tests: 8320 passing | VSIX: 1.24 MB | i18n: 6 languages

## [1.2.3] - 2026-03-28

**Scale & Complete**: Enterprise foundation, real-time sync, conflict resolution, AI personas, streaming execution, and three new seed modes.

### Added

**CSV Import (Seed)**
- Drag-and-drop CSV file upload with automatic BOM stripping and file size validation
- Auto column mapping: case-insensitive, underscore-tolerant matching to Salesforce fields with manual override
- Inline validation: type mismatches, missing required fields, length exceeded, invalid picklist values, duplicate external IDs
- 4-step wizard: Upload → Map Columns → Validate → Execute
- Preview of first 10 rows before execution

**Clone from Org (Seed)**
- Clone records between Salesforce orgs with full relationship integrity
- Source org picker with visual source → target direction indicator
- Object selector with searchable list and per-object SOQL WHERE filters
- Relationship-ordered insert via topological sort with cycle detection
- Self-referential handling (e.g., Account.ParentId) via two-pass insert
- Cursor-based pagination (2000/batch) for large datasets
- ID mapping table (source ID → new ID) with CSV export
- 4-step wizard: Source Org → Select Objects → Preview → Execute

**Seed Mode Selector**
- SeedPage now offers 3 modes via card-based selector: AI Generate, CSV Upload, Clone from Org

**CDC Real-Time Sync**
- Change Data Capture subscriptions with start/stop per object
- Live event feed with virtual scrolling (ring buffer, 5000 events)
- Event batching (150ms window) for high-throughput scenarios
- Auto-sync toggle per object with configurable conflict strategy
- Watchdog reconnection on sleep/wake with replay ID persistence
- Metrics dashboard: throughput sparkline, event lag, counters, uptime

**Conflict Resolution**
- Side-by-side diff viewer with 2-way and 3-way comparison (using base value)
- Per-field conflict resolution with source/target/manual choice
- Bulk resolution actions (accept all source, accept all target)
- Conflict list with DataTable, pagination, and severity/object/status filters
- Sync Page "Conflicts" tab with live badge count

**Sync History & Scheduling**
- Full execution history with FIFO retention (500 entries)
- History detail view with re-run capability
- Cron-based scheduling with visual builder, raw expression, and timezone support
- Schedule persistence across VSCode restarts
- Sleep/wake resilient execution (overdue jobs run once, not per missed interval)
- VSCode notifications on schedule completion/failure
- Sync Page tabs: Active Syncs, History, Schedules

**AI Personas (Seed)**
- Persona gallery with 10 industry-specific cards featuring icons and locale badges
- Preview popover showing 5 AI-generated sample records per persona
- Customization panel with editable field patterns per persona
- Persona field patterns auto-applied to Seed wizard field rules
- AI mode fork: choose between persona-guided or free-form generation

**Smart Actions**
- SmartActionAnalyzer: automatic record count analysis on 5 standard objects (Account, Contact, Opportunity, Case, Lead)
- SmartActionCard on Home Dashboard: contextual recommendations with "Just Do It" one-click CTA
- Decision priority: clone > quick-seed > sync > none (based on source data presence)

**Adaptive Seed Wizard**
- Auto-advance: skip Configure step when selecting fewer than 5 objects
- Category grouping: accordion layout when selecting more than 20 objects (Standard, Custom, Managed Package)
- InfoTooltip: dismissible contextual help persisted via localStorage

**Streaming Execution**
- StreamingPipeline: async generator-based chunk processing with abort support
- ChunkedBulkExecutor: multi-upload Bulk API 2.0 with 2000 records/chunk
- Automatic streaming for operations exceeding 10,000 records per object
- Progress callbacks with per-chunk tracking (chunksProcessed / totalChunks)
- Error cap at 100 entries to prevent memory growth during large operations

**Background Operations**
- BackgroundOperationRegistry: detached operation lifecycle with running/completed/failed/aborted states
- Abort support via AbortController for any running background operation
- Operation events: started, progress, completed, failed, aborted with subscriber pattern
- WebView visibility tracking via onDidChangeViewState
- VSCode native notifications when operations complete while panel is hidden
- ExecutionHandler: query operation status, list active operations, abort by ID
- Sync and Seed handlers automatically detach to background for streaming operations

**Enterprise Foundation**
- Pagination component with page size selector and keyboard navigation
- Virtual scrolling via @tanstack/react-virtual for large lists and tables
- Skeleton loading states for tables, cards, and panels
- Keyboard shortcuts: Ctrl+1..6 for direct module navigation
- Notification center with severity filters and mark-as-read
- Bulk job progress tracker with per-object progress bars
- Error recovery panel with retry, exponential backoff, and skip options
- Cache manager with automatic org-switch invalidation

### Changed

- SeedPage restructured with mode selector and AI persona fork (was wizard-only)
- Sync Page reorganized with tabbed layout (Active Syncs, History, Schedules, Conflicts, Real-Time)
- Seed and Sync handlers refactored: streaming pipeline for large datasets, background detachment for long-running ops
- Home Dashboard now shows SmartActionCard with contextual recommendations

### Performance

- Virtual scrolling for all large data tables (10,000+ rows)
- Ring buffer for CDC events (constant memory, no array growth)
- Org-switch cache invalidation (no stale data between orgs)
- Streaming execution for datasets > 10K records (async generator, 2000/chunk)
- Background operation detachment: UI stays responsive during long-running ops
- VSIX size: 1.23 MB
- 8320 tests passing (shared: 912, extension: 4533, webview: 2875)
- i18n: all new features translated in 6 languages (en, fr, de, es, ja, pt-BR)

## [1.2.2] - 2026-03-27

**Adoption-First: Sync & Seed Polish**: one-click sync and seed flows to populate a Salesforce sandbox.

### Added

**Quick Sync**
- 3-click flow: pick source/target orgs → multi-select objects → preview & execute
- Auto-field mapping: same-name fields matched automatically (no manual mapping step)
- Smart defaults: source-to-target direction, full mode, source-wins conflict, 200 batch size, upsert operation
- Pre-execution preview with estimated record counts and API call estimates
- Smart object suggestions: top 5 most-used objects (Account, Contact, Opportunity, Case, Lead)
- Relationship auto-detection: adding "Opportunity" auto-suggests "Account" as parent

**Quick Seed**
- 1-click seed from pre-built template gallery (no field configuration step)
- Template gallery UI with card grid showing name, description, object count, total records, and tags
- Customize record counts per object before execution

**Pre-Built Templates**
- 3 Seed templates: Sales Cloud Starter (7 objects, 7601 records), Service Cloud Starter (5 objects, 3800 records), Minimal Demo (3 objects, 350 records)
- 3 Sync templates: Full Account Hierarchy, Opportunities + Products, Cases + Attachments

**Seed Data Quality**
- Locale-aware data generation in 6 locales (en, fr, de, es, ja, pt-BR) with geo-coherent addresses
- Contextual ranges: object-specific amounts and dates (e.g., Opportunity.Amount: 5K-500K)
- Validation Rule auto-adjuster: detects ISBLANK, ISPICKVAL, LEN, REGEX rules and adjusts field values
- Picklist-aware generation: passes all active picklist values without truncation

**Onboarding**
- Sandbox detection with contextual guidance for new users
- Guided first-step cards on Sync and Seed empty states
- "Populate Sandbox" quick action on Home dashboard
- Welcome wizard updated for sandbox orgs

**Persistence**
- Save, load, and manage named sync configurations
- Save, load, and manage custom seed templates
- Wizard draft auto-save on every step change (survives page refresh)

### Changed

- Sync wizard reduced from 7 to 6 steps (merged org + object selection)

### Performance

- VSIX size: 1.16 MB
- 7623 tests passing (shared: 874, extension: 4310, webview: 2439)

## [1.2.1] - 2026-03-26

**Monitor Enrichment & Wiring**: Live backend services, alerting, and governance.

### Added

**Service Wiring**
- 5 previously dead backend services wired end-to-end with dedicated UI panels: Error Log Monitor, User Session Monitor, Apex Log Analyzer, Sandbox Refresh Tracker, Health Check

**Alert System**
- Default alert rules for API limits, storage, and error rates
- Alert persistence with configurable thresholds and severity levels
- VSCode native notifications (info/warning/error) on alert triggers
- Alert history timeline in Monitor dashboard

**Health Scoring**
- Unified health score aggregating all metric calculators
- Trend feedback with linear interpolation
- Health score displayed in Monitor dashboard and Home KPI row

**Limits & Trends**
- Expanded limits coverage: email invocations, Platform Events, FileStorage, sandbox reset countdown
- API response caching: /limits 30s TTL, OrgInfo 5min TTL
- Real timestamps in trend data (replaces index-based)
- CSV export for trend data

**Governance**
- Governance rule CRUD operations with custom rule definitions
- Rule evaluation engine with AlertEngine pipeline integration

## [1.2.0] - 2026-03-20

**Forge UX & Reliability**: Bug fixes, UX polish, performance, accessibility.

### Fixed

- Abort/pause/resume wired end-to-end in Forge execution
- DryRun flag properly honored during execution
- Dynamic object resolution for Forge templates
- Relationship field prefix map for correct reference handling
- Dead checkbox states in Forge wizard
- KPI calculation errors in Forge dashboard

### Added

**UX Improvements**
- Auto-org detection on extension activation
- Swap source/target orgs button
- Table view for object lists
- Log persistence across sessions
- ETA calculation for long-running operations
- Template CRUD management (create, edit, delete, duplicate)
- Node search in Forge dependency graph
- SidePanel redesign: compact mode, improved org switcher, collapsible metrics

**Backend Hardening**
- Structured error responses across all message handlers
- Configurable timeouts for all API calls
- Lifecycle events for operation tracking (started, progress, completed, failed)
- Real Bulk API 2.0 job IDs in responses

**Accessibility**
- ARIA tablist on tabbed interfaces
- aria-pressed on toggle buttons
- role="log" on live output panels
- Radiogroup patterns for exclusive selections
- Contrast fixes for WCAG 2.1 AA compliance

### Performance

- Dagre layout calculation separated from render cycle
- Memoized KPI computations
- Adaptive row heights in data tables
- 7149 tests passing

## [1.1.0] - 2026-03-19

**Stabilisation & Real-World Readiness**: Every module working end-to-end.

### Fixed

- CorrelationId bridge infrastructure: all message handlers use typed request/response with correlationId
- Ghost features removed: Grappe sidebar, placeholder modules, dead routes
- Bulk API 2.0 properly wired with retry and exponential backoff

### Added

- All 8 modules functional end-to-end: Seed, Sync, Monitor, Compare, DataOps, Automation, AI, Autopilot
- AI conversation persistence across sessions
- Dashboard refresh UX with error recovery
- Competitor benchmark analysis and 5 Monitor feature gaps addressed
- 7042 tests passing

## [1.0.0] - 2026-03-17

**Marketplace-Ready Release**: First public version.

### Added

- 6 core modules: Seed (AI-powered data generation), Sync (bidirectional ETL), Monitor (org health), Compare (metadata diff), DataOps (backup/compliance), Automation (visual pipelines)
- AI Assistant: NL2SOQL, error resolver, schema advice, 10 business personas
- Autopilot: auto-provisioning with compliance profiles, dependency graph, execution waves
- Grappe Engine for parallel processing of large datasets
- Production Guard with 3 safety tiers and CRUD/FLS enforcement
- Full i18n support (en, fr, de, es, ja, pt-BR)
- 162 Playwright E2E tests with WCAG 2.1 AA accessibility compliance
- GitHub Actions CI on Windows, macOS, and Linux
- VSIX optimized to 1.07 MB
- Published on VS Code Marketplace
