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
 * Run an axe-core WCAG 2.1 AA scan on the current page.
 * Returns the full AxeResults for assertion in tests.
 */
export async function checkAccessibility(
  page: Page,
  options?: AccessibilityCheckOptions,
): Promise<AxeResults> {
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
      const nodes = v.nodes.map((n) => `  - ${n.html.substring(0, 120)}`).join('\n');
      return `[${v.impact}] ${v.id}: ${v.description}\n${nodes}`;
    })
    .join('\n\n');
}
