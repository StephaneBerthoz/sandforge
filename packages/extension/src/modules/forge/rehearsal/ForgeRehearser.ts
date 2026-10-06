import type {
  ForgeConfig,
  ForgeGraph,
  ForgeRehearsal,
  ForgeRehearsalProgress,
} from '@sandforge/shared';
import { forgeWriteHeaders } from '@sandforge/shared';
import { ForgeExecutor, type ForgeExecutorDeps } from '../ForgeExecutor.js';
import { ForgeOrchestrator } from '../ForgeOrchestrator.js';
import type { GraphDiscoveryService } from '../GraphDiscoveryService.js';
import type { ForgeAnonymizationMethods } from '../ForgeAnonymizer.js';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';
import { rehearsalExecutorDeps } from './RehearsalWriter.js';
import { rehearse, type RehearsalPlan } from './rehearse.js';
import type { CompositeRequestBody } from './compositeCalls.js';

/** What the extension's rehearsals are wired to. */
export interface ForgeRehearserDeps {
  /**
   * The deps of the run's executor: a rehearsal reads through them as the
   * run does, and writes through none of them.
   */
  reads: ForgeExecutorDeps;
  /** What reads the personal fields a run anonymizes, as the run's orchestrator does. */
  discoveryService: GraphDiscoveryService;
  /** Send one composite request to an org, with the headers given; resolve with its answer. */
  composite: (
    orgId: string,
    body: CompositeRequestBody,
    headers: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
  /** An org's REST API path, `/services/data/vXX.X`. */
  apiPath: (orgId: string) => Promise<string>;
}

/** What one rehearsal is given besides the graph and the config. */
export interface RehearseOptions {
  /** The source → target record type table, as the run's is built. */
  recordTypeMappings?: RecordTypeMapping[];
  /** The method Review holds per PII category. */
  anonymizationRules?: ForgeAnonymizationMethods;
  /** Put the plan to the user; what it throws stops the rehearsal before its first call. */
  confirm: (plan: RehearsalPlan) => Promise<void>;
  onProgress?: (progress: ForgeRehearsalProgress) => void;
}

/**
 * Rehearses the runs Review asks about: each one with an executor and an
 * orchestrator of its own, built on the run's reads and on a writer that
 * keeps the rows instead of writing them, so that the rows a rehearsal judges
 * are prepared by the same code, from the same options, as the run's.
 */
export class ForgeRehearser {
  constructor(private readonly deps: ForgeRehearserDeps) {}

  async rehearse(
    graph: ForgeGraph,
    config: ForgeConfig,
    options: RehearseOptions,
  ): Promise<ForgeRehearsal> {
    const { targetOrgId } = config;
    const recordTypeNames = new Map(
      (options.recordTypeMappings ?? []).map((m) => [m.targetId.slice(0, 15), m.developerName]),
    );
    return rehearse({
      prepare: async (writer) => {
        const orchestrator = new ForgeOrchestrator({
          discoveryService: this.deps.discoveryService,
          executor: new ForgeExecutor(rehearsalExecutorDeps(this.deps.reads, writer)),
        });
        const stopListening = orchestrator.on('forge:progress', (event) =>
          options.onProgress?.({ phase: 'reading', objectApiName: event.objectName }),
        );
        try {
          // Through the write stage, as a real run: a simulation's executor
          // never hands its writer a row.
          await orchestrator.execute(
            graph,
            { ...config, dryRun: false },
            {
              recordTypeMappings: options.recordTypeMappings,
              anonymizationRules: options.anonymizationRules,
            },
          );
        } finally {
          stopListening();
        }
      },
      keyPrefixOf: async (objectApiName) =>
        (await this.deps.reads.describeObject?.(targetOrgId, objectApiName))?.keyPrefix ?? null,
      composite: (body) =>
        this.deps.composite(
          targetOrgId,
          body,
          forgeWriteHeaders({ applyAssignmentRules: config.applyAssignmentRules === true }),
        ),
      apiPath: await this.deps.apiPath(targetOrgId),
      writeHeaders: forgeWriteHeaders({
        applyAssignmentRules: config.applyAssignmentRules === true,
      }),
      recordTypeNames,
      confirm: options.confirm,
      onProgress: options.onProgress,
    });
  }
}
