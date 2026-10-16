/**
 * An org shaped like a large client sandbox, behind a connection that counts
 * every call it answers.
 *
 * Run for real, a client sandbox of some six hundred and seventy custom
 * objects showed what a small fixture never does: an Autopilot plan for two
 * objects walked into six hundred, and a Frozen selection of one candidate
 * spent six hundred and forty API calls in its first two minutes. Both are
 * questions of how many objects a walk reaches and how many calls each costs,
 * which only a schema of that size answers. Most objects here are custom; a
 * quarter hang under `Case`, a third point at `Account`, each points at the
 * next one along — a chain as deep as the org — and many at a reference table
 * of tens of thousands of rows nobody selected.
 *
 * The connection answers what the scanners, the discovery, the extraction
 * and the selection ask — describes, the global describe, counts, scoped
 * reads and grouped values — and reads its WHERE clauses leniently: the
 * equality and IN terms it can test are tested, any other term (a date bound)
 * holds. What matters to the tests built on it is how many calls a step makes
 * and which records it reaches.
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

/** A field of the fake org, as a describe gives it. */
export interface LargeOrgField {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  relationshipName: string | null;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  unique: boolean;
  externalId: boolean;
  cascadeDelete: boolean;
  defaultValue: null;
}

/** An object of the fake org. */
export interface LargeOrgObject {
  name: string;
  label: string;
  custom: boolean;
  keyPrefix: string;
  queryable: boolean;
  createable: boolean;
  fields: LargeOrgField[];
}

/** A row of the fake org. */
export type LargeOrgRow = Record<string, string | number | boolean | null>;

/** The fake org: its objects, the rows a read returns, and what a count says of the others. */
export interface LargeOrg {
  objects: Map<string, LargeOrgObject>;
  /** Rows of the objects whose records a test reads. */
  rows: Record<string, LargeOrgRow[]>;
  /** What a `COUNT()` of the whole table says, where it says more than the rows listed. */
  counts: Record<string, number>;
}

/** The shape of {@link largeOrg}. */
export interface LargeOrgOptions {
  /** Custom objects, besides the standard ones. */
  customObjects?: number;
  /** Cases, each with an `Origin`. */
  cases?: number;
  /** Rows of each custom object under each case, for the objects that hang under `Case`. */
  rowsPerCase?: number;
  /** Leads, a third of them converted. */
  leads?: number;
  /**
   * Field service beside the cases, left out unless asked: a work order under
   * each case, booked in one territory of a tree that shares its operating
   * hours with every account, and assets under each account. Run for real, a
   * dossier of three cases took 39 540 territories and every asset of the
   * cases' accounts.
   */
  fieldService?: {
    /** Assets under each account, and under nothing of a case. */
    assetsPerAccount: number;
    /** Territories beside the one each work order is booked in, under the same parent. */
    territories: number;
  };
}

/** Key prefixes of the standard objects. */
const STANDARD_PREFIXES: Readonly<Record<string, string>> = {
  Account: '001',
  Contact: '003',
  User: '005',
  Opportunity: '006',
  Lead: '00Q',
  Task: '00T',
  Group: '00G',
  CaseComment: '00a',
  RecordType: '012',
  EmailMessage: '02s',
  OperatingHours: '0OH',
  Case: '500',
  Asset: '02i',
  WorkOrder: '0WO',
  ServiceAppointment: '08p',
  ServiceTerritory: '0Hh',
};

/** A field with every attribute the describes read. */
function field(
  name: string,
  type: string,
  extra: Partial<Omit<LargeOrgField, 'name' | 'type'>> = {},
): LargeOrgField {
  return {
    name,
    label: extra.label ?? name.replace(/__c$/, '').replace(/_/g, ' '),
    type,
    referenceTo: extra.referenceTo ?? [],
    relationshipName: extra.relationshipName ?? null,
    nillable: extra.nillable ?? true,
    createable: extra.createable ?? true,
    updateable: extra.updateable ?? true,
    unique: false,
    externalId: false,
    cascadeDelete: extra.cascadeDelete ?? false,
    defaultValue: null,
  };
}

