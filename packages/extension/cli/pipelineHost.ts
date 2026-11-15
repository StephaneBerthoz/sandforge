/**
 * The extension host a pipeline file runs in, without the editor
 * (`sandforge pipeline`): the panel host every command line drives a panel
 * through (`panelHost.ts`), given what the editor's own composition gives the
 * Automation page's runs, and what this machine's command lines read back.
 *
 * - A Production Guard that asks nobody: it declines a production org and
 *   lets every other through, whose own question the pipeline's checks
 *   already put to an Approval step (`commandLineGuard`'s rule).
 * - The registry Live Operations would list the run in: what a stop reaches
 *   it through.
 * - Snapshots kept in the backups folder the DataOps and Sync command lines
 *   restore from, and the runs of Sync and Seed in the journal folder their
 *   removals read: the lines a run prints to take itself back are the ones
 *   those commands run.
 * - The settings the file carries, the terminal or `--approve` for an
 *   Approval step, a printed line for a Notification step.
 *
 * It never goes through Forge's host, which asks Node 22.15 (`forgeHost.ts`):
 * a pipeline has no Forge step.
 *
 * What the file names is put into the host as the Automation page would have
 * it: each org connected by its alias and typed live, the Staging mark the
 * file carries set on a sandbox alone, the steps and the Sync configurations
 * rewritten from the editor's ids to the orgs connected here, the
 * configurations and templates saved in the host's store.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PipelineFileOrg,
  PipelineFileOrgKind,
  SalesforceOrg,
  SandforgePipelineFile,
} from '@sandforge/shared';
import { pipelineFileOrgRefs, registeredOrgType } from '@sandforge/shared';
import { createPanelHost, type PanelHost, type PostedMessage } from './panelHost.js';
import { fileConfigStore } from './fileConfigStore.js';
import { journalDirOf } from './journalDir.js';
import { defaultBackupStoreOf, openBackupStore } from './backupStore.js';
import type { InfraServices } from '../src/bridge/ExtensionHandlers.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';
import { ProductionGuard, type SafetyTier } from '../src/core/precheck/ProductionGuard.js';
import type { ConfigStore } from '../src/core/storage/ConfigStore.js';
import type { OrgRegistry } from '../src/core/connection/OrgRegistry.js';
import { BackupRecordStore, nodeBackupFiles } from '../src/modules/dataops/BackupRecordStore.js';
import { AnonymizationTemplateStore } from '../src/modules/dataops/AnonymizationTemplateStore.js';
import { SeedTemplateStore } from '../src/modules/seed/SeedTemplateStore.js';
import { nodeSeedRunCreations } from '../src/modules/seed/SeedRunCreations.js';
import { SyncConfigStore } from '../src/modules/sync/SyncConfigStore.js';
import { nodeSyncRunCreations } from '../src/modules/sync/SyncRunCreations.js';
import type { Services } from '../src/services.js';

/** What the host needs from the command that runs it. */
export interface PipelineHostOptions {
  /** The host's store: the saved pipeline, the Sync watermarks, the Rewind confirmations, the audit. */
  storeDir: string;
  /** The extension's warnings and failures, as the command prints them. */
  log: (line: string) => void;
  /** Told of each message the host posts, as it is posted: a step as it starts and ends. */
  onPost?: (message: PostedMessage) => void;
  /** How an Approval step is asked: at the terminal, or answered by `--approve`. */
  askApproval?: Services['askApproval'];
  /** A setting a step reads: the file's, or the extension's default. */
  setting: <T>(key: string, fallback: T) => T;
  /** A Notification step's message, printed. */
  notify: (message: string) => void;
  /** This SandForge's version: what the check of a pipeline names, as an export does. */
  sandforgeVersion: string;
  /** Where the runs of Sync and Seed are kept: `SANDFORGE_JOURNAL_DIR`, or `~/.sandforge`. */
  journalDir?: string;
  /** Where the snapshots of an Anonymize or a Backup step, and what a Sync writes over, are kept. */
  backupDir?: string;
}

/** The host, with what the command reads and writes of it besides its requests. */
export interface PipelineHost {
  host: PanelHost;
  configStore: ConfigStore;
  orgRegistry: OrgRegistry;
  /** Where the snapshots are kept, shared with `sandforge dataops` and `sandforge sync --remove`. */
  backupDir: string;
  /** Let go of what the host holds. */
  dispose(): void;
}

/** What the host's log carries that is worth a line: a warning, a failure, a lock taken over. */
const WORTH_SAYING = /^\[(WARN|ERR)\]|^\[INFO\] (?:The run lock|the confirmation)/;

