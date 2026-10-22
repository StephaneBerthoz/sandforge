import { describe, expect, it } from 'vitest';
import { undeletableAnswer } from './undeletableAnswer.js';

describe('undeletableAnswer', () => {
  const objects = [{ objectApiName: 'Account', records: 12 }];

  it('stops the removal before its first delete, naming the objects and the flag that goes on', async () => {
    const lines: string[] = [];

    expect(await undeletableAnswer(false, 'DEV', (line) => lines.push(line))(objects)).toBe(false);
    expect(lines).toEqual([
      'The user SandForge connects as may not delete the records of Account (12 records) in DEV.',
      'Nothing was removed. Give that user Delete on those objects, or run again with ' +
        '--leave-undeletable to remove the rest and leave them.',
    ]);
  });

  it('removes the rest with --leave-undeletable, and says what stays', async () => {
    const lines: string[] = [];

    expect(await undeletableAnswer(true, 'DEV', (line) => lines.push(line))(objects)).toBe(true);
    expect(lines[1]).toBe(
      'Those stay, with the records they hang from; the rest is removed (--leave-undeletable).',
    );
  });
});
