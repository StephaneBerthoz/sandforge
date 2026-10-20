/**
 * The locale a seed draws its people and places in when nobody chose one:
 * the org's own.
 *
 * The panel drew every seed in en_US — American names, addresses and phone
 * numbers in a French, German or Japanese org — while the command line took a
 * `--locale`. A seed now draws in the org's default locale
 * (`Organization.DefaultLocaleSidKey`) unless one is given: `fr_FR` gives
 * French people in French cities. A locale the generator has no data for
 * draws in the nearest it has (`fr_CA` in French), or in en_US.
 */

/** A locale as Salesforce writes one: `fr`, `fr_FR`, `zh_Hant_TW`. */
const LOCALE_SID = /^[a-z]{2,3}(?:_[A-Za-z0-9]{2,4}){0,2}$/;

/** The org's default locale, or undefined when the org will not say. */
export async function orgSeedLocale(conn: {
  query: (soql: string) => PromiseLike<{ records: Array<Record<string, unknown>> }>;
}): Promise<string | undefined> {
  try {
    const answer = await conn.query('SELECT DefaultLocaleSidKey FROM Organization LIMIT 1');
    const locale = answer.records[0]?.['DefaultLocaleSidKey'];
    return typeof locale === 'string' && LOCALE_SID.test(locale) ? locale : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The locale a seed draws in: the one chosen, or the org's, or en_US.
 *
 * @param chosen - The locale the request or the command line named, if any.
 */
export async function seedLocaleOf(
  chosen: string | undefined,
  conn: Parameters<typeof orgSeedLocale>[0],
): Promise<string> {
  return chosen ?? (await orgSeedLocale(conn)) ?? 'en_US';
}
