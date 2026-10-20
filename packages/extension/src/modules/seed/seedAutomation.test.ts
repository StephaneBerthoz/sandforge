import { describe, expect, it, vi } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { seedEmailEstimates } from '@sandforge/shared';
import {
  alertsCountAsSingle,
  readSeedAutomation,
  seedAutomationLines,
  seedAutomationPreview,
  seedEmailGate,
  seedEmailsPerRecord,
  type SeedAutomationRead,
} from './seedAutomation.js';

/** A flow of the target that runs after a contact is saved. */
function contactFlow(overrides: Partial<ForgeTargetFlow>): ForgeTargetFlow {
  return {
    apiName: 'Flow',
    label: 'Flow',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/**
 * What a Developer Edition runs as contacts are created: a flow that emails
 * each one twice — once in the save, once after it — unless its user holds a
 * bypass; a workflow rule that emails each one; a flow that opens a task.
 */
function trapAutomation(
  options: { held?: boolean; ruleBypass?: boolean } = {},
): ForgeTargetAutomation {
  const bypass = { name: 'Trap_Bypass_Flow', bypass: true, held: options.held ?? false };
  return {
    objectsRead: ['Account', 'Contact', 'Case'],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          contactFlow({
            apiName: 'Welcome_Email',
            label: 'Welcome Email',
            permissions: [bypass],
            paths: [{ kind: 'async' }],
            messages: [
              { kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' },
              { kind: 'email', name: 'Send Follow Up Email', limit: 'SingleEmail' },
            ],
          }),
          contactFlow({ apiName: 'Follow_Up_Task', label: 'Follow Up Task', creates: ['Task'] }),
        ],
        triggers: [],
        workflowRules: [
          contactFlow({
            apiName: 'Contact_Welcome',
            label: 'Contact_Welcome',
            permissions: options.ruleBypass ? [bypass] : [],
            messages: [{ kind: 'email', name: 'Contact_Alert', limit: 'DailyWorkflowEmails' }],
          }),
        ],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: options.held
      ? []
      : [
          {
            permission: 'Trap_Bypass_Flow',
            permissionSets: [
              { name: 'Trap_Bypass', label: 'Trap Bypass', grants: 2 },
              { name: 'Admin_Extras', label: 'Admin Extras', grants: 40 },
            ],
          },
        ],
    requests: 7,
  };
}

/** A Developer Edition's daily email limits, its single emails untouched. */
const DE_LIMITS = {
  SingleEmail: { max: 15, remaining: 15 },
  DailyWorkflowEmails: { max: 8040, remaining: 8040 },
};

/** The CRM starter's counts, as the gallery shows them. */
const CRM_COUNTS = [
  { objectApiName: 'Account', recordCount: 25 },
  { objectApiName: 'Contact', recordCount: 75 },
  { objectApiName: 'Case', recordCount: 50 },
];

describe('alertsCountAsSingle', () => {
  it('counts email alerts against the single emails of an org held to fifteen a day, not of one with more', () => {
    expect(alertsCountAsSingle(DE_LIMITS)).toBe(true);
    expect(alertsCountAsSingle({ SingleEmail: { max: 5000, remaining: 4990 } })).toBe(false);
    expect(alertsCountAsSingle({ DailyWorkflowEmails: { max: 15, remaining: 15 } })).toBe(false);
  });
});

describe('seedEmailsPerRecord', () => {
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
    expect(seedEmailsPerRecord(perInsert, true)).toEqual([
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
    expect(seedEmailsPerRecord(perInsert, false)).toEqual(perInsert);
  });
});

describe('seedAutomationPreview', () => {
  it('says what fires as each record is created, what it sends or creates, and the bypass that quiets it', () => {
    const preview = seedAutomationPreview(trapAutomation(), 'my-dev-org', DE_LIMITS);

    expect(preview.objects).toEqual([
      {
        objectApiName: 'Contact',
        entries: [
          {
            kind: 'workflowRule',
            name: 'Contact_Welcome',
            when: 'after',
            emails: 1,
            messages: [],
            creates: [],
            afterCommit: false,
            bypasses: [],
            keptQuiet: false,
            unread: false,
          },
          {
            kind: 'flow',
            name: 'Welcome Email',
            when: 'after',
            emails: 2,
            messages: [],
            creates: [],
            afterCommit: true,
            bypasses: [{ name: 'Trap_Bypass_Flow', held: false }],
            keptQuiet: false,
            unread: false,
          },
          {
            kind: 'flow',
            name: 'Follow Up Task',
            when: 'after',
            emails: 0,
            messages: [],
            creates: ['Task'],
            afterCommit: false,
            bypasses: [],
            keptQuiet: false,
            unread: false,
          },
        ],
      },
    ]);
    expect(preview.emailsPerRecord).toEqual([
      {
        objectApiName: 'Contact',
        limit: 'DailyWorkflowEmails',
        perRecord: 1,
        sentBy: ['Contact_Welcome'],
      },
      {
        objectApiName: 'Contact',
        limit: 'SingleEmail',
        perRecord: 3,
        sentBy: ['Welcome Email', 'Contact_Welcome'],
      },
    ]);
    expect(preview).toMatchObject({
      org: 'my-dev-org',
      objectsRead: ['Account', 'Contact', 'Case'],
      limits: DE_LIMITS,
      alertsAsSingle: true,
      bypasses: [{ permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass' }],
      bypassesHeld: [],
      unread: [],
      blinded: false,
      conditionsNotRead: 0,
    });
  });

  it('counts nothing a bypass the user holds keeps quiet', () => {
    const preview = seedAutomationPreview(
      trapAutomation({ held: true, ruleBypass: true }),
      'my-dev-org',
      DE_LIMITS,
    );
    expect(preview.emailsPerRecord).toEqual([]);
    expect(preview.bypassesHeld).toEqual(['Trap_Bypass_Flow']);
    expect(preview.bypasses).toEqual([]);
    expect(preview.objects[0].entries.filter((e) => e.keptQuiet).map((e) => e.name)).toEqual([
      'Contact_Welcome',
      'Welcome Email',
    ]);
    expect(preview).not.toHaveProperty('limits');
  });

  it('keeps why the limits could not be read, and counts the alerts as workflow emails then', () => {
    const preview = seedAutomationPreview(trapAutomation(), 'my-dev-org', {
      unread: 'INSUFFICIENT_ACCESS',
    });
    expect(preview.limitsUnread).toBe('INSUFFICIENT_ACCESS');
    expect(preview.alertsAsSingle).toBe(false);
    expect(preview.emailsPerRecord.map((e) => [e.limit, e.perRecord])).toEqual([
      ['DailyWorkflowEmails', 1],
      ['SingleEmail', 2],
    ]);
  });

  it('says a part the org refused, and that nothing found then says nothing', () => {
    const preview = seedAutomationPreview(
      {
        ...trapAutomation(),
        objects: [],
        unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS' }],
      },
      'my-dev-org',
      {},
    );
    expect(preview).toMatchObject({
      objects: [],
      unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS' }],
      blinded: true,
    });
  });
});

describe('readSeedAutomation', () => {
  it('reads the limits only when a record sends emails', async () => {
    const readLimits = vi.fn(async () => DE_LIMITS);
    const quiet = await readSeedAutomation({
      org: 'my-dev-org',
      objects: ['Account'],
      readAutomation: async () => ({ ...trapAutomation(), objects: [] }),
      readLimits,
    });
    expect(readLimits).not.toHaveBeenCalled();
    expect('preview' in quiet && quiet.preview.emailsPerRecord).toEqual([]);

    const sending = await readSeedAutomation({
      org: 'my-dev-org',
      objects: ['Contact'],
      readAutomation: async (objects) => ({ ...trapAutomation(), objectsRead: [...objects] }),
      readLimits,
    });
    expect(readLimits).toHaveBeenCalledOnce();
    expect('preview' in sending && sending.preview.limits).toEqual(DE_LIMITS);
  });

  it('says why when the automation or the limits could not be read, and never throws', async () => {
    expect(
      await readSeedAutomation({
        org: 'my-dev-org',
        objects: ['Contact'],
        readAutomation: async () => {
          throw new Error('Session expired or invalid');
        },
        readLimits: async () => DE_LIMITS,
      }),
    ).toEqual({ error: 'Session expired or invalid' });

    const read = await readSeedAutomation({
      org: 'my-dev-org',
      objects: ['Contact'],
      readAutomation: async () => trapAutomation(),
      readLimits: async () => {
        throw new Error('REQUEST_LIMIT_EXCEEDED');
      },
    });
    expect('preview' in read && read.preview.limitsUnread).toBe('REQUEST_LIMIT_EXCEEDED');
  });
});

describe('seedEmailGate', () => {
  const read = (automation = trapAutomation(), limits: object = DE_LIMITS): SeedAutomationRead => ({
    preview: seedAutomationPreview(automation, 'my-dev-org', limits),
  });

  it('refuses the CRM starter on a Developer Edition whose contact automation emails each contact', () => {
    const gate = seedEmailGate(read(), CRM_COUNTS, 'my-dev-org');

    expect(gate.refusal).toBe(
      'The seed was refused before it wrote anything: its records would make my-dev-org send ' +
        'about 225 single emails (3 per Contact), 15 of 15 left today. Past what is left, a flow ' +
        'that sends in the save refuses its record (CANNOT_EXECUTE_FLOW_TRIGGER), and the ' +
        "org's own emails stop for the rest of the day. To seed it, lower the record counts, " +
        'set Contact to 0, turn off "Contact_Welcome" and "Welcome Email", or give the user the ' +
        'seed writes as the permission set Trap_Bypass, whose Trap_Bypass_Flow keeps "Welcome ' +
        'Email" quiet. Nothing was written.',
    );
    expect(gate.figures).toEqual({
      org: 'my-dev-org',
      limit: 'SingleEmail',
      emails: 225,
      remaining: 15,
      max: 15,
      objects: ['Contact'],
      senders: ['Contact_Welcome', 'Welcome Email'],
      bypasses: [
        { permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass', quiets: ['Welcome Email'] },
      ],
    });
    expect(gate.unknown).toBeUndefined();
  });

  it('lets the seed through once its counts fit what is left', () => {
    const gate = seedEmailGate(
      read(),
      [
        { objectApiName: 'Account', recordCount: 25 },
        { objectApiName: 'Contact', recordCount: 5 },
      ],
      'my-dev-org',
    );
    expect(gate.refusal).toBeUndefined();
    expect(gate.checks.map((c) => [c.limit, c.emails, c.verdict])).toEqual([
      ['DailyWorkflowEmails', 5, 'fits'],
      ['SingleEmail', 15, 'fits'],
    ]);
  });

  it('lets through a seed whose sender the user holds the bypass of', () => {
    const gate = seedEmailGate(
      read(trapAutomation({ held: true, ruleBypass: true })),
      CRM_COUNTS,
      'my-dev-org',
    );
    expect(gate).toEqual({ checks: [] });
  });

  it('warns and does not refuse when what the org has left could not be read', () => {
    const gate = seedEmailGate(
      read(trapAutomation(), { unread: 'INSUFFICIENT_ACCESS' }),
      CRM_COUNTS,
      'my-dev-org',
    );
    expect(gate.refusal).toBeUndefined();
    expect(gate.unknown).toEqual([
      'about 75 workflow emails, but what my-dev-org has left today could not be read (INSUFFICIENT_ACCESS)',
      'about 150 single emails, but what my-dev-org has left today could not be read (INSUFFICIENT_ACCESS)',
    ]);
  });

  it('warns and does not refuse when the automation could not be read at all', () => {
    expect(seedEmailGate({ error: 'Session expired' }, CRM_COUNTS, 'my-dev-org')).toEqual({
      checks: [],
      unknown: [
        'what my-dev-org runs as these records are created could not be read (Session expired): ' +
          'the emails they make it send are not known',
      ],
    });
  });

  it('warns of a part of the automation it could not read, beside a refusal it can still make', () => {
    const automation = {
      ...trapAutomation(),
      unread: [{ part: 'triggers' as const, reason: 'INSUFFICIENT_ACCESS' }],
      conditionsNotRead: 2,
    };
    const gate = seedEmailGate(read(automation), CRM_COUNTS, 'my-dev-org');
    expect(gate.refusal).toContain('about 225 single emails');
    expect(gate.unknown).toEqual([
      'part of what my-dev-org runs could not be read: emails it sends may not be counted',
      '2 start condition(s) of my-dev-org not read: the emails of those flows are not counted',
    ]);
  });

  it('comes to the figures the confirmation counts from the same read', () => {
    const { preview } = read() as { preview: Parameters<typeof seedEmailEstimates>[0] };
    for (const contacts of [0, 5, 6, 75]) {
      const counts = [...CRM_COUNTS.filter((c) => c.objectApiName !== 'Contact')];
      counts.push({ objectApiName: 'Contact', recordCount: contacts });
      const gate = seedEmailGate(read(), counts, 'my-dev-org');
      const estimates = seedEmailEstimates(
        preview,
        Object.fromEntries(counts.map((c) => [c.objectApiName, c.recordCount])),
      );
      expect(estimates.map((e) => [e.limit, e.emails, e.verdict, e.remaining])).toEqual(
        gate.checks.map((c) => [c.limit, c.emails, c.verdict, c.remaining]),
      );
    }
  });
});

describe('seedAutomationLines', () => {
  it('says per object what its inserts fire, the bypass that quiets it, and how alerts are counted', () => {
    expect(
      seedAutomationLines(
        { preview: seedAutomationPreview(trapAutomation(), 'TGT', DE_LIMITS) },
        'TGT',
      ),
    ).toEqual([
      'target automation: what TGT runs as these records are created',
      '  Contact: workflow rule "Contact_Welcome" (after save; 1 email(s) a record), flow ' +
        '"Welcome Email" (after save; 2 email(s) a record; then after commit; not for a user ' +
        'with Trap_Bypass_Flow (not held)), flow "Follow Up Task" (after save; creates Task)',
      '  bypass: Trap_Bypass_Flow keeps quiet what names it; permission set Trap_Bypass holds it',
      '  TGT counts its email alerts against its single emails too, as a Developer Edition does',
    ]);
  });

  it('says a bypass held, a read that failed, and that nothing runs', () => {
    expect(
      seedAutomationLines(
        {
          preview: seedAutomationPreview(
            trapAutomation({ held: true, ruleBypass: true }),
            'TGT',
            {},
          ),
        },
        'TGT',
      ),
    ).toContain(
      '  bypass held: the user the seed writes as holds Trap_Bypass_Flow, and what names it stays quiet',
    );
    expect(seedAutomationLines({ error: 'Session expired' }, 'TGT')).toEqual([
      'target automation: what TGT runs as these records are created could not be read ' +
        '(Session expired): the emails they make it send are not known',
    ]);
    expect(
      seedAutomationLines(
        { preview: seedAutomationPreview({ ...trapAutomation(), objects: [] }, 'TGT', {}) },
        'TGT',
      ),
    ).toEqual([
      'target automation: what TGT runs as these records are created',
      '  nothing runs on them: no flow, Apex trigger, process or workflow rule',
    ]);
  });
});
