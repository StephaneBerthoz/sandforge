import { describe, expect, it } from 'vitest';

import {
  refusalOfSummary,
  refusedLine,
  refusedSummary,
  refusedSummaryWords,
} from './runRefused.js';

const EMAILS = { code: 'EMAILS_NOT_ACCEPTED', message: 'TGT delivers every email.' };

describe('refusedLine', () => {
  it('names the code a CI job reads before the sentence', () => {
    expect(refusedLine(EMAILS)).toBe('refused (EMAILS_NOT_ACCEPTED): TGT delivers every email.');
  });
});

describe('refusedSummary', () => {
  it('says the run wrote nothing as a dry run does not: a real run, refused, its code apart', () => {
    expect(
      JSON.parse(
        refusedSummary(
          { tool: 'sandforge-clone', source: 'SRC', target: 'TGT', elapsedMs: 12 },
          EMAILS,
        ),
      ),
    ).toEqual({
      tool: 'sandforge-clone',
      source: 'SRC',
      target: 'TGT',
      dryRun: false,
      refused: EMAILS,
      elapsedMs: 12,
    });
  });

  it('leaves out the source of a run that reads none, and names what else refused it', () => {
    const automation = { code: 'AUTOMATION_NOT_ACCEPTED', message: 'What fires.' };

    const summary = JSON.parse(
      refusedSummary({ tool: 'sandforge-seed', target: 'TGT', elapsedMs: 1 }, automation, [EMAILS]),
    ) as Record<string, unknown>;

    expect(summary).not.toHaveProperty('source');
    expect(summary['refused']).toEqual(automation);
    expect(summary['alsoRefused']).toEqual([EMAILS]);
  });

  it('ends on a new line, as a summary a shell redirects', () => {
    expect(refusedSummary({ tool: 't', target: 'T', elapsedMs: 0 }, EMAILS).endsWith('}\n')).toBe(
      true,
    );
  });
});

describe('refusalOfSummary', () => {
  const saved = refusedSummary({ tool: 'sandforge-clone', target: 'TGT', elapsedMs: 4 }, EMAILS);

  it('reads the refusal of a refused run’s summary, saved as `--json` printed it', () => {
    expect(refusalOfSummary(JSON.parse(saved), 'sandforge-clone')).toEqual(EMAILS);
  });

  it('reads none of another command’s, of a dry run’s, nor of one that holds what a run did', () => {
    const summary = JSON.parse(saved) as Record<string, unknown>;

    expect(refusalOfSummary(summary, 'sandforge-seed')).toBeUndefined();
    expect(refusalOfSummary({ ...summary, dryRun: true }, 'sandforge-clone')).toBeUndefined();
    // A run that wrote never reads as one that wrote nothing, whatever else it names.
    expect(
      refusalOfSummary({ ...summary, result: { successCount: 3 } }, 'sandforge-clone'),
    ).toBeUndefined();
  });
});

describe('refusedSummaryWords', () => {
  it('says the run wrote nothing, its code named, and what there is nothing of to do', () => {
    expect(refusedSummaryWords(EMAILS, 'verify')).toBe(
      'is the summary of a run refused before its first write (EMAILS_NOT_ACCEPTED), which wrote ' +
        'nothing to the target: there is nothing of it to verify.',
    );
  });
});
