import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ForgeUndoObjectResult, ForgeUndoResult } from '@sandforge/shared';
import i18n from '../../i18n';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
  removalConfirmLabel,
} from './ForgeRunRemovalView';

/** One object's outcome, nothing counted but what a test names. */
function outcome(overrides: Partial<ForgeUndoObjectResult>): ForgeUndoObjectResult {
  return {
    objectApiName: 'Contact',
    planned: 0,
    deleted: 0,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
    ...overrides,
  };
}

function result(overrides: Partial<ForgeUndoResult>): ForgeUndoResult {
  return {
    forgeId: 'forge-1',
    status: 'success',
    includeChanged: false,
    objects: [],
    finishedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

describe('removalConfirmLabel', () => {
  const t = i18n.t.bind(i18n) as Parameters<typeof removalConfirmLabel>[0];
  const contacts = [{ objectApiName: 'Contact', count: 4 }];
  const withFiles = [{ objectApiName: 'ContentDocument', count: 1 }, ...contacts];

  it('says the act and its size, one or several', () => {
    expect(removalConfirmLabel(t, contacts, false)).toBe('Remove 4 records');
    expect(removalConfirmLabel(t, [{ objectApiName: 'Contact', count: 1 }], false)).toBe(
      'Remove 1 record',
    );
  });

  it('counts the plan’s files as files, as the plan names them', () => {
    expect(removalConfirmLabel(t, withFiles, false)).toBe('Remove 5 records and files');
  });

  it('says a sweep goes with it: it deletes records the plan does not count', () => {
    expect(removalConfirmLabel(t, contacts, true)).toBe(
      'Remove 4 records and what the sweep takes',
    );
    expect(removalConfirmLabel(t, withFiles, true)).toBe(
      'Remove 5 records and files, and what the sweep takes',
    );
  });

  it('never says it removes no record: nothing planned is the sweep alone', () => {
    expect(removalConfirmLabel(t, [], true)).toBe('Delete what the sweep takes');
  });

  it('names no size it does not know, and no sweep that is not asked', () => {
    expect(removalConfirmLabel(t, [], false)).toBe('Confirm');
  });
});

describe('ForgeRunRemovalPlan', () => {
  it('counts the records of each object, one or several', () => {
    render(
      <ForgeRunRemovalPlan
        plan={[
          { objectApiName: 'Contact', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ]}
        linked={0}
      />,
    );

    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 2 records', 'Account: 1 record']);
    // No linked record, nothing said about them.
    expect(screen.queryByTestId('forge-removal-linked')).toBeNull();
  });

  it('counts the files a run created as files, one or several, and records as records', () => {
    render(
      <ForgeRunRemovalPlan
        plan={[
          { objectApiName: 'ContentDocument', count: 1 },
          { objectApiName: 'Attachment', count: 2 },
          { objectApiName: 'Account', count: 1 },
        ]}
        linked={0}
      />,
    );

    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ContentDocument: 1 file', 'Attachment: 2 files', 'Account: 1 record']);
  });

  it('says the lines the platform copied go too, for a plan with a quote and its lines', () => {
    const { rerender } = render(
      <ForgeRunRemovalPlan
        plan={[
          { objectApiName: 'QuoteLineItem', count: 2 },
          { objectApiName: 'Quote', count: 1 },
        ]}
        linked={0}
      />,
    );
    expect(screen.getByTestId('forge-removal-quote-copies').textContent).toBe(
      'The lines the platform copied between a quote the run synced and its opportunity go too: they are read as the removal begins, and counted apart in its result.',
    );

    rerender(
      <ForgeRunRemovalPlan
        plan={[
          { objectApiName: 'OpportunityLineItem', count: 2 },
          { objectApiName: 'Quote', count: 1 },
        ]}
        linked={0}
      />,
    );
    expect(screen.getByTestId('forge-removal-quote-copies')).toBeDefined();
  });

  it('says nothing of copies for a plan without a quote, or without its lines', () => {
    const { rerender } = render(
      <ForgeRunRemovalPlan plan={[{ objectApiName: 'Quote', count: 1 }]} linked={0} />,
    );
    expect(screen.queryByTestId('forge-removal-quote-copies')).toBeNull();

    rerender(
      <ForgeRunRemovalPlan plan={[{ objectApiName: 'QuoteLineItem', count: 2 }]} linked={0} />,
    );
    expect(screen.queryByTestId('forge-removal-quote-copies')).toBeNull();

    rerender(
      <ForgeRunRemovalPlan
        plan={[
          { objectApiName: 'QuoteLineItem', count: 0 },
          { objectApiName: 'Quote', count: 1 },
        ]}
        linked={0}
      />,
    );
    expect(screen.queryByTestId('forge-removal-quote-copies')).toBeNull();
  });

  it('says the linked records are kept', () => {
    render(<ForgeRunRemovalPlan plan={[{ objectApiName: 'Account', count: 1 }]} linked={3} />);

    expect(screen.getByTestId('forge-removal-linked').textContent).toBe(
      '3 linked records are kept.',
    );
  });

  it('says which removal left the records it names, when one did', () => {
    const { rerender } = render(
      <ForgeRunRemovalPlan plan={[{ objectApiName: 'Order', count: 2 }]} linked={0} />,
    );
    expect(screen.queryByTestId('forge-removal-left-by')).toBeNull();

    rerender(
      <ForgeRunRemovalPlan
        plan={[{ objectApiName: 'Order', count: 2 }]}
        linked={0}
        leftBy="2026-09-29 15:51"
      />,
    );
    expect(screen.getByTestId('forge-removal-left-by').textContent).toBe(
      'The removal of 2026-09-29 15:51 left these records:',
    );
  });
});

describe('ForgeRunRemovalResult', () => {
  it('says, per object, only the counts that are not zero', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          status: 'partial',
          objects: [
            outcome({ objectApiName: 'Case', planned: 3, deleted: 2, alreadyGone: 1 }),
            outcome({ objectApiName: 'Contact', planned: 4, keptChanged: 3, refused: 1 }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-result-Case').textContent).toBe(
      'Case: 2 deleted · 1 already gone',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 3 kept, changed since the run · 1 refused',
    );
  });

  it('says a record found neither in the org nor in its recycle bin is not visible, never gone', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          status: 'partial',
          objects: [outcome({ objectApiName: 'Case', planned: 3, deleted: 2, notVisible: 1 })],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-result-Case').textContent).toBe(
      'Case: 2 deleted · 1 not visible to this user (neither found nor in the recycle bin)',
    );
  });

  it('names, for a removal stopped part way, what it never reached, an object it never got to too', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          status: 'cancelled',
          objects: [
            outcome({ objectApiName: 'Contact', planned: 5, deleted: 3, notReached: 2 }),
            outcome({ objectApiName: 'Account', planned: 1, notReached: 1 }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 3 deleted · 2 not reached before the cancel',
    );
    expect(screen.getByTestId('forge-removal-result-Account').textContent).toBe(
      'Account: 1 not reached before the cancel',
    );
  });

  it('names the objects whose records hold a kept record, or says they could not be read', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          status: 'failure',
          objects: [
            outcome({ objectApiName: 'Account', keptDependents: 2, heldBy: ['Task', 'Contact'] }),
            outcome({
              objectApiName: 'Opportunity',
              keptDependents: 1,
              reasons: ['OpportunityContactRole: INVALID_FIELD: No such column'],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-result-Account').textContent).toBe(
      'Account: 2 kept, records of Task, Contact that stay depend on them',
    );
    const opportunity = screen.getByTestId('forge-removal-result-Opportunity');
    expect(opportunity.textContent).toContain('1 kept: what depends on it could not be read');
    expect(within(opportunity).getByRole('listitem').textContent).toBe(
      'OpportunityContactRole: INVALID_FIELD: No such column',
    );
  });

  it('says once which objects it could not check, whichever objects had them', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          objects: [
            outcome({ objectApiName: 'Contact', deleted: 1, unchecked: ['ActionableListMember'] }),
            outcome({ objectApiName: 'Account', deleted: 1, unchecked: ['ActionableListMember'] }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-unchecked').textContent).toBe(
      'Not checked: records of ActionableListMember cannot be read by the record they depend on, and are deleted with it.',
    );
  });

  it('says the records of the run a call may have written, which the removal cannot reach', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={{ ...result({ objects: [outcome({ deleted: 1 })] }), mayHaveBeenWritten: 2 }}
      />,
    );

    expect(screen.getByTestId('forge-removal-unreachable').textContent).toBe(
      '2 records a call of the run may have written before its answer was lost may be in DEV-SANDBOX: no id of theirs is known, and the removal cannot reach them.',
    );
  });

  it('says nothing of records out of reach when every call of the run was answered', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({ objects: [outcome({ deleted: 1 })] })}
      />,
    );

    expect(screen.queryByTestId('forge-removal-unreachable')).toBeNull();
    expect(screen.queryByTestId('forge-removal-not-journaled')).toBeNull();
    expect(screen.queryByTestId('forge-removal-calls-not-looked-for')).toBeNull();
  });

  it('says why some were never looked for: an upsert its journal does not keep, calls left after an earlier removal', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={{
          ...result({ objects: [outcome({ deleted: 1 })] }),
          mayHaveBeenWritten: 3,
          notLookedFor: { notJournaled: 2, callsAfterRemoval: 1 },
        }}
      />,
    );

    expect(screen.getByTestId('forge-removal-not-journaled').textContent).toBe(
      "2 of them went in an upsert, whose calls the run's journal does not keep: they were not looked for in DEV-SANDBOX.",
    );
    expect(screen.getByTestId('forge-removal-calls-not-looked-for').textContent).toBe(
      "1 insert call this run had under way when it stopped was not looked for in DEV-SANDBOX: such calls are looked for before a run's first removal only, and whatever it may have written stays there.",
    );
  });

  it('says nothing of checks when every relationship was read', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({ objects: [outcome({ deleted: 1 })] })}
      />,
    );

    expect(screen.queryByTestId('forge-removal-unchecked')).toBeNull();
  });

  it('opens with how the removal ended, in the org it removed from', () => {
    const { rerender } = render(
      <ForgeRunRemovalResult org="DEV-SANDBOX" result={result({ status: 'success' })} />,
    );
    expect(screen.getByRole('heading').textContent).toBe(
      'No record this run created is left in DEV-SANDBOX.',
    );

    rerender(<ForgeRunRemovalResult org="DEV-SANDBOX" result={result({ status: 'cancelled' })} />);
    expect(screen.getByRole('heading').textContent).toBe(
      'Stopped before the end: what was done by then is listed, and the rest is still in DEV-SANDBOX.',
    );
  });

  it('says a removal of what an earlier one left picked up where that one left off', () => {
    const { rerender } = render(
      <ForgeRunRemovalResult org="DEV-SANDBOX" result={result({ status: 'success' })} />,
    );
    expect(screen.queryByTestId('forge-removal-result-left-by')).toBeNull();

    rerender(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({ status: 'success', leftBy: '2026-09-29T15:51:27.295Z' })}
      />,
    );
    expect(screen.getByTestId('forge-removal-result-left-by').textContent).toMatch(
      /^Picked up where the removal of 2026-09-29 \d\d:\d\d left off\.$/,
    );

    rerender(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({ status: 'success', leftBy: 'not a date' })}
      />,
    );
    expect(screen.getByTestId('forge-removal-result-left-by').textContent).toBe(
      'Picked up where the removal of unknown left off.',
    );
  });
});

