/**
 * The field describe shape the CSV import path validates rows against.
 *
 * Types only: this module compiles to nothing.
 */

/** Subset of Salesforce field describe. */
export interface DescribeField {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  defaultValue: unknown;
  picklistValues?: Array<{ value: string; active: boolean }>;
  referenceTo?: string[];
  unique: boolean;
  externalId: boolean;
  length?: number;
  relationshipName?: string;
}
