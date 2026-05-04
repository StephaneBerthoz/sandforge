/**
 * Context-aware ranges for currency, number, and date fields.
 * Maps object+field patterns to realistic min/max values so that
 * Opportunity.Amount generates $5K-$500K, not $0-$1000.
 */

/** Range for numeric/currency fields */
export interface AmountRange {
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Number of decimal places */
  decimals: number;
}

/** Range for date fields expressed as days from today */
export interface DateRange {
  /** Minimum days from now (negative = past) */
  minDaysFromNow: number;
  /** Maximum days from now (negative = past) */
  maxDaysFromNow: number;
}

/** Exact object.field match for amount ranges */
const EXACT_AMOUNT_RANGES: Record<string, AmountRange> = {
  'Opportunity.Amount': { min: 5000, max: 500000, decimals: 2 },
  'Opportunity.ExpectedRevenue': { min: 2500, max: 250000, decimals: 2 },
  'OpportunityLineItem.UnitPrice': { min: 50, max: 5000, decimals: 2 },
  'OpportunityLineItem.TotalPrice': { min: 100, max: 50000, decimals: 2 },
};

/** Field name patterns for amount ranges (checked case-insensitively) */
const PATTERN_AMOUNT_RANGES: Array<{ pattern: RegExp; range: AmountRange }> = [
  { pattern: /^AnnualRevenue$/i, range: { min: 100000, max: 10000000, decimals: 0 } },
  { pattern: /^NumberOfEmployees$/i, range: { min: 1, max: 50000, decimals: 0 } },
  { pattern: /Quantity/i, range: { min: 1, max: 1000, decimals: 0 } },
  { pattern: /Discount|Percent/i, range: { min: 0, max: 100, decimals: 1 } },
  { pattern: /Price/i, range: { min: 10, max: 10000, decimals: 2 } },
  { pattern: /Amount|Total/i, range: { min: 100, max: 100000, decimals: 2 } },
];

/** Default fallback for unmatched currency fields */
const FALLBACK_AMOUNT_RANGE: AmountRange = { min: 100, max: 50000, decimals: 2 };

/** Exact object.field match for date ranges */
const EXACT_DATE_RANGES: Record<string, DateRange> = {
  'Opportunity.CloseDate': { minDaysFromNow: 30, maxDaysFromNow: 180 },
};

/** Field name patterns for date ranges */
const PATTERN_DATE_RANGES: Array<{ pattern: RegExp; range: DateRange }> = [
  { pattern: /^Birthdate$/i, range: { minDaysFromNow: -25550, maxDaysFromNow: -6570 } },
  {
    pattern: /^(CreatedDate|LastModifiedDate)$/i,
    range: { minDaysFromNow: -365, maxDaysFromNow: 0 },
  },
  { pattern: /DueDate/i, range: { minDaysFromNow: 7, maxDaysFromNow: 90 } },
  { pattern: /StartDate/i, range: { minDaysFromNow: -30, maxDaysFromNow: 90 } },
  { pattern: /EndDate/i, range: { minDaysFromNow: 30, maxDaysFromNow: 365 } },
];

/** Default fallback for unmatched date fields */
const FALLBACK_DATE_RANGE: DateRange = { minDaysFromNow: -90, maxDaysFromNow: 90 };

/**
 * Get the appropriate amount range for a given object and field.
 * Uses a priority system: exact object.field match first, then field-name pattern, then fallback.
 *
 * @param objectName - Salesforce object API name (e.g. 'Opportunity')
 * @param fieldName - Field API name (e.g. 'Amount')
 * @returns The matching AmountRange
 */
export function getAmountRange(objectName: string, fieldName: string): AmountRange {
  // Exact match
  const key = `${objectName}.${fieldName}`;
  const exact = EXACT_AMOUNT_RANGES[key];
  if (exact) {
    return exact;
  }

  // Pattern match on field name
  for (const entry of PATTERN_AMOUNT_RANGES) {
    if (entry.pattern.test(fieldName)) {
      return entry.range;
    }
  }

  // Fallback
  return FALLBACK_AMOUNT_RANGE;
}

/**
 * Get the appropriate date range for a given object and field.
 * Uses a priority system: exact object.field match first, then field-name pattern, then fallback.
 *
 * @param objectName - Salesforce object API name (e.g. 'Opportunity')
 * @param fieldName - Field API name (e.g. 'CloseDate')
 * @returns The matching DateRange
 */
export function getDateRange(objectName: string, fieldName: string): DateRange {
  // Exact match
  const key = `${objectName}.${fieldName}`;
  const exact = EXACT_DATE_RANGES[key];
  if (exact) {
    return exact;
  }

  // Pattern match on field name
  for (const entry of PATTERN_DATE_RANGES) {
    if (entry.pattern.test(fieldName)) {
      return entry.range;
    }
  }

  // Fallback
  return FALLBACK_DATE_RANGE;
}

/**
 * Generate a deterministic ISO date string within the given range.
 * Spreads values evenly across the range based on the index.
 *
 * @param range - Date range (days from now)
 * @param index - Record index for deterministic generation
 * @returns ISO date string (YYYY-MM-DD)
 */
export function generateDateFromRange(range: DateRange, index: number): string {
  const span = range.maxDaysFromNow - range.minDaysFromNow;
  const offset = span === 0 ? 0 : range.minDaysFromNow + (index % (span + 1));
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().split('T')[0];
}
