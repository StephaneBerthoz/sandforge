import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRefusal } from './runRefused.js';
import { RELAYED_BY_VARIABLE } from './scriptRunner.js';
import { undeletableAnswer, undeletableRefusal } from './undeletableAnswer.js';

describe('undeletableAnswer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const objects = [{ objectApiName: 'Account', records: 12 }];

  it('stops the removal before its first delete, handing on the refusal under its code, naming the objects and the flag that goes on', async () => {
    const lines: string[] = [];
    const refusals: RunRefusal[] = [];

    expect(
      await undeletableAnswer(
        false,
        'DEV',
        (refusal) => refusals.push(refusal),
        (line) => lines.push(line),
      )(objects),
    ).toBe(false);
    // Said by the command that ends on it, its code on its line.
    expect(lines).toEqual([]);
    expect(refusals).toEqual([
      {
        code: 'UNDELETABLE_NOT_LEFT',
        message:
          'The user SandForge connects as may not delete the records of Account (12 records) in ' +
          'DEV. Nothing was removed. Give that user Delete on those objects, or run again with ' +
          '--leave-undeletable to remove the rest and leave them.',
      },
    ]);
  });

  it('removes the rest with --leave-undeletable, says what stays, and refuses nothing', async () => {
    const lines: string[] = [];
    const refusals: RunRefusal[] = [];

    expect(
      await undeletableAnswer(
        true,
        'DEV',
        (refusal) => refusals.push(refusal),
        (line) => lines.push(line),
      )(objects),
    ).toBe(true);
    expect(lines).toEqual([
      'The user SandForge connects as may not delete the records of Account (12 records) in DEV.',
      'Those stay, with the records they hang from; the rest is removed (--leave-undeletable).',
    ]);
    expect(refusals).toEqual([]);
  });

  it('sends the reader of a command that does not take the flag to this script’s own removal', () => {
    // Relayed by sandforge-env, "run again with --leave-undeletable" named a
    // flag the destroy refused, exit 2.
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge-env');
    expect(undeletableRefusal(objects, 'DEV').message).toContain(
      "or run this script's own removal with --leave-undeletable to remove the rest and leave " +
        'them.',
    );
    // The MCP server's run_remove takes it: leaveUndeletable.
    vi.stubEnv(RELAYED_BY_VARIABLE, 'sandforge-mcp');
    expect(undeletableRefusal(objects, 'DEV').message).toContain(
      'or run again with --leave-undeletable to remove the rest and leave them.',
    );
  });

  it('names every object it is refused for', () => {
    expect(
      undeletableRefusal(
        [
          { objectApiName: 'Account', records: 2 },
          { objectApiName: 'Case', records: 1 },
        ],
        'DEV',
      ).message,
    ).toContain('the records of Account (2 records), Case (1 records) in DEV.');
  });
});
