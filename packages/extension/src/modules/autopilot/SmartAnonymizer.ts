/**
 * SmartAnonymizer applies anonymization rules to records using 10 methods.
 * PersonaRegistry provides cross-object coherent fake data via keyed hashing.
 */

import { createHmac, randomBytes } from 'node:crypto';

import type {
  AnonymizationMethod,
  AutopilotAnonymizationRule,
  AnonymizedPersona,
  ApiName,
} from '@sandforge/shared';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Field name mapping from Salesforce API names to persona properties */
export const PERSONA_FIELD_MAP: Record<string, keyof AnonymizedPersona> = {
  FirstName: 'firstName',
  LastName: 'lastName',
  Email: 'email',
  Phone: 'phone',
  MobilePhone: 'phone',
  HomePhone: 'phone',
  MailingStreet: 'address',
  OtherStreet: 'address',
  BillingStreet: 'address',
  ShippingStreet: 'address',
  MailingCity: 'city',
  OtherCity: 'city',
  BillingCity: 'city',
  ShippingCity: 'city',
  MailingPostalCode: 'postalCode',
  OtherPostalCode: 'postalCode',
  BillingPostalCode: 'postalCode',
  ShippingPostalCode: 'postalCode',
  Company: 'company',
  CompanyName: 'company',
  Name: 'company',
};

/**
 * Keyed Fisher-Yates permutation of the characters of `value`.
 *
 * The swap sequence comes from an HMAC keystream, so the permutation cannot be
 * reproduced — and therefore cannot be undone — without `key`. Seeding from the
 * value itself makes the shuffle a public function of its own input: anyone
 * holding the anonymized data can recompute the permutation and invert it, so
 * the value is not protected at all. Deterministic for the same `value` and
 * `key`, so re-running a dataset still produces the same output.
 *
 * A permutation preserves the multiset of characters no matter how it is
 * derived, so `shuffle` stays the weakest method on offer: it hides ordering,
 * not content. Prefer `fake` or `hash` for anything that identifies a person.
 */
