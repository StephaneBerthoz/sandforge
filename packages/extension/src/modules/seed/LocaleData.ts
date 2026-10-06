/**
 * Locale-aware datasets for deterministic data generation.
 * Provides culturally-appropriate names, cities, companies, phone/zip formats
 * for 6 locales: en_US, fr_FR, de_DE, es_ES, ja_JP, pt_BR. Its email domains
 * and phone numbers look real and reach nobody.
 */

/** Supported locale identifiers */
export type SupportedLocale = 'en_US' | 'fr_FR' | 'de_DE' | 'es_ES' | 'ja_JP' | 'pt_BR';

/** How a locale's phone numbers are written, and which of them nobody holds. */
export interface PhoneRange {
  /** Country calling code, without its '+'. */
  readonly countryCode: string;
  /** Digit a national number is dialled with inside the country, '' where there is none. */
  readonly trunkPrefix: string;
  /** National numbers nobody holds, without country code or trunk prefix. */
  readonly nationalNumber: RegExp;
}

/** Dataset for a single locale with culturally-appropriate data */
export interface LocaleDataSet {
  /** First names common in this locale (at least 15 entries) */
  readonly firstNames: readonly string[];
  /** Last names common in this locale (at least 15 entries) */
  readonly lastNames: readonly string[];
  /** City names in this locale (at least 10 entries) */
  readonly cities: readonly string[];
  /** Company names appropriate for this locale (at least 10 entries) */
  readonly companies: readonly string[];
  /**
   * Phone formats where X is replaced by digits, all inside {@link phoneRange}:
   * the range the regulator keeps for fiction where it publishes one, and a
   * range the numbering plan leaves unassigned where it does not. A number
   * that rings reaches whoever holds it, and a flow that texts new contacts
   * texts them.
   */
  readonly phoneFormats: readonly string[];
  /** The national numbers `phoneFormats` draws from, and how the locale writes a number. */
  readonly phoneRange: PhoneRange;
  /** Zip code format where # is replaced by digits (e.g. '#####') */
  readonly zipFormat: string;
  /**
   * Email domains no mailbox can be at: see {@link isReservedEmailDomain}. A
   * sandbox whose flows mail new contacts writes to whatever domain the
   * address names, and `mail.com` or `test.com` are somebody's.
   */
  readonly emailDomains: readonly string[];
}

