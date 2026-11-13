import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { ForgeWholeOrgDryRunResult } from './ForgeWholeOrgDryRun';
import { wholeOrgDryRun } from './testing/wholeOrg';

/** The result as the results screen draws it, the source `prod` into `uat`. */
function renderDry(over: Parameters<typeof wholeOrgDryRun>[0] = {}): void {
  render(
    <ForgeWholeOrgDryRunResult
      dry={wholeOrgDryRun(over)}
      source="prod"
      target="uat"
      checkpointAsked={false}
    />,
  );
}

/*
 * The dry run of a clone of the whole org stops at its gate, reading past the
 * counts only what they cannot tell and writing nothing: what it says there
 * is all the page has to decide on a run that can write millions of records
 * into an org.
 */
describe('ForgeWholeOrgDryRunResult', () => {
  it('says it stopped at the gate, and what the run would write and how long it would take', () => {
    renderDry();

    const panel = screen.getByTestId('forge-whole-org-dry-run');
    expect(panel.textContent).toContain('Dry run of the whole org');
    // It said no row was read past the counts, where it reads the ids of the
    // records the run would hold back or leave aside, and more.
    expect(panel.textContent).toContain(
      'past the counts, only the ids of the records the run would hold back or leave aside ' +
        'and of the contact roles the platform writes itself were read, with the size of the ' +
        'emails and files, and nothing was written to either org.',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-records').textContent).toBe(
      '9,400 records to write into uat, of 4 objects, in about 1h 6min.',
    );
  });

  it('names every refusal the run would meet, each in the words of its own stop', () => {
    renderDry();

    const verdict = screen.getByTestId('forge-whole-org-dry-run-verdict');
    expect(verdict.textContent).toContain('The run would be refused, for 2 reasons:');
    const refusals = within(screen.getByTestId('forge-whole-org-dry-run-refusals')).getAllByRole(
      'listitem',
    );
    expect(refusals.map((item) => item.textContent)).toEqual([
      'The run was refused before it wrote anything: its Bulk API jobs would take about 16,000 batches of the target org, which has 2,000 left over the last 24 hours. Run it once the org has more to spare.',
      'The run was refused before it wrote anything: reading the source org would take about 120,000 of its API requests, and it has 4,000 left today. Run it once the org has more to spare, or leave objects out on Review.',
    ]);
  });

  it('says a refusal the page has no words for in the host’s own', () => {
    renderDry({
      wouldBeRefused: [{ code: 'MAX_TOTAL_EXCEEDED', message: 'Over the total the run allows.' }],
    });

    expect(screen.getByTestId('forge-whole-org-dry-run-refusals').textContent).toBe(
      'Over the total the run allows.',
    );
  });

  it('says the records the run holds back with their parent and those it leaves aside, its parent not in the source', () => {
    const dry = wholeOrgDryRun();
    renderDry({
      leftOut: {
        ...dry.leftOut,
        rows: {
          writtenBefore: 0,
          heldBack: [{ objectApiName: 'Opportunity', rows: 1 }],
          withoutParent: [{ objectApiName: 'OpportunityLineItem', rows: 4 }],
          noParentInSource: [{ objectApiName: 'PricebookEntry', rows: 34 }],
        },
      },
    });

    expect(screen.getByTestId('forge-whole-org-dry-run-held-under').textContent).toBe(
      '4 records of OpportunityLineItem, under records held back that they cannot be written without',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-left-aside').textContent).toBe(
      '34 records of PricebookEntry: a lookup they may not leave empty names a record the source does not hold, so no copy can write them',
    );
  });

  it('says the records the run holds back for a record type the target has none of, apart from those closed to its user', () => {
    // Live, an opportunity of a record type the target lacked was counted to
    // write, sent with the source's id and refused, and the dry run had said
    // nothing of it.
    const dry = wholeOrgDryRun();
    renderDry({
      leftOut: {
        ...dry.leftOut,
        rows: {
          writtenBefore: 0,
          heldBack: [{ objectApiName: 'Opportunity', rows: 1 }],
          recordTypeNotInTarget: [{ objectApiName: 'Opportunity', rows: 1 }],
        },
      },
    });

    expect(screen.getByTestId('forge-whole-org-dry-run-type-not-in-target').textContent).toBe(
      '1 record of Opportunity, whose record type the target has none of, which it would refuse',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-held-back').textContent).toBe(
      '1 record of Opportunity, whose record type is closed to the user the run writes as',
    );
  });

  it('says the run would go through when nothing refuses it', () => {
    renderDry({ wouldBeRefused: [] });

    expect(screen.getByTestId('forge-whole-org-dry-run-verdict').textContent).toBe(
      'The run would go through its gate: Execute still asks you first, saying what it writes and takes.',
    );
    expect(screen.queryByTestId('forge-whole-org-dry-run-refusals')).toBeNull();
  });

  it('weighs the requests, the batches and the storage of both orgs against what each has left', () => {
    renderDry();

    expect(screen.getByTestId('forge-whole-org-dry-run-target-requests').textContent).toBe(
      'about 140, of 92,000 left today out of 100,000',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-source-requests').textContent).toBe(
      'about 120,000, past the 4,000 left today out of 150,000',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-bulk-batches').textContent).toBe(
      'about 16,000, past the 2,000 left today out of 15,000',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-storage').textContent).toBe(
      'about 18.8 MB, of 800 MB left out of 1,024 MB',
    );
    expect(screen.getByText('API requests of uat, the target')).toBeDefined();
    expect(screen.getByText('API requests of prod, the source')).toBeDefined();
  });

  it('says what an org would not tell, rather than a figure', () => {
    renderDry({
      sourceRequests: { verdict: 'unread', estimate: 300, unread: 'INVALID_SESSION_ID' },
    });

    expect(screen.getByTestId('forge-whole-org-dry-run-source-requests').textContent).toBe(
      'about 300; what is left could not be read: INVALID_SESSION_ID',
    );
  });

  it('says the files are not copied unless asked, and weighs them when they are', () => {
    renderDry();
    expect(screen.getByTestId('forge-whole-org-dry-run-files').textContent).toBe(
      'none: the copy of files is off',
    );
  });

  it('weighs the files asked for against the file storage left', () => {
    renderDry({
      files: {
        count: 40,
        check: { verdict: 'near', estimateMB: 300, maxMB: 2_000, remainingMB: 350 },
      },
    });

    expect(screen.getByTestId('forge-whole-org-dry-run-files').textContent).toBe(
      '40 files: about 300 MB, of 350 MB left out of 2,000 MB: more than 80 % of what is left',
    );
  });

  it('counts what it leaves out by why, and the personal fields it copies as they are', () => {
    renderDry();

    expect(screen.getByTestId('forge-whole-org-dry-run-left-out').textContent).toContain(
      '6 objects of the source:',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-left-out').textContent).toContain(
      'Chatter feeds (1)',
    );
    expect(screen.getByTestId('forge-whole-org-dry-run-personal').textContent).toBe(
      '5 fields, on Account, Contact, Lead',
    );
  });

  it('lists what it would write of each object, in jobs and by REST, in a region the keyboard scrolls', () => {
    renderDry();

    const region = screen.getByTestId('forge-whole-org-dry-run-objects');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
    const rows = within(region).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'Contact4,80010',
      'Lead2,50010',
      'Account1,20001,200',
      'Opportunity9000900',
    ]);
  });
});
