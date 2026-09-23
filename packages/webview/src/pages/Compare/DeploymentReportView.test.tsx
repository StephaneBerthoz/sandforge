import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { DeploymentReport } from '@sandforge/shared';
import { DeploymentReportView } from './DeploymentReportView';

const report = (overrides: Partial<DeploymentReport> = {}): DeploymentReport => ({
  deployId: '0Af000000000001',
  checkOnly: true,
  status: 'Succeeded',
  success: true,
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  testLevel: 'RunSpecifiedTests',
  runTests: ['InvoicingTest'],
  components: [
    { componentType: 'ApexClass', fullName: 'Invoicing', outcome: 'changed' },
    { componentType: 'CustomLabel', fullName: 'Greeting', outcome: 'created' },
  ],
  counts: {
    componentsTotal: 2,
    componentsDeployed: 2,
    componentErrors: 0,
    testsTotal: 4,
    testsCompleted: 4,
    testErrors: 0,
  },
  testFailures: [],
  coverageWarnings: [],
  ...overrides,
});

const view = (r: DeploymentReport) =>
  render(<DeploymentReportView report={r} targetLabel="Dev" data-testid="rep" />);

describe('DeploymentReportView', () => {
  it('says a validation kept nothing, where Setup lists it, and what it would do to each component', () => {
    view(report());

    expect(screen.getByTestId('rep-badge').textContent).toBe('Validated');
    expect(screen.getByTestId('rep-verdict').textContent).toBe(
      'Validated in Dev: it compiled everything, ran the tests asked for, and kept nothing.',
    );
    expect(screen.getByTestId('rep-where').textContent).toBe(
      'Dev lists it in Setup › Deployment Status, as 0Af000000000001.',
    );
    expect(screen.getByTestId('rep-counts').textContent).toBe(
      'Components: 2 of 2 without an error, 0 with one. Apex tests: 4 of 4 passed, 0 failed.',
    );
    expect(screen.getByTestId('rep-component-ApexClass-Invoicing').textContent).toContain(
      'Would change',
    );
    expect(screen.getByTestId('rep-component-CustomLabel-Greeting').textContent).toContain(
      'Would be created',
    );
  });

  it('says what a deployment did to each component, in the past', () => {
    view(report({ checkOnly: false }));

    expect(screen.getByTestId('rep-badge').textContent).toBe('Deployed');
    expect(screen.getByTestId('rep-verdict').textContent).toBe('Deployed to Dev.');
    expect(screen.getByTestId('rep-component-ApexClass-Invoicing').textContent).toContain(
      'Changed',
    );
  });

  it('gives each failure the line it fails on, and each failed test its line', () => {
    view(
      report({
        success: false,
        status: 'Failed',
        components: [
          {
            componentType: 'ApexClass',
            fullName: 'Invoicing',
            outcome: 'failed',
            problem: 'Variable does not exist: total',
            problemType: 'Error',
            fileName: 'classes/Invoicing.cls',
            line: 12,
            column: 5,
          },
          {
            componentType: 'Layout',
            fullName: 'Order-Order Layout',
            outcome: 'failed',
            problem: 'Field missing',
            problemType: 'Warning',
          },
        ],
        testFailures: [
          {
            className: 'InvoicingTest',
            methodName: 'charges',
            message: 'System.AssertException: Assertion Failed',
            line: 21,
          },
        ],
        coverageWarnings: ['Invoicing: Test coverage of 40%'],
      }),
    );

    expect(screen.getByTestId('rep-badge').textContent).toBe('Failed');
    expect(screen.getByTestId('rep-verdict').textContent).toBe(
      'The validation failed in Dev: nothing can be deployed until a validation succeeds.',
    );
    expect(screen.getByTestId('rep-component-ApexClass-Invoicing').textContent).toContain(
      'Variable does not exist: total(classes/Invoicing.cls, line 12, column 5)',
    );
    expect(screen.getByTestId('rep-component-Layout-Order-Order Layout').textContent).toContain(
      'Warning',
    );
    expect(screen.getByTestId('rep-test-failures').textContent).toContain('1 test failed');
    expect(screen.getByTestId('rep-test-failures').textContent).toContain(
      'InvoicingTest.charges(line 21)',
    );
    expect(screen.getByTestId('rep-coverage').textContent).toContain(
      'Invoicing: Test coverage of 40%',
    );
  });

  it('says nothing was sent when the source returned none of the components', () => {
    view(
      report({
        deployId: undefined,
        success: false,
        status: 'NotStarted',
        components: [
          {
            componentType: 'ApexClass',
            fullName: 'Invoicing',
            outcome: 'not_retrieved',
            problem: "Entity of type 'ApexClass' named 'Invoicing' cannot be found",
          },
        ],
      }),
    );

    expect(screen.getByTestId('rep-badge').textContent).toBe('Not started');
    expect(screen.getByTestId('rep-verdict').textContent).toBe(
      'Nothing was sent to Dev: the source returned none of the components.',
    );
    expect(screen.getByTestId('rep-missing').textContent).toBe(
      'The source did not return 1 component asked for: untick it and validate again.',
    );
    expect(screen.queryByTestId('rep-where')).toBeNull();
    expect(screen.queryByTestId('rep-counts')).toBeNull();
    expect(screen.getByTestId('rep-component-ApexClass-Invoicing').textContent).toContain(
      'Not returned by the source',
    );
  });

  it('keeps what stopped a deployment as a whole, and what the source said', () => {
    view(
      report({
        success: false,
        status: 'Failed',
        errorMessage: 'No package.xml found',
        retrieveProblems: ['classes/Invoicing.cls: Unable to read file'],
        counts: {
          componentsTotal: 0,
          componentsDeployed: 0,
          componentErrors: 0,
          testsTotal: 0,
          testsCompleted: 0,
          testErrors: 0,
        },
      }),
    );

    expect(screen.getByTestId('rep-error').textContent).toBe(
      'Stopped as a whole: No package.xml found',
    );
    expect(screen.getByTestId('rep-counts').textContent).toContain('No Apex test ran.');
    expect(screen.getByTestId('rep-retrieve-problems').textContent).toContain(
      'classes/Invoicing.cls: Unable to read file',
    );
  });
});
