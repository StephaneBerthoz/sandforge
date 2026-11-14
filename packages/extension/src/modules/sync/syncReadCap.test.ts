import { describe, expect, it } from 'vitest';
import {
  PANEL_READ_CUT_WORDS,
  SYNC_READ_CAP_DEFAULT,
  SYNC_READ_CAP_MAX,
  heavyReadAdvice,
  readCutRemedy,
  syncReadCapOf,
} from './syncReadCap.js';

describe('the bound a sync reads an object to', () => {
  it('reads 50 000 records unless the setting asks for fewer', () => {
    expect(syncReadCapOf(undefined)).toBe(SYNC_READ_CAP_DEFAULT);
    expect(SYNC_READ_CAP_DEFAULT).toBe(50_000);
    expect(syncReadCapOf(1_000)).toBe(1_000);
  });

  it('holds a hand-edited setting within the bounds a run holds', () => {
    expect(syncReadCapOf(900_000)).toBe(SYNC_READ_CAP_MAX);
    expect(syncReadCapOf(0)).toBe(1);
    expect(syncReadCapOf(-5)).toBe(1);
    expect(syncReadCapOf(1_234.9)).toBe(1_234);
    expect(syncReadCapOf('20000')).toBe(SYNC_READ_CAP_DEFAULT);
    expect(syncReadCapOf(Number.NaN)).toBe(SYNC_READ_CAP_DEFAULT);
  });
});

describe('what a read the bound cut short says to do', () => {
  it('offers to raise the setting below the most a run holds, then the slices and the sample', () => {
    const words = readCutRemedy('source', 1_000, PANEL_READ_CUT_WORDS);

    expect(words).toBe(
      'To copy the rest, raise the sandforge.sync.maxRecordsPerObject setting (50000 at most), ' +
        'or read it in slices: a filter on CreatedDate, one range per run. To copy a sample of ' +
        'the source that fits the target instead, use Forge, with Depth ALL and Records per ' +
        'object set to A sample that fits the target.',
    );
  });

  it('offers nothing to raise at the most a run holds', () => {
    const words = readCutRemedy('source', SYNC_READ_CAP_MAX, PANEL_READ_CUT_WORDS);

    expect(words).not.toContain('raise');
    expect(words).toContain('To copy the rest, read it in slices');
  });

  it('says, of the target of a bidirectional run, how to compare every record', () => {
    expect(readCutRemedy('target', 1_000, { raise: '--max-records-per-object', sample: 'x' })).toBe(
      "To compare every record, raise --max-records-per-object (50000 at most), or narrow the object's filter.",
    );
  });
});

describe('what gets a read Salesforce gave up on through', () => {
  it('names an indexed filter, a date range and View All Data for a timeout or a read too large', () => {
    for (const error of [
      'QUERY_TIMEOUT: Your query request was running for too long.',
      'OPERATION_TOO_LARGE: exceeded 100000 distinct ids',
    ]) {
      const advice = heavyReadAdvice(error);
      expect(advice).toContain('an indexed field');
      expect(advice).toContain('a narrower range of CreatedDate');
      expect(advice).toContain('View All Data');
    }
  });

  it('says nothing of another error, which another remedy answers', () => {
    expect(heavyReadAdvice('INVALID_FIELD: no such column')).toBe('');
  });
});
