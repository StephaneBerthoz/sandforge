import type { FieldRule } from '@sandforge/shared';

/** Supported faker method names */
export type FakerMethodName =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'country'
  | 'company'
  | 'date'
  | 'pastDate'
  | 'futureDate'
  | 'number'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'lorem'
  | 'sentence'
  | 'paragraph'
  | 'uuid'
  | 'url'
  | 'zipCode';

/** Configuration for number generation ranges */
interface NumberRange {
  min: number;
  max: number;
}

/**
 * Generates data records using deterministic faker-like methods.
 * Maps fakerMethod strings from field rules to generation functions
 * for reproducible test data without an AI dependency.
 */
export class FakerFallback {
  /**
   * Generate records from field rules using faker-style generation.
   * Each field rule with ruleType 'faker' uses its config.fakerMethod
   * to select the appropriate generator.
   */
  generate(fieldRules: FieldRule[], count: number): Record<string, unknown>[] {
    if (count <= 0 || fieldRules.length === 0) {
      return [];
    }

    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < count; i++) {
      const record: Record<string, unknown> = {};
      for (const rule of fieldRules) {
        record[rule.fieldApiName] = this.generateFieldValue(rule, i);
      }
      records.push(record);
    }

    return records;
  }

  /**
   * Generate a single field value based on the rule's faker method.
   */
  private generateFieldValue(rule: FieldRule, index: number): unknown {
    const method = rule.config.fakerMethod ?? 'lorem';
    const range: NumberRange = {
      min: rule.config.minValue ?? 0,
      max: rule.config.maxValue ?? 1000,
    };

    return generateByMethod(method, index, range);
  }
}

/**
 * Generate a value using the specified faker method name.
 * Falls back to a lorem-style string for unrecognized methods.
 */
export function generateByMethod(
  method: string,
  index: number,
  range: NumberRange
): unknown {
  switch (method) {
    case 'name':
      return generateName(index);
    case 'firstName':
      return generateFirstName(index);
    case 'lastName':
      return generateLastName(index);
    case 'email':
      return generateEmail(index);
    case 'phone':
      return generatePhone(index);
    case 'address':
      return generateAddress(index);
    case 'city':
      return generateCity(index);
    case 'country':
      return generateCountry(index);
    case 'company':
      return generateCompany(index);
    case 'date':
    case 'pastDate':
      return generatePastDate(index);
    case 'futureDate':
      return generateFutureDate(index);
    case 'number':
    case 'integer':
      return generateInteger(range);
    case 'float':
      return generateFloat(range);
    case 'boolean':
      return index % 2 === 0;
    case 'lorem':
    case 'sentence':
      return generateSentence(index);
    case 'paragraph':
      return generateParagraph(index);
    case 'uuid':
      return generateUUID(index);
    case 'url':
      return `https://example.com/resource/${index}`;
    case 'zipCode':
      return generateZipCode(index);
    default:
      return generateSentence(index);
  }
}

const FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Eve',
  'Frank', 'Grace', 'Hank', 'Ivy', 'Jack',
  'Kate', 'Leo', 'Mia', 'Noah', 'Olivia',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones',
  'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
];

const CITIES = [
  'New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix',
  'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'Austin',
];

const COUNTRIES = [
  'United States', 'Canada', 'United Kingdom', 'France', 'Germany',
  'Japan', 'Australia', 'Brazil', 'India', 'Mexico',
];

const COMPANIES = [
  'Acme Corp', 'Globex Inc', 'Initech', 'Umbrella Corp', 'Stark Industries',
  'Wayne Enterprises', 'Cyberdyne Systems', 'Oscorp', 'LexCorp', 'Massive Dynamic',
];

function generateFirstName(index: number): string {
  return FIRST_NAMES[index % FIRST_NAMES.length];
}

function generateLastName(index: number): string {
  return LAST_NAMES[index % LAST_NAMES.length];
}

function generateName(index: number): string {
  return `${generateFirstName(index)} ${generateLastName(index)}`;
}

function generateEmail(index: number): string {
  const first = generateFirstName(index).toLowerCase();
  const last = generateLastName(index).toLowerCase();
  return `${first}.${last}${index}@example.com`;
}

function generatePhone(index: number): string {
  const area = 200 + (index % 800);
  const mid = 200 + ((index * 7) % 800);
  const last = 1000 + (index % 9000);
  return `(${area}) ${mid}-${last}`;
}

function generateAddress(index: number): string {
  const number = 100 + index;
  const streets = ['Main St', 'Oak Ave', 'Elm St', 'Park Blvd', 'Cedar Ln'];
  return `${number} ${streets[index % streets.length]}`;
}

function generateCity(index: number): string {
  return CITIES[index % CITIES.length];
}

function generateCountry(index: number): string {
  return COUNTRIES[index % COUNTRIES.length];
}

function generateCompany(index: number): string {
  return COMPANIES[index % COMPANIES.length];
}

function generatePastDate(index: number): string {
  const base = new Date('2024-01-01');
  base.setDate(base.getDate() - index);
  return base.toISOString().split('T')[0];
}

function generateFutureDate(index: number): string {
  const base = new Date('2026-01-01');
  base.setDate(base.getDate() + index);
  return base.toISOString().split('T')[0];
}

function generateInteger(range: NumberRange): number {
  return Math.floor(range.min + Math.random() * (range.max - range.min + 1));
}

function generateFloat(range: NumberRange): number {
  const value = range.min + Math.random() * (range.max - range.min);
  return Math.round(value * 100) / 100;
}

function generateSentence(index: number): string {
  const words = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit'];
  const start = index % words.length;
  const sentence = [];
  for (let i = 0; i < 6; i++) {
    sentence.push(words[(start + i) % words.length]);
  }
  return sentence.join(' ') + '.';
}

function generateParagraph(index: number): string {
  return [
    generateSentence(index),
    generateSentence(index + 1),
    generateSentence(index + 2),
  ].join(' ');
}

function generateUUID(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function generateZipCode(index: number): string {
  return String(10000 + (index % 90000));
}
