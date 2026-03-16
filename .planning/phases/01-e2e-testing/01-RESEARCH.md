# Phase 1: E2E Testing - Research

**Researched:** 2026-03-16

## Don't Hand-Roll

### axe-core Integration
Use `@axe-core/playwright` — the official Playwright binding. Don't write custom WCAG checkers.
```bash
pnpm add -D @axe-core/playwright --filter webview
```
Usage: `import AxeBuilder from '@axe-core/playwright'` then `new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()`.

### MockBridge Helper
Don't build a full message bus framework. The existing `injectVSCodeApiMock` + `sendExtensionMessage` + `__SANDFORGE_MESSAGES__` global is solid. The MockBridge should be a thin wrapper that:
1. Auto-captures outgoing messages by type
2. Auto-correlates `correlationId` from request `id`
3. Provides `bridge.respondTo('type', payload)` that handles correlation automatically
4. Avoids reinventing — keep `injectVSCodeApiMock` as the core, just wrap it.

### GitHub Actions Playwright
Use `@playwright/test`'s official GitHub Actions setup pattern — don't hand-roll Chromium installation:
```yaml
- uses: actions/setup-node@v4
- run: pnpm install
- run: npx playwright install --with-deps chromium
```

## Common Pitfalls

### 1. CorrelationId Race Conditions
**What goes wrong:** Tests call `sendExtensionMessage` before the page has registered its message listener. The response is dispatched but nobody listens.
**Current mitigation:** `page.waitForTimeout(200)` — fragile.
**Better approach:** MockBridge should wait for the outgoing request to appear in `__SANDFORGE_MESSAGES__` before sending the response. Use `page.waitForFunction()` instead of `waitForTimeout`.

### 2. axe-core False Positives on VSCode Themes
**What goes wrong:** axe flags color contrast issues because the VSCode theme CSS variables resolve to unexpected values outside the real VSCode host.
**How to avoid:** In the E2E Vite config, the page loads with default CSS variable values. Ensure the mock CSS variables provide sufficient contrast. If needed, exclude `color-contrast` rule initially and add it back once theme values are verified.

### 3. Framer Motion Animation Interference
**What goes wrong:** Tests fail because elements are mid-animation (opacity 0, transform offscreen) when assertions run.
**How to avoid:** The Vite E2E config already patches Framer Motion strict mode. For tests, consider using `page.locator().waitFor({ state: 'visible' })` rather than immediate assertions. The existing specs already do this.

### 4. Autopilot Graph Rendering Timing
**What goes wrong:** The dependency graph uses SVG/Canvas rendering that may not be immediately ready after state updates.
**How to avoid:** Wait for specific graph node `data-testid` elements rather than asserting on the graph container. Test graph state via node counts and node statuses, not pixel positions.

### 5. CI Windows Path Issues
**What goes wrong:** Forward-slash vs backslash in file paths, `npx` resolution differences, Vite server startup timing.
**How to avoid:** Use `windows-latest` runner. Playwright handles cross-platform well. Increase `webServer.timeout` in CI (currently 30s, may need 60s on Windows CI runners which are slower).

### 6. Shared Fixture Drift
**What goes wrong:** Mock data shapes diverge from actual Zod schemas over time. Tests pass with outdated mocks but real data fails.
**How to avoid:** Import types from `packages/shared` in fixture files. Use `satisfies` operator to type-check fixtures against shared types. Reference shapes in `test/FIXTURES-README.md`.

## Codebase Findings

### Existing Test Infrastructure
- **12 spec files**, ~1936 lines total, 47+ tests passing
- **6 module specs** already exist: seed (249L), sync (123L), monitor (240L), compare (222L), dataops (256L), automation (353L)
- **6 cross-cutting specs**: home-page, navigation, accessibility, i18n, responsive, theme
- **Mock helpers**: `e2e/mocks/vscode-api.ts` with `injectVSCodeApiMock()` and `sendExtensionMessage()`

### AI Module (Ready for E2E)
- Pages: `AIPage.tsx`, `AIChatPanel.tsx` with full data-testid coverage
- data-testids: `ai-chat-panel`, `conversation-sidebar`, `new-conversation-btn`, `chat-input`, `send-btn`, `message-{id}`, `loading-indicator`, `chat-empty-state`, etc.
- Message types: `ai:chat`, `ai:conversation:create/load/delete`, `ai:nl2soql`, `ai:resolve-error`, `ai:suggestions`, `ai:anomaly-scan`
- Response types: `ai:chat:response`, `ai:nl2soql:response`, `ai:resolve-error:response`, `ai:error`

### Autopilot Module (Ready for E2E)
- Pages: `AutopilotPage.tsx` with wizard (4 steps), graph visualization, control panel, compliance report
- Wizard steps: `Step1_Connect`, `Step2_Objects`, `Step3_Compliance`, `Step4_Review`
- Graph: `AutopilotGraph.tsx`, `ObjectNode.tsx`, `RelationEdge.tsx`, `GraphControls.tsx`, `GraphLegend.tsx`
- Control panel: pause/resume, skip node, retry — all with data-testids
- States: connect → objects → compliance → review → executing → completed
- Message types: `autopilot:scan-schema`, `autopilot:generate-plan`, `autopilot:execute`, `autopilot:pause/resume/skip-node`
- Progress events: `autopilot:node-progress`, `autopilot:node-completed`, `autopilot:node-failed`, `autopilot:completed`, `autopilot:compliance-report`

### Scripts Available
- `pnpm --filter webview e2e` — run Playwright tests
- `pnpm --filter webview e2e:ui` — Playwright UI mode
- `pnpm --filter webview e2e:report` — show HTML report

### No GitHub Actions Yet
- No `.github/` directory at project root
- Needs `.github/workflows/ci.yml` from scratch

---
*Phase: 01-e2e-testing*
*Research completed: 2026-03-16*
