import { createHmac } from 'node:crypto';

import type { DataOpsAnonymizationRule, AnonymizationMethod } from '@sandforge/shared';

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
      for (const rule of rules) {
        if (rule.fieldApiName in copy) {
          copy[rule.fieldApiName] = this.applyRule(copy[rule.fieldApiName], rule);
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
   * @returns The anonymized value
   */
  applyRule(value: unknown, rule: DataOpsAnonymizationRule): unknown {
    const handlers: Partial<
      Record<AnonymizationMethod, (v: unknown, r: DataOpsAnonymizationRule) => unknown>
    > = {
      mask: (v, r) => this.applyMask(v, r),
      hash: (v, r) => this.applyHash(v, r),
      fake: (v, r) => this.applyFake(v, r),
      nullify: () => null,
      shuffle: (v) => this.applyShuffle(v),
      truncate: (v) => this.applyTruncate(v),
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

  private applyFake(value: unknown, rule: DataOpsAnonymizationRule): string {
    const method = rule.config.fakerMethod ?? 'generic';
    const locale = rule.config.fakerLocale ?? 'en';
    const original = String(value ?? '');
    return `fake_${method}_${locale}_${original.length}`;
  }

  private applyShuffle(value: unknown): string {
    const str = String(value ?? '');
    const chars = str.split('');
    for (let i = chars.length - 1; i > 0; i--) {
      const j = i - 1;
      const temp = chars[i];
      chars[i] = chars[j];
      chars[j] = temp;
    }
    return chars.join('');
  }

  private applyTruncate(value: unknown): string {
    const str = String(value ?? '');
    if (str.length <= 3) {
      return str;
    }
    return str.slice(0, 3);
  }

  private applyPreserveFormat(value: unknown): string {
    const str = String(value ?? '');
    return str.replace(/[a-zA-Z]/g, 'x').replace(/[0-9]/g, '0');
  }
}
