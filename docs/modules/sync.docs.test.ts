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
const CONFLICT_RESOLVER = source('packages/extension/src/modules/sync/ConflictResolver.ts');
const BULK_WRITER = source('packages/extension/src/modules/sync/BulkDataWriter.ts');
const VALIDATE_PAYLOAD = source('packages/extension/src/bridge/validatePayload.ts');
const SYNC_PAGE_DATA = source('packages/webview/src/pages/Sync/useSyncPageData.ts');

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
    const strategies = /syncConflictStrategySchema = z\.enum\(\[([^\]]*)\]/.exec(SYNC_SCHEMA);
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

  it('promises no delta and no metadata: every run reads each object whole', () => {
    // Positive control: the tracker no run read back and the metadata stub
    // are gone, so nothing in the engine could stand behind a delta.
    for (const gone of ['IncrementalTracker.ts', 'MetadataSync.ts']) {
      expect(existsSync(resolve(REPO_ROOT, 'packages/extension/src/modules/sync', gone))).toBe(
        false,
      );
    }
    expect(SYNC_ORCHESTRATOR).not.toContain('incrementalTracker');

    expect(DOC).toContain('Nothing remembers where a previous run stopped');
    expect(DOC).toContain('no metadata is deployed');
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

  it('says the Grappe count costs one API request per object', () => {
    // Positive control: the count the sentence is about, as the handler sends
    // it before the run.
    expect(SYNC_HANDLER).toContain('`SELECT COUNT() FROM ${safeObj}`');

    expect(DOC).toContain('`SELECT COUNT()` per object');
    expect(DOC).toContain("counts against the org's daily API request limit");
    expect(DOC).toContain('`sandforge.grappe.enabled`');
  });
});
