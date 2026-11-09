import { describe, it, expect, vi } from 'vitest';
import type { Connection } from 'jsforce';
import {
  SeedPlatformRoles,
  rolesNotLookedUpNote,
  rolesOfADryRun,
  seedTargetOf,
  writtenByThePlatformLine,
} from './seedPlatformRoles.js';
import {
  contactRolesSoql,
  madeWithItsOpportunity,
  rolesMadeAlikeWords,
} from '../../core/common/platformRecords.js';
import { MADE_BY_THE_RUN, RUN_USER, secondsAfterItWentIn } from '../../test/contactRoleReads.js';

const OPP = '006000000000001AAA';
const OPP_2 = '006000000000002AAA';
const CONTACT = '003000000000001AAA';
const CONTACT_2 = '003000000000002AAA';
const PLATFORM_ROLE = '00K000000000001AAA';
const HAND_ROLE = '00K000000000002AAA';

/** The role the platform wrote with the first opportunity, as the read answers it. */
const platformRole: Record<string, unknown> = {
  Id: PLATFORM_ROLE,
  OpportunityId: OPP,
  ContactId: CONTACT,
  Role: null,
  ...MADE_BY_THE_RUN,
  Opportunity: { ...MADE_BY_THE_RUN },
};

/** A role of the same contact made by hand under the first opportunity seconds after it. */
const handRole: Record<string, unknown> = {
  ...platformRole,
  Id: HAND_ROLE,
  Role: 'Influencer',
  CreatedDate: secondsAfterItWentIn(4),
  CreatedById: RUN_USER,
};

function roles(readTarget = vi.fn(async () => [platformRole])) {
  const update = vi.fn(async (_orgId: string, _objectApiName: string, records: unknown[]) =>
    records.map(() => ({ success: true })),
  );
  const said = new SeedPlatformRoles({ orgId: 'org', readTarget, update, stopped: () => false });
  return { said, readTarget, update };
}

describe('SeedPlatformRoles', () => {
  it('pairs a role with the opportunity it names only when its contact is the one the opportunity went in with', async () => {
    const { said, readTarget, update } = roles();
    said.opportunitiesWritten([{ ContactId: CONTACT }, { ContactId: CONTACT_2 }], {
      successIds: [OPP, OPP_2],
      errors: [],
      rows: [{ id: OPP }, { id: OPP_2 }],
    });

    const linked = await said.link([
      { OpportunityId: OPP_2, ContactId: CONTACT, Role: 'Champion' },
      { OpportunityId: OPP, ContactId: CONTACT, Role: 'Decision Maker', IsPrimary: false },
    ]);

    expect([...linked.keys()]).toEqual([1]);
    // Read for the opportunity a role pairs with alone, with the fields given.
    expect(readTarget).toHaveBeenCalledWith(contactRolesSoql([OPP], ['Role']));
    // Given its role, never its primary flag nor what pairs it.
    expect(update).toHaveBeenCalledWith('org', 'OpportunityContactRole', [
      { Id: PLATFORM_ROLE, Role: 'Decision Maker' },
    ]);
    expect(said.resultOf('OpportunityContactRole')).toEqual({
      linkedIds: [PLATFORM_ROLE],
      writtenByThePlatform: { records: 1, given: 1 },
      notes: [],
    });
    expect(said.resultOf('Opportunity')).toEqual({ linkedIds: [], notes: [] });
  });

  it('links the role made with the opportunity, never one of its contact made under it after, which the target answers first', async () => {
    const { said, update } = roles(vi.fn(async () => [handRole, platformRole]));
    said.opportunitiesWritten([{ ContactId: CONTACT }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });

    const linked = await said.link([
      { OpportunityId: OPP, ContactId: CONTACT, Role: 'Decision Maker', IsPrimary: true },
    ]);

    expect(linked).toEqual(new Map([[0, platformRole]]));
    expect(update).toHaveBeenCalledWith('org', 'OpportunityContactRole', [
      { Id: PLATFORM_ROLE, Role: 'Decision Maker' },
    ]);
    expect(said.resultOf('OpportunityContactRole').linkedIds).toEqual([PLATFORM_ROLE]);
  });

  it('links none, sends the role as generated and says why, where the opportunity holds two roles of its contact made with it', async () => {
    const automations = { ...platformRole, Id: HAND_ROLE, Role: 'Business User' };
    const { said, update } = roles(vi.fn(async () => [automations, platformRole]));
    said.opportunitiesWritten([{ ContactId: CONTACT }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });

    const linked = await said.link([{ OpportunityId: OPP, ContactId: CONTACT, Role: 'Champion' }]);

    expect(linked.size).toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(said.resultOf('OpportunityContactRole')).toEqual({
      linkedIds: [],
      notes: [rolesMadeAlikeWords(1, 'generated')],
    });
    expect(rolesMadeAlikeWords(1, 'generated')).toContain('so written as generated:');
    // Its turn came: a second slice of the same contact is sent, and not said twice.
    expect((await said.link([{ OpportunityId: OPP, ContactId: CONTACT }])).size).toBe(0);
    expect(said.resultOf('OpportunityContactRole').notes).toHaveLength(1);
  });

  it('links one role an opportunity: a second slice of the same contact is sent', async () => {
    const { said } = roles();
    said.opportunitiesWritten([{ ContactId: CONTACT }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });
    await said.link([{ OpportunityId: OPP, ContactId: CONTACT }]);

    expect((await said.link([{ OpportunityId: OPP, ContactId: CONTACT }])).size).toBe(0);
  });

  it('reads nothing when no opportunity went in with a contact', async () => {
    const { said, readTarget } = roles();
    said.opportunitiesWritten([{ Name: 'Deal' }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });

    expect((await said.link([{ OpportunityId: OPP, ContactId: CONTACT }])).size).toBe(0);
    expect(readTarget).not.toHaveBeenCalled();
    expect(said.resultOf('OpportunityContactRole').notes).toEqual([]);
  });

  it('says why when a role pairs and the run cannot read the target', async () => {
    const said = new SeedPlatformRoles({
      orgId: 'org',
      readTarget: undefined,
      update: undefined,
      stopped: () => false,
    });
    said.opportunitiesWritten([{ ContactId: CONTACT }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });
    await said.link([{ OpportunityId: OPP, ContactId: CONTACT_2 }]);
    expect(said.resultOf('OpportunityContactRole').notes).toEqual([]);

    await said.link([{ OpportunityId: OPP, ContactId: CONTACT }]);
    expect(said.resultOf('OpportunityContactRole').notes).toEqual([
      rolesNotLookedUpNote('This run cannot read the target.'),
    ]);
  });

  it('gives no field once the run is stopped, and says so', async () => {
    const update = vi.fn();
    const said = new SeedPlatformRoles({
      orgId: 'org',
      readTarget: async () => [platformRole],
      update,
      stopped: () => true,
    });
    said.opportunitiesWritten([{ ContactId: CONTACT }], {
      successIds: [OPP],
      errors: [],
      rows: [{ id: OPP }],
    });
    await said.link([{ OpportunityId: OPP, ContactId: CONTACT, Role: 'Champion' }]);

    expect(update).not.toHaveBeenCalled();
    expect(said.resultOf('OpportunityContactRole').writtenByThePlatform).toEqual({
      records: 1,
      given: 0,
      refusal: 'The run was stopped before they were given them.',
    });
  });
});

