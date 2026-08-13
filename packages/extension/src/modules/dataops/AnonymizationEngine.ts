import { createHmac, randomBytes } from 'node:crypto';

import type { DataOpsAnonymizationRule, AnonymizationMethod } from '@sandforge/shared';

import { keyedShuffle, PERSONA_FIELD_MAP, PersonaRegistry } from '../autopilot/SmartAnonymizer.js';

/**
 * Number of trailing characters a `truncate` rule keeps.
 *
 * `truncateLength` is not declared on the shared `AnonymizationRuleConfig` yet,
 * so it is read structurally: a rule that already carries one is honoured, and
 * a rule that says nothing keeps nothing. Zero is the only safe default — the
 * caller who never thought about N must not get a plaintext fragment by accident.
 */
function truncateLengthOf(config: DataOpsAnonymizationRule['config']): number {
  const raw: unknown = (config as { truncateLength?: unknown }).truncateLength;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Thrown when a hash rule would produce an unkeyed, brute-forceable digest. */
export class MissingHashSaltError extends Error {
  constructor(fieldApiName: string) {
    super(
      `Hash rule for ${fieldApiName} has no hashSalt. The values being hashed are ` +
        `low-entropy PII (emails, phone numbers, names), so an unkeyed digest is ` +
        `recovered by enumeration in seconds. Set config.hashSalt to a secret value.`,
    );
    this.name = 'MissingHashSaltError';
  }
}

/**
 * Applies anonymization rules to records in order to protect
 * sensitive data (PII, PHI, etc.) before moving data between environments.
 * Supports 8 rule types: mask, hash, fake, nullify, shuffle, truncate,
 * constant, and preserve_format.
 */
export class AnonymizationEngine {
  private readonly personaRegistry: PersonaRegistry;

  /** HMAC key used by rules that carry no `config.hashSalt`. See the constructor. */
  private readonly fallbackKey: string;

  /**
   * @param personaRegistry - Shared persona source. Pass the same registry as the
   *   autopilot run to keep a record's fake identity consistent across modules.
   * @param fallbackKey - HMAC key for `shuffle` and `fake` when the rule carries
   *   no `config.hashSalt`. When omitted a random per-instance key is generated:
   *   outputs stay consistent within a run but differ between runs. There is
   *   deliberately no fixed default — a hardcoded key would make every
   *   installation's permutations identical and therefore invertible by anyone.
   *   `hash` is excluded: it throws instead, because a digest that silently
   *   changes between runs breaks the foreign keys it is meant to preserve.
   */
  constructor(personaRegistry?: PersonaRegistry, fallbackKey?: string) {
    this.personaRegistry = personaRegistry ?? new PersonaRegistry();
    this.fallbackKey = fallbackKey ?? randomBytes(32).toString('hex');
  }

  /**
   * Anonymize all records according to the provided rules.
   * Each rule targets a specific object/field combination.
   * @param records - The records to anonymize
   * @param rules - The anonymization rules to apply
   * @returns A new array of anonymized records (originals are not mutated)
   */
  anonymize(
    records: Record<string, unknown>[],
    rules: DataOpsAnonymizationRule[],
  ): Record<string, unknown>[] {
    return records.map((record) => {
      const copy = { ...record };
      // Every field of a record must draw from the same persona, or a "fake"
      // Contact ends up with one person's name and another's email.
      const recordId = String(record['Id'] ?? record['id'] ?? '');
      for (const rule of rules) {
        if (rule.fieldApiName in copy) {
          copy[rule.fieldApiName] = this.applyRule(copy[rule.fieldApiName], rule, recordId);
        }
      }
      return copy;
    });
  }

  /**
   * Apply a single anonymization rule to a value.
   * Dispatches to the appropriate handler based on rule type.
   * @param value - The original field value
   * @param rule - The anonymization rule to apply
   * @param recordId - Id of the record the value came from, when known. Only
   *   `fake` uses it, to keep one record's fields on one persona.
   * @returns The anonymized value
   */
  applyRule(value: unknown, rule: DataOpsAnonymizationRule, recordId = ''): unknown {
    const handlers: Partial<
      Record<AnonymizationMethod, (v: unknown, r: DataOpsAnonymizationRule) => unknown>
    > = {
      mask: (v, r) => this.applyMask(v, r),
      hash: (v, r) => this.applyHash(v, r),
      fake: (v, r) => this.applyFake(v, r, recordId),
      nullify: () => null,
      shuffle: (v, r) => this.applyShuffle(v, r),
      truncate: (v, r) => this.applyTruncate(v, r),
      constant: (_v, r) => r.config.constantValue ?? '',
      preserve_format: (v) => this.applyPreserveFormat(v),
    };

    const handler = handlers[rule.method];
    if (!handler) {
      return value;
    }
    return handler(value, rule);
  }

  /**
   * Preview anonymization on a limited sample of records.
   * @param records - The full record set
   * @param rules - The anonymization rules to apply
   * @param sampleSize - Maximum number of records to include in the preview
   * @returns Anonymized sample records
   */
  preview(
    records: Record<string, unknown>[],
    rules: DataOpsAnonymizationRule[],
    sampleSize: number,
  ): Record<string, unknown>[] {
    const sample = records.slice(0, Math.max(0, sampleSize));
    return this.anonymize(sample, rules);
  }

  /**
   * Validate a set of anonymization rules and return any errors found.
   * @param rules - The rules to validate
   * @returns Array of validation error messages; empty if all rules are valid
   */
  validateRules(rules: DataOpsAnonymizationRule[]): string[] {
    const errors: string[] = [];

    for (const rule of rules) {
      if (!rule.fieldApiName) {
        errors.push('Rule must specify a fieldApiName');
      }
      if (!rule.objectApiName) {
        errors.push('Rule must specify an objectApiName');
      }
      if (rule.method === 'mask' && !rule.config.maskChar) {
        errors.push(`Mask rule for ${rule.fieldApiName} must specify a maskChar`);
      }
      if (
        rule.method === 'hash' &&
        rule.config.hashAlgorithm !== 'sha256' &&
        rule.config.hashAlgorithm !== 'md5'
      ) {
        errors.push(
          `Hash rule for ${rule.fieldApiName} must specify hashAlgorithm as sha256 or md5`,
        );
      }
      if (rule.method === 'hash' && !rule.config.hashSalt) {
        errors.push(
          `Hash rule for ${rule.fieldApiName} must specify a hashSalt — an unkeyed ` +
            `digest of low-entropy PII is trivially reversible`,
        );
      }
      if (rule.method === 'constant' && rule.config.constantValue === undefined) {
        errors.push(`Constant rule for ${rule.fieldApiName} must specify a constantValue`);
      }
    }

    return errors;
  }

  private applyMask(value: unknown, rule: DataOpsAnonymizationRule): string {
    const str = String(value ?? '');
    const maskChar = rule.config.maskChar ?? '*';
    const start = rule.config.maskStart ?? 0;
    const end = rule.config.maskEnd ?? str.length;

    const chars = str.split('');
    for (let i = start; i < Math.min(end, chars.length); i++) {
      chars[i] = maskChar;
    }
    return chars.join('');
  }

  /**
   * Hash: keyed HMAC over the value.
   *
   * Uses HMAC rather than a bare digest because the inputs are low-entropy PII:
   * an unkeyed hash of a phone number or an email is recovered by enumerating
   * the keyspace, so the salt is the only thing providing real protection —
   * hence {@link MissingHashSaltError} instead of a silent `?? ''` fallback.
   * This mirrors the ADR-0003 model already used by DeterministicPseudonymizer.
   *
   * The digest is truncated to 32 hex chars (128 bits): far beyond collision
   * range for a sandbox dataset, and short enough that the result still fits
   * the Salesforce text fields these values are written back into.
   */
  private applyHash(value: unknown, rule: DataOpsAnonymizationRule): string {
    const salt = rule.config.hashSalt;
    if (!salt) {
      throw new MissingHashSaltError(rule.fieldApiName);
    }
    const algo = rule.config.hashAlgorithm ?? 'sha256';
    const digest = createHmac(algo, salt)
      .update(String(value ?? ''))
      .digest('hex')
      .slice(0, 32);
    return `${algo}:${digest}`;
  }

  /**
   * Fake: substitute a field-appropriate value drawn from a coherent persona.
   *
   * A `fake_<method>_<locale>_<length>` placeholder fails twice over: the
   * character count alone re-identifies a record inside a known population, and
   * the string is not a valid email, phone or postal code, so the anonymized org
   * trips validation rules the real one passed. {@link PersonaRegistry} already
   * produces well-formed values for autopilot; reuse it rather than re-inventing.
   *
   * Personas are keyed by record id when the caller has one. A bare `applyRule`
   * has none, so the key is a keyed digest of the value instead: same value,
   * same persona, and the registry never holds plaintext PII as a map key.
   */
  private applyFake(value: unknown, rule: DataOpsAnonymizationRule, recordId: string): string {
    const personaKey = recordId !== '' ? recordId : this.keyedDigest(String(value ?? ''), rule);
    const persona = this.personaRegistry.getPersona(personaKey);
    const personaField = PERSONA_FIELD_MAP[rule.fieldApiName];
    if (personaField) {
      return persona[personaField];
    }
    // Unmapped field: a fixed-width opaque token, so nothing about the original
    // — its length least of all — survives in the shape of the replacement.
    return `fake_${this.keyedDigest(`${rule.fieldApiName}:${personaKey}`, rule).slice(0, 8)}`;
  }

  /**
   * Shuffle: keyed permutation of the characters.
   *
   * A rotation — or any permutation fixed by the algorithm rather than by a
   * secret — is a public transformation that anyone holding the output can run
   * backwards. See {@link keyedShuffle} for why the key matters, and why
   * `shuffle` is still not a substitute for `fake` or `hash`.
   */
  private applyShuffle(value: unknown, rule: DataOpsAnonymizationRule): string {
    return keyedShuffle(String(value ?? ''), rule.config.hashSalt ?? this.fallbackKey);
  }

  /**
   * Truncate: keep the last N characters, N from `config.truncateLength`.
   *
   * The last N and not the first N: the opening characters of a name, an email
   * local part or a record id are the identifying ones, so a kept prefix leaves
   * "Ale…" standing for Alexander. A suffix narrows far less, and N defaults to
   * 0 so a rule that never specified a length keeps nothing at all.
   */
  private applyTruncate(value: unknown, rule: DataOpsAnonymizationRule): string {
    const keep = truncateLengthOf(rule.config);
    // `slice(-0)` returns the whole string, so zero has to short-circuit.
    return keep === 0 ? '' : String(value ?? '').slice(-keep);
  }

  /** HMAC over `input`, keyed by the rule salt when set and the instance key otherwise. */
  private keyedDigest(input: string, rule: DataOpsAnonymizationRule): string {
    return createHmac('sha256', rule.config.hashSalt ?? this.fallbackKey)
      .update(input)
      .digest('hex');
  }

  private applyPreserveFormat(value: unknown): string {
    const str = String(value ?? '');
    return str.replace(/[a-zA-Z]/g, 'x').replace(/[0-9]/g, '0');
  }
}
