/**
 * The labels of an org's objects, by API name, as a describe the page already
 * holds gives them: Seed's object list, Forge's graph.
 */
export type ObjectLabels = ReadonlyMap<string, string>;

/**
 * How a sentence names an object: its label where the page holds one, else
 * its API name. "Open a created Invoice__c": a custom object's API name, its
 * suffix included, stood in prose where the org's own pages say Invoice.
 */
export function objectLabelOf(objectApiName: string, labels?: ObjectLabels): string {
  const label = labels?.get(objectApiName)?.trim();
  return label ? label : objectApiName;
}

/** The labels of the objects a describe listed, by API name; an object it gave no label is left out. */
export function objectLabelsOf(
  described: Iterable<{ apiName: string; label?: string | undefined }>,
): ObjectLabels {
  const labels = new Map<string, string>();
  for (const { apiName, label } of described) {
    if (label && label.trim() !== '' && !labels.has(apiName)) labels.set(apiName, label.trim());
  }
  return labels;
}
