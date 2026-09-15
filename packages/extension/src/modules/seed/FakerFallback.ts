import { resolveFakerMethod } from '@sandforge/shared';
import type { FieldRule } from '@sandforge/shared';
import { getLocaleData, formatPhone, fillDigitMask } from './LocaleData';
import type { LocaleDataSet, SupportedLocale } from './LocaleData';
import { GeoCoherentGenerator, resolveLocale } from './GeoCoherentGenerator';

/** Configuration for number generation ranges */
interface NumberRange {
  min: number;
  max: number;
}

/** ISO 3166-1 alpha-2 code of each locale, for codes that carry a country. */
const COUNTRY_CODES: Record<SupportedLocale, string> = {
  en_US: 'US',
  fr_FR: 'FR',
  de_DE: 'DE',
  es_ES: 'ES',
  ja_JP: 'JP',
  pt_BR: 'BR',
};

/**
 * IBAN layout per locale: the country code and the BBAN length ISO 13616
 * registers for it. Only countries whose BBAN is all digits are listed — the
 * mask that fills it produces digits. IBAN is a European scheme, so a locale
 * that has none borrows the German layout rather than inventing one.
 */
const IBAN_LAYOUTS: Record<SupportedLocale, { country: string; bbanLength: number }> = {
  fr_FR: { country: 'FR', bbanLength: 23 },
  de_DE: { country: 'DE', bbanLength: 18 },
  es_ES: { country: 'ES', bbanLength: 20 },
  en_US: { country: 'DE', bbanLength: 18 },
  ja_JP: { country: 'DE', bbanLength: 18 },
  pt_BR: { country: 'DE', bbanLength: 18 },
};

/** Letters a BIC location code may use: ISO 9362 excludes 'O' from it. */
const BIC_LOCATION_LETTERS = 'ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** Word banks for product names, in the adjective / material / product shape. */
const PRODUCT_ADJECTIVES = [
  'Ergonomic',
  'Handcrafted',
  'Refined',
  'Sleek',
  'Rustic',
  'Compact',
  'Modular',
  'Insulated',
];
const PRODUCT_MATERIALS = ['Steel', 'Wooden', 'Cotton', 'Granite', 'Rubber', 'Leather', 'Ceramic'];
const PRODUCTS = [
  'Chair',
  'Table',
  'Lamp',
  'Keyboard',
  'Backpack',
  'Bottle',
  'Headphones',
  'Gloves',
  'Bench',
];

/** Street names shared by the full and the street-only address. */
const STREETS = ['Main St', 'Oak Ave', 'Elm St', 'Park Blvd', 'Cedar Ln'];

/** Word banks for job titles, in the level / area / role shape. */
const JOB_LEVELS = ['Senior', 'Lead', 'Junior', 'Principal', 'Associate', 'Chief'];
const JOB_AREAS = ['Marketing', 'Operations', 'Finance', 'Sales', 'Product', 'Customer Success'];
const JOB_ROLES = ['Manager', 'Analyst', 'Coordinator', 'Specialist', 'Director', 'Consultant'];

/** Word banks for a company slogan, in the adjective / descriptor / noun shape. */
const PHRASE_ADJECTIVES = ['Adaptive', 'Integrated', 'Customer-focused', 'Scalable', 'Secure'];
const PHRASE_DESCRIPTORS = ['cloud-based', 'real-time', 'data-driven', 'modular', 'global'];
const PHRASE_NOUNS = ['platform', 'solution', 'workflow', 'service', 'framework', 'network'];

