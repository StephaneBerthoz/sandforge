import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CompareItem } from '@sandforge/shared';
import { parseArgs, modifiedBecause, PAGE_COMPONENT_TYPES } from './sandforge-compare.js';

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-compare.ts', ...args];
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
  it('reads the two orgs and the categories to diff', () => {
    const args = parseArgs(
      argv('--source', 'SRC', '--target', 'TGT', '--type', 'ApexClass', '--type', 'Flow'),
    );
    expect(args.source).toBe('SRC');
    expect(args.target).toBe('TGT');
    expect(args.types).toEqual(['ApexClass', 'Flow']);
    expect(args.operations).toEqual(['execute', 'permissions', 'snapshots', 'drift']);
  });

  it('sends every category the page offers for --all-types, as "Select all" does', () => {
    const args = parseArgs(argv('--source', 'SRC', '--target', 'TGT', '--all-types'));
    expect(args.types).toEqual([...PAGE_COMPONENT_TYPES]);
  });

  it('runs only the operations asked for, and needs no category without execute', () => {
    const args = parseArgs(argv('--source', 'SRC', '--target', 'TGT', '--op', 'drift'));
    expect(args.operations).toEqual(['drift']);
    expect(args.types).toEqual([]);
  });

  it('refuses a diff with no category, as the page keeps Run disabled', () => {
    const { code, message } = refuse('--source', 'SRC', '--target', 'TGT');
    expect(code).toBe(2);
    expect(message).toContain('--type');
  });

  it('refuses a category the page does not offer', () => {
    expect(refuse('--source', 'S', '--target', 'T', '--type', 'CustomSetting').code).toBe(2);
  });

  it('refuses one org compared with itself', () => {
    expect(refuse('--source', 'S', '--target', 'S', '--op', 'drift').code).toBe(2);
  });

  it('refuses a line with an org missing', () => {
    expect(refuse('--source', 'S', '--op', 'drift').code).toBe(2);
  });

  it('refuses an operation the page does not send', () => {
    expect(refuse('--source', 'S', '--target', 'T', '--op', 'deploy').code).toBe(2);
  });
});

describe('modifiedBecause', () => {
  it('counts the properties the two orgs disagree on across modified items', () => {
    const item = (source: object, target: object): CompareItem => ({
      componentType: 'ApexClass',
      fullName: 'Invoicing',
      status: 'modified',
      sourceValue: JSON.stringify(source),
      targetValue: JSON.stringify(target),
      severity: 'breaking',
      deployable: true,
    });

    const counts = modifiedBecause([
      item({ id: 'a', fullName: 'X' }, { id: 'b', fullName: 'X' }),
      item({ id: 'c', lastModifiedDate: '1' }, { id: 'd', lastModifiedDate: '2' }),
    ]);

    expect(counts).toEqual({ id: 2, lastModifiedDate: 1 });
  });
});
