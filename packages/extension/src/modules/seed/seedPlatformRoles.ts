/**
 * The contact role the platform writes itself with each opportunity a seed
 * inserts with its contact, and the role the seed generated for that contact.
 *
 * Learnt in a real org (`rolesThePlatformWrites`): an opportunity inserted
 * with its `ContactId` is given, as it is taken, a contact role of that
 * contact, primary, with no role, written by the user the run writes as. A
 * seed that went on to insert the role it generated for that contact on that
 * opportunity left the opportunity two roles of one contact. A clone, a Sync
 * and a Frozen load link the role they copy to the platform's. A seed's role
 * is the copy of none, but it is the role the template asks of that contact
 * on that opportunity, and the platform's stands where it would have gone: it
 * is linked the same way, given the fields the run generated for it, and
 * never sent. Left unsent instead, the role the template generated — its
 * `Role` — would be lost, and the platform's left with none; and a role is
 * never left unsent on the word of a rule alone: one no record is found for
 * goes in as generated.
 */

import { recordWriteHeaders, type SeedObjectResult } from '@sandforge/shared';
import {
  CONTACT_FIELD,
  OPPORTUNITY_CONTACT_ROLE,
  contactRolesOfSoql,
  rolesThePlatformWrote,
  type SoqlQuery,
} from '../../core/common/platformRecords.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { recordErrorText } from '../../core/common/existingRecordMatch.js';
import type { Connection } from 'jsforce';
import type { InsertResult } from './SeedOrchestrator';

/** The object whose records the platform writes a contact role with. */
export const OPPORTUNITY = 'Opportunity';

/** What the org answered for one record of an update. */
export interface UpdatedRow {
  success: boolean;
  /** Why it refused it, in its words. */
  error?: string;
}

/** Function signature for updating records of the org, each by its id, answered in order. */
export type UpdateFn = (
  orgId: string,
  objectApiName: string,
  records: Array<Record<string, unknown> & { Id: string }>,
) => Promise<UpdatedRow[]>;

/** What a role object's result says of the roles linked to the platform's. */
export type RolesWrittenByThePlatform = NonNullable<SeedObjectResult['writtenByThePlatform']>;

/**
 * The fields a role linked to the platform's is never given. The two that pair
 * it with the platform's record, and its primary flag: the platform made it
 * primary, as the opportunity's `ContactId` names its primary role's contact.
 * A role generated not primary for that contact, given its flag, would leave
 * the opportunity with no primary contact — and change the contact the run
 * wrote on the opportunity, which an update of its role sets.
 */
const NOT_GIVEN: ReadonlySet<string> = new Set(['Id', 'OpportunityId', CONTACT_FIELD, 'IsPrimary']);

/** Records per update call. */
const UPDATE_CHUNK = 200;

/** A record's key: its id's first fifteen characters, as the org matches ids. */
const idKey = (id: string): string => id.slice(0, 15);

/** The words of a role object's result when the roles could not be paired with the platform's. */
export function rolesNotLookedUpNote(why: string): string {
  return (
    "The contact roles the platform wrote with the run's opportunities were not looked up, " +
    `so written as generated: an opportunity may hold the role of its contact twice. ${why}`
  );
}

/** What a seed holds of the roles the platform wrote with its opportunities, across its objects. */
export interface SeedPlatformRolesDeps {
  orgId: string;
  /** Reads the target; without it, no role is looked up. */
  readTarget: SoqlQuery | undefined;
  /** Updates records of the target; without it, a linked role keeps what the platform wrote. */
  update: UpdateFn | undefined;
  /** Whether the run's cancel came: no role is given its fields after it. */
  stopped: () => boolean;
}

/**
 * The run's account of the roles the platform wrote: the contact each
 * opportunity it created went in with, then, as its contact roles go in, those
 * linked to the platform's, and what its result says of them.
 */
export class SeedPlatformRoles {
  /** The contact each opportunity the run created went in with, by the opportunity's key. */
  private readonly sentWith = new Map<string, string>();
  /** Why some opportunity's contact cannot be told: its role cannot be paired. */
  private untold: string | undefined;
  /** The platform's records the roles were linked to, by their id. */
  private readonly linkedIds: string[] = [];
  private said: RolesWrittenByThePlatform | undefined;
  /** Why the roles were not looked up, once said. */
  private unread: string | undefined;

  constructor(private readonly deps: SeedPlatformRolesDeps) {}

