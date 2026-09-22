import type { Connection } from 'jsforce';
import { duplicateRuleHeaders, sanitizeSoqlObjectName } from '@sandforge/shared';
import type { ApiName } from '@sandforge/shared';
import { queryWithFieldsFallback } from '../core/common/soqlQueryHelper';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { GrappeConfig } from '@sandforge/shared';
import type { GrappeEventEnvelope } from '../bridge/handlers/HandlerTypes';
import {
  parseRecordTypeCounts,
  parseRecordTypeInfos,
  recordTypeCountSoql,
  type RecordTypeAvailability,
} from '../core/metadata/recordTypeAvailability';

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
         * One describe of the target per object: the fields the run may send
         * and the record types the running user may use are both read from
         * it. Kept per target connection, so a run against another org — the
         * record types above all — never reads the last org's answer.
         */
        type TargetDescribe = {
          creatable: ReadonlySet<string>;
          recordTypes: RecordTypeAvailability[];
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
                // create calls carrying them. Source Ids are still returned in
                // sourceIds for the remapper's source→target mapping.
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
                const arr = Array.isArray(results) ? results : [results];
                const successIds: string[] = [];
                const sourceIds: string[] = [];
                const errors: string[] = [];
                arr.forEach((r, i) => {
                  if (r.success && r.id) {
                    successIds.push(r.id);
                    sourceIds.push(String(records[i]['Id'] ?? ''));
                  } else {
                    errors.push(
                      ...(r.errors?.map((e: { message: string }) => e.message) ?? [
                        `Insert failed for ${safeObj} record #${i}`,
                      ]),
                    );
                  }
                });
                return { successIds, sourceIds, errors };
              },
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
