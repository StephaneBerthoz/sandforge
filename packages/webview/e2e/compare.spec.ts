import { test, expect, type Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS, DEV_SANDBOX, QA_SANDBOX } from './fixtures';
import { sendExtensionMessage } from './mocks/vscode-api';

/**
 * Compare panel E2E.
 *
 * Access rewritten for the panel-per-module world: the in-app sidebar this
 * file used to click through was deleted in 1.8.0 (11f12588), so every test
 * here boots the panel the way the extension does — `__SANDFORGE_MODULE__`
 * set before the app loads — and waits on `compare-page`, a page testid, not
 * on a shell element.
 *
 * The assertions are the ones the quarantined file meant to make, tightened:
 * where the old version settled for "the page is still visible", these read
 * the control the test is named after.
 */

/** A `CompareResult` shaped the way `CompareOrchestrator.execute` returns it. */
const MOCK_COMPARE_RESULT = {
  configId: '4f1a2b3c-0000-4000-8000-000000000001',
  sourceOrgId: DEV_SANDBOX.id,
  targetOrgId: QA_SANDBOX.id,
  mode: 'metadata',
  summary: {
    totalItems: 135,
    added: 5,
    removed: 2,
    modified: 8,
    unchanged: 120,
    byType: {},
  },
  // `CompareItem`, not the `{componentName, sourceContent}` shape the
  // quarantined fixture invented — `enrichDiffs` reads `fullName`,
  // `componentType`, `status`, `severity`, so the old fixture produced rows
  // with an undefined name and no risk at all.
  diffs: [
    {
      componentType: 'ApexTrigger',
      fullName: 'AccountTrigger',
      status: 'modified',
      sourceValue: 'trigger AccountTrigger on Account (before insert) { }',
      targetValue: 'trigger AccountTrigger on Account (before insert, before update) { }',
      severity: 'warning',
      deployable: true,
    },
    {
      componentType: 'ApexClass',
      fullName: 'MyClass',
      status: 'added',
      sourceValue: 'public class MyClass { }',
      severity: 'info',
      deployable: true,
    },
    {
      componentType: 'ApexClass',
      fullName: 'OldHelper',
      status: 'removed',
      targetValue: 'public class OldHelper { }',
      severity: 'breaking',
      deployable: false,
    },
    {
      componentType: 'CustomObject',
      fullName: 'Legacy__c',
      status: 'unchanged',
      severity: 'info',
      deployable: true,
    },
  ],
  timestamp: '2026-09-10T09:00:00.000Z',
  duration: 4210,
};

/**
 * Answer *every* in-flight request of a type, each with its own correlationId.
 *
 * `useMessageResponse` drops any response whose `correlationId` is not the
 * request's id, and React StrictMode can leave two ids in flight for the same
 * query — answering only one leaves the live one hanging on its skeleton.
 *
 * Local to this spec on purpose: the shared helpers are read-only here.
 */
async function answerAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await page.waitForFunction(
    (type) => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return msgs.some((m) => {
        const envelope = m as Record<string, unknown>;
        const inner = (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
        return inner.type === type;
      });
    },
    requestType,
    { timeout: 10_000 },
  );

  const ids = await page.evaluate((type) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const envelope = m as Record<string, unknown>;
        return (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
      })
      .filter((m) => m.type === type)
      .map((m) => m.id as string);
  }, requestType);

  for (const correlationId of ids) {
    await sendExtensionMessage(page, {
      type: responseType,
      id: `resp-${correlationId}`,
      correlationId,
      payload,
    });
  }
}

/** Id of the most recent outgoing request of a type, for the error channel. */
async function lastRequestId(page: Page, requestType: string): Promise<string> {
  return page.evaluate((type) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    const match = [...msgs]
      .map((m) => {
        const envelope = m as Record<string, unknown>;
        return (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
      })
      .reverse()
      .find((m) => m.type === type) as Record<string, unknown> | undefined;
    return (match?.id as string) ?? 'unknown';
  }, requestType);
}

