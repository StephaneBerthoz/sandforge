import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import type { CompiledScenario, SeedExecutionResult } from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type {
  InsertFn,
  InsertedRow,
  SeedOrchestratorDependencies,
  SeedRowsWritten,
} from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { DataPlanBuilder } from './DataPlanBuilder';
import { FieldMapper } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { AIDataGenerator } from './AIDataGenerator';
import { ReferenceLinker } from './ReferenceLinker';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { seedObjectAccess } from './seedObjectAccess';
import { nodeSeedRunCreations, type SeedRunCreations } from './SeedRunCreations';
import { compileScenario } from './scenario/compileScenario';
import {
  ARTICLE_VERSION_OBJECT,
  articleBodyFields,
  articleBodyOptions,
  seedKnowledge,
  type KnowledgeOrg,
  type SeedKnowledgeDeps,
} from './seedKnowledge';
import { removeSyncRun } from '../sync/SyncRunRemoval';
import {
  ARTICLE,
  ARTICLE_VERSION,
  CASE_ARTICLE,
  MemoryKnowledgeOrg,
} from '../../test/memoryKnowledgeOrg';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const START = Date.parse('2026-10-28T11:00:00.000Z');

/** Seconds the org takes before each call the step after the writes makes. */
const CALL_SECONDS = 30;

let dir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  dir = mkdtempSync(join(tmpdir(), 'sandforge-seed-knowledge-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** Move the clock on by `seconds`. */
function later(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1_000);
}

describe('articleBodyFields', () => {
  const field = (name: string, extra: Record<string, unknown>) => ({
    name,
    label: name,
    type: 'textarea',
    createable: true,
    ...extra,
  });

  it('offers Summary alone on a Knowledge base turned on afresh, as a fresh one describes it', async () => {
    const org = new MemoryKnowledgeOrg();

    const fields = articleBodyFields(await org.describe(ARTICLE_VERSION));

    expect(fields).toEqual([{ name: 'Summary', length: 1_000, kind: 'summary' }]);
    expect(articleBodyOptions(fields[0])).toEqual({
      articleBodyField: 'Summary',
      articleBodyLength: 1_000,
    });
  });

  it('offers the rich text field the admin added first, then a long text one, each the longest first, Summary last', () => {
    const fields = articleBodyFields({
      fields: [
        field('Summary', { length: 1_000, extraTypeInfo: 'plaintextarea' }),
        field('Notes__c', { length: 32_768, extraTypeInfo: 'plaintextarea' }),
        field('Answer__c', { length: 32_768, extraTypeInfo: 'richtextarea', htmlFormatted: true }),
        field('Details__c', { length: 131_072, extraTypeInfo: 'plaintextarea' }),
        // A text area holds 255 characters: no body's field.
        field('Short__c', { length: 255, extraTypeInfo: 'plaintextarea' }),
        // One the user may not set.
        field('Locked__c', { length: 32_768, extraTypeInfo: 'richtextarea', createable: false }),
        { name: 'Title', label: 'Title', type: 'string', length: 255, createable: true },
      ],
    });

    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['Answer__c', 'richText'],
      ['Details__c', 'longText'],
      ['Notes__c', 'longText'],
      ['Summary', 'summary'],
    ]);
    expect(articleBodyOptions(fields[0])).toEqual({
      articleBodyField: 'Answer__c',
      articleBodyLength: 32_768,
      articleBodyHtml: true,
    });
  });

  it('offers none when the describe cannot be read, the article then written with its summary alone', () => {
    expect(articleBodyFields(undefined)).toEqual([]);
    expect(articleBodyFields({ fields: 'none' })).toEqual([]);
  });

  it('offers the field an admin added to the memory org, which compiles the body into it whole', async () => {
    const org = new MemoryKnowledgeOrg();
    org.addBodyField({ name: 'Answer__c', length: 32_768, rich: true });

    const [best] = articleBodyFields(await org.describe(ARTICLE_VERSION));
    const compiled = compileScenario(RETAIL_ORDERS_PACK, articleBodyOptions(best));
    const article = compiled.template.objects.find((o) => o.objectApiName === ARTICLE_VERSION)!
      .rows![0].values;

    expect(best).toEqual({ name: 'Answer__c', length: 32_768, kind: 'richText' });
    expect(String(article.Answer__c).startsWith('<p>If a parcel arrives damaged')).toBe(true);
    expect(article.Summary).toBe(RETAIL_ORDERS_PACK.topics[0].article.summary);
  });
});

