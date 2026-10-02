import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18n from '../../i18n';
import ja from '../../i18n/locales/ja.json';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { ReviewAutomationTab } from './ReviewAutomationTab';

/** A flow of the target that starts after a case is created, its start condition read. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Case_Notify_Customer',
    label: 'Case notify customer',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/** What the target runs on the run's objects, read in full unless told. */
function automation(overrides: Partial<ForgeTargetAutomation> = {}): ForgeTargetAutomation {
  return {
    objectsRead: ['Case', 'Contact'],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 2,
    ...overrides,
  };
}

describe('ReviewAutomationTab', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('says it is reading until the read answers', () => {
    render(<ReviewAutomationTab automation={null} />);
    expect(screen.getByTestId('automation-loading').textContent).toBe(
      'Reading what the target org runs on the records this run writes…',
    );
  });

  it('shows the error of a read that could not run', () => {
    render(
      <ReviewAutomationTab automation={null} error="Target automation reader not configured" />,
    );
    expect(screen.getByTestId('automation-error').textContent).toBe(
      'Target automation reader not configured',
    );
    expect(screen.queryByTestId('automation-loading')).toBeNull();
  });

  it('says nothing fires when the read found nothing on the objects the run writes', () => {
    render(<ReviewAutomationTab automation={automation()} />);
    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'No active flow or Apex trigger of the target org fires on the 2 objects this run writes.',
    );
    expect(screen.getByTestId('automation-cost').textContent).toBe(
      'Read in 2 requests to the target org.',
    );
  });

  it('says, per object, what each write fires, before or after the save', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow(),
                flow({
                  apiName: 'Case_Defaults',
                  label: 'Case defaults',
                  timing: 'beforeSave',
                  startsOn: 'createAndUpdate',
                }),
                flow({
                  apiName: 'Case_Guard',
                  label: 'Case guard',
                  timing: 'beforeDelete',
                  startsOn: 'delete',
                }),
              ],
              triggers: [{ name: 'CaseTrigger', events: ['beforeInsert', 'afterInsert'] }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'As the run writes its records, the target org runs:',
    );
    const object = screen.getByRole('region', { name: 'Case' });
    const onInsert = within(object).getByTestId('automation-Case-insert');
    expect(
      within(onInsert)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Flow: Case defaults · before save',
      'Apex trigger: CaseTrigger · before and after save',
      'Flow: Case notify customer · after save',
    ]);
    expect(within(object).getByTestId('automation-Case-update').textContent).toBe(
      'On update, when the run writes a record a second timeFlow: Case defaults · before save',
    );
    expect(within(object).getByTestId('automation-Case-delete').textContent).toBe(
      'On delete, when the records of the run are removedFlow: Case guard · before delete',
    );
  });

  it('names the permission that keeps a flow quiet, and says to assign it to the user who writes', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true }] })],
              triggers: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('listitem').textContent).toBe(
      'Flow: Case notify customer · after saveDoes not start for a user with the custom permission Case_BypassFlow',
    );
    expect(screen.getByTestId('automation-bypass').textContent).toBe(
      'Assign the custom permission Case_BypassFlow to the user the run writes as in the target org, and the flows whose start condition excludes it stay quiet.',
    );
  });

  it('names a permission a start condition names any other way, without saying to assign it', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [flow({ permissions: [{ name: 'Run_Sync', bypass: false }] })],
              triggers: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('listitem').textContent).toContain(
      'Its start condition names the custom permission Run_Sync',
    );
    expect(screen.queryByTestId('automation-bypass')).toBeNull();
  });

  it('says which start conditions were left unread or could not be read, and why', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow({ condition: 'notRead' }),
                flow({ apiName: 'Case_Other', label: 'Case other', condition: 'unreadable' }),
              ],
              triggers: [],
            },
          ],
          unread: [{ part: 'conditions', reason: 'INSUFFICIENT_ACCESS: no access' }],
          conditionsNotRead: 1,
          requests: 27,
        })}
      />,
    );

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual([
      'Flow: Case notify customer · after saveStart condition not read',
      'Flow: Case other · after saveStart condition could not be read',
    ]);
    expect(screen.getByTestId('automation-not-read').textContent).toBe(
      'The start condition of 1 flow was not read: the read takes 25 at most, one request each.',
    );
    expect(screen.getByTestId('automation-unread-conditions').textContent).toBe(
      'The start conditions of some flows could not be read: INSUFFICIENT_ACCESS: no access',
    );
  });

  it('does not say nothing fires when the flows or the triggers could not be read', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS: no access' }],
        })}
      />,
    );

    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'Nothing was found in what could be read.',
    );
    expect(screen.getByTestId('automation-unread-flows').textContent).toBe(
      'The flows of the target org could not be read: INSUFFICIENT_ACCESS: no access',
    );
  });

  it('leaves out an object the user has left out of the run since the read, and counts the rest', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Contact',
              flows: [flow({ permissions: [{ name: 'Bypass_All', bypass: true }] })],
              triggers: [],
            },
          ],
        })}
        leftOut={new Set(['Contact'])}
      />,
    );

    expect(screen.queryByTestId('automation-object-Contact')).toBeNull();
    expect(screen.queryByTestId('automation-bypass')).toBeNull();
    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'No active flow or Apex trigger of the target org fires on the object this run writes.',
    );
  });

  it('says it in the language the panel is set to', async () => {
    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await i18n.changeLanguage('ja');
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true }] })],
              triggers: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('automation-summary').textContent).toBe(
      ja.forge.review.automation.intro,
    );
    expect(screen.getByTestId('automation-bypass').textContent).toBe(
      'ターゲット組織でこの実行が書き込みに使うユーザーにカスタム権限 Case_BypassFlow を割り当てると、開始条件でそれを除外しているフローは起動しなくなります。',
    );
  });
});
