import { describe, it, expect } from 'vitest';
import type { ForgeGap, ForgeGraph, ForgeGraphNode, ForgeTargetGaps } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import {
  ACTIVE_DUPLICATE_RULES_SOQL,
  FORMULAS_BOUND,
  TargetGapReader,
  bypassesOf,
  callsEstimateOf,
  gapFieldOf,
  gapLines,
  validationFormulaSoql,
  validationRulesSoql,
  type GapField,
  type GapRunScope,
  type TargetGapDeps,
} from './TargetGapReader.js';
import { USER_PERMISSIONS_SOQL, type QueryAnswer } from './TargetAutomationReader.js';

const SOURCE = 'src-org';
const TARGET = 'tgt-org';

/** A node of a discovered graph, included unless told. */
function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function graphOf(nodes: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes,
    edges: [],
    totalRecords: nodes.reduce((sum, n) => sum + n.recordCount, 0),
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/** A field as both orgs describe it unless told: optional, createable text. */
function field(name: string, overrides: Partial<GapField> = {}): GapField {
  return {
    name,
    type: 'string',
    createable: true,
    nillable: true,
    defaultedOnCreate: false,
    referenceTo: [],
    picklistValues: [],
    lookupFilter: null,
    ...overrides,
  };
}

/** A validation rule of the target, as the Tooling API lists it. */
function rule(
  id: string,
  name: string,
  objectApiName: string,
  displayField: string | null = null,
): Record<string, unknown> {
  return {
    Id: id,
    ValidationName: name,
    NamespacePrefix: null,
    ErrorDisplayField: displayField,
    ErrorMessage: `${name} message`,
    EntityDefinition: { QualifiedApiName: objectApiName },
  };
}

/** An 18-character id of a validation rule, numbered. */
const ruleId = (n: number): string => `03d00000000${String(n).padStart(4, '0')}AAA`;

/** An active duplicate rule of the target, as SOQL lists it. */
function duplicateRule(developerName: string, objectApiName: string): Record<string, unknown> {
  return {
    DeveloperName: developerName,
    MasterLabel: developerName.replace(/_/g, ' '),
    NamespacePrefix: null,
    SobjectType: objectApiName,
  };
}

/** What the fake orgs hold, and what they refuse. */
interface FakeOrgs {
  rules?: Array<Record<string, unknown>>;
  formulas?: Record<string, string>;
  duplicates?: Array<Record<string, unknown>>;
  definitions?: Record<string, Record<string, unknown>>;
  targetFields?: Record<string, GapField[]>;
  sourceFields?: Record<string, GapField[]>;
  limits?: unknown;
  held?: Array<Record<string, unknown>>;
  /** Describes already held, by `<org>::<object>`: they cost the read nothing. */
  held_describes?: ReadonlySet<string>;
  refuse?: Partial<
    Record<'rules' | 'formulas' | 'duplicates' | 'definitions' | 'limits' | 'held', Error>
  > & { describe?: ReadonlySet<string> };
}

/** The reader's deps over fake orgs, with what each was asked and the most asked at once. */
function fakeDeps(orgs: FakeOrgs = {}) {
  const asked: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const call = async <T>(label: string, answer: () => T): Promise<T> => {
    asked.push(label);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return answer();
    } finally {
      inFlight--;
    }
  };
  const page = (records: Array<Record<string, unknown>>): QueryAnswer => ({ records, requests: 1 });
  const refuse = orgs.refuse ?? {};
  const deps: TargetGapDeps = {
    query: (orgId, soql) =>
      call(`query ${orgId} ${soql}`, () => {
        if (soql === ACTIVE_DUPLICATE_RULES_SOQL) {
          if (refuse.duplicates) throw refuse.duplicates;
          return page(orgs.duplicates ?? []);
        }
        if (soql === USER_PERMISSIONS_SOQL) {
          if (refuse.held) throw refuse.held;
          return page(orgs.held ?? []);
        }
        throw new Error(`unexpected query ${soql}`);
      }),
    toolingQuery: (orgId, soql) =>
      call(`tooling ${orgId} ${soql}`, () => {
        if (soql.includes(' FROM ValidationRule WHERE Active = true')) {
          if (refuse.rules) throw refuse.rules;
          return page(orgs.rules ?? []);
        }
        const id = /WHERE Id = '(\w+)'/.exec(soql)?.[1] ?? '';
        if (refuse.formulas) throw refuse.formulas;
        const formula = orgs.formulas?.[id];
        return page(
          formula === undefined ? [] : [{ Metadata: { errorConditionFormula: formula } }],
        );
      }),
    describeFields: (orgId, objectApiName) => {
      const key = `${orgId}::${objectApiName}`;
      const sent = !(orgs.held_describes ?? new Set()).has(key);
      const run = () => {
        if (refuse.describe?.has(key)) throw new Error(`INVALID_TYPE: ${objectApiName}`);
        const fields = (orgId === TARGET ? orgs.targetFields : orgs.sourceFields)?.[objectApiName];
        return { fields: fields ?? [field('Name')], sent };
      };
      return sent ? call(`describe ${key}`, run) : Promise.resolve().then(run);
    },
    readDuplicateRules: (orgId, fullNames) =>
      call(`metadata ${orgId} ${fullNames.join(',')}`, () => {
        if (refuse.definitions) throw refuse.definitions;
        return fullNames.flatMap((name) => {
          const definition = orgs.definitions?.[name];
          return definition ? [{ fullName: name, ...definition }] : [];
        });
      }),
    readLimits: (orgId) =>
      call(`limits ${orgId}`, () => {
        if (refuse.limits) throw refuse.limits;
        return orgs.limits ?? { DailyApiRequests: { Max: 100_000, Remaining: 100_000 } };
      }),
  };
  return { deps, asked, mostInFlight: () => mostInFlight };
}

