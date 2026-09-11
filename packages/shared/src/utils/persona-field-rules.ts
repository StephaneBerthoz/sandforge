/**
 * Translation from a persona field pattern to a seed field rule.
 *
 * Personas describe generation in their own vocabulary (`generator` +
 * free-form `params`); the seed contract describes it as a `FieldRuleType`
 * plus a {@link FieldRuleConfig}. Both shapes live in this package, so the
 * mapping between them belongs here rather than in the wizard that happens
 * to call it.
 *
 * Only contract keys are emitted: `seedConfigSchema` drops everything else on
 * the way to the extension, so a param left under its persona name reaches no
 * reader at all — the generators then fall back to their defaults (0..1000 for
 * a range, `null` for a picklist, a lorem sentence for faker) and the records
 * no longer match the persona that was picked.
 */

import type { PersonaFieldPatternMsg } from '../types/messages/seed.messages.js';
import type { FieldRuleType, FieldRuleConfig } from '../types/seed.types.js';

/** A persona pattern translated into the seed contract. */
export interface PersonaFieldRule {
  ruleType: FieldRuleType;
  config: FieldRuleConfig;
}

/**
 * faker.js-style method names (`namespace.method`) mapped to the method names
 * FakerFallback understands. Personas — the built-in ones and those an AI
 * writes — quote the faker.js spelling; an unmapped name reaches the reader
 * unchanged and falls back to a lorem sentence there.
 */
const FAKER_METHOD_ALIASES: Record<string, string> = {
  'company.name': 'company',
  'person.firstName': 'firstName',
  'person.lastName': 'lastName',
  'person.fullName': 'name',
  'name.firstName': 'firstName',
  'name.lastName': 'lastName',
  'internet.email': 'email',
  'internet.url': 'url',
  'phone.number': 'phone',
  'location.city': 'city',
  'location.country': 'country',
  'location.state': 'state',
  'location.zipCode': 'zipCode',
  'lorem.sentence': 'sentence',
  'lorem.paragraph': 'paragraph',
  'string.uuid': 'uuid',
  'date.past': 'pastDate',
  'date.future': 'futureDate',
};

/**
 * Map a persona field pattern generator string to the corresponding FieldRuleType.
 *
 * @param generator - The generator type from the persona data patterns
 * @returns The matching FieldRuleType, or null if unmapped
 */
export function mapGeneratorToRuleType(generator: string): FieldRuleType | null {
  const mapping: Record<string, FieldRuleType> = {
    faker: 'faker',
    random_pick: 'picklist_random',
    weighted_pick: 'picklist_random',
    range: 'random',
    sequence: 'sequence',
    pattern: 'regex',
    ai_generate: 'ai_generate',
    relative_date: 'faker',
  };
  return mapping[generator] ?? null;
}

/** First candidate that is a non-empty string. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Numeric params may arrive as strings from an AI-written persona. */
function firstNumber(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Read the allowed values of a pick generator. `random_pick` lists them,
 * `weighted_pick` keys them by value with a weight — the contract carries no
 * weights, so the values themselves are what survives.
 */
function picklistValuesFrom(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  }
  if (typeof raw === 'object' && raw !== null) {
    return Object.keys(raw as Record<string, unknown>);
  }
  return [];
}

/**
 * Translate a persona field pattern into a seed field rule.
 *
 * @param pattern - The persona pattern for one field
 * @returns The rule type and config, or null when the generator is unmapped
 */
export function personaPatternToFieldRule(
  pattern: PersonaFieldPatternMsg,
): PersonaFieldRule | null {
  const ruleType = mapGeneratorToRuleType(pattern.generator);
  if (!ruleType) return null;

  const params: Record<string, unknown> = pattern.params ?? {};
  const config: FieldRuleConfig = {};

  switch (pattern.generator) {
    case 'faker': {
      const method = firstString(params['fakerMethod'], params['method']);
      if (method !== undefined) config.fakerMethod = FAKER_METHOD_ALIASES[method] ?? method;
      const locale = firstString(params['fakerLocale'], params['locale']);
      if (locale !== undefined) config.fakerLocale = locale;
      break;
    }

    case 'relative_date': {
      /* The contract has no day window; the direction of the window is what
         the faker reader can still honour. */
      const days = firstNumber(params['maxDaysFromNow'], params['minDaysFromNow']);
      config.fakerMethod = days !== undefined && days < 0 ? 'pastDate' : 'futureDate';
      break;
    }

    case 'random_pick':
    case 'weighted_pick': {
      const values = picklistValuesFrom(params['picklistValues'] ?? params['values']);
      if (values.length > 0) config.picklistValues = values;
      break;
    }

    case 'range': {
      const min = firstNumber(params['minValue'], params['min']);
      const max = firstNumber(params['maxValue'], params['max']);
      if (min !== undefined) config.minValue = min;
      if (max !== undefined) config.maxValue = max;
      break;
    }

    case 'sequence': {
      const prefix = firstString(params['sequencePrefix'], params['prefix']);
      if (prefix !== undefined) config.sequencePrefix = prefix;
      const start = firstNumber(params['sequenceStart'], params['start']);
      if (start !== undefined) config.sequenceStart = start;
      const step = firstNumber(params['sequenceStep'], params['step']);
      if (step !== undefined) config.sequenceStep = step;
      break;
    }

    case 'pattern': {
      const regexPattern = firstString(params['regexPattern'], params['pattern']);
      if (regexPattern !== undefined) config.regexPattern = regexPattern;
      break;
    }

    case 'ai_generate': {
      /* Personas name the instruction `prompt`; the seed contract calls it
         `aiPrompt`, and that is the only key the model prompt is built from. */
      const aiPrompt = firstString(params['aiPrompt'], params['prompt']);
      if (aiPrompt !== undefined) config.aiPrompt = aiPrompt;
      break;
    }

    default:
      break;
  }

  return { ruleType, config };
}
