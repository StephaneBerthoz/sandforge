import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * A Forge run stopped at its gate — refused before anything was read, or
 * cancelled at one of the questions the extension asks in VS Code — comes back
 * to Review, which says why, rather than holding the execution screen on an
 * error. Scanned with axe under VS Code's default themes and the two they
 * replaced, painted as the host paints a webview, as the page scans are.
 */
const THEMES = ['Light 2026', 'Dark 2026', 'Light Modern', 'Dark Modern'] as const;
type Theme = (typeof THEMES)[number];

/** Paint the host theme before first paint, and prepend VS Code's default webview stylesheet. */
async function paintHostTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    ({ colours, defaultStyles }: { colours: Record<string, string>; defaultStyles: string }) => {
      const paint = (): void => {
        for (const [name, value] of Object.entries(colours)) {
          document.documentElement.style.setProperty(`--vscode-${name}`, value);
        }
      };
      const prependDefaultStyles = (): void => {
        const style = document.createElement('style');
        style.id = '_defaultStyles';
        style.textContent = defaultStyles;
        document.head.prepend(style);
      };
      if (document.documentElement) paint();
      else document.addEventListener('DOMContentLoaded', paint);
      if (document.head) prependDefaultStyles();
      else document.addEventListener('DOMContentLoaded', prependDefaultStyles);
    },
    { colours: hostColours(vscodeTheme(theme)), defaultStyles: VSCODE_DEFAULT_STYLES },
  );
}

/** An account, as a Forge discovery answers with it. */
const GRAPH = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 1,
      fieldCount: 50,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 40,
      estimatedSizeMB: 0.01,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 1,
};

/** Answer every pending request of a type: StrictMode can send one twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const requests = await page.evaluate((type) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === type)
      .map((m) => String(m.id));
  }, requestType);
  for (const correlationId of requests) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Discover a clone of the account from the SOQL tab, up to its Review. */
async function openReview(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs();
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-tab-soql').click();
  await page.getByTestId('forge-input-soql').fill('SELECT Id FROM Account');
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: GRAPH });
  await page.getByTestId('forge-execute-btn').click();
  await expect(page.getByTestId('forge-review')).toBeVisible();
  return bridge;
}

/** Run a clone of the account from the SOQL tab up to its execution screen; the run's request id. */
async function startRun(page: Page, theme: Theme): Promise<{ bridge: MockBridge; run: string }> {
  const bridge = await openReview(page, theme);
  await page.getByTestId('execute-button').click();
  await page.waitForSelector('[data-testid="forge-execution"]', { timeout: 10_000 });
  const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
  return { bridge, run: String(request.id) };
}

/** The extension stopping the run at its gate with `gate`, as `forge:execute:error`. */
async function stopAtTheGate(
  page: Page,
  run: string,
  message: string,
  gate: Record<string, unknown>,
): Promise<void> {
  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'gate-stop',
    correlationId: run,
    payload: { message, code: gate.code, retryable: true, gate },
  });
}

for (const theme of THEMES) {
  test.describe(`a Forge run stopped at its gate (${theme})`, () => {
    test('a production target refused comes back to Review, says why, and passes axe', async ({
      page,
    }) => {
      const { run } = await startRun(page, theme);

      await stopAtTheGate(
        page,
        run,
        'QA is a production org, or an org SandForge cannot tell is a sandbox, a scratch org or a Developer Edition org: Forge writes to those only. Nothing was read or written.',
        { code: 'PRODUCTION_TARGET' },
      );

      await expect(page.getByTestId('forge-review')).toBeVisible();
      await expect(page.getByTestId('forge-execution')).toHaveCount(0);
      const notice = page
        .getByRole('alert')
        .filter({ has: page.getByTestId('forge-run-gate-reason') });
      await expect(notice).toContainText(
        'Forge writes to those only, and nothing was read or written.',
      );
      await expect(page.getByTestId('execute-button')).toBeEnabled();
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);
    });

    test('a run cancelled before it wrote anything comes back to Review, says so, and passes axe', async ({
      page,
    }) => {
      const { run } = await startRun(page, theme);

      await stopAtTheGate(
        page,
        run,
        'Forge execution was cancelled before it wrote the records it had read. Nothing was written.',
        { code: 'WRITE_DECLINED' },
      );

      const notice = page
        .getByRole('status')
        .filter({ has: page.getByTestId('forge-run-gate-reason') });
      await expect(notice).toContainText('You cancelled the run before it wrote anything.');
      const results = await checkAccessibility(page);
      expect(results.violations.length, formatViolations(results.violations)).toBe(0);

      // Dismissed from the keyboard, and gone.
      await page.getByTestId('forge-run-gate-dismiss').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
    });
  });
}

test('a refusal for storage says what the records take and what the target had left', async ({
  page,
}) => {
  const { run } = await startRun(page, 'Dark 2026');

  await stopAtTheGate(page, run, 'The records to write take about 66.9 MB of data storage.', {
    code: 'STORAGE_EXCEEDED',
    storage: { estimateMB: 66.9, remainingMB: 12 },
  });

  await expect(page.getByTestId('forge-run-gate-reason')).toHaveText(
    'The run was refused before it wrote anything: its records take about 66.9 MB of data storage, and the target org has 12 MB left. Leave objects out, lower the records per object, or free data storage in the target org.',
  );
});

