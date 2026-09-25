import { describe, it, expect, vi } from 'vitest';
import {
  RowsLeftToThePlatform,
  STATUS_LIFECYCLES,
  STATUS_NEEDS_CHILDREN,
  directAccountContactRelations,
  draftStartOf,
  emailOnACase,
  emailWriteEdges,
  existingActivityRelations,
  existingSellingModelOptions,
  giveLinkedRelationsTheirFlags,
  leftToThePlatformNote,
  leftToThePlatformReason,
  leftToThePlatformSummary,
  lookupsThePlatformFills,
  recordsByNaturalKey,
  rowsACopySends,
  standardPriceIds,
  statusCategories,
  tasksWrittenWithEmails,
  waitsForItsTask,
  withTheRelationItIs,
  writtenByThePlatform,
  type RelationUpdate,
  type SoqlQuery,
} from './platformRecords.js';

describe('standardPriceIds', () => {
  it('names the entries of the standard price book among those asked about', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '01uSTD' }]);

    const found = await standardPriceIds(query, ['01uSTD', '01uCUSTOM']);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM PricebookEntry WHERE Id IN ('01uSTD', '01uCUSTOM') AND Pricebook2.IsStandard = true",
    );
    expect([...found]).toEqual(['01uSTD']);
  });

  it('asks about two hundred entries at a time, and nothing for none', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    await standardPriceIds(query, []);
    expect(query).not.toHaveBeenCalled();
    await standardPriceIds(
      query,
      Array.from({ length: 201 }, (_, i) => `01u${String(i).padStart(3, '0')}`),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('writtenByThePlatform', () => {
  it('names a tracked change as a feed item the platform writes itself', () => {
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'TrackedChange' })).toEqual({
      field: 'Type',
      value: 'TrackedChange',
      noun: 'tracked change',
    });
  });

  it('leaves to the insert a post, a feed item of a type it cannot say is refused, and other objects', () => {
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'TextPost' })).toBeUndefined();
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A', Type: 'CallLogPost' })).toBeUndefined();
    expect(writtenByThePlatform('FeedItem', { Id: '0D5A' })).toBeUndefined();
    expect(writtenByThePlatform('Task', { Id: '00TA', Type: 'TrackedChange' })).toBeUndefined();
  });

  it("names a task's relation to its what, however the API spells the flag, and leaves a relation to a who to the insert", () => {
    const what = {
      field: 'IsWhat',
      value: true,
      noun: 'what relation',
      from: "the task's WhatId",
    };

    expect(writtenByThePlatform('TaskRelation', { Id: '0RTA', IsWhat: true })).toEqual(what);
    expect(writtenByThePlatform('TaskRelation', { Id: '0RTA', IsWhat: 'true' })).toEqual(what);
    expect(writtenByThePlatform('TaskRelation', { Id: '0RTB', IsWhat: false })).toBeUndefined();
    expect(writtenByThePlatform('TaskRelation', { Id: '0RTC', IsWhat: '' })).toBeUndefined();
    expect(writtenByThePlatform('TaskRelation', { Id: '0RTD' })).toBeUndefined();
  });

  it("names an event's relation to its what, as a task's, and leaves one to a who or an invitee to the insert", () => {
    const what = {
      field: 'IsWhat',
      value: true,
      noun: 'what relation',
      from: "the event's WhatId",
    };

    expect(writtenByThePlatform('EventRelation', { Id: '0REA', IsWhat: true })).toEqual(what);
    expect(writtenByThePlatform('EventRelation', { Id: '0REA', IsWhat: 'true' })).toEqual(what);
    expect(
      writtenByThePlatform('EventRelation', { Id: '0REB', IsWhat: false, IsParent: true }),
    ).toBeUndefined();
    expect(
      writtenByThePlatform('EventRelation', { Id: '0REC', IsWhat: false, IsInvitee: true }),
    ).toBeUndefined();
  });

  it("names every relation of an email, whatever it carries, as one the platform writes from the email's addresses", () => {
    const relation = { noun: 'email relation', from: "the email's addresses" };

    expect(
      writtenByThePlatform('EmailMessageRelation', {
        Id: '0CZA',
        RelationType: 'ToAddress',
        RelationAddress: 'someone@example.com',
      }),
    ).toEqual(relation);
    expect(writtenByThePlatform('EmailMessageRelation', { Id: '0CZB' })).toEqual(relation);
    expect(writtenByThePlatform('EmailMessage', { Id: '02sA' })).toBeUndefined();
  });
});

