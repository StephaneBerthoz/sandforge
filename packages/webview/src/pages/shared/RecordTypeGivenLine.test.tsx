import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { MutedAutomation, RecordTypeGiven, WithoutRecordTypeWhy } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import { RecordTypeGivenLine, RecordTypesGivenSection, stillRanOf } from './RecordTypeGivenLine';

/** The type the platform gave the scratch org's Opportunity created without one. */
const RETAIL = { developerName: 'SFX_Retail', label: 'SFX Retail' };

/**
 * The case the probes found: one Opportunity on Master in the source, its
 * target's describe naming Master the admin's default with one other type
 * open, which the platform gave.
 */
const OPPORTUNITY: RecordTypeGiven = {
  objectApiName: 'Opportunity',
  rows: 1,
  why: { masterInSource: 1 },
  predicted: { ...RETAIL, basis: 'onlyOneOpen' },
};

const PREDICTED_OPPORTUNITY =
  '1 Opportunity record to create without a record type, on Master in the source: the ' +
  'target org would give it SFX_Retail (SFX Retail), the only other Opportunity record type ' +
  "open to the user SandForge writes as — its describe names Master that user's default, yet " +
  'a record written without one gets this one.';

/** Twenty-three opportunities, on Master in the source, read back once created. */
function written(readBack: RecordTypeGiven['readBack']): RecordTypeGiven {
  return {
    objectApiName: 'Opportunity',
    rows: 23,
    why: { masterInSource: 23 },
    predicted: { ...RETAIL, basis: 'onlyOneOpen' },
    ...(readBack ? { readBack } : {}),
  };
}

const LEAD_23 = '23 Opportunity records created without a record type, on Master in the source';

/** A run that muted the target's automation, a flow on Opportunity still running. */
const MUTED: MutedAutomation = {
  state: 'muted',
  assigned: ['Bypass_Automation'],
  held: [],
  permissions: ['Bypass_Flows'],
  silenced: [],
  stillRan: [
    { objectApiName: 'Opportunity', kind: 'flow', name: 'Set Opportunity Type', why: 'noBypass' },
    { objectApiName: 'Opportunity', kind: 'trigger', name: 'OpportunityTrigger', why: 'noBypass' },
    { objectApiName: 'Account', kind: 'flow', name: 'Account Rating', why: 'managedPackage' },
  ],
};

function line(
  entry: RecordTypeGiven | undefined,
  stage: 'predicted' | 'written',
  muted?: MutedAutomation,
) {
  return render(
    <RecordTypeGivenLine entry={entry} stage={stage} stillRan={stillRanOf(muted)} testId="line" />,
  );
}

