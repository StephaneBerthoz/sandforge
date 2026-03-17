/** All Salesforce field data types */
export const SF_FIELD_TYPES = [
  'id', 'string', 'boolean', 'int', 'double', 'date', 'datetime', 'time',
  'currency', 'percent', 'phone', 'email', 'url', 'textarea', 'richtext',
  'picklist', 'multipicklist', 'combobox', 'reference', 'base64',
  'address', 'location', 'encryptedstring', 'anyType',
] as const;

export type SfFieldType = typeof SF_FIELD_TYPES[number];

/** Field types that are auto-populated by Salesforce (not writable) */
export const SF_AUTO_FIELDS = [
  'Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById',
  'SystemModstamp', 'IsDeleted',
] as const;

/** Field types that support External ID */
export const SF_EXTERNAL_ID_COMPATIBLE_TYPES: SfFieldType[] = [
  'string', 'email', 'int', 'double',
];

/** Maximum field lengths by type */
export const SF_FIELD_MAX_LENGTHS: Partial<Record<SfFieldType, number>> = {
  string: 255,
  textarea: 131_072,
  richtext: 131_072,
  email: 80,
  phone: 40,
  url: 255,
  picklist: 255,
};
