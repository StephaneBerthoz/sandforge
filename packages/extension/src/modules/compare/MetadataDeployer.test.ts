import { describe, it, expect, vi } from 'vitest';
import type { DeploymentComponentRef } from '@sandforge/shared';
import {
  DeploymentStillRunning,
  deployOptions,
  deployPackage,
  deploymentReport,
  retrieveComponents,
} from './MetadataDeployer';
import type {
  DeployMetadataApi,
  DeployProgress,
  DeployStatus,
  RetrieveStatus,
  Waiting,
} from './MetadataDeployer';

/** A clock that moves only when the code under test sleeps. */
function fakeWaiting(overrides: Partial<Waiting> = {}): Waiting & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    pollMs: 1000,
    retrieveTimeoutMs: 60_000,
    deployTimeoutMs: 600_000,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
    slept,
    ...overrides,
  };
}

/** An API whose retrievals answer the given statuses in turn, and whose deployments the others. */
function fakeApi(
  retrieveStatuses: RetrieveStatus[][],
  deployStatuses: DeployStatus[] = [],
): DeployMetadataApi & {
  retrieve: ReturnType<typeof vi.fn>;
  checkRetrieveStatus: ReturnType<typeof vi.fn>;
  deploy: ReturnType<typeof vi.fn>;
  checkDeployStatus: ReturnType<typeof vi.fn>;
} {
  let retrieval = -1;
  let check = 0;
  let deployCheck = 0;
  return {
    retrieve: vi.fn(() => {
      retrieval += 1;
      check = 0;
      return Promise.resolve({ id: `09S00000000000${retrieval}` });
    }),
    checkRetrieveStatus: vi.fn(() => {
      const statuses = retrieveStatuses[retrieval];
      const status = statuses[Math.min(check, statuses.length - 1)];
      check += 1;
      return Promise.resolve(status);
    }),
    deploy: vi.fn(() => Promise.resolve({ id: '0Af000000000001' })),
    checkDeployStatus: vi.fn(() => {
      const status = deployStatuses[Math.min(deployCheck, deployStatuses.length - 1)];
      deployCheck += 1;
      return Promise.resolve(status);
    }),
  };
}

const INVOICING: DeploymentComponentRef = { componentType: 'ApexClass', fullName: 'Invoicing' };
const BILLING: DeploymentComponentRef = { componentType: 'ApexClass', fullName: 'Billing' };
const LABEL: DeploymentComponentRef = { componentType: 'CustomLabel', fullName: 'Greeting' };
const LAYOUT: DeploymentComponentRef = { componentType: 'Layout', fullName: 'Order-Order Layout' };

const packed = (overrides: Partial<RetrieveStatus> = {}): RetrieveStatus => ({
  done: true,
  success: true,
  status: 'Succeeded',
  zipFile: 'UEsDBA==',
  fileProperties: [],
  messages: [],
  ...overrides,
});

const notFound = (type: string, name: string) => ({
  fileName: 'package.xml',
  problem: `Entity of type '${type}' named '${name}' cannot be found`,
});