/** The words the guard says a production org is declined with. */
function declined(orgName: string | undefined, tier: SafetyTier): string | undefined {
  return tier === 'production'
    ? `${orgName ?? 'the org'} is taken for a production org, and a pipeline from the command ` +
        'line writes to none'
    : undefined;
}

/**
 * Stand up the host a pipeline file runs in.
 *
 * @throws When the backups folder cannot be made, or another user owns it:
 *   its snapshots would be theirs to read.
 */
export function createPipelineHost(options: PipelineHostOptions): PipelineHost {
  const journalDir = options.journalDir ?? journalDirOf();
  const backupDir = options.backupDir ?? defaultBackupStoreOf();
  const refused = openBackupStore(backupDir);
  if (refused !== undefined) throw new Error(refused);
  mkdirSync(options.storeDir, { recursive: true, mode: 0o700 });

  const registry = new BackgroundOperationRegistry();
  let wired:
    { configStore: ReturnType<typeof fileConfigStore>; orgRegistry: OrgRegistry } | undefined;
  const host = createPanelHost({
    storeDir: options.storeDir,
    log: (line) => {
      if (WORTH_SAYING.test(line.trim())) options.log(line.trim());
    },
    // A run waits as long as it lasts: an Approval waits up to a day.
    waitMs: 0,
    typeScratchOrgs: true,
    ...(options.onPost ? { onPost: options.onPost } : {}),
    services: {
      getSandforgeSetting: options.setting,
      showNotification: options.notify,
      ...(options.askApproval ? { askApproval: options.askApproval } : {}),
    },
    compose: (wiring) => {
      const orgName = (orgId: string): string | undefined => wiring.orgManager.getOrg(orgId)?.alias;
      const guard = new ProductionGuard({
        orgNameOf: orgName,
        // Nobody to ask: no for a production org, said; yes for any other,
        // whose question the pipeline put to an Approval step before it.
        requestConfirmation: (impactSummary, tier) => {
          const why = declined(undefined, tier);
          if (why === undefined) return Promise.resolve(true);
          options.log(`refused: ${why} (${impactSummary})`);
          return Promise.resolve(false);
        },
        declinesWithoutAsking: (tier) => declined(undefined, tier),
      });
      wiring.handlers.setInfraServices({
        productionGuard: guard,
        backgroundRegistry: registry,
        piiDetector: new PIIDetector(),
        // No dialog here: the version alone, which the check of a pipeline
        // names as an export does. A checkpoint's Export… and Import… are
        // the checkpoint command's, never sent here.
        checkpointFiles: {
          sandforgeVersion: options.sandforgeVersion,
          pickExportFile: () =>
            Promise.reject(new Error('sandforge checkpoint export saves a checkpoint to a file.')),
          pickImportFile: () =>
            Promise.reject(new Error('sandforge checkpoint import reads a checkpoint file.')),
        },
      } as Partial<InfraServices> as InfraServices);
      wiring.handlers.setBackgroundRegistry(registry);
      wiring.handlers.setBackupRecordStore(new BackupRecordStore(nodeBackupFiles(backupDir)));
      wiring.handlers.setSyncRunCreations(nodeSyncRunCreations(journalDir));
      wiring.handlers.setSeedRunCreations(nodeSeedRunCreations(journalDir));
      wired = { configStore: wiring.configStore, orgRegistry: wiring.orgRegistry };
    },
  });
  if (wired === undefined) throw new Error('The host composed no handlers.');
  return {
    host,
    configStore: wired.configStore,
    orgRegistry: wired.orgRegistry,
    backupDir,
    dispose: () => registry.dispose(),
  };
}

