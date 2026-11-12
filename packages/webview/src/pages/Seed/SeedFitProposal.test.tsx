import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { SeedFitProposal } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import {
  SeedFitProposalCard,
  SeedFitResultLine,
  fittedRunOf,
  isSeedFitProposal,
  useSeedFitRefusal,
} from './SeedFitProposal';

/**
 * Sales Cloud Starter refused on a Developer Edition that says it has all of
 * its 5 MB left, its accounts' follow-up flow creating a Task under each and
 * an Apex trigger on them: the proposal the extension's fit computes for it.
 */
function salesCloudOnADeveloperEdition(overrides: Partial<SeedFitProposal> = {}): SeedFitProposal {
  return {
    share: 0.226,
    budget: {
      budgetMB: 3.37929630279541,
      remainingMB: 5,
      maxMB: 5,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
      automationMB: 0.220703125,
      notCounted: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' }],
    },
    objects: [
      { objectApiName: 'Product2', before: 50, after: 11 },
      { objectApiName: 'PricebookEntry', before: 50, after: 11 },
      { objectApiName: 'Account', before: 500, after: 113 },
      { objectApiName: 'Contact', before: 1000, after: 226 },
      { objectApiName: 'Opportunity', before: 2000, after: 452 },
      { objectApiName: 'OpportunityLineItem', before: 4000, after: 904 },
    ],
    estimateMB: 3.57421875,
    ...overrides,
  };
}

