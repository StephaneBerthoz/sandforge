import { resolveFakerMethod } from '@sandforge/shared';
import type { FieldRule } from '@sandforge/shared';
import { LOCALE_DATA, getLocaleData, fillDigitMask, reservedPhone } from './LocaleData';
import type { LocaleDataSet, SupportedLocale } from './LocaleData';
import { GeoCoherentGenerator, resolveLocale } from './GeoCoherentGenerator';
import { STREETS, companyAt } from './localeNames';

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
 * What customers open a case about. A case's subject was a lorem sentence,
 * eight of them for the thousand cases of a template: nothing anyone could
 * sort, route or report on.
 */
const CASE_SUBJECTS = [
  'Unable to log in',
  'Invoice discrepancy',
  'Password reset email not received',
  'Order arrived damaged',
  'Request for a refund',
  'Cannot update billing address',
  'Shipment delayed',
  'Error when exporting a report',
  'Product not working as described',
  'Question about my contract',
  'Charged twice for one order',
  'Need help with installation',
  'Account locked after failed logins',
  'Wrong item delivered',
  'Request: edit several records at once',
  'App crashes on startup',
  'Items missing from my order',
  'Cannot download my invoice',
  'Change of delivery address',
  'Warranty claim',
  'Slow since the last update',
  'Question about my subscription renewal',
  'Data not syncing between devices',
  'Cancel my order',
  'Upgrade to a higher plan',
];