describe('withTheRelationItIs', () => {
  it('says a task relation whose IsWhat was cleared is to its what when it names neither a contact nor a lead', () => {
    expect(
      withTheRelationItIs('TaskRelation', { RelationId: 'Quote-000014', IsWhat: '' }, 'Quote'),
    ).toEqual({ RelationId: 'Quote-000014', IsWhat: true });
    expect(
      withTheRelationItIs('TaskRelation', { RelationId: 'Account-000001' }, 'Account'),
    ).toEqual({ RelationId: 'Account-000001', IsWhat: true });
  });

  it('leaves a relation to a contact or a lead, one that says what it is, one naming an unknown record, and other objects as they are', () => {
    const toContact = { RelationId: 'Contact-000001', IsWhat: '' };
    const said = { RelationId: 'Quote-000001', IsWhat: false };
    const unknown = { RelationId: '0Q0000000000001', IsWhat: '' };
    const feedItem = { ParentId: 'Quote-000001', IsWhat: '' };

    expect(withTheRelationItIs('TaskRelation', toContact, 'Contact')).toBe(toContact);
    expect(withTheRelationItIs('TaskRelation', { ...toContact }, 'Lead')).toEqual(toContact);
    expect(withTheRelationItIs('TaskRelation', said, 'Quote')).toBe(said);
    expect(withTheRelationItIs('TaskRelation', unknown, undefined)).toBe(unknown);
    expect(withTheRelationItIs('FeedItem', feedItem, 'Quote')).toBe(feedItem);
  });

  it('says an event relation whose IsWhat was cleared is to its what when it names no who and no invitee', () => {
    const toOpportunity = { RelationId: 'Opportunity-000001', IsWhat: '' };
    const toContact = { RelationId: 'Contact-000001', IsWhat: '' };
    const toUser = { RelationId: '005000000000001AAA', IsWhat: '' };
    const toRoom = { RelationId: '023000000000001AAA', IsWhat: '' };

    expect(withTheRelationItIs('EventRelation', toOpportunity, 'Opportunity')).toEqual({
      RelationId: 'Opportunity-000001',
      IsWhat: true,
    });
    expect(withTheRelationItIs('EventRelation', toContact, 'Contact')).toBe(toContact);
    expect(withTheRelationItIs('EventRelation', toUser, 'User')).toBe(toUser);
    expect(withTheRelationItIs('EventRelation', toRoom, 'Calendar')).toBe(toRoom);
  });
});

describe('emailOnACase', () => {
  it('says an email is on a case when its ParentId holds one, or its RelatedToId names one', () => {
    expect(emailOnACase({ ParentId: '500T' })).toBe(true);
    expect(emailOnACase({ RelatedToId: '500000000000001AAA' })).toBe(true);
    expect(emailOnACase({ ParentId: '', RelatedToId: '500000000000001AAA' })).toBe(true);
  });

  it('says an email related to anything else, or to nothing, is not', () => {
    expect(emailOnACase({ ParentId: '' })).toBe(false);
    expect(emailOnACase({ RelatedToId: '0Q0T' })).toBe(false);
    expect(emailOnACase({ RelatedToId: '' })).toBe(false);
    expect(emailOnACase({})).toBe(false);
  });

  it('tells the object of a reference id by the resolver it is given', () => {
    const objectOf = (id: string): string | undefined =>
      ({ 'Case-000001': 'Case', 'Quote-000001': 'Quote' })[id];

    expect(emailOnACase({ RelatedToId: 'Case-000001' }, objectOf)).toBe(true);
    expect(emailOnACase({ RelatedToId: 'Quote-000001' }, objectOf)).toBe(false);
    expect(emailOnACase({ RelatedToId: 'Case-000001' })).toBe(false);
  });
});

describe('lookupsThePlatformFills', () => {
  it("names an email's task on an email that is not on a case, and nothing on one that is", () => {
    expect(
      lookupsThePlatformFills('EmailMessage', { ActivityId: '00TT', RelatedToId: '0Q0T' }),
    ).toEqual(['ActivityId']);
    expect(
      lookupsThePlatformFills('EmailMessage', { ActivityId: '00TT', ParentId: '500T' }),
    ).toEqual([]);
  });

  it('keeps the task of an email related to a case through RelatedToId alone', () => {
    // The platform takes it: "ActivityId can only be specified for emails on
    // cases", and an email whose RelatedToId is a case is one.
    expect(
      lookupsThePlatformFills('EmailMessage', {
        ActivityId: '00TT',
        RelatedToId: '500000000000001AAA',
      }),
    ).toEqual([]);
  });

  it('names nothing on other objects', () => {
    expect(lookupsThePlatformFills('Task', { ActivityId: '00TT' })).toEqual([]);
    expect(lookupsThePlatformFills('Case', { ParentId: '500T' })).toEqual([]);
  });
});

describe('emailWriteEdges', () => {
  it('writes the emails before the tasks', () => {
    expect(emailWriteEdges(new Set(['EmailMessage', 'Task', 'Account']))).toEqual([
      {
        sourceObject: 'EmailMessage',
        targetObject: 'Task',
        relationshipName: 'EmailMessageBeforeTask',
        type: 'lookup',
        required: true,
      },
    ]);
  });

  it('orders nothing in a run that does not write both', () => {
    expect(emailWriteEdges(new Set(['EmailMessage', 'Account']))).toEqual([]);
    expect(emailWriteEdges(new Set(['Task', 'Account']))).toEqual([]);
  });
});

