/**
 * Build the Streaming API CDC channel name for a given Salesforce entity.
 *
 * - Standard objects: `Account` -> `/data/AccountChangeEvent`
 * - Custom objects: `MyObj__c` -> `/data/MyObj__ChangeEvent`
 *   (replaces trailing `__c` suffix with `__ChangeEvent`)
 * - Namespaced custom objects: `ns__MyObj__c` -> `/data/ns__MyObj__ChangeEvent`
 *
 * @param entityName - Salesforce object API name (e.g. `Account`, `MyObj__c`)
 * @returns The CDC Streaming API channel path
 */
export function buildCdcChannel(entityName: string): string {
  if (entityName.endsWith('__c')) {
    const base = entityName.slice(0, -3);
    return `/data/${base}__ChangeEvent`;
  }
  return `/data/${entityName}ChangeEvent`;
}