describe('RecordTypeGivenLine', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says before the run the one other type open to the user, which the target gives though its describe names Master', () => {
    line(OPPORTUNITY, 'predicted');

    const said = screen.getByTestId('line');
    expect(said.textContent).toBe(PREDICTED_OPPORTUNITY);
    expect(said.dataset['stage']).toBe('predicted');
    expect(said.className).not.toContain('status-warning');
  });

  it("says before the run the user's default when the describe names one that is not Master", () => {
    line(
      {
        objectApiName: 'Account',
        rows: 1,
        why: { masterInSource: 1 },
        predicted: {
          developerName: 'Business_Account',
          label: 'Business Account',
          basis: 'userDefault',
        },
      },
      'predicted',
    );

    expect(screen.getByTestId('line').textContent).toBe(
      '1 Account record to create without a record type, on Master in the source: the target ' +
        'org would give it Business_Account (Business Account), the default record type of the ' +
        'user SandForge writes as.',
    );
  });

  it('says Master when the describe gives none other, and names a type by its DeveloperName alone when its label says nothing more', () => {
    line({ objectApiName: 'Opportunity', rows: 2, why: { notRead: 2 } }, 'predicted');

    expect(screen.getByTestId('line').textContent).toBe(
      '2 Opportunity records to create without a record type, none read from the source: the ' +
        'target org would give them Master, the default of the user SandForge writes as, who ' +
        'can use no other Opportunity record type, or several.',
    );

    line(
      {
        objectApiName: 'Case',
        rows: 1,
        why: { masterInSource: 1 },
        predicted: { developerName: 'Support', label: 'Support', basis: 'userDefault' },
      },
      'predicted',
    );
    expect(screen.getAllByTestId('line')[1]!.textContent).toContain('give it Support, the default');
  });

  it.each<[WithoutRecordTypeWhy, string]>([
    ['masterInSource', 'on Master in the source'],
    ['notRead', 'none read from the source'],
    ['decidedDefault', 'given the default by your decision'],
    [
      'dropped',
      "the source's type dropped, as the target org lacks it or keeps it from the user SandForge writes as",
    ],
  ])('says why the records went without a type: %s', (why, words) => {
    line({ ...OPPORTUNITY, rows: 3, why: { [why]: 3 } }, 'predicted');

    expect(screen.getByTestId('line').textContent).toContain(
      `3 Opportunity records to create without a record type, ${words}: the target org would give them`,
    );
  });

  it('counts each reason apart when the records went without a type for more than one', () => {
    line({ ...OPPORTUNITY, rows: 25, why: { decidedDefault: 2, masterInSource: 23 } }, 'predicted');

    expect(screen.getByTestId('line').textContent).toContain(
      '25 Opportunity records to create without a record type, 23 on Master in the source and 2 ' +
        'given the default by your decision: ',
    );
  });

  it('says after the run the type the records were read back holding, and on how many', () => {
    line(written({ read: 23, types: [{ ...RETAIL, rows: 23 }] }), 'written');

    const said = screen.getByTestId('line');
    expect(said.textContent).toBe(
      `${LEAD_23}: they went in as SFX_Retail (SFX Retail), read back on 23.`,
    );
    expect(said.dataset['stage']).toBe('written');
    expect(said.className).not.toContain('status-warning');
  });

  it('says a read back of the first records of many as such, and asserts nothing of the rest', () => {
    line(
      {
        ...written({ read: 200, types: [{ ...RETAIL, rows: 200 }] }),
        rows: 1240,
        why: { masterInSource: 1240 },
      },
      'written',
    );

    expect(screen.getByTestId('line').textContent).toBe(
      '1240 Opportunity records created without a record type, on Master in the source: they ' +
        'went in as SFX_Retail (SFX Retail), read back on 200 of 1240.',
    );
  });

  it('says what the records hold where the target set another type than was predicted, and that its automation did', () => {
    line(
      written({
        read: 23,
        types: [
          { developerName: 'SFX_Other', label: 'SFX Other', rows: 20 },
          { ...RETAIL, rows: 3 },
        ],
      }),
      'written',
    );

    const said = screen.getByTestId('line');
    // The read back is said, never the prediction in its place.
    expect(said.textContent).toBe(
      `${LEAD_23}: read back on 23, 20 with SFX_Other (SFX Other) and 3 with SFX_Retail ` +
        '(SFX Retail), where SFX_Retail (SFX Retail) was predicted. An automation of the ' +
        'target org sets the record type.',
    );
    expect(said.textContent).not.toContain('went in as');
    expect(said.className).toContain('text-status-warning');
  });

  it('names what still ran on the object of a muted run, where the target set another type', () => {
    line(
      written({ read: 23, types: [{ developerName: 'SFX_Other', label: 'SFX Other', rows: 23 }] }),
      'written',
      MUTED,
    );

    const said = screen.getByTestId('line').textContent ?? '';
    expect(said).toBe(
      `${LEAD_23}: read back on 23, 23 with SFX_Other (SFX Other), where SFX_Retail ` +
        "(SFX Retail) was predicted. The target org's automation sets the record type, among what " +
        'still ran on Opportunity: Flow: Set Opportunity Type and Apex trigger: OpportunityTrigger.',
    );
    // What ran on another object set nothing here.
    expect(said).not.toContain('Account Rating');
  });

  it('names nothing of a run that only planned its mute, or found nothing to mute', () => {
    expect(stillRanOf({ ...MUTED, state: 'planned' })).toBeUndefined();
    expect(stillRanOf({ ...MUTED, state: 'nothing' })).toBeUndefined();
    expect(stillRanOf(undefined)).toBeUndefined();
    expect(stillRanOf(MUTED)).toBe(MUTED.stillRan);
  });

  it('says of one record read back with another type the type it holds', () => {
    line(
      {
        ...OPPORTUNITY,
        readBack: { read: 1, types: [{ developerName: 'Master', label: 'Master', rows: 1 }] },
      },
      'written',
    );

    expect(screen.getByTestId('line').textContent).toBe(
      '1 Opportunity record created without a record type, on Master in the source: read back, ' +
        'it holds Master, where SFX_Retail (SFX Retail) was predicted. An automation of the ' +
        'target org sets the record type.',
    );
  });

  it('says a read back that could not be done, in the org’s words, and what the describe predicted', () => {
    line(
      written({
        read: 0,
        types: [],
        unread: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
      }),
      'written',
    );

    const said = screen.getByTestId('line');
    expect(said.textContent).toBe(
      `${LEAD_23}: predicted to get SFX_Retail (SFX Retail), the only other Opportunity record type open ` +
        "to the user SandForge writes as — its describe names Master that user's default, yet a " +
        'record written without one gets this one. What they hold could not be read ' +
        'back: REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.',
    );
    expect(said.className).toContain('text-status-warning');
  });

  it('says of a run that read nothing back what was predicted, as a prediction', () => {
    line(written(undefined), 'written');

    expect(screen.getByTestId('line').textContent).toMatch(
      /: predicted to get SFX_Retail \(SFX Retail\), .*\. They were not read back\.$/,
    );
  });

  it('says records the read back did not find', () => {
    line(written({ read: 0, types: [] }), 'written');

    expect(screen.getByTestId('line').textContent).toBe(
      `${LEAD_23}: none of them was found when read back.`,
    );
  });

  it('says nothing when every record carried its type', () => {
    line(undefined, 'written');
    expect(screen.queryByTestId('line')).toBeNull();
    line({ ...OPPORTUNITY, rows: 0, why: {} }, 'predicted');
    expect(screen.queryByTestId('line')).toBeNull();

    const { container } = render(
      <RecordTypesGivenSection entries={[]} stage="written" testId="section" />,
    );
    expect(container.innerHTML).toBe('');
    render(<RecordTypesGivenSection entries={undefined} stage="predicted" testId="section" />);
    expect(screen.queryByTestId('section')).toBeNull();
  });

  it('lists a run’s objects under a title that says before the run what the target would give, and after it what it gave', () => {
    const account: RecordTypeGiven = {
      objectApiName: 'Account',
      rows: 1,
      why: { masterInSource: 1 },
      predicted: {
        developerName: 'Business_Account',
        label: 'Business Account',
        basis: 'userDefault',
      },
    };
    const { unmount } = render(
      <RecordTypesGivenSection
        entries={[account, OPPORTUNITY]}
        stage="predicted"
        testId="section"
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Record types the target org would give' }),
    ).toBeDefined();
    expect(screen.getByTestId('section-Opportunity').tagName).toBe('LI');
    expect(screen.getByTestId('section-Opportunity').textContent).toBe(PREDICTED_OPPORTUNITY);
    expect(screen.getByTestId('section-Account').textContent).toContain('Business_Account');
    unmount();

    render(
      <RecordTypesGivenSection
        entries={[written({ read: 23, types: [{ ...RETAIL, rows: 23 }] })]}
        stage="written"
        testId="section"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Record types the target org gave' })).toBeDefined();
    expect(screen.getByTestId('section-Opportunity').textContent).toContain('read back on 23');
  });

  it('says it in the panel’s language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    const { unmount } = line(written({ read: 23, types: [{ ...RETAIL, rows: 23 }] }), 'written');

    expect(screen.getByTestId('line').textContent).toBe(
      "23 enregistrements Opportunity créés sans type d'enregistrement, sur Master dans la " +
        'source : ils sont entrés en SFX_Retail (SFX Retail), relus sur 23.',
    );
    unmount();

    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await act(async () => {
      await i18n.changeLanguage('ja');
    });
    line(written({ read: 23, types: [{ ...RETAIL, rows: 23 }] }), 'written');
    expect(screen.getByTestId('line').textContent).toBe(
      'レコードタイプなしで作成された Opportunity のレコード 23 件（ソースで Master）: ' +
        'SFX_Retail (SFX Retail) として書き込まれました（23 件を読み戻し）。',
    );
  });
});
