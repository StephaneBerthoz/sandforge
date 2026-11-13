/**
 * An org in miniature for the tests of an emptying's dry run: objects as the
 * global describe lists them, their describes — fields with the
 * relationship names a path reads, and the child relationships each lists,
 * flagged as real describes flag them — and rows that `COUNT()` statements
 * are read against.
 *
 * It reads what the org reads and refuses what it refuses:
 *
 * - a path of lookups (`Contact.AccountId`) is read through the relationship
 *   names of the fields it goes up, and one the object does not have is
 *   refused, `INVALID_FIELD`, as is a field it does not list;
 * - a lookup that may point at several objects is read by the type of what
 *   it names (`What.Type`), its id and its name, and refused past them, as
 *   the org reads only its `Name` entity's columns of such a parent — one
 *   whose describe names a single object and flags it `polymorphicForeignKey`
 *   too, as an operation log's related record;
 * - a checkbox read through a parent that is not there — no lookup filled,
 *   or one naming a record the org does not hold — reads false, as the org
 *   read `Pricebook2.IsStandard = false` of prices whose book was gone;
 * - a query leaves out deleted rows and archived activities; `queryAll`
 *   returns both;
 * - an object not given, or given as one the user may not see, is refused
 *   its describe, `NOT_FOUND`.
 *
 * The statements themselves are read as the memory org reads them
 * (`memorySoql.ts`), each path standing as one field. It writes nothing:
 * there is nothing a dry run may write.
 *
 * The relationships of {@link salesOrg} are those of real describes of a
 * scratch org's account, contact, price book, product and opportunity; the
 * direct relation of a contact to its account, which none of those orgs had
 * turned on, is read as Salesforce documents it, going with its contact and
 * with its account.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import type { GlobalObject } from '../modules/checkpoint/checkpointScope.js';
import type { EmptyPreviewOrg } from '../modules/dataops/empty/emptyPreview.js';
import { parseSoql, selectFrom, type SoqlRow } from './memorySoql.js';

/** A field as the fixture's describe lists it. */
export interface FixtureField {
  name: string;
  /** The objects a lookup points at. */
  referenceTo?: string[];
  relationshipName?: string;
  /** A lookup that may point at several objects, whatever `referenceTo` lists. */
  polymorphic?: boolean;
}

/** A child relationship as a parent's describe lists it. */
export interface FixtureChild {
  childSObject: string;
  field: string;
  cascadeDelete?: boolean;
  restrictedDelete?: boolean;
}

/** A row of the fixture: its id, and its values by field. */
export type FixtureRow = Record<string, unknown> & { Id: string };

/** One object of the fixture. */
export interface FixtureObject {
  name: string;
  /** What the global describe says of it beside its name: a data object the user may do anything with, unless told. */
  global?: Partial<GlobalObject>;
  /** Its fields beside `Id` and `IsDeleted`, which every object of the fixture has unless told. */
  fields?: FixtureField[];
  /** Whether it has no recycle bin: no `IsDeleted`. */
  noRecycleBin?: boolean;
  children?: FixtureChild[];
  rows?: FixtureRow[];
}

/** A statement the fixture was sent, and whether through `queryAll`. */
export interface SentStatement {
  soql: string;
  all: boolean;
}

/** An error as the org answers one, its code first. */
function orgError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

/**
 * What the org reads of the record a lookup to several objects names: the
 * columns its `Name` entity has, by their lower-case names.
 */
const NAME_COLUMNS: Readonly<Record<string, string>> = { type: 'Type', id: 'Id', name: 'Name' };

/** A field path of a statement: two names or more, joined by dots. */
const PATH = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;

/** The org in miniature: see the module's comment. */
export class EmptyFixtureOrg implements EmptyPreviewOrg {
  readonly sent: SentStatement[] = [];
  readonly described: string[] = [];
  private readonly objects = new Map<string, FixtureObject>();
  /** Statements the org refuses, with its answer, by the object they read: a timeout, a filter it needs. */
  readonly refusals = new Map<string, string>();
  /** Objects the user may not see: their describe is refused. */
  readonly hidden = new Set<string>();

  constructor(objects: readonly FixtureObject[]) {
    for (const object of objects) this.objects.set(object.name.toLowerCase(), object);
  }

  /** Every row's id, of every object. */
  ids(): Set<string> {
    return new Set(
      [...this.objects.values()].flatMap((object) => (object.rows ?? []).map((row) => row.Id)),
    );
  }