describe('retrieveComponents', () => {
  it('asks the source for every component as one package, at the root of the zip', async () => {
    const api = fakeApi([[packed()]]);

    await retrieveComponents(api, '66.0', [INVOICING, LAYOUT, BILLING], {
      waiting: fakeWaiting(),
    });

    expect(api.retrieve).toHaveBeenCalledTimes(1);
    const request = api.retrieve.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toEqual({
      apiVersion: 66,
      singlePackage: true,
      unpackaged: {
        objectPermissions: [],
        types: [
          { members: ['Invoicing', 'Billing'], name: 'ApexClass' },
          { members: ['Order-Order Layout'], name: 'Layout' },
        ],
        version: '66.0',
      },
    });
    // The Metadata API reads elements in the order of its schema.
    expect(Object.keys(request)).toEqual(['apiVersion', 'singlePackage', 'unpackaged']);
    expect(Object.keys((request.unpackaged as { types: object[] }).types[0])).toEqual([
      'members',
      'name',
    ]);
  });

  it('checks on the retrieval until the source has packed it, waiting between checks', async () => {
    const api = fakeApi([[{ done: false, status: 'InProgress' }, { done: false }, packed()]]);
    const waiting = fakeWaiting();

    const result = await retrieveComponents(api, '66.0', [INVOICING], { waiting });

    expect(api.checkRetrieveStatus).toHaveBeenCalledTimes(3);
    expect(api.checkRetrieveStatus).toHaveBeenCalledWith('09S000000000000');
    expect(waiting.slept).toEqual([1000, 1000]);
    expect(result.zipFile).toBe('UEsDBA==');
    expect(result.retrieved).toEqual([INVOICING]);
  });

  it('asks again for the others when the source no longer holds one, so the package names only what it holds', async () => {
    const api = fakeApi([
      [packed({ zipFile: 'first', messages: [notFound('ApexClass', 'Billing')] })],
      [packed({ zipFile: 'second' })],
    ]);

    const result = await retrieveComponents(api, '66.0', [INVOICING, BILLING], {
      waiting: fakeWaiting(),
    });

    expect(api.retrieve).toHaveBeenCalledTimes(2);
    const second = api.retrieve.mock.calls[1][0] as { unpackaged: { types: unknown[] } };
    expect(second.unpackaged.types).toEqual([{ members: ['Invoicing'], name: 'ApexClass' }]);
    expect(result.zipFile).toBe('second');
    expect(result.retrieved).toEqual([INVOICING]);
    expect(result.missing).toEqual([
      { ...BILLING, problem: "Entity of type 'ApexClass' named 'Billing' cannot be found" },
    ]);
  });

  it('does not call a label missing because the source lists it as the file that holds it', async () => {
    // A label comes back in labels/CustomLabels.labels, listed as CustomLabels:
    // read as "not returned", every label would be dropped from the package.
    const api = fakeApi([
      [
        packed({
          fileProperties: [
            {
              type: 'CustomLabels',
              fullName: 'CustomLabels',
              fileName: 'labels/CustomLabels.labels',
            },
            { type: 'Package', fullName: 'package.xml', fileName: 'package.xml' },
          ],
        }),
      ],
    ]);

    const result = await retrieveComponents(api, '66.0', [LABEL], { waiting: fakeWaiting() });

    expect(api.retrieve).toHaveBeenCalledTimes(1);
    expect(result.retrieved).toEqual([LABEL]);
    expect(result.missing).toEqual([]);
  });

  it('matches a component the source names percent-encoded to the one asked for', async () => {
    const layout = { componentType: 'Layout' as const, fullName: "Quote-Quote d'offre" };
    const api = fakeApi([[packed({ messages: [notFound('Layout', 'Quote-Quote d%27offre')] })]]);

    const result = await retrieveComponents(api, '66.0', [layout], { waiting: fakeWaiting() });

    expect(result.missing.map((m) => m.fullName)).toEqual(["Quote-Quote d'offre"]);
  });

  it('hands over nothing when the source holds none of the components, without asking twice', async () => {
    const api = fakeApi([[packed({ messages: [notFound('ApexClass', 'Invoicing')] })]]);

    const result = await retrieveComponents(api, '66.0', [INVOICING], { waiting: fakeWaiting() });

    expect(api.retrieve).toHaveBeenCalledTimes(1);
    expect(result.zipFile).toBe('');
    expect(result.retrieved).toEqual([]);
    expect(result.missing).toHaveLength(1);
  });

  it('keeps what the source says of no component asked for, rather than dropping it', async () => {
    const api = fakeApi([
      [
        packed({
          messages: [{ fileName: 'classes/Invoicing.cls', problem: 'Unable to read file' }],
        }),
      ],
    ]);

    const result = await retrieveComponents(api, '66.0', [INVOICING], { waiting: fakeWaiting() });

    expect(result.problems).toEqual(['classes/Invoicing.cls: Unable to read file']);
    expect(result.retrieved).toEqual([INVOICING]);
  });

  it('flags a component asked for that a package installed, and not the package object around a field of the org', async () => {
    const field = { componentType: 'CustomField' as const, fullName: 'ns__Order__c.Rebate__c' };
    const engine = { componentType: 'ApexClass' as const, fullName: 'ns__Engine' };
    const api = fakeApi([
      [
        packed({
          fileProperties: [
            {
              type: 'CustomObject',
              fullName: 'ns__Order__c',
              namespacePrefix: 'ns',
              manageableState: 'installed',
            },
            {
              type: 'ApexClass',
              fullName: 'ns__Engine',
              namespacePrefix: 'ns',
              manageableState: 'installed',
            },
          ],
        }),
      ],
    ]);

    const result = await retrieveComponents(api, '66.0', [field, engine], {
      waiting: fakeWaiting(),
    });

    expect(result.managed).toEqual([engine]);
  });

  it('says a failed retrieval failed, with what the source answered', async () => {
    const api = fakeApi([
      [
        {
          done: true,
          success: false,
          status: 'Failed',
          errorMessage: 'INVALID_CROSS_REFERENCE_KEY',
        },
      ],
    ]);

    await expect(
      retrieveComponents(api, '66.0', [INVOICING], { waiting: fakeWaiting() }),
    ).rejects.toThrow(
      'Retrieval 09S000000000000 from the source failed: INVALID_CROSS_REFERENCE_KEY',
    );
  });

  it('stops waiting on a retrieval past its time, and names it', async () => {
    const api = fakeApi([[{ done: false, status: 'InProgress' }]]);

    const outcome = retrieveComponents(api, '66.0', [INVOICING], {
      waiting: fakeWaiting({ retrieveTimeoutMs: 3000 }),
    });

    await expect(outcome).rejects.toBeInstanceOf(DeploymentStillRunning);
    await expect(outcome).rejects.toThrow('Retrieval 09S000000000000 was still InProgress');
  });

  it('reports where the retrieval stands, before and after', async () => {
    const progress: DeployProgress[] = [];
    const api = fakeApi([[packed({ messages: [notFound('ApexClass', 'Billing')] })], [packed()]]);

    await retrieveComponents(api, '66.0', [INVOICING, BILLING], {
      waiting: fakeWaiting(),
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { step: 'retrieve', done: 0, total: 2 },
      { step: 'retrieve', done: 1, total: 2 },
    ]);
  });
});

