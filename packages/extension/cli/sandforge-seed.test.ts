import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  describeDistribution,
  parseArgs,
  prebuiltTemplate,
  rulesFromDescribe,
} from './sandforge-seed.js';

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

describe('parseArgs — relations', () => {
  const accountsThenContacts = ['--target', 'T', '--object', 'Account:3', '--object', 'Contact:1'];

  it('fills the lookup from the accounts this run writes, and counts the contacts from them', () => {
    const args = parseArgs(
      argv(...accountsThenContacts, '--relation', 'Contact.AccountId=Account', '--per-parent', '3'),
    );

    expect(args.relations).toEqual([
      {
        childObject: 'Contact',
        lookupField: 'AccountId',
        parentObject: 'Account',
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 3 },
      },
    ]);
    // The count given with --object is replaced by the one the relation plans.
    expect(args.objects).toEqual([
      { objectApiName: 'Account', recordCount: 3 },
      { objectApiName: 'Contact', recordCount: 9 },
    ]);
  });

  it('gives the options after a relation to that relation only', () => {
    const args = parseArgs(
      argv(
        ...accountsThenContacts,
        '--object',
        'Opportunity:1',
        '--relation',
        'Contact.AccountId=Account',
        '--between',
        '1-4',
        '--relation',
        'Opportunity.AccountId=Account',
        '--ratio',
        '0.5',
      ),
    );

    expect(args.relations.map((r) => r.distribution)).toEqual([
      { mode: 'range', min: 1, max: 4 },
      { mode: 'ratio', ratio: 0.5 },
    ]);
    // The ceiling of a range, and exactly what a ratio spreads.
    expect(args.objects.map((o) => o.recordCount)).toEqual([3, 12, 1]);
  });

  it('draws the parents from the org when told where, bounded by --parent-limit', () => {
    const args = parseArgs(
      argv(
        '--target',
        'T',
        '--object',
        'Contact:1',
        '--relation',
        'Contact.AccountId=Account',
        '--where',
        "Industry = 'Energy'",
        '--parent-limit',
        '4',
        '--per-parent',
        '2',
      ),
    );

    expect(args.relations[0].parents).toEqual({
      kind: 'existing',
      where: "Industry = 'Energy'",
      limit: 4,
    });
    expect(args.objects).toEqual([{ objectApiName: 'Contact', recordCount: 8 }]);
  });

  it('reads a bounded number of any existing parents with --existing alone', () => {
    const args = parseArgs(
      argv(
        '--target',
        'T',
        '--object',
        'Contact:1',
        '--relation',
        'Contact.AccountId=Account',
        '--existing',
      ),
    );

    expect(args.relations[0].parents).toEqual({ kind: 'existing', limit: 10 });
    expect(args.objects[0].recordCount).toBe(10);
  });

  it('refuses a relation option given before any relation', () => {
    const { code, message } = refuse(...accountsThenContacts, '--per-parent', '3');
    expect(code).toBe(2);
    expect(message).toContain('give --relation before it');
  });

  it('refuses a relation whose child is not one of the objects to write', () => {
    const { code, message } = refuse(
      ...accountsThenContacts,
      '--relation',
      'Case.AccountId=Account',
    );
    expect(code).toBe(2);
    expect(message).toContain('give Case with --object');
  });

  it('refuses parents from this run when the run does not write them', () => {
    const { code, message } = refuse(
      '--target',
      'T',
      '--object',
      'Contact:1',
      '--relation',
      'Contact.AccountId=Account',
    );
    expect(code).toBe(2);
    expect(message).toContain('--existing');
  });

  it('refuses parents from this run for records of their own object', () => {
    const { code } = refuse(...accountsThenContacts, '--relation', 'Account.ParentId=Account');
    expect(code).toBe(2);
  });

  it('refuses a ratio that gives no parent a child', () => {
    const { code, message } = refuse(
      '--target',
      'T',
      '--object',
      'Account:1',
      '--object',
      'Contact:1',
      '--relation',
      'Contact.AccountId=Account',
      '--ratio',
      '0.5',
    );
    expect(code).toBe(2);
    expect(message).toContain('gives no parent a child');
  });

  it('refuses a relation it cannot read, and numbers out of their bounds', () => {
    expect(refuse(...accountsThenContacts, '--relation', 'Contact.AccountId').code).toBe(2);
    for (const bad of [
      ['--per-parent', '0'],
      ['--between', '4-2'],
      ['--ratio', '0'],
      ['--parent-limit', '2001'],
    ]) {
      expect(
        refuse(...accountsThenContacts, '--relation', 'Contact.AccountId=Account', ...bad).code,
      ).toBe(2);
    }
  });

  it('refuses a relation with a built-in template, which carries its own links', () => {
    const { code } = refuse(
      '--target',
      'T',
      '--template',
      'prebuilt-minimal-demo',
      '--relation',
      'Contact.AccountId=Account',
      '--existing',
    );
    expect(code).toBe(2);
  });
});

describe('describeDistribution', () => {
  it('says how each way of spreading gives children to a parent', () => {
    expect(describeDistribution({ mode: 'perParent', count: 3 })).toBe('3 per parent');
    expect(describeDistribution({ mode: 'range', min: 1, max: 4 })).toBe('1 to 4 per parent');
    expect(describeDistribution({ mode: 'ratio', ratio: 0.5 })).toBe('0.5 per parent on average');
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

  it('gives a field the bounds the panel gives it, so the org takes what is drawn', () => {
    // A two-digit score drawn up to 1000, a percentage past 100, a name longer
    // than its field: each refuses the record. The panel bounds all three.
    const rules = rulesFromDescribe([
      { ...field('Name', 'string'), length: 80 },
      { ...field('Score__c', 'double', { nillable: false }), precision: 4, scale: 2 },
      { ...field('Rate__c', 'percent', { nillable: false }), precision: 5, scale: 2 },
      { ...field('Units__c', 'int', { nillable: false }), digits: 3 },
    ]);

    expect(Object.fromEntries(rules.map((r) => [r.fieldApiName, r.config]))).toEqual({
      Name: { fakerMethod: 'name', maxLength: 80 },
      Score__c: { fakerMethod: 'integer', maxValue: 99 },
      Rate__c: { fakerMethod: 'integer', maxValue: 100 },
      Units__c: { fakerMethod: 'integer', maxValue: 999 },
    });
  });

  it('picks a required picklist among its active values, and leaves a lookup to a relation', () => {
    const rules = rulesFromDescribe([
      {
        ...field('Stage__c', 'picklist', { nillable: false }),
        picklistValues: [
          { value: 'Open', active: true },
          { value: 'Retired', active: false },
        ],
      },
      field('Account__c', 'reference', { nillable: false }),
    ]);

    expect(rules).toEqual([
      {
        fieldApiName: 'Stage__c',
        fieldType: 'picklist',
        ruleType: 'picklist_random',
        config: { picklistValues: ['Open'] },
      },
    ]);
  });
});
