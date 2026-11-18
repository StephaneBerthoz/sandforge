import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { RecoveryStatus } from '@sandforge/shared';
import { MockBridge, checkAccessibility, formatViolations } from './helpers';
import { themeContrastShortfalls } from './helpers/theme-contrast';
import { MOCK_ORGS } from './fixtures';
import {
  ANA,
  RECOVERY_ORG,
  appliedAna,
  auditOf,
  planOfAna,
  refreshedStatus,
  unrefreshedStatus,
  usersList,
} from './fixtures/recovery';
import { VSCODE_DEFAULT_STYLES } from './fixtures/vscode-default-styles';
import { hostColours, vscodeTheme } from '../src/styles/testing/vscodeThemes';

/**
 * Back into service, drawn in Chromium the way the host draws a webview,
 * against the `recovery:*` contract played by the spec: the sandbox after its
 * refresh, its ten steps and what to keep before the next refresh; the same
 * sandbox with no refresh noticed; the users chosen, simulated, accepted and
 * run, their addresses awaiting confirmation; the audits read with their
 * Setup pages; and the steps that open another page with what it needs.
 *
 * Each state is scanned with axe under VS Code's default themes, Light 2026
 * and Dark 2026, and the two they replaced, with the stylesheet VS Code
 * prepends to every webview, and held to the theme's own contrast.
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

/**
 * The extension's side of the bridge, as the spec plays it: each request the
 * page sends is answered once, correlated to it. A development build mounts
 * the panel twice, so a request can be asked twice; both are answered.
 */
class Extension {
  private readonly answered = new Set<string>();

  constructor(readonly bridge: MockBridge) {}

  private async pending(type: string): Promise<Record<string, unknown>[]> {
    return (await this.bridge.getMessages(type)).filter(
      (message) => !this.answered.has(String(message.id)),
    );
  }

  /** The latest request of `type` nothing answered yet, once the page sent one. */
  async asked(type: string): Promise<Record<string, unknown>> {
    await expect
      .poll(async () => (await this.pending(type)).length, {
        message: `the page sent no ${type} left to answer`,
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const requests = await this.pending(type);
    return requests[requests.length - 1];
  }

  /** Answer every request of `type` not answered yet: the latest is returned. */
  async answer(
    type: string,
    payload: object,
    responseType = `${type}:response`,
  ): Promise<Record<string, unknown>> {
    const latest = await this.asked(type);
    for (const request of await this.pending(type)) {
      this.answered.add(String(request.id));
      await this.bridge.respond(
        responseType,
        payload as Record<string, unknown>,
        String(request.id),
      );
    }
    return latest;
  }

  /** Push a message correlated to the latest request of `type`. */
  async push(type: string, pushed: string, payload: object): Promise<void> {
    const requests = await this.bridge.getMessages(type);
    const latest = requests[requests.length - 1];
    await this.bridge.respond(pushed, payload as Record<string, unknown>, String(latest?.id));
  }
}

/** Open Back into service on the dev sandbox, its status answered. */
async function openRecovery(
  page: Page,
  theme: Theme,
  status: RecoveryStatus = refreshedStatus(),
): Promise<Extension> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await paintHostTheme(page, theme);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'recovery';
  });
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  const host = new Extension(bridge);
  await expect(page.getByTestId('recovery-page')).toBeVisible();
  const asked = await host.answer('recovery:status', { status });
  expect(asked.payload).toEqual({ orgId: RECOVERY_ORG.id });
  await expect(page.getByTestId('recovery-steps')).toBeVisible();
  return host;
}

/** The page as painted passes axe and the theme's own contrast. */
async function expectReadable(page: Page, theme: Theme): Promise<void> {
  const results = await checkAccessibility(page);
  expect(results.violations.length, formatViolations(results.violations)).toBe(0);
  const shortfalls = await themeContrastShortfalls(page, vscodeTheme(theme));
  expect(shortfalls, shortfalls.join('\n')).toEqual([]);
}

/** Choose Ana, simulate, accept the email to her, and run. */
async function runAna(page: Page, host: Extension): Promise<void> {
  await page.getByTestId('recovery-users-toggle').click();
  await host.answer('recovery:users:list', usersList());
  await page.getByRole('checkbox', { name: ANA }).check();
  await page.getByTestId('recovery-users-simulate').click();
  await host.answer('recovery:users:plan', { orgId: RECOVERY_ORG.id, plan: planOfAna() });
  await expect(page.getByTestId('recovery-users-apply')).toBeDisabled();
  await page.getByTestId('recovery-users-acceptUserEmails').getByRole('checkbox').check();
  await page.getByTestId('recovery-users-apply').click();
}

