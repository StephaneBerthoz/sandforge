# Phase 02: Wire Dead Services — Research

**Researched:** 2026-03-20
**Phase goal:** Wire 5 fully-implemented services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) to bridge handlers and UI panels.

---

## Service Signatures (what is already built)

| Service | Input fn type | Key output | Cached per orgId |
|---------|---------------|-----------|-----------------|
| `ErrorLogMonitor` | `QueryErrorsFn(orgId, since) => Promise<ErrorLogEntry[]>` | `getRecentErrors()`, `getErrorsByType()`, `getErrorCount()` | `errorCache: Map` |
| `UserSessionMonitor` | `QuerySessionsFn(orgId) => Promise<UserSessionInfo[]>` | `getActiveSessions()`, `getActiveUserCount()` | `sessionCache: Map` |
| `ApexLogAnalyzer` | `FetchLogsFn(orgId, count) => Promise<ApexLogEntry[]>` | `fetchAndAnalyze()`, `getTopIssues()`, `getRecentAnalyses()` | `analyses: Map` |
| `SandboxRefreshTracker` | `QuerySandboxesFn(orgId) => Promise<SandboxRefreshEvent[]>` | `getRecentRefreshes()`, `isRefreshInProgress()` | `refreshCache: Map` |
| `HealthCheck` | `HealthSignalProvider[]` (array of `(orgId) => Promise<HealthSignal>`) | `computeHealth(orgId): OrgHealthStatus` | none (stateless aggregator) |

`ApexLogEntry` is imported from `@sandforge/shared` (already defined in `monitor.types.ts`, fields: `id`, `operation`, `status`, `durationMs`, `logSize`, `startTime`, `user`).

---

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| SOQL for error logs | Use `queryAll()` from `../../core/common/soqlQueryHelper.js` with `ApexLog` object | Every existing handler uses `queryAll`, never raw `conn.query`. Handles pagination transparently. |
| SOQL for user sessions | Use `queryAll()` with `AuthSession` SF object | Existing pattern. `UserSessionInfo` maps directly: `userId=UsersId`, `username=User.Username`, `sessionType=SessionType`, `loginTime=CreatedDate`, `sourceIp=SourceIp`. |
| SOQL for sandbox refreshes | Use `queryAll()` with `SandboxProcess` SF object | `SandboxProcess` has `SandboxName`, `Status`, `CreatedDate`, `SourceId`. Matches `SandboxRefreshEvent` fields. |
| Bridge message construction | Use `buildResponse(deps, msg, type, payload)` from `HandlerTypes.js` | All existing handlers use this. Sets `correlationId = request.id` so `useBridgeQuery` on the webview side can match the response. Never construct message objects manually. |
| Error handling in handlers | Use `sendHandlerError(deps, context, responseType, err)` from `HandlerTypes.js` | Consolidated pattern used in all 8 existing handlers. Extracts error message, logs `[ERR]`, posts typed error response, logs `[TX]`. |
| SF API call counting | Call `checkApiLimits(conn.limitInfo, label)` after every SOQL | Used consistently in `handleRefresh`, `handleStorage`, `handleDeployments`. Required for governor limit observability. |

---

## Common Pitfalls

### Pitfall 1: Services take dependency-injected functions, not jsforce connections directly

**What goes wrong:** The services (`ErrorLogMonitor`, `UserSessionMonitor`, etc.) are constructed with a query function (`QueryErrorsFn`, `QuerySessionsFn`, etc.) — not with a jsforce connection. The planner might try to instantiate them with a connection and discover the constructor does not accept one.

**Why:** These services were designed for testability (pure function injection). The query functions must be created at handler call-time, after `getJsforceConnection()` resolves, then passed to the service's `fetch()` or `fetchAndAnalyze()` method.

