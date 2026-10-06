/** Describes a Salesforce field from the describe API */
export interface FieldDescribe {
  apiName: string;
  label: string;
  type: string;
  length?: number;
}

/** A field identified as containing personally identifiable or sensitive information */
export interface PIIField {
  fieldApiName: string;
  fieldLabel: string;
  classification: 'PII' | 'PHI' | 'PCI' | 'Confidential';
  detectionMethod: 'name_pattern' | 'content_pattern' | 'type_analysis';
  confidence: number;
  pattern?: string;
}

/** Result of PII detection on a single Salesforce object */
export interface PIIDetectionResult {
  objectName: string;
  totalFields: number;
  piiFields: PIIField[];
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

interface NamePattern {
  regex: RegExp;
  classification: PIIField['classification'];
  confidence: number;
  label: string;
  /** The field types the pattern holds for; every type when absent. */
  types?: ReadonlySet<string>;
}

/**
 * A person's name or a part of it, in a lowercased API name or label: first,
 * last and middle names (`FirstName`, `Last_Name__c`, "Middle Name", the
 * `FirstNameLocal` some locales add), a surname, and the name a web form
 * supplied on a case. Not the record's own name — "Account Name", "Contact
 * Name" on a lookup — nor the full name a contact composes from its parts,
 * which nobody writes and which follows the parts.
 */
const PERSON_NAME =
  /(?<![a-z])(?:(?:first|last|middle|maiden)[\s_]?name(?:local)?|surname|suppliedname)(?![a-z])/;

/**
 * The types a person's name is written in. A picklist or a checkbox whose name
 * starts like one (`Last_Name_Changed__c`) holds no name, and a made-up name
 * written into it would cost the row.
 */
const NAME_TYPES: ReadonlySet<string> = new Set(['string', 'textarea', 'encryptedstring']);

/**
 * Whether a field's API name says it holds a person's name, as the detector
 * reads it. Exported for the anonymizers, which pick a method by what a field
 * holds and must not take a name for something else.
 *
 * @param apiName - The field's API name, custom suffix included or not.
 */
export function isPersonNameField(apiName: string): boolean {
  return PERSON_NAME.test(apiName.toLowerCase().replace(/__c$/i, ''));
}

/** What a contact point field holds: email addresses, or phone numbers. */
export type ContactPointKind = 'email' | 'phone';

/**
 * The types a contact point is written in as text, beside the email and phone
 * types. A checkbox or a picklist named like one holds a flag or a choice —
 * `Email_Opt_Out__c`, `Phone_Type__c` — and no address or number.
 */
const CONTACT_POINT_TEXT_TYPES: ReadonlySet<string> = new Set([
  'string',
  'textarea',
  'encryptedstring',
]);

/** Words of an API name that give a field to email addresses. */
const EMAIL_WORDS: ReadonlySet<string> = new Set([
  'email',
  'emails',
  'mail',
  'mails',
  'courriel',
  'courriels',
]);

/**
 * The recipients of an email, kept as text: an email message's `ToAddress`,
 * `CcAddress` and `BccAddress` hold the addresses it went to, under no word
 * that names one.
 */
const RECIPIENT_FIELDS: ReadonlySet<string> = new Set(['ToAddress', 'CcAddress', 'BccAddress']);

/** Words of an API name that give a field to phone numbers. */
const PHONE_WORDS: ReadonlySet<string> = new Set([
  'phone',
  'phones',
  'telephone',
  'tel',
  'mobile',
  'cell',
  'fax',
  'sms',
  'gsm',
  'whatsapp',
  'portable',
]);

/**
 * The words of an API name, lowercased: split at underscores, where a small
 * letter meets a capital and between letters and digits, with its suffix and
 * a namespace left out. `Notification_Email__c` reads "notification email",
 * `SuppliedPhone` "supplied phone", `ns__SMSNumber__c` "sms number".
 */
function apiNameWords(apiName: string): string[] {
  return apiName
    .replace(/__[a-z]+$/i, '')
    .replace(/^[a-z0-9]+__/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/**
 * Whether a field holds a contact point, and which: an email or a phone field
 * by its type, a text field by the words of its API name — the last of them
 * that names one, as a name ends on what it holds. The detector's patterns
 * read the words of a label: `\bemail\b` finds "Notification Email" and never
 * `Notification_Email__c`, whose words an underscore joins, and no pattern
 * names a number for texts like `SMS_Number__c`. Any other type holds none,
 * whatever its name.
 *
 * @param apiName - The field's API name.
 * @param type - Its Salesforce type, as the describe gives it.
 */
export function contactPointOf(apiName: string, type: string): ContactPointKind | undefined {
  const lowerType = type.toLowerCase();
  if (lowerType === 'email') return 'email';
  if (lowerType === 'phone') return 'phone';
  if (!CONTACT_POINT_TEXT_TYPES.has(lowerType)) return undefined;
  if (RECIPIENT_FIELDS.has(apiName)) return 'email';
  let kind: ContactPointKind | undefined;
  for (const word of apiNameWords(apiName)) {
    if (EMAIL_WORDS.has(word) || word.endsWith('email')) kind = 'email';
    else if (PHONE_WORDS.has(word) || word.endsWith('phone')) kind = 'phone';
  }
  return kind;
}

/**
 * The personal fields among fields known by API name and type alone, as a
 * describe kept without labels has them — Forge's. The API name stands in for
 * the label, as it always did; a text field named for an email address or a
 * phone number, which no pattern finds in an API name, is added by the words
 * of that name (`contactPointOf`).
 *
 * @param detector - The detector the session runs.
 * @param fields - The object's fields, in the describe's order, kept in it.
 */
export function personalFieldsByApiName(
  detector: Pick<PIIDetector, 'detectPII'>,
  fields: ReadonlyArray<{ name: string; type: string }>,
): string[] {
  const detected = new Set(
    detector
      .detectPII(
        'unknown',
        fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type })),
      )
      .piiFields.map((p) => p.fieldApiName),
  );
  return fields
    .filter((f) => detected.has(f.name) || contactPointOf(f.name, f.type) !== undefined)
    .map((f) => f.name);
}