test.describe('Back into service', () => {
  test('lists the ten steps of a refreshed sandbox, with the warning and what to keep after them', async ({
    page,
  }) => {
    await openRecovery(page, 'Dark 2026');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      `Bring ${RECOVERY_ORG.alias} back into service`,
    );
    await expect(page.getByTestId('recovery-count')).toHaveText('1/10 steps');
    await expect(page.getByTestId('recovery-not-proven')).toContainText(
      'Not yet proven on a refreshed sandbox',
    );
    await expect(page.getByTestId('recovery-steps').locator(':scope > li')).toHaveCount(10);
    await expect(page.getByRole('heading', { name: '1. Refresh noticed' })).toBeVisible();
    const order = await page.evaluate(() => {
      const steps = document.querySelector('[data-testid="recovery-steps"]');
      const before = document.querySelector('[data-testid="recovery-before-next"]');
      return steps && before ? steps.compareDocumentPosition(before) : 0;
    });
    expect(order & 4, 'what to keep comes after the steps').toBe(4);
  });

  test('without a refresh noticed, says so and puts what to keep before the next one first', async ({
    page,
  }) => {
    await openRecovery(page, 'Dark 2026', unrefreshedStatus());
    await expect(page.getByTestId('recovery-no-refresh')).toBeVisible();
    await expect(page.getByTestId('recovery-refreshed')).toHaveText('No refresh noticed');
    const order = await page.evaluate(() => {
      const steps = document.querySelector('[data-testid="recovery-steps"]');
      const before = document.querySelector('[data-testid="recovery-before-next"]');
      return steps && before ? before.compareDocumentPosition(steps) : 0;
    });
    expect(order & 4, 'what to keep comes before the steps').toBe(4);
    await expect(page.getByTestId('recovery-finish')).toHaveCount(0);
  });

  test('sets the users up after a simulation of the same list, the email to each accepted for the run', async ({
    page,
  }) => {
    const host = await openRecovery(page, 'Dark 2026');
    await runAna(page, host);
    const applied = await host.asked('recovery:users:apply');
    expect(applied.payload).toEqual({
      orgId: RECOVERY_ORG.id,
      config: { users: [{ username: ANA, email: 'restore' }] },
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    });
    await host.push('recovery:users:apply', 'recovery:users:progress', {
      orgId: RECOVERY_ORG.id,
      done: 0,
      total: 1,
    });
    await expect(page.getByTestId('recovery-users-progress')).toContainText('0 of 1 users');
    await host.answer('recovery:users:apply', { orgId: RECOVERY_ORG.id, applied: appliedAna() });
    const result = page.getByTestId('recovery-users-result');
    await expect(result).toContainText('Run 1: the users are set up as asked.');
    await expect(result).toContainText('awaiting confirmation');
    await expect(result).not.toContainText(/restored/i);
    // The status is read again once the run ended.
    await host.asked('recovery:status');
  });

  test('reads the audits, each finding with its Setup page', async ({ page }) => {
    const host = await openRecovery(page, 'Dark 2026');
    await page.getByTestId('recovery-read-endpoints').click();
    await host.answer('recovery:audit', { orgId: RECOVERY_ORG.id, audit: auditOf() });
    await expect(page.getByRole('link', { name: 'Open Setup: ERP' })).toHaveAttribute(
      'href',
      'https://example--dev.sandbox.my.salesforce.com/lightning/setup/NamedCredential/home',
    );
    await expect(page.getByRole('link', { name: 'Open Setup: Billing' })).toHaveAttribute(
      'href',
      'https://example--dev.sandbox.my.salesforce.com/lightning/setup/SecurityRemoteProxy/home',
    );
  });

  test('opens Masking in DataOps on the sandbox, as a navigation', async ({ page }) => {
    await openRecovery(page, 'Dark 2026');
    await page.getByTestId('recovery-open-masking').click();
    await expect(page.getByTestId('dataops-page')).toBeVisible();
  });

  test('opens the replay of the checkpoint of before in Checkpoints', async ({ page }) => {
    await openRecovery(page, 'Dark 2026');
    await page.getByTestId('recovery-open-replay').click();
    await expect(page.getByTestId('checkpoint-page')).toBeVisible();
  });

  for (const theme of THEMES) {
    test.describe(`reads on ${theme}`, () => {
      test.describe.configure({ timeout: 60_000 });

      test('the steps of a refreshed sandbox, a refused one among them', async ({ page }) => {
        await openRecovery(
          page,
          theme,
          refreshedStatus({ tier: 'staging' }, { frozen: 'stagingSandbox', masking: 'skipped' }),
        );
        await expect(page.getByTestId('recovery-replay-staging')).toBeVisible();
        await expectReadable(page, theme);
      });

      test('a sandbox with no refresh noticed', async ({ page }) => {
        await openRecovery(page, theme, unrefreshedStatus());
        await expectReadable(page, theme);
      });

      test('the users simulated, the email to accept, then their run', async ({ page }) => {
        const host = await openRecovery(page, theme);
        await page.getByTestId('recovery-users-toggle').click();
        await host.answer('recovery:users:list', usersList());
        await page.getByRole('checkbox', { name: ANA }).check();
        await page.getByTestId('recovery-users-simulate').click();
        await host.answer('recovery:users:plan', { orgId: RECOVERY_ORG.id, plan: planOfAna() });
        await expect(page.getByTestId('recovery-users-plan')).toBeVisible();
        await expectReadable(page, theme);

        await page.getByTestId('recovery-users-acceptUserEmails').getByRole('checkbox').check();
        await page.getByTestId('recovery-users-apply').click();
        await host.answer('recovery:users:apply', {
          orgId: RECOVERY_ORG.id,
          applied: appliedAna(),
        });
        await expect(page.getByTestId('recovery-users-result')).toBeVisible();
        await expectReadable(page, theme);
      });

      test('the audits read', async ({ page }) => {
        const host = await openRecovery(page, theme);
        for (const step of ['deliverability', 'scheduledJobs', 'endpoints'] as const) {
          await page.getByTestId(`recovery-read-${step}`).click();
          await host.answer('recovery:audit', { orgId: RECOVERY_ORG.id, audit: auditOf() });
          await expect(page.getByTestId(`recovery-audit-${step}`)).toBeVisible();
        }
        await expectReadable(page, theme);
      });
    });
  }
});
