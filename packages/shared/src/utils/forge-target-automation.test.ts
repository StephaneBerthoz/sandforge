import { describe, it, expect } from 'vitest';

import type { ForgeTargetFlow, ForgeTargetObjectAutomation } from '../types/forge.types.js';
import {
  automationByWrite,
  bypassPermissionsOf,
  firedOnInsert,
} from './forge-target-automation.js';

/** A flow read with its start condition, naming no permission unless told. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Case_After_Create',
    label: 'Case after create',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/** An object of the run, and what the target runs on it. */
function object(overrides: Partial<ForgeTargetObjectAutomation> = {}): ForgeTargetObjectAutomation {
  return { objectApiName: 'Case', flows: [], triggers: [], ...overrides };
}

describe('automationByWrite', () => {
  it('lists a flow that starts on a created record under the insert alone', () => {
    const created = flow();
    expect(automationByWrite(object({ flows: [created] }))).toEqual([
      {
        write: 'insert',
        fired: [{ kind: 'flow', name: 'Case after create', when: 'after', flow: created }],
      },
    ]);
  });

  it('lists a flow that starts on a record created or updated under both writes', () => {
    const both = flow({
      label: 'Case defaults',
      timing: 'beforeSave',
      startsOn: 'createAndUpdate',
    });
    const byWrite = automationByWrite(object({ flows: [both] }));
    expect(byWrite.map((entry) => entry.write)).toEqual(['insert', 'update']);
    expect(byWrite.map((entry) => entry.fired[0].when)).toEqual(['before', 'before']);
  });

  it('lists a flow that starts on an updated record under the update alone', () => {
    const updated = flow({ startsOn: 'update' });
    expect(automationByWrite(object({ flows: [updated] })).map((entry) => entry.write)).toEqual([
      'update',
    ]);
  });

  it('lists a flow that runs before a delete under the delete, before it', () => {
    const deleted = flow({ timing: 'beforeDelete', startsOn: 'delete' });
    expect(automationByWrite(object({ flows: [deleted] }))).toEqual([
      {
        write: 'delete',
        fired: [{ kind: 'flow', name: 'Case after create', when: 'before', flow: deleted }],
      },
    ]);
  });

  it('says of a trigger whether it runs before the write, after it or both, write by write', () => {
    const byWrite = automationByWrite(
      object({
        triggers: [
          {
            name: 'CaseTrigger',
            events: ['beforeInsert', 'afterInsert', 'afterUpdate', 'beforeDelete'],
          },
        ],
      }),
    );
    expect(byWrite).toEqual([
      {
        write: 'insert',
        fired: [{ kind: 'trigger', name: 'CaseTrigger', when: 'beforeAndAfter' }],
      },
      { write: 'update', fired: [{ kind: 'trigger', name: 'CaseTrigger', when: 'after' }] },
      { write: 'delete', fired: [{ kind: 'trigger', name: 'CaseTrigger', when: 'before' }] },
    ]);
  });

  it('leaves out a trigger that runs only on an undelete, which no run makes', () => {
    expect(
      automationByWrite(
        object({ triggers: [{ name: 'CaseUndelete', events: ['afterUndelete'] }] }),
      ),
    ).toEqual([]);
  });

  it('orders a write as the platform runs it: flows before the save, triggers, flows after it', () => {
    const after = flow({ label: 'After' });
    const before = flow({ label: 'Before', timing: 'beforeSave' });
    const [insert] = automationByWrite(
      object({
        flows: [after, before],
        triggers: [{ name: 'Trigger', events: ['beforeInsert'] }],
      }),
    );
    expect(insert.fired.map((fired) => fired.name)).toEqual(['Before', 'Trigger', 'After']);
  });

  it('lists nothing for an object that runs nothing', () => {
    expect(automationByWrite(object())).toEqual([]);
  });
});

describe('bypassPermissionsOf', () => {
  it('names each permission that keeps a flow quiet once, in name order', () => {
    const automation = {
      objects: [
        object({
          flows: [
            flow({ permissions: [{ name: 'Case_BypassFlow', bypass: true }] }),
            flow({
              permissions: [
                { name: 'Bypass_All', bypass: true },
                { name: 'Case_BypassFlow', bypass: true },
              ],
            }),
          ],
        }),
        object({
          objectApiName: 'Contact',
          flows: [flow({ permissions: [{ name: 'Bypass_All', bypass: true }] })],
        }),
      ],
    };
    expect(bypassPermissionsOf(automation)).toEqual(['Bypass_All', 'Case_BypassFlow']);
  });

  it('leaves out a permission a start condition names without keeping the flow quiet for it', () => {
    // `{!$Permission.Run_Sync}` alone starts the flow for the users who hold
    // it: assigning it would make the flow fire, not keep it quiet.
    const automation = {
      objects: [object({ flows: [flow({ permissions: [{ name: 'Run_Sync', bypass: false }] })] })],
    };
    expect(bypassPermissionsOf(automation)).toEqual([]);
  });
});

describe('firedOnInsert', () => {
  it('counts the flows and the triggers that fire as the run inserts, and nothing else', () => {
    const automation = {
      objects: [
        object({
          flows: [
            flow(),
            flow({ startsOn: 'createAndUpdate', timing: 'beforeSave' }),
            flow({ startsOn: 'update' }),
            flow({ startsOn: 'delete', timing: 'beforeDelete' }),
          ],
          triggers: [
            { name: 'CaseTrigger', events: ['beforeInsert', 'afterInsert'] },
            { name: 'CaseUpdate', events: ['afterUpdate'] },
          ],
        }),
        object({ objectApiName: 'Contact', flows: [flow()] }),
      ],
    };
    // Two flows and a trigger on Case, a flow on Contact.
    expect(firedOnInsert(automation)).toBe(4);
  });

  it('counts none when nothing fires on an insert', () => {
    expect(firedOnInsert({ objects: [object({ flows: [flow({ startsOn: 'update' })] })] })).toBe(0);
  });
});