**How to avoid:** Instantiate the services as class-level fields in `MonitorOpsHandler` (like `UnifiedHealthScorer` and `TrendStorage`). Pass the concrete query function as a closure inside each `handle*` method when calling `fetch()`. Do not pass services in the constructor — the pattern is: field = service instance, per-call = concrete fn.

### Pitfall 2: Service instances hold per-org cache — do not reinstantiate per request

**What goes wrong:** If the handler creates `new ErrorLogMonitor(queryFn)` inside the `handleErrorLogs()` method, the `errorCache` is reset on every call, defeating incremental `since`-timestamp logic in `ErrorLogMonitor`.

**Why:** `ErrorLogMonitor.getLastTimestamp()` uses `errorCache` to build the `since` parameter. A fresh instance always passes a 24h-ago timestamp instead of the timestamp of the last known error.

**How to avoid:** Declare all 5 services as private readonly fields on `MonitorOpsHandler`, initialized in the constructor (no constructor args needed since they accept the fn separately). Reuse across requests.

### Pitfall 3: HealthCheck WIRE-05 — do not replace UnifiedHealthScorer

**What goes wrong:** `HealthCheck.computeHealth()` returns `OrgHealthStatus` — which is a different (simpler) type than `HealthReport` returned by `UnifiedHealthScorer`. The existing `handleRefresh` and `handleHealthScore` already use `UnifiedHealthScorer` to compute `healthReport` and `healthScore`. WIRE-05 says "HealthCheck aggregator wired into monitor:refresh flow", not "replace the health scorer".

**Why:** `OrgHealthStatus` has `overall`, `apiLimitsStatus`, `storageStatus`, `activeJobs`, `recentErrors`. These complement the `HealthReport` detail-level data; they do not replace it.

**How to avoid:** In `handleRefresh`, call `HealthCheck.computeHealth()` after the existing `UnifiedHealthScorer.calculate()` call and include the result in the response payload as a separate `healthStatus` field, or use it to feed the `recentErrors` count into the existing health report. Confirm with the task what "wired into monitor:refresh flow" means concretely — the most natural reading is adding it to the `monitor:data` response payload as `orgHealthStatus`, not removing `UnifiedHealthScorer`.

### Pitfall 4: Missing message type registration in ExtensionHandlers.registerAll()

**What goes wrong:** New handler methods are added to `MonitorOpsHandler` but the new message types are not added to the `route([...], this.monitorHandler)` call in `ExtensionHandlers.ts` (around line 205). The webview sends the message, the broker silently drops it, and the panel hangs in loading state forever.

**Why:** `MessageRouter.route()` must be called explicitly for every new type string. The `MONITOR_TYPES` Set inside `MonitorOpsHandler` is used for early-return in `handle()`, but routing is registered separately in `ExtensionHandlers`.

**How to avoid:** For each new message type added (e.g., `'monitor:error-logs'`, `'monitor:sessions'`, `'monitor:apex-insights'`, `'monitor:sandbox-refresh'`), add it to both: (1) the `MONITOR_TYPES` set in `MonitorOpsHandler`, and (2) the `route([...], this.monitorHandler)` array in `ExtensionHandlers.registerAll()`.

### Pitfall 5: Missing message types in the shared WebViewToExtension / ExtensionToWebView unions

**What goes wrong:** New request and response interfaces are created in `messages.types.ts` but not added to the `WebViewToExtensionMessage` and `ExtensionToWebViewMessage` union types. TypeScript strict mode will not catch this at compile time since the broker uses the loose `BaseMessage` type at runtime, but the discriminated-union types become inaccurate and future tooling will miss these types.

**Why:** Every existing message pair follows the pattern: define interface + add to both union types (see lines 164-312 of `messages.types.ts`). This is a required step, not optional.

**How to avoid:** For each new service, define both the request interface (WebView→Extension) and the response interface (Extension→WebView), then add both to the respective union types in `messages.types.ts`.

### Pitfall 6: UI panel hook choice — useBridgeQuery vs useBridgeMutation

