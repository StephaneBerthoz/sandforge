import { test, expect, type Page } from '@playwright/test';
import { injectVSCodeApiMock, sendExtensionMessage } from './mocks/vscode-api';
import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Layout behaviour across panel widths.
 *
 * The two viewport-fidelity tests boot a real module panel the way the
 * extension does (`__SANDFORGE_MODULE__`), because there has been no in-app
 * navigation sidebar since 1.8.0 — the shell they used to measure is gone.
 * What they measured through it (does the layout survive a resize) is still
 * the webview's main exposure: a VS Code panel is dragged narrower and wider
 * all day long, so these assert the two failure modes a resize produces —
 * content spilling past the right edge, and content stranded in a narrow
 * column when the panel is maximised.
 *
 * Two former tests are gone rather than rewritten: "sidebar and content area
 * coexist" and "sidebar can be collapsed via Ctrl+B" measured the geometry
 * and the keyboard toggle of that deleted sidebar. There is no surviving
 * behaviour to point them at — a single full-width `main` cannot sit to the
 * left of itself, and Ctrl+B toggles nothing the webview owns.
 */

/** Viewport of a full-width VS Code editor panel on a 1080p display. */
const DESKTOP = { width: 1280, height: 720 };

/** Viewport of the same panel maximised on a 1440p/4K display. */
const LARGE_DESKTOP = { width: 1920, height: 1080 };

/**
 * Health payload for the Home KPI row, minimal but internally consistent:
 * one of the two limits is over the 60% warning threshold
 * (`useOrgHealthSummary.LIMIT_WARNING_THRESHOLD`), so the fourth card renders
 * a real figure instead of its loading skeleton.
 */
const MOCK_HEALTH = {
  healthScore: 85,
  limits: [
    { name: 'DailyApiRequests', max: 100_000, remaining: 45_000, usedPercent: 55 },
    { name: 'DataStorageMB', max: 5_120, remaining: 1_024, usedPercent: 80 },
  ],
};

/**
 * Answer *every* pending request of a type, not just the first.
 *
 * React StrictMode mounts effects twice in dev, and `useBridgeQuery` sends one
 * message per hook instance — Home holds its own `org:list` alongside
 * BridgeProvider's. Answering only the last leaves a live query hanging and
 * the page stuck on `home-loading`.
 */
async function respondToAll(
  page: Page,
  requestType: string,
  responseType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const ids = await page.evaluate((type) => {
    const msgs = (window as unknown as Record<string, unknown[]>).__SANDFORGE_MESSAGES__ ?? [];
    return msgs
      .map((m) => {
        const e = m as Record<string, unknown>;
        return (e.payload as Record<string, unknown> | undefined) ?? e;
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

/**
 * Boot the Home panel at `viewport`, orgs connected and health answered.
 *
 * Home is the panel worth measuring: it is the one that reacts to width (a
 * wrapping KPI row over a `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` bento
 * grid), so a layout regression shows up here first. The viewport is set
 * before `goto` so the first paint is the one under test.
 */
async function openHomeAt(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);

  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'home';
  });
  await page.goto('/');

  await bridge.waitForMessage('org:list', { timeout: 10_000 });
  await respondToAll(page, 'org:list', 'org:list:response', { orgs: MOCK_ORGS });

  // Selecting an org unblocks the health query the fourth KPI card waits on.
  await bridge.waitForMessage('monitor:refresh', { timeout: 10_000 });
  await respondToAll(page, 'monitor:refresh', 'monitor:data', MOCK_HEALTH);

  await page.waitForSelector('[data-testid="home-page"]');
  await page.waitForSelector('[data-testid="home-kpi-row"]');
  await page.waitForSelector('[data-testid="forge-hero-card"]');
}

/** Widths of the scrolling panel and of the content it holds. */
interface OverflowMetrics {
  /** Width the panel offers its content. */
  clientWidth: number;
  /** Width the content actually takes. Larger means a horizontal scrollbar. */
  scrollWidth: number;
  /** Same pair for the document, catching content that escapes the panel. */
  documentClientWidth: number;
  documentScrollWidth: number;
}

/** Measure the panel and the document for horizontal spill. */
async function measureOverflow(page: Page): Promise<OverflowMetrics> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="panel-app"]') as HTMLElement;
    return {
      clientWidth: panel.clientWidth,
      scrollWidth: panel.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

/** Number of tracks the bento grid resolves to at the current width. */
async function bentoColumnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-testid="bento-grid"]') as HTMLElement;
    return window.getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  });
}

/** Bounding boxes of every direct child of the KPI row. */
async function kpiCardBoxes(page: Page): Promise<Array<{ top: number; right: number }>> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="home-kpi-row"]') as HTMLElement;
    return Array.from(row.children).map((child) => {
      const box = child.getBoundingClientRect();
      return { top: Math.round(box.top), right: box.right };
    });
  });
}

test.describe('Responsive layout', () => {
  test('renders correctly at desktop viewport (1280x720)', async ({ page }) => {
    await openHomeAt(page, DESKTOP);

    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByTestId('forge-hero-card')).toBeVisible();

    // Nothing spills past the right edge: no horizontal scrollbar on the
    // panel, and nothing escaping it onto the document.
    const overflow = await measureOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.documentClientWidth);

    // The bento grid is past the lg breakpoint here, so it lays out three
    // columns rather than the stacked mobile form.
    expect(await bentoColumnCount(page)).toBe(3);

    // The four KPI cards fit on one row and stay inside the panel.
    const cards = await kpiCardBoxes(page);
    expect(cards).toHaveLength(4);
    expect(new Set(cards.map((c) => c.top)).size).toBe(1);
    for (const card of cards) {
      expect(card.right).toBeLessThanOrEqual(overflow.clientWidth);
    }

    // Every tile is fully inside the panel — no clipped right-hand column.
    const tiles = page.getByTestId('bento-tile');
    const tileCount = await tiles.count();
    expect(tileCount).toBeGreaterThan(0);
    for (let i = 0; i < tileCount; i++) {
      const box = await tiles.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });

  test('renders correctly at large desktop viewport (1920x1080)', async ({ page }) => {
    await openHomeAt(page, LARGE_DESKTOP);

    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.getByTestId('forge-hero-card')).toBeVisible();

    const overflow = await measureOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.documentClientWidth);

    // Still three columns — the grid caps at lg, it does not keep splitting.
    expect(await bentoColumnCount(page)).toBe(3);

    // The extra 640px are used, not stranded: the panel is full-bleed, so the
    // grid spans the panel minus its p-4 gutters. A layout that capped the
    // content at a centred column would leave a third of a 1920 panel empty.
    const gridBox = await page.getByTestId('bento-grid').boundingBox();
    expect(gridBox).toBeTruthy();
    expect(gridBox!.width).toBeGreaterThan(overflow.clientWidth - 40);

    // The KPI row still reads as one row of four at this width.
    const cards = await kpiCardBoxes(page);
    expect(cards).toHaveLength(4);
    expect(new Set(cards.map((c) => c.top)).size).toBe(1);
    for (const card of cards) {
      expect(card.right).toBeLessThanOrEqual(overflow.clientWidth);
    }
  });

  test('renders correctly at narrow viewport (800x600)', async ({ page }) => {
    await injectVSCodeApiMock(page);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="panel-app"]');

    // App shell should still be visible
    await expect(page.getByTestId('panel-app')).toBeVisible();

    // Content should still be accessible
    await expect(page.getByTestId('home-page')).toBeVisible();
  });

  test('app shell fills the entire viewport', async ({ page }) => {
    await injectVSCodeApiMock(page);
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
    await injectVSCodeApiMock(page);
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