/** A lookup field. */
function lookup(name: string, targets: string[], required = false): LargeOrgField {
  return field(name, 'reference', {
    referenceTo: targets,
    relationshipName: name.replace(/Id$/, '').replace(/__c$/, '__r'),
    nillable: !required,
  });
}

/** The fields every object carries: its id, name and audit stamps. */
function base(nameField = true): LargeOrgField[] {
  return [
    field('Id', 'id', { nillable: false, createable: false, updateable: false }),
    ...(nameField ? [field('Name', 'string', { nillable: false })] : []),
    lookup('OwnerId', ['User', 'Group']),
    field('CreatedDate', 'datetime', { nillable: false, createable: false, updateable: false }),
    lookup('CreatedById', ['User']),
  ];
}

/** The name of the custom object at `index`, from 1. */
export function customObjectName(index: number): string {
  return `Obj${String(index).padStart(3, '0')}__c`;
}

/** An id of `object`, the `n`-th, from 1. */
export function fakeId(org: LargeOrg, object: string, n: number): string {
  const prefix = org.objects.get(object)?.keyPrefix ?? 'zzz';
  return `${prefix}${String(n).padStart(12, '0')}AAA`;
}

/**
 * Build the fake org.
 *
 * @param options - How large, and how many records the tests read.
 */