describe('waitsForItsTask', () => {
  it('holds back an email on a case that names its task', () => {
    expect(waitsForItsTask({ ActivityId: '00TT', ParentId: '500T' })).toBe(true);
    expect(waitsForItsTask({ ActivityId: '00TT', RelatedToId: '500000000000001AAA' })).toBe(true);
    // A frozen dataset names its records by reference ids, which its index resolves.
    const objectOf = (id: string): string | undefined => (id === 'ref-7' ? 'Case' : undefined);
    expect(waitsForItsTask({ ActivityId: 'ref-3', RelatedToId: 'ref-7' }, objectOf)).toBe(true);
    expect(waitsForItsTask({ ActivityId: 'ref-3', RelatedToId: 'ref-8' }, objectOf)).toBe(false);
  });

  it('lets through an email on a case that names no task, and every other email', () => {
    expect(waitsForItsTask({ ActivityId: '', ParentId: '500T' })).toBe(false);
    expect(waitsForItsTask({ ParentId: '500T' })).toBe(false);
    expect(waitsForItsTask({ ActivityId: '00TT', RelatedToId: '0Q0T' })).toBe(false);
  });
});

describe('tasksWrittenWithEmails', () => {
  it('names the task the target holds for each email that has one', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '02sWITH', ActivityId: '00TPLATFORM' },
      { Id: '02sWITHOUT', ActivityId: null },
    ]);

    const found = await tasksWrittenWithEmails(query, ['02sWITH', '02sWITHOUT']);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id, ActivityId FROM EmailMessage WHERE Id IN ('02sWITH', '02sWITHOUT')",
    );
    expect([...found]).toEqual([['02sWITH', '00TPLATFORM']]);
  });

  it('asks nothing for no email, and two hundred at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    await tasksWrittenWithEmails(query, []);
    expect(query).not.toHaveBeenCalled();
    await tasksWrittenWithEmails(
      query,
      Array.from({ length: 201 }, (_, i) => `02s${String(i).padStart(3, '0')}`),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('existingActivityRelations', () => {
  it('finds the relation the target holds for each task and record, and no other', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '0RTWHO', TaskId: '00TT', RelationId: '003WHO' },
    ]);

    const found = await existingActivityRelations(query, 'TaskRelation', [
      { TaskId: '00TT', RelationId: '003OTHER', IsWhat: false },
      { TaskId: '00TT', RelationId: '003WHO', IsWhat: false },
    ]);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id, TaskId, RelationId FROM TaskRelation WHERE TaskId IN ('00TT')",
    );
    // The first names another contact of the task: a relation the platform
    // never wrote, sent like any other record.
    expect([...found]).toEqual([[1, '0RTWHO']]);
  });

  it('finds the relation the target holds for each event and record, and leaves an invitee to the insert', async () => {
    // The platform writes an event's relation to its who as it writes the
    // event, as it does a task's.
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '0REWHO', EventId: '00UE', RelationId: '003WHO' },
    ]);

    const found = await existingActivityRelations(query, 'EventRelation', [
      { EventId: '00UE', RelationId: '003WHO', IsParent: true, IsWhat: false },
      { EventId: '00UE', RelationId: '005INVITED', IsInvitee: true, IsWhat: false },
    ]);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id, EventId, RelationId FROM EventRelation WHERE EventId IN ('00UE')",
    );
    expect([...found]).toEqual([[0, '0REWHO']]);
  });

  it('asks nothing of an object that is no activity relation, nor when no payload names its activity', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    const other = await existingActivityRelations(query, 'AccountContactRelation', [
      { TaskId: '00TT', EventId: '00UE', RelationId: '003WHO' },
    ]);
    const none = await existingActivityRelations(query, 'TaskRelation', [{ RelationId: '003WHO' }]);

    expect(query).not.toHaveBeenCalled();
    expect(other.size).toBe(0);
    expect(none.size).toBe(0);
  });

  it('asks two hundred activities at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    await existingActivityRelations(
      query,
      'EventRelation',
      Array.from({ length: 201 }, (_, i) => ({
        EventId: `00U${String(i).padStart(3, '0')}`,
        RelationId: '003WHO',
      })),
    );

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('giveLinkedRelationsTheirFlags', () => {
  /** An update the target takes whole, one success per record. */
  const takes = () =>
    vi.fn<RelationUpdate>(async (records) => records.map(() => ({ success: true, errors: [] })));

  it("gives the relation linked for an event's who the invitee flag its row had, and says nothing", async () => {
    // The platform writes the who's relation as it writes the event, not an
    // invitee: linked to in place of the row, the who was no longer invited.
    const update = takes();

    const note = await giveLinkedRelationsTheirFlags(
      'EventRelation',
      [
        [{ Id: '0RESRC1', IsParent: true, IsInvitee: true }, '0REWHO'],
        [{ Id: '0RESRC2', IsParent: true, IsInvitee: 'true' }, '0REWHO2'],
        [{ Id: '0RESRC3', IsParent: true, IsInvitee: false }, '0REWHO3'],
      ],
      () => true,
      update,
    );

    expect(update).toHaveBeenCalledWith([
      { Id: '0REWHO', IsInvitee: true },
      { Id: '0REWHO2', IsInvitee: true },
    ]);
    expect(note).toBeUndefined();
  });

  it('writes nothing and says so when the target does not let the flag be updated', async () => {
    const update = takes();

    const note = await giveLinkedRelationsTheirFlags(
      'EventRelation',
      [
        [{ IsInvitee: true }, '0REWHO'],
        [{ IsInvitee: true }, '0REWHO2'],
      ],
      (field) => field !== 'IsInvitee',
      update,
    );

    expect(update).not.toHaveBeenCalled();
    expect(note).toBe('2 linked without IsInvitee: the target does not let it be updated');
  });

  describe("an invited who's answer", () => {
    /** An invited who that accepted, when, and in its words. */
    const ACCEPTED = {
      IsParent: true,
      IsInvitee: true,
      Status: 'Accepted',
      Response: 'Will be there',
      RespondedDate: '2026-09-01T09:30:00.000+0000',
    };

    it('goes back with the invitee flag: what the row says of it, and nothing it leaves empty', async () => {
      // The platform's relation for the who holds no answer: linked to in
      // place of the row, the invited who had never answered.
      const update = takes();

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [
          [ACCEPTED, '0REWHO'],
          [{ IsInvitee: 'true', Status: 'Declined', Response: '', RespondedDate: null }, '0REWHO2'],
          // Not invited: no answer goes back, whatever the row holds.
          [{ IsParent: true, IsInvitee: false, Status: 'New' }, '0REWHO3'],
        ],
        () => true,
        update,
      );

      expect(update).toHaveBeenCalledWith([
        {
          Id: '0REWHO',
          IsInvitee: true,
          Status: 'Accepted',
          Response: 'Will be there',
          RespondedDate: '2026-09-01T09:30:00.000+0000',
        },
        { Id: '0REWHO2', IsInvitee: true, Status: 'Declined' },
      ]);
      expect(note).toBeUndefined();
    });

    it('leaves what the target does not let be updated, and says so', async () => {
      const update = takes();

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [[ACCEPTED, '0REWHO']],
        (field) => field !== 'Response',
        update,
      );

      expect(update).toHaveBeenCalledWith([
        {
          Id: '0REWHO',
          IsInvitee: true,
          Status: 'Accepted',
          RespondedDate: '2026-09-01T09:30:00.000+0000',
        },
      ]);
      expect(note).toBe('1 linked without Response: the target does not let it be updated');
    });

    it('stays with the flag when the target does not let the flag be updated', async () => {
      // A relation that is no invitee has no answer to give.
      const update = takes();

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [[ACCEPTED, '0REWHO']],
        (field) => field !== 'IsInvitee',
        update,
      );

      expect(update).not.toHaveBeenCalled();
      expect(note).toBe('1 linked without IsInvitee: the target does not let it be updated');
    });

    /** The target's refusal of a Status value it does not hold. */
    const NOT_HELD =
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Tentative';

    it('does not cost the flag when the target refuses it, and the note names the field refused', async () => {
      // The target takes or refuses a record's update whole: sent with the
      // flag, a Status it does not hold used to take the flag with it, and
      // the date and the words of the answer too.
      const update = vi.fn<RelationUpdate>(async (records) =>
        records.map((record) =>
          record['Status'] === 'Tentative'
            ? { success: false, errors: [NOT_HELD] }
            : { success: true, errors: [] },
        ),
      );

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [
          [{ ...ACCEPTED, Status: 'Tentative' }, '0REWHO'],
          [ACCEPTED, '0REWHO2'],
        ],
        () => true,
        update,
      );

      const answer = { Response: 'Will be there', RespondedDate: '2026-09-01T09:30:00.000+0000' };
      expect(update.mock.calls.map(([records]) => records)).toEqual([
        [
          { Id: '0REWHO', IsInvitee: true, Status: 'Tentative', ...answer },
          { Id: '0REWHO2', IsInvitee: true, Status: 'Accepted', ...answer },
        ],
        [{ Id: '0REWHO', IsInvitee: true }],
        [{ Id: '0REWHO', Status: 'Tentative' }],
        [{ Id: '0REWHO', Response: 'Will be there' }],
        [{ Id: '0REWHO', RespondedDate: '2026-09-01T09:30:00.000+0000' }],
      ]);
      expect(note).toBe(`1 linked without Status: the target refused the update, ${NOT_HELD}`);
    });

    it('is not sent, nor named, when the target refuses the flag itself', async () => {
      // A relation that is no invitee has no answer to give.
      const READ_ONLY = 'INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id';
      const update = vi.fn<RelationUpdate>(async (records) =>
        records.map((record) =>
          'IsInvitee' in record
            ? { success: false, errors: [READ_ONLY] }
            : { success: true, errors: [] },
        ),
      );

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [[ACCEPTED, '0REWHO']],
        () => true,
        update,
      );

      expect(update.mock.calls.map(([records]) => records)).toEqual([
        [
          {
            Id: '0REWHO',
            IsInvitee: true,
            Status: 'Accepted',
            Response: 'Will be there',
            RespondedDate: '2026-09-01T09:30:00.000+0000',
          },
        ],
        [{ Id: '0REWHO', IsInvitee: true }],
      ]);
      expect(note).toBe(`1 linked without IsInvitee: the target refused the update, ${READ_ONLY}`);
    });

    it("is not sent again once the run's cancel stopped its update, and its refusal is still said", async () => {
      // A write stopped between two batches answers for those it sent only.
      const update = vi.fn<RelationUpdate>(async () => [{ success: false, errors: [NOT_HELD] }]);

      const note = await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [
          [{ IsInvitee: true, Status: 'Tentative' }, '0REWHO'],
          [{ IsInvitee: true, Status: 'Accepted' }, '0REWHO2'],
        ],
        () => true,
        update,
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(note).toContain(`1 linked without Status: the target refused the update, ${NOT_HELD}`);
    });

    it("is not sent once the run's cancel stopped the flags sent again", async () => {
      const update = vi
        .fn<RelationUpdate>(async (records) => records.map(() => ({ success: true, errors: [] })))
        // Refused whole, both go again a field at a time…
        .mockResolvedValueOnce([
          { success: false, errors: [NOT_HELD] },
          { success: false, errors: [NOT_HELD] },
        ])
        // …and the cancel stops their flags after the first.
        .mockResolvedValueOnce([{ success: true, errors: [] }]);

      await giveLinkedRelationsTheirFlags(
        'EventRelation',
        [
          [{ IsInvitee: true, Status: 'Tentative' }, '0REWHO'],
          [{ IsInvitee: true, Status: 'Tentative' }, '0REWHO2'],
        ],
        () => true,
        update,
      );

      expect(update).toHaveBeenCalledTimes(2);
    });
  });

  it('says which updates the target refused, and why, sending one of the flag alone once', async () => {
    const update = vi.fn<RelationUpdate>(async (records) =>
      records.map((_, i) =>
        i === 0
          ? { success: true, errors: [] }
          : { success: false, errors: ['INVALID_FIELD_FOR_INSERT_UPDATE: IsInvitee'] },
      ),
    );

    const note = await giveLinkedRelationsTheirFlags(
      'EventRelation',
      [
        [{ IsInvitee: true }, '0REWHO'],
        [{ IsInvitee: true }, '0REWHO2'],
      ],
      () => true,
      update,
    );

    // Not sent again: its refusal names the one field it carried.
    expect(update).toHaveBeenCalledTimes(1);
    expect(note).toBe(
      '1 linked without IsInvitee: the target refused the update, INVALID_FIELD_FOR_INSERT_UPDATE: IsInvitee',
    );
  });

  it('lets an update that throws reach the caller, as any other write of its run', async () => {
    await expect(
      giveLinkedRelationsTheirFlags(
        'EventRelation',
        [[{ IsInvitee: true }, '0REWHO']],
        () => true,
        async () => {
          throw new Error('Production guard refused update on EventRelation');
        },
      ),
    ).rejects.toThrow('Production guard refused update on EventRelation');
  });

  it('asks nothing of a task relation, which carries no such flag', async () => {
    const update = takes();

    const note = await giveLinkedRelationsTheirFlags(
      'TaskRelation',
      [[{ IsInvitee: true, IsWhat: false }, '0RTWHO']],
      () => true,
      update,
    );

    expect(update).not.toHaveBeenCalled();
    expect(note).toBeUndefined();
  });
});

