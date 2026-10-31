import { describe, it, expect } from 'vitest';

import type {
  ForgeTargetAutomation,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
} from '../types/forge.types.js';
import {
  alsoLiftedWords,
  auditMutedOf,
  liftsUnreadWords,
  mutedAutomationOf,
  mutedEntryWords,
  mutePermissionsOf,
  mutePlanOf,
  stillRunsWords,
} from './automation-mute.js';
import { emailsPerInsertOf, firedOnInsert, firedOnWriteOf } from './forge-target-automation.js';

/** A flow read with its start condition, naming no permission unless told. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Account_After_Create',
    label: 'Account after create',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/** A flow its start condition keeps quiet for a holder of `permission`. */
function bypassed(permission: string, overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return flow({ permissions: [{ name: permission, bypass: true, held: false }], ...overrides });
}

function object(overrides: Partial<ForgeTargetObjectAutomation> = {}): ForgeTargetObjectAutomation {
  return { objectApiName: 'Account', flows: [], triggers: [], ...overrides };
}

/** A read of the target, with the permission sets that hold each bypass. */
function automation(
  objects: ForgeTargetObjectAutomation[],
  bypassGrants: ForgeTargetAutomation['bypassGrants'] = [],
): ForgeTargetAutomation {
  return {
    objectsRead: objects.map((o) => o.objectApiName),
    objects,
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants,
    requests: 1,
  };
}

const set = (name: string, grants = 1) => ({ name, label: name.replace(/_/g, ' '), grants });

describe('mutePlanOf', () => {
  it('assigns the smallest permission set holding the bypass, and says what it silences', () => {
    const read = automation(
      [object({ flows: [bypassed('Account_BypassFlow')] })],
      [
        {
          permission: 'Account_BypassFlow',
          permissionSets: [set('PS_Small', 2), set('PS_Big', 40)],
        },
      ],
    );
    expect(mutePlanOf(read)).toEqual({
      assign: [
        { permissionSet: 'PS_Small', label: 'PS Small', permissions: ['Account_BypassFlow'] },
      ],
      silenced: [
        {
          objectApiName: 'Account',
          kind: 'flow',
          name: 'Account after create',
          permission: 'Account_BypassFlow',
        },
      ],
      stillRuns: [],
      // The read does not say what the set grants: that is said, not taken for nothing.
      liftsUnread: [{ part: 'grants', permissionSet: 'PS_Small' }],
    });
  });

  it('reuses a set already chosen when it holds another bypass too, rather than assigning one more', () => {
    const read = automation(
      [
        object({
          flows: [
            bypassed('Bypass_A', { label: 'A' }),
            bypassed('Bypass_B', { label: 'B', apiName: 'B' }),
          ],
        }),
      ],
      [
        { permission: 'Bypass_A', permissionSets: [set('PS_All', 5)] },
        { permission: 'Bypass_B', permissionSets: [set('PS_B', 1), set('PS_All', 5)] },
      ],
    );
    const plan = mutePlanOf(read);
    expect(plan.assign).toEqual([
      { permissionSet: 'PS_All', label: 'PS All', permissions: ['Bypass_A', 'Bypass_B'] },
    ]);
    expect(plan.silenced.map((entry) => entry.name)).toEqual(['A', 'B']);
  });

  it('leaves out what a bypass the user already holds keeps quiet: it was quiet without the option', () => {
    const read = automation([
      object({ flows: [flow({ permissions: [{ name: 'Held', bypass: true, held: true }] })] }),
    ]);
    expect(mutePlanOf(read)).toEqual({ assign: [], silenced: [], stillRuns: [] });
  });

  it('says why each automation still runs: no bypass, a package, a condition not read, no set', () => {
    const read = automation(
      [
        object({
          flows: [
            flow({ label: 'Plain' }),
            flow({ label: 'Unread', apiName: 'Unread', condition: 'notRead' }),
            flow({ label: 'Packaged', apiName: 'pkg__Packaged', condition: 'unreadable' }),
            bypassed('Bypass_Nowhere', { label: 'Orphan bypass', apiName: 'Orphan' }),
          ],
          triggers: [
            { name: 'AccountTrigger', events: ['afterInsert'] },
            { name: 'pkg.PackageTrigger', events: ['beforeInsert'] },
          ],
        }),
      ],
      [{ permission: 'Bypass_Nowhere', permissionSets: [] }],
    );
    const plan = mutePlanOf(read);
    expect(plan.assign).toEqual([]);
    expect(plan.stillRuns.map(({ name, why }) => [name, why])).toEqual([
      ['AccountTrigger', 'noBypass'],
      ['pkg.PackageTrigger', 'managedPackage'],
      ['Plain', 'noBypass'],
      ['Unread', 'notRead'],
      ['Packaged', 'managedPackage'],
      ['Orphan bypass', 'noPermissionSet'],
    ]);
  });

  it('plans only for the writes the run makes: a flow on update alone is not muted for a run that inserts', () => {
    const read = automation(
      [object({ flows: [bypassed('Bypass_Update', { startsOn: 'update' })] })],
      [{ permission: 'Bypass_Update', permissionSets: [set('PS_Update')] }],
    );
    expect(mutePlanOf(read, (_object, write) => write === 'insert')).toEqual({
      assign: [],
      silenced: [],
      stillRuns: [],
    });
    expect(mutePlanOf(read).assign.map((a) => a.permissionSet)).toEqual(['PS_Update']);
  });

  it('lists an automation once though it fires on two writes', () => {
    const read = automation([
      object({ triggers: [{ name: 'Both', events: ['afterInsert', 'afterUpdate'] }] }),
    ]);
    expect(mutePlanOf(read).stillRuns).toHaveLength(1);
  });

  it('plans for a removal that brings records back: the triggers after an undelete still run', () => {
    const read = automation([
      object({ triggers: [{ name: 'Undeleted', events: ['afterUndelete'] }] }),
    ]);
    expect(
      mutePlanOf(read, (_object, write) => write === 'undelete').stillRuns.map((e) => e.name),
    ).toEqual(['Undeleted']);
  });
});