export function largeOrg(options: LargeOrgOptions = {}): LargeOrg {
  const customCount = options.customObjects ?? 600;
  const caseCount = options.cases ?? 4;
  const rowsPerCase = options.rowsPerCase ?? 2;
  const leadCount = options.leads ?? 30;
  const objects = new Map<string, LargeOrgObject>();
  const add = (name: string, custom: boolean, fields: LargeOrgField[], keyPrefix?: string) => {
    objects.set(name, {
      name,
      label: name.replace(/__c$/, ''),
      custom,
      keyPrefix: keyPrefix ?? STANDARD_PREFIXES[name] ?? 'zzz',
      queryable: true,
      createable: true,
      fields,
    });
  };

  add('User', false, [...base(), field('Email', 'email'), field('Username', 'string')]);
  add('Group', false, [...base()]);
  add('RecordType', false, [...base(), field('SobjectType', 'string')]);
  add('OperatingHours', false, [...base()]);
  add('Account', false, [
    ...base(),
    lookup('ParentId', ['Account']),
    lookup('OperatingHoursId', ['OperatingHours']),
    field('Phone', 'phone'),
  ]);
  add('Contact', false, [
    ...base(false),
    field('FirstName', 'string'),
    field('LastName', 'string', { nillable: false }),
    field('Email', 'email'),
    field('Phone', 'phone'),
    field('MobilePhone', 'phone'),
    lookup('AccountId', ['Account']),
    lookup('ReportsToId', ['Contact']),
  ]);
  add('Opportunity', false, [
    ...base(),
    lookup('AccountId', ['Account']),
    field('StageName', 'picklist'),
  ]);
  add('Lead', false, [
    ...base(false),
    field('FirstName', 'string'),
    field('LastName', 'string', { nillable: false }),
    field('Email', 'email'),
    field('Phone', 'phone'),
    field('Company', 'string', { nillable: false }),
    // Filled by the conversion: no insert or update sets them.
    { ...lookup('ConvertedAccountId', ['Account']), createable: false, updateable: false },
    { ...lookup('ConvertedContactId', ['Contact']), createable: false, updateable: false },
    { ...lookup('ConvertedOpportunityId', ['Opportunity']), createable: false, updateable: false },
  ]);
  add('Case', false, [
    ...base(false),
    field('Subject', 'string'),
    field('Origin', 'picklist'),
    lookup('AccountId', ['Account']),
    lookup('ContactId', ['Contact']),
    lookup('ParentId', ['Case']),
  ]);
  add('CaseComment', false, [
    ...base(false),
    lookup('ParentId', ['Case'], true),
    field('CommentBody', 'textarea'),
  ]);
  add('EmailMessage', false, [
    ...base(false),
    lookup('ParentId', ['Case']),
    field('ToAddress', 'string'),
  ]);
  add('Task', false, [
    ...base(false),
    field('Subject', 'string'),
    lookup('WhatId', ['Account', 'Case', 'Opportunity']),
    lookup('WhoId', ['Contact', 'Lead']),
  ]);
  add('PostalCode__c', true, [...base(), field('Code__c', 'string')], 'a0P');
  if (options.fieldService) {
    add('Asset', false, [
      ...base(),
      lookup('AccountId', ['Account']),
      lookup('ContactId', ['Contact']),
    ]);
    add('ServiceTerritory', false, [
      ...base(),
      lookup('ParentTerritoryId', ['ServiceTerritory']),
      lookup('OperatingHoursId', ['OperatingHours'], true),
    ]);
    add('WorkOrder', false, [
      ...base(false),
      lookup('CaseId', ['Case']),
      lookup('AccountId', ['Account']),
      lookup('ServiceTerritoryId', ['ServiceTerritory']),
    ]);
    add('ServiceAppointment', false, [
      ...base(false),
      lookup('ParentRecordId', ['WorkOrder'], true),
      lookup('ServiceTerritoryId', ['ServiceTerritory']),
    ]);
  }

  for (let i = 1; i <= customCount; i++) {
    const fields = [...base()];
    if (i % 4 === 0) fields.push(lookup('Case__c', ['Case'], i % 8 === 0));
    if (i % 3 === 0) fields.push(lookup('Account__c', ['Account']));
    if (i % 5 === 0) fields.push(lookup('Contact__c', ['Contact']));
    if (i % 2 === 0) fields.push(lookup('PostalCode__c', ['PostalCode__c']));
    if (i < customCount) fields.push(lookup('Next__c', [customObjectName(i + 1)]));
    fields.push(lookup('Other__c', [customObjectName(((i * 7) % customCount) + 1)]));
    fields.push(field('Notes__c', 'textarea'));
    add(customObjectName(i), true, fields, `a${(i + 100).toString(36).padStart(2, '0')}`);
  }

  const org: LargeOrg = { objects, rows: {}, counts: {} };
  const created = '2026-01-01T00:00:00.000Z';
  const origins = ['Phone', 'Web', 'Email', 'Chat'];
  org.rows.User = [{ Id: fakeId(org, 'User', 1), Name: 'Integration', CreatedDate: created }];
  org.rows.Account = Array.from({ length: 20 }, (_, i) => ({
    Id: fakeId(org, 'Account', i + 1),
    Name: `Account ${i + 1}`,
    ParentId: i > 0 && i % 5 === 0 ? fakeId(org, 'Account', i) : null,
    OperatingHoursId: null,
    OwnerId: fakeId(org, 'User', 1),
    CreatedDate: created,
  }));
  org.rows.Contact = Array.from({ length: 40 }, (_, i) => ({
    Id: fakeId(org, 'Contact', i + 1),
    FirstName: `First${i + 1}`,
    LastName: `Last${i + 1}`,
    Email: `person${i + 1}@example.invalid`,
    Phone: '+33100000000',
    AccountId: fakeId(org, 'Account', (i % 20) + 1),
    ReportsToId: null,
    OwnerId: fakeId(org, 'User', 1),
    CreatedDate: created,
  }));
  org.rows.Opportunity = Array.from({ length: 10 }, (_, i) => ({
    Id: fakeId(org, 'Opportunity', i + 1),
    Name: `Opportunity ${i + 1}`,
    AccountId: fakeId(org, 'Account', (i % 20) + 1),
    StageName: 'Won',
    OwnerId: fakeId(org, 'User', 1),
    CreatedDate: created,
  }));
  org.rows.Lead = Array.from({ length: leadCount }, (_, i) => {
    const converted = i % 3 === 0;
    return {
      Id: fakeId(org, 'Lead', i + 1),
      FirstName: `Lead${i + 1}`,
      LastName: `Person${i + 1}`,
      Email: `lead${i + 1}@example.invalid`,
      Phone: '+33100000001',
      Company: `Company ${i + 1}`,
      // Converted leads point at the account, contact and opportunity they
      // became — three accounts among the twenty, two contacts among forty.
      ConvertedAccountId: converted ? fakeId(org, 'Account', (i % 3) + 1) : null,
      ConvertedContactId: converted ? fakeId(org, 'Contact', (i % 2) + 1) : null,
      ConvertedOpportunityId: converted ? fakeId(org, 'Opportunity', 1) : null,
      OwnerId: fakeId(org, 'User', 1),
      CreatedDate: created,
    };
  });
  org.rows.Case = Array.from({ length: caseCount }, (_, i) => ({
    Id: fakeId(org, 'Case', i + 1),
    Subject: `Case ${i + 1}`,
    Origin: origins[i % origins.length],
    AccountId: fakeId(org, 'Account', (i % 20) + 1),
    ContactId: fakeId(org, 'Contact', (i % 40) + 1),
    ParentId: null,
    OwnerId: fakeId(org, 'User', 1),
    CreatedDate: created,
  }));
  org.rows.CaseComment = org.rows.Case.map((row, i) => ({
    Id: fakeId(org, 'CaseComment', i + 1),
    ParentId: row.Id,
    CommentBody: 'Called back',
    CreatedDate: created,
  }));
  // The custom objects under a case hold a few rows for each, which point on
  // along the chain and at the reference table.
  for (let i = 4; i <= customCount; i += 4) {
    const name = customObjectName(i);
    org.rows[name] = org.rows.Case.flatMap((row, c) =>
      Array.from({ length: rowsPerCase }, (_, r) => ({
        Id: fakeId(org, name, c * rowsPerCase + r + 1),
        Name: `${name} ${c}-${r}`,
        Case__c: row.Id,
        PostalCode__c: fakeId(org, 'PostalCode__c', c + 1),
        Next__c: null,
        Other__c: null,
        OwnerId: fakeId(org, 'User', 1),
        CreatedDate: created,
      })),
    );
  }
  org.rows.PostalCode__c = Array.from({ length: caseCount }, (_, i) => ({
    Id: fakeId(org, 'PostalCode__c', i + 1),
    Name: `750${String(i).padStart(2, '0')}`,
    CreatedDate: created,
  }));
  if (options.fieldService) addFieldService(org, options.fieldService, created);
  // Tables nobody selected, as large as a real org has them: counted, never read.
  org.counts.PostalCode__c = 61_635;
  org.counts.OperatingHours = 8_169;
  for (let i = 1; i <= customCount; i++) {
    const name = customObjectName(i);
    if (!org.rows[name]) org.counts[name] = 1_000 + i;
  }
  return org;
}