/** Read the gaps of a run of `nodes`, over fake orgs. */
async function readGaps(
  nodes: ForgeGraphNode[],
  orgs: FakeOrgs = {},
  scope: GapRunScope = {},
): Promise<ForgeTargetGaps & { asked: string[]; mostInFlight: number }> {
  const fake = fakeDeps(orgs);
  const read = await new TargetGapReader(fake.deps).read(SOURCE, TARGET, graphOf(nodes), scope);
  return { ...read, asked: fake.asked, mostInFlight: fake.mostInFlight() };
}

/** The gaps of one kind. */
function ofKind(read: ForgeTargetGaps, kind: ForgeGap['kind']): ForgeGap[] {
  return read.gaps.filter((gap) => gap.kind === kind);
}

describe('TargetGapReader — validation rules', () => {
  it('reads the active rules of the objects the run writes, one gap each, from the target', async () => {
    const read = await readGaps([node('Account'), node('Contact')], {
      rules: [
        rule(ruleId(1), 'Phone_Format', 'Contact', 'Phone'),
        rule(ruleId(2), 'Other', 'Lead'),
      ],
      formulas: { [ruleId(1)]: 'AND(NOT(ISBLANK(Phone)), NOT(REGEX(Phone, "[0-9]+")))' },
      targetFields: { Contact: [field('LastName'), field('Phone')] },
    });

    expect(ofKind(read, 'validation_rule')).toEqual([
      {
        id: forgeGapId('validation_rule', 'Contact', 'Phone', undefined, 'Phone_Format'),
        kind: 'validation_rule',
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Contact',
        field: 'Phone',
        rows: 0,
        detail: { rule: 'Phone_Format', message: 'Phone_Format message', formula: 'read' },
        decisions: ['leave_empty', 'ignore'],
        defaultDecision: 'leave_empty',
      },
    ]);
    expect(read.asked).toContain(
      `tooling ${TARGET} ${validationRulesSoql(['Account', 'Contact'])}`,
    );
    expect(read.asked).toContain(`tooling ${TARGET} ${validationFormulaSoql(ruleId(1))}`);
    expect(read.asked.some((call) => call.includes(` ${SOURCE} `) && call.includes('Rule'))).toBe(
      false,
    );
  });

  it('offers only to ignore a rule that shows its error at the top of the page', async () => {
    const read = await readGaps([node('Account')], {
      rules: [rule(ruleId(1), 'Needs_Region', 'Account')],
      formulas: { [ruleId(1)]: 'ISBLANK(Region__c)' },
    });
    const [gap] = ofKind(read, 'validation_rule');
    expect(gap.field).toBeUndefined();
    expect(gap.decisions).toEqual(['ignore']);
    expect(gap.defaultDecision).toBeUndefined();
  });

  it('takes the label the API gives a rule shown at the top of the page for no field, in any language', async () => {
    const read = await readGaps([node('Account')], {
      rules: [
        rule(ruleId(1), 'Top_French', 'Account', 'Haut de la page'),
        rule(ruleId(2), 'Top_German', 'Account', 'Seitenanfang'),
        rule(ruleId(3), 'On_Phone', 'Account', 'Account.phone'),
      ],
      targetFields: { Account: [field('Name'), field('Phone')] },
    });
    const fieldOf = new Map(ofKind(read, 'validation_rule').map((g) => [g.detail?.rule, g.field]));
    expect(Object.fromEntries(fieldOf)).toEqual({
      On_Phone: 'Phone',
      Top_French: undefined,
      Top_German: undefined,
    });
  });

  it('names what in a formula keeps the rule quiet, and says a permission the user holds keeps it quiet for the run', async () => {
    const read = await readGaps([node('Account')], {
      rules: [
        rule(ruleId(1), 'Held', 'Account', 'Phone'),
        rule(ruleId(2), 'Not_Held', 'Account', 'Phone'),
      ],
      formulas: {
        [ruleId(1)]: 'AND(NOT($Permission.Bypass_VR), ISBLANK(Phone))',
        [ruleId(2)]:
          "AND($Setup.Switches__c.Off__c = FALSE, $Profile.Name <> 'Integration', NOT($Permission.Other))",
      },
      held: [{ DeveloperName: 'Bypass_VR', NamespacePrefix: null }],
    });

    const byRule = new Map(ofKind(read, 'validation_rule').map((g) => [g.detail?.rule, g]));
    expect(byRule.get('Held')).toMatchObject({
      severity: 'info',
      detail: { bypasses: ['$Permission.Bypass_VR'], heldBypasses: ['Bypass_VR'] },
    });
    expect(byRule.get('Not_Held')).toMatchObject({
      severity: 'warning',
      detail: {
        bypasses: [
          '$Permission.Other',
          '$Setup.Switches__c.Off__c',
          "$Profile.Name = 'Integration'",
        ],
      },
    });
    expect(byRule.get('Not_Held')?.detail).not.toHaveProperty('heldBypasses');
    expect(read.asked.filter((call) => call.includes('UserSetupEntityAccess'))).toHaveLength(1);
  });

  it('asks nothing of the user when no formula names a permission that keeps a rule quiet', async () => {
    const read = await readGaps([node('Account')], {
      rules: [rule(ruleId(1), 'Region', 'Account')],
      formulas: { [ruleId(1)]: 'AND($Permission.Admin, ISBLANK(Region__c))' },
    });
    expect(read.asked.some((call) => call.includes('UserSetupEntityAccess'))).toBe(false);
    expect(ofKind(read, 'validation_rule')[0].detail).not.toHaveProperty('bypasses');
  });

  it(`reads ${FORMULAS_BOUND} formulas at most, one request each, and says the others were not read`, async () => {
    const rules = Array.from({ length: FORMULAS_BOUND + 5 }, (_, i) =>
      rule(ruleId(i), `Rule_${String(i).padStart(2, '0')}`, 'Account'),
    );
    const read = await readGaps([node('Account')], {
      rules,
      formulas: Object.fromEntries(rules.map((r) => [r.Id as string, 'ISBLANK(Name)'])),
    });

    const formulaReads = read.asked.filter((call) => call.includes(" WHERE Id = '"));
    expect(formulaReads).toHaveLength(FORMULAS_BOUND);
    const notRead = ofKind(read, 'validation_rule').filter((g) => g.detail?.formula === 'notRead');
    expect(notRead.map((g) => g.detail?.rule)).toEqual([
      'Rule_25',
      'Rule_26',
      'Rule_27',
      'Rule_28',
      'Rule_29',
    ]);
  });

  it('says the formulas it could not read, and keeps the rules', async () => {
    const read = await readGaps([node('Account')], {
      rules: [rule(ruleId(1), 'Region', 'Account')],
      refuse: { formulas: new Error('INSUFFICIENT_ACCESS') },
    });
    expect(ofKind(read, 'validation_rule')[0].detail?.formula).toBe('unreadable');
    expect(read.unread).toContainEqual({
      part: 'validationRuleFormulas',
      reason: 'INSUFFICIENT_ACCESS',
    });
  });

  it('says the rules it could not read, and reads the rest all the same', async () => {
    const read = await readGaps([node('Account')], {
      refuse: { rules: new Error('sObject type ValidationRule is not supported') },
      duplicates: [duplicateRule('Account_Rule', 'Account')],
      definitions: { 'Account.Account_Rule': { actionOnInsert: 'Block' } },
    });
    expect(read.unread).toContainEqual({
      part: 'validationRules',
      reason: 'sObject type ValidationRule is not supported',
    });
    expect(ofKind(read, 'duplicate_rule')).toHaveLength(1);
  });
});