describe('RowsLeftToThePlatform', () => {
  const TRACKED = { field: 'Type', value: 'TrackedChange', noun: 'tracked change' };

  it('keeps a post and leaves out a tracked change, counted once however often it is read', () => {
    const left = new RowsLeftToThePlatform();
    const rows = [
      { Id: '0D5POST', Type: 'TextPost' },
      { Id: '0D5CHANGE', Type: 'TrackedChange' },
    ];

    expect(left.keep('FeedItem', rows)).toEqual([{ Id: '0D5POST', Type: 'TextPost' }]);
    left.keep('FeedItem', rows);

    expect(left.has('0D5CHANGE')).toBe(true);
    expect(left.has('0D5POST')).toBe(false);
    expect(left.counts()).toEqual([
      { objectApiName: 'FeedItem', why: { rows: TRACKED }, count: 1 },
    ]);
  });

  it('leaves out what hangs from a row left out through a lookup it may not leave empty, and what hangs from that', () => {
    const left = new RowsLeftToThePlatform();
    left.keep('FeedItem', [{ Id: '0D5CHANGE', Type: 'TrackedChange' }]);

    const comments = left.keep(
      'FeedComment',
      [
        { Id: '0D7ON', FeedItemId: '0D5CHANGE' },
        { Id: '0D7OFF', FeedItemId: '0D5POST' },
      ],
      ['FeedItemId'],
    );
    const attachments = left.keep(
      'FeedAttachment',
      [{ Id: '0D6ON', FeedEntityId: '0D7ON' }],
      ['FeedEntityId'],
    );

    expect(comments).toEqual([{ Id: '0D7OFF', FeedItemId: '0D5POST' }]);
    expect(attachments).toEqual([]);
    expect(left.counts('FeedComment')).toEqual([
      { objectApiName: 'FeedComment', why: { rows: TRACKED, through: 'FeedItemId' }, count: 1 },
    ]);
    expect(left.counts('FeedAttachment')).toEqual([
      {
        objectApiName: 'FeedAttachment',
        why: { rows: TRACKED, through: 'FeedEntityId' },
        count: 1,
      },
    ]);
  });

  it('keeps a row that names a row left out through a lookup it may leave empty', () => {
    const left = new RowsLeftToThePlatform();
    left.keep('FeedItem', [{ Id: '0D5CHANGE', Type: 'TrackedChange' }]);

    expect(left.keep('Task', [{ Id: '00TA', WhatId: '0D5CHANGE' }])).toEqual([
      { Id: '00TA', WhatId: '0D5CHANGE' },
    ]);
    expect(left.counts('Task')).toEqual([]);
  });

  it('leaves out the rows it is told to instead, and what hangs from them', () => {
    // A load of a frozen dataset cannot tell a feed item whose type the
    // dataset lost from a tracked change: it leaves those out, the same way.
    const UNTYPED = { field: 'Type', value: '', noun: 'untyped feed item' };
    const left = new RowsLeftToThePlatform((objectApiName, row) =>
      objectApiName === 'FeedItem' && !row['Type'] ? UNTYPED : undefined,
    );

    expect(
      left.keep('FeedItem', [
        { Id: '0D5UNTYPED', Type: '' },
        { Id: '0D5POST', Type: 'TextPost' },
        { Id: '0D5CHANGE', Type: 'TrackedChange' },
      ]),
    ).toEqual([
      { Id: '0D5POST', Type: 'TextPost' },
      { Id: '0D5CHANGE', Type: 'TrackedChange' },
    ]);
    expect(
      left.keep('FeedComment', [{ Id: '0D7ON', FeedItemId: '0D5UNTYPED' }], ['FeedItemId']),
    ).toEqual([]);
    expect(left.counts()).toEqual([
      { objectApiName: 'FeedItem', why: { rows: UNTYPED }, count: 1 },
      { objectApiName: 'FeedComment', why: { rows: UNTYPED, through: 'FeedItemId' }, count: 1 },
    ]);
  });

  it('notes a row under the id it is given, when the row carries none of its own', () => {
    const left = new RowsLeftToThePlatform();

    expect(left.leaveOut('FeedItem', 'FeedItem-000001', { Type: 'TrackedChange' })).toEqual({
      rows: TRACKED,
    });
    expect(
      left.leaveOut('FeedComment', 'FeedComment-000001', { FeedItemId: 'FeedItem-000001' }, [
        'FeedItemId',
      ]),
    ).toEqual({ rows: TRACKED, through: 'FeedItemId' });
    expect(left.leaveOut('FeedItem', 'FeedItem-000002', { Type: 'TextPost' })).toBeUndefined();
  });

  it('words a tracked change and what hangs from one, one or several', () => {
    const own = { rows: TRACKED };
    const hanging = { rows: TRACKED, through: 'FeedItemId' };

    expect(leftToThePlatformNote(1, own)).toBe(
      '1 tracked change left out: the platform writes them itself',
    );
    expect(leftToThePlatformNote(2, own)).toBe(
      '2 tracked changes left out: the platform writes them itself',
    );
    expect(leftToThePlatformNote(2, hanging)).toBe(
      '2 left out: FeedItemId names a tracked change, which the platform writes itself',
    );
    expect(leftToThePlatformSummary(1, own)).toBe('Type=TrackedChange (1 record)');
    expect(leftToThePlatformSummary(3, hanging)).toBe('FeedItemId → tracked change (3 records)');
    expect(leftToThePlatformReason(own)).toBe(
      'Not written: the platform writes each tracked change itself, and refuses one a copy sends.',
    );
    expect(leftToThePlatformReason(hanging)).toBe(
      'Not written: FeedItemId may not be left empty, and the tracked change it names is one ' +
        'the platform writes itself, which no copy sends.',
    );
  });

  it('words the relations the platform writes from what a copy sends, and says what from', () => {
    const what = {
      rows: { field: 'IsWhat', value: true, noun: 'what relation', from: "the task's WhatId" },
    };
    const email = { rows: { noun: 'email relation', from: "the email's addresses" } };

    expect(leftToThePlatformNote(1, what)).toBe(
      "1 what relation left out: the platform writes them itself, from the task's WhatId",
    );
    expect(leftToThePlatformNote(3, email)).toBe(
      "3 email relations left out: the platform writes them itself, from the email's addresses",
    );
    expect(leftToThePlatformSummary(1, what)).toBe('IsWhat=true (1 record)');
    expect(leftToThePlatformSummary(3, email)).toBe('every email relation (3 records)');
    expect(leftToThePlatformReason(what)).toBe(
      "Not written: the platform writes each what relation itself, from the task's WhatId.",
    );
    expect(leftToThePlatformReason(email)).toBe(
      "Not written: the platform writes each email relation itself, from the email's addresses.",
    );
  });

  it('leaves out every email relation and the relation to a task’s what, and keeps a relation to a who', () => {
    const left = new RowsLeftToThePlatform();

    expect(
      left.keep('EmailMessageRelation', [
        { Id: '0CZFROM', RelationType: 'FromAddress' },
        { Id: '0CZTO', RelationType: 'ToAddress' },
      ]),
    ).toEqual([]);
    expect(
      left.keep('TaskRelation', [
        { Id: '0RTWHAT', IsWhat: true, RelationId: '0Q0Q' },
        { Id: '0RTWHO', IsWhat: false, RelationId: '003C' },
      ]),
    ).toEqual([{ Id: '0RTWHO', IsWhat: false, RelationId: '003C' }]);
    expect(left.counts().map(({ objectApiName, count }) => [objectApiName, count])).toEqual([
      ['EmailMessageRelation', 2],
      ['TaskRelation', 1],
    ]);
  });
});

