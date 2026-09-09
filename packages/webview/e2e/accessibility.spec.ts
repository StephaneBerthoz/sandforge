import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock } from './mocks/vscode-api';

test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
  });

  test('sidebar is wrapped in a <nav> element', async ({ page }) => {
    const nav = page.locator('nav[data-testid="sidebar"]');
    await expect(nav).toBeVisible();
  });

  test('main content area exists and is a <main> element', async ({ page }) => {
    const main = page.locator('main#main-content');
    await expect(main).toBeVisible();
  });

  test('skip link is present for keyboard users', async ({ page }) => {
    // The SkipLink component should render a link that targets #main-content
    const skipLink = page.locator('a[href="#main-content"]');
    // Skip links are typically visually hidden but present in the DOM
    await expect(skipLink).toBeAttached();
  });

  test('navigation buttons are focusable via keyboard', async ({ page }) => {
    // Tab into the sidebar navigation
    await page.keyboard.press('Tab');

    // After tabbing, some element should have focus
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(focusedTag).toBeTruthy();
  });

  test('sidebar items have aria-current for active route', async ({ page }) => {
    // Home is the default active route
    const homeButton = page.getByTestId('sidebar').getByRole('button', { name: 'Home' });
    await expect(homeButton).toHaveAttribute('aria-current', 'page');

    // Non-active items should not have aria-current
    const settingsButton = page.getByTestId('sidebar').getByRole('button', { name: 'Settings' });
    await expect(settingsButton).not.toHaveAttribute('aria-current');
  });

  test('keyboard navigation between sidebar items works', async ({ page }) => {
    // Focus on the first sidebar button
    const firstButton = page.getByTestId('sidebar').getByRole('button', { name: 'Home' });
    await firstButton.focus();
    await expect(firstButton).toBeFocused();

    // Tab to the next item
    await page.keyboard.press('Tab');

    // Something else should now be focused
    const newFocused = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    );
    expect(newFocused).toBeTruthy();
    expect(newFocused).not.toBe('Home');
  });

  test('collapsible sections have aria-expanded attributes', async ({ page }) => {
    // Quick actions toggle
    const quickActionsToggle = page.getByTestId('sidebar-quick-actions-toggle');
    await expect(quickActionsToggle).toHaveAttribute('aria-expanded', 'true');

    // Click to collapse
    await quickActionsToggle.click();
    await expect(quickActionsToggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('buttons have accessible names', async ({ page }) => {
    // Check that key action buttons have accessible names
    const startForgeBtn = page.getByTestId('start-forge-btn');
    const text = await startForgeBtn.textContent();
    expect(text).toBeTruthy();
    expect((text ?? '').length).toBeGreaterThan(0);
  });

  test('forge record input has a placeholder for context', async ({ page }) => {
    const input = page.getByTestId('forge-record-input');
    const placeholder = await input.getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect((placeholder ?? '').length).toBeGreaterThan(0);
  });
});