/** All locale datasets keyed by SupportedLocale */
export const LOCALE_DATA: Record<SupportedLocale, LocaleDataSet> = {
  en_US: {
    firstNames: [
      'Alice',
      'Bob',
      'Charlie',
      'Diana',
      'Eve',
      'Frank',
      'Grace',
      'Hank',
      'Ivy',
      'Jack',
      'Kate',
      'Leo',
      'Mia',
      'Noah',
      'Olivia',
    ] as const,
    lastNames: [
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
      'Hernandez',
      'Lopez',
      'Gonzalez',
      'Wilson',
      'Anderson',
    ] as const,
    cities: [
      'New York',
      'Los Angeles',
      'Chicago',
      'Houston',
      'Phoenix',
      'Philadelphia',
      'San Antonio',
      'San Diego',
      'Dallas',
      'Austin',
    ] as const,
    companies: [
      'Acme Corp',
      'Globex Inc',
      'Initech',
      'Umbrella Corp',
      'Stark Industries',
      'Wayne Enterprises',
      'Cyberdyne Systems',
      'Oscorp',
      'LexCorp',
      'Massive Dynamic',
    ] as const,
    // NANPA keeps 555-0100 to 555-0199 for fiction, behind any area code: "The
    // fictitious, non-working numbers, 555-0100 through 555-0199, will remain
    // reserved for entertainment/advertising"
    // (https://nanpa.com/numbering/555-line-numbers). The area codes are those
    // of the cities above.
    phoneFormats: [
      '+1 212-555-01XX',
      '+1 213-555-01XX',
      '+1 312-555-01XX',
      '+1 713-555-01XX',
      '+1 602-555-01XX',
      '+1 215-555-01XX',
      '+1 210-555-01XX',
      '+1 619-555-01XX',
      '+1 214-555-01XX',
      '+1 512-555-01XX',
    ] as const,
    phoneRange: {
      countryCode: '1',
      trunkPrefix: '1',
      nationalNumber: /^(?:[2-9]\d{2})?55501\d{2}$/,
    },
    zipFormat: '#####',
    emailDomains: [
      'example.com',
      'example.net',
      'example.org',
      'company.example',
      'mail.test',
    ] as const,
  },
  fr_FR: {
    firstNames: [
      'Marie',
      'Pierre',
      'Jean',
      'Sophie',
      'Nicolas',
      'Camille',
      'Julien',
      'Lea',
      'Thomas',
      'Emma',
      'Lucas',
      'Chloe',
      'Hugo',
      'Manon',
      'Antoine',
    ] as const,
    lastNames: [
      'Dupont',
      'Martin',
      'Bernard',
      'Dubois',
      'Thomas',
      'Robert',
      'Richard',
      'Petit',
      'Durand',
      'Leroy',
      'Moreau',
      'Simon',
      'Laurent',
      'Lefebvre',
      'Michel',
    ] as const,
    cities: [
      'Paris',
      'Lyon',
      'Marseille',
      'Toulouse',
      'Nice',
      'Bordeaux',
      'Strasbourg',
      'Nantes',
      'Lille',
      'Rennes',
    ] as const,
    companies: [
      'Total SA',
      'Renault Group',
      'Airbus France',
      'BNP Paribas',
      'Carrefour',
      'Sanofi',
      'Orange SA',
      'Danone',
      'Michelin',
      'Capgemini',
    ] as const,
    // Arcep keeps six blocks of 10,000 numbers for audiovisual works, numbers
    // that can neither call nor be called: those starting 01 99 00, 02 61 91,
    // 03 53 01, 04 65 71, 05 36 49 and 06 39 98 (plan national de numérotation,
    // décision n° 2018-0881 modifiée, "Numéros pour œuvres audiovisuelles",
    // https://www.arcep.fr/uploads/tx_gsavis/18-0881.pdf).
    phoneFormats: [
      '+33 1 99 00 XX XX',
      '+33 2 61 91 XX XX',
      '+33 3 53 01 XX XX',
      '+33 4 65 71 XX XX',
      '+33 5 36 49 XX XX',
      '+33 6 39 98 XX XX',
    ] as const,
    phoneRange: {
      countryCode: '33',
      trunkPrefix: '0',
      nationalNumber: /^(?:19900|26191|35301|46571|53649|63998)\d{4}$/,
    },
    zipFormat: '#####',
    emailDomains: [
      'example.com',
      'example.org',
      'example.net',
      'entreprise.example',
      'courriel.test',
    ] as const,
  },
  de_DE: {
    firstNames: [
      'Max',
      'Anna',
      'Lukas',
      'Lena',
      'Felix',
      'Marie',
      'Paul',
      'Sophia',
      'Leon',
      'Emma',
      'Jonas',
      'Mia',
      'Elias',
      'Hannah',
      'Ben',
    ] as const,
    lastNames: [
      'Mueller',
      'Schmidt',
      'Schneider',
      'Fischer',
      'Weber',
      'Meyer',
      'Wagner',
      'Becker',
      'Schulz',
      'Hoffmann',
      'Koch',
      'Richter',
      'Wolf',
      'Schaefer',
      'Bauer',
    ] as const,
    cities: [
      'Berlin',
      'Munich',
      'Hamburg',
      'Frankfurt',
      'Cologne',
      'Stuttgart',
      'Dusseldorf',
      'Leipzig',
      'Dresden',
      'Hannover',
    ] as const,
    companies: [
      'Siemens AG',
      'Volkswagen',
      'BMW Group',
      'Deutsche Bank',
      'SAP SE',
      'Allianz',
      'BASF',
      'Bosch GmbH',
      'Bayer AG',
      'DHL Deutsche Post',
    ] as const,
    // The Bundesnetzagentur keeps 1,000 "Drama Numbers" in each of five cities,
    // assigned to no subscriber for good: Berlin (0)30 23125, Frankfurt am Main
    // (0)69 90009, Hamburg (0)40 66969, Köln (0)221 4710 and München
    // (0)89 99998, each followed by 000 to 999 (Rufnummern für
    // Medienproduktionen, https://www.bundesnetzagentur.de/DE/Fachthemen/
    // Telekommunikation/Nummerierung/DramaNumbers/artikel.html).
    phoneFormats: [
      '+49 30 23125 XXX',
      '+49 69 90009 XXX',
      '+49 40 66969 XXX',
      '+49 221 4710 XXX',
      '+49 89 99998 XXX',
    ] as const,
    phoneRange: {
      countryCode: '49',
      trunkPrefix: '0',
      nationalNumber: /^(?:3023125|6990009|4066969|2214710|8999998)\d{3}$/,
    },
    zipFormat: '#####',
    emailDomains: [
      'example.com',
      'example.net',
      'example.org',
      'firma.example',
      'post.test',
    ] as const,
  },
  es_ES: {
    firstNames: [
      'Carlos',
      'Maria',
      'Alejandro',
      'Carmen',
      'Javier',
      'Lucia',
      'Miguel',
      'Marta',
      'Daniel',
      'Ana',
      'Pablo',
      'Elena',
      'Diego',
      'Laura',
      'Sergio',
    ] as const,
    lastNames: [
      'Garcia',
      'Rodriguez',
      'Martinez',
      'Lopez',
      'Gonzalez',
      'Hernandez',
      'Perez',
      'Sanchez',
      'Ramirez',
      'Torres',
      'Flores',
      'Rivera',
      'Gomez',
      'Diaz',
      'Morales',
    ] as const,
    cities: [
      'Madrid',
      'Barcelona',
      'Valencia',
      'Seville',
      'Zaragoza',
      'Malaga',
      'Bilbao',
      'Murcia',
      'Palma',
      'Granada',
    ] as const,
    companies: [
      'Telefonica',
      'Inditex',
      'Santander',
      'BBVA',
      'Repsol',
      'Iberdrola',
      'CaixaBank',
      'Endesa',
      'Mapfre',
      'Ferrovial',
    ] as const,
    // Spain publishes no numbers for fiction. Its numbering plan leaves every
    // nine-digit number starting with 3 pending attribution, so no subscriber
    // has one: "N=3. Pendiente de atribución" (plan nacional de numeración
    // telefónica, 4.4, annexed to Real Decreto 2296/2004,
    // https://www.boe.es/diario_boe/txt.php?id=BOE-A-2004-21841). Not 0 or 1,
    // which lead to short numbers such as 112.
    phoneFormats: ['+34 3XX XXX XXX'] as const,
    phoneRange: { countryCode: '34', trunkPrefix: '', nationalNumber: /^3\d{8}$/ },
    zipFormat: '#####',
    emailDomains: [
      'example.com',
      'example.org',
      'example.net',
      'empresa.example',
      'correo.test',
    ] as const,
  },
  ja_JP: {
    firstNames: [
      'Taro',
      'Hanako',
      'Yuki',
      'Kenji',
      'Sakura',
      'Haruto',
      'Yui',
      'Sota',
      'Hina',
      'Ren',
      'Mei',
      'Kaito',
      'Aoi',
      'Riku',
      'Mio',
    ] as const,
    lastNames: [
      'Tanaka',
      'Suzuki',
      'Takahashi',
      'Watanabe',
      'Ito',
      'Yamamoto',
      'Nakamura',
      'Kobayashi',
      'Kato',
      'Yoshida',
      'Yamada',
      'Sasaki',
      'Yamaguchi',
      'Matsumoto',
      'Inoue',
    ] as const,
    cities: [
      'Tokyo',
      'Osaka',
      'Yokohama',
      'Nagoya',
      'Sapporo',
      'Fukuoka',
      'Kobe',
      'Kyoto',
      'Sendai',
      'Hiroshima',
    ] as const,
    companies: [
      'Toyota Motor',
      'Sony Group',
      'Honda Motor',
      'Mitsubishi Corp',
      'SoftBank',
      'Panasonic',
      'Hitachi Ltd',
      'NTT Data',
      'Canon Inc',
      'Fujitsu',
    ] as const,
    // Japan publishes no numbers for fiction. Its numbering plan, as the
    // Ministry of Internal Affairs and Communications notified it to the ITU
    // on 19 May 2014, leaves unused the mobile numbers whose digit after 090
    // is 0: "90AXXXXXXX A=0 not in use" (https://www.itu.int/oth/T020200006D/en).
    phoneFormats: ['+81 90-0XXX-XXXX'] as const,
    phoneRange: { countryCode: '81', trunkPrefix: '0', nationalNumber: /^900\d{7}$/ },
    zipFormat: '###-####',
    emailDomains: [
      'example.com',
      'example.net',
      'example.org',
      'kaisha.example',
      'yubin.test',
    ] as const,
  },
  pt_BR: {
    firstNames: [
      'Joao',
      'Ana',
      'Pedro',
      'Maria',
      'Lucas',
      'Juliana',
      'Gabriel',
      'Fernanda',
      'Rafael',
      'Camila',
      'Matheus',
      'Larissa',
      'Bruno',
      'Beatriz',
      'Thiago',
    ] as const,
    lastNames: [
      'Silva',
      'Santos',
      'Oliveira',
      'Souza',
      'Rodrigues',
      'Ferreira',
      'Almeida',
      'Pereira',
      'Lima',
      'Gomes',
      'Costa',
      'Ribeiro',
      'Martins',
      'Carvalho',
      'Araujo',
    ] as const,
    cities: [
      'Sao Paulo',
      'Rio de Janeiro',
      'Brasilia',
      'Salvador',
      'Fortaleza',
      'Belo Horizonte',
      'Manaus',
      'Curitiba',
      'Recife',
      'Porto Alegre',
    ] as const,
    companies: [
      'Petrobras',
      'Vale SA',
      'Itau Unibanco',
      'Bradesco',
      'Banco do Brasil',
      'Ambev',
      'JBS SA',
      'Magazine Luiza',
      'Natura Co',
      'Embraer',
    ] as const,
    // Brazil publishes no numbers for fiction. Anatel's Resolution 553 of
    // 14 December 2010, which gave every mobile number its leading 9, reserves
    // the series "90N7N6N5" (art. 19): no mobile number starts with 90. The
    // area codes are those of the cities above.
    phoneFormats: [
      '+55 11 90XXX-XXXX',
      '+55 21 90XXX-XXXX',
      '+55 61 90XXX-XXXX',
      '+55 71 90XXX-XXXX',
      '+55 85 90XXX-XXXX',
      '+55 31 90XXX-XXXX',
      '+55 92 90XXX-XXXX',
      '+55 41 90XXX-XXXX',
      '+55 81 90XXX-XXXX',
      '+55 51 90XXX-XXXX',
    ] as const,
    phoneRange: { countryCode: '55', trunkPrefix: '0', nationalNumber: /^(?:[1-9]{2})?90\d{7}$/ },
    zipFormat: '#####-###',
    emailDomains: [
      'example.com',
      'example.org',
      'example.net',
      'empresa.example',
      'correio.test',
    ] as const,
  },
} as const;

