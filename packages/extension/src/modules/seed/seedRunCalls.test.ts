import { describe, it, expect } from 'vitest';
import { seedWriterCalls } from './seedRunCalls';
import type { SeedRunRecorder } from './SeedRunCreations';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** A recorder writing down what it is told, in order. */
function recorder(): Pick<SeedRunRecorder, 'sending' | 'answered'> & { told: string[] } {
  const told: string[] = [];
  return {
    told,
    sending: (object, rows, call) =>
      told.push(
        `sending ${object} ${rows}${call?.job ? ` job ${call.job}` : ''}${call?.upsert ? ' upsert' : ''}`,
      ),
    answered: (object, ids) => told.push(`answered ${object} ${ids.join(',')}`),
  };
}

describe('seedWriterCalls', () => {
  it('keeps each insert call before it goes, its job once opened, and every row it wrote once it answers', () => {
    const kept = recorder();
    const counted: number[] = [];
    const calls = seedWriterCalls(kept, (count) => counted.push(count));

    calls.sending('Contact', 'insert', 2);
    calls.opened?.('Contact', 'insert', 2, fakeId('750', 1));
    calls.answered('Contact', 'insert', [
      { success: true, id: fakeId('003', 1), errors: [] },
      { success: false, errors: ['REQUIRED_FIELD_MISSING'] },
    ]);

    expect(kept.told).toEqual([
      'sending Contact 2',
      `sending Contact 2 job ${fakeId('750', 1)}`,
      `answered Contact ${fakeId('003', 1)}`,
    ]);
    expect(counted).toEqual([1]);
  });

  it('keeps of an upsert the rows the org created, never one it wrote over', () => {
    const kept = recorder();
    const calls = seedWriterCalls(kept);

    calls.sending('Account', 'upsert', 2);
    calls.answered('Account', 'upsert', [
      { success: true, id: fakeId('001', 1), created: false, errors: [] },
      { success: true, id: fakeId('001', 2), created: true, errors: [] },
    ]);

    expect(kept.told).toEqual(['sending Account 2 upsert', `answered Account ${fakeId('001', 2)}`]);
  });

  it('keeps nothing of an update or a delete, which create nothing the run owns', () => {
    const kept = recorder();
    const calls = seedWriterCalls(kept);

    calls.sending('EventRelation', 'update', 3);
    calls.opened?.('EventRelation', 'update', 3, fakeId('750', 2));
    calls.answered('EventRelation', 'update', [
      { success: true, id: fakeId('0RE', 1), errors: [] },
    ]);
    calls.sending('Account', 'delete', 1);

    expect(kept.told).toEqual([]);
  });
});