describe('TargetGapReader — duplicate rules', () => {
  it('reads what each active rule does on insert: one that blocks refuses rows, one that allows saves them', async () => {
    const read = await readGaps([node('Account'), node('Contact')], {
      duplicates: [
        duplicateRule('Account_Block', 'Account'),
        duplicateRule('Contact_Alert', 'Contact'),
        duplicateRule('Lead_Rule', 'Lead'),
      ],
      definitions: {
        'Account.Account_Block': { actionOnInsert: 'Block' },
        'Contact.Contact_Alert': {
          actionOnInsert: 'Allow',
          operationsOnInsert: ['Alert', 'Report'],
        },
      },
    });

    expect(ofKind(read, 'duplicate_rule')).toEqual([
      {
        id: forgeGapId('duplicate_rule', 'Account', undefined, undefined, 'Account_Block'),
        kind: 'duplicate_rule',
        // Only the rows it matches: which the metadata does not say.
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Account',
        rows: 0,
        detail: { rule: 'Account Block', developerName: 'Account_Block', action: 'block' },
        decisions: ['ignore', 'exclude_object'],
      },
      {
        id: forgeGapId('duplicate_rule', 'Contact', undefined, undefined, 'Contact_Alert'),
        kind: 'duplicate_rule',
        severity: 'info',
        source: 'metadata',
        objectApiName: 'Contact',
        rows: 0,
        detail: {
          rule: 'Contact Alert',
          developerName: 'Contact_Alert',
          action: 'allow',
          alert: true,
          report: true,
        },
        decisions: ['ignore'],
        defaultDecision: 'ignore',
      },
    ]);
    expect(read.asked).toContain(`metadata ${TARGET} Account.Account_Block,Contact.Contact_Alert`);
  });

  it('reads ten definitions a call', async () => {
    const duplicates = Array.from({ length: 11 }, (_, i) => duplicateRule(`Rule_${i}`, 'Account'));
    const read = await readGaps([node('Account')], { duplicates });
    expect(read.asked.filter((call) => call.startsWith('metadata '))).toHaveLength(2);
  });

  it('takes a rule whose definition could not be read for one that may block, and says why', async () => {
    const read = await readGaps([node('Account')], {
      duplicates: [duplicateRule('Account_Rule', 'Account')],
      refuse: { definitions: new Error('INSUFFICIENT_ACCESS: readMetadata') },
    });
    expect(ofKind(read, 'duplicate_rule')[0]).toMatchObject({
      severity: 'warning',
      detail: { action: 'unknown' },
      decisions: ['ignore', 'exclude_object'],
    });
    expect(read.unread).toContainEqual({
      part: 'duplicateRuleActions',
      reason: 'INSUFFICIENT_ACCESS: readMetadata',
    });
  });

  it('says the duplicate rules it could not read', async () => {
    const read = await readGaps([node('Account')], {
      refuse: { duplicates: new Error('INSUFFICIENT_ACCESS: View Setup') },
    });
    expect(ofKind(read, 'duplicate_rule')).toEqual([]);
    expect(read.unread).toContainEqual({
      part: 'duplicateRules',
      reason: 'INSUFFICIENT_ACCESS: View Setup',
    });
  });
});

