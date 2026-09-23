import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, DeploymentReport } from '@sandforge/shared';
import { CompareHandler } from './CompareHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { Waiting } from '../../modules/compare/MetadataDeployer.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

/*
 * The deployment path of Compare through the handler: the real deployer, the
 * real Production Guard; only the two connections are stand-ins, each
 * recording what the Metadata API was asked.
 */

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** No wait at all: every check comes straight after the last. */
const instant: Waiting = {
  pollMs: 0,
  retrieveTimeoutMs: 60_000,
  deployTimeoutMs: 60_000,
  sleep: () => Promise.resolve(),
  now: () => 0,
};

/** The Metadata API of one org, answering as a sandbox does. */
function orgApi(
  options: {
    retrieveMessages?: Array<{ fileName: string; problem: string }>;
    fileProperties?: Array<Record<string, string>>;
    deployResult?: Record<string, unknown>;
  } = {},
) {
  let deployments = 0;
  const metadata = {
    retrieve: vi.fn(() => Promise.resolve({ id: '09S000000000001' })),
    checkRetrieveStatus: vi.fn(() =>
      Promise.resolve({
        done: true,
        success: true,
        status: 'Succeeded',
        zipFile: 'UEsDBBQ=',
        fileProperties: options.fileProperties ?? [],
        messages: options.retrieveMessages ?? [],
      }),
    ),
    deploy: vi.fn(() => {
      deployments += 1;
      return Promise.resolve({ id: `0Af00000000000${deployments}` });
    }),
    checkDeployStatus: vi.fn((id: string) =>
      Promise.resolve({
        id,
        done: true,
        status: 'Succeeded',
        success: true,
        numberComponentsTotal: 2,
        numberComponentsDeployed: 2,
        numberComponentErrors: 0,
        numberTestsTotal: 0,
        numberTestsCompleted: 0,
        numberTestErrors: 0,
        details: {
          componentSuccesses: [
            { componentType: 'ApexClass', fullName: 'Invoicing', success: true, changed: true },
            {
              componentType: 'Layout',
              fullName: 'Order-Order Layout',
              success: true,
              created: true,
            },
          ],
          componentFailures: [],
        },
        ...options.deployResult,
      }),
    ),
  };
  return { version: '66.0', metadata, limitInfo: undefined };
}

type OrgApi = ReturnType<typeof orgApi>;

function createDeps(orgTypes: Record<string, string | undefined>): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn((orgId: string) =>
        orgId in orgTypes ? { orgType: orgTypes[orgId] } : undefined,
      ),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

const COMPONENTS = [
  { componentType: 'ApexClass', fullName: 'Invoicing' },
  { componentType: 'Layout', fullName: 'Order-Order Layout' },
];

const validateRequest = (payload: Record<string, unknown> = {}) =>
  inboundRequest({
    id: 'req-validate',
    type: 'compare:validate-deployment',
    timestamp: Date.now(),
    payload: {
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      components: COMPONENTS,
      testLevel: 'NoTestRun',
      ...payload,
    },
  });

const deployRequest = (payload: Record<string, unknown>) =>
  inboundRequest({ id: 'req-deploy', type: 'compare:deploy', timestamp: Date.now(), payload });

