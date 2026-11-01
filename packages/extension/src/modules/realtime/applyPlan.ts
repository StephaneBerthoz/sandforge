import type { RealTimeApplyObject, SyncConfig } from '@sandforge/shared';
import {
  fieldlessTransformRefusal,
  fieldlessTransformRules,
  unreadablePatternRefusal,
  unreadablePatternRules,
} from '@sandforge/shared';
import type { ApplyPlan } from './RealtimeApplier.js';

/** Mapping types that copy the source value as it is — the only ones a key can come through. */
const VERBATIM_TYPES = new Set(['direct', 'rename']);

/**
 * How the changes of an applied object are written, from what the user picked.
 *
 * The emails and phone numbers of an object found by its Id or an external id
 * follow the session's choice (`session.keepContactPoints`), and those of one
 * found by the mapping of a saved configuration that configuration's, which
 * its own runs follow. An object found by Id had no way to keep them: every
 * session neutralized it, whatever the user wanted of the copy.
 *
 * @param apply - The object, how its target record is found, and whether deletes apply.
 * @param loadConfig - Reads a saved Sync configuration by id.
 * @param orgs - The pair the session runs between.
 * @param session - What the session was asked beside its objects.
 * @throws {Error} When the saved configuration picked is gone, runs between
 *   other orgs, does not carry the object, or carries a transform rule on it
 *   that names no field or a Regex replace whose pattern is no regular
 *   expression, which a run of it refuses as well.
 */
export function applyPlanFor(
  apply: RealTimeApplyObject,
  loadConfig: (configId: string) => SyncConfig | undefined,
  orgs: { sourceOrgId: string; targetOrgId: string },
  session: { keepContactPoints?: boolean } = {},
): ApplyPlan {
  const base = {
    objectApiName: apply.objectApiName,
    fieldMappings: [],
    addOnFields: [],
    transformRules: [],
    applyDeletes: apply.applyDeletes,
  };
  const kept = session.keepContactPoints === true ? { keepContactPoints: true } : {};
  switch (apply.match.kind) {
    case 'id':
      return { ...base, keyField: 'Id', keySource: 'Id', ...kept };
    case 'externalId':
      return { ...base, keyField: apply.match.field, keySource: apply.match.field, ...kept };
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
      // Applied, such a rule would change every field of every change written.
      const fieldless = fieldlessTransformRules([entry]);
      if (fieldless.length > 0) {
        throw new Error(
          `${apply.objectApiName}: the saved Sync configuration "${config.name}" cannot be ` +
            `applied. ${fieldlessTransformRefusal(fieldless)}`,
        );
      }
      // Applied, such a rule would fail every change written with a bare SyntaxError.
      const unreadable = unreadablePatternRules([entry]);
      if (unreadable.length > 0) {
        throw new Error(
          `${apply.objectApiName}: the saved Sync configuration "${config.name}" cannot be ` +
            `applied. ${unreadablePatternRefusal(unreadable)}`,
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
        // A mapping renames its field and the others go as read: the fields
        // the configuration leaves out stay out, as its runs leave them.
        ...(entry.excludedFields?.length ? { excludedFields: entry.excludedFields } : {}),
        addOnFields: entry.addOnFields,
        transformRules: entry.transformRules,
        // The configuration's choice of the emails and phone numbers, which
        // its own runs neutralize unless it keeps them.
        ...(config.keepContactPoints === true ? { keepContactPoints: true } : {}),
      };
    }
  }
}
