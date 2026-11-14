import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { ForgeWholeOrgSample } from './ForgeWholeOrgSample';
import { wholeOrgSample, wholeOrgSampleOfTheRoots } from './testing/wholeOrg';

/** What the simulation drew, as its results draw it, the source `prod` into `dev`. */
function renderSample(over: Parameters<typeof wholeOrgSample>[0] = {}): void {
  render(<ForgeWholeOrgSample sample={wholeOrgSample(over)} source="prod" target="dev" />);
}

/** The text of the line `id`. */
function line(id: string): string {
  return screen.getByTestId(`forge-whole-org-sample-${id}`).textContent ?? '';
}

/*
 * A simulation of a sample says, before anything is written, what it drew
 * and how: the share of each object's roots, what it takes of the target and
 * what held it there, what it keeps of each object and how each record came
 * in, and every record it reached and leaves out, with why.
 */
describe('ForgeWholeOrgSample', () => {
  it('says what it keeps of the source, how it drew it, and what it takes of the target', () => {
    renderSample();

    expect(line('kept')).toBe(
      '1,812 of 9,400 records of prod, from 3 objects: 0.41 % of the roots of each object, seed 1, spread over the org, with the records they reach.',
    );
    expect(line('taken')).toBe(
      'About 3.1 MB of the 3.2 MB the sample may take (80 % of the 4.5 MB left, 0.5 MB off for rounding, 0.1 MB for what the target’s automation creates), held by the data storage dev has left.',
    );
  });

  it('says the draw of the newest first, and the objects whose newest are read by their ids', () => {
    renderSample({ draw: 'recent', newestByIds: ['Region__c'] });

    expect(line('kept')).toContain('seed 1, the newest first,');
    expect(line('newest-by-ids')).toBe(
      'Newest by the order of their ids, having no creation date the org sorts by: Region__c.',
    );
  });

  it('says the MB asked held it, and recommends every record when the whole org fits', () => {
    renderSample({
      budget: { bytes: 2_097_152, withinMB: 2, limitedBy: 'within' },
    });
    expect(line('taken')).toBe(
      'About 3.1 MB of the 2 MB the sample may take (the 2 MB asked), held by the MB asked.',
    );

    renderSample({
      budget: {
        bytes: 335_544_320,
        remainingMB: 400,
        maxMB: 1_024,
        share: 0.8,
        roundingMB: 0.5,
        limitedBy: 'whole',
      },
    });
    expect(screen.getAllByTestId('forge-whole-org-sample-taken')[1].textContent).toBe(
      'About 3.1 MB of the 320 MB the sample may take (80 % of the 400 MB left, 0.5 MB off for rounding). Every record fits: copying the whole org is the better run.',
    );
  });

  it('says the records set aside held it when every other root fits, never that every record does', () => {
    renderSample({
      share: 1,
      budget: {
        bytes: 335_544_320,
        remainingMB: 400,
        maxMB: 1_024,
        share: 0.8,
        roundingMB: 0.5,
        limitedBy: 'heavyRoots',
      },
    });

    expect(line('taken')).toBe(
      'About 3.1 MB of the 320 MB the sample may take (80 % of the 400 MB left, 0.5 MB off for rounding), held by the records set aside below, each past a tenth of the room dev has: every other root fits.',
    );
    expect(line('taken')).not.toContain('Every record fits');
    expect(line('heavy-roots')).toContain('Account 001000000000001AAA');
  });

  it('lists what it keeps of each object, and how each record came in', () => {
    renderSample();

    const rows = within(screen.getByTestId('forge-whole-org-sample-objects'))
      .getAllByRole('row')
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Object', 'In the source', 'Kept', 'Drawn', 'Under a parent', 'As a parent'],
      ['Opportunity', '900', '900', 'whole', '', ''],
      ['Account', '1,200', '712', '500', '0', '212'],
      ['Contact', '4,800', '200', '12', '180', '8'],
    ]);
  });

  it('names the objects copied whole and why, and the children the cap left out', () => {
    renderSample();

    expect(line('whole')).toBe(
      'Copied whole: Opportunity (an object of few records that drawn records name).',
    );
    expect(line('children-cut')).toBe(
      'Children past 100 per record and relation, the newest kept, left out: Contact.AccountId (1,340).',
    );
  });

  it('says the objects none of whose records it keeps apart, never as empty', () => {
    renderSample();

    expect(line('no-record-drawn')).toBe(
      'Objects of prod none of whose records the sample keeps: Lead (2,500 in the source).',
    );
  });

  it('names the records set aside by id, and what each would have brought in, past a tenth of the target’s room', () => {
    renderSample();

    // Weighed against the room the target has, not the MB the sample may
    // take: a smaller sample of the same target sets aside the same roots.
    expect(line('heavy-roots')).toBe(
      'Records set aside, each of which would have brought in more than a tenth of the room dev has: Account 001000000000001AAA (about 4,100 records through Contact.AccountId).',
    );
  });

  it('says each record it reached and leaves out, and why, and the lookups it writes empty', () => {
    renderSample();

    expect(line('dropped')).toBe(
      'Records the draw reached and leaves out, never sent: 6 of Contact, a record they cannot be written without is not in the source; 3 of Account, the target has none of their record type.',
    );
    expect(line('left-empty')).toBe(
      'Lookups written empty, their record outside the sample: Contact.ReportsToId (14).',
    );
  });

  // Run for real on a whole org: opportunities copied whole kept 3 of their
  // 4 line items, drawn as roots, and each amount came to the lines written,
  // which Simulate never said.
  it('names the masters that keep part of their details, what they sum of them counting the details written', () => {
    renderSample({
      partialMasters: [
        {
          objectApiName: 'Opportunity',
          details: 'OpportunityLineItem',
          field: 'OpportunityId',
          kept: 3,
          sourceRows: 4,
        },
        { objectApiName: 'Invoice__c', details: 'Line__c', field: 'Invoice__c', asParents: 12 },
      ],
    });

    expect(line('partial-masters')).toBe(
      'Masters that keep part of their details: Opportunity, copied whole: 3 of the 4 OpportunityLineItem records (OpportunityLineItem.OpportunityId); 12 Invoice__c records brought in as parents, with only the Line__c records drawn on their own (Line__c.Invoice__c). If such a master totals them, as an opportunity’s amount or a roll-up summary does, that total counts only the details written.',
    );
  });

  it('says what drawing it sent the source, and where its plan is kept for the run', () => {
    renderSample();

    expect(line('requests')).toBe('Drawing it sent 61 API requests to prod.');
    expect(line('plan')).toBe(
      'The plan is kept on this machine for a day: /storage/forge-samples/3f9a/plan (SHA-256 9f86d081884c…). Execute Forge takes it up while the run is set up the same; otherwise the run draws again, and says why.',
    );
  });

  it('says nothing of what it did not meet', () => {
    renderSample({
      heavyRoots: [],
      dropped: [],
      leftEmpty: [],
      noRecordDrawn: [],
      whole: [],
      objects: wholeOrgSample().objects.map((object) => {
        const kept = { ...object };
        delete kept.childrenCut;
        return kept;
      }),
    });

    for (const id of [
      'heavy-roots',
      'dropped',
      'left-empty',
      'no-record-drawn',
      'whole',
      'partial-masters',
      'roots',
      'in-the-draw',
      'no-root-in-the-draw',
      'not-windowed',
      'oldest-by-ids',
      'strata',
    ]) {
      expect(screen.queryByTestId(`forge-whole-org-sample-${id}`), id).toBeNull();
    }
    expect(screen.queryByTestId('forge-whole-org-sample-children-cut')).toBeNull();
  });
});

