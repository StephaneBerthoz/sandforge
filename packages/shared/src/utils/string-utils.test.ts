import { describe, it, expect } from 'vitest';

import {
  truncate,
  toPascalCase,
  toCamelCase,
  toSnakeCase,
  pluralize,
  maskString,
  generateId,
} from './string-utils.js';

describe('truncate', () => {
  it('should return the original string when shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should return the original string when exactly maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should truncate and add ellipsis when longer than maxLength', () => {
    expect(truncate('hello world', 6)).toBe('hello\u2026');
  });

  it('should handle maxLength of 1', () => {
    expect(truncate('hello', 1)).toBe('\u2026');
  });

  it('should handle empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('truncate edge cases', () => {
  it('should return empty string for maxLength = 0', () => {
    expect(truncate('hello', 0)).toBe('');
  });
  it('should return empty string for negative maxLength', () => {
    expect(truncate('hello', -5)).toBe('');
  });
  it('should return ellipsis for maxLength = 1 on long string', () => {
    expect(truncate('hello', 1)).toBe('\u2026');
  });
});

describe('toPascalCase', () => {
  it('should convert space-separated words', () => {
    expect(toPascalCase('hello world')).toBe('HelloWorld');
  });

  it('should convert kebab-case', () => {
    expect(toPascalCase('my-component')).toBe('MyComponent');
  });

  it('should convert snake_case', () => {
    expect(toPascalCase('my_variable')).toBe('MyVariable');
  });

  it('should handle single word', () => {
    expect(toPascalCase('hello')).toBe('Hello');
  });

  it('should handle already PascalCase', () => {
    expect(toPascalCase('HelloWorld')).toBe('HelloWorld');
  });

  it('should handle mixed separators', () => {
    expect(toPascalCase('my-cool_variable name')).toBe('MyCoolVariableName');
  });
});

describe('toCamelCase', () => {
  it('should convert space-separated words', () => {
    expect(toCamelCase('hello world')).toBe('helloWorld');
  });

  it('should convert kebab-case', () => {
    expect(toCamelCase('my-component')).toBe('myComponent');
  });

  it('should convert snake_case', () => {
    expect(toCamelCase('my_variable')).toBe('myVariable');
  });

  it('should handle single word', () => {
    expect(toCamelCase('Hello')).toBe('hello');
  });

  it('should handle already camelCase', () => {
    expect(toCamelCase('helloWorld')).toBe('helloWorld');
  });
});

describe('toSnakeCase', () => {
  it('should convert camelCase', () => {
    expect(toSnakeCase('helloWorld')).toBe('hello_world');
  });

  it('should convert PascalCase', () => {
    expect(toSnakeCase('HelloWorld')).toBe('hello_world');
  });

  it('should convert kebab-case', () => {
    expect(toSnakeCase('my-component')).toBe('my_component');
  });

  it('should convert space-separated words', () => {
    expect(toSnakeCase('hello world')).toBe('hello_world');
  });

  it('should handle single lowercase word', () => {
    expect(toSnakeCase('hello')).toBe('hello');
  });
});

describe('pluralize', () => {
  it('should return singular for count of 1', () => {
    expect(pluralize('record', 1)).toBe('record');
    expect(pluralize('box', 1)).toBe('box');
  });

  it('should add "s" for regular words', () => {
    expect(pluralize('record', 2)).toBe('records');
    expect(pluralize('account', 5)).toBe('accounts');
  });

  it('should add "es" for words ending in s, x, z, ch, sh', () => {
    expect(pluralize('bus', 2)).toBe('buses');
    expect(pluralize('box', 2)).toBe('boxes');
    expect(pluralize('buzz', 2)).toBe('buzzes');
    expect(pluralize('batch', 2)).toBe('batches');
    expect(pluralize('push', 2)).toBe('pushes');
  });

  it('should convert "y" to "ies" for consonant + y', () => {
    expect(pluralize('query', 2)).toBe('queries');
    expect(pluralize('category', 3)).toBe('categories');
  });

  it('should add "s" for vowel + y', () => {
    expect(pluralize('key', 2)).toBe('keys');
    expect(pluralize('day', 5)).toBe('days');
  });

  it('should handle count of 0', () => {
    expect(pluralize('record', 0)).toBe('records');
  });
});

describe('maskString', () => {
  it('should mask characters after visible portion', () => {
    expect(maskString('secrettoken', 4)).toBe('secr*******');
  });

  it('should fully mask strings shorter than visibleChars', () => {
    expect(maskString('ab', 4)).toBe('**');
  });

  it('should fully mask strings equal to visibleChars', () => {
    expect(maskString('abcd', 4)).toBe('****');
  });

  it('should use default visibleChars of 4', () => {
    expect(maskString('mypassword')).toBe('mypa******');
  });

  it('should handle single character', () => {
    expect(maskString('a', 4)).toBe('*');
  });

  it('should handle empty string', () => {
    expect(maskString('', 4)).toBe('');
  });
});

describe('generateId', () => {
  it('should return a non-empty string', () => {
    const id = generateId();
    expect(id.length).toBeGreaterThan(0);
  });

  it('should contain a hyphen separator', () => {
    const id = generateId();
    expect(id).toContain('-');
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('should only contain alphanumeric and hyphen characters', () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
