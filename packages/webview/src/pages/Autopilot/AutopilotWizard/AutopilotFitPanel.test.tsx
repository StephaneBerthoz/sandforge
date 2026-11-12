import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AutopilotFitReport, AutopilotPlanWriteGate } from '@sandforge/shared';
import i18n from '../../../i18n';
import fr from '../../../i18n/locales/fr.json';
import {
  AutopilotFitResultLine,
  AutopilotFitSection,
  AutopilotNodeFit,
  AutopilotPlanStorage,
  fitNotAppliedWords,
  isAutopilotPlanWriteGate,
} from './AutopilotFitPanel';

/** A client sandbox's accounts and contacts, 64.5 MB for the 22 MB it has left. */
const REFUSED: AutopilotPlanWriteGate = {
  records: 32_982,
  estimateMB: 64.5,
  remainingMB: 22,
  maxMB: 200,
  verdict: 'exceeds',
  apiRequests: { estimate: 120, remaining: 14_000, max: 15_000, verdict: 'fits' },
};

/**
 * The fit the extension proposes for it: a quarter of the accounts, the
 * contacts of the accounts kept, the parents they name; the contact flow
 * muted, a trigger it cannot read named.
 */
function fitted(overrides: Partial<AutopilotFitReport> = {}): AutopilotFitReport {
  return {
    mode: { share: true },
    heldBy: 'storage',
    budget: {
      budgetMB: 16.4,
      remainingMB: 22,
      maxMB: 200,
      share: 0.8,
      roundingMB: 0.5,
      limitedBy: 'storage',
      automationMB: 0,
      notCounted: [{ objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger' }],
    },
    share: 0.26,
    objects: [
      {
        objectApiName: 'Account',
        inSource: 12_935,
        kept: 3_371,
        cutSpread: 9_564,
        cutWithParent: [],
      },
      {
        objectApiName: 'Contact',
        inSource: 20_045,
        kept: 5_213,
        cutSpread: 222,
        cutWithParent: [{ field: 'AccountId', parent: 'Account', count: 14_610 }],
      },
    ],
    emptied: [
      { objectApiName: 'Account', field: 'ParentId', count: 41, why: 'selfReference' },
      { objectApiName: 'Account', field: 'Primary_Contact__c', count: 37, why: 'owed' },
    ],
    parents: [{ objectApiName: 'Region__c', records: 1 }],
    records: 8_585,
    estimateMB: 16.7,
    requestsRead: 19,
    ...overrides,
  };
}

function section(props: Partial<React.ComponentProps<typeof AutopilotFitSection>> = {}) {
  const handlers = { onFit: vi.fn(), onUndo: vi.fn(), onOpen: vi.fn() };
  const view = render(
    <AutopilotFitSection
      org="QASandbox"
      selectedObjects={['Account', 'Contact']}
      writeGate={REFUSED}
      muted={false}
      fitting={false}
      undoing={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('isAutopilotPlanWriteGate', () => {
  it('takes what the extension says of a plan against its target', () => {
    expect(isAutopilotPlanWriteGate(REFUSED)).toBe(true);
    expect(
      isAutopilotPlanWriteGate({ records: 3, estimateMB: 0.01, verdict: 'unread', unread: 'x' }),
    ).toBe(true);
  });

  it('leaves unshown what an extension of another version sends in part', () => {
    expect(isAutopilotPlanWriteGate(undefined)).toBe(false);
    expect(isAutopilotPlanWriteGate({ ...REFUSED, verdict: 'tight' })).toBe(false);
    expect(isAutopilotPlanWriteGate({ ...REFUSED, remainingMB: undefined })).toBe(false);
    expect(
      isAutopilotPlanWriteGate({ ...REFUSED, apiRequests: { estimate: 1, verdict: 'fits' } }),
    ).toBe(false);
  });
});

describe('AutopilotPlanStorage', () => {
  it('says before Run that a run would be refused, in figures', () => {
    render(<AutopilotPlanStorage writeGate={REFUSED} org="QASandbox" testId="s" />);
    expect(screen.getByTestId('s-storage').textContent).toContain(
      '64.5 MB to write, and QASandbox has 22 MB left of 200 MB: a run would be refused.',
    );
    expect(screen.queryByTestId('s-requests')).toBeNull();
  });

  it('says the API requests when a run would be refused or asked for them', () => {
    render(
      <AutopilotPlanStorage
        writeGate={{
          ...REFUSED,
          verdict: 'fits',
          apiRequests: { estimate: 9_000, remaining: 8_000, max: 15_000, verdict: 'exceeds' },
        }}
        org="QASandbox"
        testId="s"
      />,
    );
    expect(screen.getByTestId('s-requests').textContent).toContain(
      'About 9,000 API requests, and QASandbox has 8,000 of its 15,000 daily requests left: a run would be refused.',
    );
  });

  it('says why the target did not say what it has left', () => {
    render(
      <AutopilotPlanStorage
        writeGate={{
          records: 3,
          estimateMB: 0.01,
          verdict: 'unread',
          unread: 'INVALID_SESSION_ID',
        }}
        org="QASandbox"
        testId="s"
      />,
    );
    expect(screen.getByTestId('s-storage').textContent).toContain(
      'QASandbox did not say what data storage it has left (INVALID_SESSION_ID)',
    );
  });
});

describe('AutopilotFitSection', () => {
  it('offers the fit of a plan that would be refused, by share by default', () => {
    const { onFit, onOpen } = section();

    fireEvent.click(screen.getByRole('button', { name: 'Fit to storage…' }));
    expect(onOpen).toHaveBeenCalledOnce();
    const panel = screen.getByRole('group', { name: 'Fit the plan to what QASandbox has left' });
    expect(
      (within(panel).getByRole('radio', { name: /same share of every object/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: 'Fit the plan' }));

    expect(onFit).toHaveBeenCalledWith({ share: true });
  });

  it('fits by caps per object, within so many MB, then by share when asked', () => {
    const { onFit } = section();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to storage…' }));

    fireEvent.click(screen.getByRole('radio', { name: 'At most so many records of each object' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'At most this many Contact records' }), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Use no more than (MB, optional)' }), {
      target: { value: '16,5' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /largest share of what the caps leave/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit the plan' }));

    expect(onFit).toHaveBeenCalledWith({ caps: { Contact: 1000 }, share: true, withinMB: 16.5 });
  });

  it('refuses caps that ask nothing, or a cap that is not a number of records', () => {
    const { onFit } = section();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to storage…' }));
    fireEvent.click(screen.getByRole('radio', { name: 'At most so many records of each object' }));

    fireEvent.click(screen.getByRole('button', { name: 'Fit the plan' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Give a cap to at least one object, or fit by share.',
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'At most this many Account records' }), {
      target: { value: '2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fit the plan' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'The cap of Account is a whole number of records, 1 or more.',
    );
    expect(onFit).not.toHaveBeenCalled();
  });

  it('says what the fit kept, what held it, and each object before and after, and undoes it', () => {
    const { onUndo } = section({ fitted: fitted() });

    const report = screen.getByRole('region', { name: 'Fitted to QASandbox' });
    expect(within(report).getByTestId('step4-fit-report-share').textContent).toContain(
      'The largest share of every object that fits: 26%.',
    );
    expect(within(report).getByTestId('step4-fit-report-bound').textContent).toContain(
      '16.4 MB fit: 80% of the 22 MB QASandbox says it has left of 200 MB, once 0.5 MB is set aside for the rounding of what it says.',
    );
    expect(within(report).getByTestId('step4-fit-report-room').textContent).toContain(
      'Nothing is kept for the flows of QASandbox: none of those that still run creates records under these.',
    );
    expect(within(report).getByTestId('step4-fit-report-not-counted').textContent).toContain(
      'Not counted: what the Apex trigger AccountTrigger on Account creates.',
    );
    const contact = within(report).getByTestId('step4-fit-report-object-Contact');
    expect(contact.textContent).toContain('20,045');
    expect(contact.textContent).toContain('5,213');
    expect(contact.textContent).toContain('With their Account (AccountId): 14,610');
    expect(contact.textContent).toContain('Spread over the table: 222');
    expect(within(report).getByTestId('step4-fit-report-emptied').textContent).toContain(
      'Account.ParentId (41): the record of its own object it names was cut',
    );
    expect(within(report).getByTestId('step4-fit-report-emptied').textContent).toContain(
      'Account.Primary_Contact__c (37): the record it names, written after it, was cut',
    );
    expect(within(report).getByTestId('step4-fit-report-parents').textContent).toContain(
      'Region__c: 1',
    );
    expect(within(report).getByTestId('step4-fit-report-total').textContent).toContain(
      '8,585 records in all, about 16.7 MB; 19 requests read to fit it.',
    );
    expect(screen.getByRole('button', { name: 'Fit again…' })).toBeTruthy();

    fireEvent.click(within(report).getByRole('button', { name: 'Undo fit' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('says the room kept for the flows, or that the automation could not be read', () => {
    const { rerender } = render(
      <AutopilotFitSection
        org="QASandbox"
        selectedObjects={['Account']}
        writeGate={REFUSED}
        fitted={fitted({ budget: { ...fitted().budget, automationMB: 0.5 } })}
        muted={false}
        fitting={false}
        undoing={false}
        onFit={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step4-fit-report-room').textContent).toContain(
      '0.5 MB of it is kept for what the flows of QASandbox that still run create under these records.',
    );
    expect(screen.getByTestId('step4-fit-report-total').textContent).toContain(
      'about 16.7 MB and 0.5 MB for what the flows create under them',
    );

    rerender(
      <AutopilotFitSection
        org="QASandbox"
        selectedObjects={['Account']}
        writeGate={REFUSED}
        fitted={fitted({ automationUnread: 'timed out' })}
        muted
        fitting={false}
        undoing={false}
        onFit={vi.fn()}
        onUndo={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step4-fit-report-room').textContent).toContain(
      'No room is kept for what the automation of QASandbox creates: it could not be read (timed out).',
    );
  });

  it('says the fit was counted for another mute than the run is now set to', () => {
    const { unmount } = section({ fitted: fitted({ countedMuted: true }), muted: false });
    expect(screen.getByTestId('step4-fit-report-mute-changed').textContent).toContain(
      'The mute was changed since this fit',
    );
    expect(screen.getByTestId('step4-fit-report-room').textContent).toContain(
      'the mute keeps the others quiet',
    );
    unmount();

    section({ fitted: fitted({ countedMuted: true }), muted: true });
    expect(screen.queryByTestId('step4-fit-report-mute-changed')).toBeNull();
  });

  it('hands the keyboard to what the fit kept, and to Fit to storage once it is undone', () => {
    const props = {
      org: 'QASandbox',
      selectedObjects: ['Account', 'Contact'],
      writeGate: REFUSED,
      muted: false,
      fitting: false,
      undoing: false,
      onFit: vi.fn(),
      onUndo: vi.fn(),
    };
    const { rerender } = render(<AutopilotFitSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fit to storage…' }));

    rerender(<AutopilotFitSection {...props} fitted={fitted()} />);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Fitted to QASandbox' }),
    );

    rerender(<AutopilotFitSection {...props} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fit to storage…' }));
  });

  it('names what held each fit', () => {
    const boundOf = (report: AutopilotFitReport): string | null => {
      const { unmount } = section({ fitted: report });
      const text = screen.getByTestId('step4-fit-report-bound').textContent;
      unmount();
      return text;
    };
    expect(
      boundOf(
        fitted({
          heldBy: 'within',
          mode: { share: true, withinMB: 3 },
          budget: { ...fitted().budget, withinMB: 3 },
        }),
      ),
    ).toBe('3 MB fit: the most asked of this fit.');
    expect(boundOf(fitted({ heldBy: 'apiRequests' }))).toBe(
      "Today's API requests held it: the writes of these records leave QASandbox a tenth of its daily requests.",
    );
    expect(boundOf(fitted({ heldBy: 'maxTotal', maxTotal: 10_000 }))).toBe(
      'The most records a run may write held it: 10,000.',
    );
    expect(boundOf(fitted({ heldBy: 'caps', share: undefined }))).toBe(
      'The caps asked held it, within the 16.4 MB that fit.',
    );
  });

  it('offers no fit to a target that did not say what it has left, and says why a fit was refused', () => {
    section({
      writeGate: { records: 3, estimateMB: 0.01, verdict: 'unread', unread: 'x' },
      error:
        'The plan was not fitted: the source org refused a read of its records (REQUEST_LIMIT_EXCEEDED).',
    });
    expect(screen.queryByRole('button', { name: 'Fit to storage…' })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('REQUEST_LIMIT_EXCEEDED');
  });

  it('says in the panel what a fit that fitted nothing came to', () => {
    section({
      notApplied: fitted({
        cannotFit: { why: 'least', over: { bound: 'storage', takesMB: 0.03, fitsMB: 0 } },
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fit to storage…' }));
    expect(screen.getByTestId('step4-fit-panel-not-applied').textContent).toContain(
      'Even cut as far as it goes — one record of each object and what must come with it — the plan takes 0.03 MB, past the 0 MB that fit in QASandbox.',
    );
  });

  it('is said in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    section({ fitted: fitted() });
    expect(screen.getByRole('region', { name: 'Ajusté à QASandbox' })).toBeTruthy();
    // French writes a narrow no-break space before the percent sign.
    const bound = screen.getByTestId('step4-fit-report-bound').textContent ?? '';
    expect(bound.replace(/[\u202f\u00a0]/g, ' ')).toContain(
      fr.autopilot.fit.boundStorage
        .replace('{{fits}}', '16,4')
        .replace('{{near}}', '80 %')
        .replace('{{remaining}}', '22')
        .replace('{{org}}', 'QASandbox')
        .replace('{{max}}', '200')
        .replace('{{rounding}}', '0,5'),
    );
  });
});

describe('fitNotAppliedWords', () => {
  const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options);

  it('says a plan that fits as it is, and why nothing fits, from the figures', () => {
    expect(fitNotAppliedWords(fitted({ records: 6, estimateMB: 0.01 }), 'QASandbox', t)).toBe(
      'The plan fits QASandbox as it is: 6 records, about 0.01 MB. Nothing was cut.',
    );
    const words = (cannotFit: AutopilotFitReport['cannotFit']): string =>
      fitNotAppliedWords(fitted({ cannotFit }), 'QASandbox', t);
    expect(words({ why: 'sourceChanged' })).toBe(
      'The source changed since the plan: it holds records the plan did not count. Go back to the objects and plan again.',
    );
    expect(words({ why: 'rounds' })).toContain('Fit by caps instead.');
    expect(words({ why: 'capNotSelected', object: 'Region__c' })).toBe(
      'The plan does not select Region__c: a cap holds an object the plan selects.',
    );
    expect(words({ why: 'caps', over: { bound: 'storage', takesMB: 30, fitsMB: 16.8 } })).toBe(
      'With these caps the plan takes 30 MB, past the 16.8 MB that fit in QASandbox. Lower them, or fit by share.',
    );
    expect(
      words({ why: 'caps', over: { bound: 'apiRequests', requests: 9_000, allowed: 6_500 } }),
    ).toContain('about 9,000 API requests, past the 6,500 that leave QASandbox');
    expect(
      words({ why: 'least', over: { bound: 'maxTotal', records: 12_000, allowed: 10_000 } }),
    ).toBe(
      'Even cut as far as it goes, the plan writes 12,000 records, past the 10,000 a run may write. Leave objects out.',
    );
  });
});

describe('AutopilotFitResultLine', () => {
  it('says what the run copied of the source, and what was held back since the fit', () => {
    render(<AutopilotFitResultLine report={fitted()} org="QASandbox" cutSinceFit={3} testId="r" />);
    expect(screen.getByTestId('r').textContent).toContain(
      'Plan fitted to the data storage of QASandbox: 8,584 of the 32,980 records of the selected objects kept, 26% of each.',
    );
    expect(screen.getByTestId('r-cut-since').textContent).toContain(
      'Held back since the fit, read naming a record the fit cut, neither written nor refused: 3',
    );
  });

  it('says a fit by caps alone without a share', () => {
    render(
      <AutopilotFitResultLine report={fitted({ share: undefined })} org="QASandbox" testId="r" />,
    );
    expect(screen.getByTestId('r').textContent).toContain('by the caps asked');
    expect(screen.queryByTestId('r-cut-since')).toBeNull();
  });
});

describe('AutopilotNodeFit', () => {
  it('says what a selected object kept, a parent that it follows, and what was held back', () => {
    const { rerender } = render(
      <AutopilotNodeFit objectApiName="Contact" report={fitted()} cutSinceFit={2} />,
    );
    expect(screen.getByTestId('node-fit-kept').textContent).toContain(
      '5,213 of the 20,045 records in the source kept',
    );
    expect(screen.getByTestId('node-fit').textContent).toContain(
      'With their Account (AccountId): 14,610',
    );
    expect(screen.getByTestId('node-fit-cut-since').textContent).toContain(': 2');

    rerender(<AutopilotNodeFit objectApiName="Region__c" report={fitted()} />);
    expect(screen.getByTestId('node-fit-parent').textContent).toContain(
      'Read by id, the records the kept ones name: 1',
    );

    rerender(<AutopilotNodeFit objectApiName="Lead" report={fitted()} />);
    expect(screen.queryByTestId('node-fit')).toBeNull();
  });
});