describe('TargetGapReader — fields only the target requires', () => {
  it('says a field the target requires and the run does not write, under the id the simulation gives it', async () => {
    const read = await readGaps([node('Account')], {
      targetFields: {
        Account: [
          field('Name', { nillable: false }),
          field('Region__c', { nillable: false, type: 'picklist', picklistValues: ['EU', 'US'] }),
          field('Owner_Code__c', { nillable: false, defaultedOnCreate: true }),
          field('Formula__c', { nillable: false, createable: false }),
          field('Optional__c'),
        ],
      },
      sourceFields: { Account: [field('Name')] },
    });

    expect(ofKind(read, 'required_field_missing')).toEqual([
      {
        id: forgeGapId('required_field_missing', 'Account', 'Region__c'),
        kind: 'required_field_missing',
        severity: 'blocking',
        source: 'metadata',
        objectApiName: 'Account',
        field: 'Region__c',
        rows: 0,
        detail: { type: 'picklist', reason: 'notInSource', values: ['EU', 'US'] },
        decisions: ['set_default', 'exclude_object'],
      },
    ]);
  });

  it('counts a field the run leaves out, or writes under another name, as not written', async () => {
    const read = await readGaps(
      [node('Account')],
      {
        targetFields: {
          Account: [
            field('Code__c', { nillable: false }),
            field('Region__c', { nillable: false }),
            field('Region2__c', { nillable: false }),
            field('Formula__c', { nillable: false }),
          ],
        },
        sourceFields: {
          Account: [
            field('Code__c'),
            field('Region__c'),
            field('Formula__c', { createable: false }),
          ],
        },
      },
      {
        fieldExclusions: { Account: ['Code__c'] },
        fieldMappings: { Account: { Region__c: 'Region2__c' } },
      },
    );

    expect(ofKind(read, 'required_field_missing').map((g) => [g.field, g.detail?.reason])).toEqual([
      ['Code__c', 'excluded'],
      ['Formula__c', 'notCreateableInSource'],
      ['Region__c', 'excluded'],
    ]);
  });

  it('matches the fields of both orgs whatever their case', async () => {
    const read = await readGaps([node('Account')], {
      targetFields: { Account: [field('region__c', { nillable: false })] },
      sourceFields: { Account: [field('Region__c')] },
    });
    expect(ofKind(read, 'required_field_missing')).toEqual([]);
  });

  it('names what a required lookup only the target has points at', async () => {
    const read = await readGaps([node('Contact')], {
      targetFields: {
        Contact: [
          field('Branch__c', { nillable: false, type: 'reference', referenceTo: ['Branch__c'] }),
        ],
      },
      sourceFields: { Contact: [] },
    });
    expect(ofKind(read, 'required_field_missing')[0].detail).toEqual({
      type: 'reference',
      reason: 'notInSource',
      referenceTo: ['Branch__c'],
    });
  });

  it('says an object it could not describe, and reads the others', async () => {
    const read = await readGaps([node('Account'), node('Contact')], {
      targetFields: {
        Account: [field('Region__c', { nillable: false })],
        Contact: [field('Code__c', { nillable: false })],
      },
      sourceFields: { Account: [], Contact: [] },
      refuse: { describe: new Set([`${TARGET}::Account`]) },
    });
    expect(read.unread).toContainEqual({
      part: 'targetFields',
      reason: 'Account: INVALID_TYPE: Account',
    });
    expect(ofKind(read, 'required_field_missing').map((g) => g.objectApiName)).toEqual(['Contact']);
  });
});