interface ContentPattern {
  regex: RegExp;
  classification: PIIField['classification'];
  confidence: number;
  label: string;
}

/**
 * Scans Salesforce field metadata and optional sample data to detect
 * fields that may contain PII, PHI, PCI, or other confidential data.
 */
export class PIIDetector {
  private readonly namePatterns: NamePattern[];
  private readonly contentPatterns: ContentPattern[];

  constructor() {
    this.namePatterns = buildNamePatterns();
    this.contentPatterns = buildContentPatterns();
  }

  /**
   * Detect PII fields on a Salesforce object by analyzing field names,
   * field types, and optionally sample record data.
   */
  detectPII(
    objectName: string,
    fields: FieldDescribe[],
    sampleData?: Array<Record<string, unknown>>,
  ): PIIDetectionResult {
    const detected = new Map<string, PIIField>();

    for (const field of fields) {
      this.detectByName(field, detected);
      this.detectByType(field, detected);
    }

    if (sampleData && sampleData.length > 0) {
      for (const field of fields) {
        this.detectByContent(field, sampleData, detected);
      }
    }

    const piiFields = Array.from(detected.values());

    return {
      objectName,
      totalFields: fields.length,
      piiFields,
      riskLevel: computeRiskLevel(piiFields.length),
    };
  }

  /** Return the content detection patterns used by this detector */
  getPatterns(): Record<string, RegExp> {
    const result: Record<string, RegExp> = {};
    for (const pattern of this.contentPatterns) {
      result[pattern.label] = pattern.regex;
    }
    return result;
  }

  /** Check a field's API name and label against known PII name patterns */
  private detectByName(field: FieldDescribe, detected: Map<string, PIIField>): void {
    const nameToCheck = field.apiName.toLowerCase().replace(/__c$/i, '');
    const labelToCheck = field.label.toLowerCase();
    const typeToCheck = field.type.toLowerCase();

    for (const pattern of this.namePatterns) {
      if (pattern.types && !pattern.types.has(typeToCheck)) continue;
      if (pattern.regex.test(nameToCheck) || pattern.regex.test(labelToCheck)) {
        this.addDetection(detected, field, {
          classification: pattern.classification,
          detectionMethod: 'name_pattern',
          confidence: pattern.confidence,
          pattern: pattern.label,
        });
        return;
      }
    }
  }

