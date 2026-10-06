import { describe, it, expect, vi } from 'vitest';
import type {
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeTargetAutomation,
  ForgeTargetFlow,
} from '@sandforge/shared';
import {
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  DEFAULT_MAX_TOTAL,
  ForgeRunGateError,
  automationRefusal,
  automationUnreadOf,
  bypassesToAssign,
  confirmationStorageOf,
  firedOnInsertOf,
  firedOnUpdateOf,
  forgeTargetTier,
  formatMB,
  isDeveloperEdition,
  isForgeRunGateError,
  objectsUpdatedAfterInsert,
  readDataStorage,
  removalAutomationLines,
  removalAutomationRefusal,
  rowStorageBytes,
  runBypassesOf,
  storageCheckOf,
  storageRefusal,
  updateStepsOf,
  writePlanLines,
  writePlanOf,
} from './ForgeRunGate.js';

const KB = 1024;
const MB = 1024 * KB;

/** `n` rows of an object, as the run holds them. */
const rows = (n: number, row: Record<string, unknown> = {}): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ Id: `row-${i}`, ...row }));

describe('the data storage a row takes, by the sizes Salesforce documents', () => {
  it('counts most records at 2 KB whatever their fields hold', () => {
    expect(rowStorageBytes('Opportunity', { Name: 'x'.repeat(5_000) })).toBe(2 * KB);
    expect(rowStorageBytes('Custom__c', {})).toBe(2 * KB);
    expect(rowStorageBytes('Account', { Name: 'Acme' })).toBe(2 * KB);
  });

  it('counts a person account at 4 KB, and its contact at nothing more', () => {
    expect(rowStorageBytes('Account', { IsPersonAccount: true })).toBe(4 * KB);
    expect(rowStorageBytes('Contact', { IsPersonAccount: true })).toBe(0);
    expect(rowStorageBytes('Contact', { IsPersonAccount: false })).toBe(2 * KB);
  });

  it('counts a campaign at 8 KB and a campaign member at 1 KB', () => {
    expect(rowStorageBytes('Campaign', {})).toBe(8 * KB);
    expect(rowStorageBytes('CampaignMember', {})).toBe(1 * KB);
  });

  it('counts an article at 4 KB and the long text it holds besides', () => {
    expect(rowStorageBytes('Knowledge__kav', { Title: 'Reset a password' })).toBe(4 * KB);
    expect(rowStorageBytes('Knowledge__kav', { Title: 'T', Body__c: 'é'.repeat(1_000) })).toBe(
      4 * KB + 2_000,
    );
  });

  it('counts an email message at its actual size', () => {
    expect(
      rowStorageBytes('EmailMessage', { Subject: 'Hello', TextBody: 'é'.repeat(10), Id: 'x' }),
    ).toBe(5 + 20 + 1);
  });
});

describe('the tier a run takes its target for', () => {
  it('takes a Developer Edition org, registered as production, for a development org', () => {
    expect(forgeTargetTier('Production', 'Developer Edition')).toBe('development');
    expect(isDeveloperEdition(' developer edition ')).toBe(true);
  });

  it('keeps every other production org, and one of unknown edition, production', () => {
    expect(forgeTargetTier('Production', 'Enterprise Edition')).toBe('production');
    expect(forgeTargetTier('Production', '')).toBe('production');
    expect(forgeTargetTier('Production', undefined)).toBe('production');
    expect(forgeTargetTier('', 'Developer Edition')).toBe('development');
    expect(forgeTargetTier('', undefined)).toBe('production');
  });

  it('leaves sandboxes and scratch orgs as the guard tiers them', () => {
    expect(forgeTargetTier('Sandbox', 'Enterprise Edition')).toBe('development');
    expect(forgeTargetTier('Scratch', undefined)).toBe('scratch');
  });
});

describe('writePlanOf', () => {
  it('counts the rows to write per object, the most first, and in all', () => {
    const plan = writePlanOf([
      { objectApiName: 'Account', rows: rows(2) },
      { objectApiName: 'Contact', rows: rows(5) },
      { objectApiName: 'Case', rows: [] },
      { objectApiName: 'Campaign', rows: rows(2) },
    ]);

    expect(plan.objects.map(({ objectApiName, rows: n }) => [objectApiName, n])).toEqual([
      ['Contact', 5],
      ['Account', 2],
      ['Campaign', 2],
    ]);
    expect(plan.totalRows).toBe(9);
    expect(plan.storageBytes).toBe(7 * 2 * KB + 2 * 8 * KB);
  });
});