/**
 * The second-level domains RFC 2606 reserves for examples, and the top-level
 * domains RFC 2606 and RFC 6761 reserve so that they are never delegated: no
 * mailbox under any of them belongs to anybody.
 */
const RESERVED_SECOND_LEVEL_DOMAINS: readonly string[] = [
  'example.com',
  'example.net',
  'example.org',
];
const RESERVED_TOP_LEVEL_DOMAINS: readonly string[] = ['example', 'invalid', 'test'];

/**
 * Whether mail to this domain reaches nobody: it is one of the reserved
 * second-level domains or under one, or it ends in a reserved top-level domain.
 */
export function isReservedEmailDomain(domain: string): boolean {
  const host = domain.toLowerCase().replace(/\.$/, '');
  return (
    RESERVED_SECOND_LEVEL_DOMAINS.some(
      (reserved) => host === reserved || host.endsWith(`.${reserved}`),
    ) || RESERVED_TOP_LEVEL_DOMAINS.some((tld) => host.endsWith(`.${tld}`))
  );
}

/**
 * The digits after the country code's '+', or after the international prefix
 * '00', of a number written in international form; undefined for a number
 * written the national way.
 */
function internationalDigits(value: string): string | undefined {
  const written = value.trim();
  const digits = written.replace(/\D/g, '');
  if (written.startsWith('+')) return digits;
  return digits.startsWith('00') ? digits.slice(2) : undefined;
}