/**
 * The rows of {@link LargeOrgOptions.fieldService}: one set of operating
 * hours every account and territory names, a territory tree whose top holds
 * the one each work order is booked in and `territories` more, a work order
 * and an appointment under each case, and assets under each account.
 */
function addFieldService(
  org: LargeOrg,
  shape: NonNullable<LargeOrgOptions['fieldService']>,
  created: string,
): void {
  const hours = fakeId(org, 'OperatingHours', 1);
  org.rows.OperatingHours = [{ Id: hours, Name: 'Office hours', CreatedDate: created }];
  for (const account of org.rows.Account ?? []) account.OperatingHoursId = hours;
  const top = fakeId(org, 'ServiceTerritory', 1);
  // The territory the work orders are booked in is the second; its siblings follow.
  org.rows.ServiceTerritory = Array.from({ length: shape.territories + 2 }, (_, i) => ({
    Id: fakeId(org, 'ServiceTerritory', i + 1),
    Name: `Territory ${i + 1}`,
    ParentTerritoryId: i === 0 ? null : top,
    OperatingHoursId: hours,
    CreatedDate: created,
  }));
  const booked = fakeId(org, 'ServiceTerritory', 2);
  org.rows.WorkOrder = (org.rows.Case ?? []).map((row, i) => ({
    Id: fakeId(org, 'WorkOrder', i + 1),
    CaseId: row.Id,
    AccountId: row.AccountId,
    ServiceTerritoryId: booked,
    CreatedDate: created,
  }));
  org.rows.ServiceAppointment = org.rows.WorkOrder.map((row, i) => ({
    Id: fakeId(org, 'ServiceAppointment', i + 1),
    ParentRecordId: row.Id,
    ServiceTerritoryId: booked,
    CreatedDate: created,
  }));
  org.rows.Asset = (org.rows.Account ?? []).flatMap((account, a) =>
    Array.from({ length: shape.assetsPerAccount }, (_, i) => ({
      Id: fakeId(org, 'Asset', a * shape.assetsPerAccount + i + 1),
      Name: `Asset ${a + 1}-${i + 1}`,
      AccountId: account.Id,
      ContactId: null,
      CreatedDate: created,
    })),
  );
}

