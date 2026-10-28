import { describe, expect, it, vi } from 'vitest';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import { compileScenario } from './compileScenario';
import {
  CASE_STATUS_BY_LABEL_SOQL,
  CASE_STATUS_SOQL,
  prepareScenario,
  readScenarioCaseStatus,
  scenarioCasePicklists,
  scenarioKnowledge,
  toolingQueryAll,
  type ScenarioDescribedField,
} from './scenarioOrg';

/** A new org's case statuses, as `CaseStatus` answers for them. */
const NEW_ORG_STATUSES = [
  { ApiName: 'New', MasterLabel: 'New', IsClosed: false, IsDefault: true },
  { ApiName: 'Working', MasterLabel: 'Working', IsClosed: false, IsDefault: false },
  { ApiName: 'Escalated', MasterLabel: 'Escalated', IsClosed: false, IsDefault: false },
  { ApiName: 'Closed', MasterLabel: 'Closed', IsClosed: true, IsDefault: false },
];

describe('readScenarioCaseStatus — the words an org files its cases under', () => {
  it("writes an open case under the org's default status and a closed one under Closed", async () => {
    const query = vi.fn(async () => NEW_ORG_STATUSES);

    expect(await readScenarioCaseStatus(query)).toEqual({
      open: 'New',
      closed: 'Closed',
      from: 'org',
    });
    expect(query).toHaveBeenCalledWith(CASE_STATUS_SOQL);
  });

  it('takes the first open status when the default one closes a case, and the first closed one when none is Closed', async () => {
    const statuses = [
      { ApiName: 'Resolved', IsClosed: true, IsDefault: true },
      { ApiName: 'Received', IsClosed: false, IsDefault: false },
      { ApiName: 'Done', IsClosed: true, IsDefault: false },
    ];

    expect(await readScenarioCaseStatus(async () => statuses)).toEqual({
      open: 'Received',
      closed: 'Resolved',
      from: 'org',
    });
  });

  it('reads the statuses by label from an org that will not select their API name', async () => {
    const query = vi.fn(async (soql: string) => {
      if (soql === CASE_STATUS_SOQL) throw new Error("INVALID_FIELD: No such column 'ApiName'");
      return [
        { MasterLabel: 'Nouveau', IsClosed: false, IsDefault: true },
        { MasterLabel: 'Fermé', IsClosed: true, IsDefault: false },
      ];
    });

    expect(await readScenarioCaseStatus(query)).toEqual({
      open: 'Nouveau',
      closed: 'Fermé',
      from: 'org',
    });
    expect(query).toHaveBeenLastCalledWith(CASE_STATUS_BY_LABEL_SOQL);
  });

  it("gives a new org's statuses with why when the org will not say", async () => {
    const refused = await readScenarioCaseStatus(async () => {
      throw new Error('INSUFFICIENT_ACCESS');
    });
    expect(refused).toEqual({
      open: 'New',
      closed: 'Closed',
      from: 'default',
      reason: 'the org would not read its case statuses: INSUFFICIENT_ACCESS',
    });

    const noClosed = await readScenarioCaseStatus(async () => [
      { ApiName: 'New', IsClosed: false, IsDefault: true },
    ]);
    expect(noClosed).toMatchObject({
      from: 'default',
      reason: 'the org has no case status that closes a case',
    });
  });
});

/** An article's fields as a describe gives them, a new activation's and two of an admin's. */
const ARTICLE_FIELDS: ScenarioDescribedField[] = [
  { name: 'Title', type: 'string', length: 255, createable: true },
  { name: 'Summary', type: 'textarea', length: 1000, createable: true },
  {
    name: 'Notes__c',
    type: 'textarea',
    length: 32768,
    createable: true,
    extraTypeInfo: 'plaintextarea',
  },
  {
    name: 'Answer__c',
    type: 'textarea',
    length: 32768,
    createable: true,
    extraTypeInfo: 'richtextarea',
  },
  { name: 'Short__c', type: 'textarea', length: 255, createable: true },
  {
    name: 'Locked__c',
    type: 'textarea',
    length: 32768,
    createable: false,
    extraTypeInfo: 'richtextarea',
  },
];