**What goes wrong:** Using `useBridgeMutation` for panels that should auto-fetch on mount (like `ApiUsagePanel`), or `useBridgeQuery` for panels that are explicitly user-triggered (like `OrgHealthPanel`).

**Why:** `useBridgeQuery` auto-sends on mount and supports `skip: !selectedOrgId`. `useBridgeMutation` requires explicit `mutate()` call. `ApiUsagePanel` uses `useBridgeQuery` (auto-load). `OrgHealthPanel` uses `useBridgeMutation` (user clicks "Scan"). The rule of thumb: if the data should appear automatically when an org is selected, use `useBridgeQuery`. If it requires a deliberate user action, use `useBridgeMutation`.

**For this phase:** `ErrorLogsPanel`, `SessionsPanel`, `ApexInsightsPanel`, and `RefreshPanel` should most likely use `useBridgeQuery` (auto-load when org selected, matching the pattern of `ApiUsagePanel` and `StorageBreakdownPanel`).

### Pitfall 7: i18n keys must be added to both en/ and fr/ locales

**What goes wrong:** Keys added only to `packages/shared/src/i18n/locales/en/monitor.ts` but not to `fr/monitor.ts` will cause the i18n engine to fall back to the key string in French locale, which looks broken.

**Why:** Both locale files are `TranslationRecord` (a flat `Record<string, string>`). The project rule is "i18n from day 1, no hardcoded strings". Panels use `useTranslation()` with `t('monitor.errorLogs.title', 'fallback')` — the inline fallback is only for development safety, not a substitute for the FR locale entry.

**How to avoid:** For every new `t('monitor.errorLogs.*')` key added, add corresponding entries to both `en/monitor.ts` and `fr/monitor.ts`. Keep keys nested by panel name (e.g., `errorLogs.title`, `errorLogs.empty`, `sessions.title`, `apexInsights.title`, `sandboxRefresh.title`).

### Pitfall 8: SOQL for ApexLog — object is `ApexLog`, not `ApexDebugLog`

**What goes wrong:** Using `ApexDebugLog` (which tracks the debug configuration, not log content) instead of `ApexLog` (the actual debug log records). Alternatively, trying to query `EventLogFile` (Event Monitoring) which requires an add-on license.

**Why:** `ApexLogEntry` in `monitor.types.ts` has fields matching `ApexLog` SOQL object: `Operation` maps to `operation`, `Status` to `status`, `DurationMilliseconds` to `durationMs`, `LogLength` to `logSize`, `StartTime` to `startTime`, `LogUserId` → join to `User.Username` for `user`. SOQL: `SELECT Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUserId FROM ApexLog ORDER BY StartTime DESC LIMIT {count}`.

### Pitfall 9: SandboxRefreshTracker's onRefreshDetected callback is not wired in handler context

**What goes wrong:** Passing a `onRefreshDetected` callback to `SandboxRefreshTracker` that captures `this.deps.broker` for sending a notification — but this gets called on every subsequent `fetch()` when previously unseen events appear. If the handler sends a VSCode notification for every sandbox seen on the first fetch, it floods the user.

**Why:** `knownRefreshIds` starts empty on handler boot, so the first `fetch()` triggers `onRefreshDetected` for every event returned. Only subsequent calls detect truly new events.

**How to avoid:** Either (a) initialize `knownRefreshIds` from existing cache before the first fetch (by calling `fetch()` once silently on startup), or (b) don't pass an `onRefreshDetected` callback when wiring to the bridge handler — the UI panel can display all refreshes without needing a push notification. The simplest safe approach: omit `onRefreshDetected` in the handler instantiation for the initial wiring.

---

## Existing Patterns in This Codebase

- **SOQL query pattern:** `queryAll<RecordType>(conn, soql)` from `../../core/common/soqlQueryHelper.js`. Used in `handleRefresh`, `handleStorage`, `handleDeployments`. Always pass the typed record shape as the generic.