describe('readDataStorage', () => {
  it('reads the data storage the org says it has, from its limits', async () => {
    const request = vi.fn().mockResolvedValue({
      DataStorageMB: { Max: 200, Remaining: 37 },
      FileStorageMB: { Max: 1_000, Remaining: 900 },
    });

    await expect(readDataStorage({ request })).resolves.toEqual({ maxMB: 200, remainingMB: 37 });
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/limits' });
  });

  it('refuses an answer that does not say it, rather than taking it for enough', async () => {
    await expect(readDataStorage({ request: vi.fn().mockResolvedValue({}) })).rejects.toThrow();
    await expect(
      readDataStorage({ request: vi.fn().mockResolvedValue({ DataStorageMB: { Max: 200 } }) }),
    ).rejects.toThrow();
  });
});

describe('storageCheckOf', () => {
  const plan = (megabytes: number) => ({ storageBytes: megabytes * MB });

  it('fits under 80 % of what the target has left', () => {
    expect(storageCheckOf(plan(8), { maxMB: 200, remainingMB: 10 }).verdict).toBe('fits');
  });

  it('comes near past 80 % of it, which a load leaves less of than the org says', () => {
    expect(storageCheckOf(plan(8.5), { maxMB: 200, remainingMB: 10 }).verdict).toBe('near');
  });

  it('exceeds past what is left, and on an org already over its allocation', () => {
    expect(storageCheckOf(plan(10.5), { maxMB: 200, remainingMB: 10 }).verdict).toBe('exceeds');
    expect(storageCheckOf(plan(0.01), { maxMB: 200, remainingMB: -4 }).verdict).toBe('exceeds');
  });

  it('says why it could not tell, and keeps the estimate', () => {
    expect(storageCheckOf(plan(2), { unread: 'INSUFFICIENT_ACCESS' })).toEqual({
      verdict: 'unread',
      estimateMB: 2,
      unread: 'INSUFFICIENT_ACCESS',
    });
  });

  it('gives the confirmation what it says of each', () => {
    expect(confirmationStorageOf(storageCheckOf(plan(9), { maxMB: 200, remainingMB: 10 }))).toEqual(
      { estimateMB: 9, maxMB: 200, remainingMB: 10, near: true },
    );
    expect(confirmationStorageOf(storageCheckOf(plan(1), { unread: 'refused' }))).toEqual({
      estimateMB: 1,
      unread: 'refused',
    });
  });
});

describe('formatMB', () => {
  it('rounds an estimate up, to two decimals under 10 MB', () => {
    expect(formatMB(0)).toBe('0');
    expect(formatMB(74 / 1024)).toBe('0.08');
    expect(formatMB(0.0001)).toBe('0.01');
    expect(formatMB(66.81)).toBe('66.9');
  });

  it('keeps a value the float holds a hair above its decimal at that decimal', () => {
    // 4.69 × 100 is 469.00000000000006 in floating point.
    expect(formatMB(4.69)).toBe('4.69');
    expect(formatMB(12.3)).toBe('12.3');
  });
});