  /** Check a field's Salesforce type to infer PII classification */
  private detectByType(field: FieldDescribe, detected: Map<string, PIIField>): void {
    if (detected.has(field.apiName)) {
      return;
    }

    const fieldType = field.type.toLowerCase();

    if (fieldType === 'email') {
      this.addDetection(detected, field, {
        classification: 'PII',
        detectionMethod: 'type_analysis',
        confidence: 0.95,
        pattern: 'email_type',
      });
    } else if (fieldType === 'phone') {
      this.addDetection(detected, field, {
        classification: 'PII',
        detectionMethod: 'type_analysis',
        confidence: 0.9,
        pattern: 'phone_type',
      });
    }
  }

  /** Scan sample data values for content matching PII regex patterns */
  private detectByContent(
    field: FieldDescribe,
    sampleData: Array<Record<string, unknown>>,
    detected: Map<string, PIIField>,
  ): void {
    if (detected.has(field.apiName)) {
      return;
    }

    for (const pattern of this.contentPatterns) {
      const matchCount = countContentMatches(field.apiName, sampleData, pattern.regex);

      if (matchCount > 0) {
        const matchRatio = matchCount / sampleData.length;
        const adjustedConfidence = pattern.confidence * Math.min(matchRatio * 2, 1);

        this.addDetection(detected, field, {
          classification: pattern.classification,
          detectionMethod: 'content_pattern',
          confidence: adjustedConfidence,
          pattern: pattern.label,
        });
        return;
      }
    }
  }

  /** Add or update a PII detection entry, keeping the higher-confidence result */
  private addDetection(
    detected: Map<string, PIIField>,
    field: FieldDescribe,
    info: {
      classification: PIIField['classification'];
      detectionMethod: PIIField['detectionMethod'];
      confidence: number;
      pattern: string;
    },
  ): void {
    const existing = detected.get(field.apiName);
    if (existing && existing.confidence >= info.confidence) {
      return;
    }

    detected.set(field.apiName, {
      fieldApiName: field.apiName,
      fieldLabel: field.label,
      classification: info.classification,
      detectionMethod: info.detectionMethod,
      confidence: info.confidence,
      pattern: info.pattern,
    });
  }
}

