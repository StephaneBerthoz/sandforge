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
}

/**
 * The template a finished run is saved as: its input, scope options and
 * anonymization, and the org it wrote to. The source org is not kept — the
 * record id or query is the recipe; which org it is read from is picked again.
 */
export function templateFromRun(run: RunToSave): ForgeTemplate {
  return {
    id: run.id,
    name: run.name.trim(),
    description: run.description.trim(),
    config: withoutOrgs(run.config),
    targetOrgId: run.config.targetOrgId,
    anonymization: {
      ...(run.anonymizationPresetId ? { presetId: run.anonymizationPresetId } : {}),
      rules: { ...run.anonymizationRules },
    },
    objectCount: run.objectCount,
    recordCount: run.recordCount,
    createdAt: run.savedAt,
    lastUsedAt: run.savedAt,
  };
}
