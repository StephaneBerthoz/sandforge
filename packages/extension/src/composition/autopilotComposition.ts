import type { Connection } from 'jsforce';
import { duplicateRuleHeaders, sanitizeSoqlObjectName } from '@sandforge/shared';
import type { ApiName } from '@sandforge/shared';
import { queryWithFieldsFallback } from '../core/common/soqlQueryHelper';
import { toSaveOutcomes } from '../core/common/existingRecordMatch';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { GrappeConfig } from '@sandforge/shared';
import type { GrappeEventEnvelope } from '../bridge/handlers/HandlerTypes';
import {
  parseRecordTypeCounts,
  parseRecordTypeInfos,
  recordTypeCountSoql,
  type RecordTypeAvailability,
} from '../core/metadata/recordTypeAvailability';
import { describedLookups, type DescribedLookup } from '../core/metadata/describedLookups';

/** Inputs required to wire the Autopilot orchestrator. */
export interface AutopilotCompositionDeps {
  handlers: ExtensionHandlers;
  log: (msg: string) => void;
  /**
   * Grappe settings snapshot (`sandforge.grappe.*`). Absent keeps partitioned
   * mode off — `isGrappeActive` requires an enabled config.
   */
  grappeConfig?: GrappeConfig;
  /**
   * Forwards the orchestrator's grappe lifecycle events to the webview. Built
   * by the activation root, which owns the broker; without it the three
   * `grappe:*` channels never fire and the Grappe page stays blank.
   */
  onGrappeEvent?: (event: GrappeEventEnvelope) => void;
}

/**
 * Wire up the Autopilot orchestrator via dynamic imports, then inject
 * it into the handlers through the late setter (`setAutopilotOrchestrator`).
 *
 * Fire-and-forget by design: the 9 dynamic imports stay OFF the activation hot
 * path. The injection therefore lands AFTER `handlers.registerAll(router)` —
 * see the late-injection contract in `./lateServices.ts`. Until then the
 * AutopilotHandler guard answers "Autopilot module is not initialized.".
 * Failures are logged, never thrown (the rest of the extension stays usable).
 *
 * ## Connection capture
 *
 * The fixed orchestrator API only sees connections at `scanSchemas` time and
 * `createExecutor` takes no argument, so the executor's query/insert functions
 * cannot be handed connections directly. A SchemaScanner subclass therefore
 * records the connections of the latest scan ("latest wins" — the same
 * semantics as AutopilotHandler's current operation and the orchestrator's
 * running-executor stack), and `createExecutor` freezes them per execution so
 * a concurrent scan cannot swap connections mid-run.
 *
 * The returned promise resolves once injection landed (or failed — errors are
 * caught and logged, never rethrown); production calls it fire-and-forget,
 * tests can await it.
 */
