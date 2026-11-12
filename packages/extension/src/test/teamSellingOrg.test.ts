import { describe, it, expect } from 'vitest';
import { TeamSellingOrg } from './teamSellingOrg.js';

const OWNER = '005TGT000000001AAA';
const OTHER = '005TGT000000002AAA';
const REVENUE = '149TGT000000001AAA';
const OVERLAY = '149TGT000000002AAA';

function org(): TeamSellingOrg {
  return new TeamSellingOrg({
    runningUser: OWNER,
    users: [OTHER],
    splitTypes: [
      { Id: REVENUE, DeveloperName: 'Revenue', IsTotalValidated: true },
      { Id: OVERLAY, DeveloperName: 'Overlay', IsTotalValidated: false },
    ],
  });
}

/** An opportunity written to `target`, and its id. */
function opportunityIn(target: TeamSellingOrg): string {
  return target.insert('Opportunity', [{ Name: 'Deal', StageName: 'Prospecting' }])[0].id;
}

describe('TeamSellingOrg', () => {
  it("writes the owner's team member and Revenue split as it takes an opportunity, and no Overlay split", () => {
    const target = org();

    const opportunity = opportunityIn(target);

    expect(target.teamOf(opportunity)).toEqual([
      expect.objectContaining({
        UserId: OWNER,
        TeamMemberRole: 'Opportunity Owner',
        OpportunityAccessLevel: 'All',
      }),
    ]);
    expect(target.splitsOf(opportunity)).toEqual([
      expect.objectContaining({
        SplitOwnerId: OWNER,
        SplitTypeId: REVENUE,
        SplitPercentage: '100',
      }),
    ]);
  });

  it('refuses a team member without its user, and one of a user it has none of', () => {
    const target = org();
    const opportunity = opportunityIn(target);

    const answers = target.insert('OpportunityTeamMember', [
      { OpportunityId: opportunity, TeamMemberRole: 'Opportunity Owner', CurrencyIsoCode: 'USD' },
      { OpportunityId: opportunity, UserId: '005SRC000000009AAA', TeamMemberRole: 'Sales Rep' },
    ]);

    expect(answers.map((a) => a.errors)).toEqual([
      ['REQUIRED_FIELD_MISSING: Required fields are missing: [UserId]'],
      ['INVALID_CROSS_REFERENCE_KEY: invalid user id'],
    ]);
  });

  it("takes the owner's member sent again as its own: the same id, the role sent", () => {
    const target = org();
    const opportunity = opportunityIn(target);
    const platforms = target.teamOf(opportunity)[0]['Id'];

    const [answer] = target.insert('OpportunityTeamMember', [
      { OpportunityId: opportunity, UserId: OWNER, TeamMemberRole: 'Sales Rep' },
    ]);

    expect(answer).toEqual({ id: platforms, success: true, errors: [] });
    expect(target.teamOf(opportunity)).toEqual([
      expect.objectContaining({ Id: platforms, TeamMemberRole: 'Sales Rep' }),
    ]);
  });

  it('refuses two splits of no user and no type in one call twice each, and one alone once', () => {
    const target = org();
    const opportunity = opportunityIn(target);

    const both = target.insert('OpportunitySplit', [
      { OpportunityId: opportunity, SplitPercentage: 100 },
      { OpportunityId: opportunity, SplitPercentage: 40, SplitNote: 'Overlay' },
    ]);
    const alone = target.insert('OpportunitySplit', [
      { OpportunityId: opportunity, SplitPercentage: 40 },
    ]);

    const notOnTheTeam =
      "INVALID_CROSS_REFERENCE_KEY: You can't create an Opportunity Split for a user unless they're part of the opportunity team. [SplitOwnerId]";
    const ownersSplit =
      "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: You can't adjust necessary split percentages from the opportunity owner's split.";
    expect(both.map((a) => a.errors)).toEqual([
      [notOnTheTeam, ownersSplit],
      [notOnTheTeam, ownersSplit],
    ]);
    expect(alone.map((a) => a.errors)).toEqual([[notOnTheTeam]]);
  });

  it("refuses the owner's Revenue split sent again, takes the owner's Overlay split, and refuses a type it has none of or a currency", () => {
    const target = org();
    const opportunity = opportunityIn(target);

    const answers = target.insert('OpportunitySplit', [
      {
        OpportunityId: opportunity,
        SplitOwnerId: OWNER,
        SplitTypeId: REVENUE,
        SplitPercentage: 100,
      },
      { OpportunityId: opportunity, SplitOwnerId: OWNER, SplitPercentage: 40 },
      {
        OpportunityId: opportunity,
        SplitOwnerId: OWNER,
        SplitTypeId: OVERLAY,
        SplitPercentage: 40,
      },
      {
        OpportunityId: opportunity,
        SplitOwnerId: OWNER,
        SplitTypeId: '149SRC000000002AAA',
        SplitPercentage: 40,
      },
      {
        OpportunityId: opportunity,
        SplitOwnerId: OWNER,
        SplitPercentage: 40,
        CurrencyIsoCode: 'USD',
      },
    ]);

    const duplicate =
      'DUPLICATE_VALUE: The user has already been entered for that split type. [SplitOwnerId]';
    expect(answers.map((a) => a.errors)).toEqual([
      [duplicate],
      [duplicate],
      [],
      [
        'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id: 149SRC000000002',
      ],
      [
        'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: CurrencyIsoCode. Please check the security settings of this field and verify that it is read/write for your profile or permission set. [CurrencyIsoCode]',
      ],
    ]);
  });

  it("takes another member's Revenue split only once the member is on the team, from the owner's", () => {
    const target = org();
    const opportunity = opportunityIn(target);
    const split = { OpportunityId: opportunity, SplitOwnerId: OTHER, SplitTypeId: REVENUE };

    const before = target.insert('OpportunitySplit', [{ ...split, SplitPercentage: 40 }]);
    target.insert('OpportunityTeamMember', [
      { OpportunityId: opportunity, UserId: OTHER, TeamMemberRole: 'Sales Rep' },
    ]);
    const after = target.insert('OpportunitySplit', [{ ...split, SplitPercentage: 40 }]);

    expect(before[0].success).toBe(false);
    expect(after[0].success).toBe(true);
    expect(
      target.splitsOf(opportunity).map((s) => [s['SplitOwnerId'], s['SplitPercentage']]),
    ).toEqual([
      [OWNER, '60'],
      [OTHER, '40'],
    ]);
  });

  it('answers the statements a clone asks of it, and throws on one it cannot read', () => {
    const target = org();
    const opportunity = opportunityIn(target);

    expect(
      target.query(
        `SELECT Id, OpportunityId, UserId FROM OpportunityTeamMember WHERE OpportunityId IN ('${opportunity}')`,
      ),
    ).toHaveLength(1);
    expect(
      target
        .query(
          'SELECT Id, DeveloperName, IsTotalValidated FROM OpportunitySplitType WHERE IsActive = true',
        )
        .map((t) => t['DeveloperName']),
    ).toEqual(['Revenue', 'Overlay']);
    expect(() => target.query('SELECT Id FROM OpportunitySplitType')).toThrow(/Not a statement/);
  });
});
