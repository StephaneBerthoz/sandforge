import type { SyncOperation } from '@sandforge/shared';
import type { ObjectSetEntry } from './ObjectSetEditor';

/** The objects of a configuration as it came over the bridge, each one that names its object. */
export function configObjects(config: Record<string, unknown>): Array<Record<string, unknown>> {
  const objects = config.objects;
  if (!Array.isArray(objects)) return [];
  return objects.filter(
    (raw): raw is Record<string, unknown> =>
      typeof raw === 'object' && raw !== null && typeof raw.objectApiName === 'string',
  );
}

/**
 * What a row of the object set shows of an object of a configuration: the
 * Migration page's editor, and the execute step of a saved configuration
 * Sync opens, which says what each object does as Review does.
 */
export function objectSetEntryOf(obj: Record<string, unknown>): ObjectSetEntry {
  return {
    objectApiName: String(obj.objectApiName),
    operation: (typeof obj.operation === 'string' ? obj.operation : 'insert') as SyncOperation,
    externalIdField: typeof obj.externalIdField === 'string' ? obj.externalIdField : '',
    batchSize: typeof obj.batchSize === 'number' ? obj.batchSize : 200,
    where: typeof obj.where === 'string' ? obj.where : '',
  };
}
