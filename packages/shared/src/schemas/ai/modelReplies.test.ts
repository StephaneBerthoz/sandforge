import { describe, it, expect } from 'vitest';
import {
  parseModelJson,
  PipelineDraftReplySchema,
  PipelineSuggestionsReplySchema,
  NL2SOQLReplySchema,
  PersonaReplySchema,
  DataRowsReplySchema,
  ErrorResolutionReplySchema,
} from './modelReplies.js';

describe('parseModelJson', () => {
  it('reads JSON the model wrapped in a markdown fence', () => {
    const reply = '```json\n{"soql": "SELECT Id FROM Account"}\n```';

    expect(parseModelJson(NL2SOQLReplySchema, reply).soql).toBe('SELECT Id FROM Account');
  });

  it('reads a fence with no language tag and prose around it', () => {
    const reply = 'Here you go:\n```\n["Add a compare step"]\n```\nHope it helps.';

    expect(parseModelJson(PipelineSuggestionsReplySchema, reply)).toEqual(['Add a compare step']);
  });

  it('reads bare JSON', () => {
    expect(parseModelJson(PipelineSuggestionsReplySchema, '  ["a"]  ')).toEqual(['a']);
  });

  it('throws when the reply is not JSON', () => {
    expect(() => parseModelJson(NL2SOQLReplySchema, 'not json')).toThrow(/not valid JSON/);
  });

  it('throws when the JSON does not have the expected shape', () => {
    expect(() => parseModelJson(NL2SOQLReplySchema, '[1, 2]')).toThrow(/expected format/);
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
