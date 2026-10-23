/**
 * Pseudonymization rules file — the single source of truth mapping
 * `Object.Field` → generator. A field without a rule falls back to the
 * `clear` default so no clear-text ever leaks into the frozen dataset — all
 * but the platform's own words, which are no one's data and which a load
 * cannot do without: the fields of {@link KEPT_WITHOUT_A_RULE}, the settings
 * of {@link SETTINGS_ON_ANY_OBJECT}, and the restricted picklists the source's
 * describe names ({@link withSchemaDefaults}).
 *
 * The file is versioned JSON (`rulesVersion`, semver). A `keep` rule is
 * only honored when it carries `approved: true`, which a human sets after
 * explicit review: keeping a field in clear text is never automatic.
 */

import {
  accountKindOf,
  accountKindRequiring,
  heldToAccountKind,
} from '../../core/common/platformRecords.js';
import type { PIIDetector } from '../../core/precheck/PIIDetector.js';
import { PSEUDONYM_GENERATORS, type PseudonymGenerator } from './DeterministicPseudonymizer.js';
import type { ExtractedDataset } from './types.js';

/** One rule entry of the rules file. */
export interface PseudonymRuleEntry {
  /** Generator applied to the field. */
  generator: PseudonymGenerator;
  /**
   * Mandatory (and only meaningful) for `keep`: proof that a human
   * explicitly reviewed and approved keeping this field in clear text.
   */
  approved?: boolean;
  /** Optional human note (why this generator was chosen). */
  comment?: string;
}

/** Parsed rules file. */
export interface PseudonymRulesFile {
  /** Semver of the rules content, consigned in the manifest. */
  rulesVersion: string;
  /** Rules keyed by `"ObjectApiName.FieldApiName"`. */
  rules: Record<string, PseudonymRuleEntry>;
  /**
   * The fields, keyed as `rules` is, kept without a rule because the source's
   * describe says they hold the schema's own words: see
   * {@link withSchemaDefaults}. Held in memory for one extraction, never read
   * from or written to the file.
   */
  keptBySchema?: ReadonlySet<string>;
  /**
   * The fields, keyed as `rules` is, the personal data detector names from the
   * source's describe: cleared unless a rule declares otherwise, whatever
   * would keep them without one. In memory only, as `keptBySchema`.
   */
  personalBySchema?: ReadonlySet<string>;
}

/** A field as the defaults of the rules read it from the source org's describe. */
export interface RuleSchemaField {
  name: string;
  type: string;
  /** The field's label in the org, which the personal data detector reads too. */
  label?: string;
  /** The org holds the picklist to its own values: no value of anyone's can be written to it. */
  restrictedPicklist?: boolean;
  /** Whether the field takes no value; `false` makes it required. Unknown reads as nillable. */
  nillable?: boolean;
  /** Whether an insert can set the field. Unknown reads as createable. */
  createable?: boolean;
  /** The platform gives the field a value when an insert leaves it out. */
  defaultedOnCreate?: boolean;
  /** The objects a lookup points at; empty for any other field. */
  referenceTo?: readonly string[];
  /** The compound field — an address — the field is a part of, if any. */
  compoundFieldName?: string;
}

/** Error thrown when a rules file fails validation. */
export class RulesFileError extends Error {
  constructor(
    message: string,
    /** Individual validation violations, for actionable reporting. */
    readonly violations: string[] = [],
  ) {
    super(violations.length > 0 ? `${message}:\n- ${violations.join('\n- ')}` : message);
    this.name = 'RulesFileError';
  }
}