describe('TargetGapReader — lookup filters', () => {
  it('warns of the filter of a lookup the run writes, and says whether the lookup may be left empty', async () => {
    const lookup = (name: string, nillable: boolean): GapField =>
      field(name, {
        type: 'reference',
        referenceTo: ['Account'],
        nillable,
        lookupFilter: { optional: false },
      });
    const read = await readGaps([node('Contact')], {
      targetFields: {
        Contact: [
          lookup('Partner__c', true),
          lookup('Branch__c', false),
          lookup('Target_Only__c', true),
        ],
      },
      sourceFields: { Contact: [field('Partner__c'), field('Branch__c')] },
    });

    expect(ofKind(read, 'lookup_filter')).toEqual([
      {
        id: forgeGapId('lookup_filter', 'Contact', 'Branch__c'),
        kind: 'lookup_filter',
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Contact',
        field: 'Branch__c',
        rows: 0,
        detail: { referenceTo: ['Account'], optional: false, filterOptional: false },
        decisions: ['ignore', 'exclude_object'],
      },
      {
        id: forgeGapId('lookup_filter', 'Contact', 'Partner__c'),
        kind: 'lookup_filter',
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Contact',
        field: 'Partner__c',
        rows: 0,
        detail: { referenceTo: ['Account'], optional: true, filterOptional: false },
        decisions: ['leave_empty', 'ignore'],
        defaultDecision: 'leave_empty',
      },
    ]);
  });
});

