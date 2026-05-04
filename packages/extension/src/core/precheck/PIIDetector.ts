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

    for (const pattern of this.namePatterns) {
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
