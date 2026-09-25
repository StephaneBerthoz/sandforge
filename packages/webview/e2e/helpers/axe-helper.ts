/**
 * Reusable axe-core accessibility scanning helper for E2E tests.
 * Uses @axe-core/playwright to run WCAG 2.1 AA automated checks.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * What a scan returns, as `@axe-core/playwright` types it. The type used to be
 * imported from `axe-core`, which is that package's dependency and not the
 * webview's: the import resolved nowhere, every result was typed `any`, and
 * nothing that read one was checked.
 */
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

/** Options for the accessibility check. */
export interface AccessibilityCheckOptions {
  /** CSS selectors to exclude from the scan. */
  exclude?: string[];
  /** axe-core rule IDs to disable. */
  disableRules?: string[];
}

/**
 * Frames the page has to paint in a row with nothing moving before it is taken
 * as still. framer-motion starts a panel's entrance from an effect, a frame or
 * two after the one that put the panel on screen: one quiet frame says nothing
 * of the next.
 */
const STILL_FRAMES = 5;

/** How many waits this worker has made, so a wait never counts the frames of the one before. */
let stillnessWaits = 0;

/**
 * Wait until nothing on the page is still moving: until it has painted
 * {@link STILL_FRAMES} frames in a row with no animation running and no inline
 * style changing.
 *
 * Colour contrast is measured on what is painted at the instant of the scan, and
 * a panel fading in paints its text at part opacity: a step of the Autopilot
 * wizard read 1.45:1 mid-transition. CSS animations and the ones framer-motion
 * hands to the browser show up in `getAnimations()`; the ones it drives frame by
 * frame write inline styles. Both are read on every frame.
 *
 * The animations used to be read once, before the styles were sampled every
 * 100 ms, and under load a fade began after that one read. What framer-motion
 * hands to the browser writes no inline style, so two samples agreed while it
 * ran: the Forge results were scanned with their cards at 0.64 opacity, and
 * their labels read 4.21:1. Frames are counted rather than milliseconds, so a
 * page slowed down by load is given the frames it needs to start what it has
 * to show. Animations that never end (a spinner) are not waited for.
 */
export async function waitForStillness(page: Page): Promise<void> {
  stillnessWaits += 1;
  await page.waitForFunction(
    ({ wait, frames }) => {
      const holder = window as unknown as {
        __sfStillness?: { wait: number; sample: string; still: number };
      };
      const moving = document
        .getAnimations()
        .some(
          (animation) =>
            (animation.playState === 'running' || animation.pending) &&
            animation.effect?.getComputedTiming().iterations !== Infinity,
        );
      const sample = Array.from(document.querySelectorAll<HTMLElement>('[style]'))
        .map((element) => `${element.style.opacity}|${element.style.transform}`)
        .join(';');
      const last = holder.__sfStillness;
      const still = !moving && last?.wait === wait && last.sample === sample ? last.still + 1 : 0;
      holder.__sfStillness = { wait, sample, still };
      return still >= frames;
    },
    { wait: stillnessWaits, frames: STILL_FRAMES },
    { polling: 'raf', timeout: 5_000 },
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