  /** The global describe of the org. */
  global(): GlobalObject[] {
    return [...this.objects.values()].map((object) => ({
      name: object.name,
      queryable: true,
      createable: true,
      updateable: true,
      deletable: true,
      layoutable: true,
      ...object.global,
    }));
  }

  async describe(objectApiName: string): Promise<unknown> {
    this.described.push(objectApiName);
    const object = this.objects.get(objectApiName.toLowerCase());
    if (!object || this.hidden.has(object.name)) {
      throw orgError('NOT_FOUND', `The requested resource does not exist`);
    }
    return {
      name: object.name,
      deletable: object.global?.deletable ?? true,
      undeletable: object.global?.undeletable ?? true,
      fields: this.fieldsOf(object).map((field) => ({
        name: field.name,
        type: field.referenceTo ? 'reference' : 'string',
        ...(field.referenceTo ? { referenceTo: field.referenceTo } : {}),
        ...(field.relationshipName ? { relationshipName: field.relationshipName } : {}),
        ...(field.polymorphic ? { polymorphicForeignKey: true } : {}),
      })),
      childRelationships: (object.children ?? []).map((child) => ({
        childSObject: child.childSObject,
        field: child.field,
        cascadeDelete: child.cascadeDelete === true,
        restrictedDelete: child.restrictedDelete === true,
      })),
    };
  }

  async count(soql: string): Promise<number> {
    return this.counted(soql, false);
  }

  async countAll(soql: string): Promise<number> {
    return this.counted(soql, true);
  }

  private fieldsOf(object: FixtureObject): FixtureField[] {
    return [
      { name: 'Id' },
      ...(object.noRecycleBin ? [] : [{ name: 'IsDeleted' }]),
      ...(object.fields ?? []),
    ];
  }

  private fieldOf(object: FixtureObject, name: string): FixtureField | undefined {
    const key = name.toLowerCase();
    return this.fieldsOf(object).find((field) => field.name.toLowerCase() === key);
  }

  /** The object holding the row of `id`, among `names`, and the row. */
  private rowOf(
    names: readonly string[],
    id: unknown,
  ): { object: FixtureObject; row: FixtureRow } | undefined {
    if (typeof id !== 'string') return undefined;
    for (const name of names) {
      const object = this.objects.get(name.toLowerCase());
      const row = object?.rows?.find((candidate) => candidate.Id === id);
      if (object && row) return { object, row };
    }
    return undefined;
  }

  /** The value of `path` read from `row` of `object`, as the org reads a path. */
  private valueAt(object: FixtureObject, row: FixtureRow, path: string): unknown {
    const names = path.split('.');
    let current: { object: FixtureObject; row: FixtureRow } | undefined = { object, row };
    for (const [at, name] of names.entries()) {
      // Through a parent that is not there, a checkbox reads false.
      if (!current) return /^Is[A-Z]/.test(names[names.length - 1]) ? false : null;
      const last = at === names.length - 1;
      if (last) {
        const field = this.fieldOf(current.object, name);
        if (!field) {
          throw orgError(
            'INVALID_FIELD',
            `No such column '${name}' on entity '${current.object.name}'`,
          );
        }
        // A checkbox is never empty: unset, it reads false.
        return current.row[field.name] ?? (/^Is[A-Z]/.test(field.name) ? false : null);
      }
      const key = name.toLowerCase();
      const lookup = this.fieldsOf(current.object).find(
        (field) => field.relationshipName?.toLowerCase() === key,
      );
      if (!lookup?.referenceTo) {
        throw orgError(
          'INVALID_FIELD',
          `Didn't understand relationship '${name}' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name.`,
        );
      }
      const target = this.rowOf(lookup.referenceTo, current.row[lookup.name]);
      if (lookup.referenceTo.length > 1 || lookup.polymorphic === true) {
        const next = names[at + 1];
        const column = NAME_COLUMNS[next.toLowerCase()];
        if (at + 1 !== names.length - 1 || column === undefined) {
          throw orgError('INVALID_FIELD', `No such column '${next}' on entity 'Name'`);
        }
        if (!target) return null;
        return column === 'Type' ? target.object.name : (target.row[column] ?? null);
      }
      current = target;
    }
    return null;
  }