/** The insert of a seed into the memory org, answering record by record as REST does. */
function insertInto(org: MemoryKnowledgeOrg): InsertFn {
  return async (_orgId, objectApiName, records) => {
    const answers = await org.sobject(objectApiName).create(records);
    const rows = answers.map((answer): InsertedRow =>
      answer.success
        ? { id: answer.id }
        : { error: `${answer.errors[0].statusCode}: ${answer.errors[0].message}` },
    );
    return {
      successIds: rows.flatMap((row) => (row.id ? [row.id] : [])),
      errors: rows.flatMap((row) => (row.error ? [row.error] : [])),
      rows,
    };
  };
}

/**
 * The org as the step after the writes reaches it, the org's clock moving on
 * before each call: what it dates is then past the run's last insert by more
 * than the leeway a removal reads the org's dates with.
 */
function slowly(org: MemoryKnowledgeOrg): KnowledgeOrg {
  return {
    query: (soql) => org.query(soql),
    request: async (request) => {
      later(CALL_SECONDS);
      return org.request(request);
    },
    sobject: (objectApiName) => ({
      create: async (records, options) => {
        later(CALL_SECONDS);
        return org.sobject(objectApiName).create(records, options);
      },
    }),
  };
}

/** A seed of `compiled` into `org`, as the panel runs one, with the step after its writes. */
function orchestrator(
  org: MemoryKnowledgeOrg,
  knowledge: SeedOrchestratorDependencies['knowledge'],
  extra: Partial<SeedOrchestratorDependencies> = {},
): SeedOrchestrator {
  return new SeedOrchestrator({
    validator: new SeedValidator(),
    planBuilder: new DataPlanBuilder(),
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error('no AI here');
      }),
      fakerFallback: new FakerFallback('en_US'),
    }),
    referenceLinker: new ReferenceLinker(),
    insert: insertInto(org),
    generateId: () => 'op-1',
    now: () => new Date().toISOString(),
    // What the org lets a seed create, read from its object list as the panel reads it.
    objectAccess: seedObjectAccess({
      describeGlobal: async () =>
        (await org.describeGlobal()) as { sobjects: Array<{ name: string; createable?: boolean }> },
      query: (soql) => org.query(soql),
      identity: () => org.identity(),
    }),
    ...(knowledge ? { knowledge } : {}),
    ...extra,
  });
}

/** The org a scenario is written to: the relationships a removal reads, Knowledge on or off. */
function scenarioOrg(knowledge = true): MemoryKnowledgeOrg {
  return new MemoryKnowledgeOrg(
    {
      Account: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Case', field: 'AccountId', cascadeDelete: true },
      ],
      Contact: [{ childSObject: 'Case', field: 'ContactId' }],
      Case: [{ childSObject: 'CaseComment', field: 'ParentId', cascadeDelete: true }],
    },
    { knowledge },
  );
}

/** A scenario compiled for the body field the org offers first. */
async function compiledFor(org: MemoryKnowledgeOrg): Promise<CompiledScenario> {
  const [field] = org.knowledge ? articleBodyFields(await org.describe(ARTICLE_VERSION)) : [];
  return compileScenario(RETAIL_ORDERS_PACK, field ? articleBodyOptions(field) : {});
}