describe('rowsACopySends', () => {
  /** A comment's lookup at the feed item it answers, which it may not leave empty. */
  const FEED_ITEM = { name: 'FeedItemId', referenceTo: ['FeedItem', 'OpportunityFeed'] };

  it('keeps the feed items that are not tracked changes, those with no type among them', () => {
    // SOQL's != keeps the rows where the field is null, as the copy does.
    expect(rowsACopySends('FeedItem', [], new Map([['FeedItem', undefined]]))).toEqual([
      "Type != 'TrackedChange'",
    ]);
  });

  it('keeps the comments that do not answer a tracked change the copy reads, under its filter', () => {
    const copied = new Map([
      ['FeedItem', "ParentId = '006FAKE000000001'"],
      ['FeedComment', undefined],
    ]);

    expect(rowsACopySends('FeedComment', [FEED_ITEM], copied)).toEqual([
      'FeedItemId NOT IN (SELECT Id FROM FeedItem WHERE ' +
        "(ParentId = '006FAKE000000001') AND (Type = 'TrackedChange'))",
    ]);
    expect(rowsACopySends('FeedComment', [FEED_ITEM], new Map([['FeedItem', undefined]]))).toEqual([
      "FeedItemId NOT IN (SELECT Id FROM FeedItem WHERE (Type = 'TrackedChange'))",
    ]);
  });

  it('keeps every comment when the copy reads no feed item: it leaves none of their feed items out', () => {
    expect(
      rowsACopySends('FeedComment', [FEED_ITEM], new Map([['FeedComment', undefined]])),
    ).toEqual([]);
  });

  it('keeps every row of an object that neither is nor hangs from one the platform writes', () => {
    const copied = new Map([
      ['Account', undefined],
      ['Contact', undefined],
    ]);
    expect(
      rowsACopySends('Contact', [{ name: 'AccountId', referenceTo: ['Account'] }], copied),
    ).toEqual([]);
  });

  it('refuses a filter of the copy that does more than filter, rather than send it', () => {
    const copied = new Map([['FeedItem', 'Id IN (SELECT ParentId FROM Opportunity)']]);
    expect(() => rowsACopySends('FeedComment', [FEED_ITEM], copied)).toThrow(
      /Invalid SOQL WHERE clause/,
    );
  });
});

