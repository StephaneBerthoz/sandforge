/**
 * A target org with Team Selling and Opportunity Splits on, in miniature: what
 * it writes itself as it takes an opportunity, and what it refuses of a copy,
 * in the words a real org used.
 *
 * Each rule was read from a scratch org with both on, through the REST API's
 * sObject Collections as a clone writes, and through anonymous Apex in a
 * transaction rolled back:
 * - an opportunity goes in with its owner's team member — role "Opportunity
 *   Owner", access All — and its owner's split of each type held to a total
 *   of 100 %, at 100 %; no other split;
 * - a member without a user is refused `REQUIRED_FIELD_MISSING`, one of a user
 *   the org has none of `INVALID_CROSS_REFERENCE_KEY` "invalid user id", and
 *   one of a user on the team already goes in as that member — the insert
 *   answers with its id, and the role sent replaces its own;
 * - a split without a type is one of the Revenue type; one whose type the org
 *   holds none of is refused `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`,
 *   one with a currency `INVALID_FIELD_FOR_INSERT_UPDATE`, one of a user not
 *   on the team — or of none — `INVALID_CROSS_REFERENCE_KEY` "You can't create
 *   an Opportunity Split for a user unless they're part of the opportunity
 *   team", and one of a type the user holds a split of already
 *   `DUPLICATE_VALUE`. Two such refused splits held to 100 % in one call,
 *   which the owner's split could not give between them, are each refused
 *   besides `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY` "You can't adjust
 *   necessary split percentages from the opportunity owner's split";
 * - a split held to 100 % of another member is taken from the owner's: 40 %
 *   written, the owner's goes to 60 %.
 *
 * Queries are read by `selectRows`: what it cannot read throws.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

import { selectRows, type FakeRow } from './fakeSoql.js';

/** One record's answer to an insert, as the executor's deps give it. */
export interface TeamSellingInsertResult {
  id: string;
  success: boolean;
  errors: string[];
}

/** A split type of the org. */
export interface TeamSellingSplitType {
  readonly Id: string;
  readonly DeveloperName: string;
  readonly IsTotalValidated: boolean;
  readonly IsActive?: boolean;
}

/** What the org holds before anything is written. */
export interface TeamSellingOrgOptions {
  /** The user every write is made as: the owner of an opportunity sent without one. */
  readonly runningUser: string;
  /** The org's other active users. */
  readonly users?: readonly string[];
  readonly splitTypes: readonly TeamSellingSplitType[];
}

const NOT_ON_THE_TEAM =
  "INVALID_CROSS_REFERENCE_KEY: You can't create an Opportunity Split for a user unless " +
  "they're part of the opportunity team. [SplitOwnerId]";
const OWNERS_SPLIT_SHORT =
  "CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: You can't adjust necessary split percentages from the opportunity owner's split.";
const SPLIT_CURRENCY =
  'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: CurrencyIsoCode. Please ' +
  'check the security settings of this field and verify that it is read/write for your ' +
  'profile or permission set. [CurrencyIsoCode]';

