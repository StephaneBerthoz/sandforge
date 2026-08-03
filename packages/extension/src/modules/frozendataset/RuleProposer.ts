/**
 * Pattern-based rule proposer (spec §3): suggests a generator per field
 * from its name, type and length so new fields get covered quickly.
 *
 * The proposer NEVER emits `keep`: fields that look safe to keep
 * (picklists, statuses, reference codes) are emitted with the safe
 * `clear` default plus `reviewKeep: true`, inviting a human to switch the
 * rule to `keep` + `approved: true` after explicit review.
 */

import type { PseudonymGenerator } from './DeterministicPseudonymizer.js';

/** Field metadata the proposer patterns match against. */
export interface FieldPatternInput {
  objectApiName: string;
  /** Field API name. */
  name: string;
  /** Salesforce field type (e.g. 'string', 'email', 'date'). */
  type: string;
  /** Declared field length, when described. */
  length?: number;
}

/** A proposed rule for one field. */
export interface ProposedRule {
  /** Rules-file key `"ObjectApiName.FieldApiName"`. */
  key: string;
  /**
   * Proposed generator — never `keep` (human approval required for that).
   */
  generator: PseudonymGenerator;
  /**
   * True when the field looks like a candidate for `keep` after human
   * review (low-sensitivity business categorization).
   */
  reviewKeep: boolean;
  /** Why this generator was proposed. */
  rationale: string;
}

interface NamePattern {
  regex: RegExp;
  generator: PseudonymGenerator;
  rationale: string;
}

/**
 * Ordered name patterns — first match wins. Order matters: `birth` must
 * win over the generic `date` type fallback, `firstName` before
 * `lastName` (a "firstname" field also ends with "name").
 */
const NAME_PATTERNS: NamePattern[] = [
  { regex: /email|e-mail|courriel/i, generator: 'email', rationale: 'email-like field name' },
  { regex: /phone|tel|mobile|fax/i, generator: 'phoneE164', rationale: 'phone-like field name' },
  {
    regex: /first_?name|prenom|prénom|given_?name/i,
    generator: 'firstName',
    rationale: 'first-name-like field name',
  },
  {
    regex: /last_?name|surname|nom_?de_?famille|family_?name/i,
    generator: 'lastName',
    rationale: 'last-name-like field name',
  },
  {
    regex: /company|societe|société|raison_?sociale|employer|employeur/i,
    generator: 'companyName',
    rationale: 'company-like field name',
  },
  {
    regex: /immat|registration|license_?plate|plaque/i,
    generator: 'registrationSIV',
    rationale: 'vehicle-registration-like field name',
  },
  {
    regex: /contract|contrat|police|policy|agreement/i,
    generator: 'contractNumber',
    rationale: 'contract-identifier-like field name',
  },
  {
    regex: /postal|code_?postal|zip_?code|zip$/i,
    generator: 'postalCodeGeneralize',
    rationale: 'postal-code-like field name',
  },
  {
    regex: /birth|naissance|nee?_?le|né/i,
    generator: 'dateMonthStart',
    rationale: 'birthdate-like field name (month-start generalization)',
  },
  {
    regex: /latitude|longitude|geo|_?lat\b|_?lng\b|_?lon\b/i,
    generator: 'geoRound1',
    rationale: 'geo-coordinate-like field name',
  },
  {
    regex: /kilometr|_?km\b|mileage|odometer|compteur/i,
    generator: 'kmRound10',
    rationale: 'mileage-like field name',
  },
];

/** Salesforce types that always map to a generator regardless of name. */
const TYPE_FALLBACKS: Record<string, { generator: PseudonymGenerator; rationale: string }> = {
  email: { generator: 'email', rationale: 'Salesforce email field type' },
  phone: { generator: 'phoneE164', rationale: 'Salesforce phone field type' },
  date: { generator: 'dateShift', rationale: 'Salesforce date field type' },
  datetime: { generator: 'dateShift', rationale: 'Salesforce datetime field type' },
  location: { generator: 'geoRound1', rationale: 'Salesforce location field type' },
};

/** Types that are keep-candidates (low-sensitivity categorization). */
const KEEP_CANDIDATE_TYPES = new Set(['picklist', 'multipicklist', 'boolean', 'combobox']);

/**
 * Propose pseudonymization rules from field patterns. Pure function of
 * field metadata — no org access.
 */
export class RuleProposer {
  /** Propose one rule per field. */
  propose(fields: FieldPatternInput[]): ProposedRule[] {
    return fields.map((f) => this.proposeField(f));
  }

  /** Propose the rule for a single field. */
  proposeField(field: FieldPatternInput): ProposedRule {
    const key = `${field.objectApiName}.${field.name}`;
    const bareName = field.name.replace(/__c$/i, '').replace(/__/g, '_');

    for (const pattern of NAME_PATTERNS) {
      if (pattern.regex.test(bareName)) {
        return {
          key,
          generator: pattern.generator,
          reviewKeep: false,
          rationale: pattern.rationale,
        };
      }
    }

    const typeFallback = TYPE_FALLBACKS[field.type.toLowerCase()];
    if (typeFallback) {
      return {
        key,
        generator: typeFallback.generator,
        reviewKeep: false,
        rationale: typeFallback.rationale,
      };
    }

    if (KEEP_CANDIDATE_TYPES.has(field.type.toLowerCase())) {
      return {
        key,
        generator: 'clear',
        reviewKeep: true,
        rationale:
          'Low-sensitivity categorization type — a human may switch to ' +
          '"keep" with "approved": true after explicit review',
      };
    }

    return {
      key,
      generator: 'clear',
      reviewKeep: false,
      rationale: 'No pattern matched — safe default (never clear-text)',
    };
  }
}
