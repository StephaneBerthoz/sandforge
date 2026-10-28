import { describe, it, expect } from 'vitest';
import type { ScenarioPack } from '../types/scenario.types.js';
import { scenarioPackSchema, scenarioPlaceholdersIn } from '../schemas/scenario.schema.js';
import {
  BROADBAND_SUPPORT_PACK,
  BUILT_IN_SCENARIO_PACKS,
  RETAIL_ORDERS_PACK,
  SAAS_SUPPORT_PACK,
} from './scenario-packs.js';

/** Every text of a pack, with where it is. */
function textsOf(pack: ScenarioPack): Array<{ at: string; text: string }> {
  const texts: Array<{ at: string; text: string }> = [];
  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'string') texts.push({ at, text: value });
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${at}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, at ? `${at}.${key}` : key);
    }
  };
  walk(pack, '');
  return texts;
}

describe('BUILT_IN_SCENARIO_PACKS', () => {
  it('offers the three packs, retail orders first', () => {
    expect(BUILT_IN_SCENARIO_PACKS).toEqual([
      RETAIL_ORDERS_PACK,
      BROADBAND_SUPPORT_PACK,
      SAAS_SUPPORT_PACK,
    ]);
    expect(BUILT_IN_SCENARIO_PACKS.map((pack) => pack.id)).toEqual([
      'retail-orders',
      'broadband-support',
      'saas-support',
    ]);
  });

  it('covers the subjects each pack is offered for', () => {
    expect(BUILT_IN_SCENARIO_PACKS.map((pack) => pack.topics.map((topic) => topic.key))).toEqual([
      ['damaged-parcel', 'refund', 'late-delivery', 'address-change', 'warranty'],
      ['outage', 'slow-speed', 'billing-dispute', 'router', 'plan-change'],
      ['sso', 'password', 'invoice', 'data-export', 'api-error'],
    ]);
  });

  describe.each(BUILT_IN_SCENARIO_PACKS.map((pack) => [pack.id, pack] as const))(
    '%s',
    (_id, pack) => {
      it('is a pack the schema takes, in English, for ten customers', () => {
        expect(scenarioPackSchema.safeParse(pack).success).toBe(true);
        expect(pack.language).toBe('en_US');
        expect(pack.customers.count).toBe(10);
      });

      it('holds no address and no number anybody could be reached at', () => {
        for (const { at, text } of textsOf(pack)) {
          expect({ at, at_sign: text.includes('@') }).toEqual({ at, at_sign: false });
          expect({ at, phone: /\d[\d ().-]{6,}\d/.test(text) }).toEqual({ at, phone: false });
        }
      });

      it('lets an agent identify the customer in each topic: an utterance names the address', () => {
        for (const topic of pack.topics) {
          expect(topic.utterances.some((u) => u.text.includes('{email}'))).toBe(true);
        }
      });

      it('expects the open case found wherever an utterance names the address', () => {
        for (const topic of pack.topics) {
          for (const utterance of topic.utterances) {
            if (!utterance.text.includes('{email}')) continue;
            expect(scenarioPlaceholdersIn(utterance.expectedOutcome)).toContain('caseSubject');
          }
        }
      });

      it('gives each topic two case templates whose closed cases are resolved in two steps', () => {
        for (const topic of pack.topics) {
          expect(topic.caseTemplates).toHaveLength(2);
          for (const template of topic.caseTemplates) {
            expect(template.resolution).toHaveLength(2);
            expect(template.resolution.at(-1)).toMatch(/Case closed\.$/);
          }
        }
      });

      it('signs each case description with the customer who opened it', () => {
        for (const template of pack.topics.flatMap((topic) => topic.caseTemplates)) {
          expect(scenarioPlaceholdersIn(template.description)).toEqual(['firstName', 'company']);
        }
      });

      it('gives every case of the pack a subject of its own', () => {
        const subjects = pack.topics.flatMap((t) => t.caseTemplates.map((c) => c.subject));
        expect(new Set(subjects).size).toBe(subjects.length);
      });
    },
  );
});
