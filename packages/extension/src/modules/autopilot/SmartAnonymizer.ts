/**
 * SmartAnonymizer applies anonymization rules to records using 10 methods.
 * PersonaRegistry provides cross-object coherent fake data via deterministic hashing.
 */

import type {
  AnonymizationMethod,
  AutopilotAnonymizationRule,
  AnonymizedPersona,
  ApiName,
} from '@sandforge/shared';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

/** Field name mapping from Salesforce API names to persona properties */
const PERSONA_FIELD_MAP: Record<string, keyof AnonymizedPersona> = {
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

/** Registry of deterministic fake personas for cross-object coherence. */
export class PersonaRegistry {
  private readonly personas = new Map<string, AnonymizedPersona>();

  private readonly firstNames = [
    'Alex',
    'Jordan',
    'Taylor',
    'Morgan',
    'Casey',
    'Riley',
    'Quinn',
    'Avery',
    'Parker',
    'Reese',
    'Dakota',
    'Skyler',
    'Sage',
    'River',
    'Hayden',
    'Emery',
    'Finley',
    'Blake',
    'Charlie',
    'Drew',
  ];

  private readonly lastNames = [
    'Smith',
    'Johnson',
    'Williams',
    'Brown',
    'Jones',
    'Garcia',
    'Miller',
    'Davis',
    'Rodriguez',
    'Martinez',
    'Anderson',
    'Taylor',
    'Thomas',
    'Moore',
    'Jackson',
    'Martin',
    'Lee',
    'White',
    'Harris',
    'Clark',
  ];

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
   * Deterministic hash ensures same persona for same ID.
   * @param sourceRecordId - The Salesforce record ID
   * @returns A coherent fake persona
   */
  getPersona(sourceRecordId: string): AnonymizedPersona {
    const existing = this.personas.get(sourceRecordId);
    if (existing) {
      return existing;
    }

    const hash = this.simpleHash(sourceRecordId);
    const firstName = this.firstNames[hash % this.firstNames.length];
    const lastName = this.lastNames[(hash >> 8) % this.lastNames.length];
    const city = this.cities[(hash >> 16) % this.cities.length];

    const persona: AnonymizedPersona = {
      sourceRecordId,
      firstName,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      phone: `+1-555-${String((hash % 900) + 100).padStart(3, '0')}-${String(((hash >> 4) % 9000) + 1000).padStart(4, '0')}`,
      address: `${(hash % 999) + 1} ${this.streets[(hash >> 12) % this.streets.length]}`,
      city,
      postalCode: String((hash % 90000) + 10000),
      company: this.companies[(hash >> 20) % this.companies.length],
    };

    this.personas.set(sourceRecordId, persona);
    return persona;
  }

  /** Simple deterministic hash for a string. */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /** Get count of registered personas. */
  get size(): number {
    return this.personas.size;
  }

  /** Clear all personas. */
  clear(): void {
    this.personas.clear();
  }
}

/**
 * Applies anonymization rules to records using 10 methods.
 * Uses PersonaRegistry for cross-object coherent fake data.
 */
export class SmartAnonymizer {
  private readonly personaRegistry: PersonaRegistry;

  constructor(personaRegistry?: PersonaRegistry) {
    this.personaRegistry = personaRegistry ?? new PersonaRegistry();
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
        return this.applyTruncate(value);
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
    // Fallback: return a deterministic fake based on field name + record ID
    const hash = this.simpleHash(`${fieldApiName}:${recordId}`);
    return `fake_${hash.toString(16).slice(0, 8)}`;
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

  /** Hash: deterministic hex string from value. */
  private applyHash(value: string): string {
    const hash = this.simpleHash(value);
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * Shuffle: randomize character order using deterministic seed.
   * Uses Fisher-Yates with seeded pseudo-random for reproducibility.
   */
  private applyShuffle(value: string): string {
    const chars = value.split('');
    let seed = this.simpleHash(value);
    for (let i = chars.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
      const j = seed % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  /** Truncate: reduce to approximately half length, minimum 1 character. */
  private applyTruncate(value: string): string {
    return value.slice(0, Math.max(1, Math.floor(value.length / 2)));
  }

  /**
   * Preserve format: replace characters with same-type characters.
   * Digits become random digits, letters become random letters.
   * Keeps separators (spaces, dashes, dots, etc.) intact.
   */
  private applyPreserveFormat(value: string): string {
    let seed = this.simpleHash(value);
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

  /** Simple deterministic hash for a string. */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }
}