export function initAutopilotComposition(deps: AutopilotCompositionDeps): Promise<void> {
  const { handlers, log, grappeConfig, onGrappeEvent } = deps;

  return Promise.all([
    import('../modules/autopilot/SchemaScanner.js'),
    import('../modules/autopilot/DependencyGraphBuilder.js'),
    import('../modules/autopilot/ComplianceEngine.js'),
    import('../modules/autopilot/SmartAnonymizer.js'),
    import('../modules/autopilot/ExecutionPlanGenerator.js'),
    import('../modules/autopilot/RecordIdRemapper.js'),
    import('../modules/autopilot/AutopilotExecutor.js'),
    import('../modules/autopilot/AutopilotGrappeAdapter.js'),
    import('../modules/autopilot/AutopilotOrchestrator.js'),
  ])
    .then(
      ([
        { SchemaScanner },
        { DependencyGraphBuilder },
        { ComplianceEngine },
        { SmartAnonymizer },
        { ExecutionPlanGenerator },
        { RecordIdRemapper },
        { AutopilotExecutor },
        { AutopilotGrappeAdapter },
        { AutopilotOrchestrator },
      ]) => {
        // Connections of the most recent scan. AutopilotHandler resolves real
        // jsforce Connections and casts them to the scanner's narrow
        // AutopilotConnection interface — casting back recovers the full API
        // (sobject().create) the executor's insert path needs.
        let lastConnections: { source: Connection; target: Connection } | undefined;

        class ConnectionCapturingScanner extends SchemaScanner {
          override async scan(
            sourceConn: import('../modules/autopilot/SchemaScanner.js').AutopilotConnection,
            targetConn: import('../modules/autopilot/SchemaScanner.js').AutopilotConnection,
            selectedObjects: ApiName[],
            includeStandardObjects: boolean,
          ): Promise<import('../modules/autopilot/SchemaScanner.js').SchemaScanResult> {
            lastConnections = {
              source: sourceConn as unknown as Connection,
              target: targetConn as unknown as Connection,
            };
            return super.scan(sourceConn, targetConn, selectedObjects, includeStandardObjects);
          }
        }

        /**
         * One describe of the target per object: the fields the run may send,
         * the record types the running user may use and the key prefix an id
         * a refusal names must carry are all read from it. Kept per target
         * connection, so a run against another org — the record types above
         * all — never reads the last org's answer.
         */
        type TargetDescribe = {
          creatable: ReadonlySet<string>;
          recordTypes: RecordTypeAvailability[];
          keyPrefix: string | null;
          lookups: DescribedLookup[];
        };
        const describedByTarget = new WeakMap<Connection, Map<string, TargetDescribe>>();
        const describeTarget = async (
          target: Connection,
          objectApiName: string,
        ): Promise<TargetDescribe> => {
          let byObject = describedByTarget.get(target);
          if (!byObject) {
            byObject = new Map();
            describedByTarget.set(target, byObject);
          }
          const cached = byObject.get(objectApiName);
          if (cached) return cached;
          const described = await target.describe(objectApiName);
          const answer: TargetDescribe = {
            creatable: new Set(
              (described.fields as Array<{ name: string; createable?: boolean }>)
                .filter((f) => f.createable === true)
                .map((f) => f.name),
            ),
            recordTypes: parseRecordTypeInfos(described.recordTypeInfos),
            keyPrefix: typeof described.keyPrefix === 'string' ? described.keyPrefix : null,
            lookups: describedLookups(described.fields),
          };
          byObject.set(objectApiName, answer);
          return answer;
        };
        const anonymizer = new SmartAnonymizer();

        const orchestrator = new AutopilotOrchestrator({
          schemaScanner: new ConnectionCapturingScanner(),
          graphBuilder: new DependencyGraphBuilder(),
          complianceEngine: new ComplianceEngine(),
          anonymizer,
          planGenerator: new ExecutionPlanGenerator(),
          // The orchestrator's own remapper slot (unused by the orchestrator
          // itself; each execution builds a fresh one — see createExecutor).
          remapper: new RecordIdRemapper(),
          createExecutor: () => {
            const connections = lastConnections;
            if (!connections) {
              throw new Error(
                'Autopilot: no scanned connections available. Run scan-schema before execute.',
              );
            }
            // Freeze per execution: a scan starting mid-run must not swap the
            // connections of an in-flight executor.
            const { source, target } = connections;
            return new AutopilotExecutor({
              query: async (objectApiName, offset, limit) => {
                const safeObj = sanitizeSoqlObjectName(objectApiName);
                // OFFSET pagination mirrors the executor's offset-based design
                // (SOQL caps OFFSET at 2000 — larger objects fail per-node).
                const soql = `SELECT FIELDS(ALL) FROM ${safeObj} LIMIT ${limit} OFFSET ${offset}`;
                return queryWithFieldsFallback<Record<string, unknown>>(source, safeObj, soql);
              },
              insert: async (objectApiName, records) => {
                const safeObj = sanitizeSoqlObjectName(objectApiName);
                // Strip source Id + jsforce attributes: Salesforce rejects
                // create calls carrying them. The outcomes come back in the
                // order of `records`, which is how the executor pairs each
                // one with the source Id it maps.
                const cleaned = records.map((r) => {
                  const copy = { ...r };
                  delete copy['Id'];
                  delete copy['attributes'];
                  return copy;
                });
                // A copy writes rows that look like rows the target has,
                // which is what a duplicate rule exists to stop. The fourth
                // module to need this header; see `duplicate-rules.ts`.
                const results = await target
                  .sobject(safeObj)
                  .create(cleaned, { headers: duplicateRuleHeaders(true) });
                // Each refusal with its status code, its fields and the
                // records a duplicate rule matched. Only the message used to
                // be kept: a French org's "valeur en double trouvée" reached
                // the run with nothing that said it was a duplicate, and
                // nothing that said which record.
                return toSaveOutcomes(results, safeObj);
              },
              // The statuses a record could not be born with, written back
              // once its children are in.
              update: async (objectApiName, records) => {
                const safeObj = sanitizeSoqlObjectName(objectApiName);
                const results = await target
                  .sobject(safeObj)
                  .update(records as Array<Record<string, unknown> & { Id: string }>, {
                    headers: duplicateRuleHeaders(true),
                  });
                return toSaveOutcomes(results, safeObj);
              },
              // The standard price book on each side, the relations the
              // platform made, the statuses a lifecycle starts with, and a
              // duplicate a refusal does not name. Every one of them is a
              // bounded read: a single page answers it.
              querySource: async (soql) =>
                (await source.query<Record<string, unknown>>(soql)).records,
              queryTarget: async (soql) =>
                (await target.query<Record<string, unknown>>(soql)).records,
              describeKeyPrefix: async (objectApiName: string) =>
                (await describeTarget(target, objectApiName)).keyPrefix,
              // What each lookup may point at and when it may be set: which
              // are left to the target's default, what a cycle writes first,
              // and what the second pass may fill.
              describeLookups: async (objectApiName: string) =>
                (await describeTarget(target, objectApiName)).lookups,
              anonymizer,
              // Per-execution remapper: source→target ID mappings are scoped to
              // a single run — a shared instance would remap lookups to IDs
              // inserted by a previous execution.
              remapper: new RecordIdRemapper(),
              // What the target will take. Without it a run sends every field
              // it read and the platform refuses every record — see
              // `describeCreateableFields`. Successive runs against the same
              // connection describe once.
              describeCreateableFields: async (objectApiName: string) =>
                (await describeTarget(target, objectApiName)).creatable,
              // From the same describe: no request of its own. A record type
              // closed to the running user is what the run tells the user to
              // change in the target, so that answer is not kept past this
              // run: the next one reads the target again and sees the change.
              describeRecordTypes: async (objectApiName: string) => {
                const { recordTypes } = await describeTarget(target, objectApiName);
                if (recordTypes.some((type) => !type.available && !type.master)) {
                  describedByTarget.get(target)?.delete(objectApiName);
                }
                return recordTypes;
              },
              // Asked only when the target has a record type the running user
              // cannot use: the run reads a page at a time and has to know
              // every type its records carry before the first page is written.
              countRecordTypes: async (objectApiName: string) => {
                const safeObj = sanitizeSoqlObjectName(objectApiName);
                const counted = await source.query<Record<string, unknown>>(
                  recordTypeCountSoql(safeObj),
                );
                return parseRecordTypeCounts(counted.records);
              },
            });
          },
          grappeAdapter: new AutopilotGrappeAdapter(),
          // Grappe mode is opt-in (`sandforge.grappe.enabled`): an absent config
          // is what isGrappeActive reads as "stay sequential". The callback is
          // passed through regardless — it was the missing half that left the
          // `grappe:*` channels silent even when the mode was on.
          grappeConfig,
          onGrappeEvent,
        });

        handlers.setAutopilotOrchestrator(orchestrator);
        log('Autopilot module initialized.');
      },
    )
    .catch((err) => log(`Failed to init Autopilot module: ${String(err)}`));
}
