/**
 * Reusable axe-core accessibility scanning helper for E2E tests.
 * Uses @axe-core/playwright to run WCAG 2.1 AA automated checks.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';

/** Options for the accessibility check. */
export interface AccessibilityCheckOptions {
  /** CSS selectors to exclude from the scan. */
  exclude?: string[];
  /** axe-core rule IDs to disable. */
  disableRules?: string[];
}

/**
 * Wait until nothing on the page is still moving.
 *
 * Colour contrast is measured on what is painted at the instant of the scan, and
 * a panel fading in paints its text at part opacity: a step of the Autopilot
 * wizard read 1.45:1 mid-transition. CSS animations and the ones framer-motion
 * hands to the browser show up in `getAnimations()`; the ones it drives frame by
 * frame write inline styles, so those are sampled until two reads agree.
 * Animations that never end (a spinner) are not waited for.
 */
export async function waitForStillness(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== 'running' ||
            animation.effect?.getComputedTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 5_000 },
  );
  await page.waitForFunction(
    () => {
      const holder = window as unknown as { __sfStyleSample?: string };
      const sample = Array.from(document.querySelectorAll<HTMLElement>('[style]'))
        .map((element) => `${element.style.opacity}|${element.style.transform}`)
        .join(';');
      const still = holder.__sfStyleSample === sample;
      holder.__sfStyleSample = sample;
      return still;
    },
    undefined,
    { polling: 100, timeout: 5_000 },
  );
}

/**
 * Run an axe-core WCAG 2.1 AA scan on the current page, once it is still.
 * Returns the full AxeResults for assertion in tests.
 */
export async function checkAccessibility(
  page: Page,
  options?: AccessibilityCheckOptions,
): Promise<AxeResults> {
  await waitForStillness(page);
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (options?.exclude) {
    for (const selector of options.exclude) {
      builder = builder.exclude(selector);
    }
  }
  if (options?.disableRules) {
    builder = builder.disableRules(options.disableRules);
  }
  return builder.analyze();
}

/**
 * Format axe violations into a readable string for test failure messages.
 */
export function formatViolations(violations: AxeResults['violations']): string {
  return violations
    .map((v) => {
      // For colour contrast, the check's own message carries the measured colours
      // and ratio, which the element's markup alone does not.
      const nodes = v.nodes
        .map((n) => {
          const detail = n.any[0]?.message ?? '';
          return `  - ${n.html.substring(0, 120)}${detail ? `\n    ${detail}` : ''}`;
        })
        .join('\n');
      return `[${v.impact}] ${v.id}: ${v.description}\n${nodes}`;
    })
    .join('\n\n');
}
