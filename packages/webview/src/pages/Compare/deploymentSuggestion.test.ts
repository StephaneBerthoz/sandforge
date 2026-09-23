import { describe, it, expect } from 'vitest';
import type { CompareItem } from '@sandforge/shared';
import { DEPLOY_MAX_TESTS } from '@sandforge/shared';
import { enrichDiffs } from './enrichDiffs';
import {
  advisedTestLevel,
  candidateKey,
  notDeployableReason,
  parseTestNames,
  suggestDeployment,
} from './deploymentSuggestion';

const item = (overrides: Partial<CompareItem> & Pick<CompareItem, 'fullName'>): CompareItem => ({
  componentType: 'ApexClass',
  status: 'modified',
  severity: 'warning',
  deployable: true,
  ...overrides,
});

describe('notDeployableReason', () => {
  it('lets a component only the source holds, or one that differs, be deployed', () => {
    // `removed`, in the comparison's terms: in the source, not in the target.
    expect(notDeployableReason(item({ fullName: 'A', status: 'removed' }))).toBeUndefined();
    expect(notDeployableReason(item({ fullName: 'B', status: 'modified' }))).toBeUndefined();
  });

  it('holds back what only the target holds: taking it out is destructive', () => {
    expect(notDeployableReason(item({ fullName: 'A', status: 'added' }))).toBe('only_in_target');
  });

  it('holds back what a package installed, whatever else is true of it', () => {
    expect(notDeployableReason(item({ fullName: 'ns__A', managed: true }))).toBe('managed');
    expect(
      notDeployableReason(
        item({
          fullName: 'ns__B',
          status: 'not_compared',
          notComparedReason: 'unreadable',
          managed: true,
        }),
      ),
    ).toBe('managed');
  });

  it('says why a component was not compared: unreadable, or simply not compared', () => {
    expect(
      notDeployableReason(
        item({ fullName: 'A', status: 'not_compared', notComparedReason: 'unreadable' }),
      ),
    ).toBe('unreadable');
    expect(
      notDeployableReason(
        item({ fullName: 'B', status: 'not_compared', notComparedReason: 'over_budget' }),
      ),
    ).toBe('not_compared');
    expect(
      notDeployableReason(
        item({ fullName: 'C', status: 'not_compared', notComparedReason: 'read_failed' }),
      ),
    ).toBe('not_compared');
  });

  it('holds back a profile or a permission set, which a retrieval returns only in part', () => {
    expect(notDeployableReason(item({ fullName: 'Admin', componentType: 'Profile' }))).toBe(
      'permissions_in_part',
    );
  });
});

describe('suggestDeployment', () => {
  const items: CompareItem[] = [
    item({ fullName: 'Same', status: 'unchanged' }),
    item({ fullName: 'Region__c', componentType: 'CustomField', status: 'removed' }),
    item({ fullName: 'Invoicing', status: 'modified' }),
    item({ fullName: 'Greeting', componentType: 'CustomLabel', status: 'removed' }),
    item({ fullName: 'Admin', componentType: 'Profile', status: 'modified' }),
    item({ fullName: 'Legacy', status: 'added' }),
    item({ fullName: 'Billing', status: 'not_compared', notComparedReason: 'over_budget' }),
  ];

  it('offers every change the source can carry, and leaves out what is unchanged', () => {
    const suggestion = suggestDeployment(items, enrichDiffs(items));
    const everything = [...suggestion.deployable, ...suggestion.notDeployable];

    expect(suggestion.deployable.map(candidateKey)).toEqual([
      'CustomField:Region__c',
      'ApexClass:Invoicing',
      'CustomLabel:Greeting',
    ]);
    expect(everything.map((c) => c.fullName)).not.toContain('Same');
  });

  it('lists in the risk card groups, data model first, with the card risk of each change', () => {
    const suggestion = suggestDeployment(items, enrichDiffs(items));

    expect(suggestion.deployable.map((c) => c.group)).toEqual([
      'Data Model',
      'Apex Code',
      'Configuration',
    ]);
    const invoicing = suggestion.deployable.find((c) => c.fullName === 'Invoicing');
    expect(invoicing?.riskLevel).toBe(
      enrichDiffs(items).diffs.find((d) => d.name === 'Invoicing')?.riskLevel,
    );
    expect(invoicing?.riskLevel).not.toBe('none');
  });

  it('says why each of the others cannot be deployed, and gives an unscored one no risk', () => {
    const suggestion = suggestDeployment(items, enrichDiffs(items));

    expect(suggestion.notDeployable.map((c) => [c.fullName, c.notDeployable, c.riskLevel])).toEqual(
      [
        ['Billing', 'not_compared', 'none'],
        ['Legacy', 'only_in_target', expect.any(String)],
        ['Admin', 'permissions_in_part', expect.any(String)],
      ],
    );
  });
});

describe('advisedTestLevel', () => {
  it('advises the target tests for Apex, as the risk card does, and none otherwise', () => {
    expect(advisedTestLevel([{ componentType: 'ApexClass' }, { componentType: 'Layout' }])).toBe(
      'RunLocalTests',
    );
    expect(advisedTestLevel([{ componentType: 'ApexTrigger' }])).toBe('RunLocalTests');
    expect(advisedTestLevel([{ componentType: 'CustomLabel' }])).toBe('NoTestRun');
    expect(advisedTestLevel([])).toBe('NoTestRun');
  });

  it('agrees with the risk card on the same components', () => {
    const apex = [item({ fullName: 'Invoicing' })];
    const card = enrichDiffs(apex).deploymentAdvice.some((a) => a.kind === 'apexTests');

    expect(advisedTestLevel(apex) === 'RunLocalTests').toBe(card);
  });
});

describe('parseTestNames', () => {
  it('reads names separated by commas, semicolons or spaces, each once', () => {
    expect(parseTestNames(' InvoicingTest, BillingTest;InvoicingTest  pkg.EngineTest ')).toEqual({
      names: ['InvoicingTest', 'BillingTest', 'pkg.EngineTest'],
      invalid: [],
      tooMany: false,
    });
  });

  it('sets apart what is no class name', () => {
    expect(parseTestNames('InvoicingTest 1Bad Bad-Name').invalid).toEqual(['1Bad', 'Bad-Name']);
  });

  it('says when more tests are named than a deployment takes', () => {
    const many = Array.from({ length: DEPLOY_MAX_TESTS + 1 }, (_, i) => `T${i}`).join(' ');

    expect(parseTestNames(many).tooMany).toBe(true);
    expect(parseTestNames('').names).toEqual([]);
  });
});