/** The supported locale whose country code an international number starts with. */
export function localeOfPhone(value: string): SupportedLocale | undefined {
  const international = internationalDigits(value);
  if (international === undefined) return undefined;
  return (Object.keys(LOCALE_DATA) as SupportedLocale[]).find((locale) =>
    international.startsWith(LOCALE_DATA[locale].phoneRange.countryCode),
  );
}

/**
 * Whether the number, however it is spaced or punctuated, is one nobody holds
 * in `locale`'s {@link PhoneRange}, or in any supported locale's when none is
 * given. A number in international form must carry the locale's country code;
 * one in national form may keep its trunk prefix.
 */
export function isReservedPhone(value: string, locale?: string): boolean {
  const international = internationalDigits(value);
  const digits = value.replace(/\D/g, '');
  const datasets = locale === undefined ? Object.values(LOCALE_DATA) : [getLocaleData(locale)];
  return datasets.some(({ phoneRange: { countryCode, trunkPrefix, nationalNumber } }) => {
    let national = digits;
    if (international !== undefined) {
      if (!international.startsWith(countryCode)) return false;
      national = international.slice(countryCode.length);
    }
    // A trunk prefix can follow the country code too, written '+33 (0)6 39 98 …'.
    const withoutTrunk =
      trunkPrefix !== '' && national.startsWith(trunkPrefix)
        ? national.slice(trunkPrefix.length)
        : national;
    return nationalNumber.test(national) || nationalNumber.test(withoutTrunk);
  });
}

