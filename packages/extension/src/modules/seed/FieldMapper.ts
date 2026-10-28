import type { SeedObjectConfig, FieldRule, SeedAiFallback, SeedRow } from '@sandforge/shared';
import { phoneReplacement, reachNobody, type AIDataGenerator } from './AIDataGenerator';
import type { FakerFallback } from './FakerFallback';
import { fillDigitMask } from './LocaleData';

/** Dependencies required by FieldMapper */
export interface FieldMapperDependencies {
  aiGenerator: AIDataGenerator;
  fakerFallback: FakerFallback;
  /**
   * Draws the random numbers, picklist values and parents of the rules other
   * than faker's; `Math.random` unless a caller fixes it — the command line's
   * seeded draw.
   */
  random?: () => number;
}

/**
 * Maps field rules to generated values for a given object configuration.
 * Delegates AI and faker generation to their respective sub-services
 * and handles all other rule types internally.
 */
export class FieldMapper {
  private readonly deps: FieldMapperDependencies;

  constructor(deps: FieldMapperDependencies) {
    this.deps = deps;
  }

  /**
   * Generate an array of records for the given object configuration.
   * Uses existingIds to resolve reference fields to previously created records.
   *
   * An object with rows gives each record its row's values, over what its
   * rules generate: record `i` is row `from + i`.
   *
   * @param from - The place of the first record among the object's: a seed
   *   generates an object a slice at a time (`SeedOrchestrator`), and a
   *   sequence, a mask or a phone number goes on from the slice before.
   * @param rowLengths - The most characters each field of the object takes,
   *   by the org's describe: what a row's text is cut to. A field it does not
   *   name is cut to its rule's `maxLength`, if one gives it.
   */
  async mapFields(
    objectConfig: SeedObjectConfig,
    existingIds: Map<string, string[]>,
    onAiFallback?: (fallback: SeedAiFallback) => void,
    from = 0,
    rowLengths?: ReadonlyMap<string, number>,
  ): Promise<Record<string, unknown>[]> {
    const { recordCount, fieldRules, rows } = objectConfig;

    if (recordCount <= 0 || (fieldRules.length === 0 && !rows)) {
      return [];
    }

    const aiRules = fieldRules.filter((r) => r.ruleType === 'ai_generate');
    const fakerRules = fieldRules.filter((r) => r.ruleType === 'faker');
    const replacement = phoneReplacement();
    const otherRules = fieldRules
      .filter((r) => r.ruleType !== 'ai_generate' && r.ruleType !== 'faker')
      .map((rule) => pickingValuesThatReachNobody(rule, replacement));

    const aiRecords =
      aiRules.length > 0 ? await this.deps.aiGenerator.generate(aiRules, recordCount) : [];

    const fakerRecords =
      fakerRules.length > 0 ? this.deps.fakerFallback.generate(fakerRules, recordCount, from) : [];

    // The AI call yields no records when AI is off or the call is refused, and
    // may return fewer records or fields than asked. A field it left out was
    // inserted blank; it now gets a generated sentence, so the run writes what
    // the rule promised and the refusal stays a log line.
    const aiGaps = hasMissingAiValues(aiRules, aiRecords, recordCount);
    const aiFallbackRecords = aiGaps
      ? this.deps.fakerFallback.generate(aiRules.map(toSentenceRule), recordCount, from)
      : [];
    // The log line alone left the run result claiming AI-written values.
    if (aiGaps) {
      onAiFallback?.({
        fields: aiRulesMissingValues(aiRules, aiRecords, recordCount),
        reason: aiRecords.length === 0 ? 'no-answer' : 'short-answer',
      });
    }
    const textRules = [...aiRules, ...fakerRules];
    const random = this.deps.random ?? Math.random;
    const datesTheStage = closeDateFollowsStage(objectConfig);
    const fitRow = rows ? rowFitter(fieldRules, replacement, rowLengths) : undefined;

    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < recordCount; i++) {
      const record: Record<string, unknown> = {};

      for (const rule of otherRules) {
        record[rule.fieldApiName] = generateValue(rule, from + i, existingIds, random);
      }

      if (aiRecords[i]) {
        Object.assign(record, aiRecords[i]);
      }

      for (const rule of aiGaps ? aiRules : []) {
        if (record[rule.fieldApiName] === undefined || record[rule.fieldApiName] === null) {
          record[rule.fieldApiName] = aiFallbackRecords[i]?.[rule.fieldApiName] ?? null;
        }
      }

      if (fakerRecords[i]) {
        Object.assign(record, fakerRecords[i]);
      }

      for (const rule of textRules) {
        record[rule.fieldApiName] = fitToLength(record[rule.fieldApiName], rule.config.maxLength);
      }

      if (datesTheStage && typeof record[OPPORTUNITY_STAGE] === 'string') {
        record[OPPORTUNITY_CLOSE_DATE] = this.deps.fakerFallback.dateOf(
          CLOSED_STAGE.test(record[OPPORTUNITY_STAGE]) ? 'pastDate' : 'futureDate',
        );
      }

      // Last, so that nothing drawn above takes the place of a value the row gives.
      const row = rows?.[from + i];
      if (row && fitRow) Object.assign(record, fitRow(row));

      records.push(record);
    }

