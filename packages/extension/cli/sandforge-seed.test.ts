import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs, prebuiltTemplate, rulesFromDescribe } from './sandforge-seed.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-seed.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads an object and how many rows of it', () => {
    const args = parseArgs(argv('--target', 'TGT', '--object', 'Account:5'));
    expect(args.target).toBe('TGT');
    expect(args.objects).toEqual([{ objectApiName: 'Account', recordCount: 5 }]);
  });

  it('keeps several objects in the order given, which is the insert order', () => {
    const args = parseArgs(argv('--target', 'T', '--object', 'Account:2', '--object', 'Contact:4'));
    expect(args.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
  });

  it('refuses a line with nothing to write', () => {
    expect(refuse('--target', 'T').code).toBe(2);
  });

  it('refuses a template and objects together', () => {
    // Two answers to "what should this write" is one too many.
    const { code, message } = refuse(
      '--target',
      'T',
      '--template',
      'prebuilt-minimal-demo',
      '--object',
      'Account:1',
    );
    expect(code).toBe(2);
    expect(message).toContain('not both');
  });

  it('refuses an object with no count', () => {
    expect(refuse('--target', 'T', '--object', 'Account').code).toBe(2);
  });

  it('refuses a count that is not a whole number of records', () => {
    expect(refuse('--target', 'T', '--object', 'Account:0').code).toBe(2);
    expect(refuse('--target', 'T', '--object', 'Account:many').code).toBe(2);
  });

  it('refuses an object name that is not one', () => {
    expect(refuse('--target', 'T', '--object', 'Account; DROP:1').code).toBe(2);
  });
});

describe('prebuiltTemplate', () => {
  it('finds a built-in one by id', () => {
    expect(prebuiltTemplate('prebuilt-minimal-demo')?.id).toBe('prebuilt-minimal-demo');
  });

  it('answers nothing when the flags describe the objects instead', () => {
    expect(prebuiltTemplate(undefined)).toBeNull();
  });

  it('names what it has when asked for one it does not', () => {
    const { code, message } = (() => {
      let code: number | undefined;
      let message = '';
      vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
        code = c;
        throw new Error('exit');
      }) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
        message += chunk;
        return true;
      }) as never);
      try {
        prebuiltTemplate('prebuilt-does-not-exist');
      } catch {
        // stubbed exit
      }
      return { code, message };
    })();
    expect(code).toBe(2);
    expect(message).toContain('prebuilt-minimal-demo');
  });
});

describe('rulesFromDescribe', () => {
  const field = (
    name: string,
    type: string,
    over: Partial<{ createable: boolean; nillable: boolean; defaultedOnCreate: boolean }> = {},
  ) => ({ name, type, createable: true, nillable: true, ...over });

  it('takes Name even though the platform does not insist on it', () => {
    // A seeded record with no name is not usable data.
    const rules = rulesFromDescribe([field('Name', 'string')]);
    expect(rules.map((r) => r.fieldApiName)).toEqual(['Name']);
  });

  it('takes the fields the platform will not let a record omit', () => {
    const rules = rulesFromDescribe([
      field('Subject', 'string', { nillable: false }),
      field('Optional__c', 'string'),
    ]);
    expect(rules.map((r) => r.fieldApiName)).toEqual(['Subject']);
  });

  it('leaves out a required field the platform fills in by itself', () => {
    const rules = rulesFromDescribe([
      field('OwnerId', 'reference', { nillable: false, defaultedOnCreate: true }),
    ]);
    expect(rules).toEqual([]);
  });

  it('leaves out what cannot be written at all', () => {
    const rules = rulesFromDescribe([
      field('CreatedDate', 'datetime', { createable: false, nillable: false }),
    ]);
    expect(rules).toEqual([]);
  });

  it('asks the faker for something that suits the field', () => {
    const rules = rulesFromDescribe([field('Email', 'email', { nillable: false })]);
    expect(rules[0].ruleType).toBe('faker');
    expect(rules[0].config.fakerMethod).toBeTruthy();
    expect(rules[0].fieldType).toBe('email');
  });

  it('leaves out a type the faker has nothing for', () => {
    const rules = rulesFromDescribe([field('Blob__c', 'base64', { nillable: false })]);
    expect(rules).toEqual([]);
  });
});
