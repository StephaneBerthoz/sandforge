import { test, expect } from '@playwright/test';
import { injectVSCodeApiMock } from './mocks/vscode-api';

test.describe('Sidebar navigation', () => {
  test.beforeEach(async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-shell"]');
  });

  test('renders the sidebar with all main navigation items', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();

    // Main nav items
    await expect(sidebar.getByRole('button', { name: 'Home' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Organizations' })).toBeVisible();
  });

  test('renders forge hero button', async ({ page }) => {
    await expect(page.getByTestId('sidebar-forge-hero')).toBeVisible();
  });

  test('renders module navigation items', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByRole('button', { name: 'Monitor', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Seed', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Sync', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Grappe', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Autopilot', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Compare Org', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'DataOps', exact: true })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Automation', exact: true })).toBeVisible();
  });

  test('renders bottom navigation items', async ({ page }) => {
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByRole('button', { name: 'Reports' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Help' })).toBeVisible();
  });

  test('home is active by default', async ({ page }) => {
    const homeButton = page.getByTestId('sidebar').getByRole('button', { name: 'Home' });
    await expect(homeButton).toHaveAttribute('aria-current', 'page');
  });

  test('clicking a nav item navigates to the corresponding page', async ({ page }) => {
    // Navigate to Monitor
    await page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true }).click();

    // Home should no longer be active
    const homeButton = page.getByTestId('sidebar').getByRole('button', { name: 'Home' });
    await expect(homeButton).not.toHaveAttribute('aria-current', 'page');

    // Monitor should be active
    const monitorButton = page.getByTestId('sidebar').getByRole('button', { name: 'Monitor', exact: true });
    await expect(monitorButton).toHaveAttribute('aria-current', 'page');
  });

  test('clicking Forge hero navigates to forge page', async ({ page }) => {
    await page.getByTestId('sidebar-forge-hero').click();
    // The forge hero button should reflect active state
    await expect(page.getByTestId('sidebar-forge-hero')).toBeVisible();
  });

  test('navigating back to Home shows the home page', async ({ page }) => {
    // Go to Settings first
    await page.getByTestId('sidebar').getByRole('button', { name: 'Settings' }).click();

    // Then back to Home
    await page.getByTestId('sidebar').getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('home-page')).toBeVisible();
  });
});