describe('scenarioKnowledge — what an org offers the articles of a scenario', () => {
  it('says why there is none in an org without Knowledge', async () => {
    const describe = vi.fn();
    const knowledge = await scenarioKnowledge(
      async () => ({ access: 'absent', reason: 'Salesforce Knowledge is not turned on in it' }),
      describe,
    );

    expect(knowledge).toEqual({
      available: false,
      reason: 'Salesforce Knowledge is not turned on in it',
    });
    expect(describe).not.toHaveBeenCalled();
  });

  it('says so of a user who may read articles and not create them', async () => {
    const knowledge = await scenarioKnowledge(
      async () => ({ access: 'readOnly' }),
      async () => ({ fields: ARTICLE_FIELDS }),
    );

    expect(knowledge).toEqual({
      available: false,
      reason: 'the user this seed runs as may read Knowledge__kav and not create it',
    });
  });

  it('offers the fields a body can be written to, a rich text area first, then a long text one, then the summary', async () => {
    const knowledge = await scenarioKnowledge(
      async () => ({ access: 'createable' }),
      async () => ({ fields: ARTICLE_FIELDS }),
    );

    expect(knowledge).toEqual({
      available: true,
      bodyFields: [
        { name: 'Answer__c', length: 32768, kind: 'richText' },
        { name: 'Notes__c', length: 32768, kind: 'longText' },
        { name: 'Summary', length: 1000, kind: 'summary' },
      ],
    });
  });

  it('offers Summary alone on a Knowledge base turned on afresh, which has no other field for a body', async () => {
    const knowledge = await scenarioKnowledge(
      async () => ({ access: 'createable' }),
      async () => ({
        fields: ARTICLE_FIELDS.filter((field) => ['Title', 'Summary'].includes(field.name)),
      }),
    );

    expect(knowledge).toEqual({
      available: true,
      bodyFields: [{ name: 'Summary', length: 1000, kind: 'summary' }],
    });
  });

  it('offers no field when the article cannot be described: the summary is all it says', async () => {
    const knowledge = await scenarioKnowledge(
      async () => ({ access: 'createable' }),
      async () => {
        throw new Error('NOT_FOUND');
      },
    );

    expect(knowledge).toEqual({ available: true, bodyFields: [] });
  });
});

describe('scenarioCasePicklists — the only words of the org a draft is told', () => {
  it("gives the active values of the four Case picklists, in the org's order", async () => {
    const picklists = await scenarioCasePicklists(async () => ({
      fields: [
        {
          name: 'Status',
          type: 'picklist',
          picklistValues: [
            { value: 'New', active: true },
            { value: 'Retired', active: false },
            { value: 'Closed', active: true },
          ],
        },
        { name: 'Origin', type: 'picklist', picklistValues: [{ value: 'Web', active: true }] },
        { name: 'Subject', type: 'string' },
      ],
    }));

    expect(picklists).toEqual({ Status: ['New', 'Closed'], Origin: ['Web'] });
  });

  it('gives none when Case cannot be described', async () => {
    expect(
      await scenarioCasePicklists(async () => {
        throw new Error('INVALID_TYPE');
      }),
    ).toBeUndefined();
  });
});

