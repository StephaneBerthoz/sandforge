import { describe, it, expect } from 'vitest';

import { AI_CONFIG, AI_PROVIDER, resolveAIModel } from './ai-config.js';

describe('AI_PROVIDER', () => {
  it('should be a non-empty string', () => {
    expect(typeof AI_PROVIDER).toBe('string');
    expect(AI_PROVIDER.length).toBeGreaterThan(0);
  });
});

describe('AI_CONFIG', () => {
  it('should have a non-empty model identifier', () => {
    expect(AI_CONFIG.MODEL).toBeTruthy();
    expect(typeof AI_CONFIG.MODEL).toBe('string');
    expect(AI_CONFIG.MODEL.length).toBeGreaterThan(0);
  });

  it('should have a positive max tokens value', () => {
    expect(AI_CONFIG.MAX_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(AI_CONFIG.MAX_TOKENS)).toBe(true);
  });

  // A timeout, a base URL and an API version were declared here and read by
  // nothing but this file: the SDK client is built from the key and
  // `maxRetries` alone.
  it('holds only what the extension reads: the default model and the answer cap', () => {
    expect(Object.keys(AI_CONFIG).sort()).toEqual(['MAX_TOKENS', 'MODEL']);
  });
});

describe('resolveAIModel', () => {
  it('asks the model the setting names, as it is written', () => {
    expect(resolveAIModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace-only', ' \t\n '],
    ['a number', 42],
    ['null', null],
  ])('asks the default model when the setting is %s', (_label, configured) => {
    expect(resolveAIModel(configured)).toBe(AI_CONFIG.MODEL);
  });
});
