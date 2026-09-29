import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ForgeUndoObjectResult, ForgeUndoResult } from '@sandforge/shared';
import '../../i18n';
import {
  ForgeRunRemovalMark,
  ForgeRunRemovalPlan,
  ForgeRunRemovalResult,
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
});