/** What an agent writes on a case as it works it. */
const CASE_COMMENTS = [
  'Asked the customer for a screenshot of the error.',
  'Reproduced the issue on our side.',
  'Escalated to the second-level team.',
  'Sent the customer a workaround.',
  'Customer confirmed the fix works.',
  "Waiting for the customer's reply.",
  'Refund approved and processed.',
  'Replacement shipped today.',
  'Called the customer, no answer; left a voicemail.',
  'Linked to a known issue, a fix is planned.',
  "Updated the customer's address on file.",
  'Shared the knowledge article on this topic.',
  'Closed after the customer confirmed.',
  'Reset the account; login works again.',
  'Checked the logs, nothing unusual found.',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a past date is drawn, in days. */
const PAST_DAYS = 365;

/** How far ahead a date to come is drawn, in days: a quarter or so, as a close date is. */
const FUTURE_DAYS = 120;

/** How far ahead a meeting is booked, in days. */
const MEETING_DAYS = 30;

/** The ages a person's birth date gives them. */
const YOUNGEST = 20;
const OLDEST = 65;

/** What a run's draws are made with. */
export interface FakerOptions {
  /**
   * Draws a number in [0, 1): the names, companies, addresses, dates and
   * numbers a record gets. `Math.random` unless the caller fixes it — the
   * command line's seeded draw, which a dry run and the run after it share.
   */
  random?: () => number;
  /** Today, which dates are drawn around: dates to come after it, past dates before. */
  today?: () => Date;
}

/**
 * A record's draws, each made once: every field of the record that reads the
 * same draw gets the same value from it — its email the first and last name
 * its name fields got, its city, state, country and postal code one address.
 */
type RecordDraw = (key: string, size: number) => number;

/**
 * Generates data records faker-style, in the locale's names and places.
 *
 * Every value was drawn from the record's index: the first and the last name
 * from the same one, so a template's thousand contacts were fifteen people,
 * and a second run wrote exactly the values of the first. A run now draws
 * each value — the first and the last name apart, the parts of an address
 * together — and a company without putting it back, so no two accounts of a
 * run share a name until the locale's companies run out. What has to be
 * unique still comes from the index: a phone number in the reserved ranges,
 * an email address, a username, an IBAN.
 */
export class FakerFallback {
  private locale: string;
  private localeData: LocaleDataSet;
  private geoGenerator: GeoCoherentGenerator;
  /** Sets this generator's usernames apart from every other's: see {@link generateUsername}. */
  private readonly usernameToken: string = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  private readonly random: () => number;
  private readonly today: () => Date;
  /** The companies of each locale in the order this generator hands them out. */
  private readonly companyDecks = new Map<string, number[]>();
  /** Companies handed out so far, per locale. */
  private readonly companiesDealt = new Map<string, number>();

  /**
   * Create a new FakerFallback instance.
   * @param locale - Locale for data generation (e.g. 'fr_FR'). Defaults to 'en_US'.
   * @param options - What the draws are made with; see {@link FakerOptions}.
   */
  constructor(locale?: string, options: FakerOptions = {}) {
    this.locale = locale ?? 'en_US';
    this.localeData = getLocaleData(this.locale);
    this.geoGenerator = new GeoCoherentGenerator(this.locale);
    this.random = options.random ?? Math.random;
    this.today = options.today ?? (() => new Date());
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
    // Each phone field of a record draws a number of its own: drawn from the
    // record's index alone, a contact's Phone and MobilePhone were the same
    // number. The k-th of n phone fields of record i takes the number i·n + k
    // of the locale's fictional range — still the same for the same template,
    // whatever the seed of the run, and one field alone draws as before.
    const phones = fieldRules.filter(
      (rule) => resolveFakerMethod(rule.config.fakerMethod ?? 'lorem') === 'phone',
    );

    for (let i = 0; i < count; i++) {
      const record: Record<string, unknown> = {};
      const drawn = new Map<string, number>();
      const draw: RecordDraw = (key, size) => {
        const known = drawn.get(key);
        if (known !== undefined) return known % size;
        const value = this.below(size);
        drawn.set(key, value);
        return value;
      };
      for (const rule of fieldRules) {
        const phone = phones.indexOf(rule);
        const index = phone >= 0 ? i * phones.length + phone : i;
        record[rule.fieldApiName] = this.generateFieldValue(rule, index, draw);
      }
      records.push(record);
    }

    return records;
  }

  /**
   * A date as a rule naming `method` gets it: what a caller sets a field to
   * when it settles one value against another — a closed opportunity's close
   * date, which comes before today.
   */
  dateOf(method: 'pastDate' | 'futureDate'): string {
    return method === 'pastDate' ? this.pastDate() : this.futureDate();
  }

  /** A whole number from 0 to `size - 1`. */
  private below(size: number): number {
    return Math.min(size - 1, Math.floor(this.random() * size));
  }

  /** One of `values`, drawn. */
  private pick<T>(values: readonly T[]): T {
    return values[this.below(values.length)];
  }

  /**
   * Generate a single field value based on the rule's faker method.
   */
  private generateFieldValue(rule: FieldRule, index: number, draw: RecordDraw): unknown {
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
      const value = this.generateByMethodInstance(method, index, range, draw);
      this.locale = savedLocale;
      this.localeData = savedData;
      this.geoGenerator = savedGeo;
      return value;
    }

    return this.generateByMethodInstance(method, index, range, draw);
  }

  /**
   * Generate a value using the specified faker method, using instance locale data.
   */
  private generateByMethodInstance(
    method: string,
    index: number,
    range: NumberRange,
    draw: RecordDraw,
  ): unknown {
    const resolved = resolveFakerMethod(method);
    if (!resolved) {
      return unsupportedMethod(method);
    }
    const geo = (): number => draw('geo', 10_000);
    switch (resolved) {
      case 'name':
        return `${this.firstName(draw)} ${this.lastName(draw)}`;
      case 'firstName':
        return this.firstName(draw);
      case 'lastName':
        return this.lastName(draw);
      case 'jobTitle':
        return `${this.pick(JOB_LEVELS)} ${this.pick(JOB_AREAS)} ${this.pick(JOB_ROLES)}`;
      case 'email':
        return this.generateEmail(index, draw);
      case 'username':
        return this.generateUsername(index, draw);
      case 'nickname':
        return this.generateNickname(index, draw);
      case 'phone':
        return this.generatePhone(index);
      case 'address':
        return `${this.streetAddress()}, ${this.geoGenerator.getCity(geo())}`;
      case 'streetAddress':
        return this.streetAddress();
      case 'city':
        return this.geoGenerator.getCity(geo());
      case 'country':
        return this.geoGenerator.getCountry(geo());
      case 'state':
        return this.geoGenerator.getState(geo());
      case 'company':
        return this.generateCompany();
      case 'catchPhrase':
        return (
          `${this.pick(PHRASE_ADJECTIVES)} ${this.pick(PHRASE_DESCRIPTORS)} ` +
          this.pick(PHRASE_NOUNS)
        );
      case 'date':
      case 'pastDate':
        return this.pastDate();
      case 'futureDate':
        return this.futureDate();
      case 'futureDateTime':
        return this.futureDateTime();
      case 'birthdate':
        return this.birthdate();
      case 'number':
      case 'integer':
        return Math.floor(range.min + this.random() * (range.max - range.min + 1));
      case 'float':
        return Math.round((range.min + this.random() * (range.max - range.min)) * 100) / 100;
      case 'boolean':
        return index % 2 === 0;
      case 'lorem':
      case 'sentence':
        return generateSentence(index);
      case 'paragraph':
        return generateParagraph(index);
      case 'caseSubject':
        return this.pick(CASE_SUBJECTS);
      case 'caseComment':
        return this.pick(CASE_COMMENTS);
      case 'uuid':
        return this.uuid();
      case 'url':
        return `https://example.com/resource/${index}`;
      case 'zipCode':
        return this.geoGenerator.getZipCode(geo());
      case 'productName':
        return this.productName(draw);
      case 'productDescription':
        return `${this.productName(draw)}, made for ${this.pick(PRODUCT_USES)}.`;
      case 'iban':
        return this.generateIban(index);
      case 'bic':
        return this.generateBic(index);
    }
  }

  private firstName(draw: RecordDraw): string {
    const names = this.localeData.firstNames;
    return names[draw('first', names.length)];
  }

  private lastName(draw: RecordDraw): string {
    const names = this.localeData.lastNames;
    return names[draw('last', names.length)];
  }

  /**
   * An email address on the record's own name, as its name fields give it,
   * and the index, which no other record of the run has.
   */
  private generateEmail(index: number, draw: RecordDraw): string {
    const domain = this.localeData.emailDomains[index % this.localeData.emailDomains.length];
    return `${asciiLetters(this.firstName(draw))}.${asciiLetters(this.lastName(draw))}${index}@${domain}`;
  }

  /**
   * A user's username: an email address in form, as the org requires, on one
   * of the locale's reserved domains, so nothing sent to it reaches anyone.
   * A username is unique across every Salesforce org, not within one, so the
   * person's name and the index are not enough: a second seed, in this org or
   * any other, would write the same ones, and the org refuses a username
   * taken anywhere. A token drawn once per generator sets each run's apart.
   */
  private generateUsername(index: number, draw: RecordDraw): string {
    const first = asciiLetters(this.firstName(draw));
    const last = asciiLetters(this.lastName(draw));
    const domain = this.localeData.emailDomains[index % this.localeData.emailDomains.length];
    return `${first}.${last}.${this.usernameToken}${index}@${domain}`;
  }

  /**
   * A user's nickname (`CommunityNickname`): unique in its org, and at most
   * 40 characters. A person's name is neither, so the nickname is a first
   * name with this generator's token and the index, as a username is: no two
   * users of a seed share one, nor do those of two seeds of the same org.
   */
  private generateNickname(index: number, draw: RecordDraw): string {
    const first = asciiLetters(this.firstName(draw)).slice(0, 20);
    return `${first}.${this.usernameToken}${index}`;
  }

  /** A number nobody holds, in the locale's range: see {@link reservedPhone}. */
  private generatePhone(index: number): string {
    return reservedPhone(this.locale, index);
  }

  /** A house number on one of the locale's streets, written the locale's way, without the city. */
  private streetAddress(): string {
    const { names, format } = STREETS[resolveLocale(this.locale)];
    return format
      .replace('{street}', this.pick(names))
      .replace('{n}', String(1 + this.below(199)))
      .replace('{m}', String(1 + this.below(9)));
  }

  /**
   * The locale's next company, dealt from its companies shuffled once for
   * this generator: no two records share one. Once every company is out the
   * deck goes round again, each company now the branch of a region of the
   * country (`companyAt`), so the names stay unique past the list.
   */
  private generateCompany(): string {
    const key = resolveLocale(this.locale);
    const size = LOCALE_DATA[key].companies.length;
    let deck = this.companyDecks.get(key);
    if (!deck || deck.length !== size) {
      deck = Array.from({ length: size }, (_, i) => i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = this.below(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      this.companyDecks.set(key, deck);
    }
    const dealt = this.companiesDealt.get(key) ?? 0;
    this.companiesDealt.set(key, dealt + 1);
    return companyAt(key, deck[dealt % deck.length], Math.floor(dealt / deck.length));
  }

  /**
   * A three-word product name — adjective, material, product — in the shape a
   * catalogue uses. Drawn once per record, so its description names it.
   */
  private productName(draw: RecordDraw): string {
    const adjective = PRODUCT_ADJECTIVES[draw('productAdjective', PRODUCT_ADJECTIVES.length)];
    const material = PRODUCT_MATERIALS[draw('productMaterial', PRODUCT_MATERIALS.length)];
    const product = PRODUCTS[draw('product', PRODUCTS.length)];
    return `${adjective} ${material} ${product}`;
  }

  /** A day of the past year. */
  private pastDate(): string {
    return isoDate(this.daysFromToday(-(1 + this.below(PAST_DAYS))));
  }

  /** A day of the weeks to come. */
  private futureDate(): string {
    return isoDate(this.daysFromToday(1 + this.below(FUTURE_DAYS)));
  }

  /** A meeting time in the weeks to come, on the hour or the half hour of a working day, UTC. */
  private futureDateTime(): string {
    const day = this.daysFromToday(1 + this.below(MEETING_DAYS));
    day.setUTCHours(8 + this.below(9), this.below(2) * 30, 0, 0);
    return day.toISOString();
  }

  /** The birth date of someone aged from {@link YOUNGEST} to {@link OLDEST}. */
  private birthdate(): string {
    const span = (OLDEST - YOUNGEST) * 365;
    return isoDate(this.daysFromToday(-(YOUNGEST * 365 + this.below(span))));
  }

  /** Today, moved by a number of days. */
  private daysFromToday(days: number): Date {
    return new Date(this.today().getTime() + days * DAY_MS);
  }

  /** A random UUID of version 4, drawn: an article's URL name is unique in its org. */
  private uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.below(16).toString(16));
    hex[12] = '4';
    hex[16] = ((this.below(16) & 0x3) | 0x8).toString(16);
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
 * @param index - Record index, which what has to be unique is drawn from
 * @param range - Number range for numeric methods
 * @param locale - Optional locale for locale-aware generation
 * @param options - What the draws are made with; see {@link FakerOptions}
 */
export function generateByMethod(
  method: string,
  index: number,
  range: NumberRange,
  locale?: string,
  options?: FakerOptions,
): unknown {
  const faker = new FakerFallback(locale, options);
  const rule: FieldRule = {
    fieldApiName: 'temp',
    ruleType: 'faker',
    config: { fakerMethod: method, minValue: range.min, maxValue: range.max },
  };
  const records = faker.generate([rule], index + 1);
  return records[index]?.['temp'];
}

/** A day as Salesforce writes a date field, `YYYY-MM-DD`. */
function isoDate(day: Date): string {
  return day.toISOString().split('T')[0];
}

/**
 * The letters of a name an address can carry, accents taken off: "Hélène"
 * is "helene" in an email address, where it was "hlne".
 */
function asciiLetters(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
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