describe('ForgeRunRemovalResult of what the automation made', () => {
  /** A removal that kept an opportunity and two contacts for what hung under them. */
  const HELD = result({
    status: 'partial',
    objects: [
      outcome({
        objectApiName: 'Opportunity',
        keptDependents: 1,
        heldBy: ['Task'],
        heldByAutomation: 1,
        automationHolders: ['Task'],
      }),
      outcome({
        objectApiName: 'Contact',
        keptDependents: 2,
        heldBy: ['Task', 'FeedItem'],
        heldByAutomation: 2,
        automationHolders: ['Task', 'FeedItem'],
      }),
    ],
  });

  it('names what the automation likely made, once each, and how many of the run’s it held', () => {
    render(<ForgeRunRemovalResult result={HELD} org="DEV-SANDBOX" />);

    expect(screen.getByTestId('forge-removal-held-by-automation').textContent).toBe(
      "3 records of this run were kept for records created under them during the run, as its user, likely by the target's automation: Task, FeedItem.",
    );
  });

  it('proposes the sweep, and says what it leaves that a rewind takes back', () => {
    const onTakeBackMade = vi.fn();
    render(
      <ForgeRunRemovalResult result={HELD} org="DEV-SANDBOX" onTakeBackMade={onTakeBackMade} />,
    );

    const button = screen.getByTestId('forge-removal-take-back-made');
    expect(button.textContent).toBe(
      "Take back what the target's automation made for this run, then remove again",
    );
    fireEvent.click(button);
    expect(onTakeBackMade).toHaveBeenCalledOnce();
    expect(screen.getByTestId('forge-removal-held-by-automation').textContent).toContain(
      'only a rewind to a checkpoint takes that back',
    );
  });

  it('names them without a button where no removal can follow', () => {
    render(<ForgeRunRemovalResult result={HELD} org="DEV-SANDBOX" />);

    expect(screen.queryByTestId('forge-removal-take-back-made')).toBeNull();
  });

  it('says nothing of the automation for records held by others, or by nothing it made', () => {
    render(
      <ForgeRunRemovalResult
        result={result({
          status: 'partial',
          objects: [
            outcome({ objectApiName: 'Contact', keptDependents: 1, heldBy: ['Case'] }),
            outcome({ objectApiName: 'Account', deleted: 1, heldByAutomation: 0 }),
          ],
        })}
        org="DEV-SANDBOX"
        onTakeBackMade={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('forge-removal-held-by-automation')).toBeNull();
    expect(screen.queryByTestId('forge-removal-take-back-made')).toBeNull();
  });

  it('says a sweep that was asked left them, and its list says why', () => {
    render(
      <ForgeRunRemovalResult
        result={{
          ...HELD,
          sweep: { status: 'success', objects: [], unread: [], handWork: [] },
        }}
        org="DEV-SANDBOX"
        onTakeBackMade={vi.fn()}
      />,
    );

    expect(screen.getByTestId('forge-removal-held-sweep-left').textContent).toBe(
      'The sweep left them: its list says why, and what came late can be asked for.',
    );
  });

  it('says it of a load in a load’s words', () => {
    render(
      <ForgeRunRemovalResult
        result={HELD}
        org="DEV-SANDBOX"
        subject="load"
        onTakeBackMade={vi.fn()}
      />,
    );

    expect(screen.getByTestId('forge-removal-held-by-automation').textContent).toContain(
      '3 records of this load were kept for records created under them during the load',
    );
    expect(screen.getByTestId('forge-removal-take-back-made').textContent).toBe(
      "Take back what the target's automation made for this load, then remove again",
    );
  });

  it('says nothing of it for a rewind, whose records are what was added since a checkpoint', () => {
    render(
      <ForgeRunRemovalResult
        result={HELD}
        org="DEV-SANDBOX"
        subject="rewind"
        onTakeBackMade={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('forge-removal-held-by-automation')).toBeNull();
  });
});

describe('ForgeRunRemovalResult of the lines the platform copied', () => {
  it('names them beside what it deleted: a plan of 2 lines ended in 4 deleted', () => {
    render(
      <ForgeRunRemovalResult
        result={result({
          objects: [
            outcome({
              objectApiName: 'QuoteLineItem',
              planned: 4,
              deleted: 4,
              platformCopies: 2,
            }),
          ],
        })}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByTestId('forge-removal-result-QuoteLineItem').textContent).toBe(
      'QuoteLineItem: 4 deleted · 2 the platform copied between the quote the run synced and its opportunity',
    );
  });

  it('says nothing of copies when there were none', () => {
    render(
      <ForgeRunRemovalResult
        result={result({
          objects: [outcome({ objectApiName: 'QuoteLineItem', planned: 2, deleted: 2 })],
        })}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByTestId('forge-removal-result-QuoteLineItem').textContent).toBe(
      'QuoteLineItem: 2 deleted',
    );
  });
});

describe('ForgeRunRemovalResult of a Frozen load', () => {
  it('says what the load created, and what changed since the load', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        subject="load"
        result={result({
          status: 'partial',
          objects: [outcome({ objectApiName: 'Contact', deleted: 1, keptChanged: 2 })],
        })}
      />,
    );

    expect(screen.getByRole('heading').textContent).toBe(
      'Records this load created were removed from DEV-SANDBOX; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 1 deleted · 2 kept, changed since the load',
    );
  });

  it('names the files attached to the records it deleted that stay in the org, which the load did not create', () => {
    render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        subject="load"
        result={result({
          objects: [
            outcome({
              objectApiName: 'Order',
              deleted: 2,
              filesLeft: { count: 2, names: ['Confirmation-0001.pdf', 'Confirmation-0002.pdf'] },
            }),
            outcome({ objectApiName: 'Contact', deleted: 1 }),
          ],
        })}
      />,
    );

    expect(screen.getByTestId('forge-removal-files-Order').textContent).toBe(
      '2 files attached to them stay in DEV-SANDBOX, as the load did not create them: Confirmation-0001.pdf, Confirmation-0002.pdf',
    );
    expect(screen.queryByTestId('forge-removal-files-Contact')).toBeNull();
  });
});

