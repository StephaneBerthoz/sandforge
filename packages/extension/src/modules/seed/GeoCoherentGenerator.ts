/**
 * Generates geographically coherent address tuples.
 * Ensures city, state, country, and zip code all belong to the same region,
 * preventing nonsensical combinations like "Paris, Texas, Japan".
 */

import { getLocaleData } from './LocaleData';
import type { SupportedLocale } from './LocaleData';

/** A geographically coherent address tuple */
export interface AddressTuple {
  /** City name */
  city: string;
  /** State or region name */
  state: string;
  /** Country name */
  country: string;
  /** Zip/postal code */
  zipCode: string;
}

/** Geo-coherent address tuples per locale (at least 10 per locale) */
export const GEO_DATA: Record<SupportedLocale, readonly AddressTuple[]> = {
  en_US: [
    { city: 'New York', state: 'New York', country: 'United States', zipCode: '10001' },
    { city: 'Los Angeles', state: 'California', country: 'United States', zipCode: '90001' },
    { city: 'Chicago', state: 'Illinois', country: 'United States', zipCode: '60601' },
    { city: 'Houston', state: 'Texas', country: 'United States', zipCode: '77001' },
    { city: 'Phoenix', state: 'Arizona', country: 'United States', zipCode: '85001' },
    { city: 'Philadelphia', state: 'Pennsylvania', country: 'United States', zipCode: '19101' },
    { city: 'San Antonio', state: 'Texas', country: 'United States', zipCode: '78201' },
    { city: 'San Diego', state: 'California', country: 'United States', zipCode: '92101' },
    { city: 'Dallas', state: 'Texas', country: 'United States', zipCode: '75201' },
    { city: 'Austin', state: 'Texas', country: 'United States', zipCode: '78701' },
  ] as const,
  fr_FR: [
    { city: 'Paris', state: 'Ile-de-France', country: 'France', zipCode: '75001' },
    { city: 'Lyon', state: 'Auvergne-Rhone-Alpes', country: 'France', zipCode: '69001' },
    { city: 'Marseille', state: "Provence-Alpes-Cote d'Azur", country: 'France', zipCode: '13001' },
    { city: 'Toulouse', state: 'Occitanie', country: 'France', zipCode: '31000' },
    { city: 'Nice', state: "Provence-Alpes-Cote d'Azur", country: 'France', zipCode: '06000' },
    { city: 'Bordeaux', state: 'Nouvelle-Aquitaine', country: 'France', zipCode: '33000' },
    { city: 'Strasbourg', state: 'Grand Est', country: 'France', zipCode: '67000' },
    { city: 'Nantes', state: 'Pays de la Loire', country: 'France', zipCode: '44000' },
    { city: 'Lille', state: 'Hauts-de-France', country: 'France', zipCode: '59000' },
    { city: 'Rennes', state: 'Bretagne', country: 'France', zipCode: '35000' },
  ] as const,
  de_DE: [
    { city: 'Berlin', state: 'Berlin', country: 'Germany', zipCode: '10115' },
    { city: 'Munich', state: 'Bavaria', country: 'Germany', zipCode: '80331' },
    { city: 'Hamburg', state: 'Hamburg', country: 'Germany', zipCode: '20095' },
    { city: 'Frankfurt', state: 'Hesse', country: 'Germany', zipCode: '60311' },
    { city: 'Cologne', state: 'North Rhine-Westphalia', country: 'Germany', zipCode: '50667' },
    { city: 'Stuttgart', state: 'Baden-Wurttemberg', country: 'Germany', zipCode: '70173' },
    { city: 'Dusseldorf', state: 'North Rhine-Westphalia', country: 'Germany', zipCode: '40213' },
    { city: 'Leipzig', state: 'Saxony', country: 'Germany', zipCode: '04109' },
    { city: 'Dresden', state: 'Saxony', country: 'Germany', zipCode: '01067' },
    { city: 'Hannover', state: 'Lower Saxony', country: 'Germany', zipCode: '30159' },
  ] as const,
  es_ES: [
    { city: 'Madrid', state: 'Comunidad de Madrid', country: 'Spain', zipCode: '28001' },
    { city: 'Barcelona', state: 'Catalonia', country: 'Spain', zipCode: '08001' },
    { city: 'Valencia', state: 'Comunitat Valenciana', country: 'Spain', zipCode: '46001' },
    { city: 'Seville', state: 'Andalusia', country: 'Spain', zipCode: '41001' },
    { city: 'Zaragoza', state: 'Aragon', country: 'Spain', zipCode: '50001' },
    { city: 'Malaga', state: 'Andalusia', country: 'Spain', zipCode: '29001' },
    { city: 'Bilbao', state: 'Basque Country', country: 'Spain', zipCode: '48001' },
    { city: 'Murcia', state: 'Region de Murcia', country: 'Spain', zipCode: '30001' },
    { city: 'Palma', state: 'Balearic Islands', country: 'Spain', zipCode: '07001' },
    { city: 'Granada', state: 'Andalusia', country: 'Spain', zipCode: '18001' },
  ] as const,
  ja_JP: [
    { city: 'Tokyo', state: 'Tokyo', country: 'Japan', zipCode: '100-0001' },
    { city: 'Osaka', state: 'Osaka', country: 'Japan', zipCode: '530-0001' },
    { city: 'Yokohama', state: 'Kanagawa', country: 'Japan', zipCode: '220-0011' },
    { city: 'Nagoya', state: 'Aichi', country: 'Japan', zipCode: '450-0001' },
    { city: 'Sapporo', state: 'Hokkaido', country: 'Japan', zipCode: '060-0001' },
    { city: 'Fukuoka', state: 'Fukuoka', country: 'Japan', zipCode: '810-0001' },
    { city: 'Kobe', state: 'Hyogo', country: 'Japan', zipCode: '650-0001' },
    { city: 'Kyoto', state: 'Kyoto', country: 'Japan', zipCode: '600-8001' },
    { city: 'Sendai', state: 'Miyagi', country: 'Japan', zipCode: '980-0001' },
    { city: 'Hiroshima', state: 'Hiroshima', country: 'Japan', zipCode: '730-0001' },
  ] as const,
  pt_BR: [
    { city: 'Sao Paulo', state: 'Sao Paulo', country: 'Brazil', zipCode: '01000-000' },
    { city: 'Rio de Janeiro', state: 'Rio de Janeiro', country: 'Brazil', zipCode: '20000-000' },
    { city: 'Brasilia', state: 'Distrito Federal', country: 'Brazil', zipCode: '70000-000' },
    { city: 'Salvador', state: 'Bahia', country: 'Brazil', zipCode: '40000-000' },
    { city: 'Fortaleza', state: 'Ceara', country: 'Brazil', zipCode: '60000-000' },
    { city: 'Belo Horizonte', state: 'Minas Gerais', country: 'Brazil', zipCode: '30000-000' },
    { city: 'Manaus', state: 'Amazonas', country: 'Brazil', zipCode: '69000-000' },
    { city: 'Curitiba', state: 'Parana', country: 'Brazil', zipCode: '80000-000' },
    { city: 'Recife', state: 'Pernambuco', country: 'Brazil', zipCode: '50000-000' },
    { city: 'Porto Alegre', state: 'Rio Grande do Sul', country: 'Brazil', zipCode: '90000-000' },
  ] as const,
} as const;

