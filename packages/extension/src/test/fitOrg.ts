/**
 * A source org in miniature for the fit of an Autopilot plan: the accounts,
 * contacts, cases and tasks of the integrity gate, with what makes a fit
 * hard — accounts and contacts pointing at each other, self-references, a
 * polymorphic lookup, a chain of parents read by id, one of them with a
 * master-detail back at a selected object.
 *
 * Its connection answers as an org does where {@link countingConnection}
 * reads leniently: a read naming a column the object lacks is refused, as the
 * org refuses it. A fixture that answered any column let a read of
 * `LastModifiedById` on FeedItem through, and the org refused the real run.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

import {
  countingConnection,
  describeOf,
  type LargeOrg,
  type LargeOrgField,
  type LargeOrgObject,
  type LargeOrgRow,
} from './largeOrg';

/** A field of the fake org. */
function field(name: string, type: string, extra: Partial<LargeOrgField> = {}): LargeOrgField {
  return {
    name,
    label: name,
    type,
    referenceTo: [],
    relationshipName: null,
    nillable: true,
    createable: true,
    updateable: true,
    unique: false,
    externalId: false,
    cascadeDelete: false,
    defaultValue: null,
    ...extra,
  };
}

/** A lookup at `targets`, one a record cannot be written without when `required`. */
export function lookupField(name: string, targets: string[], required = false): LargeOrgField {
  return field(name, 'reference', {
    referenceTo: targets,
    relationshipName: name.replace(/Id$|__c$/, ''),
    nillable: !required,
  });
}

/** An object of the fake org, with an id and a text field. */
function objectOf(name: string, keyPrefix: string, fields: LargeOrgField[]): LargeOrgObject {
  return {
    name,
    label: name,
    custom: name.endsWith('__c'),
    keyPrefix,
    queryable: true,
    createable: true,
    fields: [
      field('Id', 'id', { nillable: false, createable: false, updateable: false }),
      field('Name', 'string'),
      ...fields,
    ],
  };
}

/** The objects of the org: what each record may point at. */
function fitObjects(): Map<string, LargeOrgObject> {
  const personFlag = field('IsPersonAccount', 'boolean', { createable: false, updateable: false });
  const objects = [
    objectOf('Account', '001', [
      lookupField('ParentId', ['Account']),
      lookupField('Primary_Contact__c', ['Contact']),
      lookupField('Territory__c', ['Territory__c']),
      personFlag,
    ]),
    objectOf('Contact', '003', [
      lookupField('AccountId', ['Account']),
      lookupField('ReportsToId', ['Contact']),
      lookupField('Licence__c', ['Licence__c']),
      personFlag,
    ]),
    objectOf('Case', '500', [
      lookupField('AccountId', ['Account']),
      lookupField('ContactId', ['Contact']),
      lookupField('ParentId', ['Case']),
    ]),
    objectOf('Task', '00T', [lookupField('WhatId', ['Account', 'Case', 'Opportunity'])]),
    objectOf('Territory__c', 'a01', [lookupField('Region__c', ['Region__c'])]),
    objectOf('Region__c', 'a02', []),
    objectOf('Licence__c', 'a03', [lookupField('Account__c', ['Account'], true)]),
  ];
  return new Map(objects.map((object) => [object.name, object]));
}

/**
 * An org holding `rows`, object by object.
 *
 * @param rows - Each object's rows; `Id` is enough for one nothing names.
 */
export function fitOrg(rows: Record<string, LargeOrgRow[]>): LargeOrg {
  return { objects: fitObjects(), rows, counts: {} };
}

/** The first column a statement names that its object does not have. */
function missingColumn(org: LargeOrg, object: string, select: string): string | undefined {
  const has = new Set(org.objects.get(object)?.fields.map((f) => f.name) ?? []);
  return select
    .split(',')
    .map((name) => name.trim())
    .find((name) => !/^COUNT\(\)$/i.test(name) && !has.has(name));
}

/**
 * A connection to the fake org that counts what it is asked, refuses a column
 * the object lacks (`INVALID_FIELD`) and answers `FIELDS(ALL)` with the rows'
 * fields, as a run reads them.
 */
export function fitConnection(org: LargeOrg): ReturnType<typeof countingConnection> {
  const counted = countingConnection(org);
  const query = async (soql: string) => {
    const [, select = '', object = ''] = /^SELECT\s+(.+?)\s+FROM\s+(\w+)/is.exec(soql) ?? [];
    if (select === 'FIELDS(ALL)') {
      const every = describeOf(org, object).fields.map((f) => f.name);
      return counted.conn.query(soql.replace('FIELDS(ALL)', every.join(', ')));
    }
    const missing = missingColumn(org, object, select);
    if (missing !== undefined) {
      throw Object.assign(new Error(`No such column '${missing}' on entity '${object}'`), {
        errorCode: 'INVALID_FIELD',
      });
    }
    return counted.conn.query(soql);
  };
  return { ...counted, conn: { ...counted.conn, query } };
}
