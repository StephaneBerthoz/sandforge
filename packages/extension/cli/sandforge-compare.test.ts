import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CompareItem, CompareResult } from '@sandforge/shared';
import {
  parseArgs,
  modifiedByType,
  describeCoverage,
  describeAnswer,
  PAGE_COMPONENT_TYPES,
} from './sandforge-compare.js';

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

/** One component of a diff. */
function item(
  componentType: CompareItem['componentType'],
  fullName: string,
  status: CompareItem['status'],
  notComparedReason?: CompareItem['notComparedReason'],
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    ...(notComparedReason ? { notComparedReason } : {}),
    severity: 'info',
    deployable: false,
  };
}

/** A diff answer, as the page receives it. */
const RESULT: CompareResult = {
  configId: 'cfg',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  mode: 'metadata',
  summary: {
    totalItems: 6,
    added: 1,
    removed: 0,
    modified: 2,
    unchanged: 1,
    notCompared: 2,
    byType: {},
  },
  content: {
    compared: 3,
    notCompared: { unreadable: 1, read_failed: 0, over_budget: 1 },
    budget: { components: 500, seconds: 90 },
  },
  diffs: [
    item('ApexClass', 'Billing', 'modified'),
    item('ApexClass', 'Invoicing', 'unchanged'),
    item('ApexClass', 'pkg__Engine', 'not_compared', 'unreadable'),
    item('ApexClass', 'Tax', 'added'),
    item('Flow', 'Onboarding', 'modified'),
    item('CustomField', 'Account.Region__c', 'not_compared', 'over_budget'),
  ],
  timestamp: '2026-09-22T10:00:00.000Z',
  duration: 1000,
};

describe('modifiedByType', () => {
  it('names the components called modified, by type', () => {
    expect(modifiedByType(RESULT.diffs)).toEqual(
      new Map([
        ['ApexClass', ['Billing']],
        ['Flow', ['Onboarding']],
      ]),
    );
  });
});

describe('describeCoverage', () => {
  it('says how many of the components in both orgs were compared by content, and why the rest were not', () => {
    expect(describeCoverage(RESULT)).toBe(
      '  content compared for 3 of 5 in both orgs; not compared: 1 over the budget ' +
        '(500 per org, 90 s), 1 unreadable, 0 read failed',
    );
  });
});

describe('describeAnswer', () => {
  it('counts each type in each org with the components it did not compare', () => {
    const lines = describeAnswer('execute', {
      outcome: 'answered',
      message: { id: 'r', type: 'compare:execute:response', timestamp: 0, payload: RESULT },
      elapsedMs: 1200,
      late: false,
    });

    expect(lines).toContain(
      '  mode metadata, 6 item(s): +1 added  -0 removed  ~2 modified  =1 unchanged  ?2 not compared',
    );
    // Three classes in the source, four in the target: the one it hides counts in both.
    expect(lines).toContain(
      `    ${'ApexClass'.padEnd(26)} source     3  target     4   +1 -0 ~1 =1 ?1`,
    );
    expect(lines).toContain('  modified ApexClass: Billing');
  });
});