  /**
   * Note, of an insert of opportunities, the contact each it created went in
   * with. An insert that did not answer record by record, or an id the org
   * did not say whose it is, leaves an opportunity of a contact whose role
   * cannot be paired: said with the roles.
   */
  opportunitiesWritten(records: readonly Record<string, unknown>[], result: InsertResult): void {
    const withContact = (record: Record<string, unknown> | undefined): string | undefined => {
      const contact = record?.[CONTACT_FIELD];
      return typeof contact === 'string' && contact !== '' ? contact : undefined;
    };
    const answered =
      result.rows && (result.rows.length === records.length || result.stopped)
        ? result.rows
        : undefined;
    if (!answered) {
      if (result.successIds.length > 0 && records.some((record) => withContact(record))) {
        this.untold ??=
          "The opportunities' insert did not say which record each id it answered is.";
      }
      return;
    }
    answered.forEach((answer, i) => {
      const contact = withContact(records[i]);
      if (!answer.id || contact === undefined) return;
      if (answer.unmatched) {
        this.untold ??=
          "The opportunities' insert did not say which record each id it answered is.";
        return;
      }
      this.sentWith.set(idKey(answer.id), contact);
    });
  }

  /**
   * Of a slice of contact roles about to be inserted, each the platform wrote
   * itself with one of the run's opportunities, for the contact it went in
   * with, by the role's index, with the platform's record: the primary one of
   * that contact first, one an opportunity (`rolesThePlatformWrote`). Each is
   * given by an update the fields the run generated for it it lacks; none is
   * sent. None when the target could not be read: the roles go as generated,
   * and the result says why.
   */
  async link(
    records: readonly Record<string, unknown>[],
  ): Promise<Map<number, Readonly<Record<string, unknown>>>> {
    if (records.length > 0 && this.untold !== undefined) this.unread ??= this.untold;
    if (this.sentWith.size === 0 || records.length === 0) return new Map();
    const pairing = records.map((record) => ({
      OpportunityId: record['OpportunityId'],
      [CONTACT_FIELD]: record[CONTACT_FIELD],
      IsPrimary: record['IsPrimary'],
    }));
    const sentWith = (opportunity: string): string | undefined =>
      this.sentWith.get(idKey(opportunity));
    const read = this.deps.readTarget;
    if (!read) {
      // Nothing to look the roles up with: said once a role pairs.
      if (pairsAny(pairing, sentWith)) this.unread ??= 'This run cannot read the target.';
      return new Map();
    }
    let found: Map<number, Readonly<Record<string, unknown>>>;
    try {
      found = await rolesThePlatformWrote(read, pairing, sentWith, givenFields(records));
    } catch (err: unknown) {
      this.unread ??= extractErrorMessage(err);
      return new Map();
    }
    for (const index of found.keys()) {
      this.sentWith.delete(idKey(String(records[index]['OpportunityId'])));
    }
    if (found.size > 0) await this.give(records, found);
    return found;
  }

  /**
   * Give each role linked to the platform's the fields the run generated for
   * it it lacks, and count what the target took: a role it refused stays as
   * the platform wrote it, linked all the same, its words kept.
   */
  private async give(
    records: readonly Record<string, unknown>[],
    found: ReadonlyMap<number, Readonly<Record<string, unknown>>>,
  ): Promise<void> {
    const said = (this.said ??= { records: 0, given: 0 });
    const updates: Array<Record<string, unknown> & { Id: string }> = [];
    for (const [index, record] of found) {
      const id = String(record['Id']);
      this.linkedIds.push(id);
      said.records++;
      const lacks = Object.entries(records[index] ?? {}).filter(
        ([field, value]) =>
          !NOT_GIVEN.has(field) &&
          value !== null &&
          value !== undefined &&
          String(record[field] ?? '') !== String(value),
      );
      if (lacks.length > 0) updates.push({ Id: id, ...Object.fromEntries(lacks) });
    }
    if (updates.length === 0) return;
    const refused = (why: string): void => {
      said.refusal ??= why;
    };
    if (!this.deps.update) return refused('This run cannot update the target.');
    for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
      if (this.deps.stopped()) return refused('The run was stopped before they were given them.');
      const chunk = updates.slice(i, i + UPDATE_CHUNK);
      let answers: UpdatedRow[];
      try {
        answers = await this.deps.update(this.deps.orgId, OPPORTUNITY_CONTACT_ROLE, chunk);
      } catch (err: unknown) {
        refused(extractErrorMessage(err));
        continue;
      }
      chunk.forEach((_, at) => {
        const answer = answers[at];
        if (answer?.success) said.given++;
        else refused(answer?.error ?? 'The org gave no answer for it.');
      });
    }
  }

  /**
   * What the result of `objectApiName` says of the roles the platform wrote:
   * the ids of the records linked, what linking them came to, and why some
   * were not looked up. Nothing for any other object.
   */
  resultOf(objectApiName: string): {
    linkedIds: readonly string[];
    writtenByThePlatform?: RolesWrittenByThePlatform;
    notes: string[];
  } {
    if (objectApiName !== OPPORTUNITY_CONTACT_ROLE) return { linkedIds: [], notes: [] };
    return {
      linkedIds: this.linkedIds,
      ...(this.said ? { writtenByThePlatform: { ...this.said } } : {}),
      notes: this.unread !== undefined ? [rolesNotLookedUpNote(this.unread)] : [],
    };
  }
}

