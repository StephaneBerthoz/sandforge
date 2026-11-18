import { test, expect, type Locator, type Page } from '@playwright/test';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';
import { createRequire } from 'node:module';

/**
 * Navigation E2E.
 *
 * This file used to drive an in-panel navigation sidebar (`sidebar`,
 * `sidebar-forge-hero`, `aria-current="page"`) that was deleted in 1.8.0 with
 * the App/AppShell shell. The quarantine README guessed the file was therefore
 * obsolete rather than repairable. It is not: navigation did not disappear in
 * 1.8.0, it moved, and it moved into TWO surfaces that both live in this
 * package and are both reachable from the harness.
 *
 * 1. In-panel routing. `PanelInner` (PanelApp.tsx) renders its own `moduleId`
 *    but subscribes to `useAppStore.currentRoute` and re-renders `PanelRouter`
 *    on every change. `useGlobalShortcuts` (G+key chords, Ctrl+1..9/0) and the
 *    command palette both call `navigate()`, so a panel really does swap the
 *    page under the user — the old "clicking a nav item navigates to the
 *    corresponding page" and "navigating back to Home shows the home page"
 *    still have a subject, only the input device changed.
 *
 * 2. The module launcher. `SidePanel` renders in the VS Code sidebar
 *    (`__SANDFORGE_MODULE__ = 'sidepanel'`, see main.tsx) and posts
 *    `sidebar:navigate` to the extension, which maps the route through
 *    `SIDEBAR_ROUTE_COMMANDS` to a `sandforge.open*` command and opens the
 *    module's panel.
 *
 * What genuinely died with the shell is the *router chrome*: there is no
 * active/current nav item anywhere any more (nothing in the webview sets
 * `aria-current`), so the two tests that asserted it were dropped rather than
 * rewritten — a launcher has no current page to mark.
 *
 * The launcher lane is raw, not enveloped: `SidePanel` posts through
 * `useVSCodeApi()` directly, with no BridgeProvider ancestor and no
 * correlationId. `MockBridge.seedOrgs`/`waitForMessage` unwrap `msg.payload`
 * before matching a type, so they cannot see these messages at all — hence the
 * local `posted`/`waitForPost` below rather than the shared helpers.
 */

/**
 * The extension's route→command map, read from the extension's own source so
 * this file cannot drift from it. That module is deliberately free of any
 * `vscode` import precisely so it can be consumed outside a VS Code runtime.
 *
 * Pulled in with `createRequire` rather than a static import: the extension
 * package is CommonJS and this one is ESM, so a named import fails on the
 * interop boundary and a default import lands on Node's own TS handling of a
 * file whose package has no `"type": "module"`. `require` goes through
 * Playwright's TypeScript hook, which handles both.
 */
const { MODULE_COMMANDS, SIDEBAR_ROUTE_COMMANDS } = createRequire(import.meta.url)(
  '../../extension/src/composition/moduleCommands',
) as {
  MODULE_COMMANDS: readonly { moduleId: string; command: string }[];
  SIDEBAR_ROUTE_COMMANDS: Readonly<Record<string, string>>;
};

/** Boot a full-width module panel, orgs already connected. */
async function openPanel(page: Page, moduleId: string): Promise<void> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  // Without orgs every org-gated page short-circuits to an EmptyState that
  // carries no page-level testid, so a navigation assertion would fail for a
  // reason that has nothing to do with navigation.
  await bridge.seedOrgs(MOCK_ORGS);
}

/** Boot the VS Code sidebar launcher, orgs already delivered. */
async function openLauncher(page: Page, orgs: readonly unknown[] = MOCK_ORGS): Promise<void> {
  await injectVSCodeApiMock(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'sidepanel';
  });
  await page.goto('/');
  await page.waitForSelector('[data-testid="sidepanel-root"]', { timeout: 10_000 });

  // The launcher asks for its orgs on mount and the extension answers with a
  // raw `org:list:response` broadcast (SidebarViewProvider.ts). Waiting for the
  // request first guarantees the listener that consumes the answer is attached:
  // the effect posts and subscribes in one synchronous body.
  await waitForPost(page, 'sidebar:requestOrgs');
  await sendExtensionMessage(page, {
    type: 'org:list:response',
    payload: { orgs, selectedOrgId: null },
  });
}