describe('TargetGapReader — API budget', () => {
  /** The budget gap of a run of `nodes` against `limits`. */
  async function budgetOf(
    nodes: ForgeGraphNode[],
    limits: unknown,
    scope: GapRunScope = {},
  ): Promise<ForgeGap> {
    const [gap] = ofKind(await readGaps(nodes, { limits }, scope), 'api_budget');
    return gap;
  }
  const limits = (max: number, remaining: number) => ({
    DailyApiRequests: { Max: max, Remaining: remaining },
  });

  it('counts the writes 200 rows a call, and refuses a run past what the target has left', async () => {
    // 450 rows: 3 writes, 1 read.
    const gap = await budgetOf([node('Account', { recordCount: 450 })], limits(15_000, 3));
    expect(gap).toEqual({
      id: forgeGapId('api_budget', 'Account'),
      kind: 'api_budget',
      severity: 'blocking',
      source: 'metadata',
      objectApiName: 'Account',
      rows: 0,
      detail: { calls: 4, writes: 3, reads: 1, estimate: 'exact', max: 15_000, remaining: 3 },
      decisions: ['ignore'],
    });
  });

  it('warns when the run would bring the org past 80 % of its daily limit', async () => {
    const gap = await budgetOf([node('Account', { recordCount: 450 })], limits(100, 22));
    expect(gap.severity).toBe('warning');
  });

  it('says the budget holds the run otherwise', async () => {
    const gap = await budgetOf([node('Account', { recordCount: 450 })], limits(100, 30));
    expect(gap.severity).toBe('info');
  });

  it('never refuses a clone of one record for it: discovery counted whole tables', async () => {
    const gap = await budgetOf([node('Account', { recordCount: 450 })], limits(15_000, 3), {
      inputMode: 'record',
      recordId: '001000000000001AAA',
    });
    expect(gap.severity).toBe('warning');
    expect(gap.detail?.estimate).toBe('atMost');
  });

  it('holds each table to the cap on each object', async () => {
    const gap = await budgetOf([node('Account', { recordCount: 450 })], limits(15_000, 15_000), {
      maxRecordsPerObject: 50,
    });
    expect(gap.detail).toMatchObject({ calls: 2, writes: 1, reads: 1 });
  });

  it('takes a run of objects never counted, or a budget the target would not say, for no more than a warning', async () => {
    const unknown = await budgetOf(
      [node('Account', { recordCount: 0, recordCountUnknown: true })],
      limits(15_000, 15_000),
    );
    expect(unknown).toMatchObject({ severity: 'warning', detail: { estimate: 'unknown' } });

    const read = await readGaps([node('Account')], {
      refuse: { limits: new Error('INSUFFICIENT_ACCESS: Manage Users') },
    });
    expect(ofKind(read, 'api_budget')[0]).toMatchObject({
      severity: 'warning',
      detail: { budgetRead: false },
    });
    expect(read.unread).toContainEqual({
      part: 'apiBudget',
      reason: 'INSUFFICIENT_ACCESS: Manage Users',
    });
  });
});

describe('TargetGapReader — limits that say nothing of the budget', () => {
  it('takes limits that hold no daily requests for a budget not read', async () => {
    const read = await readGaps([node('Account')], {
      limits: { DataStorageMB: { Max: 200, Remaining: 150 } },
    });
    expect(read.unread).toContainEqual({
      part: 'apiBudget',
      reason: 'the limits the org answered hold no DailyApiRequests',
    });
    expect(ofKind(read, 'api_budget')[0]).toMatchObject({
      severity: 'warning',
      detail: { budgetRead: false },
    });
  });
});

