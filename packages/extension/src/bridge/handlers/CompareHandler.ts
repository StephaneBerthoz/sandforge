import type {
  AuditObjectCounts,
  CompareConfig,
  CompareResult,
  GuardDecision,
  MetadataComponentType,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import type { DeploymentComponentRef, DeploymentReport, DeployTestLevel } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendOperationProgress } from './HandlerTypes.js';
import {
  validatePayload,
  compareDeployPayloadSchema,
  compareExecutePayloadSchema,
  compareOrgsPayloadSchema,
  compareValidateDeploymentPayloadSchema,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryAll } from '../../core/common/soqlQueryHelper.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { DeployProgress, Waiting } from '../../modules/compare/MetadataDeployer.js';

/**
 * The types listMetadata answers only folder by folder, each with the type
 * that lists its folders (the unfiled folder among them). Asked without a
 * folder it answers with nothing: run against two sandboxes holding 191
 * reports, 17 dashboards and 80 email templates each, the diff listed none of
 * them and so found no difference in any.
 */
const FOLDER_TYPES: Partial<Record<string, string>> = {
  Report: 'ReportFolder',
  Dashboard: 'DashboardFolder',
  EmailTemplate: 'EmailTemplateFolder',
};

/** Message types handled by CompareHandler. */
const COMPARE_TYPES = new Set([
  'compare:execute',
  'compare:permissions',
  'compare:snapshots',
  'compare:drift',
  'compare:validate-deployment',
  'compare:deploy',
]);

/** Validations a window keeps for a deployment: the last few, oldest dropped first. */
const VALIDATIONS_KEPT = 5;

/** A validation that succeeded, and the package it validated. */
interface Validation {
  sourceOrgId: string;
  targetOrgId: string;
  /** The package as the source returned it, byte for byte what the target checked. */
  zipFile: string;
  components: DeploymentComponentRef[];
  testLevel: DeployTestLevel;
  runTests: string[];
}

/** What {@link CompareHandler} can be given besides its deps. */
export interface CompareHandlerOptions {
  /** How deployments are waited on; a test passes its own clock. */
  waiting?: Waiting;
}

/**
 * What a finished deployment did, per component type, in the audit trail's
 * columns: what the org created, what it changed, what it refused. A
 * component left unchanged or never retrieved wrote nothing and is not
 * counted.
 */
function deployedComponentCounts(report: DeploymentReport): AuditObjectCounts[] {
  const byType = new Map<string, AuditObjectCounts>();
  for (const component of report.components) {
    const counts = byType.get(component.componentType) ?? {
      objectApiName: component.componentType,
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
    };
    if (component.outcome === 'created') counts.created += 1;
    else if (component.outcome === 'changed') counts.updated += 1;
    else if (component.outcome === 'failed') counts.failed += 1;
    else continue;
    byType.set(component.componentType, counts);
  }
  return [...byType.values()];
}

/**
 * Domain handler for compare-related webview-to-extension messages.
 *
 * Routes compare:* message types: the metadata diff, permission set and
 * profile presence, the object snapshot and five Organization settings,
 * between two Salesforce orgs, and the deployment of what differs, validated
 * first.
 */
export class CompareHandler implements DomainHandler {
  /**
   * Successful validations by deployment id. A deployment deploys one of
   * these, never a package a page describes, and each at most once.
   */
  private readonly validations = new Map<string, Validation>();