for (const refusal of [
  {
    code: 'FILES_UNREAD',
    host: 'The files of the records to clone could not all be looked up in the source (INVALID_TYPE: sObject type ContentDocumentLink is not supported.). Run it again, or leave the files out. Nothing was written.',
    says: 'The run was refused before it wrote anything: the files of the records to clone could not all be looked up in the source, and the records would have gone without some of them. Turn the copy of files off on Review, or run it again once the source answers.',
  },
  {
    code: 'FILE_STORAGE_UNREAD',
    host: 'The file storage the target has left could not be read (Request timed out), so the files could not be checked against it. Nothing was written.',
    says: 'The run was refused before it wrote anything: the target org would not say what file storage it has left, so the files to copy could not be weighed against it. Turn the copy of files off on Review, or run it again once the org answers.',
  },
]) {
  test(`files its copier refused (${refusal.code}) come back to Review, said in its words, and pass axe`, async ({
    page,
  }) => {
    // Told as a run that failed, the copier's refusal stayed on the execution
    // screen in the host's English, with no hint, away from the copy of files.
    const { run } = await startRun(page, 'Light Modern');

    await stopAtTheGate(page, run, refusal.host, { code: refusal.code });

    await expect(page.getByTestId('forge-review')).toBeVisible();
    await expect(page.getByTestId('forge-run-gate-reason')).toHaveText(refusal.says);
    await expect(page.getByTestId('forge-execution-error')).toHaveCount(0);
    const results = await checkAccessibility(page);
    expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  });
}

test('a run that failed stays on the execution screen with its error, not on Review', async ({
  page,
}) => {
  const { run } = await startRun(page, 'Light 2026');

  await sendExtensionMessage(page, {
    type: 'forge:execute:error',
    id: 'failure',
    correlationId: run,
    payload: {
      message: 'INVALID_SESSION_ID: Session expired',
      code: 'EXECUTE_ERROR',
      retryable: true,
    },
  });

  await expect(page.getByTestId('forge-execution-error')).toBeVisible();
  await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
});

test.describe('a panel too narrow for Review’s run column beside the rows', () => {
  // Under 860 pixels the column goes under the rows, Execute held to the foot
  // of the panel, and the notice stays at the head of the rows.
  test.use({ viewport: { width: 600, height: 560 } });

  test('the first Execute draws the execution step in place, Review’s scroll kept', async ({
    page,
  }) => {
    await openReview(page, 'Dark 2026');
    // Review fetches the execution step's chunk while it is read.
    await page.waitForLoadState('networkidle');
    const panel = page.getByTestId('panel-app');
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
    // The step's place, empty while it loads, is all a suspended step draws.
    await page.evaluate(() => {
      const seen = { loading: false };
      (window as unknown as Record<string, unknown>).__forgeStepLoadingSeen = seen;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="forge-step-loading"]')) seen.loading = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.getByTestId('execute-button').click();
    await expect(page.getByTestId('forge-execution')).toBeVisible();

    // The step fetched ahead still suspended once as it was first drawn: its
    // empty place took the page's height, and the panel went back to its top.
    const loadingSeen = await page.evaluate(
      () =>
        (window as unknown as Record<string, { loading: boolean }>).__forgeStepLoadingSeen.loading,
    );
    expect(loadingSeen).toBe(false);
    expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
  });

  test('the notice of a refusal is scrolled into view and handed the keyboard, wherever the page was scrolled', async ({
    page,
  }) => {
    const bridge = await openReview(page, 'Dark 2026');
    const panel = page.getByTestId('panel-app');
    const toFoot = (el: HTMLElement): void => {
      el.scrollTop = el.scrollHeight;
    };
    await panel.evaluate(toFoot);
    await page.getByTestId('execute-button').click();
    await expect(page.getByTestId('forge-execution')).toBeVisible();
    const request = await bridge.waitForMessage('forge:execute', { timeout: 10_000 });
    // The run reads and asks its questions under the execution screen:
    // followed down that screen, the page came back to Review as far down,
    // the notice some 290 pixels above the fold and the keyboard on the step
    // around it.
    await panel.evaluate(toFoot);
    await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);

    await stopAtTheGate(page, String(request.id), 'The records to write take about 66.9 MB.', {
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 66.9, remainingMB: 12 },
    });

    await expect(page.getByTestId('forge-review')).toBeVisible();
    const notice = page.getByTestId('forge-run-gate-notice');
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice).toBeFocused();
    // Once per stop: a scroll of the user's own is not undone.
    await panel.evaluate(toFoot);
    await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);
    await expect(notice).not.toBeInViewport();
    const results = await checkAccessibility(page);
    expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  });

  test('the notice of a second run cancelled is scrolled into view, Review scrolled to Execute before it', async ({
    page,
  }) => {
    const { bridge, run } = await startRun(page, 'Dark 2026');
    await stopAtTheGate(page, run, 'The records to write take about 66.9 MB.', {
      code: 'STORAGE_EXCEEDED',
      storage: { estimateMB: 66.9, remainingMB: 12 },
    });
    await page.getByTestId('forge-run-gate-dismiss').click();
    await expect(page.getByTestId('forge-run-gate-notice')).toHaveCount(0);
    const panel = page.getByTestId('panel-app');

    // The page keeps Review's scroll across the execution screen, as far
    // down as that screen goes.
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.getByTestId('execute-button').click();
    await expect(page.getByTestId('forge-execution')).toBeVisible();
    await expect.poll(async () => (await bridge.getMessages('forge:execute')).length).toBe(2);
    const second = (await bridge.getMessages('forge:execute'))[1];
    await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(400);

    await stopAtTheGate(
      page,
      String(second.id),
      'Forge execution was cancelled before it wrote the records it had read. Nothing was written.',
      { code: 'WRITE_DECLINED' },
    );

    await expect(page.getByTestId('forge-review')).toBeVisible();
    const notice = page.getByTestId('forge-run-gate-notice');
    await expect(notice).toHaveAttribute('data-code', 'WRITE_DECLINED');
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(notice).toBeFocused();
  });
});
