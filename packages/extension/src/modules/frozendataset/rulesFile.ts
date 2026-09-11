/**
 * Pseudonymization rules file — the single source of truth mapping
 * `Object.Field` → generator (spec §3). No rule is hard-coded in the
 * engine: a field without a rule falls back to the `clear` default so no
 * clear-text ever leaks into the frozen dataset.
 *
 * The file is versioned JSON (`rulesVersion`, semver). A `keep` rule is
 * only honored when it carries `approved: true`, which a human sets after
 * explicit review: keeping a field in clear text is never the default and
 * never automatic.
 */

import { PSEUDONYM_GENERATORS, type PseudonymGenerator } from './DeterministicPseudonymizer.js';

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
      // Spec §3: keep requires explicit human validation.
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

/**
 * Resolve the effective generator for `objectApiName.fieldApiName`.
 * Fields without a rule default to `clear` — never clear-text (spec §3).
 */
export function resolveGenerator(
  rules: PseudonymRulesFile,
  objectApiName: string,
  fieldApiName: string,
): PseudonymGenerator {
  return rules.rules[`${objectApiName}.${fieldApiName}`]?.generator ?? 'clear';
}