describe('deployOptions', () => {
  it('validates when asked to, rolls everything back on an error, and never purges', () => {
    expect(deployOptions(true, 'NoTestRun', [])).toEqual({
      allowMissingFiles: false,
      autoUpdatePackage: false,
      checkOnly: true,
      ignoreWarnings: false,
      performRetrieve: false,
      purgeOnDelete: false,
      rollbackOnError: true,
      singlePackage: true,
      testLevel: 'NoTestRun',
    });
    expect(deployOptions(false, 'RunLocalTests', ['Ignored']).checkOnly).toBe(false);
  });

  it('names the tests only for the level that runs the named tests', () => {
    expect(deployOptions(true, 'RunSpecifiedTests', ['InvoicingTest']).runTests).toEqual([
      'InvoicingTest',
    ]);
    expect(deployOptions(true, 'RunLocalTests', ['InvoicingTest'])).not.toHaveProperty('runTests');
  });

  it('writes the options in the order of the Metadata API schema', () => {
    expect(Object.keys(deployOptions(true, 'RunSpecifiedTests', ['T']))).toEqual([
      'allowMissingFiles',
      'autoUpdatePackage',
      'checkOnly',
      'ignoreWarnings',
      'performRetrieve',
      'purgeOnDelete',
      'rollbackOnError',
      'runTests',
      'singlePackage',
      'testLevel',
    ]);
  });
});

