/**
 * ForgeAnonymizer wraps SmartAnonymizer for the Forge pipeline.
 * Maps Salesforce fields to anonymization categories via pattern matching
 * and delegates actual anonymization to SmartAnonymizer.
 *
 * What it writes in an email or a phone field is Forge's own, whatever the
 * method: an address under `.invalid` and a number of the range kept for
 * fiction, as the run's contact point stage writes them
 * (`stages/ContactPointNeutralizer.ts`). SmartAnonymizer's are left to the
 * modules that share it: DataOps draws its personas from the same registry.
 */

import type { ForgeAnonymizationCategory, ForgeGraph } from '@sandforge/shared';
import type { AnonymizationMethod, AutopilotAnonymizationRule } from '@sandforge/shared';
import { SmartAnonymizer, PersonaRegistry } from '../autopilot/SmartAnonymizer.js';
import { contactPointOf, isPersonNameField } from '../../core/precheck/PIIDetector.js';
import { knowsItsFields } from './GraphDiscoveryService.js';
import { ContactPointNeutralizer, EMAIL_FIELD_LENGTH } from './stages/ContactPointNeutralizer.js';

/** PII field info for anonymization. */
export interface PIIFieldInfo {
  /** Field API name. */
  name: string;
  /** Salesforce field type. */
  type: string;
  /** The most characters the field takes, when the describe says. */
  length?: number;
}

/** A method for some PII categories; a category left out takes its default. */
export type ForgeAnonymizationMethods = Partial<
  Record<ForgeAnonymizationCategory, AnonymizationMethod>
>;

/** What a run anonymizes before it writes. */
export interface ForgeRunAnonymization {
  /**
   * Per object whose node knows its fields, the source fields selected for
   * anonymization on it — none when the user deselected them all.
   */
  fields: Record<string, string[]>;
  /** The method Review holds for each PII category. */
  methods: ForgeAnonymizationMethods;
  /**
   * The personal fields of an object `fields` says nothing about, as
   * discovery would have named them on its node: an orphan parent fetched
   * from outside the graph, or an object whose node was never described.
   * Absent, such an object is written as the source holds it.
   */
  personalFieldsOf?: (fields: PIIFieldInfo[]) => string[];
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
 * is what its node says. An object no node knows the fields of — an orphan
 * parent from outside the graph, a node of a starter template's graph whose
 * fields were never read — takes what `personalFieldsOf` names in its fields
 * at the write: such parents used to be written as the source held them,
 * names and emails included, whatever the toggle said.
 *
 * @param anonymizePII - The run's anonymize toggle.
 * @param graph - The graph the run executes, with each node's selection.
 * @param methods - The method per category Review holds, when it sent any.
 * @param personalFieldsOf - The personal fields of an object, as discovery
 *   names them on a node.
 */
export function runAnonymization(
  anonymizePII: boolean,
  graph: ForgeGraph,
  methods: ForgeAnonymizationMethods = {},
  personalFieldsOf?: (fields: PIIFieldInfo[]) => string[],
): ForgeRunAnonymization | undefined {
  if (!anonymizePII) return undefined;
  const fields: Record<string, string[]> = {};
  for (const node of graph.nodes) {
    if (knowsItsFields(node)) fields[node.objectApiName] = [...node.anonymizeFields];
  }
  return { fields, methods: { ...methods }, ...(personalFieldsOf ? { personalFieldsOf } : {}) };
}

/** What Salesforce takes as an address in an email field. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The domain a persona's address is under. */
const PERSONA_DOMAIN = /@example\.com$/i;

/** Where a persona's address goes, and an anonymized value that is no address. */
const UNDELIVERABLE_DOMAIN = '@example.invalid';

/** The longest local part an address takes. */
const LOCAL_PART_LENGTH = 64;

/**
 * The methods whose output for a phone field still reads as a number: a fake
 * one, the last four digits behind a mask, the digits shuffled or redrawn in
 * the same format. Each could ring a line someone holds.
 */
const NUMBER_METHODS: ReadonlySet<AnonymizationMethod> = new Set([
  'fake',
  'mask',
  'preserve_format',
  'shuffle',
]);

/**
 * An anonymized value an email field will take, under a domain no address is
 * ever delivered to.
 *
 * Salesforce refuses a row whose email field does not hold an address
 * (`INVALID_EMAIL_ADDRESS`), and most methods do not produce one: a hash, a
 * mask, `[REDACTED]`, or the token `fake` falls back to for any email field
 * but `Email` itself — `PersonEmail` or a custom one. Anonymizing such a field
 * cost the whole row. The value is kept as the part before `@`, under
 * `example.invalid`; an empty value stays empty.
 *
 * Anonymized addresses went to `example.com`, a persona's `first.last` among
 * them, and a method that keeps the domain — `generalize`, `preserve_format` —
 * kept a real one. A persona's address now goes under `example.invalid`, and
 * any other under `.invalid` after its domain, as the contact point stage
 * writes it.
 *
 * @param maxLength - The most characters the field takes.
 */
function asUndeliverableAddress(
  value: unknown,
  contactPoints: ContactPointNeutralizer,
  maxLength: number,
): unknown {
  if (typeof value !== 'string' || value === '') return value;
  if (!EMAIL_SHAPE.test(value)) {
    const local =
      value
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, LOCAL_PART_LENGTH)
        .replace(/^[._]+|[._]+$/g, '') || 'anonymized';
    return `${local}${UNDELIVERABLE_DOMAIN}`;
  }
  return contactPoints.email(value.replace(PERSONA_DOMAIN, UNDELIVERABLE_DOMAIN), maxLength);
}

