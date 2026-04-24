# Disposable Hygiene Audit

**Generated:** 2026-04-24T10:02:27.194Z
**Script:** `scripts/audit-disposables.ts`

## Summary

- Total timer calls scanned: **29**
- Total listener calls scanned: **15**
- Orphan registrations (no disposable sink found): **22**

### By category

- `timer`: 10
- `event-emitter`: 8
- `vscode-event`: 3
- `dom-event`: 1

## Orphans

- **packages/extension/src/adapters/salesforce/SalesforceAdapter.ts:201** [`dom-event`]
  ```ts
  signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(handle);
        reject(signal.reason ?? new Error('aborted'));
…
  ```
- **packages/extension/src/bridge/handlers/AutomationHandler.ts:137** [`event-emitter`]
  ```ts
  orchestrator.on('stepCompleted', (_event, data) => {
        const stepData = data as { runId: string; stepResult: { stepName: string; stat…
  ```
- **packages/extension/src/bridge/handlers/ForgeHandler.ts:372** [`event-emitter`]
  ```ts
  this.orchestrator.on('forge:progress', (event) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:progress', event as unkno…
  ```
- **packages/extension/src/bridge/MessageRouter.ts:17** [`event-emitter`]
  ```ts
  this.broker.on(type, handler)
  ```
- **packages/extension/src/core/engine/BulkApiExecutor.ts:157** [`timer`]
  ```ts
  setTimeout(r, 5000)
  ```
- **packages/extension/src/core/engine/ChunkedBulkExecutor.ts:119** [`timer`]
  ```ts
  setTimeout(r, this.pollIntervalMs)
  ```
- **packages/extension/src/core/engine/RateLimiter.ts:64** [`timer`]
  ```ts
  setTimeout(resolve, delay)
  ```
- **packages/extension/src/core/engine/RetryableOperation.ts:67** [`timer`]
  ```ts
  setTimeout(resolve, delay)
  ```
- **packages/extension/src/core/engine/RetryableOperation.ts:114** [`timer`]
  ```ts
  setTimeout(r, Math.min(delay, maxDelay))
  ```
- **packages/extension/src/core/engine/RetryStrategy.ts:62** [`timer`]
  ```ts
  setTimeout(resolve, delay)
  ```
- **packages/extension/src/core/engine/WorkerPool.ts:152** [`timer`]
  ```ts
  setTimeout(resolve, 10)
  ```
- **packages/extension/src/core/grappe/GrappeOrchestrator.ts:332** [`timer`]
  ```ts
  setTimeout(resolve, ms)
  ```
- **packages/extension/src/modules/automation/StepExecutor.ts:103** [`timer`]
  ```ts
  setTimeout(() => reject(new Error('Step execution timed out')), step.timeout)
  ```
- **packages/extension/src/modules/automation/StepExecutor.ts:171** [`timer`]
  ```ts
  setTimeout(resolve, durationMs)
  ```
- **packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts:51** [`event-emitter`]
  ```ts
  this.broker.on('realtime:start', (msg) => this.handleStart(msg))
  ```
- **packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts:52** [`event-emitter`]
  ```ts
  this.broker.on('realtime:stop', (msg) => this.handleStop(msg))
  ```
- **packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts:53** [`event-emitter`]
  ```ts
  this.broker.on('realtime:status', (msg) => this.handleStatus(msg))
  ```
- **packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts:54** [`event-emitter`]
  ```ts
  this.broker.on('realtime:metrics', (msg) => this.handleMetrics(msg))
  ```
- **packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts:55** [`event-emitter`]
  ```ts
  this.broker.on('realtime:resolve-conflict', (msg) => this.handleResolveConflict(msg))
  ```
- **packages/extension/src/providers/SidebarViewProvider.ts:45** [`vscode-event`]
  ```ts
  webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      const type = message.type as string | undefined;
      const paylo…
  ```
- **packages/extension/src/providers/WebviewPanelManager.ts:96** [`vscode-event`]
  ```ts
  panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.visiblePanels.add(config.viewType);
      } else {
    …
  ```
- **packages/extension/src/providers/WebviewPanelManager.ts:105** [`vscode-event`]
  ```ts
  panel.onDidDispose(() => {
      this.panels.delete(config.viewType);
      this.visiblePanels.delete(config.viewType);
    })
  ```