describe('ForgeRunRemovalResult of the files a run did not create', () => {
  it('names one file, and says more are left than it names', () => {
    const { rerender } = render(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          objects: [
            outcome({
              objectApiName: 'Case',
              deleted: 1,
              filesLeft: { count: 1, names: ['Photo.png'] },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId('forge-removal-files-Case').textContent).toBe(
      '1 file attached to them stays in DEV-SANDBOX, as the run did not create it: Photo.png',
    );

    rerender(
      <ForgeRunRemovalResult
        org="DEV-SANDBOX"
        result={result({
          objects: [
            outcome({
              objectApiName: 'Case',
              deleted: 7,
              filesLeft: { count: 7, names: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByTestId('forge-removal-files-Case').textContent).toBe(
      '7 files attached to them stay in DEV-SANDBOX, as the run did not create them: a.png, b.png, c.png, d.png, e.png, …',
    );
  });
});

describe('ForgeRunRemovalMark', () => {
  it('says when the records were removed, and what became of them', () => {
    render(
      <ForgeRunRemovalMark
        date="2026-09-23 12:00"
        mark={{ removedAt: '', deleted: 5, alreadyGone: 1, kept: 0, refused: 2 }}
      />,
    );

    expect(screen.getByTestId('forge-removal-mark').textContent).toBe(
      'Records removed on 2026-09-23 12:00: 5 deleted · 1 already gone · 2 refused',
    );
  });

  it('says how many records the last removal did not reach, once it was cancelled', () => {
    render(
      <ForgeRunRemovalMark
        date="2026-09-30 09:10"
        mark={{ removedAt: '', deleted: 6, alreadyGone: 0, kept: 0, refused: 0, notReached: 3 }}
      />,
    );

    expect(screen.getByTestId('forge-removal-mark').textContent).toBe(
      'Records removed on 2026-09-30 09:10: 6 deleted · 3 not reached before the cancel',
    );
  });

  it('says how many records the last removal could not see', () => {
    render(
      <ForgeRunRemovalMark
        date="2026-09-30 09:10"
        mark={{ removedAt: '', deleted: 2, alreadyGone: 0, kept: 0, refused: 0, notVisible: 2 }}
      />,
    );

    expect(screen.getByTestId('forge-removal-mark').textContent).toBe(
      'Records removed on 2026-09-30 09:10: 2 deleted · 2 not visible to this user (neither found nor in the recycle bin)',
    );
  });
});