describe('directAccountContactRelations', () => {
  it('finds the relation the platform made for each account and contact pair', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '07kDIRECT', AccountId: '001T', ContactId: '003T' },
    ]);

    const found = await directAccountContactRelations(query, [
      { AccountId: '001T', ContactId: '003T' },
      { AccountId: '001OTHER', ContactId: '003T' },
    ]);

    expect(query).toHaveBeenCalledWith(
      "SELECT Id, AccountId, ContactId FROM AccountContactRelation WHERE IsDirect = true AND ContactId IN ('003T')",
    );
    // The second payload joins the same contact to another account: an
    // indirect relation, written like any other record.
    expect([...found]).toEqual([[0, '07kDIRECT']]);
  });

  it('asks nothing when no payload names a contact', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    const found = await directAccountContactRelations(query, [{ AccountId: '001T' }]);

    expect(query).not.toHaveBeenCalled();
    expect(found.size).toBe(0);
  });

  it('asks for two hundred contacts at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);
    const payloads = Array.from({ length: 201 }, (_, i) => ({
      AccountId: '001T',
      ContactId: `003C${String(i).padStart(3, '0')}`,
    }));

    await directAccountContactRelations(query, payloads);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('existingSellingModelOptions', () => {
  it('finds the option the target holds for a product and selling model, and no other', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { Id: '0iOHELD', Product2Id: '01tHELD', ProductSellingModelId: '0jPONCE' },
    ]);

    const found = await existingSellingModelOptions(query, [
      { Product2Id: '01tNEW', ProductSellingModelId: '0jPONCE' },
      { Product2Id: '01tHELD', ProductSellingModelId: '0jPONCE' },
      // The product the target holds, under a model it has no option for.
      { Product2Id: '01tHELD', ProductSellingModelId: '0jPYEARLY' },
    ]);

    expect(query).toHaveBeenCalledWith(
      'SELECT Id, Product2Id, ProductSellingModelId FROM ProductSellingModelOption ' +
        "WHERE Product2Id IN ('01tNEW', '01tHELD')",
    );
    expect([...found]).toEqual([[1, '0iOHELD']]);
  });

  it('asks nothing when no payload names a product', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);

    const found = await existingSellingModelOptions(query, [{ ProductSellingModelId: '0jP' }]);

    expect(query).not.toHaveBeenCalled();
    expect(found.size).toBe(0);
  });

  it('asks for two hundred products at a time', async () => {
    const query = vi.fn<SoqlQuery>(async () => []);
    const payloads = Array.from({ length: 201 }, (_, i) => ({
      Product2Id: `01tP${String(i).padStart(3, '0')}`,
      ProductSellingModelId: '0jPONCE',
    }));

    await existingSellingModelOptions(query, payloads);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('recordsByNaturalKey', () => {
  const KEY = ['SellingModelType', 'PricingTerm', 'PricingTermUnit'];

  it('names the one record holding the key, and asks once per distinct key', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '0jPEXISTING' }]);
    const payload = { SellingModelType: 'OneTime', PricingTerm: 1, PricingTermUnit: 'Months' };

    const found = await recordsByNaturalKey(query, 'ProductSellingModel', KEY, [payload, payload]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      "SELECT Id FROM ProductSellingModel WHERE SellingModelType = 'OneTime' AND PricingTerm = 1 AND PricingTermUnit = 'Months' LIMIT 2",
    );
    expect(found).toEqual(['0jPEXISTING', '0jPEXISTING']);
  });

  it('names nothing when the key matches two records', async () => {
    const query = vi.fn<SoqlQuery>(async () => [{ Id: '0jPA' }, { Id: '0jPB' }]);

    const found = await recordsByNaturalKey(query, 'ProductSellingModel', KEY, [
      { SellingModelType: 'OneTime', PricingTerm: null, PricingTermUnit: null },
    ]);

    expect(query.mock.calls[0][0]).toContain('PricingTerm = null');
    expect(found).toEqual([undefined]);
  });
});

