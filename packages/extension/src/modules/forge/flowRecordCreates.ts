/**
 * The objects a flow's record-create elements create, read from the metadata
 * of its version (`Flow.Metadata` over the Tooling API), a process's as a
 * flow's.
 *
 * A Forge clone into a client sandbox made a Case flow there "clone the
 * insured risk" into a new Asset for each case it wrote, as the run's user:
 * dozens of assets no removal of the run took back, as no remap held them. A
 * sweep of what the target's automation created looks in the objects its
 * flows create, and reads them here.
 *
 * An element that sets the new record's fields names its object (`object`);
 * one that creates the record a variable holds (`inputReference`) names the
 * variable, whose `objectType` says the object — a collection's as well.
 */

/** An API name as the org writes one: a custom object's, a namespace's included. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The value of `key` on what may be an object, undefined otherwise. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** What may be a list of objects, as a list; none for anything else. */
function listOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item)
    : [];
}

/** A string that is an API name, or undefined. */
function apiName(value: unknown): string | undefined {
  return typeof value === 'string' && API_NAME_RE.test(value) ? value : undefined;
}

/**
 * The objects the record-create elements of a flow's metadata create, each
 * once, in the order the elements name them; none when the metadata holds no
 * such element, or is not metadata at all.
 */
export function recordCreatesOf(metadata: unknown): string[] {
  const objectOfVariable = new Map<string, string>();
  for (const variable of listOf(field(metadata, 'variables'))) {
    const name = variable.name;
    const object = apiName(variable.objectType);
    if (typeof name === 'string' && object) objectOfVariable.set(name.toLowerCase(), object);
  }
  const created: string[] = [];
  for (const element of listOf(field(metadata, 'recordCreates'))) {
    const reference = element.inputReference;
    const object =
      apiName(element.object) ??
      (typeof reference === 'string' ? objectOfVariable.get(reference.toLowerCase()) : undefined);
    if (object && !created.some((name) => name.toLowerCase() === object.toLowerCase())) {
      created.push(object);
    }
  }
  return created;
}