/** What a pipeline file calls the kind of an org connected here, typed live. */
export function liveKindOf(org: Pick<SalesforceOrg, 'orgType' | 'metadata'>): PipelineFileOrgKind {
  switch (registeredOrgType(org.orgType, org.metadata?.edition)) {
    case 'Sandbox':
      return 'sandbox';
    case 'Scratch':
      return 'scratch';
    case 'Developer':
      return 'developer';
    default:
      return 'production';
  }
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
export function sameOrganization(a: string, b: string): boolean {
  return a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/** The kinds of org that are made again often, under the same alias: never pinned to their Id. */
const UNPINNED: ReadonlySet<PipelineFileOrgKind> = new Set(['scratch', 'developer']);

/** A kind of org, as the refusal of one that changed names it. */
const KIND_WORDS: Readonly<Record<PipelineFileOrgKind, string>> = {
  sandbox: 'a sandbox',
  scratch: 'a scratch org',
  developer: 'a Developer Edition org',
  production: 'a production org',
};

/**
 * What changed of an org since the export, in a clause: its Id alone, or its
 * kind too. A file that said sandbox, its alias now reaching a Developer
 * Edition org, was refused for "a sandbox refreshed since", which it was not.
 */
function changedWords(fileKind: PipelineFileOrgKind, liveKind: PipelineFileOrgKind): string {
  if (fileKind !== liveKind) {
    return `another org, of another kind: ${KIND_WORDS[liveKind]} here, ${KIND_WORDS[fileKind]} in the file`;
  }
  return fileKind === 'sandbox'
    ? 'a sandbox refreshed since is another org, holding production’s data again'
    : 'another org than the one the pipeline was exported for';
}

/** An org of the file as it answered here, against what the file says of it. */
export type OrgMatch =
  /** The org the file names, or one of a kind not pinned to its Id. */
  | { ok: true; note?: string }
  /** Another org than the file's, by Organization Id: a sandbox refreshed since, an alias moved. */
  | { ok: false; code: 'ORG_MOVED'; message: string; wayOut: string };

/**
 * Whether the org an alias reached is the one the file names. A sandbox and
 * a production org are pinned to their Organization Id: a refresh gives a
 * sandbox another, and its data is production's again. A scratch org and a
 * Developer Edition org, made again under the same alias, are not, while
 * they stay of such a kind: the file's says which, the live type says the
 * other.
 *
 * The way out names the org by the alias it is reached by: its key in the
 * file is the Organization Id the editor registered it under, and
 * `--accept-org <key>=<id>` read as one Id given for another.
 *
 * @param accepted - The Organization Id `--accept-org` gives for it.
 * @param acceptedAs - What that `--accept-org` named the org by: its alias, or its key.
 */
export function matchOrg(
  key: string,
  alias: string,
  fileOrg: PipelineFileOrg,
  live: { organizationId: string; kind: PipelineFileOrgKind },
  accepted?: string,
  acceptedAs: string = key,
): OrgMatch {
  if (sameOrganization(fileOrg.organizationId, live.organizationId)) return { ok: true };
  if (accepted !== undefined && sameOrganization(accepted, live.organizationId)) {
    return {
      ok: true,
      note:
        `${alias} answers as org ${live.organizationId}, not the ${fileOrg.organizationId} the file ` +
        `names: taken, as --accept-org ${acceptedAs}=${accepted} says.`,
    };
  }
  if (UNPINNED.has(fileOrg.kind) && UNPINNED.has(live.kind)) {
    return {
      ok: true,
      note:
        `${alias} answers as org ${live.organizationId}, not the ${fileOrg.organizationId} the file ` +
        `names: a ${live.kind === 'scratch' ? 'scratch org' : 'Developer Edition org'} is made ` +
        'again under its alias, and is not pinned to its Id.',
    };
  }
  return {
    ok: false,
    code: 'ORG_MOVED',
    message:
      `${alias} answers as org ${live.organizationId}, and the file names ` +
      `${fileOrg.organizationId}: ${changedWords(fileOrg.kind, live.kind)}. Nothing was run.`,
    wayOut:
      `check that ${alias} is the org the pipeline is for, then run again with --accept-org ` +
      `${alias}=${live.organizationId}; or export the pipeline again from the Automation page.`,
  };
}

/**
 * Set the Staging mark the file carries on the org connected here, as Org
 * Manager sets it: read of a sandbox alone, as Production Guard reads it. A
 * line says when the file marks an org this one is no sandbox to carry it.
 *
 * @returns The org as the registry holds it now, and the line, if any.
 */
export function markStaging(
  registry: Pick<OrgRegistry, 'updateOrgMetadata'>,
  org: SalesforceOrg,
  fileOrg: PipelineFileOrg,
  alias: string,
): { org: SalesforceOrg; note?: string } {
  if (!fileOrg.staging) return { org };
  const kind = liveKindOf(org);
  if (kind !== 'sandbox') {
    return {
      org,
      note:
        `${alias} is marked Staging in the file, and is a ${kind} org here: the mark is read of ` +
        'a sandbox alone, and not set.',
    };
  }
  const marked = { ...org, staging: true };
  registry.updateOrgMetadata(marked);
  return { org: marked };
}

/** A value as plain data, never the file's own objects. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The pipeline, its Sync configurations, and the ids rewritten from the editor's to the orgs here. */
export interface HostedPipeline {
  /** The pipeline as `pipeline:save` takes it. */
  pipeline: Record<string, unknown> & { id: string; name: string; steps: unknown[] };
  syncConfigs: Array<Record<string, unknown> & { id: string }>;
}

/**
 * The file's pipeline and Sync configurations, each org they name rewritten
 * from the key the editor's registry gave it to the id the org is registered
 * under here: its Organization Id, as connected. A key `idOf` does not know
 * stays as it is, and the step that names it is refused by its check.
 */
export function hostedPipeline(
  file: Pick<SandforgePipelineFile, 'pipeline' | 'syncConfigs' | 'exportedAt'>,
  idOf: (key: string) => string | undefined,
): HostedPipeline {
  const pipeline = plain(file.pipeline);
  const syncConfigs = plain(file.syncConfigs);
  for (const ref of pipelineFileOrgRefs(file)) {
    const id = idOf(ref.key);
    if (id === undefined) continue;
    if (ref.stepId !== undefined) {
      const step = pipeline.steps.find((each) => each.id === ref.stepId);
      if (step) step.config[ref.field] = id;
    } else if (ref.syncConfigId !== undefined) {
      const config = syncConfigs[ref.syncConfigId];
      if (config) (config as Record<string, unknown>)[ref.field] = id;
    }
  }
  return {
    pipeline: {
      ...pipeline,
      // A variable the run requires and the file gives no value — a secret
      // never travels in it — is held to its value by the command line
      // before the run, which hands the value on with the run alone. Saved
      // as required, the editor's check asked it a default, and refused
      // every run of a pipeline with a secret.
      variables: pipeline.variables.map((variable) =>
        variable.required && variable.defaultValue === undefined
          ? { ...variable, required: false }
          : variable,
      ),
      // What a saved pipeline holds besides: its schedule is the launcher's.
      version: 1,
      triggers: [],
      createdAt: file.exportedAt,
      updatedAt: file.exportedAt,
    },
    syncConfigs: Object.values(syncConfigs),
  };
}

/** The prefix of a Seed template SandForge ships: named by id, never saved over. */
const SHIPPED_SEED_TEMPLATE = 'prebuilt-';

/** The prefix of a masking template SandForge ships: named by id, never saved over. */
const SHIPPED_MASKING_TEMPLATE = 'tpl-';

/**
 * Save in the host's store what the file carries for its steps: the Sync
 * configurations, rewritten for the orgs here, and the Seed and masking
 * templates. A configuration saved under the same id is written over, and its
 * watermarks stay: the next delta run of the same store reads on from them.
 */
export function saveCarried(
  configStore: ConfigStore,
  file: Pick<SandforgePipelineFile, 'seedTemplates' | 'maskingTemplates'>,
  hosted: Pick<HostedPipeline, 'syncConfigs'>,
): void {
  const syncs = new SyncConfigStore(configStore);
  for (const config of hosted.syncConfigs) {
    syncs.save(config as unknown as Parameters<SyncConfigStore['save']>[0]);
  }
  const seeds = new SeedTemplateStore(configStore);
  for (const template of Object.values(file.seedTemplates)) {
    if (template.id.startsWith(SHIPPED_SEED_TEMPLATE)) continue;
    seeds.save(plain(template) as unknown as Parameters<SeedTemplateStore['save']>[0]);
  }
  const masks = new AnonymizationTemplateStore(configStore);
  for (const template of Object.values(file.maskingTemplates)) {
    if (template.id.startsWith(SHIPPED_MASKING_TEMPLATE)) continue;
    masks.save(plain(template) as unknown as Parameters<AnonymizationTemplateStore['save']>[0]);
  }
}

/** The metadata of a snapshot, as `sandforge dataops` and `sandforge sync --remove` list one. */
const SNAPSHOT_KEY = 'backup:';

/**
 * Copy into the backups folder's own list the snapshots a run took, which the
 * host listed in its store: the DataOps command line restores a snapshot, and
 * Sync's removal gives back what a run wrote over, from that list alone. The
 * records themselves are in the folder already.
 *
 * @param before - The snapshots the host listed before the run: left as they are.
 * @returns How many were copied.
 */
export function shareSnapshots(
  hostStore: ConfigStore,
  backupDir: string,
  before: ReadonlySet<string>,
): number {
  const taken = hostStore.getKeysByPrefix(SNAPSHOT_KEY).filter((key) => !before.has(key));
  if (taken.length === 0) return 0;
  const shared = fileConfigStore(join(backupDir, 'snapshots.json'));
  for (const key of taken) shared.set(key, hostStore.get(key), 'backups');
  return taken.length;
}

/** The snapshots a store lists now: what {@link shareSnapshots} leaves out after a run. */
export function snapshotKeys(store: ConfigStore): Set<string> {
  return new Set(store.getKeysByPrefix(SNAPSHOT_KEY));
}