    return records;
  }
}

/**
 * What gives a row's values to its record, through what every generated
 * value goes through: an email address or a phone number made to reach
 * nobody (see {@link reachNobody}) — a scenario a model drafted holds its
 * addresses and numbers as much as an answer does — and a text cut to its
 * field's length. Numbers, booleans and nulls go as they are. A phone field
 * is known by its rule's type, as a pick's is, or by its name.
 */
function rowFitter(
  fieldRules: readonly FieldRule[],
  replacement: (written: string) => string,
  lengths: ReadonlyMap<string, number> | undefined,
): (row: SeedRow) => Record<string, unknown> {
  const phoneFields = new Set(
    fieldRules
      .filter((rule) => rule.fieldType?.toLowerCase() === 'phone')
      .map((rule) => rule.fieldApiName),
  );
  const ruleLengths = new Map(
    fieldRules.flatMap((rule) =>
      rule.config.maxLength !== undefined
        ? [[rule.fieldApiName, rule.config.maxLength] as const]
        : [],
    ),
  );
  return (row) => {
    const safe = reachNobody(row.values, phoneFields, replacement);
    for (const [field, value] of Object.entries(safe)) {
      safe[field] = fitToLength(value, lengths?.get(field) ?? ruleLengths.get(field));
    }
    return safe;
  };
}

const OPPORTUNITY_STAGE = 'StageName';
const OPPORTUNITY_CLOSE_DATE = 'CloseDate';

/** A stage that closes an opportunity: `Closed Won`, `Closed Lost` and their like. */
const CLOSED_STAGE = /closed/i;

/**
 * Whether an object's close date is drawn after its stage: an opportunity
 * whose close date the faker draws and whose stage a rule sets. A close date
 * drawn on its own fell after today for an opportunity won or lost, and
 * before it for one still open; it now comes after today for an open stage
 * and before it for a closed one. A close date the author set is theirs.
 */
function closeDateFollowsStage(objectConfig: SeedObjectConfig): boolean {
  if (objectConfig.objectApiName !== 'Opportunity') return false;
  const close = objectConfig.fieldRules.find((r) => r.fieldApiName === OPPORTUNITY_CLOSE_DATE);
  return (
    close?.ruleType === 'faker' &&
    objectConfig.fieldRules.some((r) => r.fieldApiName === OPPORTUNITY_STAGE)
  );
}

/**
 * A pick rule whose values reach nobody: an email address or a phone number
 * among them is rewritten as a model's answer is (see {@link reachNobody}),
 * each value once, so the values are still drawn as often as each other.
 *
 * A persona's random picks become these values, and a persona is as often a
 * model's writing as an answer is: an AI-written persona can give a contact
 * field real-looking addresses and numbers to pick from, which were written
 * to the org as they stood. A picklist's own values are words, and none of
 * them is changed.
 */
function pickingValuesThatReachNobody(
  rule: FieldRule,
  replacement: (written: string) => string,
): FieldRule {
  const values = rule.config.picklistValues;
  if (rule.ruleType !== 'picklist_random' || !values) return rule;
  const phoneFields = new Set(rule.fieldType?.toLowerCase() === 'phone' ? [rule.fieldApiName] : []);
  const safeValues = values.map((value) => {
    const safe = reachNobody({ [rule.fieldApiName]: value }, phoneFields, replacement)[
      rule.fieldApiName
    ];
    return typeof safe === 'string' ? safe : value;
  });
  return { ...rule, config: { ...rule.config, picklistValues: safeValues } };
}

/**
 * A text value cut to the field's length: at the last word boundary within
 * the limit when there is one, otherwise hard. A sentence longer than a short
 * text field failed the insert with STRING_TOO_LONG. Non-text values, and
 * values of rules that set no length, come back unchanged.
 */
