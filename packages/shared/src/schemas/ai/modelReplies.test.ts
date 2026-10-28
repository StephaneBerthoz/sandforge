import { describe, it, expect } from 'vitest';
import {
  parseModelJson,
  PipelineDraftReplySchema,
  NL2SOQLReplySchema,
  PersonaReplySchema,
  DataRowsReplySchema,
  ErrorResolutionReplySchema,
  ModelReplyShapeError,
  ScenarioPackDraftSchema,
  ScenarioPackReplySchema,
  parseModelReplyNamingFields,
} from './modelReplies.js';
import { BUILT_IN_SCENARIO_PACKS } from '../../constants/scenario-packs.js';
import type { ScenarioPack } from '../../types/scenario.types.js';

describe('parseModelJson', () => {
  it('reads JSON the model wrapped in a markdown fence', () => {
    const reply = '```json\n{"soql": "SELECT Id FROM Account"}\n```';

    expect(parseModelJson(NL2SOQLReplySchema, reply).soql).toBe('SELECT Id FROM Account');
  });

  it('reads a fence with no language tag and prose around it', () => {
    const reply = 'Here you go:\n```\n{"soql": "SELECT Id FROM Case"}\n```\nHope it helps.';

    expect(parseModelJson(NL2SOQLReplySchema, reply).soql).toBe('SELECT Id FROM Case');
  });

  it('reads bare JSON', () => {
    expect(parseModelJson(NL2SOQLReplySchema, '  {"soql": "a"}  ').soql).toBe('a');
  });

  it('throws when the reply is not JSON', () => {
    expect(() => parseModelJson(NL2SOQLReplySchema, 'not json')).toThrow(/not valid JSON/);
  });

  it('throws when the JSON does not have the expected shape', () => {
    expect(() => parseModelJson(NL2SOQLReplySchema, '[1, 2]')).toThrow(/expected format/);
  });

  it('reads a fence whose content sits between blank lines and indentation', () => {
    const reply = '```json\n\n   {"soql": "SELECT Id FROM Lead"}   \n\n```';

    expect(parseModelJson(NL2SOQLReplySchema, reply).soql).toBe('SELECT Id FROM Lead');
  });

  it('answers at once when a reply opens a fence and never closes it', () => {
    const reply = '```' + ' '.repeat(3000) + 'x';

    const started = performance.now();
    expect(() => parseModelJson(NL2SOQLReplySchema, reply)).toThrow(/not valid JSON/);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('PipelineDraftReplySchema', () => {
  it('keeps the steps that name a step and a type, and drops the rest', () => {
    const draft = PipelineDraftReplySchema.parse({
      name: 'Nightly refresh',
      steps: [
        { name: 'copy', type: 'sync', config: { objects: ['Account'] }, description: 'Copy' },
        { name: 'no type' },
        'a sentence',
        { name: 'bare', type: 'compare' },
      ],
      triggers: ['sandbox_refresh', 42],
    });

    expect(draft.steps).toEqual([
      { name: 'copy', type: 'sync', config: { objects: ['Account'] }, description: 'Copy' },
      { name: 'bare', type: 'compare', config: {}, description: '' },
    ]);
    expect(draft.triggers).toEqual(['sandbox_refresh']);
    expect(draft.description).toBeUndefined();
  });

  it('reads a draft whose steps are missing as a draft with no step', () => {
    expect(PipelineDraftReplySchema.parse({ name: 'x', steps: 'none' }).steps).toEqual([]);
  });

  it('refuses a reply that is not an object', () => {
    expect(PipelineDraftReplySchema.safeParse([{ name: 'a', type: 'sync' }]).success).toBe(false);
  });
});

describe('NL2SOQLReplySchema', () => {
  it('fills what the model left out and keeps only string alternatives', () => {
    expect(
      NL2SOQLReplySchema.parse({ soql: 'SELECT Id FROM Account', alternatives: ['a', 1] }),
    ).toEqual({
      soql: 'SELECT Id FROM Account',
      explanation: '',
      confidence: 0,
      alternatives: ['a'],
    });
  });
});

describe('PersonaReplySchema', () => {
  it('fills the persona fields the model left out and keeps the patterns object', () => {
    const persona = PersonaReplySchema.parse({ name: 42, dataPatterns: { Pet__c: {} } });

    expect(persona).toEqual({
      name: 'Custom Persona',
      description: '',
      industry: 'General',
      locale: 'en-US',
      dataPatterns: { Pet__c: {} },
    });
  });

  it('reads patterns that are not an object as none', () => {
    expect(PersonaReplySchema.parse({ dataPatterns: ['x'] }).dataPatterns).toEqual({});
  });
});

describe('ErrorResolutionReplySchema', () => {
  it('fills the fields the model left out', () => {
    expect(ErrorResolutionReplySchema.parse({})).toEqual({
      explanation: 'Unable to determine root cause.',
      suggestions: [],
      autoFixable: false,
      autoFixAction: undefined,
      confidence: 0.5,
      relatedDocs: [],
    });
  });

  it('keeps the suggestions that are objects and the docs that are links', () => {
    const resolution = ErrorResolutionReplySchema.parse({
      explanation: 'The record is locked.',
      suggestions: [{ title: 'Retry', description: 'Wait and retry', probability: 0.8 }, 'later'],
      relatedDocs: ['https://developer.salesforce.com/docs', 7],
      confidence: 0.9,
    });

    expect(resolution.suggestions).toEqual([
      { title: 'Retry', description: 'Wait and retry', probability: 0.8, action: undefined },
    ]);
    expect(resolution.relatedDocs).toEqual(['https://developer.salesforce.com/docs']);
    expect(resolution.confidence).toBe(0.9);
  });

  it('refuses a reply that is not an object', () => {
    expect(ErrorResolutionReplySchema.safeParse(['explanation']).success).toBe(false);
  });
});

describe('DataRowsReplySchema', () => {
  it('keeps the objects of an array', () => {
    expect(DataRowsReplySchema.parse([{ Name: 'A' }, 42, 'x', null, [1], { Name: 'B' }])).toEqual([
      { Name: 'A' },
      { Name: 'B' },
    ]);
  });

  it('reads a single object as one row', () => {
    expect(DataRowsReplySchema.parse({ Name: 'Solo' })).toEqual([{ Name: 'Solo' }]);
  });

  it('reads a bare value as no row', () => {
    expect(DataRowsReplySchema.parse(42)).toEqual([]);
  });
});

/** The plan a pack was drafted from: the pack less its topics' articles and cases. */
function planOf(pack: ScenarioPack) {
  return {
    id: pack.id,
    name: pack.name,
    businessContext: pack.businessContext,
    customers: pack.customers,
    topics: pack.topics.map(({ key, label, utterances }) => ({ key, label, utterances })),
    decoy: pack.decoy,
    outOfScope: pack.outOfScope,
  };
}

const PACK = BUILT_IN_SCENARIO_PACKS[0];

describe('parseModelReplyNamingFields', () => {
  it('names every field a reply breaks by its path, and what is wrong there', () => {
    const reply = JSON.stringify({
      ...planOf(PACK),
      topics: [{ ...planOf(PACK).topics[0], key: 'Not A Key' }, ...planOf(PACK).topics.slice(1)],
      outOfScope: undefined,
      extra: true,
    });

    let refused: unknown;
    try {
      parseModelReplyNamingFields(ScenarioPackReplySchema.plan, reply);
    } catch (err) {
      refused = err;
    }

    expect(refused).toBeInstanceOf(ModelReplyShapeError);
    const { issues, message } = refused as ModelReplyShapeError;
    expect(issues).toEqual([
      expect.stringMatching(/^topics\[0\]\.key: A key is lower-case letters/),
      expect.stringMatching(/^outOfScope: /),
      '(the reply): Unrecognized key: "extra"',
    ]);
    expect(message).toBe(
      `The AI reply is JSON, but not in the expected format: ${issues.join('; ')}`,
    );
  });

  it('says how many more it broke past the first ten', () => {
    const issues = Array.from({ length: 12 }, (_, i) => `f${i}: wrong`);

    expect(new ModelReplyShapeError(issues).message).toMatch(/f9: wrong; and 2 more$/);
  });

  it('reads a fenced reply as the plain one, and refuses one that is no JSON', () => {
    const fenced = '```json\n' + JSON.stringify(planOf(PACK)) + '\n```';

    expect(parseModelReplyNamingFields(ScenarioPackReplySchema.plan, fenced).id).toBe(PACK.id);
    expect(() => parseModelReplyNamingFields(ScenarioPackReplySchema.plan, 'nope')).toThrow(
      'The AI reply is not valid JSON.',
    );
  });
});

describe('ScenarioPackReplySchema', () => {
  it.each(BUILT_IN_SCENARIO_PACKS.map((pack) => [pack.id, pack] as const))(
    'reads the plan and the topics of the built-in pack %s',
    (_, pack) => {
      expect(ScenarioPackReplySchema.plan.safeParse(planOf(pack)).success).toBe(true);
      for (const topic of pack.topics) {
        expect(
          ScenarioPackReplySchema.topic.safeParse({
            article: topic.article,
            caseTemplates: topic.caseTemplates,
          }).success,
        ).toBe(true);
      }
    },
  );

  it('refuses a plan that names a topic twice or has fewer customers than topics', () => {
    const plan = planOf(PACK);
    const twice = { ...plan, topics: [...plan.topics, plan.topics[0]] };
    const few = { ...plan, customers: { ...plan.customers, count: plan.topics.length - 1 } };

    const paths = (value: unknown) =>
      ScenarioPackReplySchema.plan.safeParse(value).error?.issues.map((i) => i.path.join('.'));
    expect(paths(twice)).toEqual([`topics.${plan.topics.length}.key`]);
    expect(paths(few)).toEqual(['customers.count']);
  });

  it('holds a topic reply to the bounds the pack holds its article to', () => {
    const topic = PACK.topics[0];
    const long = {
      article: { ...topic.article, body: 'x'.repeat(8_001) },
      caseTemplates: topic.caseTemplates,
    };

    expect(
      ScenarioPackReplySchema.topic.safeParse(long).error?.issues.map((i) => i.path.join('.')),
    ).toEqual(expect.arrayContaining(['article.body']));
  });

  it('refuses a topic reply that writes anything besides its article and cases', () => {
    const topic = PACK.topics[0];

    expect(
      ScenarioPackReplySchema.topic.safeParse({
        article: topic.article,
        caseTemplates: topic.caseTemplates,
        utterances: topic.utterances,
      }).success,
    ).toBe(false);
  });
});

describe('ScenarioPackDraftSchema', () => {
  it('reads a draft whose later topics are not written yet', () => {
    const draft = {
      ...planOf(PACK),
      version: 1,
      language: PACK.language,
      topics: PACK.topics.map((topic, index) =>
        index === 0 ? topic : { key: topic.key, label: topic.label, utterances: topic.utterances },
      ),
    };

    expect(ScenarioPackDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('reads a whole pack as a draft with every topic written', () => {
    expect(ScenarioPackDraftSchema.safeParse(PACK).success).toBe(true);
  });

  it('refuses a draft carrying a field no pack has', () => {
    expect(ScenarioPackDraftSchema.safeParse({ ...PACK, complete: true }).success).toBe(false);
  });
});