/**
 * The phone number of record `index` in `locale`: its formats take turns, and
 * each gives a record a number of its own until its digits run out — a
 * hundred per American area code, a thousand per German city, ten thousand per
 * French block.
 */
export function reservedPhone(locale: string, index: number): string {
  const formats = getLocaleData(locale).phoneFormats;
  return formatPhone(formats[index % formats.length], Math.floor(index / formats.length));
}

/** Prefix map for locale matching (e.g. 'fr' -> 'fr_FR') */
const LOCALE_PREFIX_MAP: Record<string, SupportedLocale> = {
  en: 'en_US',
  fr: 'fr_FR',
  de: 'de_DE',
  es: 'es_ES',
  ja: 'ja_JP',
  pt: 'pt_BR',
};

/**
 * Get the locale dataset for a given locale string.
 * Supports exact match (e.g. 'fr_FR') and prefix match (e.g. 'fr').
 * Falls back to en_US for unknown locales.
 *
 * @param locale - Locale string (e.g. 'fr_FR', 'fr', 'de_DE')
 * @returns The matching LocaleDataSet, or en_US as fallback
 */
export function getLocaleData(locale: string): LocaleDataSet {
  // Exact match
  if (locale in LOCALE_DATA) {
    return LOCALE_DATA[locale as SupportedLocale];
  }

  // Prefix match (e.g. 'fr' -> 'fr_FR')
  const prefix = locale.split('_')[0].toLowerCase();
  const mapped = LOCALE_PREFIX_MAP[prefix];
  if (mapped) {
    return LOCALE_DATA[mapped];
  }

  // Fallback
  return LOCALE_DATA.en_US;
}

/**
 * Format a phone number from a format template.
 * Replaces each 'X' character with a deterministic digit derived from the index.
 *
 * The X's spell `index` multiplied by a number prime to ten, modulo ten to the
 * power of their count. That product takes every value once, so each index
 * below that power gets a number of its own; the digits used to depend on the
 * index modulo 10 alone, and every tenth record shared a number.
 *
 * @param format - Phone format string (e.g. '+33 6 39 98 XX XX')
 * @param index - Record index for deterministic digit generation
 * @returns Formatted phone number string
 */
export function formatPhone(format: string, index: number): string {
  const slots = format.split('X').length - 1;
  const modulus = 10 ** slots;
  const position = ((index % modulus) + modulus) % modulus;
  const digits = String((position * 7919 + 4027) % modulus).padStart(slots, '0');
  let digitIndex = 0;
  return format.replace(/X/g, () => digits[digitIndex++]);
}

/**
 * Format a zip code from a format template.
 * Replaces each '#' character with a deterministic digit derived from the index.
 *
 * @param format - Zip code format string (e.g. '#####' or '###-####')
 * @param index - Record index for deterministic digit generation
 * @returns Formatted zip code string
 */
export function formatZipCode(format: string, index: number): string {
  let digitIndex = 0;
  return format.replace(/#/g, () => {
    const digit = (index * 3 + digitIndex * 7 + 2) % 10;
    digitIndex++;
    return String(digit);
  });
}

/**
 * Fill a digit mask: every '#' becomes a digit, every other character is kept
 * as written, so '###########00##' yields fourteen digits whose twelfth and
 * thirteenth are '0'.
 *
 * Meant for identifiers — a SIRET, the account part of an IBAN — where two
 * records must not collide. {@link formatZipCode} derives each digit from
 * `index` modulo 10, which repeats every ten records: harmless for a postal
 * code, wrong for anything that identifies a record. The digits here come from
 * a Lehmer sequence seeded by the index, so the value is still the same for the
 * same index and no longer the same for index and index + 10.
 *
 * @param mask - Mask string (e.g. '###########00##')
 * @param index - Record index for deterministic digit generation
 * @returns The mask with every '#' replaced by a digit
 */
export function fillDigitMask(mask: string, index: number): string {
  let state = ((index + 1) * 48271) % 2147483647;
  return mask.replace(/#/g, () => {
    state = (state * 48271) % 2147483647;
    return String(state % 10);
  });
}
