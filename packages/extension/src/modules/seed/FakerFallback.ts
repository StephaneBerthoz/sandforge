import type { FieldRule } from '@sandforge/shared';
import { getLocaleData, formatPhone } from './LocaleData';
import type { LocaleDataSet } from './LocaleData';
import { GeoCoherentGenerator } from './GeoCoherentGenerator';

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
  | 'state'
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
 * Supports locale-aware generation for culturally-appropriate data
 * and geo-coherent address tuples.
 */
export class FakerFallback {
  private locale: string;
  private localeData: LocaleDataSet;
  private geoGenerator: GeoCoherentGenerator;

  /**
   * Create a new FakerFallback instance.
   * @param locale - Locale for data generation (e.g. 'fr_FR'). Defaults to 'en_US'.
   */
  constructor(locale?: string) {
    this.locale = locale ?? 'en_US';
    this.localeData = getLocaleData(this.locale);
    this.geoGenerator = new GeoCoherentGenerator(this.locale);
  }

  /**
   * Change the locale for subsequent generations.
   * @param locale - New locale string
   */
  setLocale(locale: string): void {
    this.locale = locale;
    this.localeData = getLocaleData(locale);
    this.geoGenerator = new GeoCoherentGenerator(locale);
  }

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

    // Per-rule locale override
    const ruleLocale = rule.config.fakerLocale;
    if (ruleLocale && ruleLocale !== this.locale) {
      const savedLocale = this.locale;
      const savedData = this.localeData;
      const savedGeo = this.geoGenerator;
      this.locale = ruleLocale;
      this.localeData = getLocaleData(ruleLocale);
      this.geoGenerator = new GeoCoherentGenerator(ruleLocale);
      const value = this.generateByMethodInstance(method, index, range);
      this.locale = savedLocale;
      this.localeData = savedData;
      this.geoGenerator = savedGeo;
      return value;
    }

    return this.generateByMethodInstance(method, index, range);
  }

  /**
   * Generate a value using the specified faker method, using instance locale data.
   */
  private generateByMethodInstance(
    method: string,
    index: number,
    range: NumberRange,
  ): unknown {
    switch (method) {
      case 'name':
        return this.generateName(index);
      case 'firstName':
        return this.generateFirstName(index);
      case 'lastName':
        return this.generateLastName(index);
      case 'email':
        return this.generateEmail(index);
      case 'phone':
        return this.generatePhone(index);
      case 'address':
        return this.generateAddress(index);
      case 'city':
        return this.geoGenerator.getCity(index);
      case 'country':
        return this.geoGenerator.getCountry(index);
      case 'state':
        return this.geoGenerator.getState(index);
      case 'company':
        return this.generateCompany(index);
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
        return this.geoGenerator.getZipCode(index);
      default:
        return generateSentence(index);
    }
  }

  private generateFirstName(index: number): string {
    return this.localeData.firstNames[index % this.localeData.firstNames.length];
  }

  private generateLastName(index: number): string {
    return this.localeData.lastNames[index % this.localeData.lastNames.length];
  }

  private generateName(index: number): string {
    return `${this.generateFirstName(index)} ${this.generateLastName(index)}`;
  }

  private generateEmail(index: number): string {
    const first = this.generateFirstName(index).toLowerCase().replace(/[^a-z]/g, '');
    const last = this.generateLastName(index).toLowerCase().replace(/[^a-z]/g, '');
    const domain = this.localeData.emailDomains[index % this.localeData.emailDomains.length];
    return `${first}.${last}${index}@${domain}`;
  }

  private generatePhone(index: number): string {
    return formatPhone(this.localeData.phoneFormat, index);
  }

  private generateAddress(index: number): string {
    const number = 100 + index;
    const streets = ['Main St', 'Oak Ave', 'Elm St', 'Park Blvd', 'Cedar Ln'];
    const city = this.geoGenerator.getCity(index);
    return `${number} ${streets[index % streets.length]}, ${city}`;
  }

  private generateCompany(index: number): string {
    return this.localeData.companies[index % this.localeData.companies.length];
  }
}

/**
 * Generate a value using the specified faker method name.
 * Standalone function for backward compatibility.
 * Falls back to a lorem-style string for unrecognized methods.
 *
 * @param method - Faker method name
 * @param index - Record index for deterministic generation
 * @param range - Number range for numeric methods
 * @param locale - Optional locale for locale-aware generation
 */
export function generateByMethod(
  method: string,
  index: number,
  range: NumberRange,
  locale?: string,
): unknown {
  const faker = new FakerFallback(locale);
  const rule: FieldRule = {
    fieldApiName: 'temp',
    ruleType: 'faker',
    config: { fakerMethod: method, minValue: range.min, maxValue: range.max },
  };
  const records = faker.generate([rule], index + 1);
  return records[index]?.['temp'];
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
