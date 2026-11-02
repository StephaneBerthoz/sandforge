import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow, RewindDiffObject } from '@sandforge/shared';

import {
  actDeliverability,
  actEmailsGate,
  actSendersOf,
  afterLeaseEmailsRefusal,
  checkpointEmails,
  checkpointEmailsUncounted,
  emailsRefusal,
  emailsUncountedWords,
  writtenByDiff,
  writtenByPlan,
  writtenByUndo,
} from './rewindEmails.js';
import { heldPlanOf } from '../forge/targetDeliverability.js';

/** A flow that sends `emails` on the writes it starts on. */
function flow(
  label: string,
  startsOn: ForgeTargetFlow['startsOn'],
  emails: Array<'SingleEmail' | 'DailyWorkflowEmails'>,
  quiet = false,
): ForgeTargetFlow {
  return {
    apiName: label.replaceAll(' ', '_'),
    label,
    timing: 'afterSave',
    startsOn,
    condition: 'read',
    permissions: quiet ? [{ name: 'Skip_Flows', bypass: true, held: true }] : [],
    messages: emails.map((limit, at) => ({ kind: 'email', name: `Send ${at}`, limit })),
  };
}

/** The org's automation: `flows` per object, nothing else. */
function automationOf(flows: Record<string, ForgeTargetFlow[]>): ForgeTargetAutomation {
  return {
    objectsRead: Object.keys(flows),
    objects: Object.entries(flows).map(([objectApiName, list]) => ({
      objectApiName,
      flows: list,
      triggers: [],
    })),
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
}

/** A Developer Edition's limits: fifteen single emails a day, its alerts among them. */
const DEVELOPER_EDITION = {
  SingleEmail: { max: 15, remaining: 12 },
  DailyWorkflowEmails: { max: 8_040, remaining: 8_000 },
};

/** A sandbox's limits, which count its alerts apart. */
const SANDBOX = {
  SingleEmail: { max: 5_000, remaining: 5_000 },
  DailyWorkflowEmails: { max: 1_000_000, remaining: 1_000_000 },
};

function diffObject(
  objectApiName: string,
  counts: Partial<Record<string, number>>,
): RewindDiffObject {
  return {
    objectApiName,
    toDelete: {
      createdSince: counts.createdSince ?? 0,
      broughtBackSince: 0,
      comesBackWithParent: 0,
    },
    toGiveBack: { records: counts.giveBack ?? 0, fields: 0, clearedLookups: 0 },
    toBringBack: { inBin: counts.inBin ?? 0, withParent: 0, deletedWhileTaken: 0 },
    ...(counts.toRecreate ? { toRecreate: counts.toRecreate } : {}),
    cannotUndo: [],
    outside: [],
    touched: 0,
    unexplained: 0,
    lastChangedBy: {},
    notCompared: [],
  };
}

describe('what a rewind and an undo write, per object and write', () => {
  it('counts of a preview what it brings back, gives back — what it brings back among it — and deletes', () => {
    expect(
      writtenByDiff([
        diffObject('Contact', { giveBack: 3, inBin: 2, createdSince: 4 }),
        diffObject('Account', {}),
      ]),
    ).toEqual([
      { objectApiName: 'Contact', write: 'undelete', records: 2 },
      { objectApiName: 'Contact', write: 'update', records: 5 },
      { objectApiName: 'Contact', write: 'delete', records: 4 },
    ]);
  });

  it('counts what a rewind makes again with new Ids as inserted, after what it brings back, and the emails that sends', () => {
    const written = writtenByDiff([diffObject('Contact', { inBin: 1, toRecreate: 3 })]);
    expect(written).toEqual([
      { objectApiName: 'Contact', write: 'undelete', records: 1 },
      { objectApiName: 'Contact', write: 'insert', records: 3 },
      { objectApiName: 'Contact', write: 'update', records: 1 },
    ]);
    const [single] = checkpointEmails(
      written,
      automationOf({ Contact: [flow('Welcome', 'create', ['SingleEmail'])] }),
      SANDBOX,
    );
    expect(single).toMatchObject({
      limit: 'SingleEmail',
      emails: 3,
      objects: [{ objectApiName: 'Contact', write: 'insert', records: 3, perRecord: 1 }],
    });
  });

  it('counts a carrier as brought back and deleted again, of a preview and of a plan: the automation of either write fires on it', () => {
    const preview = diffObject('Account', {});
    expect(
      writtenByDiff([
        {
          ...preview,
          toBringBack: { ...preview.toBringBack, carriers: 2 },
        },
      ]),
    ).toEqual([
      { objectApiName: 'Account', write: 'undelete', records: 2 },
      { objectApiName: 'Account', write: 'delete', records: 2 },
    ]);
    expect(
      writtenByPlan([
        {
          objectApiName: 'Account',
          deleted: 0,
          withParentDeleted: 0,
          undoCannot: 0,
          nextPassDeleted: 2,
          carriers: 2,
          broughtBack: 0,
          backWithParent: 0,
          recreated: 0,
          givenBackFirst: 0,
          givenBackAfter: 0,
          givenBackNextPass: 0,
          skipped: 0,
        },
      ]),
    ).toEqual([
      { objectApiName: 'Account', write: 'undelete', records: 2 },
      { objectApiName: 'Account', write: 'delete', records: 2 },
    ]);
  });

  it('counts of a plan what it sends and what goes or comes back with a parent', () => {
    expect(
      writtenByPlan([
        {
          objectApiName: 'Contact',
          deleted: 2,
          withParentDeleted: 1,
          undoCannot: 0,
          nextPassDeleted: 0,
          broughtBack: 1,
          backWithParent: 2,
          recreated: 0,
          givenBackFirst: 4,
          givenBackAfter: 1,
          givenBackNextPass: 0,
          skipped: 0,
        },
      ]),
    ).toEqual([
      { objectApiName: 'Contact', write: 'undelete', records: 3 },
      { objectApiName: 'Contact', write: 'update', records: 5 },
      { objectApiName: 'Contact', write: 'delete', records: 3 },
    ]);
  });

  it('counts of an undo what it brings back, gives back and sends back to the bin, what goes with a parent among it', () => {
    expect(
      writtenByUndo(
        [{ objectApiName: 'Account', deleted: 1, broughtBack: 2, givenBack: 3 }],
        [{ objectApiName: 'Contact', count: 2 }],
      ),
    ).toEqual([
      { objectApiName: 'Account', write: 'undelete', records: 1 },
      { objectApiName: 'Account', write: 'update', records: 3 },
      { objectApiName: 'Account', write: 'delete', records: 2 },
      { objectApiName: 'Contact', write: 'delete', records: 2 },
    ]);
  });
});

describe('checkpointEmails', () => {
  const contactChanged = automationOf({
    Contact: [
      flow('Contact changed', 'update', ['SingleEmail']),
      flow('Owner alert', 'createAndUpdate', ['DailyWorkflowEmails']),
      flow('Quiet one', 'update', ['SingleEmail'], true),
    ],
  });
  const written = [
    { objectApiName: 'Contact', write: 'update' as const, records: 20 },
    { objectApiName: 'Contact', write: 'delete' as const, records: 5 },
  ];

  it('counts the emails each record given back sends, its alerts among the single emails of a Developer Edition, past what it has left', () => {
    expect(checkpointEmails(written, contactChanged, DEVELOPER_EDITION)).toEqual([
      {
        limit: 'SingleEmail',
        emails: 40,
        objects: [
          {
            objectApiName: 'Contact',
            write: 'update',
            records: 20,
            perRecord: 2,
            sentBy: ['Contact changed', 'Owner alert'],
          },
        ],
        alertsCounted: true,
        verdict: 'exceeds',
        remaining: 12,
        max: 15,
      },
      {
        limit: 'DailyWorkflowEmails',
        emails: 20,
        objects: [
          {
            objectApiName: 'Contact',
            write: 'update',
            records: 20,
            perRecord: 1,
            sentBy: ['Owner alert'],
          },
        ],
        verdict: 'fits',
        remaining: 8_000,
        max: 8_040,
      },
    ]);
  });

  it('counts an org’s alerts apart where it does not count them against its single emails', () => {
    const emails = checkpointEmails(written, contactChanged, SANDBOX);
    expect(emails.map(({ limit, emails: sent, verdict }) => [limit, sent, verdict])).toEqual([
      ['SingleEmail', 20, 'fits'],
      ['DailyWorkflowEmails', 20, 'fits'],
    ]);
    expect(emails[0]?.alertsCounted).toBeUndefined();
  });

  it('says nothing of writes that send nothing, and cannot say what is left of limits the org did not give', () => {
    expect(checkpointEmails(written, automationOf({ Account: [] }), DEVELOPER_EDITION)).toEqual([]);
    expect(
      checkpointEmails(written, contactChanged, { unread: 'INSUFFICIENT_ACCESS' }).map(
        ({ verdict, unread }) => [verdict, unread],
      ),
    ).toEqual([
      ['unread', 'INSUFFICIENT_ACCESS'],
      ['unread', 'INSUFFICIENT_ACCESS'],
    ]);
  });
});

describe('emailsRefusal', () => {
  it('refuses an act past what the org has left of a limit, in words that say what to do, and nothing that fits', () => {
    const automation = automationOf({
      Contact: [flow('Contact changed', 'update', ['SingleEmail'])],
    });
    const over = checkpointEmails(
      [{ objectApiName: 'Contact', write: 'update', records: 20 }],
      automation,
      DEVELOPER_EDITION,
    );

    expect(emailsRefusal('rewind', over, 'DEV-ED')).toEqual({
      code: 'EMAILS',
      message:
        'This rewind would make DEV-ED send about 20 single emails, 12 of 15 left today: past ' +
        'them, each record whose flow fails in the save is refused (CANNOT_EXECUTE_FLOW_TRIGGER), ' +
        "and the org's own emails stop for the rest of the day. Turn off what sends them, or " +
        'assign the user a bypass that keeps it quiet, then rewind again. No record was written.',
    });
    expect(emailsRefusal('undo', over, 'DEV-ED')?.message).toMatch(
      /^This undo would make DEV-ED send .*then undo the rewind again\. No record was written\.$/,
    );
    const fits = checkpointEmails(
      [{ objectApiName: 'Contact', write: 'update', records: 3 }],
      automation,
      DEVELOPER_EDITION,
    );
    expect(emailsRefusal('rewind', fits, 'DEV-ED')).toBeUndefined();
  });
});

describe('checkpointEmailsUncounted', () => {
  /** A flow whose definition the read did not take: it fires, and what it sends is not known. */
  const unread = (
    label: string,
    startsOn: ForgeTargetFlow['startsOn'],
    over: Partial<ForgeTargetFlow> = {},
  ): ForgeTargetFlow => ({ ...flow(label, startsOn, []), condition: 'notRead', ...over });

  it('names a flow whose definition was not read that fires on the updates a preview gives back, with its object', () => {
    const automation = automationOf({
      Contact: [unread('Contact edited', 'update')],
      Account: [flow('Account read', 'update', [])],
    });

    expect(
      checkpointEmailsUncounted(
        writtenByDiff([
          diffObject('Contact', { giveBack: 4 }),
          diffObject('Account', { giveBack: 2 }),
        ]),
        automation,
      ),
    ).toBe('the definition of Contact edited on Contact');
  });

  it('names a flow before a delete an undo sends back to the bin, and a package’s flow with its package, whose flows no user reads', () => {
    const automation = automationOf({
      Case: [unread('Case closing', 'delete', { timing: 'beforeDelete', condition: 'unreadable' })],
      Contact: [
        unread('Contact feedback', 'update', {
          apiName: 'survey_kit__Contact_feedback',
          condition: 'unreadable',
        }),
      ],
    });

    expect(
      checkpointEmailsUncounted(
        writtenByUndo([
          { objectApiName: 'Case', deleted: 0, broughtBack: 3, givenBack: 0 },
          { objectApiName: 'Contact', deleted: 0, broughtBack: 0, givenBack: 1 },
        ]),
        automation,
      ),
    ).toBe(
      'the definitions of Case closing on Case; Contact feedback (package survey_kit, whose ' +
        'flows the org lets no one read) on Contact',
    );
  });

  it('names nothing of records only brought back, which start no flow, nor of a flow read, nor of a write that writes no record', () => {
    const automation = automationOf({
      Contact: [unread('Contact edited', 'update'), flow('Contact read', 'update', [])],
    });

    expect(
      checkpointEmailsUncounted(
        [{ objectApiName: 'Contact', write: 'undelete', records: 5 }],
        automation,
      ),
    ).toBeUndefined();
    expect(
      checkpointEmailsUncounted(
        [{ objectApiName: 'Contact', write: 'update', records: 0 }],
        automation,
      ),
    ).toBeUndefined();
  });

  it('names the parts of the org’s automation that send emails the read could not take, as the org’s', () => {
    expect(
      checkpointEmailsUncounted([{ objectApiName: 'Contact', write: 'update', records: 1 }], {
        objects: [],
        unread: [
          { part: 'flows', reason: 'INSUFFICIENT_ACCESS' },
          { part: 'triggers', reason: 'INSUFFICIENT_ACCESS' },
        ],
      }),
    ).toBe("the org's flows: INSUFFICIENT_ACCESS");
  });

  it('says it in the words of a refusal of the act’s automation, and nothing when every email was counted', () => {
    expect(emailsUncountedWords('undo', 'the definition of Contact edited on Contact')).toBe(
      'The emails it sends as the undo writes were not counted against its daily limits, as ' +
        'what sends them was not read (the definition of Contact edited on Contact). ',
    );
    expect(emailsUncountedWords('rewind', undefined)).toBe('');
  });
});

describe('whether the org delivers the emails of what still runs', () => {
  const sending = automationOf({ Contact: [flow('Contact changed', 'update', ['SingleEmail'])] });
  /** A rewind that gives contacts back and deletes nothing. */
  const steps = { giveBack: ['Contact'] };
  const input = { act: 'rewind' as const, orgName: 'DEV-ED', steps, mayMute: false };
  const SENDER = {
    objectApiName: 'Contact',
    kind: 'flow' as const,
    name: 'Contact changed',
    why: 'email' as const,
  };
  /** The same flow, kept quiet for whoever holds the set the org grants its bypass in. */
  const bypassed = {
    ...automationOf({
      Contact: [
        {
          ...flow('Contact changed', 'update', ['SingleEmail']),
          permissions: [{ name: 'Skip_Contact', bypass: true, held: false }],
        },
      ],
    }),
    bypassGrants: [
      {
        permission: 'Skip_Contact',
        permissionSets: [{ name: 'Skip_Set', label: 'Skip', grants: 1 }],
      },
    ],
  };
  const plan = {
    assign: [{ permissionSet: 'Skip_Set', label: 'Skip', permissions: ['Skip_Contact'] }],
  };
  let reads = 0;
  const reading = (level: 'all' | 'withheld') => () => {
    reads++;
    return Promise.resolve({ reading: { level }, requests: 1 });
  };

  it('reads nothing when what the act writes starts nothing that sends', async () => {
    reads = 0;
    const emails = await actDeliverability({
      ...input,
      automation: sending,
      steps: { delete: ['Contact'] },
      accepted: false,
      read: reading('all'),
    });

    expect(reads).toBe(0);
    expect(emails.gate.verdict).toBe('nothingSends');
    expect(emails.refusal).toBeUndefined();
    expect(emails.ofRun).toEqual({ senders: [] });
  });

  it('refuses it where the org delivers them, the accord alone lifting the refusal', async () => {
    reads = 0;
    const refused = await actDeliverability({
      ...input,
      automation: sending,
      accepted: false,
      read: reading('all'),
    });
    expect(refused.refusal?.code).toBe('EMAILS_DELIVERED');
    expect(refused.refusal?.message).toContain('Add --accept-emails to rewind all the same');
    expect(refused.gate.audit).toBe('all');

    const accepted = await actDeliverability({
      ...input,
      automation: sending,
      accepted: true,
      read: reading('all'),
    });
    expect(accepted.refusal).toBeUndefined();
    expect(accepted.gate.verdict).toBe('asks');
    expect(reads).toBe(2);
  });

  it('says the emails go to the addresses the records hold, an act’s values being the org’s own', async () => {
    const { refusal } = await actDeliverability({
      ...input,
      act: 'undo',
      automation: sending,
      accepted: false,
      read: reading('all'),
    });

    expect(refusal?.message).toContain('those of the records this undo writes, as they hold them');
    expect(refusal?.message).not.toContain('.invalid');
  });

  it('lets through an org that withholds them, and says so', async () => {
    const { gate, refusal } = await actDeliverability({
      ...input,
      automation: sending,
      accepted: false,
      read: reading('withheld'),
    });

    expect(refusal).toBeUndefined();
    expect(gate).toMatchObject({
      verdict: 'withheld',
      audit: 'withheld',
      deliverability: { reading: { level: 'withheld' }, senders: [SENDER] },
    });
  });

  it('reads the org, and asks, when what sends could not all be read', async () => {
    reads = 0;
    const blind = { ...automationOf({}), unread: [{ part: 'flows' as const, reason: 'refused' }] };
    const { refusal, ofRun } = await actDeliverability({
      ...input,
      automation: blind,
      accepted: false,
      read: reading('all'),
    });

    expect(reads).toBe(1);
    expect(ofRun.sendersUnread).toBe("the target's flows: refused");
    expect(refusal?.code).toBe('EMAILS_DELIVERED');
  });

  it('counts what the mute’s plan keeps quiet out of what sends, and reads nothing for it', async () => {
    reads = 0;

    expect(actSendersOf({ automation: bypassed, steps, plan })).toEqual({ senders: [] });
    const emails = await actDeliverability({
      ...input,
      automation: bypassed,
      plan,
      accepted: false,
      read: reading('all'),
    });
    expect(reads).toBe(0);
    expect(emails.refusal).toBeUndefined();
  });

  it('names what the mute keeps quiet only to an act that could have been asked to mute', () => {
    const of = (mayMute: boolean): string | undefined =>
      actEmailsGate({
        ...input,
        mayMute,
        automation: bypassed,
        accepted: false,
        senders: [SENDER],
        reading: { level: 'all' },
      }).refusal?.message;

    expect(of(true)).toContain('--mute-automation keeps quiet flow "Contact changed"');
    expect(of(false)).not.toContain('--mute-automation');
  });

  describe('the lease read back against its plan', () => {
    const after = (
      held: { assigned: string[]; held: string[] },
      overrides: { accepted?: boolean; reading?: { level: 'all' } | { level: 'withheld' } } = {},
    ) =>
      afterLeaseEmailsRefusal({
        act: 'rewind',
        orgName: 'DEV-ED',
        automation: bypassed,
        steps,
        plan,
        held,
        planned: [],
        accepted: false,
        ...overrides,
      });

    it('holds a set assigned, and one the user held already', () => {
      expect(heldPlanOf(plan, { assigned: ['Skip_Set'], held: [] })).toEqual(plan);
      expect(heldPlanOf(plan, { assigned: [], held: ['Skip_Set'] })).toEqual(plan);
      expect(heldPlanOf(plan, { assigned: [], held: [] })).toEqual({ assign: [] });
    });

    it('lets through a lease that holds its plan', () => {
      expect(after({ assigned: ['Skip_Set'], held: [] })).toBeUndefined();
    });

    it('refuses one that leaves a sender running that no one was asked about', () => {
      const refusal = after({ assigned: [], held: [] });

      expect(refusal?.code).toBe('EMAILS_DELIVERED');
      expect(refusal?.message).toContain('flow "Contact changed" on Contact may send emails');
      expect(refusal?.message).toContain('Add --accept-emails to rewind all the same');
    });

    it('lets it through once the emails were accepted, or where the org withholds them', () => {
      expect(after({ assigned: [], held: [] }, { accepted: true })).toBeUndefined();
      expect(after({ assigned: [], held: [] }, { reading: { level: 'withheld' } })).toBeUndefined();
    });
  });
});
