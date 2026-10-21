import { describe, it, expect } from 'vitest';
import { SYNC_CONFLICT_STRATEGIES } from './sync-conflict-strategies.js';
import { syncConflictStrategySchema } from '../schemas/sync-config.schema.js';

describe('the conflict strategies a sync run offers', () => {
  it('offers four, in the order the page lists them, and never the manual one', () => {
    expect(SYNC_CONFLICT_STRATEGIES).toEqual([
      'source_wins',
      'target_wins',
      'newest_wins',
      'merge',
    ]);
    expect(SYNC_CONFLICT_STRATEGIES).not.toContain('manual');
  });

  it('are the values the configuration schema accepts', () => {
    // The schema is built from the list, which the Sync page reads without
    // zod: scripts/check-webview-assets.mjs holds the page to that.
    expect(syncConflictStrategySchema.options).toEqual([...SYNC_CONFLICT_STRATEGIES]);
    expect(syncConflictStrategySchema.safeParse('manual').success).toBe(false);
  });
});