describe('what fires as a run inserts', () => {
  const flow = (over: Partial<ForgeTargetFlow>): ForgeTargetFlow => ({
    apiName: 'F',
    label: 'F',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...over,
  });
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Contact', 'Case', 'Account'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          flow({
            label: 'Contact welcome',
            permissions: [{ name: 'Load_Data', bypass: true }],
          }),
          flow({ label: 'Contact updated', startsOn: 'update', permissions: [] }),
          flow({
            label: 'Contact audit',
            startsOn: 'update',
            permissions: [{ name: 'Skip_Audit', bypass: true }],
          }),
        ],
        triggers: [],
      },
      {
        objectApiName: 'Case',
        flows: [],
        triggers: [{ name: 'CaseTrigger', events: ['beforeInsert', 'afterUpdate'] }],
      },
      {
        objectApiName: 'Account',
        flows: [],
        triggers: [{ name: 'AccountCleanup', events: ['afterDelete'] }],
      },
    ],
    unread: [
      { part: 'conditions', reason: 'MALFORMED_QUERY' },
      { part: 'triggers', reason: 'INSUFFICIENT_ACCESS: the Tooling API is off' },
    ],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 4,
  };

  it('names each flow and trigger that fires on insert, with its object and kind', () => {
    expect(firedOnInsertOf(automation)).toEqual([
      { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome' },
      { objectApiName: 'Case', kind: 'trigger', name: 'CaseTrigger' },
    ]);
  });

  it('names the permissions that keep a flow firing on insert quiet, and no other', () => {
    expect(runBypassesOf(automation)).toEqual(['Load_Data']);
  });

  it('says what could not be read of what fires, a start condition aside', () => {
    expect(automationUnreadOf(automation)).toEqual([
      { part: 'triggers', reason: 'INSUFFICIENT_ACCESS: the Tooling API is off' },
    ]);
  });

  it('gives the command line the reason it refuses to write, naming the automation', () => {
    expect(automationRefusal(automation, 'TGT')).toBe(
      'TGT runs automation on the records this clone inserts: Contact: flow "Contact welcome"; ' +
        'Case: Apex trigger CaseTrigger. The Apex triggers of TGT could not be read ' +
        '(INSUFFICIENT_ACCESS: the Tooling API is off), so what fires as the clone inserts is ' +
        'not known. Nothing was written. Add --accept-automation to clone all the same, or turn ' +
        'that automation off in TGT first.',
    );
  });

  it('leaves out a flow a bypass the run writes as holds keeps quiet, as the Automation tab does', () => {
    const held: ForgeTargetAutomation = {
      ...automation,
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            flow({
              label: 'Contact welcome',
              permissions: [{ name: 'Load_Data', bypass: true, held: true }],
            }),
          ],
          triggers: [],
        },
      ],
      unread: [],
    };

    expect(firedOnInsertOf(held)).toEqual([]);
    expect(automationRefusal(held, 'TGT')).toBeUndefined();
  });

  it('names a process and a workflow rule that fire on insert for what they are, not as triggers', () => {
    const older: ForgeTargetAutomation = {
      ...automation,
      objects: [
        {
          objectApiName: 'Lead',
          flows: [],
          triggers: [],
          processes: [flow({ label: 'Lead routing' })],
          workflowRules: [flow({ label: 'Lead alert' })],
        },
      ],
      unread: [],
    };

    // In the order the platform runs them: workflow rules, then processes.
    expect(firedOnInsertOf(older).map(({ kind }) => kind)).toEqual(['workflowRule', 'process']);
    expect(automationRefusal(older, 'TGT')).toContain(
      'Lead: workflow rule "Lead alert"; Lead: process "Lead routing".',
    );
  });

  it('counts as unknown what the processes and workflow rules not read hide, and not the rules that decide nothing', () => {
    const blind: ForgeTargetAutomation = {
      ...automation,
      objects: [],
      unread: [
        { part: 'processes', reason: 'P' },
        { part: 'workflowRules', reason: 'W' },
        { part: 'definitions', reason: 'D' },
        { part: 'assignmentRules', reason: 'A' },
        { part: 'duplicateRules', reason: 'R' },
        { part: 'userPermissions', reason: 'U' },
      ],
    };

    expect(automationUnreadOf(blind)).toEqual([
      { part: 'processes', reason: 'P' },
      { part: 'workflowRules', reason: 'W' },
    ]);
    expect(automationRefusal(blind, 'TGT')).toContain(
      'The Process Builder processes of TGT could not be read (P)',
    );
  });

  it('gives it none when nothing fires on insert and everything was read', () => {
    expect(
      automationRefusal(
        { objects: [automation.objects[2]], unread: [{ part: 'conditions', reason: 'x' }] },
        'TGT',
      ),
    ).toBeUndefined();
  });
});

