import { describe, it, expect } from 'vitest';

import { AI_CONFIG, AI_PROVIDER } from './ai-config.js';

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

  it('should have temperature between 0 and 1', () => {
    expect(AI_CONFIG.TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(AI_CONFIG.TEMPERATURE).toBeLessThanOrEqual(1);
  });

  it('should have a positive max tokens value', () => {
    expect(AI_CONFIG.MAX_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(AI_CONFIG.MAX_TOKENS)).toBe(true);
  });

  it('should have a positive timeout in milliseconds', () => {
    expect(AI_CONFIG.TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('should have a valid base URL', () => {
    expect(AI_CONFIG.BASE_URL).toMatch(/^https:\/\//);
  });

  it('should have a non-empty API version string', () => {
    expect(AI_CONFIG.API_VERSION).toBeTruthy();
    expect(typeof AI_CONFIG.API_VERSION).toBe('string');
  });

  it('should define all expected keys', () => {
    const keys = [
      'MODEL',
      'TEMPERATURE',
      'MAX_TOKENS',
      'TIMEOUT_MS',
      'BASE_URL',
      'API_VERSION',
    ] as const;
    for (const key of keys) {
      expect(AI_CONFIG[key]).toBeDefined();
    }
  });
});