/** Prefix map for locale resolution */
const LOCALE_PREFIX_MAP: Record<string, SupportedLocale> = {
  en: 'en_US',
  fr: 'fr_FR',
  de: 'de_DE',
  es: 'es_ES',
  ja: 'ja_JP',
  pt: 'pt_BR',
};

/**
 * Resolve a locale string to a SupportedLocale.
 * Supports exact match and prefix match, falls back to en_US.
 */
function resolveLocale(locale: string): SupportedLocale {
  if (locale in GEO_DATA) {
    return locale as SupportedLocale;
  }
  const prefix = locale.split('_')[0].toLowerCase();
  return LOCALE_PREFIX_MAP[prefix] ?? 'en_US';
}

/**
 * Generates geographically coherent address data.
 * All methods called with the same index return data from the SAME address tuple,
 * ensuring that city, state, country, and zip code are always consistent.
 */
export class GeoCoherentGenerator {
  private readonly tuples: readonly AddressTuple[];
  private readonly resolvedLocale: SupportedLocale;

  /**
   * Create a new GeoCoherentGenerator for the given locale.
   * @param locale - Locale string (e.g. 'fr_FR', 'fr'). Defaults to 'en_US'.
   */
  constructor(locale?: string) {
    this.resolvedLocale = resolveLocale(locale ?? 'en_US');
    this.tuples = GEO_DATA[this.resolvedLocale];
  }

  /**
   * Get a complete coherent address tuple for the given record index.
   * @param index - Record index (wraps around available tuples)
   */
  getAddress(index: number): AddressTuple {
    return this.tuples[index % this.tuples.length];
  }

  /**
   * Get the city for the given record index.
   * Coherent with state/country/zip from the same index.
   */
  getCity(index: number): string {
    return this.getAddress(index).city;
  }

  /**
   * Get the state/region for the given record index.
   * Coherent with city/country/zip from the same index.
   */
  getState(index: number): string {
    return this.getAddress(index).state;
  }

  /**
   * Get the country for the given record index.
   * Coherent with city/state/zip from the same index.
   */
  getCountry(index: number): string {
    return this.getAddress(index).country;
  }

  /**
   * Get the zip code for the given record index.
   * Coherent with city/state/country from the same index.
   */
  getZipCode(index: number): string {
    return this.getAddress(index).zipCode;
  }

  /**
   * Get the locale data associated with this generator's locale.
   * Useful for accessing names, companies, etc. from the same locale.
   */
  getLocaleData() {
    return getLocaleData(this.resolvedLocale);
  }
}
