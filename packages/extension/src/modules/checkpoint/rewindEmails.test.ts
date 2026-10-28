import { describe, expect, it } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetFlow, RewindDiffObject } from '@sandforge/shared';

import {
  checkpointEmails,
  emailsRefusal,
  writtenByDiff,
  writtenByPlan,
  writtenByUndo,
} from './rewindEmails.js';

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