/** Run a scenario, keeping what it writes, and end its file as the panel does. */
async function seeded(
  org: MemoryKnowledgeOrg,
  compiled: CompiledScenario,
  deps: Partial<Omit<SeedKnowledgeDeps, 'plan'>> & { plan?: SeedKnowledgeDeps['plan'] } = {},
  extra: Partial<SeedOrchestratorDependencies> = {},
): Promise<{ result: SeedExecutionResult; runs: SeedRunCreations }> {
  const runs = nodeSeedRunCreations(dir);
  const kept = runs.recorder({ runId: 'op-1', targetOrgId: 'tgt-org' });
  const knowledge = seedKnowledge({
    org: slowly(org),
    plan: { publish: true, links: compiled.closedCaseArticles },
    journal: kept,
    ...deps,
  });
  const insert = insertInto(org);
  const result = await orchestrator(org, knowledge, {
    insert: async (orgId, objectApiName, records, batchSize) => {
      const answer = await insert(orgId, objectApiName, records, batchSize);
      kept.note(objectApiName, answer.successIds);
      return answer;
    },
    ...extra,
  }).execute(compiled.template, 'tgt-org', 'op-1');
  await kept.end({ ...result, finishedAt: new Date().toISOString() });
  return { result, runs };
}

/** What the store keeps of what the removals of a run did, as the panel keeps it. */
async function removed(org: MemoryKnowledgeOrg, runs: SeedRunCreations) {
  later(120);
  const run = await runs.get('op-1');
  if (!run) throw new Error('no run kept');
  return removeSyncRun({ run, org, includeChanged: false, store: runs });
}