const RULES_VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const RULE_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;
const GENERATOR_SET: ReadonlySet<string> = new Set(PSEUDONYM_GENERATORS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize an untrusted rules-file payload.
 *
 * @throws {RulesFileError} Listing every violation found.
 */
export function parsePseudonymRules(payload: unknown): PseudonymRulesFile {
  const violations: string[] = [];
  if (!isPlainObject(payload)) {
    throw new RulesFileError('Rules file must be a JSON object');
  }

  const rulesVersion = payload.rulesVersion;
  if (typeof rulesVersion !== 'string' || !RULES_VERSION_REGEX.test(rulesVersion)) {
    violations.push('rulesVersion is required and must be semver (e.g. "1.0.0")');
  }

  const rawRules = payload.rules;
  if (!isPlainObject(rawRules)) {
    violations.push('rules is required and must be an object keyed by "Object.Field"');
    throw new RulesFileError('Invalid rules file', violations);
  }

  const rules: Record<string, PseudonymRuleEntry> = {};
  for (const [key, rawEntry] of Object.entries(rawRules)) {
    if (!RULE_KEY_REGEX.test(key)) {
      violations.push(`"${key}": key must match "ObjectApiName.FieldApiName"`);
      continue;
    }
    if (!isPlainObject(rawEntry)) {
      violations.push(`"${key}": rule must be an object with a "generator" property`);
      continue;
    }
    const generator = rawEntry.generator;
    if (typeof generator !== 'string' || !GENERATOR_SET.has(generator)) {
      violations.push(
        `"${key}": unknown generator ${JSON.stringify(generator)} ` +
          `(supported: ${PSEUDONYM_GENERATORS.join(', ')})`,
      );
      continue;
    }
    const approved = rawEntry.approved === true;
    if (generator === 'keep' && !approved) {
      // `keep` requires explicit human validation.
      violations.push(
        `"${key}": generator "keep" requires "approved": true (explicit human review)`,
      );
      continue;
    }
    const entry: PseudonymRuleEntry = { generator: generator as PseudonymGenerator };
    if (rawEntry.approved !== undefined) {
      entry.approved = approved;
    }
    if (typeof rawEntry.comment === 'string') {
      entry.comment = rawEntry.comment;
    }
    rules[key] = entry;
  }

  if (violations.length > 0) {
    throw new RulesFileError('Invalid rules file', violations);
  }
  return { rulesVersion: rulesVersion as string, rules };
}

/** Serialize a rules file to stable, human-reviewable JSON. */
export function serializePseudonymRules(file: PseudonymRulesFile): string {
  const sortedKeys = Object.keys(file.rules).sort();
  const sorted: Record<string, PseudonymRuleEntry> = {};
  for (const key of sortedKeys) {
    sorted[key] = file.rules[key];
  }
  return `${JSON.stringify({ rulesVersion: file.rulesVersion, rules: sorted }, null, 2)}\n`;
}

/** The days a business hours record keeps a start and an end time for. */
const WEEK_DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/**
 * Fields kept, not cleared, when the rules name no generator for them.
 *
 * The type of a feed item is one of the platform's own words — a post, a
 * link, a tracked change — and says whether the platform writes the row
 * itself: a load that cannot read it cannot tell a tracked change, which the
 * platform refuses from a copy, from a post. Cleared by default, the tracked
 * change of a real dataset went out untyped, and the target refused it for
 * its missing body. A rule the file declares still wins.
 *
 * The hours an org's business hours and a field service territory's operating
 * hours keep are the org's settings, no one's data, and the platform refuses
 * them without: cleared by default, a real dataset's business hours were
 * refused for no longer holding "at least one day with valid start and end
 * times", and the time zones of both were required. Their names stay cleared:
 * a name is free text, which anyone may have typed anything into.
 */
const KEPT_WITHOUT_A_RULE: ReadonlySet<string> = new Set([
  'FeedItem.Type',
  ...WEEK_DAYS.flatMap((day) => [`BusinessHours.${day}StartTime`, `BusinessHours.${day}EndTime`]),
  'BusinessHours.TimeZoneSidKey',
  'OperatingHours.TimeZone',
  'TimeSlot.DayOfWeek',
  'TimeSlot.StartTime',
  'TimeSlot.EndTime',
  'TimeSlot.Type',
]);

/**
 * Fields the platform names alike on every object that has them, and fills
 * from its own lists: a time zone, a locale, a language, a currency, an email
 * encoding. They hold the org's settings, never a person's words.
 */
const SETTINGS_ON_ANY_OBJECT: ReadonlySet<string> = new Set([
  'TimeZoneSidKey',
  'LocaleSidKey',
  'LanguageLocaleKey',
  'CurrencyIsoCode',
  'EmailEncodingKey',
]);

/**
 * Resolve the effective generator for `objectApiName.fieldApiName`.
 * Fields without a rule default to `clear` — never clear-text — except
 * the platform's own words, kept: those of {@link KEPT_WITHOUT_A_RULE} and
 * {@link SETTINGS_ON_ANY_OBJECT}, and those `keptBySchema` names — but for
 * a field `personalBySchema` names, cleared. A rule the file declares always
 * wins.
 */
export function resolveGenerator(
  rules: PseudonymRulesFile,
  objectApiName: string,
  fieldApiName: string,
): PseudonymGenerator {
  const key = `${objectApiName}.${fieldApiName}`;
  const declared = rules.rules[key]?.generator;
  if (declared) return declared;
  if (rules.personalBySchema?.has(key) === true) return 'clear';
  return KEPT_WITHOUT_A_RULE.has(key) ||
    SETTINGS_ON_ANY_OBJECT.has(fieldApiName) ||
    rules.keptBySchema?.has(key) === true
    ? 'keep'
    : 'clear';
}

/**
 * The rules with what the source's describe tells them: each restricted
 * picklist the rules name no generator for is kept, unless the personal data
 * detector names it.
 *
 * A restricted picklist holds one of the values the schema lists, and nothing
 * anyone typed: a value is a word of the schema, the same in every record that
 * has it. Cleared by default, a real dataset lost the type of every record and
 * a rate its load could not do without, and its first load asked for eighteen
 * declarations. An unrestricted picklist takes any value an API writes, and a
 * multi-select one strings several together on one record: both stay cleared,
 * as free text is. So does the state or the country of an address, a
 * restricted picklist where the org runs state and country picklists: a part
 * of where someone lives, which a dataset of a few records can give away.
 *
 * Nor is a value of the schema always no one's data: a contact's gender
 * identity, a marital status, a religion are restricted picklists in many
 * orgs, and say what a person is. A field the detector names — by its API
 * name or its label, as it names them for every module — stays cleared, and
 * nothing that keeps a field without a rule keeps it. A rule the file declares
 * still wins.
 *
 * A required picklist is kept too, restricted or not: the record cannot be
 * written without one of its values, and its values are the schema's. Run
 * into an org with person accounts and multiple currencies, an opportunity's
 * stage — a standard picklist the platform does not restrict — was cleared,
 * and the extraction asked a default for it that would have given every
 * opportunity of the dataset the same stage.
 *
 * @param schema - The fields of each object the dataset holds, by object.
 * @param detector - The personal data detector the session runs.
 */
export function withSchemaDefaults(
  rules: PseudonymRulesFile,
  schema: ReadonlyMap<string, readonly RuleSchemaField[]>,
  detector: Pick<PIIDetector, 'detectPII'>,
): PseudonymRulesFile {
  const kept = new Set<string>(rules.keptBySchema ?? []);
  const personal = new Set<string>(rules.personalBySchema ?? []);
  for (const [objectApiName, fields] of schema) {
    const named = new Set(
      detector
        .detectPII(
          objectApiName,
          fields.map((f) => ({ apiName: f.name, label: f.label ?? f.name, type: f.type })),
        )
        .piiFields.map((p) => p.fieldApiName),
    );
    for (const field of fields) {
      const key = `${objectApiName}.${field.name}`;
      if (named.has(field.name)) {
        personal.add(key);
      } else if (
        field.type === 'picklist' &&
        (field.restrictedPicklist === true || field.nillable === false) &&
        field.compoundFieldName === undefined
      ) {
        kept.add(key);
      }
    }
  }
  return { ...rules, keptBySchema: kept, personalBySchema: personal };
}

/**
 * The fields of the dataset kept in clear text though the rules declare no
 * generator for them, as `Object.Field`, sorted: what a review of the dataset
 * finds kept without anyone having approved it, and why it may.
 */
export function keptWithoutARule(
  extracted: Pick<ExtractedDataset, 'objects'>,
  rules: PseudonymRulesFile,
): string[] {
  const kept = new Set<string>();
  for (const objectData of extracted.objects) {
    for (const record of objectData.records) {
      for (const field of Object.keys(record.fields)) {
        const key = `${objectData.objectApiName}.${field}`;
        if (
          rules.rules[key] === undefined &&
          resolveGenerator(rules, objectData.objectApiName, field) === 'keep'
        ) {
          kept.add(key);
        }
      }
    }
  }
  return [...kept].sort();
}

/**
 * The fields the source requires that the rules leave empty, as
 * `Object.Field`, sorted: createable, taking no null, given no default by the
 * platform, not a lookup, cleared by the rules, and holding a value in a record
 * the dataset keeps.
 *
 * Said when the dataset is frozen, not only when it is loaded: a real
 * dataset's first load asked for eighteen declarations, each of which the
 * rules file could have settled before the extraction it took to find them. A
 * lookup is left out: what it points at is settled by the load, which links
 * the record in the dataset or stands a placeholder in for one outside it.
 *
 * An account's name is required of a business account and its last name of a
 * person account, which the describe of an org with person accounts does not
 * say (`accountKindRequiring`): each is named when a record of that kind holds
 * a value the rules clear.
 */
export function requiredFieldsLeftEmpty(
  extracted: Pick<ExtractedDataset, 'objects'>,
  rules: PseudonymRulesFile,
  schema: ReadonlyMap<string, readonly RuleSchemaField[]>,
): string[] {
  const left: string[] = [];
  for (const objectData of extracted.objects) {
    const fields = schema.get(objectData.objectApiName) ?? [];
    for (const field of fields) {
      const ofKind = accountKindRequiring(objectData.objectApiName, field.name);
      if (
        field.name === 'Id' ||
        field.createable === false ||
        (field.nillable !== false && ofKind === undefined) ||
        field.defaultedOnCreate === true ||
        field.type === 'reference' ||
        (field.referenceTo?.length ?? 0) > 0
      ) {
        continue;
      }
      if (resolveGenerator(rules, objectData.objectApiName, field.name) !== 'clear') continue;
      const held = objectData.records.some((record) => {
        if (
          ofKind !== undefined &&
          !heldToAccountKind(ofKind, accountKindOf(record.fields, false))
        ) {
          return false;
        }
        const value = record.fields[field.name];
        return value !== undefined && value !== null && value !== '';
      });
      if (held) left.push(`${objectData.objectApiName}.${field.name}`);
    }
  }
  return left.sort();
}

/** The note a rule written by {@link withFieldsCleared} carries, for whoever reads the file next. */
const CLEARED_ON_REVIEW =
  'Cleared on review of the extraction result: kept in clear text without a rule before.';

/** What {@link withFieldsCleared} makes of a rules file. */
export interface ClearedRules {
  /** The file's JSON as it was read, with the rules it gained and its version moved on. */
  payload: Record<string, unknown>;
  /** The version the file carries now. */
  rulesVersion: string;
  /** The fields given a `clear` rule, sorted. */
  cleared: string[];
  /** The fields the file already declared a rule for, left as declared, sorted. */
  alreadyRuled: string[];
}

/**
 * A `clear` rule for each of `fields` the rules file declares nothing for:
 * what a review of {@link keptWithoutARule} decides when a field the
 * extraction kept in clear text is someone's data after all — a restricted
 * picklist of a gender, a status that says too much of a person.
 *
 * Written into the file's JSON as it was read, every other key and rule kept,
 * so nothing the user wrote is lost to the rewrite. The minor number of
 * `rulesVersion` moves on when a rule is added: the manifest names the rules
 * a dataset was frozen with, and the same version on other rules would say
 * the next dataset was frozen with these. A field the file already rules is
 * left as declared. A required picklist cleared leaves the load to ask a value
 * for it, which the next extraction names (`requiredFieldsLeftEmpty`).
 *
 * @throws {RulesFileError} When the payload is not a valid rules file, or a
 *   field is not named `Object.Field`.
 */
export function withFieldsCleared(payload: unknown, fields: readonly string[]): ClearedRules {
  const parsed = parsePseudonymRules(payload);
  const malformed = fields.filter((field) => !RULE_KEY_REGEX.test(field));
  if (malformed.length > 0) {
    throw new RulesFileError(
      'Fields to clear must be named "ObjectApiName.FieldApiName"',
      malformed.map((field) => JSON.stringify(field)),
    );
  }
  const raw = payload as Record<string, unknown>;
  const rules: Record<string, unknown> = { ...(raw.rules as Record<string, unknown>) };
  const cleared: string[] = [];
  const alreadyRuled: string[] = [];
  for (const field of [...new Set(fields)].sort()) {
    if (parsed.rules[field] !== undefined) {
      alreadyRuled.push(field);
      continue;
    }
    rules[field] = { generator: 'clear', comment: CLEARED_ON_REVIEW };
    cleared.push(field);
  }
  const rulesVersion =
    cleared.length > 0 ? nextMinorVersion(parsed.rulesVersion) : parsed.rulesVersion;
  return { payload: { ...raw, rulesVersion, rules }, rulesVersion, cleared, alreadyRuled };
}

/** `1.4.2` → `1.5.0`. */
function nextMinorVersion(version: string): string {
  const [major, minor] = version.split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}
