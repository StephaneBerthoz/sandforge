import { describe, it, expect, vi } from 'vitest';
import type {
  ForgeGraphEdge,
  ForgeGraphNode,
  ForgeTargetAutomation,
  ForgeTargetFlow,
} from '@sandforge/shared';
import {
  apiBudgetCheckOf,
  runRequestsEstimate,
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  DEFAULT_MAX_TOTAL,
  ForgeRunGateError,
  READ_CEILING_PER_OBJECT,
  alertsCountAsSingle,
  automationRefusal,
  automationUnreadOf,
  bypassesToAssign,
  confirmationStorageOf,
  countedEmailChecksOf,
  emailCheckLines,
  emailChecksOf,
  emailRefusal,
  emailsCountedPerRecord,
  firedOnInsertOf,
  firedOnUpdateOf,
  formatMB,
  isForgeRunGateError,
  objectsAboveReadCeiling,
  objectsUpdatedAfterInsert,
  pricesForLinesOf,
  readDataStorage,
  readEmailLimits,
  removalAutomationLines,
  removalAutomationRefusal,
  removalRiskLines,
  removalStepsAutomationLines,
  removalStepsAutomationRefusal,
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

  it('measures an object a run read page by page by its count, person accounts apart', () => {
    const plan = writePlanOf([
      { objectApiName: 'Account', rows: [], counted: { rows: 10, personAccounts: 4 } },
      { objectApiName: 'Contact', rows: [], counted: { rows: 12, personAccounts: 4 } },
      { objectApiName: 'Campaign', rows: [], counted: { rows: 1 } },
      { objectApiName: 'Case', rows: [], counted: { rows: 0 } },
    ]);

    expect(plan.objects.map(({ objectApiName, rows: n }) => [objectApiName, n])).toEqual([
      ['Contact', 12],
      ['Account', 10],
      ['Campaign', 1],
    ]);
    expect(plan.totalRows).toBe(23);
    // Six business accounts, four person accounts at 4 KB, eight contacts of
    // their own and none for the person accounts', one campaign.
    expect(plan.storageBytes).toBe(6 * 2 * KB + 4 * 4 * KB + 8 * 2 * KB + 8 * KB);
    expect(plan.leftOut).toBeUndefined();
  });

  it('adds up what the run will not write: what the run it retries wrote, and the objects held back', () => {
    const plan = writePlanOf([
      { objectApiName: 'Account', rows: [], counted: { rows: 0 }, leftOut: { heldBack: 40 } },
      { objectApiName: 'Contact', rows: [], counted: { rows: 12 }, leftOut: { writtenBefore: 8 } },
      { objectApiName: 'Case', rows: rows(3), leftOut: { writtenBefore: 2 } },
    ]);
    expect(plan.totalRows).toBe(15);
    expect(plan.leftOut).toEqual({
      writtenBefore: 10,
      heldBack: [{ objectApiName: 'Account', rows: 40 }],
    });
  });

  it('counts in the prices the write may read besides those in hand, at the size of a price', () => {
    // Read as the prices were written, a price wanted in two currencies wrote
    // 17 records where the gate had counted 13.
    const plan = writePlanOf([
      { objectApiName: 'PricebookEntry', rows: rows(4), mayAdd: 3 },
      { objectApiName: 'Opportunity', rows: rows(1) },
    ]);

    expect(plan.objects).toEqual([
      { objectApiName: 'PricebookEntry', rows: 7, storageBytes: 7 * 2 * KB, mayAdd: 3 },
      { objectApiName: 'Opportunity', rows: 1, storageBytes: 2 * KB },
    ]);
    expect(plan.totalRows).toBe(8);
    expect(pricesForLinesOf(plan)).toEqual({ pricesForLines: 3 });
    expect(pricesForLinesOf(writePlanOf([{ objectApiName: 'Account', rows: rows(1) }]))).toEqual(
      {},
    );
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

describe('readEmailLimits', () => {
  it('reads the daily single and workflow emails the org has left, leaving out one it does not list', async () => {
    const request = vi.fn().mockResolvedValue({
      SingleEmail: { Max: 15, Remaining: 3 },
      DataStorageMB: { Max: 5, Remaining: 5 },
    });

    await expect(readEmailLimits({ request })).resolves.toEqual({
      SingleEmail: { max: 15, remaining: 3 },
    });
    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/limits' });
  });
});

describe('emailChecksOf', () => {
  const plan = {
    objects: [
      { objectApiName: 'Contact', rows: 36, storageBytes: 0 },
      { objectApiName: 'Account', rows: 1, storageBytes: 0 },
    ],
  };
  const sending = [
    {
      objectApiName: 'Contact',
      limit: 'SingleEmail' as const,
      perRecord: 2,
      sentBy: ['Contact welcome'],
    },
    {
      objectApiName: 'Contact',
      limit: 'DailyWorkflowEmails' as const,
      perRecord: 1,
      sentBy: ['Welcome rule'],
    },
    // Nothing of it is written: it sends nothing.
    { objectApiName: 'Lead', limit: 'SingleEmail' as const, perRecord: 1, sentBy: ['Lead hello'] },
  ];

  it('says a limit the inserts go past, and one they fit in', () => {
    // Live, into a Developer Edition: 72 single emails against 15 a day, and
    // thirty contacts refused, CANNOT_EXECUTE_FLOW_TRIGGER.
    const checks = emailChecksOf(plan, sending, {
      SingleEmail: { max: 15, remaining: 15 },
      DailyWorkflowEmails: { max: 8_040, remaining: 8_040 },
    });

    expect(checks.map(({ limit, emails, verdict }) => ({ limit, emails, verdict }))).toEqual([
      { limit: 'SingleEmail', emails: 72, verdict: 'exceeds' },
      { limit: 'DailyWorkflowEmails', emails: 36, verdict: 'fits' },
    ]);
    expect(emailCheckLines(checks, 'TRAP')[0]).toContain(
      'about 72 single emails (2 per Contact, by Contact welcome), more than the 15 of 15',
    );
  });

  it('never takes limits the org would not say for enough', () => {
    expect(emailChecksOf(plan, sending, { unread: 'INSUFFICIENT_ACCESS' })).toEqual([
      expect.objectContaining({
        limit: 'SingleEmail',
        verdict: 'unread',
        unread: 'INSUFFICIENT_ACCESS',
      }),
      expect.objectContaining({ limit: 'DailyWorkflowEmails', verdict: 'unread' }),
    ]);
    expect(emailChecksOf(plan, sending, {})[0]).toMatchObject({ verdict: 'unread' });
  });

  it('checks nothing when the inserts send no email', () => {
    expect(emailChecksOf(plan, [], { SingleEmail: { max: 15, remaining: 0 } })).toEqual([]);
  });
});

describe('alertsCountAsSingle', () => {
  it('counts email alerts against the single emails of an org held to fifteen a day, not of one with more', () => {
    expect(
      alertsCountAsSingle({
        SingleEmail: { max: 15, remaining: 15 },
        DailyWorkflowEmails: { max: 8040, remaining: 8040 },
      }),
    ).toBe(true);
    expect(alertsCountAsSingle({ SingleEmail: { max: 5000, remaining: 4990 } })).toBe(false);
    expect(alertsCountAsSingle({ DailyWorkflowEmails: { max: 15, remaining: 15 } })).toBe(false);
  });
});

describe('emailsCountedPerRecord', () => {
  const perInsert = [
    { objectApiName: 'Contact', limit: 'SingleEmail' as const, perRecord: 2, sentBy: ['A'] },
    {
      objectApiName: 'Contact',
      limit: 'DailyWorkflowEmails' as const,
      perRecord: 1,
      sentBy: ['B'],
    },
    { objectApiName: 'Case', limit: 'DailyWorkflowEmails' as const, perRecord: 1, sentBy: ['C'] },
  ];

  it('adds the alerts of each object to its single emails where the org counts them there', () => {
    expect(emailsCountedPerRecord(perInsert, true)).toEqual([
      { objectApiName: 'Contact', limit: 'SingleEmail', perRecord: 3, sentBy: ['A', 'B'] },
      { objectApiName: 'Contact', limit: 'DailyWorkflowEmails', perRecord: 1, sentBy: ['B'] },
      { objectApiName: 'Case', limit: 'DailyWorkflowEmails', perRecord: 1, sentBy: ['C'] },
      { objectApiName: 'Case', limit: 'SingleEmail', perRecord: 1, sentBy: ['C'] },
    ]);
    // What it was given is left as it was.
    expect(perInsert[0]).toEqual({
      objectApiName: 'Contact',
      limit: 'SingleEmail',
      perRecord: 2,
      sentBy: ['A'],
    });
  });

  it('leaves them to the workflow emails elsewhere', () => {
    expect(emailsCountedPerRecord(perInsert, false)).toEqual(perInsert);
  });
});

describe('countedEmailChecksOf', () => {
  // The trap Developer Edition on 2026-10-14: a workflow rule emails each
  // contact created, and the single emails already stood at −75.
  const plan = { objects: [{ objectApiName: 'Contact', rows: 36, storageBytes: 0 }] };
  const alert = [
    {
      objectApiName: 'Contact',
      limit: 'DailyWorkflowEmails' as const,
      perRecord: 1,
      sentBy: ['Contact welcome rule'],
    },
  ];
  const developerEdition = {
    SingleEmail: { max: 15, remaining: -75 },
    DailyWorkflowEmails: { max: 8_040, remaining: 8_019 },
  };

  it("counts a Developer Edition's email alerts against its single emails, and says so", () => {
    // Counted against the workflow emails alone, the clone said "36 workflow
    // emails; 8019 of 8040 left", and took the single emails to −117.
    const checks = countedEmailChecksOf(plan, alert, developerEdition);

    expect(
      checks.map(({ limit, emails, verdict, alertsCounted }) => ({
        limit,
        emails,
        verdict,
        alertsCounted,
      })),
    ).toEqual([
      { limit: 'DailyWorkflowEmails', emails: 36, verdict: 'fits', alertsCounted: undefined },
      { limit: 'SingleEmail', emails: 36, verdict: 'exceeds', alertsCounted: true },
    ]);
    expect(emailCheckLines(checks, 'TRAP')[1]).toBe(
      '  emails: these records make TRAP send about 36 single emails (1 per Contact, by Contact ' +
        'welcome rule), its email alerts among them: TRAP counts them against its single ' +
        'emails, as a Developer Edition does, more than the -75 of 15 it has left today: past ' +
        'them the action fails, and a record whose flow fails in the save is refused ' +
        '(CANNOT_EXECUTE_FLOW_TRIGGER). A bypass that keeps the flow quiet, or a smaller run, ' +
        'avoids it',
    );
    expect(emailRefusal(checks, 'TRAP')).toBe(
      "The target's automation would make TRAP send about 36 single emails (its email alerts " +
        'among them, as a Developer Edition counts them), -75 of 15 left today: past them, ' +
        'each record whose flow fails in the save is refused (CANNOT_EXECUTE_FLOW_TRIGGER), ' +
        "and the org's own emails stop for the rest of the day. Assign the user a bypass that " +
        'keeps what sends quiet, or write fewer records.',
    );
  });

  it('leaves the alerts to the workflow emails of an org with more single emails, or whose limits were not read', () => {
    expect(
      countedEmailChecksOf(plan, alert, {
        SingleEmail: { max: 5_000, remaining: 4_990 },
        DailyWorkflowEmails: { max: 1_000_000, remaining: 999_000 },
      }).map((check) => check.limit),
    ).toEqual(['DailyWorkflowEmails']);
    expect(
      countedEmailChecksOf(plan, alert, { unread: 'INSUFFICIENT_ACCESS' }).map((c) => c.limit),
    ).toEqual(['DailyWorkflowEmails']);
  });

  it('says no alert among the single emails when the records written fire none', () => {
    const flowOnly = [
      { objectApiName: 'Contact', limit: 'SingleEmail' as const, perRecord: 1, sentBy: ['Flow'] },
      { objectApiName: 'Case', limit: 'DailyWorkflowEmails' as const, perRecord: 1, sentBy: ['R'] },
    ];

    expect(countedEmailChecksOf(plan, flowOnly, developerEdition)).toEqual([
      expect.not.objectContaining({ alertsCounted: true }),
    ]);
  });
});

describe('emailRefusal', () => {
  const check = {
    limit: 'SingleEmail' as const,
    objects: [{ objectApiName: 'Contact', rows: 30, perRecord: 2, sentBy: ['Contact welcome'] }],
    emails: 60,
  };

  it('refuses a command-line run past what the target has left of a daily limit', () => {
    expect(emailRefusal([{ ...check, verdict: 'exceeds', remaining: 15, max: 15 }], 'TARGET')).toBe(
      "The target's automation would make TARGET send about 60 single emails, 15 of 15 left " +
        'today: past them, each record whose flow fails in the save is refused ' +
        "(CANNOT_EXECUTE_FLOW_TRIGGER), and the org's own emails stop for the rest of the day. " +
        'Assign the user a bypass that keeps what sends quiet, or write fewer records.',
    );
  });

  it('refuses nothing that fits, or that no limit could be read for', () => {
    expect(
      emailRefusal([{ ...check, verdict: 'fits', remaining: 90, max: 100 }], 'T'),
    ).toBeUndefined();
    expect(
      emailRefusal([{ ...check, verdict: 'unread', unread: 'no access' }], 'T'),
    ).toBeUndefined();
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

describe('the tables a run reads past the ceiling', () => {
  const graph = {
    nodes: [
      graphNode('Account', { recordCount: 12_000 }),
      graphNode('Task', { recordCount: 2_400_000 }),
      graphNode('EmailMessage', { recordCount: 80_000 }),
      graphNode('Event', { recordCount: 900_000, included: false }),
      graphNode('Custom__c', { recordCount: 0, recordCountUnknown: true }),
    ],
  };

  it('names, the most first, the tables written past 50 000 rows when nothing caps the read', () => {
    expect(READ_CEILING_PER_OBJECT).toBe(50_000);
    expect(objectsAboveReadCeiling(graph, undefined)).toEqual([
      { objectApiName: 'Task', rows: 2_400_000 },
      { objectApiName: 'EmailMessage', rows: 80_000 },
    ]);
  });

  it('names none under a cap per object at or below the ceiling', () => {
    expect(objectsAboveReadCeiling(graph, 1_000)).toEqual([]);
    expect(objectsAboveReadCeiling(graph, 50_000)).toEqual([]);
  });

  it('counts a table under a cap above the ceiling for no more than the cap', () => {
    expect(objectsAboveReadCeiling(graph, 60_000)).toEqual([
      { objectApiName: 'Task', rows: 60_000 },
      { objectApiName: 'EmailMessage', rows: 60_000 },
    ]);
  });

  it('takes a cap of zero or less for none, as the read does', () => {
    expect(objectsAboveReadCeiling(graph, 0)).toEqual(objectsAboveReadCeiling(graph, undefined));
  });
});

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

describe('what fires as a removal takes a whole run back, step by step', () => {
  const automation: ForgeTargetAutomation = {
    objectsRead: ['Contact', 'Account', 'Order'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [],
        triggers: [{ name: 'ContactBack', events: ['afterUndelete'] }],
      },
      {
        objectApiName: 'Account',
        flows: [
          {
            apiName: 'Account_Touch',
            label: 'Account touch',
            timing: 'afterSave',
            startsOn: 'update',
            condition: 'read',
            permissions: [],
          },
        ],
        triggers: [{ name: 'AccountCleanup', events: ['beforeDelete', 'afterDelete'] }],
      },
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
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 5,
  };
  /** A Sync run's removal: what the run deleted, wrote over and created. */
  const steps = {
    bringBack: ['Contact'],
    giveBack: ['Account'],
    setToDraft: ['Order'],
    delete: ['Order', 'Account'],
  };

  it('says per object what each step fires, in the order the removal writes, and that nothing does when nothing does', () => {
    // A Sync run's removal brought records back and gave values back, and
    // the command line said nothing of what those writes fire.
    expect(removalStepsAutomationLines(automation, 'TGT', steps)).toEqual([
      'removal automation: what TGT runs as the removal takes the run back',
      '  Contact: brought back from the recycle bin: Apex trigger ContactBack',
      '  Account: given back its values from before the run: flow "Account touch"',
      '  Order: set back to Draft before its delete: flow "Order sync"',
      '  Account: before and after delete: Apex trigger AccountCleanup',
    ]);
    expect(removalStepsAutomationLines({ ...automation, objects: [] }, 'TGT', steps)).toEqual([
      'removal automation: what TGT runs as the removal takes the run back',
      '  nothing fires on the 3 object(s) it writes records of',
    ]);
    expect(
      removalStepsAutomationLines(
        { objects: [], unread: [{ part: 'triggers', reason: 'NO_ACCESS' }] },
        'TGT',
        steps,
      ),
    ).toEqual([
      'removal automation: what TGT runs as the removal takes the run back',
      '  the Apex triggers could not be read: NO_ACCESS',
    ]);
  });

  it('names what each step fires, and asks for --accept-automation', () => {
    expect(removalStepsAutomationRefusal(automation, 'TGT', { steps })).toBe(
      'TGT runs automation as this removal brings back from the recycle bin what the run ' +
        'deleted: Contact: Apex trigger ContactBack. TGT runs automation as this removal gives ' +
        'the records the run wrote over their values from before it: Account: flow "Account ' +
        'touch". TGT runs automation as this removal sets activated records back to Draft, the ' +
        'only way the platform deletes them: Order: flow "Order sync". TGT runs automation on ' +
        'the records this removal deletes: Account: Apex trigger AccountCleanup (before and ' +
        'after delete). Nothing was written or deleted. Add --accept-automation to remove all ' +
        'the same, or turn that automation off in TGT first.',
    );
  });

  it('reads only what the steps write: an undelete trigger fires on what comes back alone', () => {
    expect(
      removalStepsAutomationRefusal(automation, 'TGT', { steps: { delete: ['Contact'] } }),
    ).toBeUndefined();
    expect(
      removalStepsAutomationRefusal(automation, 'TGT', { steps: { bringBack: ['Contact'] } }),
    ).toContain('brings back from the recycle bin what the run deleted: Contact');
  });

  it('gives none when nothing fires and everything was read, and refuses what could not be read', () => {
    expect(
      removalStepsAutomationRefusal({ ...automation, objects: [] }, 'TGT', { steps }),
    ).toBeUndefined();
    expect(
      removalStepsAutomationRefusal(
        { ...automation, objects: [], unread: [{ part: 'flows', reason: 'NO_ACCESS' }] },
        'TGT',
        { steps },
      ),
    ).toContain(
      'The flows of TGT could not be read (NO_ACCESS), so what fires as the removal writes is not known.',
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

  it('says on the command line the prices it counts in that the write may read', () => {
    const priced = writePlanOf([{ objectApiName: 'PricebookEntry', rows: rows(13), mayAdd: 4 }]);

    expect(
      writePlanLines(priced, storageCheckOf(priced, { maxMB: 200, remainingMB: 12 }), 'TGT'),
    ).toEqual([
      'write gate: 17 record(s) to write to TGT, about 0.04 MB of data storage',
      `  ${'PricebookEntry'.padEnd(42)}${'17'.padStart(8)}`,
      '  counted in: up to 4 PricebookEntry record(s) the run may read as it writes them, a ' +
        "price in the currency of the record its lines belong to, the source's own beside the " +
        'one read',
      '  data storage of TGT: 12 MB left of 200 MB',
    ]);
  });

  it('says on the command line what it does not count: what the run retried wrote, and the objects held back', () => {
    const leftOut = writePlanOf([
      { objectApiName: 'Contact', rows: rows(30), leftOut: { writtenBefore: 6 } },
      { objectApiName: 'Account', rows: [], leftOut: { heldBack: 4 } },
    ]);
    expect(
      writePlanLines(leftOut, storageCheckOf(leftOut, { maxMB: 200, remainingMB: 12 }), 'TGT'),
    ).toEqual([
      'write gate: 30 record(s) to write to TGT, about 0.06 MB of data storage',
      `  ${'Contact'.padEnd(42)}${'30'.padStart(8)}`,
      '  not counted: 6 record(s) the run it retries or resumes wrote, which it links to and ' +
        'does not write again',
      '  not counted: Account, 4 record(s), held back whole for a record type closed to the ' +
        'user the run writes as',
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

describe('what the command line says of the reversibility of a run', () => {
  it('names, per object, what may refuse a removal of the run', () => {
    expect(
      removalRiskLines(
        [
          { objectApiName: 'Case', kind: 'flow', name: 'Case guard' },
          { objectApiName: 'Case', kind: 'trigger', name: 'CaseDelete' },
          { objectApiName: 'Case', kind: 'packageTrigger', name: 'pkg.CaseAudit' },
          { objectApiName: 'Order', kind: 'lock' },
        ],
        'TARGET',
      ),
    ).toEqual([
      "reversibility: a removal of this run's records (--remove) may be refused in TARGET:",
      '  Case: flow "Case guard" runs before a record is deleted, and can refuse the delete',
      '  Case: Apex trigger CaseDelete runs on a delete, and can refuse it',
      '  Case: Apex trigger pkg.CaseAudit, installed by a managed package, runs on a delete and ' +
        'can refuse it; no one in the org can change it',
      '  Order: once activated, a record locks the records under it, which a removal then takes ' +
        'only with it, or once it is back in Draft',
    ]);
  });

  it('says when nothing was found that refuses one', () => {
    expect(removalRiskLines([], 'TARGET')).toEqual([
      "reversibility: nothing found in TARGET that refuses a removal of this run's records " +
        '(no flow before a delete, no Apex trigger on one, no record that locks past Draft)',
    ]);
  });
});

describe('the daily API requests', () => {
  it('reads them from the same /limits as the storage, in one request', async () => {
    const request = vi.fn(async () => ({
      DataStorageMB: { Max: 5, Remaining: 4 },
      DailyApiRequests: { Max: 15_000, Remaining: 900 },
    }));

    expect(await readDataStorage({ request })).toEqual({
      maxMB: 5,
      remainingMB: 4,
      dailyApiRequests: { max: 15_000, remaining: 900 },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('estimates a run: a REST call per 200 rows, five per Bulk API job of 10 000, a read per 2 000', () => {
    expect(
      runRequestsEstimate([
        { rows: 401 },
        { rows: 12_000, bulk: true },
        { rows: 0, readRows: 4_001 },
      ]),
    ).toBe(3 + 10 + 3);
  });

  it('says a run exceeds what is left, comes near a tenth of the day, fits, or could not be read', () => {
    expect(apiBudgetCheckOf(100, { max: 15_000, remaining: 99 }).verdict).toBe('exceeds');
    expect(apiBudgetCheckOf(100, { max: 15_000, remaining: 1_500 }).verdict).toBe('near');
    expect(apiBudgetCheckOf(100, { max: 15_000, remaining: 1_600 }).verdict).toBe('fits');
    expect(apiBudgetCheckOf(100, undefined)).toMatchObject({ verdict: 'unread' });
    expect(apiBudgetCheckOf(100, { unread: 'INSUFFICIENT_ACCESS' })).toMatchObject({
      verdict: 'unread',
      unread: 'INSUFFICIENT_ACCESS',
    });
  });
});