describe('what a mute lifts beside what it is assigned for', () => {
  /**
   * The trap org's shape: one set holding the bypass of a contact's flow and
   * workflow rule, and the bypass of two of its validation rules.
   */
  function trapShape(
    grants: Partial<{ customPermissions: string[]; customPermissionsUnread: string }>,
    lifts: Partial<ForgeTargetAutomation> = {},
  ): ForgeTargetAutomation {
    return {
      ...automation(
        [
          object({
            objectApiName: 'Contact',
            flows: [bypassed('Bypass_Flow', { label: 'Contact welcome email' })],
            workflowRules: [
              bypassed('Bypass_Flow', { label: 'Contact welcome', apiName: 'Contact_Welcome' }),
            ],
          }),
        ],
        [{ permission: 'Bypass_Flow', permissionSets: [{ ...set('PS_Bypass', 3), ...grants }] }],
      ),
      validationRuleBypasses: [
        { objectApiName: 'Contact', name: 'Email_Required', permissions: ['Bypass_VR'] },
        { objectApiName: 'Contact', name: 'Lead_Source_Locked', permissions: ['Bypass_VR'] },
      ],
      ...lifts,
    };
  }

  it('names both validation rules a set assigned for a flow’s bypass lifts with the other permission it grants', () => {
    const plan = mutePlanOf(trapShape({ customPermissions: ['Bypass_Flow', 'Bypass_VR'] }));
    expect(plan.assign.map((a) => [a.permissionSet, a.permissions])).toEqual([
      ['PS_Bypass', ['Bypass_Flow']],
    ]);
    expect(plan.silenced.map((entry) => entry.name)).toEqual([
      'Contact welcome',
      'Contact welcome email',
    ]);
    expect(plan.alsoLifts).toEqual([
      {
        objectApiName: 'Contact',
        kind: 'validationRule',
        name: 'Email_Required',
        permission: 'Bypass_VR',
        permissionSet: 'PS_Bypass',
      },
      {
        objectApiName: 'Contact',
        kind: 'validationRule',
        name: 'Lead_Source_Locked',
        permission: 'Bypass_VR',
        permissionSet: 'PS_Bypass',
      },
    ]);
    expect(plan.liftsUnread).toBeUndefined();
  });

  it('names nothing for a set that grants nothing beyond the bypass it is assigned for', () => {
    const plan = mutePlanOf(trapShape({ customPermissions: ['Bypass_Flow'] }));
    expect(plan.alsoLifts).toBeUndefined();
    expect(plan.liftsUnread).toBeUndefined();
  });

  it('says a set whose grants could not be read, and names nothing it may lift', () => {
    const plan = mutePlanOf(
      trapShape({ customPermissionsUnread: 'INSUFFICIENT_ACCESS: insufficient access rights' }),
    );
    expect(plan.alsoLifts).toBeUndefined();
    expect(plan.liftsUnread).toEqual([
      {
        part: 'grants',
        permissionSet: 'PS_Bypass',
        reason: 'INSUFFICIENT_ACCESS: insufficient access rights',
      },
    ]);
  });

  it('says validation rules not listed, or whose formula was not read, rather than taking them for none', () => {
    const granted = { customPermissions: ['Bypass_Flow', 'Bypass_VR'] };
    expect(
      mutePlanOf(
        trapShape(granted, {
          validationRuleBypasses: undefined,
          validationRulesUnread: 'INVALID_TYPE: sObject type is not supported',
        }),
      ).liftsUnread,
    ).toEqual([{ part: 'validationRules', reason: 'INVALID_TYPE: sObject type is not supported' }]);
    const partly = mutePlanOf(trapShape(granted, { validationRulesNotRead: 3 }));
    expect(partly.alsoLifts).toHaveLength(2);
    expect(partly.liftsUnread).toEqual([{ part: 'validationRules', rules: 3 }]);
  });

  it('names a flow the run’s writes do not start, which the set lets through as the target’s own automation updates', () => {
    const read = automation(
      [
        object({
          flows: [
            bypassed('Bypass_Flow', { label: 'On create' }),
            bypassed('Bypass_Other', { label: 'On update', apiName: 'Upd', startsOn: 'update' }),
          ],
        }),
      ],
      [
        {
          permission: 'Bypass_Flow',
          permissionSets: [
            { ...set('PS_Bypass'), customPermissions: ['Bypass_Flow', 'Bypass_Other'] },
          ],
        },
        { permission: 'Bypass_Other', permissionSets: [set('PS_Other')] },
      ],
    );
    const plan = mutePlanOf(
      { ...read, validationRuleBypasses: [] },
      (_object, write) => write === 'insert',
    );
    expect(plan.silenced.map((entry) => entry.name)).toEqual(['On create']);
    expect(plan.alsoLifts).toEqual([
      {
        objectApiName: 'Account',
        kind: 'flow',
        name: 'On update',
        permission: 'Bypass_Other',
        permissionSet: 'PS_Bypass',
      },
    ]);
  });

  it('leaves out a rule of an object the run does not write', () => {
    const plan = mutePlanOf(
      trapShape(
        { customPermissions: ['Bypass_Flow', 'Bypass_VR'] },
        {
          validationRuleBypasses: [
            { objectApiName: 'Lead', name: 'Lead_Rule', permissions: ['Bypass_VR'] },
          ],
        },
      ),
      (object) => object === 'Contact',
    );
    expect(plan.alsoLifts).toBeUndefined();
  });

  it('words what a set lifts as the lines name it', () => {
    expect(
      alsoLiftedWords({
        objectApiName: 'Contact',
        kind: 'validationRule',
        name: 'Email_Required',
        permission: 'Bypass_VR',
        permissionSet: 'PS_Bypass',
      }),
    ).toBe('validation rule "Email_Required" on Contact (Bypass_VR, in PS_Bypass)');
    expect(
      liftsUnreadWords({ part: 'grants', permissionSet: 'PS_Bypass', reason: 'refused' }),
    ).toBe('what PS_Bypass grants could not be read (refused): what else it lifts is not known');
  });
});