describe('rolesOfADryRun', () => {
  it('answers the read of the roles with the one the platform writes for each opportunity planned with a contact', async () => {
    const dry = rolesOfADryRun();
    dry.inserted('Contact', [{ LastName: 'Doe' }], ['dry-0']);
    dry.inserted(
      'Opportunity',
      [{ ContactId: 'dry-0' }, { Name: 'No contact' }],
      ['dry-1', 'dry-2'],
    );

    const answered = await dry.readTarget(
      contactRolesSoql(['dry-1', 'dry-2'], ['Role', 'IsPrimary']),
    );
    expect(answered).toEqual([
      expect.objectContaining({
        Id: 'dry-role-0',
        OpportunityId: 'dry-1',
        ContactId: 'dry-0',
        Role: null,
        IsPrimary: true,
      }),
    ]);
    // Dated as the platform dates its own: made with the opportunity, as a run links it.
    expect(answered.map(madeWithItsOpportunity)).toEqual([true]);
    expect(await dry.update('org', 'OpportunityContactRole', [{ Id: 'dry-role-0' }])).toEqual([
      { success: true },
    ]);
    await expect(dry.readTarget('SELECT Id FROM Account')).rejects.toThrow(
      'A dry run reads nothing else of the target here.',
    );
  });
});

describe('writtenByThePlatformLine', () => {
  it('says the roles linked, those given their fields, and the target’s words for the others', () => {
    expect(writtenByThePlatformLine(undefined)).toBeUndefined();
    expect(writtenByThePlatformLine({ records: 1, given: 1 })).toBe(
      '1 record(s) linked to the contact role the platform wrote with their opportunity, for ' +
        'its contact, not written; 1 given the fields the seed generated for it.',
    );
    expect(
      writtenByThePlatformLine({
        records: 3,
        given: 2,
        refusal: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: no',
      }),
    ).toBe(
      '3 record(s) linked to the contact role the platform wrote with their opportunity, for ' +
        'its contact, not written; 2 given the fields the seed generated for them, the others ' +
        'left as the platform wrote them (FIELD_CUSTOM_VALIDATION_EXCEPTION: no).',
    );
  });
});

describe('seedTargetOf', () => {
  it('reads every page of the roles and updates each record, answering with the org’s words', async () => {
    const queryMore = vi.fn(async () => ({
      done: true,
      totalSize: 2,
      records: [{ Id: 'second' }],
    }));
    const query = vi.fn(async () => ({
      done: false,
      nextRecordsUrl: '/next',
      totalSize: 2,
      records: [{ Id: 'first' }],
    }));
    const update = vi.fn(async () => [
      { success: true, id: PLATFORM_ROLE },
      {
        success: false,
        errors: [
          {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            message: 'A role is set by the account team.',
            fields: ['Role'],
          },
        ],
      },
    ]);
    const sobject = vi.fn(() => ({ update }));
    const target = seedTargetOf({ query, queryMore, sobject } as unknown as Connection);

    expect(await target.readTarget('SELECT Id FROM OpportunityContactRole')).toEqual([
      { Id: 'first' },
      { Id: 'second' },
    ]);
    const records = [
      { Id: PLATFORM_ROLE, Role: 'Champion' },
      { Id: '00K000000000002AAA', Role: 'Champion' },
    ];
    const answers = await target.update('org', 'OpportunityContactRole', records);

    expect(sobject).toHaveBeenCalledWith('OpportunityContactRole');
    expect(update).toHaveBeenCalledWith(records, {
      allOrNone: false,
      headers: { 'Sforce-Duplicate-Rule-Header': 'allowSave=true', 'Sforce-Auto-Assign': 'FALSE' },
    });
    expect(answers[0]).toEqual({ success: true });
    expect(answers[1].success).toBe(false);
    expect(answers[1].error).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(answers[1].error).toContain('A role is set by the account team.');
  });
});
