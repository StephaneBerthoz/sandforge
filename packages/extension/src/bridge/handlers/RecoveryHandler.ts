import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { Connection } from 'jsforce';
import {
  guardTierOf,
  isDevelopmentOrg,
  orgDisplayName,
  recoveryAckPayloadSchema,
  recoveryAcksSchema,
  recoveryAuditPayloadSchema,
  recoveryOrgPayloadSchema,
  recoveryUsersConfigPayloadSchema,
  recoveryUsersRunPayloadSchema,
  usersConfigSchema,
  usersWithDefaults,
  type AuditOutcome,
  type EnvAuditResult,
  type GuardDecision,
  type RecoveryErrorCode,
  type RecoveryStatus,
  type RecoveryStepId,
  type RecoveryUsersRunPayload,
  type SalesforceOrg,
  type UsersApplyAnswer,
  type UsersPlanAnswer,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import {
  consultProductionGuard,
  strongerDecision,
} from '../../core/precheck/consultProductionGuard.js';
import { recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { OrgCheckpointStore } from '../../modules/checkpoint/OrgCheckpointStore.js';
import type { ReplayStore } from '../../modules/checkpoint/replay/replayStore.js';
import type { RecoveryCount } from '../../modules/recovery/recoveryProgress.js';
import type { UsersGatedPlan } from '../../modules/users/usersGates.js';
import type { UsersOrg } from '../../modules/users/usersOrg.js';
import type { UsersOrgSummary, UsersRefusal } from '../../modules/users/usersPlan.js';
import type { UsersRunStore } from '../../modules/users/usersRunStore.js';
import { validatePayload } from '../validatePayload.js';
import {
  PRODUCTION_GUARD_MISSING,
  buildResponse,
  sendHandlerError,
  type DomainHandler,
  type HandlerDeps,
  type InboundRequest,
} from './HandlerTypes.js';

/** The modules the page's requests run through, loaded on the first request, off the activation path. */
async function loadRecoveryModules() {
  const [
    facts,
    status,
    users,
    handoff,
    gates,
    apply,
    runStore,
    audits,
    host,
    checkpoints,
    replays,
  ] = await Promise.all([
    import('../../modules/recovery/recoveryFacts.js'),
    import('../../modules/recovery/recoveryStatus.js'),
    import('../../modules/recovery/recoveryUsers.js'),
    import('../../modules/recovery/recoveryHandoff.js'),
    import('../../modules/users/usersGates.js'),
    import('../../modules/users/usersApply.js'),
    import('../../modules/users/usersRunStore.js'),
    import('../../modules/audit/readAudits.js'),
    import('../../modules/audit/orgHost.js'),
    import('../../modules/checkpoint/OrgCheckpointStore.js'),
    import('../../modules/checkpoint/replay/replayStore.js'),
  ]);
  return {
    recoveryFactsOf: facts.recoveryFactsOf,
    recoveryAckKeyOf: facts.recoveryAckKeyOf,
    readAcks: facts.readAcks,
    frozenDatasetDirOf: facts.frozenDatasetDirOf,
    recoveryStatusOf: status.recoveryStatusOf,
    awaitingAddressesOf: users.awaitingAddressesOf,
    recoveryUsersOf: users.recoveryUsersOf,
    recoveryTestersKey: users.recoveryTestersKey,
    readSavedTesters: users.readSavedTesters,
    saveTesters: users.saveTesters,
    replacedRunOf: users.replacedRunOf,
    choicesKeyOf: users.choicesKeyOf,
    planSignatureOf: users.planSignatureOf,
    changingUsersOf: users.changingUsersOf,
    usersDoneOf: users.usersDoneOf,
    usersAuditObjectsOf: users.usersAuditObjectsOf,
    ObservedUsersRunStore: users.ObservedUsersRunStore,
    journalDirOf: handoff.journalDirOf,
    newestHandoffOf: handoff.newestHandoffOf,
    recoveryHandoffNoteOf: handoff.recoveryHandoffNoteOf,
    recoveryHandoffPathOf: handoff.recoveryHandoffPathOf,
    writeRecoveryHandoff: handoff.writeRecoveryHandoff,
    guardUsersOrg: gates.guardUsersOrg,
    usersToRestoreOf: gates.usersToRestoreOf,
    planUsersGated: gates.planUsersGated,
    gatedPlanAnswerOf: gates.gatedPlanAnswerOf,
    applyUsers: apply.applyUsers,
    UsersRunStore: runStore.UsersRunStore,
    defaultUsersStoreRoot: runStore.defaultUsersStoreRoot,
    readAudits: audits.readAudits,
    myDomainHostOf: host.myDomainHostOf,
    openCheckpointStore: checkpoints.openCheckpointStore,
    defaultCheckpointStoreRoot: checkpoints.defaultCheckpointStoreRoot,
    ReplayStore: replays.ReplayStore,
    defaultReplayStoreRoot: replays.defaultReplayStoreRoot,
  };
}

type RecoveryModules = Awaited<ReturnType<typeof loadRecoveryModules>>;

/** The requests of the Back into service page this handler answers. */
const RECOVERY_TYPES = new Set([
  'recovery:status',
  'recovery:users:list',
  'recovery:users:plan',
  'recovery:users:apply',
  'recovery:users:cancel',
  'recovery:users:config:save',
  'recovery:users:config:export',
  'recovery:users:config:import',
  'recovery:audit',
  'recovery:handoff',
  'recovery:handoff:open',
  'recovery:ack',
]);

/** A refusal or a failure, by the code the page translates, and the step it is of. */
class Refused extends Error {
  constructor(
    readonly code: RecoveryErrorCode,
    message: string,
    readonly retryable = false,
    readonly step?: RecoveryStepId,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

/**
 * Where a `users.json` is saved, and which one is read: what the person
 * picks in the window's own dialogs. The page never names a path.
 */
export interface RecoveryFileDialogs {
  /** Ask where to save the testers, `suggestedName` filled in: the path picked, or undefined when closed. */
  pickUsersExport(suggestedName: string): Promise<string | undefined>;
  /** Ask which `users.json` to read: the path picked, or undefined when closed. */
  pickUsersImport(): Promise<string | undefined>;
}

/** Opens a file in an editor of the window. */
export type OpenInEditor = (filePath: string) => Promise<void>;

/** What a page's file is read and written on: this machine's disk alone. */
const NOT_ON_DISK =
  'SandForge writes and reads a users.json on the disk of the machine it runs on: pick a folder there.';

/** The window's own dialogs, the VS Code API fetched on first use as the other adapters do. */
const vsCodeDialogs: RecoveryFileDialogs = {
  async pickUsersExport(suggestedName) {
    const vscode = await import('vscode');
    const uri = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export the testers list as users.json'),
      saveLabel: vscode.l10n.t('Export'),
      // The home folder, never a workspace's: a list of usernames committed
      // with a project goes wherever the project goes.
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), suggestedName),
      filters: { JSON: ['json'] },
    });
    if (uri === undefined) return undefined;
    if (uri.scheme !== 'file') throw new Refused('INVALID_PAYLOAD', NOT_ON_DISK);
    return uri.fsPath;
  },
  async pickUsersImport() {
    const vscode = await import('vscode');
    const picked = await vscode.window.showOpenDialog({
      title: vscode.l10n.t('Import the testers list from a users.json'),
      openLabel: vscode.l10n.t('Import'),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    const uri = picked?.[0];
    if (uri === undefined) return undefined;
    if (uri.scheme !== 'file') throw new Refused('INVALID_PAYLOAD', NOT_ON_DISK);
    return uri.fsPath;
  },
};

/** The window's own editor. */
const openInVsCodeEditor: OpenInEditor = async (filePath) => {
  const vscode = await import('vscode');
  await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
};

/** What the handler is built with beside the shared deps: what a test or a command line names. */
export interface RecoveryHandlerOptions {
  dialogs?: RecoveryFileDialogs;
  openInEditor?: OpenInEditor;
  /** The command lines' folder: the inventories and the handoff notes. */
  journalDir?: string;
  usersStore?: UsersRunStore;
  replayStore?: Pick<ReplayStore, 'list'>;
  checkpointStore?: OrgCheckpointStore;
  /** This SandForge's version, which a handoff note names. */
  sandforgeVersion?: string;
  now?: () => Date;
}

/** The org reached, typed live and not a production org: what every request that reads it holds. */
interface Reached {
  registered: SalesforceOrg;
  orgName: string;
  conn: Connection;
  org: UsersOrg;
  organization: UsersOrgSummary;
  typingRequests: number;
}

/** A refused plan's answer, nothing read past the refusal: a run it replaces not kept, or replaced already. */
function refusedPlanOf(
  organization: UsersOrgSummary,
  refusal: UsersRefusal,
  sent: number,
): UsersPlanAnswer {
  return {
    org: organization,
    users: [],
    emailsToPeople: 0,
    apiRequests: sent,
    refusals: [refusal],
  };
}

/** The changes of a plan by what they write: users and logins updated, accesses added, accesses taken back. */
function writesOf(plan: UsersPlanAnswer): { updated: number; added: number; removed: number } {
  let updated = 0;
  let added = 0;
  let removed = 0;
  for (const user of plan.users) {
    if (user.changes.some((change) => !('name' in change))) updated += 1;
    for (const change of user.changes) {
      if (!('name' in change)) continue;
      if (change.to === 'added') added += 1;
      else removed += 1;
    }
  }
  return { updated, added, removed };
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string, b: string): boolean {
  return a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/** The most the page reads of an error. */
const MESSAGE_MAX = 4_000;

/**
 * The host of the Back into service page: where a sandbox stands after its
 * refresh, its users brought back, its audits read, what a person
 * acknowledges, and the handoff note.
 *
 * - `recovery:status` — each step deduced from what SandForge keeps on this
 *   machine (`modules/recovery/recoveryFacts.ts`), never from the org.
 * - `recovery:users:list` — the users of the sandbox to bring back. Like
 *   every request that reads the org, it is refused before anything is read
 *   for an org that is not a sandbox, a scratch org or a Developer Edition
 *   org: by the registry, then by what the org says it is, typed live
 *   (`guardUsersOrg`). Production Guard asks before an update in production
 *   and lets it through once answered: it is never what stops a production
 *   org here.
 * - `recovery:users:plan` and `recovery:users:apply` — the plan of
 *   `sandforge users`, behind its gates; the run follows a simulation of the
 *   same choices, the plan read again and refused when the org changed
 *   since, Production Guard asked, its progress said user by user, stopped
 *   by `recovery:users:cancel`. The acceptances come with each request and
 *   are kept nowhere. Its runs are kept where the command line keeps them:
 *   `sandforge users remove` takes back what the page set up.
 * - `recovery:users:config:*` — the testers kept for the sandbox by its My
 *   Domain host, which a refresh keeps; written to and read from a
 *   `users.json` the person picks.
 * - `recovery:audit` — the deliverability, the jobs and the endpoints, read
 *   only, as `sandforge env audit` reads them; the inventory of the jobs
 *   kept when asked.
 * - `recovery:handoff` — the note, written beside the command line's and
 *   opened in the editor; `recovery:handoff:open` opens the newest again as
 *   it was left, unwritten, and refuses `NOTE_NOT_FOUND` when none is kept.
 * - `recovery:ack` — a step skipped, a check marked done, or the recovery
 *   finished or resumed, kept under the refresh's key.
 *
 * Each answer that changes a step is told to {@link onStatusChanged}, which
 * the launcher's progress listens to.
 */
export class RecoveryHandler implements DomainHandler {
  private loaded?: Promise<RecoveryModules>;
  private checkpoints?: Promise<OrgCheckpointStore>;
  private usersStore?: UsersRunStore;
  private replayStore?: Pick<ReplayStore, 'list'>;
  private readonly dialogs: RecoveryFileDialogs;
  private readonly openInEditor: OpenInEditor;
  private readonly now: () => Date;
  /** The run of the users under way on each org, its stop. */
  private readonly running = new Map<string, AbortController>();
  /** The last simulation answered on each org: its choices and what it said a run would do. */
  private readonly simulated = new Map<string, { choices: string; signature: string }>();
  /** How many users the last list read of each org found, of the org it was then. */
  private readonly listed = new Map<string, { organizationId: string; total: number }>();
  /** What the audits read of each org, of the org it was then, every part kept from its last read. */
  private readonly audited = new Map<
    string,
    {
      organizationId: string;
      audit: Pick<EnvAuditResult, 'deliverability' | 'schedules' | 'endpoints'>;
    }
  >();
  private readonly statusListeners = new Set<(entryId: string) => void>();

  constructor(
    private readonly deps: HandlerDeps,
    private readonly options: RecoveryHandlerOptions = {},
  ) {
    this.dialogs = options.dialogs ?? vsCodeDialogs;
    this.openInEditor = options.openInEditor ?? openInVsCodeEditor;
    this.now = options.now ?? (() => new Date());
    if (options.checkpointStore) this.checkpoints = Promise.resolve(options.checkpointStore);
    if (options.usersStore) this.usersStore = options.usersStore;
    if (options.replayStore) this.replayStore = options.replayStore;
  }

  /** Keep reading the checkpoints from `store`: the one a command line names. */
  setCheckpointStore(store: OrgCheckpointStore): void {
    this.checkpoints = Promise.resolve(store);
  }

  /** Be told each time a step of a sandbox may have changed. The returned function stops it. */
  onStatusChanged(listener: (entryId: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * How far a sandbox is back into service, n of N, its steps deduced from
   * this machine; undefined for an org not registered, or a production org.
   */
  async progressCountOf(entryId: string): Promise<RecoveryCount | undefined> {
    const m = await this.modules();
    const read = await m.recoveryFactsOf(this.factsDeps(m), entryId);
    if (!('facts' in read)) return undefined;
    const status = m.recoveryStatusOf(read.facts);
    return { done: status.done, total: status.total };
  }

  async handle(msg: InboundRequest): Promise<boolean> {
    if (!RECOVERY_TYPES.has(msg.type)) return false;
    switch (msg.type) {
      case 'recovery:status':
        await this.handleStatus(msg);
        return true;
      case 'recovery:users:list':
        await this.handleUsersList(msg);
        return true;
      case 'recovery:users:plan':
        await this.handleUsersPlan(msg);
        return true;
      case 'recovery:users:apply':
        await this.handleUsersApply(msg);
        return true;
      case 'recovery:users:cancel':
        this.handleUsersCancel(msg);
        return true;
      case 'recovery:users:config:save':
        await this.handleConfigSave(msg);
        return true;
      case 'recovery:users:config:export':
        await this.handleConfigExport(msg);
        return true;
      case 'recovery:users:config:import':
        await this.handleConfigImport(msg);
        return true;
      case 'recovery:audit':
        await this.handleAudit(msg);
        return true;
      case 'recovery:handoff':
        await this.handleHandoff(msg);
        return true;
      case 'recovery:handoff:open':
        await this.handleHandoffOpen(msg);
        return true;
      case 'recovery:ack':
        await this.handleAck(msg);
        return true;
      default:
        return false;
    }
  }

  // ─── Where the sandbox stands ──────────────────────────────────────────────

  private async handleStatus(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const status = await this.statusOf(parsed.orgId);
      this.respond(msg, 'recovery:status:response', { status });
    } catch (err: unknown) {
      this.fail(msg, err);
    }
  }

  private async handleAck(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryAckPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const registered = this.registered(parsed.orgId);
      const m = await this.modules();
      const detector = this.deps.sandboxRefreshes;
      const refresh =
        registered.orgType === 'Sandbox' ? detector?.refreshesOf(parsed.orgId)[0] : undefined;
      const key = m.recoveryAckKeyOf(parsed.orgId, refresh, (id) => detector?.organizationIdOf(id));
      const acks = m.readAcks(this.deps.configStore, key);
      if (parsed.what === 'finish') {
        acks.finishedAt = this.now().toISOString();
      } else if (parsed.what === 'resume') {
        // The launcher and Home lead with the sandbox again; its marks stay.
        delete acks.finishedAt;
      } else if (parsed.mark === 'cleared') {
        delete acks.steps[parsed.step];
      } else {
        acks.steps[parsed.step] = parsed.mark;
      }
      this.deps.configStore.set(key, recoveryAcksSchema.parse(acks), 'recovery');
      const status = await this.statusOf(parsed.orgId);
      this.respond(msg, 'recovery:ack:response', { status });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, err);
    }
  }

  // ─── The users ─────────────────────────────────────────────────────────────

  private async handleUsersList(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const m = await this.modules();
      const reached = await this.reach(m, parsed.orgId, 'users');
      const read = await m.usersToRestoreOf(reached.org);
      const runs = await this.users(m).list(reached.organization.organizationId);
      const users = m.recoveryUsersOf(read.users, m.awaitingAddressesOf(runs));
      this.listed.set(parsed.orgId, {
        organizationId: reached.organization.organizationId,
        total: read.total,
      });
      const saved = m.readSavedTesters(
        this.deps.configStore,
        m.recoveryTestersKey(m.myDomainHostOf(reached.registered.instanceUrl), parsed.orgId),
      );
      this.respond(msg, 'recovery:users:list:response', {
        orgId: parsed.orgId,
        users,
        total: read.total,
        ...(saved !== undefined ? { saved } : {}),
      });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, err, 'users');
    }
  }

  private async handleUsersPlan(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryUsersRunPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const m = await this.modules();
      const reached = await this.reach(m, parsed.orgId, 'users');
      const { answer } = await this.planOf(m, reached, parsed);
      this.simulated.set(parsed.orgId, {
        choices: m.choicesKeyOf(parsed),
        signature: m.planSignatureOf(answer),
      });
      this.respond(msg, 'recovery:users:plan:response', { orgId: parsed.orgId, plan: answer });
    } catch (err: unknown) {
      this.fail(msg, err, 'users');
    }
  }

  private async handleUsersApply(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryUsersRunPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    const { orgId } = parsed;
    if (this.running.has(orgId)) {
      this.fail(
        msg,
        new Refused(
          'FAILED',
          'A run of the users of this org is under way from this window: wait for it to end. ' +
            'Nothing was read or written.',
          true,
          'users',
        ),
      );
      return;
    }
    const stop = new AbortController();
    this.running.set(orgId, stop);
    try {
      const m = await this.modules();
      const simulated = this.simulated.get(orgId);
      if (simulated === undefined || simulated.choices !== m.choicesKeyOf(parsed)) {
        throw new Refused(
          'ORG_CHANGED',
          'No simulation of these choices was answered on this page: simulate them, then apply. ' +
            'Nothing was read or written.',
          false,
          'users',
        );
      }
      const reached = await this.reach(m, orgId, 'users');
      const { answer, gated } = await this.planOf(m, reached, parsed);
      if (m.planSignatureOf(answer) !== simulated.signature) {
        throw new Refused(
          'ORG_CHANGED',
          `${reached.orgName} changed since the simulation: a run now would not do what it showed. ` +
            'Simulate again. Nothing was written.',
          false,
          'users',
        );
      }
      const refusals = answer.refusals ?? [];
      if (gated === undefined || refusals.length > 0) {
        throw new Refused(
          'FAILED',
          `${refusals.map((refusal) => refusal.message).join(' ')} Nothing was written.`.trim(),
          false,
          'users',
        );
      }
      const decision = await this.consultGuard(msg, reached, answer);
      if (stop.signal.aborted) {
        this.recordUsersRun(msg, orgId, 'stopped', decision);
        throw new Refused('CANCELLED', 'Stopped before the first write: nothing was written.');
      }

      const total = m.changingUsersOf(answer);
      const progress = (done: number): void => {
        this.deps.broker.postToWebview(
          buildResponse(this.deps, msg, 'recovery:users:progress', { orgId, done, total }),
        );
      };
      progress(0);
      const store = new m.ObservedUsersRunStore({ root: this.users(m).root }, (record) =>
        progress(m.usersDoneOf(record, answer)),
      );
      let outcome: Awaited<ReturnType<RecoveryModules['applyUsers']>>;
      try {
        outcome = await m.applyUsers({
          org: reached.org,
          organization: reached.organization,
          users: usersWithDefaults(parsed.config),
          store,
          signal: stop.signal,
          ...gated.options,
        });
      } catch (err: unknown) {
        this.recordUsersRun(msg, orgId, 'failure', decision);
        throw err;
      }
      if (outcome.kind === 'refused') {
        this.recordUsersRun(msg, orgId, 'stopped', decision);
        throw new Refused(
          'ORG_CHANGED',
          `${reached.orgName} changed since the plan read it: ` +
            `${(outcome.plan.refusals ?? []).map((refusal) => refusal.message).join(' ')} ` +
            'Nothing was written.',
          false,
          'users',
        );
      }
      const applied: UsersApplyAnswer = {
        ...outcome.answer,
        apiRequests: reached.typingRequests + reached.org.requests() + gated.outsideRequests,
      };
      this.recordUsersRun(msg, orgId, applied.status, decision, applied, m);
      this.respond(msg, 'recovery:users:apply:response', { orgId, applied });
    } catch (err: unknown) {
      this.fail(msg, err, 'users');
    } finally {
      this.running.delete(orgId);
      // The org is not what the simulation read any more, whatever the run did.
      this.simulated.delete(orgId);
      this.changed(orgId);
    }
  }

  private handleUsersCancel(msg: InboundRequest): void {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    // Its run ends after the step under way, cancelled, on its own response.
    this.running.get(parsed.orgId)?.abort();
  }

  /**
   * The plan of the users the page chose, behind its gates, as `sandforge
   * users plan` answers it: the run it replaces read from the same store, the
   * deliverability read when an address is asked back, what the org runs on
   * the rows it writes. No gated plan when the run it replaces is refused.
   */
  private async planOf(
    m: RecoveryModules,
    reached: Reached,
    payload: RecoveryUsersRunPayload,
  ): Promise<{ answer: UsersPlanAnswer; gated?: UsersGatedPlan }> {
    const { org, organization } = reached;
    const sentSoFar = (more: number): number => reached.typingRequests + org.requests() + more;
    let previous;
    if (payload.replaces !== undefined) {
      const replaced = await m.replacedRunOf(
        this.users(m),
        organization.organizationId,
        payload.replaces,
      );
      if ('refusal' in replaced) {
        return { answer: refusedPlanOf(organization, replaced.refusal, sentSoFar(0)) };
      }
      previous = replaced.record;
    }
    const gated = await m.planUsersGated({
      conn: reached.conn,
      org,
      orgName: reached.orgName,
      users: usersWithDefaults(payload.config),
      ...(previous !== undefined ? { previous } : {}),
      acceptUserEmails: payload.acceptUserEmails,
      acceptEmails: payload.acceptEmails,
      acceptAutomation: payload.acceptAutomation,
      voice: 'page',
      now: this.now(),
    });
    // A run sends all this plan sent, then reads the users again before its
    // first write, then writes: what the answer says it sends.
    const answer = m.gatedPlanAnswerOf(gated, organization, sentSoFar(gated.outsideRequests));
    return { answer, gated };
  }

  /**
   * Consult Production Guard before the run, as every write path does
   * (`consultProductionGuard`): what the run takes back first, then the users
   * and logins it updates, then the accesses it adds. A production org never
   * reaches here; a sandbox marked Staging is asked before what is taken
   * back. A refusal or a no is recorded with the run, which wrote nothing.
   */
  private async consultGuard(
    msg: InboundRequest,
    reached: Reached,
    plan: UsersPlanAnswer,
  ): Promise<GuardDecision> {
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) throw new Refused('FAILED', PRODUCTION_GUARD_MISSING.message, false, 'users');
    const orgTier = guardTierOf(reached.registered);
    const { updated, added, removed } = writesOf(plan);
    const asked = [
      {
        operation: 'delete' as const,
        objectName: 'PermissionSetAssignment, GroupMember',
        recordCount: removed,
      },
      { operation: 'update' as const, objectName: 'User, UserLogin', recordCount: updated },
      {
        operation: 'insert' as const,
        objectName: 'PermissionSetAssignment, GroupMember',
        recordCount: added,
      },
    ].filter((one) => one.recordCount > 0);
    let decision: GuardDecision = 'allowed';
    for (const one of asked) {
      const verdict = await consultProductionGuard(guard, {
        orgId: reached.registered.id,
        orgTier,
        module: 'recovery',
        ...one,
      });
      decision = strongerDecision(decision, verdict.decision);
      if (verdict.decision === 'refused') {
        this.recordUsersRun(msg, reached.registered.id, 'stopped', decision);
        throw new Refused(
          'FAILED',
          `Operation blocked by Production Guard: ` +
            `${verdict.check.blockedReason ?? verdict.check.impactSummary} Nothing was written.`,
          false,
          'users',
        );
      }
      if (verdict.decision === 'declined') {
        this.recordUsersRun(msg, reached.registered.id, 'stopped', decision);
        throw new Refused(
          'CANCELLED',
          `Production Guard asked before this run (${verdict.check.impactSummary}), and the ` +
            'answer was no. Nothing was written.',
          false,
          'users',
        );
      }
    }
    return decision;
  }

  /**
   * Record a run of the users in the audit trail, with Production Guard's
   * decision: what it did per object once it ran, nothing when it was
   * stopped before its first write.
   */
  private recordUsersRun(
    msg: InboundRequest,
    orgId: string,
    outcome: AuditOutcome,
    guard: GuardDecision,
    applied?: UsersApplyAnswer,
    m?: RecoveryModules,
  ): void {
    recordWriteRun(this.deps, {
      action: 'users_apply',
      module: 'recovery',
      operationId: msg.id,
      orgId,
      outcome,
      guard,
      ...(applied !== undefined && m !== undefined
        ? { objects: m.usersAuditObjectsOf(applied) }
        : {}),
      details:
        applied !== undefined ? { run: applied.run, emailsToPeople: applied.emailsToPeople } : {},
    });
  }

  // ─── The testers kept ──────────────────────────────────────────────────────

  private async handleConfigSave(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      recoveryUsersConfigPayloadSchema,
      msg,
      'recovery:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const registered = this.registered(parsed.orgId);
      const m = await this.modules();
      const saved = m.saveTesters(
        this.deps.configStore,
        m.recoveryTestersKey(m.myDomainHostOf(registered.instanceUrl), parsed.orgId),
        parsed.config,
        this.now(),
      );
      this.respond(msg, 'recovery:users:config:save:response', {
        orgId: parsed.orgId,
        savedAt: saved.savedAt,
      });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, err, 'users');
    }
  }

  private async handleConfigExport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      recoveryUsersConfigPayloadSchema,
      msg,
      'recovery:error',
      this.deps,
    );
    if (!parsed) return;
    let file: string | undefined;
    try {
      this.registered(parsed.orgId);
      file = await this.dialogs.pickUsersExport('users.json');
      if (file === undefined) {
        this.respond(msg, 'recovery:users:config:export:response', {
          status: 'cancelled',
          orgId: parsed.orgId,
        });
        return;
      }
      // Usernames: its owner's alone, as every file SandForge writes of an org.
      await writeFile(file, `${JSON.stringify(parsed.config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.respond(msg, 'recovery:users:config:export:response', {
        status: 'saved',
        orgId: parsed.orgId,
        fileName: basename(file),
      });
    } catch (err: unknown) {
      this.fail(msg, this.pathless(err, file), 'users');
    }
  }

  private async handleConfigImport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    let file: string | undefined;
    try {
      const registered = this.registered(parsed.orgId);
      file = await this.dialogs.pickUsersImport();
      if (file === undefined) {
        this.respond(msg, 'recovery:users:config:import:response', {
          status: 'cancelled',
          orgId: parsed.orgId,
        });
        return;
      }
      const fileName = basename(file);
      let document: unknown;
      try {
        document = JSON.parse(await readFile(file, 'utf8'));
      } catch (err: unknown) {
        throw new Refused(
          'INVALID_PAYLOAD',
          `${fileName} does not read as JSON (${extractErrorMessage(err)}). Nothing was kept.`,
          false,
          'users',
        );
      }
      const config = usersConfigSchema.safeParse(document);
      if (!config.success) {
        const issues = config.error.issues.map((issue) => {
          const at = issue.path.map(String).join('.');
          return at === '' ? issue.message : `${at}: ${issue.message}`;
        });
        throw new Refused(
          'INVALID_PAYLOAD',
          `${fileName} is not a users.json of sandforge users --config: ${issues.join('; ')}. ` +
            'Nothing was kept.',
          false,
          'users',
        );
      }
      const m = await this.modules();
      m.saveTesters(
        this.deps.configStore,
        m.recoveryTestersKey(m.myDomainHostOf(registered.instanceUrl), parsed.orgId),
        config.data,
        this.now(),
      );
      this.respond(msg, 'recovery:users:config:import:response', {
        status: 'read',
        orgId: parsed.orgId,
        fileName,
        config: config.data,
      });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, this.pathless(err, file), 'users');
    }
  }

  // ─── The audits ────────────────────────────────────────────────────────────

  private async handleAudit(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryAuditPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const m = await this.modules();
      const reached = await this.reach(m, parsed.orgId);
      const { conn, organization } = reached;
      const host =
        m.myDomainHostOf(conn.instanceUrl) ?? m.myDomainHostOf(reached.registered.instanceUrl);
      const read = await m.readAudits(
        {
          transport: { request: (request) => conn.request(request) },
          journalDir: this.journalDir(m),
          now: this.now,
        },
        {
          org: {
            organizationId: organization.organizationId,
            kind: organization.kind,
            alias: reached.orgName,
            ...(host !== undefined ? { host } : {}),
          },
          asked: parsed.asked,
          save: parsed.save,
        },
      );
      for (const note of read.notes) this.deps.log(`[INFO] recovery:audit: ${note}`);
      const kept = this.audited.get(parsed.orgId);
      const before =
        kept !== undefined && sameOrganization(kept.organizationId, organization.organizationId)
          ? kept.audit
          : {};
      this.audited.set(parsed.orgId, {
        organizationId: organization.organizationId,
        audit: {
          ...before,
          ...(read.result.deliverability !== undefined
            ? { deliverability: read.result.deliverability }
            : {}),
          ...(read.result.schedules !== undefined ? { schedules: read.result.schedules } : {}),
          ...(read.result.endpoints !== undefined ? { endpoints: read.result.endpoints } : {}),
        },
      });
      this.respond(msg, 'recovery:audit:response', { orgId: parsed.orgId, audit: read.result });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, err);
    }
  }

  // ─── The handoff note ──────────────────────────────────────────────────────

  private async handleHandoff(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const registered = this.registered(parsed.orgId);
      const m = await this.modules();
      const status = await this.statusOf(parsed.orgId);
      const organizationId = status.organizationId;
      if (organizationId === undefined) {
        throw new Refused(
          'NOT_CONNECTED',
          `The org ${status.alias} is now is not known yet: only its production's history ` +
            'reported its refresh. Connect to it once, then write the note. Nothing was written.',
          true,
          'handoff',
        );
      }
      const at = this.now().toISOString();
      const kept = this.audited.get(parsed.orgId);
      const text = m.recoveryHandoffNoteOf({
        status,
        org: {
          organizationId,
          kind:
            registered.orgType === 'Sandbox'
              ? 'sandbox'
              : registered.orgType === 'Scratch'
                ? 'scratch'
                : 'developer',
          alias: status.alias,
          ...(status.myDomainHost !== undefined ? { host: status.myDomainHost } : {}),
        },
        ...(kept !== undefined && sameOrganization(kept.organizationId, organizationId)
          ? { audits: kept.audit }
          : {}),
        at,
        ...(this.options.sandforgeVersion !== undefined
          ? { sandforgeVersion: this.options.sandforgeVersion }
          : {}),
      });
      const path = m.recoveryHandoffPathOf(this.journalDir(m), { organizationId, at });
      await m.writeRecoveryHandoff(path, text);
      try {
        await this.openInEditor(path);
      } catch (err: unknown) {
        // Written is what was asked: an editor that would not open it leaves
        // the note where the answer names it.
        this.deps.log(
          `[WARN] recovery:handoff: the note was not opened: ${extractErrorMessage(err)}`,
        );
      }
      this.respond(msg, 'recovery:handoff:response', { orgId: parsed.orgId, path });
      this.changed(parsed.orgId);
    } catch (err: unknown) {
      this.fail(msg, err, 'handoff');
    }
  }

  /**
   * Open the newest note of the org the sandbox is now again, as it was
   * written and maybe changed since by hand: never written over. Refused
   * `NOTE_NOT_FOUND` when no note of it is kept on this machine any more —
   * deleted, or never written for the org the refresh made it.
   */
  private async handleHandoffOpen(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(recoveryOrgPayloadSchema, msg, 'recovery:error', this.deps);
    if (!parsed) return;
    try {
      const m = await this.modules();
      const status = await this.statusOf(parsed.orgId);
      const note =
        status.organizationId !== undefined
          ? await m.newestHandoffOf(this.journalDir(m), status.organizationId)
          : undefined;
      if (note === undefined) {
        throw new Refused(
          'NOTE_NOT_FOUND',
          `No handoff note of ${status.alias} as it is now is kept on this machine: write one. ` +
            'Nothing was written.',
          false,
          'handoff',
        );
      }
      try {
        await this.openInEditor(note.path);
      } catch (err: unknown) {
        // Opening it is all that was asked: an editor that would not is a failure.
        throw new Refused(
          'FAILED',
          `The handoff note could not be opened in the editor: ${extractErrorMessage(err)}`,
          true,
          'handoff',
        );
      }
      this.respond(msg, 'recovery:handoff:open:response', {
        orgId: parsed.orgId,
        path: note.path,
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'handoff');
    }
  }

  // ─── What every request goes through ───────────────────────────────────────

  private modules(): Promise<RecoveryModules> {
    this.loaded ??= loadRecoveryModules();
    return this.loaded;
  }

  /** The checkpoints' store, opened once: the one `SANDFORGE_JOURNAL_DIR` names, or `.sandforge` in the home. */
  private async openedCheckpoints(m: RecoveryModules): Promise<OrgCheckpointStore> {
    this.checkpoints ??= Promise.resolve().then(() => {
      const opened = m.openCheckpointStore({ root: m.defaultCheckpointStoreRoot() });
      if ('store' in opened) return opened.store;
      throw new Refused(
        'FAILED',
        `The checkpoints cannot be read in ${opened.refusal.path}: ${opened.refusal.reason}.`,
      );
    });
    try {
      return await this.checkpoints;
    } catch (err: unknown) {
      // Asked again next time: the folder may be put right meanwhile.
      this.checkpoints = undefined;
      throw err;
    }
  }

  private users(m: RecoveryModules): UsersRunStore {
    this.usersStore ??= new m.UsersRunStore({ root: m.defaultUsersStoreRoot() });
    return this.usersStore;
  }

  private replays(m: RecoveryModules): Pick<ReplayStore, 'list'> {
    this.replayStore ??= new m.ReplayStore({ root: m.defaultReplayStoreRoot() });
    return this.replayStore;
  }

  private journalDir(m: RecoveryModules): string {
    return this.options.journalDir ?? m.journalDirOf();
  }

  /** What the steps are deduced from. */
  private factsDeps(m: RecoveryModules) {
    const detector = this.deps.sandboxRefreshes;
    return {
      configStore: this.deps.configStore,
      orgOf: (entryId: string) => this.deps.orgManager.getOrg(entryId),
      refreshesOf: (entryId: string) => detector?.refreshesOf(entryId) ?? [],
      organizationIdOf: (entryId: string) => detector?.organizationIdOf(entryId),
      checkpoints: () => this.openedCheckpoints(m),
      replays: () => this.replays(m),
      users: () => this.users(m),
      journalDir: this.journalDir(m),
      frozenDatasetDir: () => m.frozenDatasetDirOf(this.deps.configStore),
      usersListed: (entryId: string, organizationId: string) => {
        const listed = this.listed.get(entryId);
        return listed !== undefined && sameOrganization(listed.organizationId, organizationId)
          ? listed.total
          : undefined;
      },
    };
  }

  /** Where the sandbox stands, each step deduced. */
  private async statusOf(entryId: string): Promise<RecoveryStatus> {
    const m = await this.modules();
    const read = await m.recoveryFactsOf(this.factsDeps(m), entryId);
    if ('refused' in read) {
      this.registered(entryId);
      throw new Refused(
        read.refused,
        `${entryId} is not an org SandForge brings back into service.`,
      );
    }
    return m.recoveryStatusOf(read.facts);
  }

  /**
   * The registered org, when it is one the page works on: refused, before
   * anything is read, when it is not registered or is a production org.
   */
  private registered(entryId: string, step?: RecoveryStepId): SalesforceOrg {
    const registered = this.deps.orgManager.getOrg(entryId);
    if (registered === undefined) {
      throw new Refused(
        'ORG_NOT_FOUND',
        `No org is registered in SandForge as ${entryId}: connect it on the Organizations page.`,
        false,
        step,
      );
    }
    if (!isDevelopmentOrg(registered)) {
      throw new Refused(
        'NOT_A_DEVELOPMENT_ORG',
        `${orgDisplayName(registered, registered.username)} is registered as a production org: ` +
          'SandForge brings back into service a sandbox, a scratch org or a Developer Edition org, ' +
          "and reads nothing of a production org's. Nothing was read or written.",
        false,
        step,
      );
    }
    return registered;
  }

  /**
   * Reach the org, and type it before anything else is read: the registry
   * first — a production org is asked nothing, not even who is connected —,
   * then what the org says it is (`guardUsersOrg`). Both must say sandbox,
   * scratch org or Developer Edition org.
   */
  private async reach(
    m: RecoveryModules,
    entryId: string,
    step?: RecoveryStepId,
  ): Promise<Reached> {
    const registered = this.registered(entryId, step);
    const orgName = orgDisplayName(registered, registered.username);
    let conn: Connection;
    try {
      conn = await getJsforceConnection(entryId, this.deps.orgRegistry, this.deps.orgManager);
    } catch (err: unknown) {
      throw new Refused(
        'NOT_CONNECTED',
        `${orgName} could not be reached (${extractErrorMessage(err)}): reconnect it on the ` +
          'Organizations page. Nothing was read or written.',
        true,
        step,
      );
    }
    const guarded = await m.guardUsersOrg(conn, { orgName, registered });
    if (!guarded.allowed) {
      const { refusal } = guarded;
      throw new Refused(
        refusal.code === 'PRODUCTION' ? 'NOT_A_DEVELOPMENT_ORG' : 'NOT_CONNECTED',
        refusal.message,
        refusal.code === 'ORG_UNTYPED',
        step,
      );
    }
    return {
      registered,
      orgName,
      conn,
      org: guarded.org,
      organization: guarded.organization,
      typingRequests: guarded.typingRequests,
    };
  }

  /** Tell what listens that a step of `entryId` may have changed. */
  private changed(entryId: string): void {
    for (const listener of [...this.statusListeners]) {
      try {
        listener(entryId);
      } catch (err: unknown) {
        this.deps.log(
          `[WARN] recovery: a listener of the steps failed: ${extractErrorMessage(err)}`,
        );
      }
    }
  }

  /** Answer `msg` on its response channel. */
  private respond(msg: InboundRequest, type: string, payload: Record<string, unknown>): void {
    const response = buildResponse(this.deps, msg, type, payload);
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /** `err` with the path of `file` named by the file's name alone: the page never names a place on this machine. */
  private pathless(err: unknown, file: string | undefined): unknown {
    if (err instanceof Refused || file === undefined) return err;
    return new Error(extractErrorMessage(err).replaceAll(file, basename(file)));
  }

  /** Answer `msg` on the domain's error channel, by the code the page translates. */
  private fail(msg: InboundRequest, err: unknown, step?: RecoveryStepId): void {
    const refused =
      err instanceof Refused ? err : new Refused('FAILED', extractErrorMessage(err), true, step);
    const message = refused.message.trim() === '' ? refused.code : refused.message;
    const at = refused.step ?? step;
    // Its words alone: a connection error's own fields are no part of what the page reads.
    sendHandlerError(
      this.deps,
      msg.type,
      'recovery:error',
      msg,
      new Error(message.slice(0, MESSAGE_MAX)),
      {
        code: refused.code,
        retryable: refused.retryable,
        ...(at !== undefined ? { extraPayload: { step: at } } : {}),
      },
    );
  }
}
