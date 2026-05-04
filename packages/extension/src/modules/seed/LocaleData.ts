/**
 * Locale-aware datasets for deterministic data generation.
 * Provides culturally-appropriate names, cities, companies, phone/zip formats
 * for 6 locales: en_US, fr_FR, de_DE, es_ES, ja_JP, pt_BR.
 */

/** Supported locale identifiers */
export type SupportedLocale = 'en_US' | 'fr_FR' | 'de_DE' | 'es_ES' | 'ja_JP' | 'pt_BR';

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
  /** Phone format where X is replaced by digits (e.g. '+33 X XX XX XX XX') */
  readonly phoneFormat: string;
  /** Zip code format where # is replaced by digits (e.g. '#####') */
  readonly zipFormat: string;
  /** Email domains appropriate for this locale */
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
    phoneFormat: '+1 XXX-XXX-XXXX',
    zipFormat: '#####',
    emailDomains: ['example.com', 'mail.com', 'test.com'] as const,
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
    phoneFormat: '+33 X XX XX XX XX',
    zipFormat: '#####',
    emailDomains: ['exemple.fr', 'mail.fr', 'test.fr'] as const,
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
    phoneFormat: '+49 XXX XXXXXXX',
    zipFormat: '#####',
    emailDomains: ['beispiel.de', 'mail.de', 'test.de'] as const,
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
    phoneFormat: '+34 XXX XXX XXX',
    zipFormat: '#####',
    emailDomains: ['ejemplo.es', 'correo.es', 'test.es'] as const,
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
    phoneFormat: '+81 XX-XXXX-XXXX',
    zipFormat: '###-####',
    emailDomains: ['example.jp', 'mail.jp', 'test.jp'] as const,
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
    phoneFormat: '+55 XX XXXXX-XXXX',
    zipFormat: '#####-###',
    emailDomains: ['exemplo.com.br', 'mail.com.br', 'test.com.br'] as const,
  },
} as const;

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
 * @param format - Phone format string (e.g. '+33 X XX XX XX XX')
 * @param index - Record index for deterministic digit generation
 * @returns Formatted phone number string
 */
export function formatPhone(format: string, index: number): string {
  let digitIndex = 0;
  return format.replace(/X/g, () => {
    const digit = (index * 7 + digitIndex * 3 + 1) % 10;
    digitIndex++;
    return String(digit);
  });
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
