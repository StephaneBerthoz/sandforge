/** Rule type for data cleaning operations */
export interface CleanRule {
  type: 'trim' | 'deduplicate' | 'normalize_phone' | 'normalize_email' | 'remove_empty';
  fields: string[];
}

/**
 * Cleans and normalizes data records using configurable rules.
 * Provides operations such as whitespace trimming, deduplication,
 * and phone/email normalization.
 */
export class DataCleaner {
  /**
   * Apply a set of cleaning rules to the records.
   * @param records - The records to clean
   * @param rules - The cleaning rules to apply in order
   * @returns A new array of cleaned records
   */
  clean(records: Record<string, unknown>[], rules: CleanRule[]): Record<string, unknown>[] {
    let result = records.map((r) => ({ ...r }));

    for (const rule of rules) {
      switch (rule.type) {
        case 'trim':
          result = this.trimWhitespace(result, rule.fields);
          break;
        case 'deduplicate':
          result = this.removeDuplicates(result, rule.fields);
          break;
        case 'normalize_phone':
          for (const field of rule.fields) {
            result = this.normalizePhoneNumbers(result, field);
          }
          break;
        case 'normalize_email':
          for (const field of rule.fields) {
            result = this.normalizeEmails(result, field);
          }
          break;
        case 'remove_empty':
          result = this.removeEmpty(result, rule.fields);
          break;
      }
    }

    return result;
  }

  /**
   * Trim leading and trailing whitespace from specified fields.
   * @param records - The records to process
   * @param fields - The field names to trim
   * @returns Records with trimmed fields
   */
  trimWhitespace(records: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
    return records.map((record) => {
      const copy = { ...record };
      for (const field of fields) {
        const value = copy[field];
        if (typeof value === 'string') {
          copy[field] = value.trim();
        }
      }
      return copy;
    });
  }

  /**
   * Remove duplicate records based on the combination of specified key fields.
   * The first occurrence of each unique key combination is kept.
   * @param records - The records to deduplicate
   * @param keyFields - The fields that together form the uniqueness key
   * @returns Deduplicated records
   */
  removeDuplicates(
    records: Record<string, unknown>[],
    keyFields: string[],
  ): Record<string, unknown>[] {
    const seen = new Set<string>();
    const result: Record<string, unknown>[] = [];

    for (const record of records) {
      const key = keyFields.map((f) => String(record[f] ?? '')).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...record });
      }
    }

    return result;
  }

  /**
   * Normalize phone number fields by stripping non-digit characters
   * (except leading +) and formatting them consistently.
   * @param records - The records to process
   * @param field - The phone number field name
   * @returns Records with normalized phone numbers
   */
  normalizePhoneNumbers(
    records: Record<string, unknown>[],
    field: string,
  ): Record<string, unknown>[] {
    return records.map((record) => {
      const copy = { ...record };
      const value = copy[field];
      if (typeof value === 'string') {
        const hasPlus = value.startsWith('+');
        const digits = value.replace(/[^0-9]/g, '');
        copy[field] = hasPlus ? `+${digits}` : digits;
      }
      return copy;
    });
  }

  /**
   * Normalize email fields to lowercase and trim whitespace.
   * @param records - The records to process
   * @param field - The email field name
   * @returns Records with normalized emails
   */
  normalizeEmails(records: Record<string, unknown>[], field: string): Record<string, unknown>[] {
    return records.map((record) => {
      const copy = { ...record };
      const value = copy[field];
      if (typeof value === 'string') {
        copy[field] = value.trim().toLowerCase();
      }
      return copy;
    });
  }

  private removeEmpty(
    records: Record<string, unknown>[],
    fields: string[],
  ): Record<string, unknown>[] {
    return records.filter((record) => {
      return fields.some((field) => {
        const value = record[field];
        return value !== null && value !== undefined && value !== '';
      });
    });
  }
}
