/**
 * ForgeAnonymizer wraps SmartAnonymizer for the Forge pipeline.
 * Maps Salesforce fields to anonymization categories via pattern matching
 * and delegates actual anonymization to SmartAnonymizer.
 */

import type { ForgeAnonymizationCategory, ForgeGraph } from '@sandforge/shared';
import type { AnonymizationMethod, AutopilotAnonymizationRule } from '@sandforge/shared';
import { SmartAnonymizer, PersonaRegistry } from '../autopilot/SmartAnonymizer.js';

/** PII field info for anonymization. */
export interface PIIFieldInfo {
  /** Field API name. */
  name: string;
  /** Salesforce field type. */
  type: string;
}

/** A method for some PII categories; a category left out takes its default. */
export type ForgeAnonymizationMethods = Partial<
  Record<ForgeAnonymizationCategory, AnonymizationMethod>
>;

/** What a run anonymizes before it writes. */
export interface ForgeRunAnonymization {
  /** Per object, the source fields selected for anonymization on its node. */
  fields: Record<string, string[]>;
  /** The method Review holds for each PII category. */
  methods: ForgeAnonymizationMethods;
}

/** One object's rows to anonymize before they are written. */
export interface ForgeAnonymizeRequest {
  /** API name of the object the rows belong to. */
  objectApiName: string;
  /** The rows as they are about to be written. */
  records: Record<string, unknown>[];
  /**
   * The source id of each row, index-aligned with `records`. A row cleaned
   * for insert carries no `Id`, and a fake value is drawn from a persona kept
   * per record: keyed by nothing, every row of an object became one person.
   */
  sourceIds: string[];
  /** The fields to anonymize, under the names the rows hold them by. */
  fields: PIIFieldInfo[];
  /** The method for each PII category. */
  methods: ForgeAnonymizationMethods;
}

/**
 * What a run is to anonymize, from what the page sent: nothing with the
 * toggle off, otherwise the fields selected on each node and the methods
 * Review holds.
 *
 * The page sends all three — the toggle in the config, the fields on the
 * graph's nodes, the methods beside them — and the run used to read none of
 * them: every record was written as the source held it.
 *
 * A node left out of the copy keeps its selection: a required parent of
 * that object can still be fetched and written, and what of it is personal
 * is what its node says.
 *
 * @param anonymizePII - The run's anonymize toggle.
 * @param graph - The graph the run executes, with each node's selection.
 * @param methods - The method per category Review holds, when it sent any.
 */
export function runAnonymization(
  anonymizePII: boolean,
  graph: ForgeGraph,
  methods: ForgeAnonymizationMethods = {},
): ForgeRunAnonymization | undefined {
  if (!anonymizePII) return undefined;
  const fields: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    if (node.anonymizeFields.length > 0) fields[node.objectApiName] = [...node.anonymizeFields];
  }
  return { fields, methods: { ...methods } };
}

/** What Salesforce takes as an address in an email field. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An anonymized value an email field will take.
 *
 * Salesforce refuses a row whose email field does not hold an address
 * (`INVALID_EMAIL_ADDRESS`), and most methods do not produce one: a hash, a
 * mask, `[REDACTED]`, or the token `fake` falls back to for any email field
 * but `Email` itself — `PersonEmail` or a custom one. Anonymizing such a field
 * cost the whole row. The value is kept as the part before `@`, under a
 * domain reserved for examples; an empty value stays empty.
 */
function asEmailAddress(value: unknown): unknown {
  if (typeof value !== 'string' || value === '' || EMAIL_SHAPE.test(value)) return value;
  const local =
    value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+|[._]+$/g, '') || 'anonymized';
  return `${local}@example.com`;
}

/**
 * Maps Salesforce fields to anonymization categories and applies anonymization.
 * Wraps SmartAnonymizer from Autopilot for use in the Forge pipeline.
 */
export class ForgeAnonymizer {
  private readonly smartAnonymizer: SmartAnonymizer;

  constructor(personaRegistry?: PersonaRegistry) {
    this.smartAnonymizer = new SmartAnonymizer(personaRegistry);
  }