/** Every raw (unenveloped) message the launcher posted, of one type. */
async function posted(page: Page, type: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((msgType) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs.filter((m) => (m as Record<string, unknown>).type === msgType) as Record<
      string,
      unknown
    >[];
  }, type);
}

/** Wait until the launcher has posted at least one message of a type. */
async function waitForPost(page: Page, type: string): Promise<void> {
  await page.waitForFunction(
    (msgType) => {
      const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
      return msgs.some((m) => (m as Record<string, unknown>).type === msgType);
    },
    type,
    { timeout: 10_000 },
  );
}

/** Routes carried by every `sidebar:navigate` posted so far, in order. */
async function navigatedRoutes(page: Page): Promise<string[]> {
  const messages = await posted(page, 'sidebar:navigate');
  return messages.map((m) => (m.payload as Record<string, unknown>).route as string);
}

/** The route ids the launcher offers inside one of its nav containers. */
/** The id a launcher group is drawn with, read from its testid. */
async function groupId(group: Locator): Promise<string> {
  return ((await group.getAttribute('data-testid')) ?? '').replace('sidepanel-group-', '');
}

async function entryRoutes(page: Page, containerTestId: string): Promise<string[]> {
  return page
    .getByTestId(containerTestId)
    .locator('[data-testid^="sidepanel-nav-"]')
    .evaluateAll((els) =>
      els.map((el) => (el.getAttribute('data-testid') ?? '').replace('sidepanel-nav-', '')),
    );
}