describe('CompareHandler deployments', () => {
  let deps: HandlerDeps;
  let handler: CompareHandler;
  let source: OrgApi;
  let target: OrgApi;

  const posted = () =>
    (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as BaseMessage & { payload: Record<string, unknown> },
    );
  const answer = (type: string) => posted().find((m) => m.type === type);
  const report = (type: string) => answer(type)?.payload.report as DeploymentReport;
  const error = () => answer('compare:error');

  const connect = (src: OrgApi, tgt: OrgApi) => {
    source = src;
    target = tgt;
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps({ src: 'Sandbox', tgt: 'Sandbox' });
    handler = new CompareHandler(deps, { waiting: instant });
    connect(orgApi(), orgApi());
  });

  describe('compare:validate-deployment', () => {
    it('retrieves the components from the source and validates them check-only in the target', async () => {
      await handler.handle(validateRequest());

      expect(source.metadata.retrieve).toHaveBeenCalledTimes(1);
      expect(source.metadata.deploy).not.toHaveBeenCalled();
      expect(target.metadata.retrieve).not.toHaveBeenCalled();
      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      const [zip, options] = target.metadata.deploy.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(zip).toBe('UEsDBBQ=');
      expect(options).toMatchObject({
        checkOnly: true,
        testLevel: 'NoTestRun',
        rollbackOnError: true,
        purgeOnDelete: false,
      });

      const response = answer('compare:validate-deployment:response');
      expect(response?.correlationId).toBe('req-validate');
      expect(report('compare:validate-deployment:response')).toMatchObject({
        deployId: '0Af000000000001',
        checkOnly: true,
        success: true,
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        components: [
          { componentType: 'ApexClass', fullName: 'Invoicing', outcome: 'changed' },
          { componentType: 'Layout', fullName: 'Order-Order Layout', outcome: 'created' },
        ],
      });
    });

    it('runs the named tests when asked for them, and only then names them', async () => {
      await handler.handle(
        validateRequest({ testLevel: 'RunSpecifiedTests', runTests: ['InvoicingTest'] }),
      );
      await handler.handle(validateRequest({ testLevel: 'RunLocalTests', runTests: ['Ignored'] }));

      const [first, second] = target.metadata.deploy.mock.calls.map(
        (call) => (call as unknown as [string, Record<string, unknown>])[1],
      );
      expect(first).toMatchObject({ testLevel: 'RunSpecifiedTests', runTests: ['InvoicingTest'] });
      expect(second).toMatchObject({ testLevel: 'RunLocalTests' });
      expect(second).not.toHaveProperty('runTests');
    });

    it('refuses a production target before asking the source for anything', async () => {
      deps = createDeps({ src: 'Sandbox', tgt: 'Production' });
      handler = new CompareHandler(deps, { waiting: instant });

      await handler.handle(validateRequest());

      expect(source.metadata.retrieve).not.toHaveBeenCalled();
      expect(target.metadata.deploy).not.toHaveBeenCalled();
      expect(error()?.payload).toMatchObject({
        code: 'GUARD_BLOCKED',
        message:
          'Operation blocked by Production Guard: deploy is not allowed on production org tgt: ' +
          'SandForge deploys metadata to sandboxes only',
      });
      expect(error()?.correlationId).toBe('req-validate');
    });

    it('treats a target whose type it does not know as production', async () => {
      deps = createDeps({ src: 'Sandbox' });
      handler = new CompareHandler(deps, { waiting: instant });

      await handler.handle(validateRequest());

      expect(target.metadata.deploy).not.toHaveBeenCalled();
      expect(error()?.payload.code).toBe('GUARD_BLOCKED');
    });

    it('sends nothing to the target when the source says a package installed a component', async () => {
      connect(
        orgApi({
          fileProperties: [
            {
              type: 'ApexClass',
              fullName: 'Invoicing',
              namespacePrefix: 'ns',
              manageableState: 'installed',
            },
          ],
        }),
        orgApi(),
      );

      await handler.handle(validateRequest());

      expect(target.metadata.deploy).not.toHaveBeenCalled();
      expect(error()?.payload).toMatchObject({ code: 'MANAGED' });
      expect(String(error()?.payload.message)).toContain('ApexClass Invoicing');
    });

    it('reports a component the source no longer holds, and keeps no validation to deploy', async () => {
      connect(
        orgApi({
          retrieveMessages: [
            {
              fileName: 'package.xml',
              problem: "Entity of type 'Layout' named 'Order-Order Layout' cannot be found",
            },
          ],
        }),
        orgApi(),
      );

      await handler.handle(validateRequest());
      const validated = report('compare:validate-deployment:response');
      expect(validated.success).toBe(false);
      expect(validated.components).toContainEqual(
        expect.objectContaining({ fullName: 'Order-Order Layout', outcome: 'not_retrieved' }),
      );

      await handler.handle(
        deployRequest({ validationId: validated.deployId as string, targetOrgId: 'tgt' }),
      );
      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload.code).toBe('NOT_VALIDATED');
    });

    it('says where the run stands, under the id of the request that started it', async () => {
      await handler.handle(validateRequest());

      const progress = posted().filter((m) => m.type === 'operation:progress');
      expect(progress.length).toBeGreaterThan(0);
      for (const message of progress) expect(message.payload.operationId).toBe('req-validate');
      expect(progress[0].payload).toMatchObject({ currentStep: 'retrieve', totalRecords: 2 });
    });

    it('says the deployment goes on in the org when it outlasts the wait', async () => {
      const slow = orgApi({ deployResult: { done: false, status: 'InProgress' } });
      connect(orgApi(), slow);
      let clock = 0;
      handler = new CompareHandler(deps, {
        waiting: { ...instant, deployTimeoutMs: 120_000, now: () => (clock += 60_000) },
      });

      await handler.handle(validateRequest());

      expect(error()?.payload.code).toBe('STILL_RUNNING');
      expect(String(error()?.payload.message)).toContain('Setup › Deployment Status');
    });

    it('does not put a validation in the audit log, which records writes', async () => {
      const guard = new ProductionGuard();
      deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];

      await handler.handle(validateRequest());

      expect(guard.getAuditLog()).toEqual([]);
    });

    it.each([
      ['a permission set', { components: [{ componentType: 'PermissionSet', fullName: 'Sales' }] }],
      ['a type that is not one', { components: [{ componentType: 'Other', fullName: 'X' }] }],
      ['the same component twice', { components: [COMPONENTS[0], COMPONENTS[0]] }],
      ['named tests without a name', { testLevel: 'RunSpecifiedTests', runTests: [] }],
      [
        'a test name that is not a class name',
        { testLevel: 'RunSpecifiedTests', runTests: ['A; B'] },
      ],
      ['one org as source and target', { targetOrgId: 'src' }],
    ])('refuses a request naming %s', async (_what, payload) => {
      await handler.handle(validateRequest(payload));

      expect(source.metadata.retrieve).not.toHaveBeenCalled();
      expect(error()?.payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('compare:deploy', () => {
    async function validated(): Promise<string> {
      await handler.handle(
        validateRequest({ testLevel: 'RunSpecifiedTests', runTests: ['InvoicingTest'] }),
      );
      return report('compare:validate-deployment:response').deployId as string;
    }

    it('deploys the package the validation checked, with the same tests, for real this time', async () => {
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(source.metadata.retrieve).toHaveBeenCalledTimes(1);
      expect(target.metadata.deploy).toHaveBeenCalledTimes(2);
      const [zip, options] = target.metadata.deploy.mock.calls[1] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(zip).toBe('UEsDBBQ=');
      expect(options).toMatchObject({
        checkOnly: false,
        testLevel: 'RunSpecifiedTests',
        runTests: ['InvoicingTest'],
        rollbackOnError: true,
        purgeOnDelete: false,
      });
      expect(answer('compare:deploy:response')?.correlationId).toBe('req-deploy');
      expect(report('compare:deploy:response')).toMatchObject({
        deployId: '0Af000000000002',
        checkOnly: false,
        success: true,
      });
    });

    it('deploys a validation once', async () => {
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));
      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(target.metadata.deploy).toHaveBeenCalledTimes(2);
      expect(error()?.payload.code).toBe('NOT_VALIDATED');
    });

    it('refuses to deploy what it never validated', async () => {
      await handler.handle(deployRequest({ validationId: '0Af000000000009', targetOrgId: 'tgt' }));

      expect(target.metadata.deploy).not.toHaveBeenCalled();
      expect(error()?.payload).toMatchObject({ code: 'NOT_VALIDATED' });
      expect(String(error()?.payload.message)).toContain('Nothing was deployed');
    });

    it('refuses to deploy a validation that failed', async () => {
      connect(
        orgApi(),
        orgApi({
          deployResult: {
            status: 'Failed',
            success: false,
            details: {
              componentFailures: [
                {
                  componentType: 'ApexClass',
                  fullName: 'Invoicing',
                  success: false,
                  problem: 'Variable does not exist: total',
                  lineNumber: 12,
                  columnNumber: 5,
                },
              ],
            },
          },
        }),
      );
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload.code).toBe('NOT_VALIDATED');
    });

    it('refuses a validation run in another org than the one named', async () => {
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'elsewhere' }));

      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload.code).toBe('TARGET_MISMATCH');
    });

    it('asks the Production Guard again, with the target as it stands now', async () => {
      const validationId = await validated();
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType: 'Production',
      });

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload.code).toBe('GUARD_BLOCKED');
    });

    it('records the deployment in the audit log of the guard the extension wired', async () => {
      const guard = new ProductionGuard();
      deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(guard.getAuditLog().map((entry) => entry.request)).toEqual([
        {
          orgId: 'tgt',
          orgTier: 'development',
          operation: 'deploy',
          objectName: 'ApexClass, Layout',
          recordCount: 2,
          module: 'compare',
        },
      ]);
    });

    it('deploys nothing when the confirmation the guard asks for is declined', async () => {
      const guard = {
        check: vi.fn(() => ({
          allowed: true,
          requiresConfirmation: true,
          requiresApproval: false,
          warnings: [],
          impactSummary: 'DEPLOY 2 component(s)',
        })),
        logOperation: vi.fn(),
        confirmIfNeeded: vi.fn(() => Promise.resolve(false)),
      };
      deps.infraServices = { productionGuard: guard } as unknown as HandlerDeps['infraServices'];
      const validationId = await validated();

      await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload).toMatchObject({ code: 'GUARD_DECLINED', retryable: true });
    });

    describe('in the audit trail', () => {
      /** A window store the trail is written to, as the extension wires it. */
      function trail(): ConfigStore {
        const store = new ConfigStore(new InMemoryConfigStoreBackend());
        store.initialize();
        deps.configStore = store;
        return store;
      }

      it('records a deployment once: its outcome, the decision and what it did per type', async () => {
        const store = trail();
        const validationId = await validated();
        // A validation writes nothing, and records nothing.
        expect(new AuditTrailStore(store).list().entries).toEqual([]);

        await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

        const { entries } = new AuditTrailStore(store).list();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          action: 'metadata_deploy',
          module: 'compare',
          operationId: 'req-deploy',
          orgId: 'tgt',
          sourceOrgId: 'src',
          outcome: 'success',
          guard: 'allowed',
        });
        expect(entries[0].objects).toEqual(
          expect.arrayContaining([
            { objectApiName: 'ApexClass', created: 0, updated: 1, deleted: 0, failed: 0 },
            { objectApiName: 'Layout', created: 1, updated: 0, deleted: 0, failed: 0 },
          ]),
        );
      });

      it('records a deployment the guard stopped, with the decision that stopped it', async () => {
        const store = trail();
        const validationId = await validated();
        (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
          orgType: 'Production',
        });

        await handler.handle(deployRequest({ validationId, targetOrgId: 'tgt' }));

        expect(new AuditTrailStore(store).list().entries).toEqual([
          expect.objectContaining({
            action: 'metadata_deploy',
            outcome: 'stopped',
            guard: 'refused',
          }),
        ]);
      });
    });

    it('refuses a request that describes what to deploy instead of naming a validation', async () => {
      const validationId = await validated();

      await handler.handle(
        deployRequest({ validationId, targetOrgId: 'tgt', components: COMPONENTS }),
      );

      expect(target.metadata.deploy).toHaveBeenCalledTimes(1);
      expect(error()?.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