/** Uses a product description names, after the product it describes. */
const PRODUCT_USES = [
  'daily use at home or in the office',
  'long days on the move',
  'teams that need something that lasts',
  'small spaces',
  'outdoor work in any weather',
];

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
  private generateByMethodInstance(method: string, index: number, range: NumberRange): unknown {
    const resolved = resolveFakerMethod(method);
    if (!resolved) {
      return unsupportedMethod(method);
    }
    switch (resolved) {
      case 'name':
        return this.generateName(index);
      case 'firstName':
        return this.generateFirstName(index);
      case 'lastName':
        return this.generateLastName(index);
      case 'jobTitle':
        return generateJobTitle(index);
      case 'email':
        return this.generateEmail(index);
      case 'phone':
        return this.generatePhone(index);
      case 'address':
        return this.generateAddress(index);
      case 'streetAddress':
        return generateStreetAddress(index);
      case 'city':
        return this.geoGenerator.getCity(index);
      case 'country':
        return this.geoGenerator.getCountry(index);
      case 'state':
        return this.geoGenerator.getState(index);
      case 'company':
        return this.generateCompany(index);
      case 'catchPhrase':
        return generateCatchPhrase(index);
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
      case 'productName':
        return generateProductName(index);
      case 'productDescription':
        return generateProductDescription(index);
      case 'iban':
        return this.generateIban(index);
      case 'bic':
        return this.generateBic(index);
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
    const first = this.generateFirstName(index)
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const last = this.generateLastName(index)
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    const domain = this.localeData.emailDomains[index % this.localeData.emailDomains.length];
    return `${first}.${last}${index}@${domain}`;
  }

  private generatePhone(index: number): string {
    return formatPhone(this.localeData.phoneFormat, index);
  }

  private generateAddress(index: number): string {
    return `${generateStreetAddress(index)}, ${this.geoGenerator.getCity(index)}`;
  }

  private generateCompany(index: number): string {
    return this.localeData.companies[index % this.localeData.companies.length];
  }

  /**
   * Build an IBAN whose check digits are the ones ISO 13616 computes for its
   * body, so the value passes an IBAN validator. The digits inside the BBAN
   * carry no national meaning: a French IBAN generated here does not hold a
   * valid RIB key, and a German one no valid Bankleitzahl.
   */
  private generateIban(index: number): string {
    const layout = IBAN_LAYOUTS[resolveLocale(this.locale)];
    const bban = fillDigitMask('#'.repeat(layout.bbanLength), index);
    return `${layout.country}${ibanCheckDigits(layout.country, bban)}${bban}`;
  }

  /**
   * Build an 11-character BIC: four letters for the institution, the locale's
   * country code, a two-letter location, and 'XXX' for the head office. The
   * institution code is synthetic — it deliberately does not reproduce the
   * code of a real bank. Unlike an IBAN a BIC identifies an institution, not a
   * record, so repeating one across records is what real data looks like.
   */
  private generateBic(index: number): string {
    const institution = Array.from({ length: 4 }, (_, i) =>
      String.fromCharCode(65 + ((index * 5 + i * 7 + 3) % 26)),
    ).join('');
    const location = Array.from(
      { length: 2 },
      (_, i) => BIC_LOCATION_LETTERS[(index * 3 + i * 11 + 2) % BIC_LOCATION_LETTERS.length],
    ).join('');
    return `${institution}${COUNTRY_CODES[resolveLocale(this.locale)]}${location}XXX`;
  }
}

/**
 * Generate a value using the specified faker method name.
 * Standalone function for backward compatibility.
 * Throws for a method nothing generates, as {@link FakerFallback.generate} does.
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

/**
 * A three-word product name — adjective, material, product — in the shape a
 * catalogue uses. The three indices step at different rates so that consecutive
 * records do not share their first word.
 */
function generateProductName(index: number): string {
  const adjective = PRODUCT_ADJECTIVES[index % PRODUCT_ADJECTIVES.length];
  const material = PRODUCT_MATERIALS[(index * 3 + 1) % PRODUCT_MATERIALS.length];
  const product = PRODUCTS[(index * 5 + 2) % PRODUCTS.length];
  return `${adjective} ${material} ${product}`;
}

/** A house number and a street, without the city: the value of a Street field. */
function generateStreetAddress(index: number): string {
  return `${100 + index} ${STREETS[index % STREETS.length]}`;
}

/** A job title — level, area, role — with the parts stepping at different rates. */
function generateJobTitle(index: number): string {
  const level = JOB_LEVELS[index % JOB_LEVELS.length];
  const area = JOB_AREAS[(index * 5 + 1) % JOB_AREAS.length];
  const role = JOB_ROLES[(index * 7 + 2) % JOB_ROLES.length];
  return `${level} ${area} ${role}`;
}

/** A three-word company slogan, such as "Scalable real-time platform". */
function generateCatchPhrase(index: number): string {
  const adjective = PHRASE_ADJECTIVES[index % PHRASE_ADJECTIVES.length];
  const descriptor = PHRASE_DESCRIPTORS[(index * 3 + 1) % PHRASE_DESCRIPTORS.length];
  const noun = PHRASE_NOUNS[(index * 5 + 2) % PHRASE_NOUNS.length];
  return `${adjective} ${descriptor} ${noun}`;
}

/** One sentence describing the product generateProductName gives the same index. */
function generateProductDescription(index: number): string {
  const use = PRODUCT_USES[(index * 3 + 2) % PRODUCT_USES.length];
  return `${generateProductName(index)}, made for ${use}.`;
}

/**
 * The two check digits ISO 13616 computes for an IBAN body: move the country
 * code and '00' behind the BBAN, write every letter as its position + 9, take
 * the remainder modulo 97 and subtract it from 98. Worked digit by digit, so a
 * 30-digit number never has to fit in a double.
 */
function ibanCheckDigits(country: string, bban: string): string {
  const numeric = `${bban}${country}00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return String(98 - remainder).padStart(2, '0');
}

/**
 * A faker method this generator does not implement. It used to become a lorem
 * sentence, which looks like a value and is inserted like one. SeedValidator
 * refuses such a template before the first insert; this throw is what a caller
 * that skips validation meets, so it does not claim that nothing was written.
 */
function unsupportedMethod(method: string): never {
  throw new Error(
    `Faker method "${method}" is not implemented: choose a method SandForge generates, ` +
      `or remove it from the field rule.`,
  );
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
  return [generateSentence(index), generateSentence(index + 1), generateSentence(index + 2)].join(
    ' ',
  );
}

function generateUUID(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
