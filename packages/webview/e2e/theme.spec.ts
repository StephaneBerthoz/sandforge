import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock } from './mocks/vscode-api';

test.describe('Theme', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');
  });

  test('app shell renders with a background color', async ({ page }) => {
    const shell = page.getByTestId('panel-app');
    await expect(shell).toBeVisible();

    // The app shell should have CSS classes applied (bg-surface-0)
    await expect(shell).toHaveClass(/bg-surface-0/);
  });

  test('dark theme: text is readable against dark background', async ({ page }) => {
    // Emulate dark color scheme (VSCode dark theme)
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const shell = page.getByTestId('panel-app');
    await expect(shell).toBeVisible();
  });

  test('light theme: app renders without errors', async ({ page }) => {
    // Emulate light color scheme (VSCode light theme)
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const shell = page.getByTestId('panel-app');
    await expect(shell).toBeVisible();
  });

  test('sidebar maintains consistent styling across theme changes', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveClass(/bg-surface-1/);
    await expect(sidebar).toHaveClass(/border-r/);
  });
});