/** The CRM starter refused on an org that says it has nothing left: nothing fits. */
const NOTHING_FITS: SeedFitProposal = {
  share: 0.04,
  budget: {
    budgetMB: 0,
    remainingMB: 0,
    maxMB: 5,
    share: 0.8,
    roundingMB: 0.5,
    limitedBy: 'storage',
    automationMB: 0,
  },
  objects: [
    { objectApiName: 'Account', before: 25, after: 1 },
    { objectApiName: 'Contact', before: 75, after: 3 },
  ],
  estimateMB: 0.025390625,
  cannotFit:
    'the least it can be cut to — one Account and what follows it, 13 records — takes 0.03 MB, past the 0 MB that fit',
};

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('isSeedFitProposal', () => {
  it('takes the proposal the extension computes', () => {
    expect(isSeedFitProposal(salesCloudOnADeveloperEdition())).toBe(true);
    expect(isSeedFitProposal(NOTHING_FITS)).toBe(true);
    expect(
      isSeedFitProposal(
        salesCloudOnADeveloperEdition({
          automationUnread: 'INVALID_SESSION_ID',
          objects: [{ objectApiName: 'Case', before: 40, after: 40, keptWhole: 'rows' }],
        }),
      ),
    ).toBe(true);
  });

  it('leaves unshown what another version sends, rather than show it in part', () => {
    const proposal = salesCloudOnADeveloperEdition();
    for (const value of [
      undefined,
      null,
      [],
      { ...proposal, share: 0 },
      { ...proposal, share: 1.2 },
      { ...proposal, objects: [] },
      { ...proposal, objects: [{ objectApiName: 'Account', before: 500 }] },
      { ...proposal, objects: [{ objectApiName: 'Account', before: 500, after: 1.5 }] },
      { ...proposal, budget: { ...proposal.budget, limitedBy: 'caps' } },
      { ...proposal, budget: { ...proposal.budget, automationMB: undefined } },
      {
        ...proposal,
        budget: { ...proposal.budget, notCounted: [{ objectApiName: 'Account', kind: 'flow' }] },
      },
      { ...proposal, automationUnread: 3 },
    ]) {
      expect(isSeedFitProposal(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('fittedRunOf', () => {
  it('gives each object its count, the records it sets out to write and those the template held', () => {
    expect(fittedRunOf(salesCloudOnADeveloperEdition())).toEqual({
      counts: {
        Product2: 11,
        PricebookEntry: 11,
        Account: 113,
        Contact: 226,
        Opportunity: 452,
        OpportunityLineItem: 904,
      },
      records: 1717,
      fit: { share: 0.226, before: 7600 },
    });
  });

  it('says the bound asked, and never seeds more of an object than the template asked for', () => {
    const fitted = fittedRunOf(
      salesCloudOnADeveloperEdition({
        budget: { ...salesCloudOnADeveloperEdition().budget, withinMB: 3, limitedBy: 'within' },
        objects: [{ objectApiName: 'Account', before: 10, after: 12 }],
      }),
    );
    expect(fitted).toEqual({
      counts: { Account: 10 },
      records: 10,
      fit: { share: 0.226, before: 10, withinMB: 3 },
    });
  });
});

describe('SeedFitProposalCard', () => {
  it('shows the share, the bound and its terms, the room kept, what it leaves out, each count and the total', () => {
    const onSeed = vi.fn();
    render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition()}
        org="my-dev-org"
        onSeed={onSeed}
      />,
    );

    const card = screen.getByRole('region', { name: 'What fits in my-dev-org' });
    expect(within(card).getByTestId('seed-fit-share').textContent).toContain(
      'The largest share of every count that fits: 22.6%.',
    );
    expect(within(card).getByTestId('seed-fit-bound').textContent).toContain(
      '3.6 MB fit: 80% of the 5 MB my-dev-org says it has left of 5 MB, once 0.5 MB is set aside for the rounding of what it says.',
    );
    expect(within(card).getByTestId('seed-fit-room').textContent).toContain(
      '0.23 MB of it is kept for what the flows of my-dev-org that still run create under these records.',
    );
    expect(within(card).getByTestId('seed-fit-not-counted').textContent).toContain(
      'Not counted: what the Apex trigger AccountTrigger on Account creates.',
    );
    const rows = within(within(card).getByRole('table')).getAllByRole('row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'ObjectAskedFits',
      'Product25011',
      'PricebookEntry5011',
      'Account500113',
      'Contact1,000226',
      'Opportunity2,000452',
      'OpportunityLineItem4,000904',
    ]);
    expect(within(card).getByTestId('seed-fit-total').textContent).toContain(
      '1,717 of 7,600 records, about 3.58 MB with what the flows create under them.',
    );
    expect(within(card).getByTestId('seed-fit-counted').textContent).toContain(
      'my-dev-org counts a load in what it says it has left up to about a minute after it',
    );

    fireEvent.click(within(card).getByRole('button', { name: 'Seed these counts' }));
    expect(onSeed).toHaveBeenCalledTimes(1);
    // The wizard has a Back of its own: no second way back here.
    expect(within(card).queryByRole('button', { name: 'Change the counts' })).toBeNull();
  });

  it('says a share rounded down: never more than was kept', () => {
    render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({ share: 0.2269 })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-share').textContent).toContain('fits: 22.6%.');
  });

  it('says no room was kept when the automation could not be read, never that none of it creates', () => {
    // A proposal with 0 MB of room says either; only the extension knows which.
    const { rerender } = render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({
          automationUnread: 'INVALID_SESSION_ID',
          budget: { ...salesCloudOnADeveloperEdition().budget, automationMB: 0, notCounted: [] },
        })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-room').textContent).toContain(
      'No room is kept for what the automation of my-dev-org creates: it could not be read (INVALID_SESSION_ID).',
    );
    expect(screen.getByTestId('seed-fit-total').textContent).toContain(
      '1,717 of 7,600 records, about 3.58 MB.',
    );
    expect(screen.queryByTestId('seed-fit-not-counted')).toBeNull();

    rerender(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({
          budget: { ...salesCloudOnADeveloperEdition().budget, automationMB: 0 },
        })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-room').textContent).toContain(
      'Nothing is kept for the flows of my-dev-org: none of those that still run creates records under these.',
    );
  });

  it('names the API requests as what held it when they did, and the most asked when that did', () => {
    const base = salesCloudOnADeveloperEdition().budget;
    const { rerender } = render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({ budget: { ...base, limitedBy: 'apiRequests' } })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-bound').textContent).toContain(
      "Today's API requests held it: the writes of these records leave my-dev-org a tenth of its daily requests.",
    );
    rerender(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({
          budget: { ...base, limitedBy: 'within', withinMB: 3, budgetMB: 2.78, automationMB: 0.22 },
        })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-bound').textContent).toContain(
      '3 MB fit: the most asked of this seed.',
    );
  });

  it('marks the counts kept whole, and names a flow it could not read in quotes', () => {
    render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition({
          budget: {
            ...salesCloudOnADeveloperEdition().budget,
            notCounted: [
              { objectApiName: 'Contact', kind: 'notRead', name: 'Welcome Email' },
              { objectApiName: 'Account', kind: 'share', name: 'AccountShare' },
            ],
          },
          objects: [
            { objectApiName: 'Account', before: 10, after: 5 },
            { objectApiName: 'Case', before: 40, after: 40, keptWhole: 'rows' },
            { objectApiName: 'CaseComment', before: 8, after: 8, keptWhole: 'byKey' },
          ],
        })}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-object-Case').textContent).toContain(
      'Casekept whole: the rows the template gives4040',
    );
    expect(screen.getByTestId('seed-fit-object-CaseComment').textContent).toContain(
      'CaseCommentkept whole: each under the parent row its key names88',
    );
    expect(
      within(screen.getByTestId('seed-fit-not-counted'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Not counted: what “Welcome Email” on Contact creates, as it could not be read.',
      'Not counted: the AccountShare rows the flows on Account create.',
    ]);
  });

  it('offers nothing to seed when nothing fits, says why, and keeps the way back', () => {
    const onChangeCounts = vi.fn();
    const { rerender } = render(
      <SeedFitProposalCard
        proposal={NOTHING_FITS}
        org="my-dev-org"
        onSeed={vi.fn()}
        onChangeCounts={onChangeCounts}
      />,
    );
    expect(screen.getByTestId('seed-fit-cannot').textContent).toContain(
      'Even cut as far as it goes, this seed takes about 0.03 MB, past the 0 MB that fit in my-dev-org. Leave objects out, or free data storage in my-dev-org.',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Seed these counts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change the counts' }));
    expect(onChangeCounts).toHaveBeenCalledTimes(1);

    rerender(
      <SeedFitProposalCard
        proposal={{ ...NOTHING_FITS, budget: { ...NOTHING_FITS.budget, limitedBy: 'apiRequests' } }}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByTestId('seed-fit-cannot').textContent).toContain(
      'Even cut as far as it goes, the writes of this seed would leave my-dev-org less than a tenth of its daily API requests.',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('speaks French in French, its figures written as French writes them', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(
      <SeedFitProposalCard
        proposal={salesCloudOnADeveloperEdition()}
        org="my-dev-org"
        onSeed={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'Ce qui tient dans my-dev-org' })).toBeTruthy();
    expect(screen.getByTestId('seed-fit-total').textContent).toMatch(
      /^1\s717 enregistrements sur 7\s600, environ 3,58 Mo avec ce que les Flows créent dessous\.$/,
    );
    expect(screen.getByRole('button', { name: 'Lancer le seed avec ces nombres' })).toBeTruthy();
  });
});

describe('SeedFitResultLine', () => {
  it('says the records the run set out to write of those the template asked for, and the share', () => {
    render(
      <SeedFitResultLine
        fitted={fittedRunOf(salesCloudOnADeveloperEdition())}
        org="my-dev-org"
        testId="fitted"
      />,
    );
    expect(screen.getByTestId('fitted').textContent).toContain(
      'Counts fitted to the data storage of my-dev-org: 1,717 of the 7,600 records the template asked for, 22.6% of every count.',
    );
  });
});

/** A message from the extension, as the panel receives it. */
function fromExtension(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

describe('useSeedFitRefusal', () => {
  const refusal = (correlationId: string, payload: Record<string, unknown>) =>
    fromExtension({ type: 'seed:error', id: 'e1', correlationId, payload });

  it('takes the counts the refusal of its request carried for the storage or the API requests', () => {
    const { result, rerender } = renderHook(({ id }) => useSeedFitRefusal(id), {
      initialProps: { id: 'run-1' as string | null },
    });
    expect(result.current).toBeNull();

    refusal('run-1', {
      code: 'SEED_STORAGE_EXCEEDED',
      message: 'Too big.',
      fit: salesCloudOnADeveloperEdition(),
    });
    expect(result.current).toEqual(salesCloudOnADeveloperEdition());

    // Another run sent: the proposal was of the one before.
    rerender({ id: 'run-2' });
    expect(result.current).toBeNull();
    refusal('run-2', {
      code: 'API_BUDGET_EXCEEDED',
      message: 'Short of requests.',
      fit: NOTHING_FITS,
    });
    expect(result.current).toEqual(NOTHING_FITS);
    rerender({ id: null });
    expect(result.current).toBeNull();
  });

  it('leaves what another request, another refusal or another shape carries', () => {
    const { result } = renderHook(() => useSeedFitRefusal('run-1'));
    refusal('run-0', { code: 'SEED_STORAGE_EXCEEDED', fit: salesCloudOnADeveloperEdition() });
    refusal('run-1', { code: 'SEED_EMAILS_EXCEEDED', fit: salesCloudOnADeveloperEdition() });
    refusal('run-1', { code: 'SEED_STORAGE_EXCEEDED', fit: { share: 0.5 } });
    refusal('run-1', { code: 'SEED_STORAGE_EXCEEDED' });
    expect(result.current).toBeNull();
  });
});
