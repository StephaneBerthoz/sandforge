import type { RealTimeApplyObject, SyncConfig } from '@sandforge/shared';
import type { ApplyPlan } from './RealtimeApplier.js';

/** Mapping types that copy the source value as it is — the only ones a key can come through. */
const VERBATIM_TYPES = new Set(['direct', 'rename']);

/**
 * How the changes of an applied object are written, from what the user picked.
 *
 * @param apply - The object, how its target record is found, and whether deletes apply.
 * @param loadConfig - Reads a saved Sync configuration by id.
 * @param orgs - The pair the session runs between.
 * @throws {Error} When the saved configuration picked is gone, runs between
 *   other orgs, or does not carry the object.
 */
export function applyPlanFor(
  apply: RealTimeApplyObject,
  loadConfig: (configId: string) => SyncConfig | undefined,
  orgs: { sourceOrgId: string; targetOrgId: string },
): ApplyPlan {
  const base = {
    objectApiName: apply.objectApiName,
    fieldMappings: [],
    addOnFields: [],
    transformRules: [],
    applyDeletes: apply.applyDeletes,
  };
  switch (apply.match.kind) {
    case 'id':
      return { ...base, keyField: 'Id', keySource: 'Id' };
    case 'externalId':
      return { ...base, keyField: apply.match.field, keySource: apply.match.field };
    case 'syncConfig': {
      const config = loadConfig(apply.match.configId);
      if (!config) {
        throw new Error(
          `${apply.objectApiName}: the saved Sync configuration picked no longer exists.`,
        );
      }
      if (config.sourceOrgId !== orgs.sourceOrgId || config.targetOrgId !== orgs.targetOrgId) {
        throw new Error(
          `${apply.objectApiName}: the saved Sync configuration "${config.name}" runs between ` +
            'two other orgs.',
        );
      }
      const entry = config.objects.find((o) => o.objectApiName === apply.objectApiName);
      if (!entry) {
        throw new Error(
          `${apply.objectApiName}: the saved Sync configuration "${config.name}" does not carry it.`,
        );
      }
      const keyField = entry.externalIdField?.trim() || 'Id';
      const keyMapping = entry.fieldMappings.find(
        (m) => m.targetField === keyField && VERBATIM_TYPES.has(m.type),
      );
      return {
        ...base,
        keyField,
        keySource: keyField === 'Id' ? 'Id' : (keyMapping?.sourceField ?? keyField),
        fieldMappings: entry.fieldMappings,
        addOnFields: entry.addOnFields,
        transformRules: entry.transformRules,
      };
    }
  }
}