/**
 * Boot the compare panel exactly as the extension opens it.
 *
 * Order matters and is the one screenshots.spec.ts established: `setup` →
 * init script → `goto` → answer the mount burst → wait for the page testid.
 * Orgs have to land *before* the wait, because ComparePage short-circuits to
 * an `EmptyState` (which carries no `compare-page` testid) when fewer than two
 * orgs are connected.
 */
async function openComparePanel(
  page: Page,
  orgs: readonly unknown[] = MOCK_ORGS,
): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'compare';
  });
  await page.goto('/');
  await bridge.seedOrgs(orgs);
  return bridge;
}

/** Pick source + target orgs and one category, then fire the comparison. */
async function startComparison(page: Page): Promise<void> {
  await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
  await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
  await page.getByTestId('cat-ApexClass').click();
  await page.getByTestId('cat-ApexTrigger').click();
  await page.getByTestId('run-compare-btn').click();
}

/** Run a comparison end to end and settle on rendered results. */
async function completeComparison(page: Page): Promise<void> {
  await startComparison(page);
  await answerAll(page, 'compare:execute', 'compare:execute:response', MOCK_COMPARE_RESULT);
  await expect(page.getByTestId('compare-summary')).toBeVisible({ timeout: 10_000 });
}

test.describe('Compare panel — org prerequisites', () => {
  test('falls back to the empty state when only one org is connected', async ({ page }) => {
    await openComparePanel(page, [DEV_SANDBOX]);

    const emptyState = page.getByTestId('empty-state');
    await expect(emptyState).toBeVisible({ timeout: 10_000 });
    await expect(emptyState).toContainText('Spot differences between two orgs');
    // The first step is the one-org variant, not the connect-two variant.
    await expect(page.getByTestId('empty-step-0')).toContainText('second');
    await expect(page.getByTestId('compare-page')).toHaveCount(0);
  });
});

test.describe('Compare panel — controls', () => {
  test.beforeEach(async ({ page }) => {
    await openComparePanel(page);
    await expect(page.getByTestId('compare-page')).toBeVisible({ timeout: 10_000 });
  });

  test('opens straight into the compare page when the extension boots the panel', async ({
    page,
  }) => {
    // No sidebar, no click-through: the module id alone routes PanelRouter.
    await expect(page.getByTestId('compare-page')).toBeVisible();
    await expect(page.getByTestId('org-selector')).toBeVisible();
    await expect(page.getByTestId('category-selector')).toBeVisible();
  });

  test('displays page header with the Compare title', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: 'Compare Org' })).toBeVisible();
    await expect(page.getByTestId('page-header-subtitle')).toHaveText('No comparison results yet');
  });

  test('displays the org selector with every connected org', async ({ page }) => {
    const source = page.getByLabel('Source Org');
    const target = page.getByLabel('Target Org');

    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    // `[SBX]` / `[PROD]` suffix comes from formatOrgLabel.
    await expect(source.locator('option')).toHaveText([
      'Select source org',
      'DevSandbox [SBX]',
      'QASandbox [SBX]',
    ]);

    // Picking the same org on both sides raises the guard warning.
    await source.selectOption(DEV_SANDBOX.id);
    await target.selectOption(DEV_SANDBOX.id);
    await expect(page.getByTestId('org-same-warning')).toHaveText(
      'Source and target orgs must be different',
    );
  });

  test('run compare button is disabled until orgs and categories are picked', async ({ page }) => {
    const runBtn = page.getByTestId('run-compare-btn');
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toHaveText('Run Comparison');
    await expect(runBtn).toBeDisabled();

    // Orgs alone are not enough — a comparison with no category is a no-op.
    await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
    await page.getByLabel('Target Org').selectOption(QA_SANDBOX.id);
    await expect(runBtn).toBeDisabled();

    await page.getByTestId('cat-ApexClass').click();
    await expect(runBtn).toBeEnabled();

    // And the same org on both sides disables it again.
    await page.getByLabel('Target Org').selectOption(DEV_SANDBOX.id);
    await expect(runBtn).toBeDisabled();
  });

  test('schema advice button is visible and gated on a source org', async ({ page }) => {
    const adviceBtn = page.getByTestId('schema-advice-btn');
    await expect(adviceBtn).toBeVisible();
    await expect(adviceBtn).toBeDisabled();

    await page.getByLabel('Source Org').selectOption(DEV_SANDBOX.id);
    await expect(adviceBtn).toBeEnabled();

    await adviceBtn.click();
    await answerAll(page, 'ai:schema-advice', 'ai:schema-advice:response', {
      success: true,
      advice: {
        issues: [
          {
            objectName: 'Account',
            field: 'Rating__c',
            severity: 'high',
            message: 'Picklist has no restricted value set.',
          },
        ],
        recommendations: [
          { title: 'Restrict the picklist', description: 'Prevents free-text drift.' },
        ],
      },
    });

    const results = page.getByTestId('schema-advice-results');
    await expect(results).toBeVisible({ timeout: 10_000 });
    await expect(results).toContainText('Account');
    await expect(results).toContainText('Picklist has no restricted value set.');
    await expect(results).toContainText('Restrict the picklist');
  });

  test('shows the no-results message before any comparison has run', async ({ page }) => {
    await expect(page.getByTestId('compare-page')).toContainText('No comparison results yet');
    await expect(page.getByTestId('compare-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('compare-summary')).toHaveCount(0);
    await expect(page.getByTestId('page-tabs')).toHaveCount(0);
  });
});

