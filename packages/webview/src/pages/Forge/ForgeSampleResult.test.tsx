import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { ForgeSampleResult } from './ForgeSampleResult';
import { wholeOrgSampleResult } from './testing/wholeOrg';

/** What a run of a sample wrote, as its results draw it, the source `prod`. */
function renderResult(over: Parameters<typeof wholeOrgSampleResult>[0] = {}): void {
  render(<ForgeSampleResult sample={wholeOrgSampleResult(over)} source="prod" />);
}

/** The lines said of each object, in order. */
function objectLines(): string[] {
  return within(screen.getByTestId('forge-sample-result-objects'))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

/*
 * A run of a sample says what it wrote of each object against what its plan
 * kept, how each record came in, and of what the source held; a record gone
 * from the source since the plan is said apart, and is no failure; one held
 * back for a record it needs that changed since the plan is a failure.
 */
describe('ForgeSampleResult', () => {
  it('says how the sample was drawn and the plan it wrote', () => {
    renderResult();

    expect(screen.getByTestId('forge-sample-result-drawn').textContent).toMatch(
      /^Drawn with seed 1, spread over the org: 0\.41 % of the roots of each object\. Plan SHA-256 9f86d081884c…, drawn on .+\.$/,
    );
  });

  it('says of each object what was written of what the sample kept, how it came in, and of what the source held', () => {
    renderResult();

    expect(objectLines()).toEqual([
      'Opportunity: 900 written of 900 in the sample (copied whole) of 900 in prod.',
      'Account: 712 written of 712 in the sample (500 drawn, 212 as parents) of 1,200 in prod.',
      'Contact: 194 written of 200 in the sample (12 drawn, 180 under a parent, 8 as parents) of 4,800 in prod. 4 gone from prod since the sample: not written, and no failure. 2 held back: a record they cannot be written without changed since the sample.',
    ]);
  });

  it('says every record of the plan was written when it was, and what is short when not', () => {
    renderResult({
      objects: wholeOrgSampleResult().objects.map((object) => ({
        ...object,
        written: object.kept,
        goneSinceTheSample: 0,
        changedSinceTheSample: 0,
      })),
    });
    expect(screen.getByTestId('forge-sample-result-verdict').textContent).toBe(
      'Every record of the sample was written or linked.',
    );
  });

  it('says every record still in the source was written when some were gone from it since', () => {
    renderResult({
      objects: wholeOrgSampleResult().objects.map((object) => ({
        ...object,
        written: object.kept - object.goneSinceTheSample,
        changedSinceTheSample: 0,
      })),
    });

    expect(screen.getByTestId('forge-sample-result-verdict').textContent).toBe(
      'Every record of the sample still in prod was written or linked. 4 were gone from prod since the sample: no failure.',
    );
  });

  it('counts the failures of records that changed apart from those gone from the source', () => {
    renderResult();

    expect(screen.getByTestId('forge-sample-result-verdict').textContent).toBe(
      '2 records of the sample were held back: a record they cannot be written without changed since the sample. 4 were gone from prod since the sample: no failure.',
    );
  });

  it('says the records of the sample a failure left unwritten', () => {
    const [opportunity, account, contact] = wholeOrgSampleResult().objects;
    renderResult({
      objects: [
        opportunity,
        { ...account, written: 700 },
        { ...contact, goneSinceTheSample: 0, changedSinceTheSample: 0, written: 200 },
      ],
    });

    expect(screen.getByTestId('forge-sample-result-verdict').textContent).toBe(
      '12 records of the sample were not written: the errors below say why.',
    );
  });

  it('says the lookups written empty, their record outside the sample', () => {
    renderResult();

    expect(screen.getByTestId('forge-sample-result-left-empty').textContent).toBe(
      'Lookups written empty, their record outside the sample: Contact.ReportsToId (14).',
    );
    renderResult({ leftEmpty: undefined });
    expect(screen.getAllByTestId('forge-sample-result-left-empty')).toHaveLength(1);
  });
});