describe('TargetGapReader — budget and robustness', () => {
  it('keeps four requests in flight at most, and counts every request it sent', async () => {
    const nodes = ['Account', 'Contact', 'Case', 'Opportunity', 'Lead'].map((name) => node(name));
    const read = await readGaps(nodes, {
      rules: [rule(ruleId(1), 'Region', 'Account')],
      formulas: { [ruleId(1)]: 'NOT($Permission.Bypass)' },
      duplicates: [duplicateRule('Account_Rule', 'Account')],
    });
    expect(read.mostInFlight).toBe(4);
    // Rules, duplicate rules, limits, 10 describes, 1 formula, 1 definition, the user's permissions.
    expect(read.requests).toBe(16);
    expect(read.asked).toHaveLength(16);
  });

  it('counts no request for a describe already held', async () => {
    const read = await readGaps([node('Account')], {
      held_describes: new Set([`${SOURCE}::Account`, `${TARGET}::Account`]),
    });
    // Rules, duplicate rules, limits.
    expect(read.requests).toBe(3);
  });

  it('reads an object the user left out, and none the run leaves out by name', async () => {
    const read = await readGaps(
      [
        node('Account'),
        node('Contact', { included: false, leftOutByUser: true }),
        node('Case'),
        node('Note', { included: false }),
      ],
      {},
      { excludedObjects: ['Case'] },
    );
    const described = read.asked.filter((call) => call.startsWith(`describe ${TARGET}`));
    expect(described).toEqual([`describe ${TARGET}::Account`, `describe ${TARGET}::Contact`]);
  });

  it('sends nothing when the run writes nothing', async () => {
    const read = await readGaps([node('Account', { included: false })]);
    expect(read).toMatchObject({ gaps: [], unread: [], requests: 0, asked: [] });
  });

  it('gives every gap from metadata, no row counted, under the id forgeGapId builds', async () => {
    const read = await readGaps([node('Account')], {
      rules: [rule(ruleId(1), 'Region', 'Account', 'Region__c')],
      duplicates: [duplicateRule('Account_Rule', 'Account')],
      targetFields: { Account: [field('Code__c', { nillable: false })] },
      sourceFields: { Account: [] },
    });
    expect(read.gaps.length).toBeGreaterThan(3);
    for (const gap of read.gaps) {
      expect(gap.source).toBe('metadata');
      expect(gap.rows).toBe(0);
      expect(gap.id.startsWith(`${gap.kind}|${gap.objectApiName}|`)).toBe(true);
    }
    // The gravest first.
    expect(read.gaps[0].severity).toBe('blocking');
  });
});

describe('bypassesOf', () => {
  it('names a term the formula requires together with the rest that, holding, keeps it quiet', () => {
    expect(bypassesOf('AND(NOT($Permission.Skip), ISBLANK(Phone))')).toEqual({
      bypasses: ['$Permission.Skip'],
      permissions: ['Skip'],
    });
    expect(bypassesOf('NOT($User.Bypass__c) && ISBLANK(Phone)').bypasses).toEqual([
      '$User.Bypass__c',
    ]);
    expect(
      bypassesOf('AND($CustomMetadata.Switch__mdt.VR.Off__c = FALSE, ISBLANK(Phone))').bypasses,
    ).toEqual(['$CustomMetadata.Switch__mdt.VR.Off__c']);
  });

  it('names nothing for a global that does not keep the rule quiet', () => {
    expect(bypassesOf('AND($Permission.Admin, ISBLANK(Phone))')).toEqual({
      bypasses: [],
      permissions: [],
    });
    expect(bypassesOf('OwnerId <> $User.Id').bypasses).toEqual([]);
  });
});

describe('callsEstimateOf', () => {
  it('counts the objects the run takes only', () => {
    expect(
      callsEstimateOf(
        graphOf([node('Account', { recordCount: 4_001 }), node('Note', { included: false })]),
      ),
    ).toEqual({ writes: 21, reads: 3, bound: 'exact' });
  });

  it('bounds a run whose uncounted objects the cap holds', () => {
    expect(
      callsEstimateOf(graphOf([node('Account', { recordCount: 0, recordCountUnknown: true })]), {
        maxRecordsPerObject: 400,
      }),
    ).toEqual({ writes: 2, reads: 1, bound: 'atMost' });
  });
});

