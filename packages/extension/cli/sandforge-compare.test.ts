import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CompareItem, CompareResult } from '@sandforge/shared';
import {
  parseArgs,
  modifiedByType,
  describeCoverage,
  describeAnswer,
  describeDeployment,
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

  it('compares what a managed package installed unless told to leave it out, as the page does', () => {
    const base = ['--source', 'SRC', '--target', 'TGT', '--type', 'ApexClass'];
    expect(parseArgs(argv(...base)).includeManaged).toBe(true);
    expect(parseArgs(argv(...base, '--exclude-managed')).includeManaged).toBe(false);
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

describe('parseArgs, validating a deployment', () => {
  const base = ['--source', 'SRC', '--target', 'TGT'];

  it('validates the components named, alone, with no tests unless asked', () => {
    const args = parseArgs(
      argv(...base, '--validate', 'ApexClass:Invoicing', '--validate', 'Layout:Order-Order Layout'),
    );
    expect(args.operations).toEqual(['validate-deployment']);
    expect(args.validation).toEqual({
      components: [
        { componentType: 'ApexClass', fullName: 'Invoicing' },
        { componentType: 'Layout', fullName: 'Order-Order Layout' },
      ],
      testLevel: 'NoTestRun',
      runTests: [],
    });
  });

  it('runs the test classes named for RunSpecifiedTests', () => {
    const args = parseArgs(
      argv(
        ...base,
        '--validate',
        'ApexClass:Invoicing',
        '--tests',
        'RunSpecifiedTests',
        '--run-test',
        'InvoicingTest',
      ),
    );
    expect(args.validation.testLevel).toBe('RunSpecifiedTests');
    expect(args.validation.runTests).toEqual(['InvoicingTest']);
  });

  it('can send no request that deploys: a validation is the furthest it goes', () => {
    const every = parseArgs(
      argv(
        ...base,
        '--type',
        'ApexClass',
        '--validate',
        'ApexClass:Invoicing',
        ...['execute', 'permissions', 'snapshots', 'drift', 'validate-deployment'].flatMap((op) => [
          '--op',
          op,
        ]),
      ),
    );
    expect(every.operations.map((op) => `compare:${op}`)).not.toContain('compare:deploy');
  });

  it.each([
    ['a type a deployment does not carry', ['--validate', 'Profile:Admin']],
    ['a component with no name', ['--validate', 'ApexClass:']],
    ['named tests with none named', ['--validate', 'ApexClass:A', '--tests', 'RunSpecifiedTests']],
    ['a test named at another level', ['--validate', 'ApexClass:A', '--run-test', 'ATest']],
    [
      'a test that is no class name',
      ['--validate', 'ApexClass:A', '--tests', 'RunSpecifiedTests', '--run-test', 'A;B'],
    ],
    ['a level the Metadata API does not name', ['--validate', 'ApexClass:A', '--tests', 'All']],
    ['a validation of nothing', ['--op', 'validate-deployment']],
  ])('refuses %s', (_what, extra) => {
    expect(refuse(...base, ...extra).code).toBe(2);
  });
});

describe('describeDeployment', () => {
  it('prints the verdict, each component with where it fails, and each failed test', () => {
    const lines = describeDeployment({
      deployId: '0Af000000000001',
      checkOnly: true,
      status: 'Failed',
      success: false,
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      testLevel: 'RunSpecifiedTests',
      runTests: ['InvoicingTest'],
      components: [
        {
          componentType: 'ApexClass',
          fullName: 'Invoicing',
          outcome: 'failed',
          problem: 'Variable does not exist: total',
          line: 12,
          column: 5,
        },
        { componentType: 'Layout', fullName: 'Order-Order Layout', outcome: 'changed' },
      ],
      counts: {
        componentsTotal: 2,
        componentsDeployed: 1,
        componentErrors: 1,
        testsTotal: 1,
        testsCompleted: 0,
        testErrors: 1,
      },
      testFailures: [
        {
          className: 'InvoicingTest',
          methodName: 'charges',
          message: 'Assertion Failed',
          line: 21,
        },
      ],
      coverageWarnings: [],
    });

    expect(lines).toEqual([
      '  validation 0Af000000000001: Failed, no success',
      '  components: 1 of 2 without an error, 1 with one; tests (RunSpecifiedTests: InvoicingTest): ' +
        '0 of 1 passed, 1 failed',
      '    failed        ApexClass Invoicing — Variable does not exist: total (line 12, column 5)',
      '    changed       Layout Order-Order Layout',
      '    test failed  InvoicingTest.charges (line 21) — Assertion Failed',
    ]);
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

describe('describeCoverage with managed packages left out', () => {
  it('says how many components a managed package installed the run left out', () => {
    const leftOut = { ...RESULT, content: { ...RESULT.content, managedLeftOut: 8 } };
    expect(describeCoverage(leftOut)).toBe(
      '  content compared for 3 of 5 in both orgs; not compared: 1 over the budget ' +
        '(500 per org, 90 s), 1 unreadable, 0 read failed; left out, as asked: 8 installed by ' +
        'a managed package',
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
