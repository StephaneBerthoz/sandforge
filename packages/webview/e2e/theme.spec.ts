import { test, expect, type Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * The webview does not own its colours — VS Code does.
 *
 * The host injects `--vscode-*` custom properties into the webview document,
 * `styles/design-system.css` maps them onto the `--sf-*` tokens, and PanelApp
 * paints its `main` with `bg-[var(--sf-bg-primary)] text-[var(--sf-text-primary)]`.
 * So a panel is correctly themed only when BOTH ends of that chain resolve:
 * a themed background with hard-coded text is exactly how the product came out
 * unreadable on light themes.
 *
 * These specs boot a real module panel (`__SANDFORGE_MODULE__`, the way the
 * extension opens one — there has been no in-app navigation sidebar since 1.8.0)
 * with a host theme of their own choosing, and assert the panel resolved to it.
 *
 * The theme values below are deliberately unlike every fallback in
 * `design-system.css`: a panel that ignored the host and painted its own
 * defaults would show `#1e1e1e`/`#d4d4d4` and fail.
 */

interface HostTheme {
  /** What VS Code puts on the document. */
  readonly editorBackground: string;
  readonly editorForeground: string;
  /** What the panel must compute to, as `getComputedStyle` reports it. */
  readonly expectedBackground: string;
  readonly expectedForeground: string;
}

const DARK_HOST: HostTheme = {
  editorBackground: '#101820',
  editorForeground: '#e8e6e3',
  expectedBackground: 'rgb(16, 24, 32)',
  expectedForeground: 'rgb(232, 230, 227)',
};

const LIGHT_HOST: HostTheme = {
  editorBackground: '#fdfcfa',
  editorForeground: '#1c1a17',
  expectedBackground: 'rgb(253, 252, 250)',
  expectedForeground: 'rgb(28, 26, 23)',
};

/**
 * Boot one module panel with orgs connected, under `theme` if given.
 *
 * The theme is set as inline custom properties on `<html>` before the app's
 * first paint, which is where VS Code puts them in a real webview. `null`
 * leaves the document bare, so the `design-system.css` fallbacks apply.
 */
async function openPanel(page: Page, moduleId: string, theme: HostTheme | null): Promise<void> {
  const bridge = new MockBridge();
  await bridge.setup(page);

  await page.addInitScript(
    ({ id, background, foreground }) => {
      (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
      if (background === null || foreground === null) {
        return;
      }
      const paint = (): void => {
        document.documentElement.style.setProperty('--vscode-editor-background', background);
        document.documentElement.style.setProperty('--vscode-editor-foreground', foreground);
      };
      // An init script can run before the document element exists.
      if (document.documentElement) {
        paint();
      } else {
        document.addEventListener('DOMContentLoaded', paint);
      }
    },
    {
      id: moduleId,
      background: theme?.editorBackground ?? null,
      foreground: theme?.editorForeground ?? null,
    },
  );

  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);

  // Wait on the module's own page, not on the shell: `panel-app` is present
  // even when the page inside it never renders, and a panel showing nothing is
  // not a panel whose theming was proven.
  await page.waitForSelector('[data-testid="forge-page"]');
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);
}

test.describe('VS Code theming', () => {
  test('dark host theme: the panel takes both its background and its text from it', async ({
    page,
  }) => {
    await openPanel(page, 'forge', DARK_HOST);

    const panel = page.getByTestId('panel-app');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('background-color', DARK_HOST.expectedBackground);
    await expect(panel).toHaveCSS('color', DARK_HOST.expectedForeground);
  });

  test('light host theme: the panel follows it, text included', async ({ page }) => {
    // The regression this exists for: a panel that inherits the light
    // background but keeps light-on-dark text is unreadable, and every check
    // that only looked at the background called it themed.
    await openPanel(page, 'forge', LIGHT_HOST);

    const panel = page.getByTestId('panel-app');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('background-color', LIGHT_HOST.expectedBackground);
    await expect(panel).toHaveCSS('color', LIGHT_HOST.expectedForeground);
  });

  test('no host theme: the panel still paints an opaque background', async ({ page }) => {
    // A webview that leaves its background transparent shows the editor
    // through itself. The fallbacks in design-system.css are what prevent it;
    // the exact hex is theirs to choose, but "not transparent" is not.
    await openPanel(page, 'forge', null);

    const { background, color } = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="panel-app"]') as HTMLElement;
      const computed = getComputedStyle(panel);
      return { background: computed.backgroundColor, color: computed.color };
    });

    expect(background).not.toBe('rgba(0, 0, 0, 0)');
    expect(background).not.toBe('transparent');
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
    expect(color).not.toBe(background);
  });
});