/**
 * Maps Salesforce fields to anonymization categories and applies anonymization.
 * Wraps SmartAnonymizer from Autopilot for use in the Forge pipeline.
 */
export class ForgeAnonymizer {
  private readonly smartAnonymizer: SmartAnonymizer;

  /** What draws the addresses and the fictional numbers written in their place. */
  private readonly contactPoints: ContactPointNeutralizer;

  /**
   * @param personaRegistry - Shared registry for cross-object coherent fakes.
   * @param salt - The key the fictional numbers are drawn with; omitted, a
   *   random one, so a run's numbers say nothing of the next run's.
   */
  constructor(personaRegistry?: PersonaRegistry, salt?: string) {
    this.smartAnonymizer = new SmartAnonymizer(personaRegistry);
    this.contactPoints = new ContactPointNeutralizer(salt);
  }

  /** Categorize a field into a ForgeAnonymizationCategory based on its type and name. */
  categorizeField(fieldName: string, fieldType: string): ForgeAnonymizationCategory {
    // Match by field type first
    const lowerType = fieldType.toLowerCase();
    if (lowerType === 'email') return 'email';
    if (lowerType === 'phone') return 'phone';
    // A text its API name gives to an email address or a phone number:
    // `SMS_Number__c` fell to `other`, whose default empties the field.
    const contactPoint = contactPointOf(fieldName, fieldType);
    if (contactPoint) return contactPoint;

    // Match by field name patterns
    const lowerName = fieldName.toLowerCase();
    if (lowerName.includes('email')) return 'email';
    if (lowerName.includes('phone') || lowerName.includes('fax') || lowerName.includes('mobile'))
      return 'phone';
    // Every field the detector calls a name, not only the two standard ones:
    // `Last_Name__c` or `MiddleName` fell to `other`, whose default empties the
    // field, and a required custom name then cost its row.
    if (
      lowerName.includes('firstname') ||
      lowerName.includes('lastname') ||
      lowerName === 'name' ||
      isPersonNameField(fieldName)
    )
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
   * An email field takes an address under `.invalid`; a phone field whose
   * method leaves a number takes a fictional one, drawn from the value it
   * replaces, where the mask kept the last four digits of the real one and a
   * fake was a number of no range kept for fiction.
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
    const emailFields = request.fields.filter(
      (field) => this.categorizeField(field.name, field.type) === 'email',
    );
    const numberFields = NUMBER_METHODS.has(rules.phone)
      ? request.fields.filter((field) => this.categorizeField(field.name, field.type) === 'phone')
      : [];
    return anonymized.map((row, index) => {
      const original = request.records[index];
      const written: Record<string, unknown> = { ...row };
      for (const field of emailFields) {
        written[field.name] = this.undeliverable(written[field.name], field);
      }
      for (const field of numberFields) {
        written[field.name] = this.fictionalNumber(
          original[field.name],
          written[field.name],
          field,
        );
      }
      if ('Id' in original) written['Id'] = original['Id'];
      else delete written['Id'];
      return written;
    });
  }

  /**
   * What an email field takes of its anonymized value: an address under a
   * domain no address is ever delivered to. An email field holds one address
   * or none (`asUndeliverableAddress`); a text of the category — a backup
   * address kept as text — has each address in it put under `.invalid`, a
   * method that keeps the domain having kept a real one.
   */
  private undeliverable(value: unknown, field: PIIFieldInfo): unknown {
    const maxLength = field.length !== undefined && field.length > 0 ? field.length : undefined;
    if (field.type.toLowerCase() === 'email') {
      return asUndeliverableAddress(value, this.contactPoints, maxLength ?? EMAIL_FIELD_LENGTH);
    }
    if (typeof value !== 'string') return value;
    return this.contactPoints.addressesIn(
      value.replace(/@example\.com(?![\w.-])/gi, UNDELIVERABLE_DOMAIN),
      maxLength,
    );
  }

  /**
   * The fictional number a phone field takes for the value it held, within the
   * field's length. A value with no digit holds no number, and stays as it
   * was: `fake` gave an empty phone field a persona's number of its own.
   */
  private fictionalNumber(held: unknown, anonymized: unknown, field: PIIFieldInfo): unknown {
    if (typeof held !== 'string') return anonymized;
    if (!/\d/.test(held)) return held;
    const maxLength = field.length !== undefined && field.length > 0 ? field.length : undefined;
    return this.contactPoints.phone(held, maxLength);
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