  /** Categorize a field into a ForgeAnonymizationCategory based on its type and name. */
  categorizeField(fieldName: string, fieldType: string): ForgeAnonymizationCategory {
    // Match by field type first
    const lowerType = fieldType.toLowerCase();
    if (lowerType === 'email') return 'email';
    if (lowerType === 'phone') return 'phone';

    // Match by field name patterns
    const lowerName = fieldName.toLowerCase();
    if (lowerName.includes('email')) return 'email';
    if (lowerName.includes('phone') || lowerName.includes('fax') || lowerName.includes('mobile'))
      return 'phone';
    if (lowerName.includes('firstname') || lowerName.includes('lastname') || lowerName === 'name')
      return 'name';
    if (
      lowerName.includes('street') ||
      lowerName.includes('address') ||
      lowerName.includes('city') ||
      lowerName.includes('state') ||
      lowerName.includes('postalcode') ||
      lowerName.includes('zip') ||
      lowerName.includes('country')
    )
      return 'address';
    if (
      lowerName.includes('ssn') ||
      lowerName.includes('national_id') ||
      lowerName.includes('passport') ||
      lowerName.includes('driver') ||
      lowerName.includes('license')
    )
      return 'ssn_id';
    if (
      lowerName.includes('credit') ||
      lowerName.includes('card') ||
      lowerName.includes('cvv') ||
      lowerName.includes('iban') ||
      lowerName.includes('routing') ||
      lowerName.includes('bank')
    )
      return 'financial';

    return 'other';
  }

  /** Get the default anonymization method for a category. */
  getDefaultMethod(category: ForgeAnonymizationCategory): AnonymizationMethod {
    const defaults: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
      email: 'fake',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    };
    return defaults[category];
  }

  /** Get default methods for all categories. */
  getDefaults(): Record<ForgeAnonymizationCategory, AnonymizationMethod> {
    return {
      email: 'fake',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    };
  }

  /**
   * Anonymize one object's rows as a run writes them: each field with the
   * method of its category, a category the request leaves out with its
   * default, and each row's fake values drawn from the persona of its source
   * record.
   *
   * @returns The rows anonymized, in the same order; the rows passed in are
   *   not mutated, and none gains or loses an `Id`.
   */
  anonymize(request: ForgeAnonymizeRequest): Record<string, unknown>[] {
    if (request.fields.length === 0) return request.records;
    const rules = { ...this.getDefaults(), ...request.methods };
    const keyed = request.records.map((record, index) => ({
      ...record,
      Id: request.sourceIds[index] ?? '',
    }));
    const anonymized = this.anonymizeRecords(keyed, request.fields, rules, request.objectApiName);
    const emailFields = request.fields
      .filter((field) => field.type.toLowerCase() === 'email')
      .map((field) => field.name);
    return anonymized.map((row, index) => {
      const original = request.records[index];
      const written: Record<string, unknown> = { ...row };
      for (const field of emailFields) written[field] = asEmailAddress(written[field]);
      if ('Id' in original) written['Id'] = original['Id'];
      else delete written['Id'];
      return written;
    });
  }

  /**
   * Anonymize records using category-level rules.
   * Converts category rules to field-level rules for SmartAnonymizer.
   *
   * @param records - Records to anonymize.
   * @param piiFields - PII field metadata (name + Salesforce type).
   * @param categoryRules - Anonymization method per category.
   * @param objectApiName - Salesforce object API name.
   * @returns Anonymized records (cloned, originals not mutated).
   */
  anonymizeRecords(
    records: Record<string, unknown>[],
    piiFields: PIIFieldInfo[],
    categoryRules: Record<ForgeAnonymizationCategory, AnonymizationMethod>,
    objectApiName: string,
  ): Record<string, unknown>[] {
    // Convert category rules to per-field AnonymizationRule[]
    const rules: AutopilotAnonymizationRule[] = piiFields.map((field) => {
      const category = this.categorizeField(field.name, field.type);
      return {
        objectApiName,
        fieldApiName: field.name,
        method: categoryRules[category],
        piiCategory: 'PII' as const,
        aiConfidence: 1,
        userOverridden: false,
      };
    });

    // Clone records to avoid mutation
    const cloned = records.map((r) => ({ ...r }));
    return this.smartAnonymizer.anonymize(cloned, rules, objectApiName);
  }
}
