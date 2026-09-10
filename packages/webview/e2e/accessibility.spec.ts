import { test, expect, type Page } from '@playwright/test';

import { MockBridge } from './helpers';
import { MOCK_ORGS } from './fixtures';

/**
 * Structural accessibility of a module panel.
 *
 * These checks used to drive the in-app navigation sidebar — its `<nav>`
 * wrapper, its `aria-current` item, arrow/tab travel between its items, its
 * collapsible "quick actions" group. That shell was deleted in 1.8.0: the
 * extension opens each module as its own full-width `WebviewPanel`, so
 * `data-testid="sidebar"` is rendered by no source file and the four checks
 * that named it had no subject left. Three are gone; what they really
 * guarded — a keyboard user can traverse the panel, and a disclosure control
 * announces its state — is re-asserted below against surfaces that exist.
 *
 * Panels boot the way `screenshots.spec.ts` boots them and the way the
 * extension does: `__SANDFORGE_MODULE__` before `page.goto`, orgs seeded over
 * the mock bridge, then a wait on the *page* testid rather than a shell one.
 *
 * `axe-accessibility.spec.ts` runs the automated WCAG rule set over the same
 * pages. This file deliberately covers what axe cannot: focus order, the
 * behaviour of the skip link, and state that only changes on interaction.
 */

/** Boot the app straight into one module panel, orgs already connected. */
async function openModule(page: Page, moduleId: string, pageTestId: string): Promise<MockBridge> {
  const bridge = new MockBridge();
  await bridge.setup(page);
  await page.addInitScript((id) => {
    (window as unknown as Record<string, unknown>).__SANDFORGE_MODULE__ = id;
  }, moduleId);
  await page.goto('/');
  await bridge.seedOrgs(MOCK_ORGS);
  await page.waitForSelector(`[data-testid="${pageTestId}"]`, { timeout: 10_000 });
  return bridge;
}

/** Identify the focused element for a focus-order assertion. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'BODY';
    return el.getAttribute('data-testid') ?? `<${el.tagName.toLowerCase()}>`;
  });
}

test.describe('Accessibility — panel structure', () => {
  test('the panel body is the page single <main> landmark', async ({ page }) => {
    await openModule(page, 'home', 'home-page');

    const main = page.locator('main#main-content');
    await expect(main).toBeVisible();
    await expect(main).toHaveAttribute('data-testid', 'panel-app');

    // One landmark, not several: a screen reader's "jump to main" must be
    // unambiguous. And it has to be programmatically focusable (tabIndex -1)
    // or the skip link below has nothing to hand focus to.
    await expect(page.locator('main')).toHaveCount(1);
    await expect(main).toHaveAttribute('tabindex', '-1');
  });

  test('the skip link is the first tab stop and moves focus into main', async ({ page }) => {
    await openModule(page, 'home', 'home-page');

    const skipLink = page.locator('a[href="#main-content"]');
    await expect(skipLink).toBeAttached();

    // Visually hidden until focused, so the very first Tab must reach it —
    // that is the whole point of a bypass-blocks link (WCAG 2.4.1).
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    // Activating it must actually move focus, not just scroll.
    await page.keyboard.press('Enter');
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(focusedId).toBe('main-content');
  });

  test('tab order walks the panel controls in visual order', async ({ page }) => {
    await openModule(page, 'home', 'home-page');
    await page.waitForSelector('[data-testid="start-forge-btn"]');

    // Walk from the top of the document and record where focus lands. The
    // record input and the button that consumes it sit side by side in the
    // Forge hero card; a keyboard user must meet them in that order.
    const stops: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      stops.push(await focusedName(page));
      if (stops.includes('start-forge-btn')) break;
    }

    const trail = stops.join(' → ');
    expect(stops[0], `first tab stop: ${trail}`).toBe('<a>');

    const inputIndex = stops.indexOf('forge-record-input');
    const buttonIndex = stops.indexOf('start-forge-btn');
    expect(inputIndex, `record input never received focus: ${trail}`).toBeGreaterThanOrEqual(0);
    expect(buttonIndex, `start button never received focus: ${trail}`).toBeGreaterThan(inputIndex);
  });
});

test.describe('Accessibility — controls', () => {
  test('collapsible sections expose and update aria-expanded', async ({ page }) => {
    await openModule(page, 'help', 'help-page');

    // Help is the panel that still ships a disclosure pattern: one accordion
    // section is open on arrival, and the toggle owns the region it controls.
    const toggle = page.getByTestId('help-section-getting-started').getByRole('button').first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const controlledId = await toggle.getAttribute('aria-controls');
    expect(controlledId).toBe('help-content-getting-started');
    await expect(page.locator(`#${controlledId}`)).toBeVisible();

    // The attribute must track the actual state, in both directions.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`#${controlledId}`)).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#${controlledId}`)).toBeVisible();
  });

  test('every visible button on the panel has an accessible name', async ({ page }) => {
    await openModule(page, 'home', 'home-page');
    await page.waitForSelector('[data-testid="start-forge-btn"]');

    const scan = await page.evaluate(() => {
      /** Accessible name, in the order the accname spec resolves it. */
      const nameOf = (el: Element): string => {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const referenced = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .trim();
          if (referenced) return referenced;
        }
        const label = el.getAttribute('aria-label')?.trim();
        if (label) return label;
        const text = el.textContent?.trim();
        if (text) return text;
        return el.getAttribute('title')?.trim() ?? '';
      };

      const visible = Array.from(document.querySelectorAll('button')).filter(
        (el) => el.getClientRects().length > 0,
      );
      return {
        total: visible.length,
        unnamed: visible.filter((el) => nameOf(el) === '').map((el) => el.outerHTML.slice(0, 160)),
      };
    });

    // Guard the guard: a scan that found no buttons would pass while checking
    // nothing. Home renders the hero CTA plus the quick-action grid.
    expect(scan.total).toBeGreaterThan(4);
    expect(scan.unnamed, `buttons with no accessible name:\n${scan.unnamed.join('\n')}`).toEqual(
      [],
    );
  });

  test('the hero record input is labelled and hints at its format', async ({ page }) => {
    await openModule(page, 'home', 'home-page');

    const input = page.getByTestId('forge-record-input');
    await expect(input).toBeVisible();

    // A placeholder is a hint, never a label — the input needs both, and the
    // original check only ever looked at the placeholder.
    const label = (await input.getAttribute('aria-label')) ?? '';
    expect(label.length).toBeGreaterThan(0);

    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    expect(placeholder.length).toBeGreaterThan(0);
  });
});
