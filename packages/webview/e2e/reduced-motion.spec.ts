import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MockBridge } from './helpers';

/**
 * The OS setting that asks for less motion, as the panel's style sheet takes
 * it, read from the styles Chromium computes for the page as drawn.
 *
 * The rule cut every transition to 0.01ms and left `transition-property`
 * alone: an element under `transition-all` still ran a transition, one frame
 * long, on every property it changed — a change of state still drawn as a
 * movement, which the setting asks not to see. Nothing in the panel waits for
 * a transition to end (`transitionend`), so none has to run.
 */

/** Home, as the extension boots it, its motion as the OS sets it. */
async function openHome(page: Page, reducedMotion: 'reduce' | 'no-preference'): Promise<void> {
  await page.emulateMedia({ reducedMotion });
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = 'home';
  });
  await page.goto('/');
  await page.waitForSelector('[data-testid="home-page"]');
}

/**
 * The transition each element of the page drawn with a transition utility
 * computes to, and that of a bar drawn as the panel's progress bar is
 * (`transition-all duration-300`), which Home does not draw itself.
 */
async function transitionsOfThePage(page: Page): Promise<{
  drawn: Array<{ property: string; duration: string }>;
  bar: { property: string; duration: string };
}> {
  return page.evaluate(() => {
    const of = (element: Element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, duration: style.transitionDuration };
    };
    const drawn = Array.from(document.querySelectorAll('[class*="transition"]')).map(of);
    const bar = document.createElement('div');
    bar.className = 'h-full rounded-full bg-forge transition-all duration-300';
    document.body.append(bar);
    return { drawn, bar: of(bar) };
  });
}

test.describe('the OS setting to reduce motion', () => {
  test('lets the panel move as drawn when it is off, a transition of every property among them', async ({
    page,
  }) => {
    await openHome(page, 'no-preference');

    const { drawn, bar } = await transitionsOfThePage(page);

    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter(({ property }) => property === 'none')).toEqual([]);
    expect(bar).toEqual({ property: 'all', duration: '0.3s' });
  });

  test('runs no transition at all when it is on, not even one frame long', async ({ page }) => {
    await openHome(page, 'reduce');

    const { drawn, bar } = await transitionsOfThePage(page);

    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter(({ property }) => property !== 'none')).toEqual([]);
    expect(bar.property).toBe('none');
  });
});