describe('gapFieldOf', () => {
  it('reads a describe field, its lookup filter and active picklist values', () => {
    expect(
      gapFieldOf({
        name: 'Partner__c',
        type: 'reference',
        createable: true,
        nillable: false,
        defaultedOnCreate: false,
        referenceTo: ['Account'],
        picklistValues: [{ value: 'A', active: true }, { value: 'B', active: false }, null],
        filteredLookupInfo: { controllingFields: [], dependent: false, optionalFilter: true },
      }),
    ).toEqual({
      name: 'Partner__c',
      type: 'reference',
      createable: true,
      nillable: false,
      defaultedOnCreate: false,
      referenceTo: ['Account'],
      picklistValues: ['A'],
      lookupFilter: { optional: true },
    });
    expect(gapFieldOf({ name: 'Name', type: 'string', filteredLookupInfo: null })).toMatchObject({
      createable: false,
      nillable: true,
      lookupFilter: null,
    });
  });
});

describe('gapLines', () => {
  it('says each gap per object with its severity, the budget, what was not read and what it cost', async () => {
    const read = await readGaps([node('Account', { recordCount: 450 })], {
      rules: [
        rule(ruleId(1), 'Phone_Format', 'Account', 'Phone'),
        ...Array.from({ length: FORMULAS_BOUND }, (_, i) =>
          rule(ruleId(i + 2), `Z_${i}`, 'Account'),
        ),
      ],
      formulas: { [ruleId(1)]: 'AND(NOT($Permission.Bypass_VR), ISBLANK(Phone))' },
      duplicates: [duplicateRule('Account_Block', 'Account')],
      definitions: { 'Account.Account_Block': { actionOnInsert: 'Block' } },
      targetFields: {
        Account: [
          field('Phone'),
          field('Region__c', { nillable: false, type: 'picklist' }),
          field('ParentId', {
            type: 'reference',
            referenceTo: ['Account'],
            lookupFilter: { optional: true },
          }),
        ],
      },
      sourceFields: { Account: [field('ParentId')] },
      limits: { DailyApiRequests: { Max: 15_000, Remaining: 14_000 } },
      refuse: { held: new Error('INSUFFICIENT_ACCESS') },
    });
    const lines = gapLines(read, 'TGT');

    expect(lines[0]).toBe('target gaps: what TGT holds against the rows, read from its metadata');
    expect(lines[1]).toBe('  Account');
    expect(lines).toContain(
      '    BLOCKING: required field Region__c (picklist): only the target requires it, and the run ' +
        'does not write it (the source has no such field): every row is refused unless it is given a value',
    );
    expect(lines).toContain(
      '    warning: duplicate rule "Account Block": blocks an insert it matches: a row it matches ' +
        'is refused, whatever allowSave says',
    );
    expect(lines).toContain(
      '    warning: validation rule "Phone_Format" on Phone: "Phone_Format message" (not when ' +
        '$Permission.Bypass_VR; a row it refuses goes again without Phone)',
    );
    expect(lines).toContain(
      '    warning: lookup filter on ParentId: not checked before the run; a lookup it refuses is left empty',
    );
    expect(lines).toContain(
      '  info: API budget: the run takes about 4 call(s) (3 write(s) of 200 rows, 1 read(s)); ' +
        '14000 of 15000 daily requests left',
    );
    expect(lines).toContain(
      '  1 validation rule formula(s) not read: the read takes 25 at most, one request each',
    );
    expect(lines).toContain(
      '  the custom permissions of the user the run writes as could not be read: INSUFFICIENT_ACCESS',
    );
    expect(lines[lines.length - 1]).toBe(`  read in ${read.requests} request(s) to TGT`);
  });

  it('says when nothing was found, and when nothing could be read to find it', () => {
    const nothing = { gaps: [], unread: [], requests: 3 };
    expect(gapLines(nothing, 'TGT')[1]).toBe(
      '  no validation rule, duplicate rule, field only the target requires or lookup filter',
    );
    expect(
      gapLines({ ...nothing, unread: [{ part: 'validationRules', reason: 'refused' }] }, 'TGT'),
    ).toEqual([
      'target gaps: what TGT holds against the rows, read from its metadata',
      '  nothing found in what could be read',
      '  the validation rules could not be read: refused',
      '  read in 3 request(s) to TGT',
    ]);
  });
});
