import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '../../i18n';
import ja from '../../i18n/locales/ja.json';
import type { ForgeConfig, ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewAutomationTab, forgeRunMuteOffer } from './ReviewAutomationTab';

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

  describe('the box that mutes what the run fires', () => {
    /** A flow on insert a set of the target silences, and a trigger nothing silences. */
    const MUTABLE = automation({
      objects: [
        {
          objectApiName: 'Case',
          flows: [flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true, held: false }] })],
          triggers: [{ name: 'CaseTrigger', events: ['afterInsert'] }],
        },
      ],
      bypassGrants: [
        {
          permission: 'Case_BypassFlow',
          permissionSets: [{ name: 'Bypass_Flows', label: 'Bypass flows', grants: 1 }],
        },
      ],
    });

    /** The tab with its box, planned from `read` as Review plans it. */
    function withBox(
      read: ForgeTargetAutomation,
      checked = false,
      onChange = vi.fn(),
      leftOut: ReadonlySet<string> = new Set(),
    ) {
      return render(
        <ReviewAutomationTab
          automation={read}
          leftOut={leftOut}
          mute={{ offer: forgeRunMuteOffer(read, leftOut), checked, onChange, org: 'DEV-SANDBOX' }}
        />,
      );
    }

    it('is offered, unticked, beside what fires, with the set it assigns, what it silences and what still runs', () => {
      const onChange = vi.fn();
      withBox(MUTABLE, false, onChange);

      expect((screen.getByTestId('automation-mute-toggle') as HTMLInputElement).checked).toBe(
        false,
      );
      expect(screen.getByTestId('automation-mute-assigns').textContent).toBe(
        'Assigns the permission set Bypass_Flows to the user the run writes as in DEV-SANDBOX, for this run alone, and takes it back as the run ends.',
      );
      expect(screen.getByTestId('automation-mute-silenced-Case').textContent).toBe(
        'Case: Flow: Case notify customer · bypass Case_BypassFlow',
      );
      expect(screen.getByTestId('automation-mute-still-runs-Case').textContent).toBe(
        'Case: Apex trigger: CaseTrigger · nothing in it tests a bypass',
      );
      fireEvent.click(screen.getByTestId('automation-mute-toggle'));
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('is not offered when the user holds the bypass already, or nothing fires has one', () => {
      const held = automation({
        objects: [
          {
            objectApiName: 'Case',
            flows: [flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true, held: true }] })],
            triggers: [{ name: 'CaseTrigger', events: ['afterInsert'] }],
          },
        ],
        bypassGrants: MUTABLE.bypassGrants,
      });
      const { unmount } = withBox(held);
      expect(screen.queryByTestId('automation-mute')).toBeNull();
      unmount();

      // A bypass no permission set holds silences nothing either.
      withBox({
        ...MUTABLE,
        bypassGrants: [{ permission: 'Case_BypassFlow', permissionSets: [] }],
      });
      expect(screen.queryByTestId('automation-mute')).toBeNull();
    });

    it('leaves out an object the user left out of the run, and is not offered once none is left', () => {
      withBox(MUTABLE, false, vi.fn(), new Set(['Case']));
      expect(screen.queryByTestId('automation-mute')).toBeNull();
    });

    it('is not offered without its owner', () => {
      render(<ReviewAutomationTab automation={MUTABLE} />);
      expect(screen.queryByTestId('automation-mute')).toBeNull();
    });
  });

  describe('reading the target again', () => {
    /** A flow a bypass the user does not hold would keep quiet, and the permission set holding it. */
    const NOT_HELD = automation({
      objects: [
        {
          objectApiName: 'Case',
          flows: [flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true, held: false }] })],
          triggers: [],
        },
      ],
      bypassGrants: [
        {
          permission: 'Case_BypassFlow',
          permissionSets: [{ name: 'Bypass_Flows', label: 'Bypass flows', grants: 1 }],
        },
      ],
    });
    const TARGET = { alias: 'DEV-SANDBOX', username: 'loader@example.com.dev' };

    it('offers it under the command that assigns the bypass and below the read, and asks for it from either', () => {
      const onReadAgain = vi.fn();
      render(
        <ReviewAutomationTab automation={NOT_HELD} target={TARGET} onReadAgain={onReadAgain} />,
      );

      const bypass = screen.getByTestId('automation-bypass');
      expect(within(bypass).getByTestId('bypass-assistant').textContent).toContain(
        'Once the command has run, read the target org again: the bypass then shows as held.',
      );
      const fromAssistant = within(bypass).getByTestId('bypass-assistant-read-again');
      expect(fromAssistant.textContent).toBe('Read the target org again');
      fireEvent.click(fromAssistant);
      const fromTab = screen.getByTestId('automation-read-again');
      expect(fromTab.textContent).toBe('Read again');
      fireEvent.click(fromTab);

      expect(onReadAgain).toHaveBeenCalledTimes(2);
    });

    it('says it is reading while the read is on its way, keeps the read shown, and asks nothing more meanwhile', () => {
      const onReadAgain = vi.fn();
      render(
        <ReviewAutomationTab
          automation={NOT_HELD}
          target={TARGET}
          onReadAgain={onReadAgain}
          readingAgain
        />,
      );

      const fromTab = screen.getByTestId('automation-read-again');
      const fromAssistant = screen.getByTestId('bypass-assistant-read-again');
      for (const button of [fromTab, fromAssistant]) {
        expect(button.textContent).toBe('Reading again…');
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(button);
      }
      expect(onReadAgain).not.toHaveBeenCalled();
      expect(screen.getByTestId('automation-bypass')).toBeDefined();
    });

    it('offers it after a read that could not run', () => {
      const onReadAgain = vi.fn();
      render(
        <ReviewAutomationTab automation={null} error="session expired" onReadAgain={onReadAgain} />,
      );

      fireEvent.click(screen.getByTestId('automation-read-again'));

      expect(onReadAgain).toHaveBeenCalledTimes(1);
    });

    it('offers nothing when nobody can ask for the read', () => {
      render(<ReviewAutomationTab automation={NOT_HELD} target={TARGET} />);

      expect(screen.queryByTestId('automation-read-again')).toBeNull();
      expect(screen.queryByTestId('bypass-assistant-read-again')).toBeNull();
    });
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
      'The start condition of 1 flow was not read: the read takes 25 at most.',
    );
    expect(screen.getByTestId('automation-unread-conditions').textContent).toBe(
      'The start conditions of some flows could not be read: INSUFFICIENT_ACCESS: no access',
    );
  });

  it('names the objects whose start conditions the bound left unread, and how many on each', () => {
    render(
      <ReviewAutomationTab
        automation={automation({
          objectsRead: ['Case', 'Contact', 'Task'],
          conditionsNotRead: 1_217,
          conditionsBound: 500,
          conditionsNotReadOn: [
            { objectApiName: 'Contact', flows: 1_200 },
            { objectApiName: 'Task', flows: 17 },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('automation-not-read').textContent).toBe(
      'The start conditions of 1217 flows were not read: the read takes 500 at most. ' +
        'Left unread on Contact (1,200), Task (17).',
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
      'The definitions of 3 processes or workflow rules were not read: the read takes 15 at most.',
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
      ja.forgeRun.review.automation.intro,
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

  describe('whether the target delivers the emails of what still runs', () => {
    const SENDS_EMAIL = flow({
      messages: [{ kind: 'email', name: 'Notify customer', limit: 'SingleEmail' }],
    });
    const QUIET_BY_BYPASS = flow({
      apiName: 'Contact_Welcome',
      label: 'Contact welcome',
      messages: [{ kind: 'email', name: 'Welcome', limit: 'SingleEmail' }],
      permissions: [{ name: 'Skip_Flows', bypass: true, held: false }],
    });
    const read = (overrides: Partial<ForgeTargetAutomation> = {}): ForgeTargetAutomation =>
      automation({
        objects: [
          { objectApiName: 'Case', flows: [SENDS_EMAIL], triggers: [] },
          { objectApiName: 'Contact', flows: [QUIET_BY_BYPASS], triggers: [] },
        ],
        bypassGrants: [
          {
            permission: 'Skip_Flows',
            permissionSets: [{ name: 'Skip_Set', label: 'Skip', grants: 1 }],
          },
        ],
        deliverability: { level: 'all' },
        ...overrides,
      });
    const tab = (
      shown: ForgeTargetAutomation,
      options: { leftOut?: ReadonlySet<string>; muted?: boolean } = {},
    ) => (
      <ReviewAutomationTab
        automation={shown}
        leftOut={options.leftOut ?? new Set<string>()}
        mute={{
          offer: forgeRunMuteOffer(shown, options.leftOut ?? new Set<string>()),
          checked: options.muted === true,
          onChange: vi.fn(),
          org: 'TGT-DEV',
        }}
      />
    );

    it('says the target delivers them, names who sends, and that the run reads the org again', () => {
      render(tab(read()));

      expect(screen.getByTestId('automation-deliverability-reading').textContent).toBe(
        'TGT-DEV delivers every email its automation sends (Setup > Deliverability: All email), and what still runs as the run writes may send some: Flow “Case notify customer” on Case and Flow “Contact welcome” on Contact.',
      );
      expect(screen.getByTestId('automation-deliverability-read-again').textContent).toBe(
        'The run reads TGT-DEV again just before it writes, and asks first if they would go out.',
      );
    });

    it('says nothing goes out of a target that withholds them', () => {
      render(tab(read({ deliverability: { level: 'withheld' } })));

      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'TGT-DEV delivers none of the emails',
      );
      expect(screen.queryByTestId('automation-deliverability-addresses')).toBeNull();
    });

    it('says why a target would not say, as the host read it: a production org runs no Apex', () => {
      render(tab(read({ deliverability: { unread: 'no Apex runs in a production org' } })));

      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'could not be read (no Apex runs in a production org)',
      );
    });

    it('takes what the ticked mute keeps quiet off who sends, and nothing while it is unticked', () => {
      const { unmount } = render(tab(read(), { muted: true }));
      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'may send some: Flow “Case notify customer” on Case.',
      );
      unmount();

      render(tab(read()));
      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'Flow “Contact welcome” on Contact',
      );
    });

    it('says the mute leaves nothing to send when it keeps every sender quiet', () => {
      render(tab(read(), { muted: true, leftOut: new Set(['Case']) }));

      expect(screen.queryByTestId('automation-deliverability')).toBeNull();
      expect(screen.getByTestId('automation-deliverability-quiet').textContent).toBe(
        'What sends emails as the run writes tests a bypass: muted, none of it sends, and nothing is asked of them.',
      );
    });

    it('says nothing of an object left out of the run, nor once no sender is left', () => {
      render(tab(read(), { leftOut: new Set(['Case', 'Contact']) }));

      expect(screen.queryByTestId('automation-deliverability')).toBeNull();
      expect(screen.queryByTestId('automation-deliverability-quiet')).toBeNull();
    });

    it('says what could not be read of the flows may send some, with no sender listed', () => {
      render(
        tab(
          automation({
            objects: [],
            unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS' }],
            deliverability: { level: 'all' },
          }),
        ),
      );

      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'may send some: what of its automation could not be read.',
      );
    });

    it('counts the assignment rules the run applies among who sends, and none it does not', () => {
      const shown = read({
        objects: [
          {
            objectApiName: 'Case',
            flows: [SENDS_EMAIL],
            triggers: [],
            assignmentRules: [{ name: 'Route cases' }],
          },
        ],
      });
      const { unmount } = render(tab(shown));
      expect(screen.getByTestId('automation-deliverability-reading').textContent).not.toContain(
        'Route cases',
      );
      unmount();

      useForgeStore.setState({ config: { ...RUN, applyAssignmentRules: true } });
      render(tab(shown));
      expect(screen.getByTestId('automation-deliverability-reading').textContent).toContain(
        'Assignment rule “Route cases” on Case (applied: it can mail the owner it assigns)',
      );
    });

    it('says nothing when the read found nothing that sends, the deliverability unread', () => {
      render(
        tab(automation({ objects: [{ objectApiName: 'Case', flows: [flow()], triggers: [] }] })),
      );

      expect(screen.queryByTestId('automation-deliverability')).toBeNull();
    });
  });
});
