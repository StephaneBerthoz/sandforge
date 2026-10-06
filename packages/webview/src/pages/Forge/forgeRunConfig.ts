/**
 * What a stored run configuration says, and the template a run is saved as.
 *
 * A past run (History) and a saved template carry the same configuration: the
 * run's config with its org pair taken off. Both lists describe it the same
 * way, and a template is built from a run in one place, so the results screen
 * and the Template tab cannot disagree about what a template holds.
 */
import type {
  AnonymizationMethod,
  ForgeAnonymizationCategory,
  ForgeConfig,
  ForgeGraph,
  ForgeInputMode,
  ForgeTemplate,
} from '@sandforge/shared';

/** A run's configuration as History and templates keep it: without the org pair. */
export type StoredForgeConfig = Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;

/** The tab label each input mode was run from. */
export const INPUT_MODE_KEYS: Record<ForgeInputMode, string> = {
  record: 'forge.recordTab',
  soql: 'forge.soqlTab',
  template: 'forge.templateTab',
  ai: 'forge.aiTab',
};

/** The part of a stored config that identifies what was cloned. */
export function configSubject(config: StoredForgeConfig): string | undefined {
  switch (config.inputMode) {
    case 'record':
      return config.recordId;
    case 'soql':
      return config.soqlQuery;
    case 'template':
      return config.templateId;
    case 'ai':
      return config.aiPrompt;
  }
}

/**
 * Drop the org pair from a run's config.
 *
 * Copy-then-delete, as the extension does for History: spreading keeps every
 * field added to ForgeConfig later, where a field list would silently stop
 * saving them.
 */
export function withoutOrgs(config: ForgeConfig): StoredForgeConfig {
  const copy: Partial<ForgeConfig> = { ...config };
  delete copy.sourceOrgId;
  delete copy.targetOrgId;
  return copy as StoredForgeConfig;
}

/**
 * The parts of a run's config the form has no control for, which a template
 * or a past run brings back and a Discover sends on: the decisions taken on
 * the Gaps tab, the objects left out, and the field exclusions and mappings.
 * Built from the form alone, the config Discover sent dropped every one.
 */
const CARRIED_KEYS = [
  'fieldExclusions',
  'ownerMappings',
  'fieldMappings',
  'picklistValueMappings',
  'recordTypeMappings',
  'defaultValues',
  'truncateFields',
  'excludedObjects',
  'ignoredGaps',
] as const satisfies ReadonlyArray<keyof ForgeConfig>;

/** What a run carries that the form does not show (see `CARRIED_KEYS`). */
export type CarriedRunChoices = Partial<Pick<ForgeConfig, (typeof CARRIED_KEYS)[number]>>;

/** The choices `config` carries, only those it holds: none for no config. */
export function carriedChoices(config: StoredForgeConfig | ForgeConfig | null): CarriedRunChoices {
  const carried: CarriedRunChoices = {};
  if (!config) return carried;
  for (const key of CARRIED_KEYS) {
    if (config[key] !== undefined) Object.assign(carried, { [key]: config[key] });
  }
  return carried;
}

/** What a template is made of, as the results screen holds it. */
export interface RunToSave {
  /** Template id. */
  id: string;
  /** Name the user gave it. */
  name: string;
  /** Description the user gave it, possibly empty. */
  description: string;
  /** The run's configuration, org pair included. */
  config: ForgeConfig;
  /** Method per PII category the run was reviewed with. */
  anonymizationRules: Record<ForgeAnonymizationCategory, AnonymizationMethod>;
  /** Preset picked in Review, or '' for none. */
  anonymizationPresetId: string;
  /** Objects the run included. */
  objectCount: number;
  /** Records the run set out to clone. */
  recordCount: number;
  /** When it is saved, as an ISO 8601 timestamp. */
  savedAt: string;
  /**
   * The graph the run was reviewed on: which objects the user left out, and
   * which personal fields were anonymized on each.
   */
  graph?: ForgeGraph | null;
  /** The choice to copy the files, as Review held it; the acceptance is never kept. */
  fileCopy?: { enabled: boolean; maxFileSizeMB: number };
}

/**
 * The objects the run leaves out: those the user left out on the graph, and
 * those the config names that the graph holds no node of. A node put back in
 * is not left out, whatever the config said.
 */
function excludedOn(config: ForgeConfig, graph: ForgeGraph | null | undefined): string[] {
  if (!graph) return config.excludedObjects ?? [];
  const onGraph = new Set(graph.nodes.map((node) => node.objectApiName));
  return [
    ...(config.excludedObjects ?? []).filter((name) => !onGraph.has(name)),
    ...graph.nodes.filter((node) => node.leftOutByUser === true).map((n) => n.objectApiName),
  ];
}

/**
 * The template a run is saved as, from its results or from Review: its input,
 * scope options, the objects it leaves out and the decisions taken on its
 * gaps, its anonymization down to the fields, the choice to copy its files,
 * and the org it writes to. The source org is not kept — the record id or
 * query is the recipe; which org it is read from is picked again. Nor is a
 * simulation: whether a run only simulates is chosen run by run.
 */
export function templateFromRun(run: RunToSave): ForgeTemplate {
  const config = withoutOrgs(run.config);
  delete config.dryRun;
  const excluded = excludedOn(run.config, run.graph);
  if (excluded.length > 0) config.excludedObjects = excluded;
  else delete config.excludedObjects;
  const fields =
    run.graph && run.config.anonymizePII
      ? run.graph.nodes
          .filter((node) => node.piiFields.length > 0)
          .map((node) => ({
            objectApiName: node.objectApiName,
            fieldNames: [...node.anonymizeFields],
          }))
      : [];
  return {
    id: run.id,
    name: run.name.trim(),
    description: run.description.trim(),
    config,
    targetOrgId: run.config.targetOrgId,
    anonymization: {
      ...(run.anonymizationPresetId ? { presetId: run.anonymizationPresetId } : {}),
      rules: { ...run.anonymizationRules },
      ...(fields.length > 0 ? { fields } : {}),
    },
    ...(run.fileCopy?.enabled ? { files: { maxFileSizeMB: run.fileCopy.maxFileSizeMB } } : {}),
    objectCount: run.objectCount,
    recordCount: run.recordCount,
    createdAt: run.savedAt,
    lastUsedAt: run.savedAt,
  };
}