/** Every call the fake connection answered, by kind. */
export interface LargeOrgCalls {
  describes: string[];
  describeGlobals: number;
  queries: string[];
  limits: number;
}

/** A WHERE term the reader tests: every row holds an untested one. */
type RowTest = (row: LargeOrgRow) => boolean;

/** Tokens of a WHERE clause: literals, operators, parentheses, words. */
const TOKEN = /'(?:[^'\\]|\\.)*'|!=|<=|>=|[(),=<>]|[\w.:+-]+/g;

/** The rows of `rows` a WHERE clause selects, read leniently (see the file header). */
function whereTest(where: string): RowTest {
  const tokens = where.match(TOKEN) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (): string => tokens[at++] ?? '';
  const literal = (token: string): string | null => {
    if (/^null$/i.test(token)) return null;
    return token.startsWith("'") ? token.slice(1, -1).replace(/\\(.)/g, '$1') : token;
  };
  const valueOf = (row: LargeOrgRow, name: string): string | null => {
    const value = row[name];
    return value === null || value === undefined ? null : String(value);
  };
  const skipGroup = (): void => {
    let depth = 0;
    do {
      const token = take();
      if (token === '(') depth++;
      if (token === ')') depth--;
    } while (depth > 0 && at < tokens.length);
  };
  const primary = (): RowTest => {
    if (peek() === '(') {
      take();
      const inner = anyOf();
      if (peek() === ')') take();
      return inner;
    }
    if (peek()?.toUpperCase() === 'NOT') {
      take();
      const inner = primary();
      return (row) => !inner(row);
    }
    const name = take();
    let operator = take().toUpperCase();
    let negated = false;
    if (operator === 'NOT') {
      negated = true;
      operator = take().toUpperCase();
    }
    if (operator === 'IN') {
      if (/^\(\s*$/.test(peek() ?? '') || peek() === '(') {
        // A semi-join reads another table: held, as any term the reader cannot test.
        if ((tokens[at + 1] ?? '').toUpperCase() === 'SELECT') {
          skipGroup();
          return () => true;
        }
        take();
        const values: Array<string | null> = [];
        for (let token = take(); token !== ')' && at <= tokens.length; token = take()) {
          if (token !== ',') values.push(literal(token));
        }
        return (row) => values.includes(valueOf(row, name)) !== negated;
      }
    }
    const value = literal(take());
    if (operator === '=') return (row) => valueOf(row, name) === value;
    if (operator === '!=') return (row) => valueOf(row, name) !== value;
    return () => true;
  };
  const allOf = (): RowTest => {
    const tests = [primary()];
    while (peek()?.toUpperCase() === 'AND') {
      take();
      tests.push(primary());
    }
    return (row) => tests.every((test) => test(row));
  };
  const anyOf = (): RowTest => {
    const tests = [allOf()];
    while (peek()?.toUpperCase() === 'OR') {
      take();
      tests.push(allOf());
    }
    return (row) => tests.some((test) => test(row));
  };
  return tokens.length === 0 ? () => true : anyOf();
}

/** A query result, as jsforce gives one. */
interface FakeQueryResult {
  records: LargeOrgRow[];
  totalSize: number;
  done: true;
}

/** Answer one statement against the fake org. */
export function answerQuery(org: LargeOrg, soql: string): FakeQueryResult {
  const statement =
    /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+GROUP BY\s+(\w+))?(?:\s+ORDER BY\s+[\w\s,]+?)?(?:\s+LIMIT\s+(\d+))?(?:\s+OFFSET\s+(\d+))?$/is.exec(
      soql.trim(),
    );
  if (!statement) throw new Error(`Not a statement the fake org reads: ${soql}`);
  const [, select, object, where, groupBy, limit, offset] = statement;
  const listed = org.rows[object];
  const test = whereTest(where ?? '');
  if (/^COUNT\(\)$/i.test(select.trim())) {
    // A table counted whole says what `counts` says of it, rows listed or not:
    // a test lists the few rows it reads of a table far larger.
    const totalSize = where
      ? (listed ?? []).filter(test).length
      : (org.counts[object] ?? listed?.length ?? 0);
    return { records: [], totalSize, done: true };
  }
  const matched = (listed ?? []).filter(test);
  if (groupBy) {
    const alias = /(\w+)\s+axisValue/i.exec(select);
    if (!alias) return { records: [], totalSize: 0, done: true };
    const values = [...new Set(matched.map((row) => row[alias[1]] ?? null))];
    const rows = values.map((value) => ({ axisValue: value }));
    const bounded = limit ? rows.slice(0, Number(limit)) : rows;
    return { records: bounded, totalSize: bounded.length, done: true };
  }
  const sorted = [...matched].sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  const from = offset ? Number(offset) : 0;
  const rows = sorted.slice(from, limit ? from + Number(limit) : undefined);
  return { records: rows.map((row) => ({ ...row })), totalSize: rows.length, done: true };
}

