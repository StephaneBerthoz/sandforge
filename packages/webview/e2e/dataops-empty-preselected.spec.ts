import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { sendExtensionMessage } from './mocks/vscode-api';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';
import { wholeOrgGraph } from '../src/pages/Forge/testing/wholeOrg';
import { scopeAnswer } from '../src/pages/DataOps/empty/testing/emptyAnswers';

/**
 * Empty these objects first, from the Review of a clone of the whole org:
 * DataOps opens on Cleanup with the objects the target holds picked. One the
 * target's scope does not offer — a package's object, one the user may not
 * delete — was left picked and said nothing until a preview left it out. It
 * is said left out, with why, as Cleanup opens, and never asked. Scanned with
 * axe under VS Code's default themes and the two they replaced.
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

/** The messages the page posted of `type`, unwrapped. */
async function sent(page: Page, type: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((wanted) => {
    const posted = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return posted
      .map((m) => ((m as Record<string, unknown>).payload ?? m) as Record<string, unknown>)
      .filter((m) => m.type === wanted);
  }, type);
}

/** Answer every pending request of a type: StrictMode can send one twice. */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const request of await sent(page, requestType)) {
    const correlationId = String(request.id);
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Forge's Review of a clone of the whole org into the target, which holds Contact and Account. */
async function openReview(page: Page, theme: Theme): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'forge';
  });
  await page.goto('/');
  await bridge.seedOrgs([DEV_SANDBOX, QA_SANDBOX]);
  await page.waitForSelector('[data-testid="forge-page"]', { timeout: 10_000 });
  await page.getByTestId('forge-source-org').click();
  await page.getByTestId(`forge-source-org-option-${DEV_SANDBOX.id}`).click();
  await page.getByTestId('forge-target-org').click();
  await page.getByTestId(`forge-target-org-option-${QA_SANDBOX.id}`).click();
  await page.getByTestId('forge-depth-all').click();
  await page.getByTestId('forge-discover-btn').click();
  await page.waitForSelector('[data-testid="forge-discovery-loading"]', { timeout: 10_000 });
  await answerAll(page, 'forge:discover', 'forge:discover:response', { graph: wholeOrgGraph() });
  await expect(page.getByTestId('forge-discovery-summary')).toBeVisible();
  await page.getByTestId('forge-execute-btn').click();
  await expect(page.getByTestId('forge-review')).toBeVisible();
  await expect
    .poll(async () => (await sent(page, 'forge:target-records:request')).length)
    .not.toBe(0);
  await answerAll(page, 'forge:target-records:request', 'forge:target-records:response', {
    targetOrgId: QA_SANDBOX.id,
    objects: [
      { objectApiName: 'Contact', records: 1_500 },
      { objectApiName: 'Account', records: 20 },
    ],
  });
  return bridge;
}

/** The target's scope: Account is no object the user may delete there. */
function scopeWithoutAccount(): Record<string, unknown> {
  const scope = scopeAnswer();
  return {
    ...scope,
    objects: scope.objects.filter((name) => name !== 'Account'),
    candidates: scope.candidates.filter((name) => name !== 'Account'),
    leftOut: [...scope.leftOut, { objectApiName: 'Account', reason: 'notDeletable' }],
  };
}

for (const theme of THEMES) {
  test(`Empty these objects first says left out, with why, an object the target's scope does not offer, and never asks it (${theme})`, async ({
    page,
  }) => {
    const bridge = await openReview(page, theme);
    await page.getByTestId('review-target-holds-empty-first-btn').click();

    await page.getByTestId('empty-panel').waitFor();
    await bridge.waitForMessage('dataops:empty:scope', { timeout: 10_000 });
    await answerAll(
      page,
      'dataops:empty:scope',
      'dataops:empty:scope:response',
      scopeWithoutAccount(),
    );

    const note = page.getByTestId('empty-objects-preselected-left-out');
    await expect(note).toContainText('1 object asked to be emptied first is left out, with why:');
    await expect(page.getByTestId('empty-objects-preselected-left-out-notDeletable')).toContainText(
      'Account',
    );
    await expect(page.getByTestId('empty-pick-option-Contact')).toBeChecked();
    await expect(page.getByTestId('empty-pick-ticked')).toHaveText('1 object picked: Contact');

    await page.getByTestId('empty-objects-preview').click();
    await expect.poll(async () => (await sent(page, 'dataops:empty:preview')).length).toBe(1);
    const [preview] = await sent(page, 'dataops:empty:preview');
    expect((preview.payload as Record<string, unknown>).request).toEqual({
      mode: 'objects',
      objects: ['Contact'],
    });

    const results = await checkAccessibility(page);
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}