/** A node of a discovered graph, included unless told. */
function graphNode(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/** A lookup of `child` at `parent`, one the child may be written without unless told. */
function lookup(
  parent: string,
  child: string,
  overrides: Partial<ForgeGraphEdge> = {},
): ForgeGraphEdge {
  return {
    sourceObject: parent,
    targetObject: child,
    relationshipName: `${parent}To${child}`,
    type: 'lookup',
    ...overrides,
  };
}

describe('the objects a run updates after inserting them', () => {
  it('counts an object holding a lookup at itself: the second pass fills it in', () => {
    expect(
      objectsUpdatedAfterInsert({
        nodes: [graphNode('Account')],
        edges: [lookup('Account', 'Account')],
      }),
    ).toEqual([{ objectApiName: 'Account', steps: ['lookups'] }]);
  });

  it('counts every member of a cycle holding a lookup at another, whichever the write order puts first', () => {
    // Contact.AccountId and Account.Primary_Contact__c: one of the two is left
    // empty at insert, and which is the write order's.
    expect(
      objectsUpdatedAfterInsert({
        nodes: [graphNode('Account'), graphNode('Contact')],
        edges: [lookup('Account', 'Contact'), lookup('Contact', 'Account')],
      }),
    ).toEqual([
      { objectApiName: 'Account', steps: ['lookups'] },
      { objectApiName: 'Contact', steps: ['lookups'] },
    ]);
  });

  it('counts no update for a lookup at a parent written before its child', () => {
    expect(
      objectsUpdatedAfterInsert({
        nodes: [graphNode('Account'), graphNode('Contact'), graphNode('Case')],
        edges: [lookup('Account', 'Contact'), lookup('Contact', 'Case'), lookup('Account', 'Case')],
      }),
    ).toEqual([]);
  });

  it('counts no update for a lookup never left for the second pass: required, insert-only, or set by no write', () => {
    const nodes = [graphNode('Account'), graphNode('Contact')];
    expect(
      objectsUpdatedAfterInsert({
        nodes,
        edges: [lookup('Account', 'Contact', { required: true }), lookup('Contact', 'Account')],
      }),
    ).toEqual([{ objectApiName: 'Account', steps: ['lookups'] }]);
    expect(
      objectsUpdatedAfterInsert({
        nodes,
        edges: [lookup('Account', 'Contact', { insertOnly: true }), lookup('Contact', 'Account')],
      }),
    ).toEqual([{ objectApiName: 'Account', steps: ['lookups'] }]);
    expect(
      objectsUpdatedAfterInsert({
        nodes,
        edges: [lookup('Contact', 'Account', { settable: false }), lookup('Account', 'Contact')],
      }),
    ).toEqual([]);
  });

  it('counts no update on an object the run does not write', () => {
    expect(
      objectsUpdatedAfterInsert({
        nodes: [
          graphNode('Account'),
          graphNode('Contact', { included: false, leftOutByUser: true }),
        ],
        edges: [
          lookup('Account', 'Contact'),
          lookup('Contact', 'Account'),
          lookup('Contact', 'Contact'),
        ],
      }),
    ).toEqual([]);
  });

  it('counts the orders and contracts the run writes: those past Draft get their status back', () => {
    expect(
      objectsUpdatedAfterInsert({ nodes: [graphNode('Order'), graphNode('Contract')], edges: [] }),
    ).toEqual([
      { objectApiName: 'Order', steps: ['statuses'] },
      { objectApiName: 'Contract', steps: ['statuses'] },
    ]);
    expect(
      objectsUpdatedAfterInsert(
        { nodes: [graphNode('Order'), graphNode('Contract')], edges: [] },
        { leftOut: new Set(['Order']) },
      ),
    ).toEqual([{ objectApiName: 'Contract', steps: ['statuses'] }]);
  });

  it("counts an event's invitees, given back their answer", () => {
    expect(
      objectsUpdatedAfterInsert({
        nodes: [graphNode('Event'), graphNode('EventRelation')],
        edges: [lookup('Event', 'EventRelation', { required: true })],
      }),
    ).toEqual([{ objectApiName: 'EventRelation', steps: ['invitees'] }]);
  });

  it('counts, on a retry, every object holding a lookup at another the run writes', () => {
    expect(
      objectsUpdatedAfterInsert(
        {
          nodes: [graphNode('Account'), graphNode('Contact')],
          edges: [lookup('Account', 'Contact')],
        },
        { retry: true },
      ),
    ).toEqual([{ objectApiName: 'Contact', steps: ['retry'] }]);
  });

  it('counts, with an upsert, every object the run writes', () => {
    expect(
      objectsUpdatedAfterInsert(
        {
          nodes: [graphNode('Account'), graphNode('Contract')],
          edges: [lookup('Account', 'Contract', { required: true })],
        },
        { upsert: true },
      ),
    ).toEqual([
      { objectApiName: 'Account', steps: ['upsert'] },
      { objectApiName: 'Contract', steps: ['statuses', 'upsert'] },
    ]);
  });

  it('says each step once, in its order', () => {
    expect(
      updateStepsOf([
        { objectApiName: 'Order', steps: ['statuses', 'upsert'] },
        { objectApiName: 'Account', steps: ['lookups', 'upsert'] },
      ]),
    ).toEqual(['lookups', 'statuses', 'upsert']);
  });
});

describe('what fires as a run updates the records it inserted', () => {
  const flow = (over: Partial<ForgeTargetFlow>): ForgeTargetFlow => ({
    apiName: 'F',
    label: 'F',
    timing: 'afterSave',
    startsOn: 'update',
    condition: 'read',
    permissions: [],
    ...over,
  });
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Order', 'Account'],
    objects: [
      {
        objectApiName: 'Order',
        flows: [
          flow({ label: 'Order sync', permissions: [{ name: 'Skip_Sync', bypass: true }] }),
          flow({ label: 'Order created', startsOn: 'create' }),
        ],
        triggers: [],
      },
      {
        objectApiName: 'Account',
        flows: [flow({ label: 'Account rollup' })],
        triggers: [{ name: 'AccountTrigger', events: ['afterUpdate'] }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 5,
  };

  it('names what fires on update on the objects the run updates, and on no other', () => {
    expect(firedOnUpdateOf(automation, ['Order'])).toEqual([
      { objectApiName: 'Order', kind: 'flow', name: 'Order sync' },
    ]);
    expect(firedOnUpdateOf(automation, [])).toEqual([]);
  });

  it('names the bypasses of what fires on insert, and on update of the objects updated', () => {
    expect(runBypassesOf(automation, [])).toEqual([]);
    expect(runBypassesOf(automation, ['Order'])).toEqual(['Skip_Sync']);
  });

  it('refuses the command line a clone whose updates fire automation, naming it and why', () => {
    const refusal = automationRefusal(automation, 'TGT', {
      updated: [{ objectApiName: 'Order', steps: ['statuses'] }],
    });
    expect(refusal).toBe(
      'TGT runs automation on the records this clone inserts: Order: flow "Order created". ' +
        'TGT runs automation as this clone updates records it inserted (an order or a contract ' +
        'given back its status after it went in as a draft): Order: flow "Order sync". ' +
        'Nothing was written. Add --accept-automation to clone all the same, or turn that ' +
        'automation off in TGT first.',
    );
  });

  it('refuses a clone where only an update fires automation', () => {
    const onlyUpdates: ForgeTargetAutomation = { ...automation, objects: [automation.objects[1]] };
    expect(automationRefusal(onlyUpdates, 'TGT')).toBeUndefined();
    expect(
      automationRefusal(onlyUpdates, 'TGT', {
        updated: [{ objectApiName: 'Account', steps: ['lookups'] }],
      }),
    ).toContain(
      'TGT runs automation as this clone updates records it inserted (a lookup filled in once ' +
        'its record exists): Account: Apex trigger AccountTrigger; Account: flow "Account rollup".',
    );
  });

  it('gives the command that assigns the smallest permission set holding a bypass, or says none holds it', () => {
    expect(
      automationRefusal(automation, 'TGT', {
        updated: [{ objectApiName: 'Order', steps: ['statuses'] }],
        assign: [
          {
            permission: 'Skip_Sync',
            permissionSet: 'Sync_Off',
            others: ['Integration'],
            command:
              'sf org assign permset --name Sync_Off --target-org TGT --on-behalf-of u@x.test',
          },
          { permission: 'Skip_Rules', others: [], noneHolds: true },
        ],
      }),
    ).toContain(
      'Sync_Off is the smallest permission set of TGT that holds Skip_Sync; Integration holds it ' +
        'too. Assigned to the user the clone writes as, it keeps quiet what Skip_Sync excludes: ' +
        'sf org assign permset --name Sync_Off --target-org TGT --on-behalf-of u@x.test ' +
        'No permission set of TGT holds Skip_Rules: an admin creates one that includes it, and ' +
        'assigns it to the user the clone writes as. Nothing was written.',
    );
  });
});

describe('the bypasses to assign', () => {
  const flow: ForgeTargetFlow = {
    apiName: 'F',
    label: 'F',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [
      { name: 'Held_One', bypass: true, held: true },
      { name: 'Load_Data', bypass: true, held: false },
      { name: 'Skip_Rules', bypass: true, held: false },
      { name: 'Never_Read', bypass: true },
    ],
  };
  const automation: Pick<ForgeTargetAutomation, 'objects' | 'bypassGrants'> = {
    objects: [{ objectApiName: 'Contact', flows: [flow], triggers: [] }],
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [
          { name: 'Data_Load', label: 'Data load', grants: 1 },
          { name: 'Integration', label: 'Integration', grants: 90 },
        ],
      },
      { permission: 'Skip_Rules', permissionSets: [] },
    ],
  };
  const bypasses = ['Held_One', 'Load_Data', 'Never_Read', 'Skip_Rules'];

  it('leaves out what the user holds, gives the smallest permission set and its command, and says when none holds it', () => {
    expect(
      bypassesToAssign(automation, bypasses, { alias: 'TGT', username: 'u@example.com' }),
    ).toEqual([
      {
        permission: 'Load_Data',
        permissionSet: 'Data_Load',
        others: ['Integration'],
        command:
          'sf org assign permset --name Data_Load --target-org TGT --on-behalf-of u@example.com',
      },
      { permission: 'Never_Read', others: [] },
      { permission: 'Skip_Rules', others: [], noneHolds: true },
    ]);
  });

  it('writes no command without the user the run writes as', () => {
    expect(bypassesToAssign(automation, ['Load_Data'])).toEqual([
      { permission: 'Load_Data', permissionSet: 'Data_Load', others: ['Integration'] },
    ]);
  });
});

describe('what fires as a removal takes the run back', () => {
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Order', 'Account'],
    objects: [
      {
        objectApiName: 'Order',
        flows: [
          {
            apiName: 'Order_Sync',
            label: 'Order sync',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            permissions: [],
          },
        ],
        triggers: [{ name: 'OrderTrigger', events: ['beforeDelete'] }],
      },
      {
        objectApiName: 'Account',
        flows: [],
        triggers: [{ name: 'AccountCleanup', events: ['beforeDelete', 'afterDelete'] }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 5,
  };

  it('names what fires on delete, with when, and on update of what it sets back to Draft', () => {
    expect(removalAutomationRefusal(automation, 'TGT', { drafted: ['Order'] })).toBe(
      'TGT runs automation on the records this removal deletes: Order: Apex trigger OrderTrigger ' +
        '(before delete); Account: Apex trigger AccountCleanup (before and after delete). TGT runs ' +
        'automation as this removal sets activated records back to Draft, the only way the ' +
        'platform deletes them: Order: flow "Order sync". Nothing was deleted. Add ' +
        '--accept-automation to remove all the same, or turn that automation off in TGT first.',
    );
  });

  it('says, before a removal deletes, per object what fires and when, and that nothing does when nothing does', () => {
    expect(removalAutomationLines(automation, 'TGT', 2, ['Order'])).toEqual([
      'removal automation: what TGT runs as the removal takes the records back',
      '  Order: set back to Draft before its delete: flow "Order sync"',
      '  Order: before delete: Apex trigger OrderTrigger',
      '  Account: before and after delete: Apex trigger AccountCleanup',
    ]);
    expect(removalAutomationLines({ ...automation, objects: [] }, 'TGT', 2, [])).toEqual([
      'removal automation: what TGT runs as the removal takes the records back',
      '  nothing fires on the 2 object(s) it deletes records of',
    ]);
    expect(
      removalAutomationLines(
        { objects: [], unread: [{ part: 'triggers', reason: 'NO_ACCESS' }] },
        'TGT',
        2,
        [],
      ),
    ).toEqual([
      'removal automation: what TGT runs as the removal takes the records back',
      '  the Apex triggers could not be read: NO_ACCESS',
    ]);
  });

  it('says nothing of an update when nothing is set back to Draft', () => {
    expect(removalAutomationRefusal(automation, 'TGT')).not.toContain('Draft');
  });

  it('gives none when nothing fires on delete and everything was read', () => {
    expect(
      removalAutomationRefusal({ ...automation, objects: [] }, 'TGT', { drafted: ['Order'] }),
    ).toBeUndefined();
    expect(
      removalAutomationRefusal(
        { ...automation, objects: [], unread: [{ part: 'flows', reason: 'NO_ACCESS' }] },
        'TGT',
      ),
    ).toContain(
      'The flows of TGT could not be read (NO_ACCESS), so what fires as the removal deletes is not known.',
    );
  });
});

describe('ForgeRunGateError', () => {
  it('tells the page why the run stopped, and the storage of a refusal for storage', () => {
    expect(new ForgeRunGateError('WRITE_DECLINED', 'cancelled').stop).toEqual({
      code: 'WRITE_DECLINED',
    });
    expect(
      new ForgeRunGateError('STORAGE_EXCEEDED', 'full', { estimateMB: 70, remainingMB: 12 }).stop,
    ).toEqual({ code: 'STORAGE_EXCEEDED', storage: { estimateMB: 70, remainingMB: 12 } });
    // The command line's own refusals never reach the page.
    expect(new ForgeRunGateError('MAX_TOTAL_EXCEEDED', 'too many').stop).toBeUndefined();
  });

  it('is told by its name as well as its class', () => {
    const lookalike = Object.assign(new Error('cancelled'), {
      name: 'ForgeRunGateError',
      code: 'WRITE_DECLINED',
    });
    expect(isForgeRunGateError(new ForgeRunGateError('WRITE_DECLINED', 'cancelled'))).toBe(true);
    expect(isForgeRunGateError(lookalike)).toBe(true);
    expect(isForgeRunGateError(new Error('cancelled'))).toBe(false);
  });
});

describe('what the gate says', () => {
  const plan = writePlanOf([
    { objectApiName: 'Contact', rows: rows(30) },
    { objectApiName: 'Account', rows: rows(4) },
  ]);

  it('refuses rows that take more storage than the target has left, saying both', () => {
    const check = storageCheckOf({ storageBytes: 70 * MB }, { maxMB: 200, remainingMB: 12 });
    expect(storageRefusal(check, 'TGT')).toBe(
      'The records to write take about 70 MB of data storage, and TGT has 12 MB left of 200 MB: ' +
        'leave objects out, lower the records per object, or free data storage in TGT.',
    );
    expect(storageRefusal(storageCheckOf(plan, { maxMB: 200, remainingMB: 12 }), 'TGT')).toBe(
      undefined,
    );
  });

  it('lists the records per object and the storage on the command line', () => {
    expect(
      writePlanLines(plan, storageCheckOf(plan, { maxMB: 200, remainingMB: 12 }), 'TGT'),
    ).toEqual([
      'write gate: 34 record(s) to write to TGT, about 0.07 MB of data storage',
      `  ${'Contact'.padEnd(42)}${'30'.padStart(8)}`,
      `  ${'Account'.padEnd(42)}${'4'.padStart(8)}`,
      '  data storage of TGT: 12 MB left of 200 MB',
    ]);
  });

  it('says when the storage comes near what is left, or could not be read', () => {
    const near = writePlanLines(plan, storageCheckOf(plan, { maxMB: 1, remainingMB: 0.08 }), 'T');
    expect(near.at(-1)).toBe(
      '  that is more than 80 % of what T has left: Salesforce counts storage a while after a ' +
        'load, so less may be left than it says',
    );
    const unread = writePlanLines(plan, storageCheckOf(plan, { unread: 'refused' }), 'T');
    expect(unread.at(-1)).toBe(
      '  the data storage T has left could not be read (refused): whether the records fit is not known',
    );
  });

  it('asks above 2 000 records in the extension, and refuses above 10 000 on the command line', () => {
    expect(DEFAULT_CONFIRM_ABOVE_RECORDS).toBe(2_000);
    expect(DEFAULT_MAX_TOTAL).toBe(10_000);
  });
});
