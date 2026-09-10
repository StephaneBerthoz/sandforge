import { test, expect, type Page } from '@playwright/test';
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

  test('offers the module and tool entries', async ({ page }) => {
    await expect(page.getByTestId('sidepanel-modules')).toBeVisible();
    await expect(page.getByTestId('sidepanel-tools')).toBeVisible();

    expect((await entryRoutes(page, 'sidepanel-modules')).sort()).toEqual(
      [
        'ai',
        'automation',
        'autopilot',
        'compare',
        'dataops',
        'frozen',
        'grappe',
        'migration',
        'monitor',
        'seed',
        'sync',
      ].sort(),
    );
    expect((await entryRoutes(page, 'sidepanel-tools')).sort()).toEqual(
      ['help', 'orgs', 'settings'].sort(),
    );
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

    // The extension resolves an unknown route to `sandforge.openMonitor`
    // (SidebarViewProvider.ts), so a launcher entry whose route is not in the
    // map does not fail loudly — it silently opens Monitor instead. That is
    // what this asserts against.
    for (const route of emitted) {
      expect(Object.keys(SIDEBAR_ROUTE_COMMANDS)).toContain(route);
    }

    // And the other direction: a module command the extension registers with
    // no way to reach it from the launcher. `reports` is the one deliberate
    // exception — it has no launcher entry and is reached from the command
    // palette (ALL_ROUTES) or the G+R chord instead.
    const launcherRoutes = new Set(emitted);
    const unreachable = MODULE_COMMANDS.map((c) => c.moduleId).filter(
      (moduleId) => !launcherRoutes.has(moduleId),
    );
    expect(unreachable).toEqual(['reports']);
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
