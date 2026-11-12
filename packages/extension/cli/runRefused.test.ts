import { describe, expect, it } from 'vitest';

import {
  refusalOfSummary,
  refusedLine,
  refusedRemovalSummary,
  refusedSummary,
  refusedSummaryWords,
  wouldBeRefusedJson,
  wouldBeRefusedLine,
} from './runRefused.js';

const EMAILS = { code: 'EMAILS_NOT_ACCEPTED', message: 'TGT delivers every email.' };

describe('refusedLine', () => {
  it('names the code a CI job reads before the sentence', () => {
    expect(refusedLine(EMAILS)).toBe('refused (EMAILS_NOT_ACCEPTED): TGT delivers every email.');
  });
});

describe('wouldBeRefusedLine', () => {
  it('names the code a real run is refused with, as a rewind’s dry run names its own', () => {
    expect(wouldBeRefusedLine(EMAILS)).toBe(
      'a real run would be refused (EMAILS_NOT_ACCEPTED): TGT delivers every email.',
    );
    expect(wouldBeRefusedLine(EMAILS, 'a load')).toBe(
      'a load would be refused (EMAILS_NOT_ACCEPTED): TGT delivers every email.',
    );
  });
});

describe('wouldBeRefusedJson', () => {
  it('keeps the words where scripts read them, and gives each code beside, in their order', () => {
    const storage = { code: 'SEED_STORAGE_EXCEEDED', message: 'The records do not fit.' };

    expect(wouldBeRefusedJson([storage, EMAILS])).toEqual({
      wouldBeRefused: ['The records do not fit.', 'TGT delivers every email.'],
      wouldBeRefusedCodes: ['SEED_STORAGE_EXCEEDED', 'EMAILS_NOT_ACCEPTED'],
    });
  });

  it('gives nothing when a real run would go', () => {
    expect(wouldBeRefusedJson([])).toEqual({});
  });
});

describe('refusedRemovalSummary', () => {
  it('names the removal and its code, and reads as no run’s summary given back to --remove', () => {
    const mute = {
      code: 'MUTE_NO_RIGHT',
      message: 'The user cannot assign. Nothing was assigned.',
    };

    const answer = JSON.parse(
      refusedRemovalSummary(
        { tool: 'sandforge-seed', summary: 'seed.json', target: 'TGT', elapsedMs: 5 },
        mute,
      ),
    ) as Record<string, unknown>;

    expect(answer).toEqual({
      tool: 'sandforge-seed',
      action: 'remove',
      summary: 'seed.json',
      target: 'TGT',
      refused: mute,
      elapsedMs: 5,
    });
    expect(refusalOfSummary(answer, 'sandforge-seed')).toBeUndefined();
  });

  it('names a preview refused before it read a record as the preview', () => {
    const other = { code: 'OTHER_ORG', message: 'TGT is not the org the run wrote to.' };

    expect(
      JSON.parse(
        refusedRemovalSummary(
          {
            tool: 'sandforge-clone',
            action: 'remove-preview',
            summary: 'clone.json',
            target: 'TGT',
            elapsedMs: 3,
          },
          other,
        ),
      ),
    ).toEqual({
      tool: 'sandforge-clone',
      action: 'remove-preview',
      summary: 'clone.json',
      target: 'TGT',
      refused: other,
      elapsedMs: 3,
    });
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