describe('deployPackage', () => {
  const running = (overrides: Partial<DeployStatus>): DeployStatus => ({
    id: '0Af000000000001',
    done: false,
    status: 'InProgress',
    ...overrides,
  });

  it('sends the package with its options, follows it without details, and reads them once at the end', async () => {
    const finished = running({ done: true, status: 'Succeeded', success: true });
    const api = fakeApi(
      [],
      [
        running({ numberComponentsTotal: 2, numberComponentsDeployed: 1 }),
        running({
          numberComponentsTotal: 2,
          numberComponentsDeployed: 2,
          numberTestsTotal: 4,
          numberTestsCompleted: 1,
          numberTestErrors: 1,
        }),
        running({ done: true }),
        finished,
      ],
    );
    const progress: DeployProgress[] = [];
    const options = deployOptions(true, 'RunLocalTests', []);

    const result = await deployPackage(api, 'UEsDBA==', options, {
      waiting: fakeWaiting(),
      onProgress: (p) => progress.push(p),
    });

    expect(api.deploy).toHaveBeenCalledWith('UEsDBA==', options);
    expect(api.checkDeployStatus.mock.calls.map((call) => call[0])).toEqual(
      Array(4).fill('0Af000000000001'),
    );
    expect(api.checkDeployStatus.mock.calls.map((call) => call[1])).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(progress).toEqual([
      { step: 'components', done: 1, total: 2 },
      { step: 'tests', done: 2, total: 4 },
    ]);
    expect(result).toBe(finished);
  });

  it('stops waiting past its time and says where the deployment goes on', async () => {
    const api = fakeApi([], [running({})]);

    const outcome = deployPackage(api, 'UEsDBA==', deployOptions(true, 'NoTestRun', []), {
      waiting: fakeWaiting({ deployTimeoutMs: 120_000 }),
    });

    await expect(outcome).rejects.toBeInstanceOf(DeploymentStillRunning);
    await expect(outcome).rejects.toThrow(
      'Deployment 0Af000000000001 was still InProgress after 2 min; it goes on in the target org, and Setup › Deployment Status follows it.',
    );
  });
});