  /**
   * @param deps - Injected handler dependencies.
   * @param options - How deployments are waited on.
   */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly options: CompareHandlerOptions = {},
  ) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!COMPARE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'compare:execute':
        await this.handleCompareStart(msg);
        return true;
      case 'compare:permissions':
        await this.handlePermissions(msg);
        return true;
      case 'compare:snapshots':
        await this.handleSnapshots(msg);
        return true;
      case 'compare:drift':
        await this.handleDrift(msg);
        return true;
      case 'compare:validate-deployment':
        await this.handleValidateDeployment(msg);
        return true;
      case 'compare:deploy':
        await this.handleDeploy(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Handle compare:validate-deployment -- retrieve components from the source
   * and deploy them to the target check-only.
   *
   * The target compiles everything and runs the tests asked for, then keeps
   * nothing: a validation writes nothing, so it asks no confirmation. It goes
   * through the Production Guard all the same, which refuses a production
   * target before the source is asked for anything: a deployment it would
   * refuse is not worth validating. A validation that succeeds is kept, and
   * only a kept validation can be deployed.
   */
  private async handleValidateDeployment(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = validatePayload(
      compareValidateDeploymentPayloadSchema,
      msg,
      'compare:error',
      this.deps,
    );
    if (!payload) return;
    const runTests = payload.testLevel === 'RunSpecifiedTests' ? (payload.runTests ?? []) : [];

    try {
      if (!(await this.passGuard(msg, payload.targetOrgId, payload.components, true))) return;

      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const deployer = await import('../../modules/compare/MetadataDeployer.js');
      const waiting = this.options.waiting ?? deployer.DEFAULT_WAITING;
      const onProgress = this.progressTo(msg);

      const retrieved = await deployer.retrieveComponents(
        deployer.metadataApiOf(sourceConn),
        sourceConn.version,
        payload.components,
        { waiting, onProgress },
      );
      if (retrieved.managed.length > 0) {
        // Compare marks what a package installed; this is the source saying
        // so of what it just packed, in case the comparison could not.
        sendHandlerError(
          this.deps,
          'compare:validate-deployment',
          'compare:error',
          msg,
          new Error(
            'A managed package installed ' +
              retrieved.managed.map((c) => `${c.componentType} ${c.fullName}`).join(', ') +
              ' in the source, and it owns them: untick them and validate again. Nothing was sent to the target.',
          ),
          { code: 'MANAGED' },
        );
        return;
      }

      const status =
        retrieved.retrieved.length > 0
          ? await deployer.deployPackage(
              deployer.metadataApiOf(targetConn),
              retrieved.zipFile,
              deployer.deployOptions(true, payload.testLevel, runTests),
              { waiting, onProgress },
            )
          : undefined;
      const report = deployer.deploymentReport(status, retrieved, {
        sourceOrgId: payload.sourceOrgId,
        targetOrgId: payload.targetOrgId,
        checkOnly: true,
        testLevel: payload.testLevel,
        runTests,
      });
      if (report.success && report.deployId) {
        this.keepValidation(report.deployId, {
          sourceOrgId: payload.sourceOrgId,
          targetOrgId: payload.targetOrgId,
          zipFile: retrieved.zipFile,
          components: retrieved.retrieved,
          testLevel: payload.testLevel,
          runTests,
        });
      }
      this.post(
        buildResponse(this.deps, msg, 'compare:validate-deployment:response', { report }),
        report,
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:validate-deployment', 'compare:error', msg, err, {
        code: await this.deployErrorCode(err),
      });
    }
  }

  /**
   * Handle compare:deploy -- deploy what a validation of this window
   * validated, to the org it validated it in.
   *
   * The page names the validation and nothing else: the package deployed is
   * the one the target checked, with the tests it ran, never one rebuilt from
   * what the page describes. A validation is deployed at most once. The
   * Production Guard is asked again, with the target's type as it stands now,
   * and asks for the confirmation it requires.
   */
  private async handleDeploy(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = validatePayload(compareDeployPayloadSchema, msg, 'compare:error', this.deps);
    if (!payload) return;

    const validation = this.validations.get(payload.validationId);
    if (!validation) {
      sendHandlerError(
        this.deps,
        'compare:deploy',
        'compare:error',
        msg,
        new Error(
          `No successful validation ${payload.validationId} is waiting in this window: ` +
            'validate the deployment, then deploy it. Nothing was deployed.',
        ),
        { code: 'NOT_VALIDATED' },
      );
      return;
    }
    if (validation.targetOrgId !== payload.targetOrgId) {
      sendHandlerError(
        this.deps,
        'compare:deploy',
        'compare:error',
        msg,
        new Error(
          `Validation ${payload.validationId} was run in another org than the one named. Nothing was deployed.`,
        ),
        { code: 'TARGET_MISMATCH' },
      );
      return;
    }

    let decision: GuardDecision | undefined;
    try {
      decision = await this.passGuard(msg, validation.targetOrgId, validation.components, false);
      if (!decision) return;
      this.validations.delete(payload.validationId);

      const targetConn = await getJsforceConnection(
        validation.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const deployer = await import('../../modules/compare/MetadataDeployer.js');
      const status = await deployer.deployPackage(
        deployer.metadataApiOf(targetConn),
        validation.zipFile,
        deployer.deployOptions(false, validation.testLevel, validation.runTests),
        {
          waiting: this.options.waiting ?? deployer.DEFAULT_WAITING,
          onProgress: this.progressTo(msg),
        },
      );
      const report = deployer.deploymentReport(
        status,
        { missing: [], problems: [] },
        {
          sourceOrgId: validation.sourceOrgId,
          targetOrgId: validation.targetOrgId,
          checkOnly: false,
          testLevel: validation.testLevel,
          runTests: validation.runTests,
        },
      );
      // A deployment is all or nothing: the org rolls back a failed one.
      recordWriteRun(this.deps, {
        action: 'metadata_deploy',
        module: 'compare',
        operationId: msg.id,
        orgId: validation.targetOrgId,
        outcome: report.success ? 'success' : 'failure',
        guard: decision,
        objects: deployedComponentCounts(report),
        source: { origin: 'org', orgId: validation.sourceOrgId },
      });
      this.post(buildResponse(this.deps, msg, 'compare:deploy:response', { report }), report);
    } catch (err: unknown) {
      if (decision) {
        recordWriteRun(this.deps, {
          action: 'metadata_deploy',
          module: 'compare',
          operationId: msg.id,
          orgId: validation.targetOrgId,
          outcome: 'failure',
          guard: decision,
        });
      }
      sendHandlerError(this.deps, 'compare:deploy', 'compare:error', msg, err, {
        code: await this.deployErrorCode(err),
      });
    }
  }

  /**
   * Put a deployment to the Production Guard: the guard wired into the
   * extension, or one of its own for a host that wires none, so that its
   * policy holds whatever runs the handler. A production target is refused,
   * and an org whose type SandForge does not know counts as production.
   *
   * A validation writes nothing: it is only checked. A deployment is put to
   * the guard as every write path is, and a deployment the guard stopped is
   * recorded in the audit trail with the decision that stopped it.
   *
   * @returns The guard's decision when the deployment may go on, or
   *   `undefined` when it may not — the refusal has then been sent.
   */
  private async passGuard(
    msg: InboundRequest,
    targetOrgId: string,
    components: readonly DeploymentComponentRef[],
    checkOnly: boolean,
  ): Promise<GuardDecision | undefined> {
    const guard = this.deps.infraServices?.productionGuard ?? new ProductionGuard();
    const targetOrg = this.deps.orgManager.getOrg(targetOrgId);
    const request: OperationRequest = {
      orgId: targetOrgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation: 'deploy',
      objectName: [...new Set(components.map((c) => c.componentType))].join(', '),
      recordCount: components.length,
      module: 'compare',
    };
    if (checkOnly) {
      const check = guard.check(request);
      if (check.allowed) return 'allowed';
      this.refuse(msg, check.blockedReason ?? check.impactSummary);
      return undefined;
    }
    const { check, decision } = await consultProductionGuard(guard, request);
    if (decision === 'refused' || decision === 'declined') {
      recordWriteRun(this.deps, {
        action: 'metadata_deploy',
        module: 'compare',
        operationId: msg.id,
        orgId: targetOrgId,
        outcome: 'stopped',
        guard: decision,
      });
    }
    if (decision === 'refused') {
      this.refuse(msg, check.blockedReason ?? check.impactSummary);
      return undefined;
    }
    if (decision === 'declined') {
      sendHandlerError(
        this.deps,
        msg.type,
        'compare:error',
        msg,
        new Error('Operation cancelled by user (deployment confirmation declined).'),
        { code: 'GUARD_DECLINED', retryable: true },
      );
      return undefined;
    }
    return decision;
  }

  /** Answer a request the guard blocked. */
  private refuse(msg: InboundRequest, reason: string): void {
    sendHandlerError(
      this.deps,
      msg.type,
      'compare:error',
      msg,
      new Error(`Operation blocked by Production Guard: ${reason}`),
      { code: 'GUARD_BLOCKED' },
    );
  }

  /** Keep a validation for its deployment, dropping the oldest past the few kept. */
  private keepValidation(deployId: string, validation: Validation): void {
    this.validations.set(deployId, validation);
    while (this.validations.size > VALIDATIONS_KEPT) {
      const oldest = this.validations.keys().next().value;
      if (oldest === undefined) break;
      this.validations.delete(oldest);
    }
  }

  /**
   * Where a run stands, on `operation:progress` under the request's id: the
   * page that sent the request reads its own run and no other.
   */
  private progressTo(msg: InboundRequest): (progress: DeployProgress) => void {
    return (progress) =>
      sendOperationProgress(
        this.deps,
        msg.id,
        progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0,
        progress.done,
        progress.total,
        progress.step,
      );
  }

  /** Post the answer that carries a deployment report. */
  private post(response: ReturnType<typeof buildResponse>, report: DeploymentReport): void {
    this.deps.broker.postToWebview(response);
    this.deps.log(
      `[TX] ${response.type} id=${response.id} deploy=${report.deployId ?? '-'} status=${report.status}`,
    );
  }

  /** The code a failed deployment request answers with. */
  private async deployErrorCode(err: unknown): Promise<string> {
    const { DeploymentStillRunning } = await import('../../modules/compare/MetadataDeployer.js');
    return err instanceof DeploymentStillRunning ? 'STILL_RUNNING' : 'DEPLOY_ERROR';
  }

  private async handleCompareStart(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareExecutePayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const result = await this.compareOrgs(payload);

      const response = buildResponse(
        this.deps,
        msg,
        'compare:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:execute', 'compare:error', msg, err);
    }
  }

  /**
   * The metadata comparison the Compare page's Run and a pipeline's Compare
   * step share: list each type on both orgs, read what both hold, diff it —
   * the same listing, the same content read, the same bound. Both orgs are
   * only read.
   *
   * @param payload - The two orgs and the component types to compare.
   * @param signal - Stops the comparison: once it is aborted no request goes
   *   to either org, and the comparison settles at once with its reason, not
   *   with a result. A pipeline's Compare step passes its own.
   * @returns The comparison, every diff included.
   * @throws With the reason, when the orgs could not be compared.
   */
  async compareOrgs(
    payload: {
      sourceOrgId: string;
      targetOrgId: string;
      types: string[];
      includeManaged?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<CompareResult> {
    signal?.throwIfAborted();
    const sourceConn = await getJsforceConnection(
      payload.sourceOrgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );
    signal?.throwIfAborted();
    const targetConn = await getJsforceConnection(
      payload.targetOrgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    );

    const { DiffEngine } = await import('../../modules/compare/DiffEngine.js');
    const { MetadataCompare } = await import('../../modules/compare/MetadataCompare.js');
    const { createContentReader } = await import('../../modules/compare/ContentReader.js');

    const diffEngine = new DiffEngine();

    const fetchMetadata = async (orgId: string, componentType: MetadataComponentType) => {
      const conn = orgId === payload.sourceOrgId ? sourceConn : targetConn;
      const components = new Map<string, string>();
      const list = async (queries: Array<{ type: string; folder?: string }>) => {
        // A folder-filed type takes a call per three folders: each is one more
        // request, and none goes out once the comparison is stopped.
        signal?.throwIfAborted();
        const listResult = (await conn.metadata.list(queries)) as Array<{ fullName: string }>;
        checkApiLimits(conn.limitInfo, `compare:metadata list ${String(componentType)}`);
        return Array.isArray(listResult) ? listResult : [];
      };
      const folderType = FOLDER_TYPES[componentType];
      const queries = folderType
        ? (await list([{ type: folderType }])).map((f) => ({
            type: componentType,
            folder: f.fullName,
          }))
        : [{ type: componentType }];
      // listMetadata takes three queries per call.
      for (let i = 0; i < queries.length; i += 3) {
        for (const item of await list(queries.slice(i, i + 3))) {
          components.set(item.fullName, JSON.stringify(item));
        }
      }
      return components;
    };

    // What each org holds of a component both list: the listing alone
    // differs between any two orgs, whatever the component says.
    const contentReader = createContentReader(
      (orgId) => (orgId === payload.sourceOrgId ? sourceConn : targetConn),
      signal,
    );
    const metadataCompare = new MetadataCompare(fetchMetadata, diffEngine, contentReader);

    if (!this.deps.services) {
      throw new Error(
        'CompareHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
      );
    }
    const orchestrator = this.deps.services.compareOrchestrator({
      metadataCompare,
      diffEngine,
      services: this.deps.services,
    });

    const config: CompareConfig = {
      id: crypto.randomUUID(),
      name: 'compare-from-ui',
      sourceOrgId: payload.sourceOrgId,
      targetOrgId: payload.targetOrgId,
      mode: 'metadata',
      componentTypes: payload.types as MetadataComponentType[],
      // Compared unless the caller says otherwise: this was `false` and read by
      // nothing, so every run compared them all the same.
      includeManaged: payload.includeManaged ?? true,
      createdAt: new Date().toISOString(),
    };

    return orchestrator.execute(config, signal);
  }

  /**
   * Handle compare:permissions -- query permission sets and profiles from both orgs,
   * compare field-level and object-level permissions, and return a diff.
   */
  private async handlePermissions(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Every row of both orgs, as queryAll pages through them. A LIMIT with no
      // ORDER BY hands back a different slice of each org: run against two
      // sandboxes holding 283 and 282 permission sets, a hundred of each came
      // back and the tab listed 9 and 9 on one side only, where the orgs
      // differ by 3 and 2.
      const fetchPermissions = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
        // Not the ones profiles own: each is named after its profile's Id in
        // that org (X00e…), so the same profile goes by two names across two
        // orgs. The profiles are compared by name below.
        const permSets = await queryAll<{
          Id: string;
          Name: string;
          Label: string;
          IsOwnedByProfile: boolean;
        }>(
          conn,
          'SELECT Id, Name, Label, IsOwnedByProfile FROM PermissionSet WHERE IsOwnedByProfile = false',
        );
        checkApiLimits(conn.limitInfo, `compare:permissions ${label}`);

        const profiles = await queryAll<{ Id: string; Name: string }>(
          conn,
          'SELECT Id, Name FROM Profile',
        );
        checkApiLimits(conn.limitInfo, `compare:permissions profiles ${label}`);

        return { permSets, profiles };
      };

      const [sourcePerms, targetPerms] = await Promise.all([
        fetchPermissions(sourceConn, 'source'),
        fetchPermissions(targetConn, 'target'),
      ]);

      const sourcePermNames = new Set(sourcePerms.permSets.map((p) => p.Name));
      const targetPermNames = new Set(targetPerms.permSets.map((p) => p.Name));
      const sourceProfileNames = new Set(sourcePerms.profiles.map((p) => p.Name));
      const targetProfileNames = new Set(targetPerms.profiles.map((p) => p.Name));

      const permissionDiffs = {
        permissionSets: {
          sourceOnly: sourcePerms.permSets
            .filter((p) => !targetPermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
          targetOnly: targetPerms.permSets
            .filter((p) => !sourcePermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
          shared: sourcePerms.permSets
            .filter((p) => targetPermNames.has(p.Name))
            .map((p) => ({ name: p.Name, label: p.Label })),
        },
        profiles: {
          sourceOnly: sourcePerms.profiles
            .filter((p) => !targetProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
          targetOnly: targetPerms.profiles
            .filter((p) => !sourceProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
          shared: sourcePerms.profiles
            .filter((p) => targetProfileNames.has(p.Name))
            .map((p) => ({ name: p.Name })),
        },
      };

      const response = buildResponse(this.deps, msg, 'compare:permissions:response', {
        permissions: permissionDiffs,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:permissions', 'compare:error', msg, err);
    }
  }

  /**
   * Handle compare:snapshots -- capture org metadata snapshots via describeGlobal
   * and compare object counts, custom objects, and fields between orgs.
   */
  private async handleSnapshots(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const describeOrg = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
        const globalDescribe = await conn.describeGlobal();
        checkApiLimits(conn.limitInfo, `compare:snapshots describeGlobal ${label}`);

        const allObjects = globalDescribe.sobjects.map(
          (s: { name: string; custom: boolean; label: string; queryable: boolean }) => ({
            name: s.name,
            custom: s.custom,
            label: s.label,
            queryable: s.queryable,
          }),
        );

        return {
          totalObjects: allObjects.length,
          customObjects: allObjects.filter((o) => o.custom).length,
          standardObjects: allObjects.filter((o) => !o.custom).length,
          queryableObjects: allObjects.filter((o) => o.queryable).length,
          objects: allObjects,
        };
      };

      const [sourceSnapshot, targetSnapshot] = await Promise.all([
        describeOrg(sourceConn, 'source'),
        describeOrg(targetConn, 'target'),
      ]);

      const sourceObjectNames = new Set(sourceSnapshot.objects.map((o) => o.name));
      const targetObjectNames = new Set(targetSnapshot.objects.map((o) => o.name));

      const snapshot = {
        source: {
          orgId: payload.sourceOrgId,
          totalObjects: sourceSnapshot.totalObjects,
          customObjects: sourceSnapshot.customObjects,
          standardObjects: sourceSnapshot.standardObjects,
          queryableObjects: sourceSnapshot.queryableObjects,
        },
        target: {
          orgId: payload.targetOrgId,
          totalObjects: targetSnapshot.totalObjects,
          customObjects: targetSnapshot.customObjects,
          standardObjects: targetSnapshot.standardObjects,
          queryableObjects: targetSnapshot.queryableObjects,
        },
        diff: {
          sourceOnly: sourceSnapshot.objects
            .filter((o) => !targetObjectNames.has(o.name))
            .map((o) => o.name),
          targetOnly: targetSnapshot.objects
            .filter((o) => !sourceObjectNames.has(o.name))
            .map((o) => o.name),
          sharedCount: sourceSnapshot.objects.filter((o) => targetObjectNames.has(o.name)).length,
        },
        capturedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:snapshots:response', { snapshot });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:snapshots', 'compare:error', msg, err);
    }
  }

  /**
   * Handle compare:drift -- compare the five Organization fields below on both
   * orgs, on request. No metadata is read: the one query is
   * `SELECT Name, LanguageLocaleKey, DefaultLocaleSidKey, TimeZoneSidKey,
   * FiscalYearStartMonth FROM Organization`.
   */
  private async handleDrift(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(compareOrgsPayloadSchema, msg, 'compare:error', this.deps);
    if (!parsed) return;
    const payload = parsed;

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const fetchOrgSettings = async (
        conn: Awaited<ReturnType<typeof getJsforceConnection>>,
        label: string,
      ) => {
        const settings: Record<string, string> = {};

        const companyInfo = await queryAll<Record<string, string>>(
          conn,
          'SELECT Name, LanguageLocaleKey, DefaultLocaleSidKey, TimeZoneSidKey, FiscalYearStartMonth FROM Organization LIMIT 1',
        );
        checkApiLimits(conn.limitInfo, `compare:drift companyInfo ${label}`);
        if (companyInfo[0]) {
          for (const [key, value] of Object.entries(companyInfo[0])) {
            if (key !== 'attributes' && key !== 'Id') {
              settings[`Organization.${key}`] = String(value);
            }
          }
        }

        return settings;
      };

      const [sourceSettings, targetSettings] = await Promise.all([
        fetchOrgSettings(sourceConn, 'source'),
        fetchOrgSettings(targetConn, 'target'),
      ]);

      const allKeys = new Set([...Object.keys(sourceSettings), ...Object.keys(targetSettings)]);
      const driftItems: Array<{
        setting: string;
        sourceValue: string;
        targetValue: string;
        status: 'match' | 'drift' | 'missing_source' | 'missing_target';
      }> = [];

      for (const key of allKeys) {
        const sourceVal = sourceSettings[key];
        const targetVal = targetSettings[key];

        if (sourceVal === undefined) {
          driftItems.push({
            setting: key,
            sourceValue: '',
            targetValue: targetVal ?? '',
            status: 'missing_source',
          });
        } else if (targetVal === undefined) {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: '',
            status: 'missing_target',
          });
        } else if (sourceVal !== targetVal) {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: targetVal,
            status: 'drift',
          });
        } else {
          driftItems.push({
            setting: key,
            sourceValue: sourceVal,
            targetValue: targetVal,
            status: 'match',
          });
        }
      }

      const drift = {
        items: driftItems,
        totalChecked: driftItems.length,
        driftCount: driftItems.filter((d) => d.status === 'drift').length,
        matchCount: driftItems.filter((d) => d.status === 'match').length,
        missingCount: driftItems.filter(
          (d) => d.status === 'missing_source' || d.status === 'missing_target',
        ).length,
        detectedAt: new Date().toISOString(),
      };

      const response = buildResponse(this.deps, msg, 'compare:drift:response', { drift });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'compare:drift', 'compare:error', msg, err);
    }
  }
}
