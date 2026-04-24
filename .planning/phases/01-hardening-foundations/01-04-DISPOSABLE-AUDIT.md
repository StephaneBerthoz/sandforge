# Disposable Hygiene Audit

**Generated:** 2026-04-24T10:07:45.072Z
**Script:** `scripts/audit-disposables.ts`

## Summary

- Total timer calls scanned: **29**
- Total listener calls scanned: **15**
- Orphan registrations (no disposable sink found): **2**

### By category

- `dom-event`: 1
- `vscode-event`: 1

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
- **packages/extension/src/providers/WebviewPanelManager.ts:102** [`vscode-event`]
  ```ts
  panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.visiblePanels.add(config.viewType);
      } else {
    …
  ```
