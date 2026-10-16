/**
 * The personal fields of an Autopilot plan, found by the deterministic
 * detector every other module uses, and what a framework that anonymizes
 * expects and finds no rule for.
 *
 * The compliance profile was built from "PII fields detected by the AI
 * scanner" alone, and both the command line and the panel handed it none: run
 * for real with `--compliance gdpr` over leads, accounts and contacts, the
 * plan said `totalPiiFields: 0`, and a GDPR run would have copied every name,
 * email and phone as the source held them. The detector Frozen Dataset,
 * DataOps and Forge read fields with now gives the profile its detections
 * whenever a framework anonymizes; an AI scan, where one runs, adds to them
 * and never takes their place.
 */

import type {
  AnonymizationMethod,
  AnonymizationSummary,
  ApiName,
  AutopilotAnonymizationRule,
  ComplianceFrameworkType,
  ExpectedPersonalData,
  PIICategory,
  PIIFieldDetection,
} from '@sandforge/shared';
import type { PIIDetector, PIIField } from '../../core/precheck/PIIDetector.js';
import { contactPointOf, isPersonNameField } from '../../core/precheck/PIIDetector.js';
import { holdsValue } from '../dataops/personalDataFields.js';
import type { ObjectDescribeResult } from './SchemaScanner.js';

/** The detector's classification, in the compliance engine's categories. */
const CATEGORY: Readonly<Record<PIIField['classification'], PIICategory>> = {
  PII: 'PII',
  PHI: 'PHI',
  PCI: 'PCI',
  Confidential: 'SENSITIVE',
};

/**
 * The method a detection suggests, for a framework whose rule leaves the
 * choice open: the one the framework rules name for its category elsewhere.
 */
const SUGGESTED: Readonly<Record<PIICategory, AnonymizationMethod>> = {
  PII: 'fake',
  PHI: 'nullify',
  PCI: 'mask',
  SENSITIVE: 'hash',
  NONE: 'fake',
};

/** How the detector found a field, in the profile's words. */
const METHOD: Readonly<Record<PIIField['detectionMethod'], PIIFieldDetection['detectionMethod']>> =
  {
    name_pattern: 'field_name',
    type_analysis: 'field_name',
    content_pattern: 'content_sampling',
  };

/** How sure a text field named for an email or a phone is: the detector's own figure for a phone type. */
const CONTACT_POINT_CONFIDENCE = 0.9;

/**
 * The personal fields of every object of a plan that a copy writes, as the
 * detector names them from their API names, labels and types — and, as Forge
 * adds them, the text fields an API name gives to an email address or a phone
 * number, which no pattern finds in an API name.
 *
 * Only fields an insert can set: a computed or stamped field is never sent,
 * and a rule on it anonymizes nothing.
 *
 * @param detector - The detector the session runs (`infraServices.piiDetector`).
 * @param describes - The plan's objects, as the scan described them.
 */
export function detectPersonalFields(
  detector: Pick<PIIDetector, 'detectPII'>,
  describes: ReadonlyMap<ApiName, ObjectDescribeResult>,
): PIIFieldDetection[] {
  const found: PIIFieldDetection[] = [];
  for (const [objectApiName, describe] of describes) {
    const written = describe.fields.filter(
      (f) => f.createable && holdsValue({ name: f.name, label: f.label, type: f.type }),
    );
    const byName = new Map(written.map((f) => [f.name, f]));
    const detected = new Map<string, PIIFieldDetection>();
    const result = detector.detectPII(
      objectApiName,
      written.map((f) => ({ apiName: f.name, label: f.label, type: f.type })),
    );
    for (const detection of result.piiFields) {
      const field = byName.get(detection.fieldApiName);
      if (!field) continue;
      const category = CATEGORY[detection.classification];
      detected.set(field.name, {
        objectApiName,
        fieldApiName: field.name,
        fieldLabel: field.label,
        fieldType: field.type,
        piiCategory: category,
        detectionMethod: METHOD[detection.detectionMethod],
        confidence: detection.confidence,
        suggestedMethod: SUGGESTED[category],
      });
    }
    for (const field of written) {
      if (detected.has(field.name) || contactPointOf(field.name, field.type) === undefined) {
        continue;
      }
      detected.set(field.name, {
        objectApiName,
        fieldApiName: field.name,
        fieldLabel: field.label,
        fieldType: field.type,
        piiCategory: 'PII',
        detectionMethod: 'field_name',
        confidence: CONTACT_POINT_CONFIDENCE,
        suggestedMethod: 'fake',
      });
    }
    found.push(...detected.values());
  }
  return found;
}

/**
 * The detector's findings with an AI scan's added: a field both name keeps
 * the detector's finding, one only the scan names is added. A scan never
 * takes a field away.
 */
export function withAiDetections(
  detected: readonly PIIFieldDetection[],
  ai: readonly PIIFieldDetection[],
): PIIFieldDetection[] {
  const key = (d: PIIFieldDetection): string => `${d.objectApiName}.${d.fieldApiName}`;
  const known = new Set(detected.map(key));
  return [...detected, ...ai.filter((d) => !known.has(key(d)))];
}

/** The objects whose records are people a framework expects anonymized. */
const PERSON_OBJECTS: readonly ApiName[] = ['Contact', 'Lead'];

/**
 * The person objects of a plan on which a framework that anonymizes has no
 * rule for a name, an email or a phone. A contact's or a lead's carries all
 * three; a rule missing for one copies it in clear, and the plan says so.
 * `none` expects nothing.
 *
 * @param framework - The framework the plan runs under.
 * @param objects - The plan's objects.
 * @param rules - The rules the plan applies.
 */
export function personalDataNotCovered(
  framework: ComplianceFrameworkType,
  objects: Iterable<ApiName>,
  rules: readonly AutopilotAnonymizationRule[],
): NonNullable<AnonymizationSummary['notCovered']> {
  if (framework === 'none') return [];
  const planned = new Set(objects);
  const notCovered: NonNullable<AnonymizationSummary['notCovered']> = [];
  for (const objectApiName of PERSON_OBJECTS) {
    if (!planned.has(objectApiName)) continue;
    const covered = rules
      .filter((rule) => rule.objectApiName === objectApiName)
      .map((rule) => rule.fieldApiName);
    const missing: ExpectedPersonalData[] = [];
    if (!covered.some(isPersonNameField)) missing.push('name');
    if (!covered.some((f) => contactPointOf(f, 'string') === 'email')) missing.push('email');
    if (!covered.some((f) => contactPointOf(f, 'string') === 'phone')) missing.push('phone');
    if (missing.length > 0) notCovered.push({ objectApiName, missing });
  }
  return notCovered;
}
