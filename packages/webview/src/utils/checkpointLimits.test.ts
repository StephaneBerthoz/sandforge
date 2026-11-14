import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_OBJECT_ROWS_MAX } from './checkpointLimits';

describe('CHECKPOINT_OBJECT_ROWS_MAX', () => {
  it('is the most records the take reads of one object', () => {
    const take = readFileSync(
      join(__dirname, '../../../extension/src/modules/checkpoint/takeCheckpoint.ts'),
      'utf8',
    );
    expect(take).toContain('export const OBJECT_ROWS_MAX = 1_000_000;');
    expect(CHECKPOINT_OBJECT_ROWS_MAX).toBe(1_000_000);
  });
});