/** Build the set of regex patterns for matching field API names and labels */
function buildNamePatterns(): NamePattern[] {
  return [
    { regex: /\bemail\b/i, classification: 'PII', confidence: 0.95, label: 'email' },
    { regex: /\bphone\b/i, classification: 'PII', confidence: 0.9, label: 'phone' },
    { regex: /\bmobilephone\b/i, classification: 'PII', confidence: 0.9, label: 'mobile_phone' },
    { regex: /\bpersonemail\b/i, classification: 'PII', confidence: 0.95, label: 'person_email' },
    {
      regex: /\bmailingstreet\b/i,
      classification: 'PII',
      confidence: 0.85,
      label: 'mailing_street',
    },
    {
      regex: /\bbillingstreet\b/i,
      classification: 'PII',
      confidence: 0.85,
      label: 'billing_street',
    },
    { regex: /\bssn\b/i, classification: 'PII', confidence: 0.99, label: 'ssn' },
    {
      regex: /\bsocialsecuritynumber\b/i,
      classification: 'PII',
      confidence: 0.99,
      label: 'social_security_number',
    },
    {
      regex: /\bsocial_security\b/i,
      classification: 'PII',
      confidence: 0.99,
      label: 'social_security',
    },
    { regex: /\bbirthdate\b/i, classification: 'PII', confidence: 0.9, label: 'birthdate' },
    { regex: /\bdateofbirth\b/i, classification: 'PII', confidence: 0.9, label: 'date_of_birth' },
    {
      regex: /\bdate_of_birth\b/i,
      classification: 'PII',
      confidence: 0.9,
      label: 'date_of_birth_underscore',
    },
    { regex: /\bnationalid\b/i, classification: 'PII', confidence: 0.95, label: 'national_id' },
    {
      regex: /\bnational_id\b/i,
      classification: 'PII',
      confidence: 0.95,
      label: 'national_id_underscore',
    },
    {
      regex: /\bcreditcardnumber\b/i,
      classification: 'PCI',
      confidence: 0.99,
      label: 'credit_card_number',
    },
    { regex: /\bcreditcard\b/i, classification: 'PCI', confidence: 0.95, label: 'credit_card' },
    {
      regex: /\bcredit_card\b/i,
      classification: 'PCI',
      confidence: 0.95,
      label: 'credit_card_underscore',
    },
    { regex: /\biban\b/i, classification: 'PCI', confidence: 0.95, label: 'iban' },
    { regex: /\bbankaccount\b/i, classification: 'PCI', confidence: 0.95, label: 'bank_account' },
    {
      regex: /\bbank_account\b/i,
      classification: 'PCI',
      confidence: 0.95,
      label: 'bank_account_underscore',
    },
    { regex: /\bmedical\b/i, classification: 'PHI', confidence: 0.85, label: 'medical' },
    { regex: /\bdiagnos/i, classification: 'PHI', confidence: 0.9, label: 'diagnosis' },
    { regex: /\bhealth\b/i, classification: 'PHI', confidence: 0.8, label: 'health' },
    { regex: /\bpatient\b/i, classification: 'PHI', confidence: 0.8, label: 'patient' },
    { regex: /\bpassport\b/i, classification: 'PII', confidence: 0.95, label: 'passport' },
    { regex: /\bdriver.?licen/i, classification: 'PII', confidence: 0.95, label: 'driver_license' },
    { regex: /\baddress\b/i, classification: 'PII', confidence: 0.8, label: 'address' },
    // Names were never flagged: with "Anonymize PII" on, Forge wrote every
    // contact's first and last name as the source held them.
    {
      regex: PERSON_NAME,
      classification: 'PII',
      confidence: 0.85,
      label: 'person_name',
      types: NAME_TYPES,
    },
  ];
}

/** Build the set of regex patterns for matching field content values */
function buildContentPatterns(): ContentPattern[] {
  // Order matters: more specific patterns must come before broader ones
  // (e.g. SSN and credit card before phone, which is very greedy)
  return [
    {
      regex: /[\w.-]+@[\w.-]+\.\w{2,}/,
      classification: 'PII',
      confidence: 0.9,
      label: 'email_content',
    },
    { regex: /\d{3}-\d{2}-\d{4}/, classification: 'PII', confidence: 0.95, label: 'ssn_content' },
    {
      regex: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/,
      classification: 'PCI',
      confidence: 0.95,
      label: 'credit_card_content',
    },
    {
      regex: /[A-Z]{2}\d{2}[A-Z0-9]{4,}/,
      classification: 'PCI',
      confidence: 0.85,
      label: 'iban_content',
    },
    { regex: /\+?\d[\d\s-]{7,}/, classification: 'PII', confidence: 0.7, label: 'phone_content' },
  ];
}

/** Count how many sample data records have a field value matching the given regex */
function countContentMatches(
  fieldApiName: string,
  sampleData: Array<Record<string, unknown>>,
  regex: RegExp,
): number {
  let count = 0;
  for (const record of sampleData) {
    const value = record[fieldApiName];
    if (typeof value === 'string' && regex.test(value)) {
      count++;
    }
  }
  return count;
}

/** Determine risk level based on the number of detected PII fields */
function computeRiskLevel(piiCount: number): PIIDetectionResult['riskLevel'] {
  if (piiCount === 0) {
    return 'none';
  }
  if (piiCount <= 2) {
    return 'low';
  }
  if (piiCount <= 5) {
    return 'medium';
  }
  if (piiCount <= 10) {
    return 'high';
  }
  return 'critical';
}