/*
 * A sample drawn among chosen roots says how they were chosen, its share of
 * the roots in the draw rather than of the source, each object's roots in
 * the draw against the source's, the objects the window left no root or
 * could not date, each stratum's values, and that the draw held it: never
 * that the whole org fits.
 */
describe('ForgeWholeOrgSample, of roots chosen', () => {
  function renderChosen(over: Parameters<typeof wholeOrgSampleOfTheRoots>[0] = {}): void {
    render(
      <ForgeWholeOrgSample sample={wholeOrgSampleOfTheRoots(over)} source="prod" target="dev" />,
    );
  }

  it('says its share of the roots in the draw, the oldest first, and how the roots were chosen', () => {
    renderChosen();

    expect(line('kept')).toBe(
      '1,812 of 9,400 records of prod, from 3 objects: 100 % of the roots in the draw of each object, seed 1, the oldest first, with the records they reach.',
    );
    expect(line('roots')).toBe(
      "How the roots were chosen: roots made from Jan 1, 2025, 12:00 AM UTC to before Jul 1, 2025, 12:00 AM UTC; Account where BillingCountry = 'France'; Account stratified by RecordTypeId; Contact stratified by HasOptedOutOfEmail.",
    );
    expect(line('in-the-draw')).toBe(
      'Roots in the draw, of the roots of the source: Account 500 of 1,100; Contact 12.',
    );
  });

  it('says the draw held it, to be widened, never that every record fits', () => {
    renderChosen();

    expect(line('taken')).toContain(
      'held by the draw: every root of the window and the filters of the roots is in it — widen them to take more.',
    );
    expect(line('taken')).not.toContain('Every record fits');
  });

  it('says apart the objects with no root in the draw, those it cannot date, and those read by their ids', () => {
    renderChosen();

    expect(line('no-root-in-the-draw')).toBe(
      'Objects of prod with no root in the window or the filters of the roots, none of their records kept: Lead (2,500 in the source).',
    );
    // Not said as an object of which the sample merely keeps nothing.
    expect(screen.queryByTestId('forge-whole-org-sample-no-record-drawn')).toBeNull();
    expect(line('not-windowed')).toBe(
      'Objects without CreatedDate, which have no root in the window: Task.',
    );
    expect(line('oldest-by-ids')).toBe(
      'Oldest by the order of their ids, having no creation date the org sorts by: Campaign.',
    );
  });

  it('lists each stratum’s values in a table, a record type by its name, an empty value and a checkbox in words', () => {
    renderChosen();

    const table = within(screen.getByTestId('forge-whole-org-sample-strata')).getByRole('table', {
      name: 'The strata: the roots of each value, and those kept',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Field', 'Value', 'Roots', 'Kept']);
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Account.RecordTypeId', 'Business', '400', '400'],
      ['Account.RecordTypeId', '(empty)', '100', '100'],
      ['Account.RecordTypeId', '3 more values, not listed'],
      ['Contact.HasOptedOutOfEmail', 'checked', '2', '2'],
      ['Contact.HasOptedOutOfEmail', 'unchecked', '10', '10'],
    ]);
    expect(within(table).getAllByRole('rowheader')[0].getAttribute('scope')).toBe('row');
    expect(screen.getByTestId('forge-whole-org-sample-strata-under').textContent).toBe(
      'Records under the roots are not stratified.',
    );
  });

  it('says its share of every root when strata alone chose them', () => {
    renderChosen({
      roots: { strata: wholeOrgSampleOfTheRoots().roots?.strata },
      share: 0.5,
    });

    expect(line('kept')).toContain('50 % of the roots of each object');
  });
});