/** The fields of the roles, besides those that pair them, the read asks of the platform's. */
function givenFields(records: readonly Record<string, unknown>[]): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))].filter(
    (field) => !NOT_GIVEN.has(field),
  );
}

/** Whether a role of `pairing` is of the contact its opportunity went in with. */
function pairsAny(
  pairing: ReadonlyArray<Record<string, unknown>>,
  sentWith: (opportunity: string) => string | undefined,
): boolean {
  return pairing.some((row) => {
    const opportunity = row['OpportunityId'];
    const contact = row[CONTACT_FIELD];
    if (typeof opportunity !== 'string' || typeof contact !== 'string') return false;
    const sent = sentWith(opportunity);
    return sent !== undefined && idKey(sent) === idKey(contact);
  });
}

/**
 * What a dry run answers in place of the target, which it writes nothing to:
 * the contact role the platform writes with each opportunity the dry run
 * planned with its contact — of that contact, primary, with no role — read as
 * the target's, and an update that takes everything and writes nothing. A
 * dry run then says the roles a run links, rather than counting them among
 * those it inserts. The dry run's insert tells it each record it planned.
 */
export function rolesOfADryRun(): {
  inserted(objectApiName: string, records: readonly Record<string, unknown>[], ids: string[]): void;
  readTarget: SoqlQuery;
  update: UpdateFn;
} {
  /** The contact each planned opportunity went in with, by its id. */
  const contactOf = new Map<string, string>();
  let roles = 0;
  return {
    inserted(objectApiName, records, ids) {
      if (objectApiName !== OPPORTUNITY) return;
      records.forEach((record, i) => {
        const contact = record[CONTACT_FIELD];
        const id = ids[i];
        if (id !== undefined && typeof contact === 'string' && contact !== '') {
          contactOf.set(id, contact);
        }
      });
    },
    readTarget: async (soql) => {
      const asked = contactRolesOfSoql(soql);
      if (!asked) throw new Error('A dry run reads nothing else of the target here.');
      return asked.opportunities.flatMap((opportunity) => {
        const contact = contactOf.get(opportunity);
        if (contact === undefined) return [];
        return [
          {
            ...Object.fromEntries(asked.fields.map((field) => [field, null])),
            Id: `dry-role-${roles++}`,
            OpportunityId: opportunity,
            [CONTACT_FIELD]: contact,
            ...(asked.fields.includes('IsPrimary') ? { IsPrimary: true } : {}),
          },
        ];
      });
    },
    update: async (_orgId, _objectApiName, records) => records.map(() => ({ success: true })),
  };
}

/**
 * What the result line of a role object says of the roles linked to the
 * platform's, in the command line's words: nothing for an object with none.
 */
export function writtenByThePlatformLine(
  said: RolesWrittenByThePlatform | undefined,
): string | undefined {
  if (!said) return undefined;
  return (
    `${said.records} record(s) linked to the contact role the platform wrote with their ` +
    `opportunity, for its contact, not written; ${said.given} given the fields the seed ` +
    `generated for ${said.given === 1 ? 'it' : 'them'}` +
    (said.refusal !== undefined
      ? `, the others left as the platform wrote them (${said.refusal}).`
      : '.')
  );
}

/**
 * The target's read and update, as a seed's run asks them of `conn`, the
 * panel's connection or the command line's: a read of every page, an update
 * that answers record by record.
 */
export function seedTargetOf(conn: Connection): { readTarget: SoqlQuery; update: UpdateFn } {
  return {
    readTarget: (soql) => queryAll(conn, soql),
    update: async (_orgId, objectApiName, records) => {
      // With the headers of every write of a seed: duplicate rules waived,
      // the target's assignment rules off.
      const answered: unknown = await conn
        .sobject(objectApiName)
        .update(records, { allOrNone: false, headers: recordWriteHeaders() });
      const answers = (Array.isArray(answered) ? answered : [answered]) as Array<
        { success?: boolean; errors?: unknown[] } | undefined
      >;
      return records.map((_, i): UpdatedRow => {
        const answer = answers[i];
        if (answer?.success === true) return { success: true };
        return {
          success: false,
          // With its code and the fields it named, as an insert's refusal is said.
          error:
            (answer?.errors ?? []).length > 0
              ? recordErrorText(answer?.errors)
              : 'The org gave no answer for it.',
        };
      });
    },
  };
}