function fitToLength(value: unknown, maxLength: number | undefined): unknown {
  if (typeof value !== 'string' || maxLength === undefined || maxLength <= 0) return value;
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  if (/\s/.test(value.charAt(maxLength))) return cut.trimEnd();
  const boundary = cut.search(/\s\S*$/);
  return boundary > 0 ? cut.slice(0, boundary).trimEnd() : cut;
}

/** The AI rules at least one record got no value for, in rule order. */
function aiRulesMissingValues(
  aiRules: FieldRule[],
  aiRecords: Record<string, unknown>[],
  recordCount: number,
): string[] {
  return aiRules
    .filter((rule) =>
      Array.from({ length: recordCount }, (_, i) => aiRecords[i]?.[rule.fieldApiName]).some(
        (value) => value === undefined || value === null,
      ),
    )
    .map((rule) => rule.fieldApiName);
}

/** Whether any record lacks a value for one of the AI rules. */
function hasMissingAiValues(
  aiRules: FieldRule[],
  aiRecords: Record<string, unknown>[],
  recordCount: number,
): boolean {
  if (aiRules.length === 0) return false;
  if (aiRecords.length < recordCount) return true;
  return aiRecords.some((record) =>
    aiRules.some(
      (rule) => record[rule.fieldApiName] === undefined || record[rule.fieldApiName] === null,
    ),
  );
}

/**
 * An AI rule restated as a faker rule that writes a sentence. SeedValidator
 * refuses AI rules on fields that cannot hold text, so the sentence fits.
 */
function toSentenceRule(rule: FieldRule): FieldRule {
  return {
    fieldApiName: rule.fieldApiName,
    ruleType: 'faker',
    config: { fakerMethod: 'sentence' },
  };
}

/**
 * Generate a value for a single field rule at the given record index.
 * Handles static, random, sequence, picklist_random, and reference rule types.
 */
export function generateValue(
  rule: FieldRule,
  index: number,
  existingIds: Map<string, string[]>,
  random: () => number = Math.random,
): unknown {
  switch (rule.ruleType) {
    case 'static':
      return rule.config.staticValue ?? null;

    case 'random':
      return generateRandomValue(rule, random);

    case 'sequence':
      return generateSequenceValue(rule, index);

    case 'picklist_random':
      return generatePicklistValue(rule, random);

    case 'reference':
      return generateReferenceValue(rule, existingIds, random);

    case 'formula':
      return rule.config.formula ?? null;

    case 'regex':
      return generatePatternValue(rule, index);

    case 'from_csv':
      return null;

    default:
      return null;
  }
}

/** Generate a random value respecting min/max constraints */
function generateRandomValue(rule: FieldRule, random: () => number): unknown {
  const min = rule.config.minValue ?? 0;
  const max = rule.config.maxValue ?? 1000;
  return Math.floor(min + random() * (max - min + 1));
}

/** Generate a sequence value with optional prefix */
function generateSequenceValue(rule: FieldRule, index: number): string {
  const start = rule.config.sequenceStart ?? 1;
  const step = rule.config.sequenceStep ?? 1;
  const prefix = rule.config.sequencePrefix ?? '';
  return `${prefix}${start + index * step}`;
}

/**
 * Fill the digit mask the rule carries.
 *
 * `regexPattern` holds a mask, the shape personas and the wizard write it in:
 * '#' stands for a digit and every other character is literal. The mask says
 * what the value looks like — returning it unchanged put '###########00##' in
 * the SIRET column of every inserted record. Patterns written in regex syntax
 * are not expanded: they contain no '#' and come back as they were written.
 */
function generatePatternValue(rule: FieldRule, index: number): string | null {
  const mask = rule.config.regexPattern;
  if (!mask) {
    return null;
  }
  return fillDigitMask(mask, index);
}

/** Pick a random value from the configured picklist values */
function generatePicklistValue(rule: FieldRule, random: () => number): unknown {
  const values = rule.config.picklistValues;
  if (!values || values.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(random() * values.length);
  return values[randomIndex];
}

/** Resolve a reference to a random ID from the target object's created IDs */
function generateReferenceValue(
  rule: FieldRule,
  existingIds: Map<string, string[]>,
  random: () => number,
): unknown {
  const targetObject = rule.config.referenceObject;
  if (!targetObject) {
    return null;
  }

  const ids = existingIds.get(targetObject);
  if (!ids || ids.length === 0) {
    return null;
  }

  const randomIndex = Math.floor(random() * ids.length);
  return ids[randomIndex];
}
