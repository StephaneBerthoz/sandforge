/**
 * Doc/code drift guard for the Sync module page.
 *
 * Two claims of `docs/modules/sync.md` outlived the code they described. The
 * feature list sold "5 Conflict Strategies -- ... manual merge ...", while the
 * page offered no tab on which a conflict could be reviewed and the strategy of
 * that name resolved to the source values like source wins. The Conflicts tab
 * is offered now, for the changes real-time replication holds, and a run no
 * longer has a manual strategy at all. It also called
 * transforms "configurable per-field or per-object", while the only rules a
 * screen can produce are object-level ones that rewrite every field of every
 * record. And nothing said that Grappe's threshold is measured with one
 * `SELECT COUNT()` per object, sent before the run and paid for out of the
 * org's daily API budget.
 *
 * Each test states the code it depends on, and fails first if that code moved:
 * an assertion about a page that no longer works this way proves nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// Normalised: the assertions below are LF-anchored and miss on a CRLF checkout.
const DOC = readFileSync(resolve(HERE, 'sync.md'), 'utf8').replace(/\r\n/g, '\n');

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const SYNC_PAGE = source('packages/webview/src/pages/Sync/SyncPage.tsx');
const SYNC_HANDLER = source('packages/extension/src/bridge/handlers/SyncOpsHandler.ts');
const TRANSFORM_PIPELINE = source('packages/extension/src/modules/sync/TransformPipeline.ts');
const TRANSFORM_BUILDER = source('packages/webview/src/pages/Sync/TransformBuilder.tsx');
const SYNC_ORCHESTRATOR = source('packages/extension/src/modules/sync/SyncOrchestrator.ts');
const PUBLISHING_OBJECTS = source('packages/extension/src/modules/realtime/publishingObjects.ts');
const BULK_EXECUTOR = source('packages/extension/src/core/engine/BulkApiExecutor.ts');
const BULK_CSV = source('packages/extension/src/core/engine/bulkCsv.ts');
const ROBUSTNESS_SCHEMA = source('packages/shared/src/schemas/robustness-config.schema.ts');
const SYNC_SCHEMA = source('packages/shared/src/schemas/sync-config.schema.ts');
const SYNC_STRATEGIES = source('packages/shared/src/constants/sync-conflict-strategies.ts');
const CONFLICT_RESOLVER = source('packages/extension/src/modules/sync/ConflictResolver.ts');
const BULK_WRITER = source('packages/extension/src/modules/sync/BulkDataWriter.ts');
const VALIDATE_PAYLOAD = source('packages/extension/src/bridge/validatePayload.ts');
const SYNC_PAGE_DATA = source('packages/webview/src/pages/Sync/useSyncPageData.ts');
const SYNC_DELTA = source('packages/extension/src/modules/sync/SyncDelta.ts');
const SYNC_FILES = source('packages/extension/src/modules/sync/SyncFiles.ts');
const SYNC_CONFIG_STORE = source('packages/extension/src/modules/sync/SyncConfigStore.ts');
const SYNC_REMOVAL_HANDLER = source('packages/extension/src/bridge/handlers/SyncRemovalHandler.ts');
const SYNC_RUN_CREATIONS = source('packages/extension/src/modules/sync/SyncRunCreations.ts');
const SYNC_CLI = source('packages/extension/cli/sandforge-sync.ts');

/** The tabs the page offers, as the array it renders them from. */
const OFFERED_TABS = /const OFFERED_SYNC_TABS: readonly SyncTab\[\] = \[([^\]]*)\]/.exec(SYNC_PAGE);