describe('statusCategories', () => {
  it('reads each status with its category and picks a Draft one', async () => {
    const query = vi.fn<SoqlQuery>(async () => [
      { ApiName: 'ST002', StatusCode: 'Activated' },
      { ApiName: 'ST001', StatusCode: 'Draft' },
    ]);

    const categories = await statusCategories(query, 'OrderStatus');

    expect(query).toHaveBeenCalledWith('SELECT ApiName, StatusCode FROM OrderStatus');
    expect(categories?.draft).toBe('ST001');
    expect(categories?.categoryOf.get('ST002')).toBe('Activated');
  });

  it('says nothing when the target cannot answer', async () => {
    const query = vi.fn<SoqlQuery>(async () => {
      throw new Error("sObject type 'ContractStatus' is not supported");
    });

    await expect(statusCategories(query, 'ContractStatus')).resolves.toBeUndefined();
  });
});

describe('STATUS_NEEDS_CHILDREN', () => {
  it('names only objects a copy writes as drafts and gives their status back', () => {
    // Rows are brought for the records written as drafts, told by the
    // lifecycle: an object without one would bring none.
    for (const objectApiName of Object.keys(STATUS_NEEDS_CHILDREN)) {
      expect(STATUS_LIFECYCLES[objectApiName]).toBeDefined();
    }
  });
});

describe('draftStartOf', () => {
  const categories = {
    categoryOf: new Map([
      ['ST001', 'Draft'],
      ['ST004', 'Activated'],
    ]),
    draft: 'ST001',
  };

  it('starts a record past Draft as a draft', () => {
    expect(draftStartOf('ST004', categories)).toBe('ST001');
  });

  it('leaves a draft, an empty status and a status the target does not know as they are', () => {
    expect(draftStartOf('ST001', categories)).toBeUndefined();
    expect(draftStartOf('', categories)).toBeUndefined();
    expect(draftStartOf(undefined, categories)).toBeUndefined();
    expect(draftStartOf('ST999', categories)).toBeUndefined();
  });

  it('leaves the record alone when the target has no Draft status to start from', () => {
    expect(draftStartOf('ST004', { ...categories, draft: undefined })).toBeUndefined();
  });
});