test.describe('In-panel navigation', () => {
  test.beforeEach(async ({ page }) => {
    await openPanel(page, 'home');
    await page.waitForSelector('[data-testid="home-page"]', { timeout: 10_000 });
  });

  test('a G+key chord swaps the panel to another module', async ({ page }) => {
    await page.keyboard.press('g');
    await page.keyboard.press('e');

    // The panel booted on `home` and never reloaded — the store change alone
    // replaced the page under the same root.
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('home-page')).toHaveCount(0);
  });

  test('a chord navigates back to Home', async ({ page }) => {
    await page.keyboard.press('g');
    await page.keyboard.press('e');
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('g');
    await page.keyboard.press('h');

    await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
  });

  test('Ctrl+number jumps straight to a module', async ({ page }) => {
    await page.keyboard.press('Control+8');

    await expect(page.getByTestId('autopilot-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('home-page')).toHaveCount(0);
  });

  test('the command palette navigates to a module', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('command-palette-item-nav-help').click();

    // Selecting a navigation item both routes and dismisses the overlay.
    await expect(page.getByTestId('help-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
  });

  test('a chord expires instead of firing on a later keystroke', async ({ page }) => {
    await page.keyboard.press('g');

    // CHORD_TIMEOUT is 500 ms (useGlobalShortcuts.ts); past it the pending `g`
    // is dropped, so this `e` is a bare keystroke and not "go to settings".
    await page.waitForTimeout(800);
    await page.keyboard.press('e');

    await expect(page.getByTestId('settings-page')).toHaveCount(0);
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('chord keys typed into a text field do not navigate', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette-input')).toBeFocused({ timeout: 10_000 });

    // "ge" is the settings chord. Typed into an input it must stay text: the
    // shortcut handler bails on INPUT/TEXTAREA/contenteditable targets.
    //
    // Typed key by key, not `fill()`: fill sets the value and fires `input`
    // without a single keydown, so the shortcut handler never runs and the
    // assertion below holds whether the guard exists or not.
    await page.getByTestId('command-palette-input').pressSequentially('ge');
    await expect(page.getByTestId('command-palette-input')).toHaveValue('ge');

    await expect(page.getByTestId('settings-page')).toHaveCount(0);
    await expect(page.getByTestId('home-page')).toBeVisible();
  });
});

test.describe('Module launcher', () => {
  test.beforeEach(async ({ page }) => {
    await openLauncher(page);
  });

  test('offers every module in five groups by what they are for, none folded, and the three tools', async ({
    page,
  }) => {
    await expect(page.getByTestId('sidepanel-modules')).toBeVisible();
    await expect(page.getByTestId('sidepanel-tools')).toBeVisible();

    // Filling an org first: it works with one empty org. The two sandboxes
    // registered list Back into service.
    const modules = page.getByRole('navigation', { name: 'Modules' });
    await expect(modules.getByRole('group')).toHaveCount(5);
    const groups: Array<[string, string[]]> = [
      ['Fill an org', ['seed', 'frozen']],
      ['Copy between orgs', ['forge', 'sync', 'autopilot', 'migration']],
      ['Protect and restore', ['recovery', 'checkpoint', 'dataops']],
      ['Watch and compare', ['monitor', 'compare', 'reports']],
      ['Automate', ['automation', 'ai']],
    ];
    for (const [name, routes] of groups) {
      const group = modules.getByRole('group', { name });
      await expect(group.getByRole('heading', { name })).toBeVisible();
      expect(await entryRoutes(page, `sidepanel-group-${await groupId(group)}`)).toEqual(routes);
    }
    await expect(page.getByTestId('sidepanel-advanced-toggle')).toHaveCount(0);
    expect(await entryRoutes(page, 'sidepanel-tools')).toEqual(['orgs', 'settings', 'help']);
  });

  test('never lists Grappe, whose page is retired, whatever sandforge.grappe.enabled says', async ({
    page,
  }) => {
    await sendExtensionMessage(page, {
      type: 'settings:response',
      payload: { settings: {}, grappeEnabled: true },
    });
    await expect(page.getByTestId('sidepanel-nav-reports')).toBeVisible();
    await expect(page.getByTestId('sidepanel-nav-grappe')).toHaveCount(0);
  });

  test('every entry it offers is a route the extension can open', async ({ page }) => {
    const modules = await entryRoutes(page, 'sidepanel-modules');
    const tools = await entryRoutes(page, 'sidepanel-tools');

    for (const route of [...modules, ...tools]) {
      await page.getByTestId(`sidepanel-nav-${route}`).click();
    }
    await page.getByTestId('sidepanel-forge').click();

    const emitted = await navigatedRoutes(page);
    expect(emitted).toEqual([...modules, ...tools, 'forge']);

    // The extension resolves an unknown route to `sandforge.openHome`
    // (SidebarViewProvider.ts), so a launcher entry whose route is not in the
    // map does not fail loudly — it silently opens Home instead. That is
    // what this asserts against.
    for (const route of emitted) {
      expect(Object.keys(SIDEBAR_ROUTE_COMMANDS)).toContain(route);
    }

    // And the other direction: a module command the extension registers with
    // no way to reach it from the launcher. `home` is the page the button
    // beside the mark opens, through `sidebar:openFull` rather than a route;
    // Grappe's command goes with its retired page.
    const launcherRoutes = new Set(emitted);
    const unreachable = MODULE_COMMANDS.map((c) => c.moduleId).filter(
      (moduleId) => !launcherRoutes.has(moduleId) && moduleId !== 'grappe',
    );
    expect(unreachable).toEqual(['home']);
    await page.getByTestId('sidepanel-open-full').click();
    expect(await posted(page, 'sidebar:openFull')).toHaveLength(1);
  });

  test('after a refresh, the hero opens Back into service on the sandbox refreshed', async ({
    page,
  }) => {
    const refreshed = MOCK_ORGS[1] as { id: string; alias: string };
    await sendExtensionMessage(page, {
      type: 'sidebar:afterRefresh',
      payload: [
        {
          orgId: refreshed.id,
          alias: refreshed.alias,
          detectedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
          done: 3,
          total: 9,
        },
      ],
    });
    const hero = page.getByTestId('sidepanel-after-refresh-hero');
    await expect(hero).toContainText(`Bring ${refreshed.alias} back into service`);
    await expect(hero).toContainText('Refreshed 2 hours ago · 3/9 steps');
    await expect(page.getByTestId('sidepanel-forge')).toHaveCount(0);

    await hero.click();

    expect(await navigatedRoutes(page)).toEqual(['recovery']);
    const selected = await posted(page, 'sidebar:selectOrg');
    expect(selected.at(-1)?.payload).toEqual({ orgId: refreshed.id });

    // Every step done: the hero goes back to Forge.
    await sendExtensionMessage(page, { type: 'sidebar:afterRefresh', payload: [] });
    await expect(page.getByTestId('sidepanel-forge')).toBeVisible();
  });

  test('with production orgs alone, the hero asks for the sandbox to fill, and opens the browser login', async ({
    page,
  }) => {
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      payload: {
        orgs: [{ ...MOCK_ORGS[0], orgType: 'Production' }],
        selectedOrgId: null,
      },
    });
    await expect(page.getByTestId('sidepanel-forge')).toHaveCount(0);

    await page.getByTestId('sidepanel-add-sandbox-hero').click();

    expect((await posted(page, 'sidebar:navigate')).map((m) => m.payload)).toEqual([
      { route: 'orgs', intent: { orgAction: 'login-web' } },
    ]);
  });

  test('with one org connected, Copy between orgs says a second is needed, and opens Organizations', async ({
    page,
  }) => {
    await expect(page.getByTestId('sidepanel-needs-second-org')).toHaveCount(0);
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      payload: { orgs: [{ ...MOCK_ORGS[0], orgType: 'Developer' }], selectedOrgId: null },
    });

    const needs = page
      .getByTestId('sidepanel-group-copy')
      .getByTestId('sidepanel-needs-second-org');
    await expect(needs).toHaveText('Needs a second org');
    await needs.click();

    expect(await navigatedRoutes(page)).toEqual(['orgs']);
  });

  test('with one Developer Edition, the hero opens Seed on it rather than Forge', async ({
    page,
  }) => {
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      payload: { orgs: [{ ...MOCK_ORGS[0], orgType: 'Developer' }], selectedOrgId: null },
    });
    await expect(page.getByTestId('sidepanel-forge')).toHaveCount(0);

    await page.getByTestId('sidepanel-seed-hero').click();

    expect(await navigatedRoutes(page)).toEqual(['seed']);
    const selected = await posted(page, 'sidebar:selectOrg');
    expect(selected.at(-1)?.payload).toEqual({ orgId: (MOCK_ORGS[0] as { id: string }).id });
  });

  test('with no org, the first card opens Organizations on the import or the browser login', async ({
    page,
  }) => {
    await sendExtensionMessage(page, {
      type: 'org:list:response',
      payload: { orgs: [], selectedOrgId: null },
    });
    await sendExtensionMessage(page, { type: 'sidebar:cliOrgs', payload: { count: 2 } });
    await expect(page.getByTestId('sidepanel-first-org-import')).toHaveText(
      'Import up to 2 orgs from Salesforce CLI',
    );

    await page.getByTestId('sidepanel-first-org-import').click();
    await page.getByTestId('sidepanel-first-org-login').click();

    const intents = (await posted(page, 'sidebar:navigate')).map((m) => m.payload);
    expect(intents).toEqual([
      { route: 'orgs', intent: { orgAction: 'import-cli' } },
      { route: 'orgs', intent: { orgAction: 'login-web' } },
    ]);
  });

  test('the forge hero asks the extension to open Forge', async ({ page }) => {
    await expect(page.getByTestId('sidepanel-forge')).toBeVisible();

    await page.getByTestId('sidepanel-forge').click();

    expect(await navigatedRoutes(page)).toEqual(['forge']);
  });

  test('a short panel swaps the forge hero for its compact variant', async ({ page }) => {
    // The sidebar is often short — VS Code gives it whatever height is left
    // under the explorer. Below 650px the hero drops to a one-line button
    // (SidePanel.tsx `isCompact`), and it has to keep working.
    await page.setViewportSize({ width: 320, height: 600 });

    await expect(page.getByTestId('sidepanel-forge-compact')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sidepanel-forge')).toHaveCount(0);

    await page.getByTestId('sidepanel-forge-compact').click();
    expect(await navigatedRoutes(page)).toEqual(['forge']);

    // Give the height back and the full hero returns — the resize listener is
    // live, not a boot-time measurement.
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(page.getByTestId('sidepanel-forge')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sidepanel-forge-compact')).toHaveCount(0);
  });
});