- **Limits-cached connection pattern:** `this.getOrFetchLimits(orgId, conn)` is already on `MonitorOpsHandler`. The 5 new handlers do NOT need to call this — they use their own SOQL. Only call it if the handler needs `/limits` data (none of the 5 services require it).

- **Response naming convention:** Request type `monitor:X` → response type `monitor:X:response`. Error response type also `monitor:X:response` (with `{ message, code, retryable }` payload shape from `sendHandlerError`). See `handleStorage` → `monitor:storage:response`.

- **Panel file structure:** Each panel is a `React.FC` in `packages/webview/src/pages/Monitor/[Name]Panel.tsx` with a co-located `[Name]Panel.test.tsx`. Panel renders: loading skeleton (`data-testid="[name]-panel-loading"`), empty state (`data-testid="[name]-panel-empty"`), data view (`data-testid="[name]-panel"`).

- **Panel test pattern:** Mock `useBridgeQuery` or `useBridgeMutation` at the module level using `vi.mock('../../hooks/useBridgeQuery', ...)`. Use `useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] })` in `beforeEach`. Tests cover: loading state, empty state, data state, badge variants. See `ApiUsagePanel.test.tsx`.

- **Handler test pattern:** `vi.hoisted()` for module-level mock factories, `createMockDeps()` helper returns `HandlerDeps` with `vi.fn()` broker. Reset mocks in `beforeEach`. Verify `broker.postToWebview` was called with correct `type` and `correlationId`. See `MonitorOpsHandler.test.ts`.

- **MonitorPage integration:** New panels should be added as standalone components dropped into `MonitorPage.tsx`. The page already has sections for `StorageBreakdownPanel`, `ApiUsagePanel`, `DeploymentTimeline`. New panels follow the same pattern — self-contained, no props required (they read `selectedOrgId` from `useOrgStore` internally).

- **Service instantiation in handler:** `UnifiedHealthScorer` and `TrendStorage` are created in `MonitorOpsHandler` constructor as private readonly fields (`private readonly healthCalculator = new UnifiedHealthScorer()`). Follow the same pattern for the 5 new services.

---

## Salesforce SOQL Objects to Use

| Service | SF Object | Key Fields |
|---------|-----------|-----------|
| ErrorLogMonitor | `ApexLog` | `Id, Operation, Status, DurationMilliseconds, LogLength, StartTime, LogUserId` |
| UserSessionMonitor | `AuthSession` | `Id, UsersId, User.Username, SessionType, CreatedDate, SourceIp` |
| ApexLogAnalyzer | `ApexLog` | same as above (same object, different handler — `ApexLogAnalyzer` calls `fetchLogs` internally) |
| SandboxRefreshTracker | `SandboxProcess` | `Id, SandboxName, Status, CreatedDate, SourceId` |
| HealthCheck | none directly | consumes results from other services via `HealthSignalProvider` functions |

`AuthSession` requires the running user to have "View All Data" or appropriate permissions. `SandboxProcess` is only available in production orgs — sandbox orgs return empty results (handle gracefully).

---

## Recommended Approach

Wire all 5 services by adding private handler methods to the existing `MonitorOpsHandler` (do not create a new handler file — the routing infrastructure already targets `monitorHandler` for all `monitor:*` types). Instantiate all 5 service instances as constructor-initialized fields. For each service, define a new message type pair in `messages.types.ts`, register the type in both `MONITOR_TYPES` and `ExtensionHandlers.registerAll()`, and create a self-contained panel component following the `ApiUsagePanel` pattern (auto-fetch via `useBridgeQuery` with `skip: !selectedOrgId`, loading/empty/data states, co-located test). For WIRE-05, wire `HealthCheck.computeHealth()` into `handleRefresh` as an additional data point in the `monitor:data` response payload rather than as a standalone handler, and build the signal providers from the data already fetched (error count, active jobs) to avoid additional SOQL calls.