describe('seedKnowledge', () => {
  it('publishes every article the scenario wrote, under the id it wrote it with, and links each closed case to its article by the article', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);

    const { result } = await seeded(org, compiled);

    expect(result.status).toBe('success');
    expect(result.knowledge).toEqual({
      publish: { asked: 6, done: 6, notDone: [] },
      links: { asked: 20, done: 20, notDone: [] },
    });
    const written = result.objectResults.find((r) => r.objectApiName === ARTICLE_VERSION)!;
    expect(org.all(ARTICLE_VERSION).map((row) => row.Id)).toEqual(written.createdIds);
    for (const version of org.all(ARTICLE_VERSION)) {
      expect(version).toMatchObject({ PublishStatus: 'Online', VersionNumber: 1 });
    }
    // Never set back to draft: each version published once, as Online.
    expect(org.publications.map((p) => p.status)).toEqual(Array(6).fill('Online'));
    const articleIds = new Set(org.all(ARTICLE).map((row) => row.Id));
    const links = org.all(CASE_ARTICLE);
    expect(links).toHaveLength(20);
    for (const link of links) expect(articleIds.has(String(link.KnowledgeArticleId))).toBe(true);
    // Each closed case under the article of its topic, told by the URL name
    // the compiled article row gave the version the platform filled in.
    const rowsOf = (objectApiName: string) =>
      compiled.template.objects.find((o) => o.objectApiName === objectApiName)!.rows!;
    const urlNameOf = new Map(rowsOf(ARTICLE_VERSION).map((row) => [row.key, row.values.UrlName]));
    const subjectOf = new Map(rowsOf('Case').map((row) => [row.key, row.values.Subject]));
    const expected = compiled.closedCaseArticles
      .map(({ caseKey, articleKey }) => `${subjectOf.get(caseKey)} → ${urlNameOf.get(articleKey)}`)
      .sort();
    const caseById = new Map(org.all('Case').map((row) => [row.Id, row]));
    const versionById = new Map(org.all(ARTICLE_VERSION).map((row) => [row.Id, row]));
    const linked = links
      .map((link) => {
        const kase = caseById.get(String(link.CaseId))!;
        expect(kase.Status).toBe('Closed');
        return `${kase.Subject} → ${versionById.get(String(link.KnowledgeArticleVersionId))!.UrlName}`;
      })
      .sort();
    expect(linked).toEqual(expected);
  });

  it('leaves nothing of the run in the org once removed, the links going with their cases, though publishing and linking dated the articles after the last insert', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const { runs } = await seeded(org, compiled);

    const { result } = await removed(org, runs);

    expect(result.status).toBe('success');
    for (const object of ['Account', 'Contact', 'Case', 'CaseComment', ARTICLE, ARTICLE_VERSION]) {
      expect(org.all(object)).toEqual([]);
    }
    expect(org.all(CASE_ARTICLE)).toEqual([]);
    // The links were never the run's to delete: their cases took them.
    expect(result.objects.map((object) => object.objectApiName)).not.toContain(CASE_ARTICLE);
    expect(org.deletes.map((d) => d.objectApiName)).not.toContain(CASE_ARTICLE);
  });

  it('keeps the calls with the run: removed without them, the articles and the cases read as changed since and stayed', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const { runs } = await seeded(org, compiled, { journal: undefined });

    const { result } = await removed(org, runs);

    expect(result.status).toBe('partial');
    expect(result.objects.find((o) => o.objectApiName === ARTICLE_VERSION)).toMatchObject({
      keptChanged: 6,
    });
    // A link dated after the run hangs from its case, and holds it.
    expect(result.objects.find((o) => o.objectApiName === 'Case')).toMatchObject({
      heldBy: [CASE_ARTICLE],
    });
  });

  it('takes back articles it published and linked to nothing, each publication kept as a write of the run', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const { result: run, runs } = await seeded(org, compiled, {
      plan: { publish: true, links: [] },
    });

    const { result } = await removed(org, runs);

    expect(run.knowledge).toEqual({ publish: { asked: 6, done: 6, notDone: [] } });
    expect(result.status).toBe('success');
    expect(org.all(ARTICLE)).toEqual([]);
  });

  it('says why nothing was published or linked in an org without Knowledge, and the run stays a success', async () => {
    const org = scenarioOrg(false);
    const compiled = await compiledFor(org);
    const request = vi.spyOn(org, 'request');

    const { result } = await seeded(org, compiled);

    expect(result.status).toBe('success');
    expect(result.knowledge).toEqual({
      skipped:
        'Skipped: this org has no Knowledge__kav object (Salesforce Knowledge is not turned on in it).',
    });
    expect(request).not.toHaveBeenCalled();
    expect(org.all('Case')).toHaveLength(30);
  });

  it('names an article the org would not publish in its words, left a draft, links the rest, and leaves the run partial', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const firstArticle = `${RETAIL_ORDERS_PACK.id}-article-${RETAIL_ORDERS_PACK.topics[0].key}`;
    let refusedId: string | undefined;
    const knowledge = async (written: SeedRowsWritten) => {
      refusedId = written.ids.get(ARTICLE_VERSION_OBJECT)?.get(firstArticle);
      org.refusePublication.set(refusedId!, {
        errorCode: 'INSUFFICIENT_ACCESS',
        message: 'You do not have the permission to publish articles.',
      });
      return seedKnowledge({
        org: slowly(org),
        plan: { publish: true, links: compiled.closedCaseArticles },
      })(written);
    };

    const result = await orchestrator(org, knowledge).execute(compiled.template, 'tgt-org');

    expect(result.status).toBe('partial');
    expect(result.knowledge?.publish).toEqual({
      asked: 6,
      done: 5,
      notDone: [
        {
          key: firstArticle,
          reason:
            'Left a draft: INSUFFICIENT_ACCESS: You do not have the permission to publish articles.',
        },
      ],
    });
    expect(org.all(ARTICLE_VERSION).find((row) => row.Id === refusedId)?.PublishStatus).toBe(
      'Draft',
    );
    expect(result.knowledge?.links).toMatchObject({ asked: 20, done: 20 });
  });

  it('names a closed case whose case the org refused, links the others, and never sends it', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const [first] = compiled.closedCaseArticles;
    const refusedSubject = compiled.template.objects
      .find((o) => o.objectApiName === 'Case')!
      .rows!.find((row) => row.key === first.caseKey)!.values.Subject;
    const insert = insertInto(org);
    const knowledge = seedKnowledge({
      org: slowly(org),
      plan: { publish: false, links: compiled.closedCaseArticles },
    });

    const result = await orchestrator(org, knowledge, {
      insert: async (orgId, objectApiName, records, batchSize) => {
        if (objectApiName !== 'Case') return insert(orgId, objectApiName, records, batchSize);
        // The first closed case refused by a validation rule; the rest written.
        const kept = records.filter((record) => record.Subject !== refusedSubject);
        const answer = await insert(orgId, objectApiName, kept, batchSize);
        const rows = records.map((record) =>
          record.Subject === refusedSubject
            ? { error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: a reason is required' }
            : answer.rows!.shift()!,
        );
        return {
          successIds: answer.successIds,
          errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: a reason is required'],
          rows,
        };
      },
    }).execute(compiled.template, 'tgt-org');

    expect(result.knowledge?.publish).toBeUndefined();
    expect(result.knowledge?.links?.notDone).toContainEqual({
      key: first.caseKey,
      reason: 'Not linked: its case was not written.',
    });
    expect(result.knowledge?.links?.done).toBe(org.all(CASE_ARTICLE).length);
    expect(org.all(CASE_ARTICLE).length).toBeGreaterThan(0);
  });

  it('publishes nothing more once the run is stopped, naming each article left a draft, and answers as cancelled', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const controller = new AbortController();
    const port = slowly(org);
    let published = 0;
    const knowledge = seedKnowledge({
      org: {
        ...port,
        request: async (request) => {
          const answer = await port.request(request);
          if (++published === 2) controller.abort();
          return answer;
        },
      },
      plan: { publish: true, links: compiled.closedCaseArticles },
      signal: controller.signal,
    });

    const result = await orchestrator(org, knowledge, { signal: controller.signal }).execute(
      compiled.template,
      'tgt-org',
    );

    expect(result).toMatchObject({ status: 'partial', cancelled: true });
    expect(result.knowledge?.publish).toMatchObject({ asked: 6, done: 2 });
    expect(result.knowledge?.publish?.notDone).toHaveLength(4);
    expect(result.knowledge?.links).toMatchObject({ asked: 20, done: 0 });
    expect(org.all(CASE_ARTICLE)).toEqual([]);
    expect(org.all(ARTICLE_VERSION).filter((row) => row.PublishStatus === 'Online')).toHaveLength(
      2,
    );
  });

  it('takes the same step after a partitioned run, which a large scenario goes through', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);
    const knowledge = seedKnowledge({
      org: slowly(org),
      plan: { publish: true, links: compiled.closedCaseArticles },
    });

    const result = await orchestrator(org, knowledge, {
      grappeAdapter: new SeedGrappeAdapter(() => 'gid', 2_000),
      grappeConfig: {
        enabled: true,
        autoActivateThreshold: 1,
        grappeSize: 2_000,
      } as SeedOrchestratorDependencies['grappeConfig'],
    }).execute(compiled.template, 'tgt-org');

    expect(result.knowledge).toEqual({
      publish: { asked: 6, done: 6, notDone: [] },
      links: { asked: 20, done: 20, notDone: [] },
    });
  });

  it('keeps what the run wrote in its result when the step after the writes fails outright, said', async () => {
    const org = scenarioOrg();
    const compiled = await compiledFor(org);

    const result = await orchestrator(org, async () => {
      throw new Error('the connection was lost');
    }).execute(compiled.template, 'tgt-org');

    expect(result.status).toBe('partial');
    expect(result.knowledge).toEqual({
      skipped: 'The articles were neither published nor linked: the connection was lost',
    });
    expect(result.totalRecordsCreated).toBe(
      compiled.template.objects.reduce((sum, object) => sum + object.recordCount, 0),
    );
    expect(org.all(ARTICLE_VERSION)).toHaveLength(6);
  });
});