  private counted(soql: string, all: boolean): number {
    this.sent.push({ soql, all });
    const paths: string[] = [];
    const quoted = soql.split(/('(?:[^'\\]|\\.)*')/);
    const plain = quoted
      .map((part, at) =>
        at % 2 === 1
          ? part
          : part.replace(PATH, (path) => {
              paths.push(path);
              return `Path${paths.length - 1}`;
            }),
      )
      .join('');
    const statement = parseSoql(plain);
    const object = this.objects.get(statement.object.toLowerCase());
    if (!object) {
      throw orgError('INVALID_TYPE', `sObject type '${statement.object}' is not supported.`);
    }
    const refusal = this.refusals.get(object.name);
    if (refusal) throw new Error(refusal);
    const rows = (object.rows ?? []).filter(
      (row) => all || (row['IsDeleted'] !== true && row['IsArchived'] !== true),
    );
    const views = rows.map(
      (row) =>
        new Proxy<SoqlRow>(
          {},
          {
            get: (_target, key) => {
              if (typeof key !== 'string') return undefined;
              const path = /^Path(\d+)$/.exec(key);
              return this.valueAt(object, row, path ? paths[Number(path[1])] : key);
            },
          },
        ),
    );
    return selectFrom(views, statement).length;
  }
}

/** A lookup field. */
function lookup(name: string, to: string | string[], relationshipName: string): FixtureField {
  return { name, referenceTo: Array.isArray(to) ? to : [to], relationshipName };
}

/** What `salesOrg` holds, record by record: see its comment. */
export interface SalesOrgOptions {
  /** Rows to add, by object. */
  extraRows?: Readonly<Record<string, FixtureRow[]>>;
  /** Objects that hold none of their rows: only those added. */
  emptyObjects?: readonly string[];
}

/** The objects an activity's `WhatId` may name in the fixture. */
const WHAT = ['Account', 'Opportunity', 'Case', 'Order', 'Quote'];
/** The objects an activity's `WhoId` may name. */
const WHO = ['Contact', 'Lead'];

/**
 * A sales org in miniature, every rule of an emptying met once:
 *
 * - three business accounts, one of them with nothing under it, and a
 *   person account with its contact;
 * - six contacts: two under the first account, two under the second — one
 *   of them a portal user's — one under no account, and the person
 *   account's;
 * - direct relations for each contact under an account, the person
 *   account's included, and one indirect relation;
 * - the standard price book and a custom one, two products, their standard
 *   prices and one custom price;
 * - three opportunities — under the first account in the custom book, under
 *   the second in the standard one, under no account in the custom book —
 *   with a product each for the first two, and a contact role;
 * - a quote and its line, an activated order and a draft one, a contract;
 * - three cases — under the first account and its contact, under the
 *   private contact, under the second account — and a comment;
 * - an asset; tasks on an account, an opportunity, a lead and nothing, one of
 *   them archived, and a deleted one; an event; a lead and a converted one;
 *   a campaign and two members;
 * - and the setup, feeds, histories, custom settings, files and packages
 *   every global describe lists beside them.
 */
