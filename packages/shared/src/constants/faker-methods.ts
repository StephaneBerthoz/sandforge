/**
 * The faker methods Seed generates a value for, and the faker.js spellings it
 * reads as one of them.
 *
 * One list serves every place that names a method: the generator, the
 * validator that refuses a template before its first insert, the wizard's
 * method picker and the prompt that asks a model to write a persona. A method
 * missing from it used to pass every check up to the generator, which threw
 * after the objects before it had already been written to the org.
 */

/** Method names the generator implements. */
export const SUPPORTED_FAKER_METHODS = [
  'name',
  'firstName',
  'lastName',
  'jobTitle',
  'email',
  'phone',
  'address',
  'streetAddress',
  'city',
  'state',
  'zipCode',
  'country',
  'company',
  'catchPhrase',
  'productName',
  'productDescription',
  'date',
  'pastDate',
  'futureDate',
  'number',
  'integer',
  'float',
  'boolean',
  'lorem',
  'sentence',
  'paragraph',
  'uuid',
  'url',
  'iban',
  'bic',
] as const;

/** A method name the generator implements. */
export type FakerMethodName = (typeof SUPPORTED_FAKER_METHODS)[number];

/**
 * faker.js-style names (`namespace.method`) mapped to the method that
 * generates them. Built-in personas, AI-written personas and the prebuilt
 * templates all quote the faker.js spelling.
 */
export const FAKER_METHOD_ALIASES: Readonly<Record<string, FakerMethodName>> = {
  'company.name': 'company',
  'company.catchPhrase': 'catchPhrase',
  'person.firstName': 'firstName',
  'person.lastName': 'lastName',
  'person.fullName': 'name',
  'person.jobTitle': 'jobTitle',
  'name.firstName': 'firstName',
  'name.lastName': 'lastName',
  'internet.email': 'email',
  'internet.url': 'url',
  'phone.number': 'phone',
  'location.city': 'city',
  'location.country': 'country',
  'location.state': 'state',
  'location.zipCode': 'zipCode',
  'location.streetAddress': 'streetAddress',
  'lorem.sentence': 'sentence',
  'lorem.paragraph': 'paragraph',
  'string.uuid': 'uuid',
  'date.past': 'pastDate',
  'date.future': 'futureDate',
  'date.soon': 'futureDate',
  'commerce.productName': 'productName',
  'commerce.productDescription': 'productDescription',
  'finance.iban': 'iban',
  'finance.bic': 'bic',
};

const SUPPORTED = new Set<string>(SUPPORTED_FAKER_METHODS);

/**
 * The method a name stands for — itself when the generator implements it,
 * its target when it is a known faker.js spelling — or undefined when nothing
 * generates it.
 */
export function resolveFakerMethod(method: string): FakerMethodName | undefined {
  if (SUPPORTED.has(method)) return method as FakerMethodName;
  // Own keys only: 'constructor' or 'toString' must not resolve to a method.
  return Object.prototype.hasOwnProperty.call(FAKER_METHOD_ALIASES, method)
    ? FAKER_METHOD_ALIASES[method]
    : undefined;
}