describe('docs/modules/sync.md', () => {
  it('sells a conflict review for real-time changes only, the one list the tab shows', () => {
    // Positive control: the tab list is where the page says what it offers. If
    // this match is gone the assertion below is about nothing.
    expect(OFFERED_TABS).not.toBeNull();
    expect(OFFERED_TABS?.[1]).toContain("'conflicts'");
    expect(OFFERED_TABS?.[1]).toContain("'realtime'");
    // A run still resolves every collision by its strategy alone.
    expect(SYNC_ORCHESTRATOR).toContain('this.deps.conflictResolver.resolve(');

    expect(DOC).toContain('The Conflicts tab lists only real-time changes');
    expect(DOC).toContain('manual holds the change on the Conflicts tab');
    expect(DOC).not.toContain('5 Conflict Strategies');
    expect(DOC).not.toContain('manual merge');
  });

  it('says which objects real-time follows, and where the others are enabled', () => {
    // Positive control: the page lists what the org publishes, from the
    // org's own channel members.
    expect(PUBLISHING_OBJECTS).toContain('FROM PlatformEventChannelMember');

    expect(DOC).toContain(
      'Only\n  those can be watched: to add another, select it in Setup → Change Data\n  Capture',
    );
    expect(DOC).not.toContain(
      'Real-time (CDC) replication and the conflict list it would feed are not implemented',
    );
  });

  it('names the four strategies a run acts on, and refuses manual rather than resolving it', () => {
    // Positive control: the run's strategies are the four, and the resolver
    // has no answer for manual any more.
    const strategies = /SYNC_CONFLICT_STRATEGIES = \[([^\]]*)\]/.exec(SYNC_STRATEGIES);
    expect(SYNC_SCHEMA).toContain('syncConflictStrategySchema = z.enum(SYNC_CONFLICT_STRATEGIES)');
    expect(strategies?.[1]).toContain("'target_wins'");
    expect(strategies?.[1]).not.toContain("'manual'");
    expect(CONFLICT_RESOLVER).not.toContain("case 'manual':");
    expect(SYNC_PAGE_DATA).toContain(
      "MANUAL_STRATEGY_REPLACEMENT: SyncConflictStrategy = 'target_wins'",
    );

    for (const strategy of ['Source wins', 'target wins', 'newest wins', 'merge']) {
      expect(DOC).toContain(strategy);
    }
    expect(DOC).toContain('Manual review is not offered');
    expect(DOC).toContain('a configuration asking for it is refused before it runs');
    expect(DOC).toContain('reopens on target wins');
    expect(DOC).not.toContain('resolves to the source values without ever showing a conflict');
  });

  it('describes the simulation the Execute step runs, and that it writes nothing', () => {
    // Positive control: the engine's simulation and the channel that asks it.
    expect(SYNC_ORCHESTRATOR).toContain('async simulate(config: SyncConfig)');
    expect(SYNC_HANDLER).toContain("case 'sync:simulate':");
    expect(SYNC_HANDLER).toContain(
      "'A simulation writes nothing: the write it reached was refused.'",
    );

    expect(DOC).toContain('### Simulation');
    expect(DOC).toContain('reads both orgs as the run would and writes\n  nothing');
    expect(DOC).toContain(
      'It writes nothing to the target, to the audit trail or to the sync history.',
    );
    expect(DOC).toContain("does not run the\n  target's validation rules");
  });

  it('says where a pause holds a run, and what a cancel from the page means', () => {
    // Positive control: the run waits on its pause between objects and
    // before each batch or job, never inside one.
    expect(SYNC_ORCHESTRATOR).toContain(
      'await this.deps.pauseGate?.whilePaused(this.deps.signal);',
    );
    expect(BULK_WRITER).toContain('await this.deps.pauseGate?.whilePaused(this.deps.signal);');
    expect(SYNC_HANDLER).toContain("case 'sync:pause':");

    expect(DOC).toContain("Cancel means what Live Operations' Cancel means");
    expect(DOC).toContain('Pause holds the run before its next object, or its next batch of');
    // And Live Operations pauses and resumes it as its page does: the panel
    // offers both on a run the extension marks pausable, and the page sends
    // them on the Sync page's channels.
    expect(source('packages/webview/src/pages/Monitor/LiveOperationsPanel.tsx')).toContain(
      'data-testid={`pause-${operation.operationId}`}',
    );
    expect(source('packages/webview/src/pages/Monitor/MonitorPage.tsx')).toContain(
      "useBridgeMutation<SyncRunControlAnswer>('sync:resume')",
    );
    expect(SYNC_HANDLER).toContain('{ pausable: true }');
    expect(DOC).toContain(
      'or from Live Operations, where it is listed\n  as paused and offers Pause and Resume too',
    );
  });

  it('says what a delta run reads from and what it keeps, and promises no metadata', () => {
    // Positive control: the tracker no run read back and the metadata stub
    // are gone; the delta reads its watermark from the store beside the
    // configuration, from the org's own stamp, five minutes early.
    for (const gone of ['IncrementalTracker.ts', 'MetadataSync.ts']) {
      expect(existsSync(resolve(REPO_ROOT, 'packages/extension/src/modules/sync', gone))).toBe(
        false,
      );
    }
    expect(SYNC_ORCHESTRATOR).not.toContain('incrementalTracker');
    expect(SYNC_DELTA).toContain('export const DELTA_OVERLAP_MS = 5 * 60_000;');
    expect(SYNC_DELTA).toContain('ORDER BY SystemModstamp DESC LIMIT 1');
    expect(SYNC_ORCHESTRATOR).toContain('if (plan && mark !== null && clean) {');
    expect(VALIDATE_PAYLOAD).toContain("if (config.mode !== 'full' && config.mode !== 'delta') {");
    expect(SYNC_HANDLER).toContain(
      "if (config.mode === 'delta' && config.propagateDeletes === true) operation = 'delete';",
    );

    expect(DOC).toContain(
      'A delta run of a saved configuration reads each object from the watermark',
    );
    expect(DOC).toContain('less five minutes for saves committed during a read');
    expect(DOC).toContain('keeps its previous watermark');
    expect(DOC).toContain('Production Guard judges such a run as a delete');
    expect(DOC).toContain('no metadata is deployed');
    expect(DOC).not.toContain('Nothing remembers where a previous run stopped');
  });

  it("names the objects the picker leaves out as the list every copy reads, a managed package's offered", () => {
    // Positive control: the boundary refuses Forge's list, not one of its own,
    // save the managed-package namespaces only Forge's discovery leaves out.
    expect(VALIDATE_PAYLOAD).toContain('return isNeverCopiedWhenPicked(objectApiName);');

    expect(DOC).toContain('the list Forge and Autopilot read');
    expect(DOC).toContain("a record's history, feed or sharing rows");
    expect(DOC).toContain("A managed package's objects, such as Vlocity's");
  });

  it('says a transform rule reaches every field but the one the write matches on', () => {
    // Positive control: the rule loop walks every key of the record, and skips
    // the two the write is addressed by.
    expect(TRANSFORM_PIPELINE).toContain('for (const rule of objectConfig.transformRules)');
    expect(TRANSFORM_PIPELINE).toContain('for (const key of Object.keys(result))');
    expect(TRANSFORM_PIPELINE).toContain(
      "const matchField = objectConfig.externalIdField ?? 'Id';",
    );
    expect(TRANSFORM_PIPELINE).toContain("if (key === matchField || key === 'Id') continue;");

    expect(DOC).toContain('applies to all fields of all objects in the run, except');
    expect(DOC).not.toContain('Configurable per-field or per-object');
  });

  it('says what a formula rule does, and that no rule branches', () => {
    // Positive control: the only formula the pipeline evaluates is the token
    // substitution, and the handler table holds no conditional kind.
    expect(TRANSFORM_PIPELINE).toContain("formula.includes('VALUE')");
    expect(TRANSFORM_PIPELINE).not.toContain('conditional:');

    expect(DOC).toContain('substitutes the field value into the token');
    expect(DOC).toContain('There is no conditional rule');
    expect(DOC).not.toContain('Conditional logic');
  });

  it('says a value mapping rule has no box to fill and so does nothing', () => {
    // Positive control: the type is offered, and the builder's settings table
    // has no entry for it, so the rule can only go out with an empty config.
    expect(TRANSFORM_BUILDER).toContain("'map_value'");
    const configFields = /const CONFIG_FIELDS: Record<string, string\[\]> = \{([^}]*)\}/.exec(
      TRANSFORM_BUILDER,
    );
    expect(configFields).not.toBeNull();
    expect(configFields?.[1]).not.toContain('map_value');

    expect(DOC).toContain('Value mapping takes a table of replacements');
  });

  it('says a write past 200 records goes in one Bulk API job with every field its rows carry, each row answered', () => {
    // Positive control: the threshold, the job's CSV built from every row,
    // and its results matched on what each row was sent with. jsforce, handed
    // the records, wrote the header from the first one, and the rows that
    // differed from it came back without a result.
    expect(ROBUSTNESS_SCHEMA).toContain(
      'threshold: z.number().int().min(1).max(10_000).default(200)',
    );
    expect(BULK_EXECUTOR).toContain(
      'const upload = buildBulkCsv(operation, records, externalIdField);',
    );
    expect(BULK_EXECUTOR).toContain('await job.uploadData(upload.text);');
    expect(BULK_EXECUTOR).toContain('normalizeBulkJobResults(results, upload, jobErrorOf(status))');
    expect(BULK_CSV).toContain(
      "const rows = sent.map((cells) => columns.map((_, column) => cells.get(column) ?? ''));",
    );

    expect(DOC).toContain(
      'A write of more than 200 records goes in one Bulk API 2.0 job, its rows\n  with every field any of them carries.',
    );
    expect(DOC).toContain(
      'an update leaves the\n  field as it was, an insert gives it its default.',
    );
    expect(DOC).toContain(
      'Each row gets its own result\n  back, with its record id, whatever fields it carries',
    );
  });

  it('says files travel with their records, are never copied twice, and go with a removal of the run', () => {
    // Positive control: the run copies them with Forge's stage, keeps where
    // each went beside the watermarks, measures them against the target's
    // storage first, and a reset of the watermarks leaves that record alone.
    expect(SYNC_FILES).toContain("from '../forge/stages/FileCopier.js'");
    expect(SYNC_FILES).toContain('export const SYNC_FILE_MAP_MAX = 5_000;');
    expect(SYNC_FILES).toContain('remainingStorageBytes(deps.copy, config.targetOrgId)');
    expect(SYNC_ORCHESTRATOR).toContain('await copyPlannedFiles({');
    expect(SYNC_CONFIG_STORE).toContain('The record of\n   * the files it copied stays');
    expect(VALIDATE_PAYLOAD).toContain('Sync copies files with the records they hang on');

    expect(DOC).toContain('### Files');
    expect(DOC).toContain('which keeps which file it copied where (5 000 at most)');
    expect(DOC).toContain('added as a version of the copy in the target, never as a second file');
    expect(DOC).toContain("the target's file storage is read (`/limits`)");
    // The files a run created are kept with its records, for its removal.
    expect(SYNC_FILES).toContain('onCreated?: (objectApiName:');
    expect(DOC).toContain('removing a run takes back the files it created with its records');
    expect(DOC).not.toContain('Sync has no undo');
    expect(DOC).not.toContain('Files do not travel');
  });

  it('says what a run keeps of what it created, how its removal goes, and what the configuration forgets', () => {
    // Positive control: every run is given a place to keep what it creates,
    // the store writes it as the run goes, outside globalState and bounded;
    // the removal is judged as a delete, at the tier Sync's writes take, and
    // recorded; the delta state reads a removed object whole.
    expect(SYNC_ORCHESTRATOR).toContain('creations?: SyncCreationRecorder;');
    expect(SYNC_HANDLER).toContain('this.runCreations?.recorder({');
    expect(SYNC_RUN_CREATIONS).toContain("export const SYNC_RUNS_DIR = 'sync-runs';");
    expect(SYNC_RUN_CREATIONS).toContain('export const SYNC_RUNS_MAX_BYTES = 4 * 1024 * 1024;');
    expect(SYNC_RUN_CREATIONS).toContain(
      'export const SYNC_RUNS_HARD_MAX_BYTES = 64 * 1024 * 1024;',
    );
    expect(SYNC_REMOVAL_HANDLER).toContain("case 'sync:remove':");
    expect(SYNC_REMOVAL_HANDLER).toContain("operation: 'delete',");
    expect(SYNC_REMOVAL_HANDLER).toContain('return guardTierOf(org);');
    expect(SYNC_REMOVAL_HANDLER).toContain("action: 'cleanup_delete',");
    expect(SYNC_DELTA).toContain(
      "if (entry.removedAt !== undefined) return { read: 'full', reason: 'removed', fingerprint };",
    );
    expect(SYNC_CLI).toContain(
      'if (org.sandbox || isDeveloperEdition(org.edition)) return undefined;',
    );

    expect(DOC).toContain('### Removing what a run created');
    expect(DOC).toContain('the records it inserted, or upserted where the target held none');
    expect(DOC).toContain('Past 4 MB the runs whose creations were all removed go first');
    expect(DOC).toContain(
      'while a Developer Edition -- which Sync writes to as to a sandbox -- is not taken for one',
    );
    expect(DOC).toContain('as `cleanup_delete` from Sync');
    expect(DOC).toContain('a later delta run never takes a removed copy for still there');
    expect(DOC).toContain(
      'it removes from a sandbox or a Developer Edition org, and refuses any other',
    );
  });

  it('says a run keeps what it writes over before it writes, and its removal gives it back first', () => {
    // Positive control: each call that writes over records asks the keeper
    // first, which keeps the values in the DataOps store before the call goes
    // and refuses the call when it cannot; the removal gives them back from
    // the sweep's place, before its first delete, as an update when it
    // deletes nothing; the retention by count leaves them alone.
    const KEEPER = source('packages/extension/src/modules/sync/syncOverwrites.ts');
    const REMOVAL = source('packages/extension/src/modules/sync/SyncRunRemoval.ts');
    const DATAOPS = source('packages/extension/src/bridge/handlers/DataOpsHandler.ts');
    expect(SYNC_HANDLER).toContain('calls: syncWriterCalls(creations, keeper)');
    expect(SYNC_CLI).toContain('calls: syncWriterCalls(recorder, keeper),');
    expect(KEEPER).toContain("origin: 'sync',");
    expect(KEEPER).toContain('so none of them was ');
    expect(REMOVAL).toContain('...(beforeDeletes ? { sweep: beforeDeletes } : {}),');
    expect(SYNC_REMOVAL_HANDLER).toContain("operation: plan.length > 0 ? 'delete' : 'update',");
    expect(DATAOPS).toContain("if (meta.origin === 'sync') continue;");

    expect(DOC).toContain('**What a run writes over**');
    expect(DOC).toContain('keeps them in the DataOps backup store before the call goes');
    expect(DOC).toContain('A call whose values cannot be read or kept is not sent');
    expect(DOC).toContain(
      'First, before anything is deleted, the records the run wrote over are given back',
    );
    expect(DOC).toContain(
      'a removal that only gives back what the run wrote over as the update it is',
    );
  });

  it('says a delta run looks for files gained since past the newest stamp the last one looked at', () => {
    // Positive control: the lookups start past the stamp kept with the
    // watermark when it is the later of the two, and the run records it.
    expect(SYNC_FILES).toContain('? soqlDateTimeOf(seenBefore)');
    expect(SYNC_ORCHESTRATOR).toContain('...(filesSeen !== undefined ? { filesSeen } : {}),');

    expect(DOC).toContain(
      'Its watermark keeps the newest stamp of a link, a file version or an attachment those lookups looked at',
    );
  });

  it('says the count taken before the first write costs one API request per object, Grappe on or off', () => {
    // Positive control: the count the sentence is about, as the handler sends
    // it before the run, and the write gate that takes it whatever Grappe's
    // setting says.
    expect(SYNC_HANDLER).toContain('`SELECT COUNT() FROM ${safeObj}`');
    expect(SYNC_ORCHESTRATOR).toContain(
      'if ((!gated && !this.deps.grappeConfig?.enabled) || !count) return { none: true };',
    );

    expect(DOC).toContain('`SELECT COUNT()` per object');
    expect(DOC).toContain("counts against\n  the org's daily API request limit");
    expect(DOC).toContain('whether `sandforge.grappe.enabled` is on or\n  off');
    expect(DOC).not.toContain('With the setting off, no count is sent.');
  });
});
