import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '../../i18n';
import ja from '../../i18n/locales/ja.json';
import type { ForgeConfig, ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewAutomationTab } from './ReviewAutomationTab';

/** The run Review is about to start. */
const RUN: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

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
    useForgeStore.setState({ config: null });
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
      'Nothing the target org automates runs on the 2 objects this run writes: no active flow, process, workflow rule, Apex trigger, assignment rule or duplicate rule.',
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

  it('gives under a bypass the user does not hold the permission set that holds it and the command that assigns it', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow({
                  permissions: [
                    { name: 'Case_BypassFlow', bypass: true, held: false },
                    { name: 'Skip_All', bypass: true, held: false },
                  ],
                }),
              ],
              triggers: [],
            },
          ],
          bypassGrants: [
            {
              permission: 'Case_BypassFlow',
              permissionSets: [{ name: 'Bypass_Flows', label: 'Bypass flows', grants: 1 }],
            },
            { permission: 'Skip_All', permissionSets: [] },
          ],
        })}
        target={{ alias: 'DEV-SANDBOX', username: 'loader@example.com.dev' }}
      />,
    );

    const bypass = screen.getByTestId('automation-bypass');
    expect(within(bypass).getByTestId('bypass-assistant-command').textContent).toBe(
      'sf org assign permset --name Bypass_Flows --target-org DEV-SANDBOX --on-behalf-of loader@example.com.dev',
    );
    expect(within(bypass).getByTestId('bypass-assistant-Skip_All').textContent).toContain(
      'No permission set of the target org holds Skip_All',
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
      'Nothing the target org automates runs on the object this run writes: no active flow, process, workflow rule, Apex trigger, assignment rule or duplicate rule.',
    );
  });

  it('names the processes and workflow rules of a write, in the order the platform runs them', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [flow()],
              triggers: [{ name: 'CaseTrigger', events: ['afterInsert'] }],
              processes: [flow({ apiName: 'Case_Routing', label: 'Case routing' })],
              workflowRules: [
                flow({ apiName: 'Notify_owner', label: 'Notify owner', condition: 'notRead' }),
              ],
            },
          ],
        })}
      />,
    );

    expect(
      within(screen.getByTestId('automation-Case-insert'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Apex trigger: CaseTrigger · after save',
      'Workflow rule: Notify owner · after saveDefinition not read',
      'Process: Case routing · after save',
      'Flow: Case notify customer · after save',
    ]);
  });

  it('marks what sends messages with a badge, says each message, and calls the text message a guess', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow({
                  messages: [
                    { kind: 'email', name: 'Notify customer' },
                    { kind: 'notification', name: 'Ping owner' },
                    { kind: 'outbound', name: 'Push to ERP' },
                    { kind: 'sms', name: 'Send SMS', guessed: true },
                  ],
                }),
                flow({ apiName: 'Case_Quiet', label: 'Case quiet' }),
              ],
              triggers: [],
            },
          ],
        })}
      />,
    );

    const badges = screen.getAllByTestId('automation-sends-messages');
    expect(badges.map((badge) => badge.textContent)).toEqual(['Sends messages']);
    expect(screen.getAllByRole('listitem')[0].textContent).toBe(
      'Flow: Case notify customer · after save Sends messages' +
        'Email: Notify customer' +
        'Custom notification: Ping owner' +
        'Outbound message: Push to ERP' +
        'Text message: Send SMS (guessed from the name of an Apex action)',
    );
  });

  it('says what runs once the save is committed: the asynchronous path, and each scheduled path with its offset', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Contact',
              flows: [
                flow({
                  paths: [
                    { kind: 'async', label: 'Run Asynchronously' },
                    { kind: 'scheduled', label: 'Follow up', offset: 2, unit: 'Days' },
                    { kind: 'scheduled', offset: -1, unit: 'Hours', field: 'Birthdate' },
                    { kind: 'scheduled', offset: 30, unit: 'Minutes', field: 'EndDate' },
                    { kind: 'scheduled' },
                  ],
                }),
              ],
              triggers: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('listitem').textContent).toBe(
      'Flow: Case notify customer · after save' +
        'Also runs once the save is committed: its asynchronous path' +
        'Also runs once the save is committed: a scheduled path 2 days after the save' +
        'Also runs once the save is committed: a scheduled path 1 hour before Birthdate' +
        'Also runs once the save is committed: a scheduled path 30 minutes after EndDate' +
        'Also runs once the save is committed: a scheduled path',
    );
  });

  it('says whether the user the run writes as holds a bypass, keeps the flow quiet when it does, and asks to assign only the others', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow({ permissions: [{ name: 'Load_Data', bypass: true, held: true }] }),
                flow({
                  apiName: 'Case_Other',
                  label: 'Case other',
                  permissions: [{ name: 'Bypass_All', bypass: true, held: false }],
                }),
              ],
              triggers: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Flow: Case notify customer · after save' +
        'Does not start for a user with the custom permission Load_Data' +
        'The user the run writes as holds Load_Data' +
        'Stays quiet for this run',
      'Flow: Case other · after save' +
        'Does not start for a user with the custom permission Bypass_All' +
        'The user the run writes as does not hold Bypass_All',
    ]);
    expect(screen.getByTestId('automation-bypass').textContent).toBe(
      'Assign the custom permission Bypass_All to the user the run writes as in the target org, and the flows whose start condition excludes it stay quiet.',
    );
    expect(screen.getByTestId('automation-bypass-held').textContent).toBe(
      'The user the run writes as in the target org holds the custom permission Load_Data: what excludes it stays quiet for this run.',
    );
  });

  it("says the settings, user fields and profiles a flow's start or first decision ends it on, and what its decisions test", () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Case',
              flows: [
                flow({
                  permissions: [
                    { name: 'Skip_Flows', bypass: true, where: 'decision' },
                    { name: 'Run_Sync', bypass: false, where: 'decision' },
                  ],
                  switches: [
                    { reference: '$Setup.Bypass__c.Flows__c', where: 'start', bypass: true },
                    {
                      reference: '$Profile.Name',
                      value: 'Integration',
                      where: 'decision',
                      bypass: true,
                    },
                    { reference: '$User.Region__c', where: 'decision', bypass: false },
                  ],
                }),
              ],
              triggers: [],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole('listitem').textContent).toBe(
      'Flow: Case notify customer · after save' +
        'Its first decision ends it for a user with the custom permission Skip_Flows' +
        'Does not start when $Setup.Bypass__c.Flows__c is true' +
        'Its first decision ends it when $Profile.Name is “Integration”' +
        'Its decisions test Run_Sync, $User.Region__c',
    );
  });

  it('says the assignment rule is not applied unless the run applies it, and what the duplicate rules still refuse', () => {
    const ruled = automation({
      objectsRead: ['Lead'],
      objects: [
        {
          objectApiName: 'Lead',
          flows: [],
          triggers: [],
          assignmentRules: [{ name: 'Lead routing' }],
          duplicateRules: [
            { name: 'Lead email', developerName: 'Lead_Email' },
            { name: 'Lead name', developerName: 'Lead_Name' },
          ],
        },
      ],
    });
    const { rerender } = render(<ReviewAutomationTab automation={ruled} />);

    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'As the run writes its records, the target org runs:',
    );
    const rules = () =>
      within(screen.getByTestId('automation-Lead-rules'))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
    // Under a heading of their own, apart from what the last write fires.
    expect(screen.getByTestId('automation-Lead-rules').firstElementChild?.textContent).toBe(
      'Assignment and duplicate rules',
    );
    expect(rules()).toEqual([
      'Assignment rule: Lead routing' +
        'Not applied: the run keeps the owner it sets, and asks the target org not to apply its assignment rules (Sforce-Auto-Assign: FALSE)',
      'Duplicate rules: Lead email, Lead name' +
        'The run saves a record a rule only alerts on; a rule that blocks still refuses it.',
    ]);
    // No run to set it on, no switch.
    expect(screen.queryByTestId('automation-Lead-apply-assignment')).toBeNull();

    act(() => useForgeStore.setState({ config: { ...RUN, applyAssignmentRules: true } }));
    rerender(<ReviewAutomationTab automation={ruled} />);
    expect(rules()[0]).toBe(
      'Assignment rule: Lead routing' +
        'Applied: this run asks the target org to apply it, and it can give the records another owner and email that owner' +
        "Apply the target org's assignment rules on this run: they can give the records another owner, and email that owner",
    );
  });

  it('lets the run apply the assignment rules from the line that says whether it does, off by default', () => {
    useForgeStore.setState({ config: { ...RUN } });
    render(
      <ReviewAutomationTab
        automation={automation({
          objectsRead: ['Lead'],
          objects: [
            {
              objectApiName: 'Lead',
              flows: [],
              triggers: [],
              assignmentRules: [{ name: 'Lead routing' }],
            },
          ],
        })}
      />,
    );
    const toggle = screen.getByRole('checkbox', {
      name: "Apply the target org's assignment rules on this run: they can give the records another owner, and email that owner",
    }) as HTMLInputElement;
    const line = () => within(screen.getByTestId('automation-Lead-rules')).getByRole('listitem');

    expect(toggle.checked).toBe(false);
    expect(line().textContent).toContain('Not applied');
    expect(useForgeStore.getState().config).not.toHaveProperty('applyAssignmentRules');

    fireEvent.click(toggle);
    expect(useForgeStore.getState().config?.applyAssignmentRules).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(line().textContent).toContain(
      'Applied: this run asks the target org to apply it, and it can give the records another owner and email that owner',
    );

    // Turned off again, the run says nothing of them: off is the default.
    fireEvent.click(toggle);
    expect(useForgeStore.getState().config).not.toHaveProperty('applyAssignmentRules');
    expect(line().textContent).toContain('Not applied');
    // The rest of the run is left as it was.
    expect(useForgeStore.getState().config).toEqual(RUN);
  });

  it('says what it left unread of the processes and workflow rules, and the parts it could not read', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          unread: [
            { part: 'processes', reason: 'INSUFFICIENT_ACCESS: a' },
            { part: 'workflowRules', reason: 'INSUFFICIENT_ACCESS: b' },
            { part: 'definitions', reason: 'INSUFFICIENT_ACCESS: c' },
            { part: 'assignmentRules', reason: 'INSUFFICIENT_ACCESS: d' },
            { part: 'duplicateRules', reason: 'INSUFFICIENT_ACCESS: e' },
            { part: 'userPermissions', reason: 'INVALID_TYPE: f' },
          ],
          definitionsNotRead: 3,
          definitionsBound: 15,
        })}
      />,
    );

    expect(screen.getByTestId('automation-summary').textContent).toBe(
      'Nothing was found in what could be read.',
    );
    expect(screen.getByTestId('automation-definitions-not-read').textContent).toBe(
      'The definitions of 3 processes or workflow rules were not read: the read takes 15 at most, one request each.',
    );
    expect(
      [
        'processes',
        'workflowRules',
        'definitions',
        'assignmentRules',
        'duplicateRules',
        'userPermissions',
      ].map((part) => screen.getByTestId(`automation-unread-${part}`).textContent),
    ).toEqual([
      'The Process Builder processes of the target org could not be read: INSUFFICIENT_ACCESS: a',
      'The workflow rules of the target org could not be read: INSUFFICIENT_ACCESS: b',
      'The definitions of some processes or workflow rules could not be read: INSUFFICIENT_ACCESS: c',
      'The assignment rules of the target org could not be read: INSUFFICIENT_ACCESS: d',
      'The duplicate rules of the target org could not be read: INSUFFICIENT_ACCESS: e',
      'The custom permissions of the user the run writes as could not be read: INVALID_TYPE: f',
    ]);
  });

  it('still says nothing runs when only the pieces read one by one were refused', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          unread: [{ part: 'userPermissions', reason: 'INVALID_TYPE: not supported' }],
        })}
      />,
    );
    expect(screen.getByTestId('automation-summary').textContent).toContain(
      'Nothing the target org automates runs on the 2 objects this run writes',
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

  it('writes the offset of a scheduled path and the badge in the language the panel is set to', async () => {
    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await i18n.changeLanguage('ja');
    render(
      <ReviewAutomationTab
        automation={automation({
          objects: [
            {
              objectApiName: 'Contact',
              flows: [
                flow({
                  paths: [{ kind: 'scheduled', offset: 2, unit: 'Days' }],
                  messages: [{ kind: 'email', name: 'Welcome' }],
                }),
              ],
              triggers: [],
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('automation-sends-messages').textContent).toBe('メッセージを送信');
    expect(screen.getByRole('listitem').textContent).toContain(
      '保存がコミットされた後にも実行: 保存の 2 日後のスケジュール済みパス',
    );
  });

  describe("what may refuse a removal of the run's records", () => {
    it('names a flow before a delete, a trigger on one, a managed package trigger, and records that lock past Draft', () => {
      render(
        <ReviewAutomationTab
          automation={automation({
            objectsRead: ['Case', 'Order'],
            objects: [
              {
                objectApiName: 'Case',
                flows: [
                  flow(),
                  flow({
                    apiName: 'Case_Guard',
                    label: 'Case guard',
                    timing: 'beforeDelete',
                    startsOn: 'delete',
                  }),
                ],
                triggers: [
                  { name: 'CaseDelete', events: ['beforeDelete'] },
                  { name: 'pkg.CaseAudit', events: ['afterDelete'] },
                ],
              },
            ],
          })}
        />,
      );

      const said = screen.getByTestId('automation-removal');
      expect(said.textContent).toContain("A removal of this run's records may be refused:");
      expect(
        within(said)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Case: Flow "Case guard" runs before a record is deleted, and can refuse the delete',
        'Case: Apex trigger CaseDelete runs on a delete, and can refuse it',
        'Case: Apex trigger pkg.CaseAudit, installed by a managed package, runs on a delete and can refuse it; no one in the org can change it',
        'Order: once activated, a record locks the records under it, which a removal then takes only with it, or once it is back in Draft',
      ]);
      expect(screen.queryByTestId('automation-removal-none')).toBeNull();
    });

    it('says none was found once everything was read, and leaves that unsaid when a part could not be', () => {
      const { unmount } = render(<ReviewAutomationTab automation={automation()} />);
      expect(screen.getByTestId('automation-removal-none').textContent).toBe(
        "Nothing found that would refuse a removal of this run's records: no Flow before a delete, no Apex trigger on one, no record that locks past Draft.",
      );
      unmount();

      render(
        <ReviewAutomationTab
          automation={automation({ unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }] })}
        />,
      );
      expect(screen.queryByTestId('automation-removal-none')).toBeNull();
      expect(screen.queryByTestId('automation-removal')).toBeNull();
    });

    it('leaves out an object the user has left out of the run since the read', () => {
      render(
        <ReviewAutomationTab
          automation={automation({ objectsRead: ['Case', 'Order'] })}
          leftOut={new Set(['Order'])}
        />,
      );

      expect(screen.queryByTestId('automation-removal')).toBeNull();
      expect(screen.getByTestId('automation-removal-none')).toBeDefined();
    });
  });
});