describe('prepareScenario — a pack compiled for an org', () => {
  const orgStatus = { open: 'Received', closed: 'Resolved', from: 'org' as const };
  const ANSWER = { name: 'Answer__c', length: 32768, kind: 'richText' as const };
  const NOTES = { name: 'Notes__c', length: 32768, kind: 'longText' as const };
  const SUMMARY = { name: 'Summary', length: 1000, kind: 'summary' as const };

  it("compiles with the org's statuses and the first body field it offers, and says what the run writes", () => {
    const prepared = prepareScenario(RETAIL_ORDERS_PACK, {
      caseStatus: orgStatus,
      knowledge: { available: true, bodyFields: [ANSWER, NOTES, SUMMARY] },
      seed: 7,
    });

    if (!('preparation' in prepared)) throw new Error(prepared.issues.join('; '));
    const { preparation } = prepared;
    expect(preparation.options).toEqual({
      seed: 7,
      caseStatus: { open: 'Received', closed: 'Resolved' },
      articleBodyField: 'Answer__c',
      articleBodyLength: 32768,
      articleBodyHtml: true,
    });
    expect(preparation.knowledge).toEqual({
      available: true,
      bodyFields: ['Answer__c', 'Notes__c', 'Summary'],
    });
    const compiled = compileScenario(RETAIL_ORDERS_PACK, preparation.options);
    const comments = compiled.template.objects.find((o) => o.objectApiName === 'CaseComment');
    expect(preparation.objects).toEqual([
      { objectApiName: 'Account', recordCount: 10 },
      { objectApiName: 'Contact', recordCount: 10 },
      { objectApiName: 'Case', recordCount: 30 },
      { objectApiName: 'CaseComment', recordCount: comments?.recordCount },
      { objectApiName: 'Knowledge__kav', recordCount: 6, optional: true },
    ]);
    expect(preparation.tests).toBe(compiled.tests.length);
    expect(preparation.caseStatusFrom).toEqual({ from: 'org' });
    // Each case is written with the org's own words.
    const statuses = new Set(
      compiled.template.objects
        .find((o) => o.objectApiName === 'Case')
        ?.rows?.map((row) => row.values.Status),
    );
    expect([...statuses].sort()).toEqual(['Received', 'Resolved']);
  });

  it('writes no body field in an org without Knowledge, and says where the statuses came from', () => {
    const prepared = prepareScenario(RETAIL_ORDERS_PACK, {
      caseStatus: { open: 'New', closed: 'Closed', from: 'default', reason: 'refused' },
      knowledge: { available: false, reason: 'Salesforce Knowledge is not turned on in it' },
    });

    if (!('preparation' in prepared)) throw new Error(prepared.issues.join('; '));
    expect(prepared.preparation.options).toEqual({
      seed: 1,
      caseStatus: { open: 'New', closed: 'Closed' },
    });
    expect(prepared.preparation.caseStatusFrom).toEqual({ from: 'default', reason: 'refused' });
  });

  it('compiles each body into the 1 000 characters of Summary on a base turned on afresh, every fact kept', () => {
    const prepared = prepareScenario(RETAIL_ORDERS_PACK, {
      caseStatus: orgStatus,
      knowledge: { available: true, bodyFields: [SUMMARY] },
    });

    if (!('preparation' in prepared)) throw new Error(prepared.issues.join('; '));
    expect(prepared.preparation.options).toMatchObject({
      articleBodyField: 'Summary',
      articleBodyLength: 1000,
    });
    expect(prepared.preparation.options).not.toHaveProperty('articleBodyHtml');
    const articles = compileScenario(RETAIL_ORDERS_PACK, prepared.preparation.options)
      .template.objects.find((o) => o.objectApiName === 'Knowledge__kav')!
      .rows!.slice(0, RETAIL_ORDERS_PACK.topics.length);
    RETAIL_ORDERS_PACK.topics.forEach((topic, at) => {
      const body = String(articles[at].values.Summary);
      expect(body.length).toBeLessThanOrEqual(1000);
      for (const fact of topic.article.facts) {
        expect(body.toLowerCase().replace(/\s+/g, ' ')).toContain(
          fact.toLowerCase().replace(/\s+/g, ' '),
        );
      }
    });
  });

  it('compiles for the field the user chose among those the org offers, with its own length', () => {
    const prepared = prepareScenario(RETAIL_ORDERS_PACK, {
      caseStatus: orgStatus,
      knowledge: { available: true, bodyFields: [ANSWER, NOTES, SUMMARY] },
      articleBodyField: 'Notes__c',
    });

    if (!('preparation' in prepared)) throw new Error(prepared.issues.join('; '));
    expect(prepared.preparation.options).toMatchObject({
      articleBodyField: 'Notes__c',
      articleBodyLength: 32768,
    });
    expect(prepared.preparation.options).not.toHaveProperty('articleBodyHtml');
  });

  it('refuses a body field the org does not offer, naming those it does', () => {
    const prepared = prepareScenario(RETAIL_ORDERS_PACK, {
      caseStatus: orgStatus,
      knowledge: { available: true, bodyFields: [ANSWER] },
      articleBodyField: 'Title',
    });

    expect(prepared).toEqual({
      issues: [
        'options.articleBodyField: Title is not a field of Knowledge__kav this org lets a body ' +
          'be written to (Answer__c)',
      ],
    });
  });

  it('refuses a pack that does not hold, with the field', () => {
    const prepared = prepareScenario(
      { ...RETAIL_ORDERS_PACK, customers: { ...RETAIL_ORDERS_PACK.customers, count: 2 } },
      { caseStatus: orgStatus, knowledge: { available: true, bodyFields: [] } },
    );

    expect('issues' in prepared && prepared.issues[0]).toMatch(/^pack\.customers\.count: /);
  });
});

describe('toolingQueryAll', () => {
  it('reads every page of an answer', async () => {
    const query = toolingQueryAll({
      query: async () => ({ records: [{ Id: '1' }], done: false, nextRecordsUrl: '/next-1' }),
      queryMore: async (url) =>
        url === '/next-1'
          ? { records: [{ Id: '2' }], done: false, nextRecordsUrl: '/next-2' }
          : { records: [{ Id: '3' }], done: true },
    });

    expect(await query('SELECT Id FROM GenAiPlannerDefinition')).toEqual([
      { Id: '1' },
      { Id: '2' },
      { Id: '3' },
    ]);
  });
});