export function salesOrg(options: SalesOrgOptions = {}): EmptyFixtureOrg {
  const extra = options.extraRows ?? {};
  const empty = new Set(options.emptyObjects ?? []);
  const rows = (name: string, own: FixtureRow[]): FixtureRow[] => [
    ...(empty.has(name) ? [] : own),
    ...(extra[name] ?? []),
  ];
  return new EmptyFixtureOrg([
    {
      name: 'Account',
      fields: [
        { name: 'Name' },
        { name: 'IsPersonAccount' },
        lookup('ParentId', 'Account', 'Parent'),
        lookup('PersonContactId', 'Contact', 'PersonContact'),
      ],
      children: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Order', field: 'AccountId', cascadeDelete: true, restrictedDelete: true },
        {
          childSObject: 'Contract',
          field: 'AccountId',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
        { childSObject: 'Asset', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'AccountContactRelation', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
        { childSObject: 'Event', field: 'WhatId', cascadeDelete: true },
        { childSObject: 'Account', field: 'ParentId' },
        { childSObject: 'AccountHistory', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'AccountShare', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'AccountFeed', field: 'ParentId', cascadeDelete: true },
      ],
      rows: rows('Account', [
        { Id: 'A1', Name: 'First' },
        { Id: 'A2', Name: 'Second' },
        { Id: 'A3', Name: 'Third' },
        { Id: 'PA1', Name: 'Person', IsPersonAccount: true, PersonContactId: 'PC1' },
      ]),
    },
    {
      name: 'Contact',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('ReportsToId', 'Contact', 'ReportsTo'),
        { name: 'IsPersonAccount' },
      ],
      children: [
        { childSObject: 'Case', field: 'ContactId', restrictedDelete: true },
        { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
        { childSObject: 'Event', field: 'WhoId', cascadeDelete: true },
        { childSObject: 'AccountContactRelation', field: 'ContactId', cascadeDelete: true },
        { childSObject: 'OpportunityContactRole', field: 'ContactId', cascadeDelete: true },
        { childSObject: 'CampaignMember', field: 'ContactId', cascadeDelete: true },
        { childSObject: 'Order', field: 'BillToContactId', restrictedDelete: true },
        { childSObject: 'Contract', field: 'CustomerSignedId', restrictedDelete: true },
        { childSObject: 'User', field: 'ContactId', restrictedDelete: true },
        { childSObject: 'Account', field: 'PersonContactId' },
        { childSObject: 'Lead', field: 'ConvertedContactId' },
        { childSObject: 'Opportunity', field: 'ContactId' },
        { childSObject: 'Contact', field: 'ReportsToId' },
      ],
      rows: rows('Contact', [
        { Id: 'C1', AccountId: 'A1' },
        { Id: 'C2', AccountId: 'A1' },
        { Id: 'C3', AccountId: 'A2' },
        { Id: 'CP', AccountId: 'A2' },
        { Id: 'C4', AccountId: null },
        { Id: 'PC1', AccountId: 'PA1', IsPersonAccount: true },
      ]),
    },
    {
      name: 'AccountContactRelation',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('ContactId', 'Contact', 'Contact'),
        { name: 'IsDirect' },
      ],
      rows: rows('AccountContactRelation', [
        { Id: 'ACR1', AccountId: 'A1', ContactId: 'C1', IsDirect: true },
        { Id: 'ACR2', AccountId: 'A1', ContactId: 'C2', IsDirect: true },
        { Id: 'ACR3', AccountId: 'A2', ContactId: 'C3', IsDirect: true },
        { Id: 'ACR4', AccountId: 'A2', ContactId: 'CP', IsDirect: true },
        { Id: 'ACR5', AccountId: 'PA1', ContactId: 'PC1', IsDirect: true },
        { Id: 'ACR6', AccountId: 'A2', ContactId: 'C1', IsDirect: false },
      ]),
    },
    {
      name: 'Pricebook2',
      fields: [{ name: 'IsStandard' }],
      children: [
        { childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'Pricebook2Id', restrictedDelete: true },
        { childSObject: 'Quote', field: 'Pricebook2Id', restrictedDelete: true },
        { childSObject: 'Order', field: 'Pricebook2Id', restrictedDelete: true },
        { childSObject: 'Contract', field: 'Pricebook2Id', restrictedDelete: true },
      ],
      rows: rows('Pricebook2', [
        { Id: 'PBS', IsStandard: true },
        { Id: 'PBC', IsStandard: false },
      ]),
    },
    {
      name: 'Product2',
      children: [
        {
          childSObject: 'PricebookEntry',
          field: 'Product2Id',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'OrderItem', field: 'Product2Id', restrictedDelete: true },
        { childSObject: 'QuoteLineItem', field: 'Product2Id', restrictedDelete: true },
        { childSObject: 'Asset', field: 'Product2Id', restrictedDelete: true },
      ],
      rows: rows('Product2', [{ Id: 'P1' }, { Id: 'P2' }]),
    },
    {
      name: 'PricebookEntry',
      fields: [
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        lookup('Product2Id', 'Product2', 'Product2'),
      ],
      children: [
        { childSObject: 'OpportunityLineItem', field: 'PricebookEntryId', restrictedDelete: true },
        { childSObject: 'QuoteLineItem', field: 'PricebookEntryId', restrictedDelete: true },
        { childSObject: 'OrderItem', field: 'PricebookEntryId', restrictedDelete: true },
      ],
      rows: rows('PricebookEntry', [
        { Id: 'PES1', Pricebook2Id: 'PBS', Product2Id: 'P1' },
        { Id: 'PES2', Pricebook2Id: 'PBS', Product2Id: 'P2' },
        { Id: 'PEC1', Pricebook2Id: 'PBC', Product2Id: 'P1' },
      ]),
    },
    {
      name: 'Opportunity',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        lookup('ContactId', 'Contact', 'Contact'),
        { name: 'IsWon' },
      ],
      children: [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'OpportunityContactRole', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
        { childSObject: 'Event', field: 'WhatId', cascadeDelete: true },
      ],
      rows: rows('Opportunity', [
        { Id: 'O1', AccountId: 'A1', Pricebook2Id: 'PBC' },
        { Id: 'O2', AccountId: 'A2', Pricebook2Id: 'PBS' },
        { Id: 'O3', AccountId: null, Pricebook2Id: 'PBC' },
      ]),
    },
    {
      name: 'OpportunityLineItem',
      fields: [
        lookup('OpportunityId', 'Opportunity', 'Opportunity'),
        lookup('PricebookEntryId', 'PricebookEntry', 'PricebookEntry'),
        lookup('Product2Id', 'Product2', 'Product2'),
      ],
      rows: rows('OpportunityLineItem', [
        { Id: 'OLI1', OpportunityId: 'O1', PricebookEntryId: 'PEC1', Product2Id: 'P1' },
        { Id: 'OLI2', OpportunityId: 'O2', PricebookEntryId: 'PES2', Product2Id: 'P2' },
      ]),
    },
    {
      name: 'OpportunityContactRole',
      fields: [
        lookup('OpportunityId', 'Opportunity', 'Opportunity'),
        lookup('ContactId', 'Contact', 'Contact'),
      ],
      rows: rows('OpportunityContactRole', [{ Id: 'OCR1', OpportunityId: 'O1', ContactId: 'C1' }]),
    },
    {
      name: 'Quote',
      fields: [
        lookup('OpportunityId', 'Opportunity', 'Opportunity'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
      ],
      children: [
        { childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      ],
      rows: rows('Quote', [{ Id: 'Q1', OpportunityId: 'O1', Pricebook2Id: 'PBC' }]),
    },
    {
      name: 'QuoteLineItem',
      fields: [
        lookup('QuoteId', 'Quote', 'Quote'),
        lookup('Product2Id', 'Product2', 'Product2'),
        lookup('PricebookEntryId', 'PricebookEntry', 'PricebookEntry'),
      ],
      rows: rows('QuoteLineItem', [
        { Id: 'QLI1', QuoteId: 'Q1', Product2Id: 'P1', PricebookEntryId: 'PEC1' },
      ]),
    },
    {
      name: 'Order',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        lookup('BillToContactId', 'Contact', 'BillToContact'),
        { name: 'StatusCode' },
      ],
      children: [
        { childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      ],
      rows: rows('Order', [
        {
          Id: 'ORD1',
          AccountId: 'A1',
          Pricebook2Id: 'PBC',
          BillToContactId: 'C2',
          StatusCode: 'Activated',
        },
        { Id: 'ORD2', AccountId: 'A2', Pricebook2Id: 'PBS', StatusCode: 'Draft' },
      ]),
    },
    {
      name: 'OrderItem',
      fields: [
        lookup('OrderId', 'Order', 'Order'),
        lookup('Product2Id', 'Product2', 'Product2'),
        lookup('PricebookEntryId', 'PricebookEntry', 'PricebookEntry'),
      ],
      rows: rows('OrderItem', [
        { Id: 'OI1', OrderId: 'ORD1', Product2Id: 'P1', PricebookEntryId: 'PEC1' },
      ]),
    },
    {
      name: 'Contract',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Pricebook2Id', 'Pricebook2', 'Pricebook2'),
        lookup('CustomerSignedId', 'Contact', 'CustomerSigned'),
        { name: 'StatusCode' },
      ],
      rows: rows('Contract', [
        { Id: 'CT1', AccountId: 'A1', Pricebook2Id: 'PBS', StatusCode: 'Draft' },
      ]),
    },
    {
      name: 'Case',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('ContactId', 'Contact', 'Contact'),
        lookup('ParentId', 'Case', 'Parent'),
      ],
      children: [
        { childSObject: 'Case', field: 'ParentId' },
        { childSObject: 'CaseComment', field: 'ParentId', cascadeDelete: true },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      ],
      rows: rows('Case', [
        { Id: 'CS1', AccountId: 'A1', ContactId: 'C1' },
        { Id: 'CS2', AccountId: null, ContactId: 'C4' },
        { Id: 'CS3', AccountId: 'A2', ContactId: null },
      ]),
    },
    {
      name: 'CaseComment',
      fields: [lookup('ParentId', 'Case', 'Parent')],
      rows: rows('CaseComment', [{ Id: 'CC1', ParentId: 'CS1' }]),
    },
    {
      name: 'Asset',
      fields: [
        lookup('AccountId', 'Account', 'Account'),
        lookup('Product2Id', 'Product2', 'Product2'),
      ],
      rows: rows('Asset', [{ Id: 'AS1', AccountId: 'A1', Product2Id: 'P2' }]),
    },
    {
      name: 'Task',
      fields: [lookup('WhatId', WHAT, 'What'), lookup('WhoId', WHO, 'Who'), { name: 'IsArchived' }],
      rows: rows('Task', [
        { Id: 'T1', WhatId: 'A1', WhoId: 'C1' },
        { Id: 'T2', WhatId: 'O1', WhoId: null },
        { Id: 'T3', WhatId: 'A1', WhoId: null, IsArchived: true },
        { Id: 'T4', WhatId: null, WhoId: 'L1' },
        { Id: 'T5', WhatId: null, WhoId: null },
        { Id: 'T6', WhatId: 'A2', WhoId: null, IsDeleted: true },
      ]),
    },
    {
      name: 'Event',
      fields: [lookup('WhatId', WHAT, 'What'), lookup('WhoId', WHO, 'Who'), { name: 'IsArchived' }],
      rows: rows('Event', [{ Id: 'E1', WhatId: 'A2', WhoId: null }]),
    },
    {
      name: 'Lead',
      fields: [lookup('ConvertedContactId', 'Contact', 'ConvertedContact')],
      children: [
        { childSObject: 'Task', field: 'WhoId', cascadeDelete: true },
        { childSObject: 'Event', field: 'WhoId', cascadeDelete: true },
        { childSObject: 'CampaignMember', field: 'LeadId', cascadeDelete: true },
      ],
      rows: rows('Lead', [{ Id: 'L1' }, { Id: 'L2', ConvertedContactId: 'C3' }]),
    },
    {
      name: 'Campaign',
      children: [{ childSObject: 'CampaignMember', field: 'CampaignId', cascadeDelete: true }],
      rows: rows('Campaign', [{ Id: 'CMP1' }]),
    },
    {
      name: 'CampaignMember',
      fields: [
        lookup('CampaignId', 'Campaign', 'Campaign'),
        lookup('ContactId', 'Contact', 'Contact'),
        lookup('LeadId', 'Lead', 'Lead'),
      ],
      rows: rows('CampaignMember', [
        { Id: 'CM1', CampaignId: 'CMP1', ContactId: 'C1' },
        { Id: 'CM2', CampaignId: 'CMP1', LeadId: 'L1' },
      ]),
    },
    {
      name: 'User',
      global: { createable: true, updateable: true, deletable: false },
      fields: [lookup('ContactId', 'Contact', 'Contact')],
      rows: rows('User', [{ Id: 'U1', ContactId: 'CP' }, { Id: 'U2' }]),
    },
    { name: 'AccountHistory', global: { createable: false, updateable: false, deletable: false } },
    { name: 'AccountShare' },
    { name: 'AccountFeed', global: { createable: false, updateable: false } },
    { name: 'FeedItem' },
    {
      name: 'AccountChangeEvent',
      global: { createable: false, updateable: false, deletable: false },
    },
    { name: 'PermissionSet' },
    { name: 'ApexClass' },
    { name: 'App_Config__c', global: { customSetting: true }, rows: [{ Id: 'CS-ROW' }] },
    { name: 'ContentDocument', global: { createable: false }, rows: [{ Id: 'DOC1' }] },
    { name: 'ContentVersion', global: { deletable: false } },
    { name: 'ContentDocumentLink' },
    { name: 'Attachment', global: { layoutable: false }, rows: [{ Id: 'ATT1' }] },
    { name: 'Document', global: { layoutable: false } },
    { name: 'acme__Invoice__c', rows: [{ Id: 'INV1' }] },
    { name: 'Survey_Response__c', global: { createable: false, updateable: false } },
    { name: 'Read_Only__c', global: { deletable: false } },
    { name: 'Archive__b' },
    { name: 'No_Bin__c', noRecycleBin: true },
  ]);
}