export function keyedShuffle(value: string, key: string): string {
  const chars = value.split('');
  if (chars.length < 2) {
    return value;
  }
  // 4 bytes per swap: modulo bias against a 2^32 range is negligible here.
  const stream = keystream(key, value, 4 * (chars.length - 1));
  for (let i = chars.length - 1, offset = 0; i > 0; i--, offset += 4) {
    const j = stream.readUInt32BE(offset) % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** HMAC-SHA256 in counter mode: `byteLength` bytes derived from `key` and `seed`. */
function keystream(key: string, seed: string, byteLength: number): Buffer {
  const blocks: Buffer[] = [];
  while (blocks.length * 32 < byteLength) {
    blocks.push(createHmac('sha256', key).update(`${blocks.length}:${seed}`).digest());
  }
  return Buffer.concat(blocks).subarray(0, byteLength);
}

/**
 * A non-negative 31-bit integer drawn from HMAC-SHA256 of `seed` under `key`.
 *
 * Every value SmartAnonymizer invents is picked with one of these, so the pick
 * cannot be recomputed from the original without the key.
 */
function keyedSeed(key: string, seed: string): number {
  return createHmac('sha256', key).update(seed).digest().readUInt32BE(0) & 0x7fffffff;
}

/**
 * Given names a persona draws from: a hundred neutral English ones.
 *
 * Twenty given names and twenty surnames made four hundred people, and a
 * persona's address is its name: a run over 1 220 contacts could not give them
 * all a name or an address of their own, and 'Taylor' was on both lists.
 */
const FIRST_NAMES = (
  'Alex Jordan Morgan Casey Riley Quinn Avery Parker Reese Dakota Skyler Sage River Hayden ' +
  'Emery Finley Blake Charlie Drew Rowan Jamie Robin Kendall Logan Peyton Cameron Jesse Kai ' +
  'Arden Bailey Blair Brook Carson Corey Devon Eden Ellis Emerson Frankie Gray Harper Jules ' +
  'Jody Kerry Lane Leslie Linden Marley Micah Nico Noel Oakley Perry Quincy Reagan Remy Rory ' +
  'Sam Sasha Shawn Spencer Sutton Tatum Terry Toby Tracy Val Wren Wynn Adair Alden Ainsley ' +
  'Billie Briar Cass Dale Darcy Ellery Emory Fallon Glenn Hollis Ira Jaden Kit Lennon Lou ' +
  'Mackenzie Monroe Nova Palmer Presley Ridley Sawyer Scout Shay Sloane Tanner Teagan Winter'
).split(' ');

/**
 * Surnames a persona draws from: a hundred made-up ones, each a first part and
 * an ending, none of them a given name above.
 */
const LAST_NAMES = [
  'Ash',
  'Birch',
  'Brook',
  'Clay',
  'Fern',
  'Hazel',
  'Lark',
  'Marsh',
  'Oak',
  'Thorn',
].flatMap((first) =>
  ['bury', 'combe', 'dale', 'field', 'ford', 'gate', 'ridge', 'stone', 'ton', 'wood'].map(
    (ending) => `${first}${ending}`,
  ),
);

/**
 * How many times a persona draws again when its name, or its address, is one
 * the registry already gave. Past ten thousand records the names run out, and
 * a name is given twice rather than drawn for ever; the address still differs
 * by its token.
 */
const MAX_REDRAWS = 32;

/** The name a pick gives. */
function nameOf(hash: number): { firstName: string; lastName: string } {
  return {
    firstName: FIRST_NAMES[hash % FIRST_NAMES.length],
    lastName: LAST_NAMES[(hash >> 8) % LAST_NAMES.length],
  };
}

/** A persona's name as one string, `First Last`, as the registry tells two apart by it. */
function fullName(name: { firstName: string; lastName: string }): string {
  return `${name.firstName} ${name.lastName}`;
}

/** Registry of deterministic fake personas for cross-object coherence. */
export class PersonaRegistry {
  private readonly personas = new Map<string, AnonymizedPersona>();

  /** Full names already given: two records of a run are not one person while names last. */
  private readonly namesGiven = new Set<string>();

  /** Addresses already given: two records of a run never share one. */
  private readonly emailsGiven = new Set<string>();

  /** HMAC key the persona picks are drawn with. See the constructor. */
  private readonly key: string;

  /**
   * @param key - HMAC key for choosing a record's persona. When omitted, a
   *   random per-instance key is generated: a record keeps its persona for the
   *   life of the registry, and gets another one in the next run. Pass the same
   *   key to get the same personas across runs.
   */
  constructor(key?: string) {
    this.key = key ?? randomBytes(32).toString('hex');
  }

  private readonly cities = [
    'Springfield',
    'Riverside',
    'Fairview',
    'Greenville',
    'Franklin',
    'Clinton',
    'Madison',
    'Georgetown',
    'Arlington',
    'Salem',
  ];

  private readonly streets = [
    'Main St',
    'Oak Ave',
    'Elm St',
    'Park Dr',
    'Cedar Ln',
    'Pine Rd',
    'Maple Way',
    'Lake Blvd',
  ];

  private readonly companies = [
    'Acme Corp',
    'Global Tech',
    'Sunrise Inc',
    'Horizon Ltd',
    'Evergreen Co',
    'Summit Group',
    'Atlas Partners',
    'Apex Solutions',
    'Nova Industries',
    'Pinnacle LLC',
  ];

  /**
   * Get or create a persona for a source record ID.
   *
   * The pick is keyed: an unkeyed hash of the id gives every installation the
   * same persona for the same record, so a fake name can be traced back to its
   * record by anyone who can list candidate ids.
   *
   * A name the registry already gave is drawn again (`persona:<id>:<n>`), so
   * the records of one run are as many people as there are records, up to the
   * ten thousand names there are. The registry lives for one run: which record
   * draws again follows the order the run reads them in, and the same ordered
   * run gives the same people. The address carries a short token keyed on the
   * id, `first.last.ab12`, so it is unlike every other one the registry gave,
   * and very likely unlike those of another run.
   * @param sourceRecordId - The Salesforce record ID
   * @returns A coherent fake persona
   */
  getPersona(sourceRecordId: string): AnonymizedPersona {
    const existing = this.personas.get(sourceRecordId);
    if (existing) {
      return existing;
    }

    let hash = keyedSeed(this.key, `persona:${sourceRecordId}`);
    for (let n = 1; n <= MAX_REDRAWS && this.namesGiven.has(fullName(nameOf(hash))); n++) {
      hash = keyedSeed(this.key, `persona:${sourceRecordId}:${n}`);
    }
    const { firstName, lastName } = nameOf(hash);
    this.namesGiven.add(fullName({ firstName, lastName }));
    const city = this.cities[(hash >> 16) % this.cities.length];

    const persona: AnonymizedPersona = {
      sourceRecordId,
      firstName,
      lastName,
      email: this.emailFor(firstName, lastName, sourceRecordId),
      phone: `+1-555-${String((hash % 900) + 100).padStart(3, '0')}-${String(((hash >> 4) % 9000) + 1000).padStart(4, '0')}`,
      address: `${(hash % 999) + 1} ${this.streets[(hash >> 12) % this.streets.length]}`,
      city,
      postalCode: String((hash % 90000) + 10000),
      company: this.companies[(hash >> 20) % this.companies.length],
    };

    this.personas.set(sourceRecordId, persona);
    return persona;
  }

  /**
   * A persona's address: its name and four hex digits keyed on the record id,
   * drawn again while the registry already gave the address.
   */
  private emailFor(firstName: string, lastName: string, sourceRecordId: string): string {
    const local = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
    let email = '';
    for (let n = 0; n <= MAX_REDRAWS; n++) {
      const seed = n === 0 ? `email:${sourceRecordId}` : `email:${sourceRecordId}:${n}`;
      const token = (keyedSeed(this.key, seed) & 0xffff).toString(16).padStart(4, '0');
      email = `${local}.${token}@example.com`;
      if (!this.emailsGiven.has(email)) break;
    }
    this.emailsGiven.add(email);
    return email;
  }

  /** Get count of registered personas. */
  get size(): number {
    return this.personas.size;
  }

  /** Clear all personas. */
  clear(): void {
    this.personas.clear();
    this.namesGiven.clear();
    this.emailsGiven.clear();
  }
}

/**
 * Applies anonymization rules to records using 10 methods.
 * Uses PersonaRegistry for cross-object coherent fake data.
 */
export class SmartAnonymizer {
  private readonly personaRegistry: PersonaRegistry;

  /** HMAC key for the `hash` method. See the constructor for the fallback. */
  private readonly hashSalt: string;

  /**
   * @param personaRegistry - Shared registry for cross-object coherent fakes.
   *   When omitted, one keyed with the salt is created, so the same salt gives
   *   the same personas. A registry passed in keeps its own key.
   * @param hashSalt - HMAC key for every method that derives its output from
   *   the value or the record id: `hash`, `shuffle`, `preserve_format` and the
   *   `fake` fallback. When omitted, a random per-instance key is generated:
   *   outputs stay consistent within a run (so foreign keys still join) but
   *   differ between runs. Pass an explicit salt when you need the same input to
   *   map to the same output across runs. There is deliberately no fixed
   *   default — a hardcoded key would make every installation's outputs
   *   interchangeable and reversible by lookup table.
   */
  constructor(personaRegistry?: PersonaRegistry, hashSalt?: string) {
    this.hashSalt = hashSalt ?? randomBytes(32).toString('hex');
    this.personaRegistry = personaRegistry ?? new PersonaRegistry(this.hashSalt);
  }

  /** Get the persona registry for inspection/testing. */
  getPersonaRegistry(): PersonaRegistry {
    return this.personaRegistry;
  }

  /**
   * Anonymize a batch of records according to the rules.
   * @param records - Records to anonymize (mutated in place)
   * @param rules - Anonymization rules to apply (filtered for this object)
   * @param objectApiName - The object being anonymized
   * @returns The anonymized records
   */
  anonymize(
    records: Record<string, unknown>[],
    rules: AnonymizationRule[],
    objectApiName: ApiName,
  ): Record<string, unknown>[] {
    const objectRules = rules.filter((r) => r.objectApiName === objectApiName);
    if (objectRules.length === 0) {
      return records;
    }

    for (const record of records) {
      const recordId = String(record['Id'] ?? record['id'] ?? '');
      for (const rule of objectRules) {
        const value = record[rule.fieldApiName];
        if (value === null || value === undefined) {
          continue;
        }
        record[rule.fieldApiName] = this.applyMethod(
          rule.method,
          String(value),
          rule.fieldApiName,
          recordId,
        );
      }
    }

    return records;
  }

  /** Apply a single anonymization method to a value. */
  private applyMethod(
    method: AnonymizationMethod,
    value: string,
    fieldApiName: string,
    recordId: string,
  ): unknown {
    switch (method) {
      case 'fake':
        return this.applyFake(value, fieldApiName, recordId);
      case 'mask':
        return this.applyMask(value);
      case 'hash':
        return this.applyHash(value);
      case 'nullify':
        return null;
      case 'redact':
        return '[REDACTED]';
      case 'shuffle':
        return this.applyShuffle(value);
      case 'truncate':
        return this.applyTruncate();
      case 'preserve_format':
        return this.applyPreserveFormat(value);
      case 'age_band':
        return this.applyAgeBand(value);
      case 'generalize':
        return this.applyGeneralize(value, fieldApiName);
      case 'constant':
        return '';
    }
  }

  /**
   * Fake: use PersonaRegistry, match field name to persona property.
   * Falls back to generic fake string if field not mapped.
   */
  private applyFake(_value: string, fieldApiName: string, recordId: string): string {
    const persona = this.personaRegistry.getPersona(recordId);
    const personaKey = PERSONA_FIELD_MAP[fieldApiName];
    if (personaKey) {
      return persona[personaKey];
    }
    // Fallback: a fixed-width token keyed with the salt, so it cannot be
    // matched back to a record id by recomputing it.
    const token = createHmac('sha256', this.hashSalt)
      .update(`fake:${fieldApiName}:${recordId}`)
      .digest('hex');
    return `fake_${token.slice(0, 8)}`;
  }

  /**
   * Mask: show last 4 characters, replace the rest with asterisks.
   * Short values (<=4 chars) are fully masked.
   */
  private applyMask(value: string): string {
    if (value.length <= 4) {
      return '*'.repeat(value.length);
    }
    return '*'.repeat(value.length - 4) + value.slice(-4);
  }

  /**
   * Hash: keyed HMAC-SHA256 over the value, truncated to 32 hex chars.
   *
   * Keyed rather than a bare digest because the inputs are low-entropy PII —
   * an unkeyed hash of an email or a phone number is recovered by enumeration.
   * The same holds for every value invented from the original: a replacement
   * that is a public function of the original can be checked against a list
   * of candidates, so persona picks and format-preserving output are keyed too.
   */
  private applyHash(value: string): string {
    return createHmac('sha256', this.hashSalt).update(value).digest('hex').slice(0, 32);
  }

  /**
   * Shuffle: randomize character order, keyed by the instance salt.
   *
   * The seed is the salt rather than the value: a permutation derived from the
   * value alone is one anybody can recompute from the anonymized output and run
   * backwards.
   */
  private applyShuffle(value: string): string {
    return keyedShuffle(value, this.hashSalt);
  }

  /**
   * Truncate: keep the last N characters — and N is 0 here.
   *
   * The opening characters of a name, an email local part or a record id are
   * the identifying ones — halving "Alexander" leaves "Alex" standing — so a
   * kept prefix is not anonymization. A suffix discloses far less, but autopilot
   * rules carry no per-rule config, so there is no N to honour here and the safe
   * default applies: keep nothing.
   */
  private applyTruncate(): string {
    return '';
  }

  /**
   * Preserve format: replace characters with same-type characters.
   * Digits become random digits, letters become random letters.
   * Keeps separators (spaces, dashes, dots, etc.) intact.
   *
   * The sequence is seeded with the salt: seeded from the value alone, a phone
   * number or a national id is confirmed by running candidates through it.
   */
  private applyPreserveFormat(value: string): string {
    let seed = keyedSeed(this.hashSalt, `preserve_format:${value}`);
    return value
      .split('')
      .map((ch) => {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        if (/[0-9]/.test(ch)) {
          return String(seed % 10);
        }
        if (/[A-Z]/.test(ch)) {
          return String.fromCharCode(65 + (seed % 26));
        }
        if (/[a-z]/.test(ch)) {
          return String.fromCharCode(97 + (seed % 26));
        }
        return ch;
      })
      .join('');
  }

  /**
   * Age band: parse a date and return a decade range like "1980-1989".
   * Falls back to "Unknown" if the date cannot be parsed.
   */
  private applyAgeBand(value: string): string {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return 'Unknown';
    }
    const year = date.getFullYear();
    const decadeStart = Math.floor(year / 10) * 10;
    return `${decadeStart}-${decadeStart + 9}`;
  }

  /**
   * Generalize: reduce specificity of data.
   * - Email: keep only domain (user@domain -> ***@domain)
   * - Phone-like: keep country code, mask rest
   * - Location fields: return first word (city-level)
   * - Default: return first word or truncate
   */
  private applyGeneralize(value: string, fieldApiName: string): string {
    // Email pattern
    if (value.includes('@')) {
      const parts = value.split('@');
      return `***@${parts[parts.length - 1]}`;
    }

    // Phone-like: starts with + or contains mostly digits
    const digitCount = (value.match(/\d/g) ?? []).length;
    if (value.startsWith('+') || digitCount > value.length / 2) {
      return value.slice(0, Math.min(3, value.length)) + '-***';
    }

    // Location fields: return just first word
    const lowerField = fieldApiName.toLowerCase();
    if (
      lowerField.includes('street') ||
      lowerField.includes('address') ||
      lowerField.includes('city') ||
      lowerField.includes('state')
    ) {
      const firstWord = value.split(/\s+/)[0];
      return firstWord ?? value;
    }

    // Default: first word or truncated
    const words = value.split(/\s+/);
    if (words.length > 1) {
      return `${words[0]} ...`;
    }
    return value.slice(0, Math.max(1, Math.ceil(value.length / 2)));
  }
}