/** The text of a field, or nothing. */
const text = (row: Record<string, unknown>, field: string): string | undefined => {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** The org: its tables, its inserts and its queries. */
export class TeamSellingOrg {
  /** Every record of the org, by object. */
  readonly tables: Record<string, FakeRow[]> = {
    Account: [],
    Opportunity: [],
    OpportunityTeamMember: [],
    OpportunitySplit: [],
    OpportunitySplitType: [],
    User: [],
  };
  /** What each insert call was sent, by object, in order. */
  readonly sent: Record<string, Array<Record<string, unknown>>> = {};
  private issued = 0;

  constructor(private readonly options: TeamSellingOrgOptions) {
    for (const id of [options.runningUser, ...(options.users ?? [])]) {
      this.tables['User'].push({ Id: id, IsActive: true });
    }
    for (const type of options.splitTypes) {
      this.tables['OpportunitySplitType'].push({
        Id: type.Id,
        DeveloperName: type.DeveloperName,
        IsTotalValidated: type.IsTotalValidated,
        IsActive: type.IsActive ?? true,
      });
    }
  }

  /** The rows a statement selects, as `selectRows` reads it. */
  query(soql: string): FakeRow[] {
    return selectRows(this.tables, soql);
  }

  /** Whether the org holds rows of `objectApiName`. */
  holds(objectApiName: string): boolean {
    return this.tables[objectApiName] !== undefined;
  }

  /** One call's insert of `rows`, answered row by row. */
  insert(
    objectApiName: string,
    rows: readonly Record<string, unknown>[],
  ): TeamSellingInsertResult[] {
    (this.sent[objectApiName] ??= []).push(...rows.map((row) => ({ ...row })));
    if (objectApiName === 'OpportunityTeamMember') return rows.map((row) => this.member(row));
    if (objectApiName === 'OpportunitySplit') return this.splits(rows);
    return rows.map((row) => {
      const id = this.idFor(objectApiName);
      const record: FakeRow = { Id: id };
      for (const [field, value] of Object.entries(row)) {
        if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
          record[field] = value;
        } else if (typeof value === 'number') {
          record[field] = String(value);
        }
      }
      if (objectApiName === 'Opportunity') {
        record['OwnerId'] = text(row, 'OwnerId') ?? this.options.runningUser;
        this.writeWithTheOpportunity(id, String(record['OwnerId']));
      }
      (this.tables[objectApiName] ??= []).push(record);
      return { id, success: true, errors: [] };
    });
  }

  /** The members of an opportunity's team. */
  teamOf(opportunityId: string): FakeRow[] {
    return this.tables['OpportunityTeamMember'].filter((m) => m['OpportunityId'] === opportunityId);
  }

  /** The splits of an opportunity. */
  splitsOf(opportunityId: string): FakeRow[] {
    return this.tables['OpportunitySplit'].filter((s) => s['OpportunityId'] === opportunityId);
  }

  private idFor(objectApiName: string): string {
    this.issued++;
    const prefix: Record<string, string> = {
      Account: '001',
      Opportunity: '006',
      OpportunityTeamMember: '00q',
      OpportunitySplit: '049',
    };
    return `${prefix[objectApiName] ?? 'a00'}TGT${String(this.issued).padStart(9, '0')}AAA`;
  }

  /** The owner's member, and the owner's split of each type held to 100 %. */
  private writeWithTheOpportunity(opportunityId: string, owner: string): void {
    this.tables['OpportunityTeamMember'].push({
      Id: this.idFor('OpportunityTeamMember'),
      OpportunityId: opportunityId,
      UserId: owner,
      TeamMemberRole: 'Opportunity Owner',
      OpportunityAccessLevel: 'All',
    });
    for (const type of this.activeTypes().filter((t) => t.IsTotalValidated)) {
      this.tables['OpportunitySplit'].push({
        Id: this.idFor('OpportunitySplit'),
        OpportunityId: opportunityId,
        SplitOwnerId: owner,
        SplitTypeId: type.Id,
        SplitPercentage: '100',
      });
    }
  }

  private activeTypes(): TeamSellingSplitType[] {
    return this.options.splitTypes.filter((t) => t.IsActive !== false);
  }

  private member(row: Record<string, unknown>): TeamSellingInsertResult {
    const user = text(row, 'UserId');
    if (user === undefined) {
      return {
        id: '',
        success: false,
        errors: ['REQUIRED_FIELD_MISSING: Required fields are missing: [UserId]'],
      };
    }
    if (!this.tables['User'].some((u) => u['Id'] === user && u['IsActive'] === true)) {
      return { id: '', success: false, errors: ['INVALID_CROSS_REFERENCE_KEY: invalid user id'] };
    }
    const opportunity = String(row['OpportunityId']);
    const on = this.teamOf(opportunity).find((m) => m['UserId'] === user);
    if (on) {
      if (typeof row['TeamMemberRole'] === 'string') on['TeamMemberRole'] = row['TeamMemberRole'];
      return { id: String(on['Id']), success: true, errors: [] };
    }
    const id = this.idFor('OpportunityTeamMember');
    this.tables['OpportunityTeamMember'].push({
      Id: id,
      OpportunityId: opportunity,
      UserId: user,
      TeamMemberRole: typeof row['TeamMemberRole'] === 'string' ? row['TeamMemberRole'] : null,
      OpportunityAccessLevel:
        typeof row['OpportunityAccessLevel'] === 'string' ? row['OpportunityAccessLevel'] : null,
    });
    return { id, success: true, errors: [] };
  }

  private splits(rows: readonly Record<string, unknown>[]): TeamSellingInsertResult[] {
    const revenue = this.activeTypes().find((t) => t.DeveloperName === 'Revenue');
    const results = rows.map((row): TeamSellingInsertResult & { total?: string } => {
      if ('CurrencyIsoCode' in row) return { id: '', success: false, errors: [SPLIT_CURRENCY] };
      const typeId = text(row, 'SplitTypeId') ?? revenue?.Id;
      const type = this.activeTypes().find((t) => t.Id === typeId);
      if (type === undefined) {
        return {
          id: '',
          success: false,
          errors: [
            `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id: ${String(typeId).slice(0, 15)}`,
          ],
        };
      }
      const opportunity = String(row['OpportunityId']);
      const user = text(row, 'SplitOwnerId');
      const total = type.IsTotalValidated ? opportunity : undefined;
      if (user === undefined || !this.teamOf(opportunity).some((m) => m['UserId'] === user)) {
        return { id: '', success: false, errors: [NOT_ON_THE_TEAM], ...(total ? { total } : {}) };
      }
      const splits = this.splitsOf(opportunity);
      if (splits.some((s) => s['SplitOwnerId'] === user && s['SplitTypeId'] === type.Id)) {
        return {
          id: '',
          success: false,
          errors: [
            'DUPLICATE_VALUE: The user has already been entered for that split type. [SplitOwnerId]',
          ],
        };
      }
      const percentage = Number(row['SplitPercentage'] ?? 0);
      if (type.IsTotalValidated) {
        const owner = this.tables['Opportunity'].find((o) => o['Id'] === opportunity)?.['OwnerId'];
        const ownersSplit = splits.find(
          (s) => s['SplitOwnerId'] === owner && s['SplitTypeId'] === type.Id,
        );
        if (ownersSplit) {
          ownersSplit['SplitPercentage'] = String(
            Number(ownersSplit['SplitPercentage']) - percentage,
          );
        }
      }
      const id = this.idFor('OpportunitySplit');
      this.tables['OpportunitySplit'].push({
        Id: id,
        OpportunityId: opportunity,
        SplitOwnerId: user,
        SplitTypeId: type.Id,
        SplitPercentage: String(percentage),
        SplitNote: typeof row['SplitNote'] === 'string' ? row['SplitNote'] : null,
      });
      return { id, success: true, errors: [] };
    });
    // Refused for want of the team, the splits held to 100 % of one
    // opportunity that the owner's could not give between them.
    const refusedTotals = new Map<string, number>();
    results.forEach((result, i) => {
      if (result.total === undefined) return;
      const asked = Number(rows[i]['SplitPercentage'] ?? 0);
      refusedTotals.set(result.total, (refusedTotals.get(result.total) ?? 0) + asked);
    });
    return results.map(({ total, ...result }) => {
      const refusedCount = results.filter((r) => r.total !== undefined && r.total === total).length;
      return total !== undefined && refusedCount > 1 && (refusedTotals.get(total) ?? 0) > 100
        ? { ...result, errors: [...result.errors, OWNERS_SPLIT_SHORT] }
        : result;
    });
  }
}
