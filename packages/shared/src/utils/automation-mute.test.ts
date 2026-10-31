import { describe, it, expect } from 'vitest';

import type {
  ForgeTargetAutomation,
  ForgeTargetFlow,
  ForgeTargetObjectAutomation,
} from '../types/forge.types.js';
import {
  auditMutedOf,
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
