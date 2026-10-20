/**
 * The locales a seed can draw its people, companies, addresses and phone
 * numbers in, as Salesforce writes a locale: every locale the generator has
 * names for, which are the six the product is translated into. Any other
 * locale draws in the nearest of them (`fr_CA` in `fr_FR`), or in `en_US`.
 *
 * The panel offers them beside the org's own locale, the default: a seed
 * could be drawn in another locale only from the command line.
 */
export const SEED_LOCALES = ['en_US', 'fr_FR', 'de_DE', 'es_ES', 'ja_JP', 'pt_BR'] as const;

/** One of {@link SEED_LOCALES}. */
export type SeedLocale = (typeof SEED_LOCALES)[number];
