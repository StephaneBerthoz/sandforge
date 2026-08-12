import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock } from './mocks/vscode-api';

test.describe('Responsive layout', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
  });

  test('renders correctly at desktop viewport (1280x720)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    const homePage = page.getByTestId('home-page');
    await expect(homePage).toBeVisible();
  });

  test('renders correctly at large desktop viewport (1920x1080)', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByTestId('forge-hero-card')).toBeVisible();
  });

  test('renders correctly at narrow viewport (800x600)', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    // App shell should still be visible
    await expect(page.getByTestId('panel-app')).toBeVisible();

    // Content should still be accessible
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('sidebar and content area coexist at medium viewport (1024x768)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const sidebar = page.getByTestId('sidebar');
    const main = page.locator('main#main-content');

    await expect(sidebar).toBeVisible();
    await expect(main).toBeVisible();

    // Both should be within the viewport
    const sidebarBox = await sidebar.boundingBox();
    const mainBox = await main.boundingBox();

    expect(sidebarBox).toBeTruthy();
    expect(mainBox).toBeTruthy();

    // Sidebar should be to the left of main content
    if (sidebarBox && mainBox) {
      expect(sidebarBox.x).toBeLessThan(mainBox.x);
    }
  });

  test('sidebar can be collapsed via keyboard shortcut (Ctrl+B)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const sidebar = page.getByTestId('sidebar');

    // Get initial width
    const initialBox = await sidebar.boundingBox();
    expect(initialBox).toBeTruthy();

    // Press Ctrl+B to toggle sidebar
    await page.keyboard.press('Control+b');

    // Wait for transition
    await page.waitForTimeout(300);

    // Sidebar should still exist but have different width
    const collapsedBox = await sidebar.boundingBox();
    expect(collapsedBox).toBeTruthy();

    if (initialBox && collapsedBox) {
      expect(collapsedBox.width).not.toBe(initialBox.width);
    }
  });

  test('app shell fills the entire viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const shell = page.getByTestId('panel-app');
    const box = await shell.boundingBox();

    expect(box).toBeTruthy();
    if (box) {
      expect(box.width).toBe(1280);
      expect(box.height).toBe(720);
    }
  });

  test('content area is scrollable when content overflows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    const main = page.locator('main#main-content');
    const overflow = await main.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.overflowY;
    });

    expect(overflow).toBe('auto');
  });
});