/** The describe of one object, its child relationships read off every other object's lookups. */
export function describeOf(org: LargeOrg, name: string) {
  const object = org.objects.get(name);
  if (!object) throw new Error(`The requested resource does not exist: ${name}`);
  const childRelationships = [...org.objects.values()].flatMap((child) =>
    child.fields
      .filter((f) => f.referenceTo.includes(name))
      .map((f) => ({
        childSObject: child.name,
        field: f.name,
        relationshipName: `${child.name}_${f.name}`,
        cascadeDelete: f.cascadeDelete,
      })),
  );
  return {
    name: object.name,
    label: object.label,
    custom: object.custom,
    keyPrefix: object.keyPrefix,
    queryable: object.queryable,
    createable: object.createable,
    fields: object.fields.map((f) => ({ ...f })),
    childRelationships,
    recordTypeInfos: [],
  };
}

/**
 * A connection to the fake org that counts what it is asked: the methods of a
 * jsforce connection the scanners, the discovery, the extraction and the
 * selection call.
 */
export function countingConnection(org: LargeOrg) {
  const calls: LargeOrgCalls = { describes: [], describeGlobals: 0, queries: [], limits: 0 };
  const describe = async (name: string) => {
    calls.describes.push(name);
    return describeOf(org, name);
  };
  const conn = {
    describeGlobal: async () => {
      calls.describeGlobals++;
      return {
        sobjects: [...org.objects.values()].map((o) => ({
          name: o.name,
          label: o.label,
          custom: o.custom,
          keyPrefix: o.keyPrefix,
          queryable: o.queryable,
          createable: o.createable,
          deletable: true,
          updateable: true,
        })),
      };
    },
    describe,
    sobject: (name: string) => ({ describe: () => describe(name) }),
    query: async (soql: string) => {
      calls.queries.push(soql);
      return answerQuery(org, soql);
    },
    queryMore: async () => ({ records: [], totalSize: 0, done: true as const }),
    request: async () => {
      calls.limits++;
      return { DataStorageMB: { Max: 200, Remaining: 25 } };
    },
    tooling: { describeGlobal: async () => ({ sobjects: [] }) },
  };
  /** Every call so far. */
  const total = (): number =>
    calls.describes.length + calls.describeGlobals + calls.queries.length + calls.limits;
  return { conn, calls, total };
}