describe('deploymentReport', () => {
  const facts = {
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    checkOnly: true,
    testLevel: 'RunSpecifiedTests' as const,
    runTests: ['InvoicingTest'],
  };

  const validated: DeployStatus = {
    id: '0Af000000000001',
    done: true,
    status: 'Failed',
    success: false,
    checkOnly: true,
    numberComponentsTotal: 3,
    numberComponentsDeployed: 2,
    numberComponentErrors: 1,
    numberTestsTotal: 2,
    numberTestsCompleted: 1,
    numberTestErrors: 1,
    startDate: '2026-09-23T10:00:00.000Z',
    completedDate: '2026-09-23T10:01:00.000Z',
    details: {
      componentFailures: [
        {
          componentType: 'ApexClass',
          fullName: 'Invoicing',
          fileName: 'classes/Invoicing.cls',
          success: false,
          problem: 'Variable does not exist: total',
          problemType: 'Error',
          lineNumber: 12,
          columnNumber: 5,
        },
      ],
      componentSuccesses: [
        { componentType: '', fullName: 'package.xml', success: true },
        { componentType: 'ApexClass', fullName: 'Invoicing', success: true, changed: true },
        { componentType: 'Layout', fullName: 'Order-Order Layout', success: true, changed: true },
        {
          componentType: 'CustomLabels',
          fullName: 'CustomLabels',
          success: 'true',
          created: 'false',
          changed: 'false',
        },
        { componentType: 'CustomLabel', fullName: 'Greeting', success: true, created: true },
      ],
      runTestResult: {
        failures: {
          name: 'InvoicingTest',
          methodName: 'charges',
          message: 'System.AssertException: Assertion Failed',
          stackTrace: 'Class.InvoicingTest.charges: line 21, column 1',
        },
        codeCoverageWarnings: [{ name: 'Invoicing', message: 'Test coverage of 40%' }],
      },
    },
  };

  it('lists each component the org reports once, its failure first, with where it fails', () => {
    const report = deploymentReport(validated, { missing: [], problems: [] }, facts);

    expect(report.components).toEqual([
      {
        componentType: 'ApexClass',
        fullName: 'Invoicing',
        fileName: 'classes/Invoicing.cls',
        outcome: 'failed',
        problem: 'Variable does not exist: total',
        problemType: 'Error',
        line: 12,
        column: 5,
      },
      { componentType: 'Layout', fullName: 'Order-Order Layout', outcome: 'changed' },
      { componentType: 'CustomLabels', fullName: 'CustomLabels', outcome: 'unchanged' },
      { componentType: 'CustomLabel', fullName: 'Greeting', outcome: 'created' },
    ]);
  });

  it('gives each failed test the line its stack trace names, and the coverage it found short', () => {
    const report = deploymentReport(validated, { missing: [], problems: [] }, facts);

    expect(report.testFailures).toEqual([
      {
        className: 'InvoicingTest',
        methodName: 'charges',
        message: 'System.AssertException: Assertion Failed',
        stackTrace: 'Class.InvoicingTest.charges: line 21, column 1',
        line: 21,
      },
    ]);
    expect(report.coverageWarnings).toEqual(['Invoicing: Test coverage of 40%']);
  });

  it('carries the id, the status, the counts and the times the org gave', () => {
    const report = deploymentReport(validated, { missing: [], problems: [] }, facts);

    expect(report).toMatchObject({
      deployId: '0Af000000000001',
      checkOnly: true,
      status: 'Failed',
      success: false,
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      testLevel: 'RunSpecifiedTests',
      runTests: ['InvoicingTest'],
      counts: {
        componentsTotal: 3,
        componentsDeployed: 2,
        componentErrors: 1,
        testsTotal: 2,
        testsCompleted: 1,
        testErrors: 1,
      },
      startedAt: '2026-09-23T10:00:00.000Z',
      completedAt: '2026-09-23T10:01:00.000Z',
    });
  });

  it('adds what the source did not return, and does not call the run a success without it', () => {
    const succeeded: DeployStatus = {
      id: '0Af000000000002',
      done: true,
      status: 'Succeeded',
      success: true,
    };
    const report = deploymentReport(
      succeeded,
      {
        missing: [
          { ...BILLING, problem: "Entity of type 'ApexClass' named 'Billing' cannot be found" },
        ],
        problems: ['classes/Invoicing.cls: Unable to read file'],
      },
      facts,
    );

    expect(report.success).toBe(false);
    expect(report.status).toBe('Succeeded');
    expect(report.components).toEqual([
      {
        componentType: 'ApexClass',
        fullName: 'Billing',
        outcome: 'not_retrieved',
        problem: "Entity of type 'ApexClass' named 'Billing' cannot be found",
      },
    ]);
    expect(report.retrieveProblems).toEqual(['classes/Invoicing.cls: Unable to read file']);
  });

  it('calls a run that took everything a success', () => {
    const succeeded: DeployStatus = {
      id: '0Af000000000003',
      done: true,
      status: 'Succeeded',
      success: true,
    };

    expect(deploymentReport(succeeded, { missing: [], problems: [] }, facts).success).toBe(true);
  });

  it('says nothing was sent when the source returned nothing', () => {
    const report = deploymentReport(
      undefined,
      { missing: [{ ...INVOICING, problem: 'gone' }], problems: [] },
      facts,
    );

    expect(report).not.toHaveProperty('deployId');
    expect(report.status).toBe('NotStarted');
    expect(report.success).toBe(false);
    expect(report.components.map((c) => c.outcome)).toEqual(['not_retrieved']);
  });

  it('keeps the error that stopped a deployment as a whole', () => {
    const stopped: DeployStatus = {
      id: '0Af000000000004',
      done: true,
      status: 'Failed',
      success: false,
      errorMessage: 'No package.xml found',
    };

    expect(deploymentReport(stopped, { missing: [], problems: [] }, facts).errorMessage).toBe(
      'No package.xml found',
    );
  });
});
