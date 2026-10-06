import { describe, expect, it } from 'vitest';
import type { FieldRule } from '@sandforge/shared';

import { AIDataGenerator } from './AIDataGenerator';
import { FakerFallback } from './FakerFallback';
import { LOCALE_DATA, type SupportedLocale } from './LocaleData';

/**
 * Every email address and phone number Seed generates reaches nobody, in every
 * locale it generates for: a sandbox whose flows mail or text new contacts
 * would otherwise write to whoever holds the address or the number. The rules
 * are written out here rather than read from LocaleData, so that a change
 * there which lets a real domain or a real number through fails here.
 */

/**
 * The domains RFC 2606 reserves (example.com, example.net, example.org) and the
 * names under them, or a name under a top-level domain RFC 2606 and RFC 6761
 * keep from ever being delegated (.example, .invalid, .test).
 */
function isReservedDomain(domain: string): boolean {
  const host = domain.toLowerCase();
  return (
    /^(?:[\p{L}\p{N}-]+\.)*example\.(?:com|net|org)$/u.test(host) ||
    /\.(?:example|invalid|test)$/.test(host)
  );
}

/**
 * The shape of a generated number, per locale, and where its range is
 * published. A locale added to LocaleData fails to compile here until its range
 * is verified and written down.
 */
const RESERVED_PHONE: Record<SupportedLocale, RegExp> = {
  // NANPA, 555 line numbers: 555-0100 to 555-0199 reserved for fiction.
  en_US: /^\+1 [2-9]\d{2}-555-01\d{2}$/,
  // Arcep, plan national de numérotation: numbers for audiovisual works.
  fr_FR: /^\+33 (?:1 99 00|2 61 91|3 53 01|4 65 71|5 36 49|6 39 98) \d{2} \d{2}$/,
  // Bundesnetzagentur, Rufnummern für Medienproduktionen ("Drama Numbers").
  de_DE: /^\+49 (?:30 23125|69 90009|40 66969|221 4710|89 99998) \d{3}$/,
  // No fiction range: plan nacional de numeración telefónica, 4.4, N=3 pending attribution.
  es_ES: /^\+34 3\d{2} \d{3} \d{3}$/,
  // No fiction range: numbering plan notified to the ITU in 2014, 90AXXXXXXX with A=0 not in use.
  ja_JP: /^\+81 90-0\d{3}-\d{4}$/,
  // No fiction range: Anatel Resolution 553/2010, art. 19, series 90N7N6N5 reserved.
  pt_BR: /^\+55 [1-9]{2} 90\d{3}-\d{4}$/,
};

/** A real-looking number of each locale, which the AI model may well write. */
const DIALABLE_PHONE: Record<SupportedLocale, (i: number) => string> = {
  en_US: (i) => `+1 415-867-${String(5000 + i).padStart(4, '0')}`,
  fr_FR: (i) => `+33 6 12 34 ${String(i % 100).padStart(2, '0')} 78`,
  de_DE: (i) => `+49 30 1234${String(i).padStart(4, '0')}`,
  es_ES: (i) => `+34 612 345 ${String(i % 1000).padStart(3, '0')}`,
  ja_JP: (i) => `+81 90-1234-${String(i).padStart(4, '0')}`,
  pt_BR: (i) => `+55 11 91234-${String(i).padStart(4, '0')}`,
};

/** Values generated per locale. */
const N = 1000;

/** Every email address in a text, by its domain. */
function domainsIn(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}._%+-]+@([\p{L}\p{N}.-]+\.\p{L}{2,63})/gu)].map((m) => m[1]);
}

const LOCALES = Object.keys(LOCALE_DATA) as SupportedLocale[];

describe('generated contact points reach nobody', () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      it('writes every faker email on a reserved domain and every faker phone in a reserved range', () => {
        const rules: FieldRule[] = [
          { fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'internet.email' } },
          { fieldApiName: 'Phone', ruleType: 'faker', config: { fakerMethod: 'phone.number' } },
          {
            fieldApiName: 'MobilePhone',
            ruleType: 'faker',
            config: { fakerMethod: 'phone', fakerLocale: locale },
          },
        ];

        const records = new FakerFallback(locale).generate(rules, N);
        const overridden = new FakerFallback(locale === 'en_US' ? 'fr_FR' : 'en_US').generate(
          rules.slice(2),
          N,
        );

        expect(records).toHaveLength(N);
        for (const record of records) {
          const [, domain] = String(record['Email']).split('@');
          expect(isReservedDomain(domain), String(record['Email'])).toBe(true);
          expect(String(record['Phone'])).toMatch(RESERVED_PHONE[locale]);
          expect(String(record['MobilePhone'])).toMatch(RESERVED_PHONE[locale]);
        }
        for (const record of overridden) {
          expect(String(record['MobilePhone'])).toMatch(RESERVED_PHONE[locale]);
        }
      });

      it("holds the AI model's addresses and numbers to the same rules", async () => {
        // The model is asked for reserved values; this one answers with real
        // ones, in fields, in a field it was not asked for and in free text.
        let call = 0;
        const generator = new AIDataGenerator(async (prompt) => {
          const size = Number(/Generate exactly (\d+)/.exec(prompt)?.[1] ?? 0);
          const batch = Array.from({ length: size }, (_, k) => {
            const i = call * 50 + k;
            const phone = DIALABLE_PHONE[locale](i);
            return {
              Contact_Line__c: phone,
              MobilePhone: phone,
              Email__c: `person${i}@company${i % 7}.com`,
              Description: `Write to sales${i}@acme.co.uk or call ${phone}.`,
            };
          });
          call++;
          return JSON.stringify(batch);
        });
        const rules: FieldRule[] = [
          {
            fieldApiName: 'Contact_Line__c',
            fieldType: 'phone',
            ruleType: 'ai_generate',
            config: {},
          },
          { fieldApiName: 'Email__c', fieldType: 'string', ruleType: 'ai_generate', config: {} },
          {
            fieldApiName: 'Description',
            fieldType: 'textarea',
            ruleType: 'ai_generate',
            config: {},
          },
        ];

        const records = await generator.generate(rules, N);

        expect(records).toHaveLength(N);
        for (const [i, record] of records.entries()) {
          expect(String(record['Contact_Line__c'])).toMatch(RESERVED_PHONE[locale]);
          expect(String(record['MobilePhone'])).toMatch(RESERVED_PHONE[locale]);
          const description = String(record['Description']);
          expect(description).not.toContain(DIALABLE_PHONE[locale](i));
          expect(/ or call (.+)\.$/.exec(description)?.[1]).toMatch(RESERVED_PHONE[locale]);
          for (const domain of [
            ...domainsIn(String(record['Email__c'])),
            ...domainsIn(description),
          ]) {
            expect(isReservedDomain(domain), domain).toBe(true);
          }
          expect(domainsIn(description)).toHaveLength(1);
        }
      });
    });
  }
});
