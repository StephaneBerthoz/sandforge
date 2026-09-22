import { describe, it, expect, vi } from 'vitest';
import { ScopedDossierHealthChecker } from './ScopedDossierHealthChecker.js';

describe('ScopedDossierHealthChecker', () => {
  it('is healthy when the dossier holds a record of every expected object', async () => {
    const measure = vi.fn(async () => ({ Opportunity: 1, OpportunityLineItem: 3 }));
    const checker = new ScopedDossierHealthChecker(measure, ['OpportunityLineItem']);

    expect(await checker.check('006000000000001AAA')).toEqual({ healthy: true });
    // Measured on that one root: the verdict is about this dossier.
    expect(measure).toHaveBeenCalledWith(['006000000000001AAA']);
  });

  it('tells two candidates of the same object apart', async () => {
    // What the graph-based check could not do: its graph was the schema's,
    // identical for every candidate, so every candidate got one verdict.
    const measure = vi.fn(
      async ([id]: string[]): Promise<Record<string, number>> =>
        id === 'withLines' ? { Opportunity: 1, OpportunityLineItem: 2 } : { Opportunity: 1 },
    );
    const checker = new ScopedDossierHealthChecker(measure, ['OpportunityLineItem']);

    expect((await checker.check('withLines')).healthy).toBe(true);
    expect(await checker.check('bare')).toEqual({
      healthy: false,
      reason: 'no OpportunityLineItem record in this dossier',
    });
  });

  it('reads zero records the same as an object the extraction never reached', async () => {
    const checker = new ScopedDossierHealthChecker(
      async () => ({ Opportunity: 1, Quote: 0 }),
      ['Quote'],
    );
    expect((await checker.check('id')).healthy).toBe(false);
  });

  it('is healthy with no expected object at all', async () => {
    const checker = new ScopedDossierHealthChecker(async () => ({ Opportunity: 1 }), []);
    expect((await checker.check('id')).healthy).toBe(true);
  });

  it('is lame, not crashed, when the extraction throws', async () => {
    const checker = new ScopedDossierHealthChecker(async () => {
      throw new Error('INVALID_FIELD');
    }, []);
    expect(await checker.check('id')).toEqual({
      healthy: false,
      reason: 'extraction failed: INVALID_FIELD',
    });
  });
});