describe('mutedAutomationOf', () => {
  const read = automation(
    [
      object({
        flows: [
          bypassed('Account_BypassFlow', {
            messages: [{ kind: 'email', name: 'Welcome', limit: 'SingleEmail' }],
          }),
          flow({ label: 'Still', apiName: 'Still' }),
        ],
      }),
    ],
    [{ permission: 'Account_BypassFlow', permissionSets: [set('PS_Small')] }],
  );

  it('holds the bypasses muted, so every gate leaves out what they keep quiet and asks for what still runs', () => {
    const muted = mutedAutomationOf(read, ['account_bypassflow']);
    expect(firedOnInsert(read)).toBe(2);
    expect(firedOnInsert(muted)).toBe(1);
    expect(firedOnWriteOf(muted, 'insert').map((fired) => fired.name)).toEqual(['Still']);
    // What the muted flow sends is not counted against the day's emails.
    expect(emailsPerInsertOf(read)).toHaveLength(1);
    expect(emailsPerInsertOf(muted)).toEqual([]);
    expect(muted.bypassGrants).toEqual([]);
  });

  it('leaves the read as it was without a bypass to hold', () => {
    expect(mutedAutomationOf(read, [])).toBe(read);
  });
});

describe('the words of a mute', () => {
  it('names an automation by its object, its kind and its name, and why it still runs', () => {
    expect(mutedEntryWords({ objectApiName: 'Case', kind: 'trigger', name: 'CaseTrigger' })).toBe(
      'Case: Apex trigger "CaseTrigger"',
    );
    expect(stillRunsWords('managedPackage')).toBe('installed by a managed package');
  });

  it('keeps the sets by name and the automations by count in the audit trail', () => {
    expect(
      auditMutedOf({
        state: 'muted',
        assigned: ['PS_Small'],
        held: [],
        permissions: ['Account_BypassFlow'],
        silenced: [
          { objectApiName: 'Account', kind: 'flow', name: 'A', permission: 'Account_BypassFlow' },
        ],
        stillRan: [{ objectApiName: 'Account', kind: 'trigger', name: 'T', why: 'noBypass' }],
        released: true,
      }),
    ).toEqual({
      state: 'muted',
      assigned: ['PS_Small'],
      held: [],
      silenced: 1,
      stillRan: 1,
      released: true,
    });
  });

  it('counts in the audit trail what the sets lifted beside what they were assigned for', () => {
    const lifted = {
      objectApiName: 'Contact',
      kind: 'validationRule' as const,
      name: 'Email_Required',
      permission: 'Bypass_VR',
      permissionSet: 'PS_Bypass',
    };
    expect(
      auditMutedOf({
        state: 'muted',
        assigned: ['PS_Bypass'],
        held: [],
        permissions: ['Bypass_Flow'],
        silenced: [],
        stillRan: [],
        alsoLifted: [lifted, { ...lifted, name: 'Lead_Source_Locked' }],
      }),
    ).toMatchObject({ assigned: ['PS_Bypass'], alsoLifted: 2 });
  });

  it('lists each bypass a plan holds once', () => {
    expect(
      mutePermissionsOf({
        assign: [
          { permissionSet: 'A', label: 'A', permissions: ['Y', 'X'] },
          { permissionSet: 'B', label: 'B', permissions: ['X'] },
        ],
      }),
    ).toEqual(['X', 'Y']);
  });
});