test.describe('Compare panel — running a comparison', () => {
  test.beforeEach(async ({ page }) => {
    await openComparePanel(page);
    await expect(page.getByTestId('compare-page')).toBeVisible({ timeout: 10_000 });
  });

  test('shows loading skeleton while the comparison is in flight', async ({ page }) => {
    await startComparison(page);

    // Nothing has answered `compare:execute` yet: the page must say it is
    // working, not sit on the "no results" line as if nothing had happened.
    await expect(page.getByTestId('compare-skeleton')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('run-compare-btn')).toHaveText('Comparing...');
    await expect(page.getByTestId('run-compare-btn')).toBeDisabled();

    await answerAll(page, 'compare:execute', 'compare:execute:response', MOCK_COMPARE_RESULT);

    await expect(page.getByTestId('compare-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('run-compare-btn')).toHaveText('Run Comparison');
  });

  test('displays compare results after receiving the response', async ({ page }) => {
    await completeComparison(page);

    // Summary bar reads the response's own counts.
    const summary = page.getByTestId('compare-summary');
    await expect(summary).toContainText('+5 Added');
    await expect(summary).toContainText('-2 Removed');
    await expect(summary).toContainText('~8 Modified');
    await expect(summary).toContainText('=120 Unchanged');

    // Risk scoring runs over the diffs, not over the summary.
    await expect(page.getByTestId('risk-score-card')).toBeVisible();
    await expect(page.getByTestId('risk-score-value')).not.toBeEmpty();

    // Diff groups: the three changed items land in "Apex Code"; the
    // unchanged CustomObject is filtered out by enrichDiffs, so no
    // "Data Model" group exists.
    await expect(page.getByTestId('diff-groups')).toBeVisible();
    const apexGroup = page.getByTestId('diff-group-Apex Code');
    await expect(apexGroup).toBeVisible();
    await expect(apexGroup).toContainText('3 changes');
    await expect(page.getByTestId('diff-group-Data Model')).toHaveCount(0);

    // Expanding the group lists the components by their real API names.
    await page.getByTestId('diff-group-toggle-Apex Code').click();
    await expect(page.getByTestId('diff-item-AccountTrigger')).toBeVisible();
    await expect(page.getByTestId('diff-item-MyClass')).toBeVisible();
    await expect(page.getByTestId('diff-item-OldHelper')).toBeVisible();

    // And a component opens its detail modal.
    await page.getByTestId('diff-item-OldHelper').click();
    await expect(page.getByTestId('diff-detail-modal')).toBeVisible();
    await expect(page.getByTestId('diff-detail-name')).toContainText('OldHelper');
    await expect(page.getByTestId('diff-target-value')).toContainText('public class OldHelper { }');
    await page.getByTestId('close-diff-modal').click();
    await expect(page.getByTestId('diff-detail-modal')).toHaveCount(0);
  });

  test('error banner surfaces a failed comparison and can be dismissed', async ({ page }) => {
    await startComparison(page);

    // CompareHandler replies on `compare:error` when the orchestrator throws;
    // the banner is the only place the user ever sees that string.
    const correlationId = await lastRequestId(page, 'compare:execute');
    await sendExtensionMessage(page, {
      type: 'compare:error',
      id: `err-${correlationId}`,
      correlationId,
      payload: { message: 'Connection timeout while retrieving metadata' },
    });

    const banner = page.getByTestId('compare-error');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Connection timeout while retrieving metadata');
    await expect(page.getByTestId('compare-skeleton')).toHaveCount(0);

    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
  });
});

test.describe('Compare panel — results tabs', () => {
  test.beforeEach(async ({ page }) => {
    await openComparePanel(page);
    await expect(page.getByTestId('compare-page')).toBeVisible({ timeout: 10_000 });
    await completeComparison(page);
  });

  test('renders the five result tabs once a comparison has run', async ({ page }) => {
    await expect(page.getByTestId('page-tabs')).toBeVisible();
    await expect(page.getByTestId('page-tabs').getByRole('tab')).toHaveText([
      'Diff Viewer',
      'Permission Matrix',
      'Snapshots',
      'Drift Dashboard',
      'Deploy from Diff',
    ]);
    await expect(page.getByTestId('page-tab-diff')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('page-tab-permissions')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  /**
   * Was a product gap: `CompareHandler.handlePermissions` posts
   * `{ permissions: { permissionSets, profiles } }` — names split three ways —
   * while the tab read the payload as `PermissionMatrixRow[]` and handed it to
   * a CRUD matrix, whose `rows.map` threw and took the whole panel down.
   *
   * The extension's data is real, so the tab reads it: which permission sets
   * and profiles each org has, ✓/✗ per side. Nothing anywhere computes object
   * CRUD, so no CRUD column is rendered to suggest access was audited — this
   * test holds that absence in place as much as the presence of the rows.
   */
  test('permissions tab shows which permission sets and profiles each org has', async ({
    page,
  }) => {
    await page.getByTestId('page-tab-permissions').click();
    await answerAll(page, 'compare:permissions', 'compare:permissions:response', {
      permissions: {
        permissionSets: {
          sourceOnly: [{ name: 'Sales_Admin', label: 'Sales Admin' }],
          targetOnly: [],
          shared: [{ name: 'Support_Agent', label: 'Support Agent' }],
        },
        profiles: {
          sourceOnly: [],
          targetOnly: [{ name: 'Read Only' }],
          shared: [{ name: 'System Administrator' }],
        },
      },
    });

    const matrix = page.getByTestId('perm-presence-matrix');
    await expect(matrix).toBeVisible({ timeout: 10_000 });

    // The two sides are the two orgs, not four CRUD letters.
    await expect(page.getByTestId('perm-header-source')).toHaveText('Source Org');
    await expect(page.getByTestId('perm-header-target')).toHaveText('Target Org');

    // Source-only permission set: present left, absent right, called Removed
    // in the same vocabulary as the summary bar above it.
    await expect(page.getByTestId('perm-source-PermissionSet-Sales_Admin')).toHaveText('✓');
    await expect(page.getByTestId('perm-target-PermissionSet-Sales_Admin')).toHaveText('✗');
    await expect(page.getByTestId('perm-status-PermissionSet-Sales_Admin')).toHaveText('Removed');
    await expect(matrix).toContainText('Sales Admin');

    // Target-only profile is the mirror case; shared entries read Unchanged.
    await expect(page.getByTestId('perm-source-Profile-Read Only')).toHaveText('✗');
    await expect(page.getByTestId('perm-status-Profile-Read Only')).toHaveText('Added');
    await expect(page.getByTestId('perm-status-Profile-System Administrator')).toHaveText(
      'Unchanged',
    );

    // Honesty lock: the CRUD grid nothing feeds must not come back.
    await expect(page.getByTestId('perm-matrix')).toHaveCount(0);
    await expect(page.getByTestId('perm-yes')).toHaveCount(0);

    // And the panel itself survived the tab — the whole point of the fix.
    await expect(page.getByTestId('compare-page')).toBeVisible();
  });

  /**
   * Was a product gap: `CompareHandler.handleSnapshots` posts
   * `{ snapshot: { source, target, diff, capturedAt } }` — one capture of both
   * orgs, taken now — while the tab read it as `OrgSnapshot[]` and spread it
   * with `[...snapshots]`, which throws on a plain object.
   *
   * Nothing in the extension stores snapshots over time, so the timeline had
   * no possible input, and its "Create Snapshot" button promised a capability
   * that does not exist. The tab renders the comparison that does: object
   * totals per org and the objects only one side has.
   */
  test('snapshots tab shows both orgs object totals and what only one side has', async ({
    page,
  }) => {
    await page.getByTestId('page-tab-snapshots').click();
    await answerAll(page, 'compare:snapshots', 'compare:snapshots:response', {
      snapshot: {
        source: {
          orgId: DEV_SANDBOX.id,
          totalObjects: 812,
          customObjects: 44,
          standardObjects: 768,
          queryableObjects: 790,
        },
        target: {
          orgId: QA_SANDBOX.id,
          totalObjects: 806,
          customObjects: 41,
          standardObjects: 765,
          queryableObjects: 784,
        },
        diff: { sourceOnly: ['Legacy__c'], targetOnly: [], sharedCount: 805 },
        capturedAt: '2026-09-10T09:05:00.000Z',
      },
    });

    await expect(page.getByTestId('snapshot-comparison')).toBeVisible({ timeout: 10_000 });

    // Both totals come from the response, each under its own org.
    await expect(page.getByTestId('snapshot-source-total')).toHaveText('812 objects');
    await expect(page.getByTestId('snapshot-target-total')).toHaveText('806 objects');
    await expect(page.getByTestId('snapshot-source')).toContainText('Source Org');
    await expect(page.getByTestId('snapshot-target')).toContainText('Target Org');

    // The one object the target lacks is named, not just counted.
    await expect(page.getByTestId('snapshot-object-Legacy__c')).toBeVisible();
    await expect(page.getByTestId('snapshot-object-status-Legacy__c')).toHaveText('Removed');

    // The shared count is the sample size: without it an empty list of
    // differences could pass for "nothing was compared".
    await expect(page.getByTestId('snapshot-shared-count')).toHaveText('805 objects');
    await expect(page.getByTestId('snapshot-captured-at')).toContainText('2026-09-10');

    // Honesty lock: no history, so no timeline and no snapshot-taking button.
    await expect(page.getByTestId('snapshot-timeline')).toHaveCount(0);
    await expect(page.getByTestId('create-snapshot-btn')).toHaveCount(0);
    await expect(page.getByTestId('compare-page')).not.toContainText('No snapshots available');

    await expect(page.getByTestId('compare-page')).toBeVisible();
  });

  /**
   * Was a product gap: `CompareHandler.handleDrift` posts
   * `{ drift: { items, totalChecked, driftCount, ... } }` — org *settings*,
   * read off the `Organization` record on both sides — while the dashboard
   * read `drift.driftedComponents` and `drift.driftScore`, two fields no
   * producer in the codebase has ever computed.
   *
   * The items are settings, so the tab renders settings, and scores them by
   * the same four-way vocabulary the rest of the page uses.
   */
  test('drift tab scores the settings the extension actually compared', async ({ page }) => {
    await page.getByTestId('page-tab-drift').click();
    await answerAll(page, 'compare:drift', 'compare:drift:response', {
      drift: {
        items: [
          {
            setting: 'Organization.DefaultLocaleSidKey',
            sourceValue: 'fr_FR',
            targetValue: 'en_US',
            status: 'drift',
          },
          {
            setting: 'Organization.TimeZoneSidKey',
            sourceValue: 'Europe/Paris',
            targetValue: 'Europe/Paris',
            status: 'match',
          },
        ],
        totalChecked: 2,
        driftCount: 1,
        matchCount: 1,
        missingCount: 0,
        detectedAt: '2026-09-10T09:06:00.000Z',
      },
    });

    await expect(page.getByTestId('settings-drift')).toBeVisible({ timeout: 10_000 });

    // Both compared settings are listed with the values behind the verdict.
    await expect(page.getByTestId('drift-source-Organization.DefaultLocaleSidKey')).toHaveText(
      'fr_FR',
    );
    await expect(page.getByTestId('drift-target-Organization.DefaultLocaleSidKey')).toHaveText(
      'en_US',
    );
    await expect(page.getByTestId('drift-status-Organization.DefaultLocaleSidKey')).toHaveText(
      'Modified',
    );
    await expect(page.getByTestId('drift-status-Organization.TimeZoneSidKey')).toHaveText(
      'Unchanged',
    );

    // 1 of the 2 settings differs: the score is that fraction, and the counts
    // that make up its denominator are on screen beside it.
    await expect(page.getByTestId('settings-drift')).toContainText('50%');
    await expect(page.getByTestId('drift-modified')).toContainText('~1');
    await expect(page.getByTestId('drift-unchanged')).toContainText('=1');
    await expect(page.getByTestId('drift-added')).toContainText('+0');

    // Honesty lock: with one setting differing, the old "No drift detected"
    // line would be a false all-clear.
    await expect(page.getByTestId('compare-page')).not.toContainText('No drift detected');

    await expect(page.getByTestId('compare-page')).toBeVisible();
  });

  /**
   * The other half of the contract: a well-formed envelope that carries
   * nothing comparable is reported, not rendered.
   *
   * An empty drift dashboard reads as "these two orgs agree" — a measurement
   * the extension never made. v1.19.0 spent a release deleting that class of
   * lie; this test keeps it out of the compare panel.
   */
  test('drift tab reports an empty answer instead of implying the orgs agree', async ({ page }) => {
    await page.getByTestId('page-tab-drift').click();
    await answerAll(page, 'compare:drift', 'compare:drift:response', {
      drift: {
        items: [],
        totalChecked: 0,
        driftCount: 0,
        matchCount: 0,
        missingCount: 0,
        detectedAt: '2026-09-10T09:06:00.000Z',
      },
    });

    const banner = page.getByTestId('compare-drift-error');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('compare:drift returned no settings to compare');
    await expect(page.getByTestId('settings-drift')).toHaveCount(0);
    await expect(page.getByTestId('compare-page')).not.toContainText('No drift detected');
    await expect(page.getByTestId('compare-page')).toBeVisible();
  });

  /**
   * The deploy tab has no producer anywhere in the extension — no
   * `compare:deploy` handler, no `DeploymentSuggestion` ever computed. The
   * page says so instead of mounting an empty deployment list, and that
   * honesty is what this test protects: a regression that swaps the notice
   * back for a component fed hardcoded emptiness would read to the user as
   * "this diff holds nothing deployable".
   */
  test('deploy tab says the capability is not wired yet', async ({ page }) => {
    await page.getByTestId('page-tab-deploy').click();

    const notice = page.getByTestId('compare-deploy-soon');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Coming soon');
    await expect(notice).toContainText('Build Deployment');
    // No request is fired for a surface nothing answers.
    const deployRequests = await page.evaluate(() => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return msgs
        .map((m) => {
          const envelope = m as Record<string, unknown>;
          return (envelope.payload as Record<string, unknown> | undefined) ?? envelope;
        })
        .filter(
          (m) => typeof m.type === 'string' && (m.type as string).startsWith('compare:deploy'),
        ).length;
    });
    expect(deployRequests).toBe(0);
  });
});
