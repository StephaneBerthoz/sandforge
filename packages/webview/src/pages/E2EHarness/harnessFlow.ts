/**
 * E2E harness gate — query-param parsing for the Playwright harness.
 *
 * Kept in its own dependency-free module so `App.tsx` can statically import
 * the gate while the (heavy) harness component itself is lazy-loaded and
 * tree-shaken out of the production bundle.
 */

export type Flow = 'seed-ai' | 'sync-conflict' | 'monitor' | 'cdc' | 'ai-diagnose';

/** Read the ?e2e-harness=<flow> query param. Returns null when absent. */
export function getHarnessFlow(search: string): Flow | null {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('e2e-harness');
    if (
      raw === 'seed-ai' ||
      raw === 'sync-conflict' ||
      raw === 'monitor' ||
      raw === 'cdc' ||
      raw === 'ai-diagnose'
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}
