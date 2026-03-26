import type { SyncDirection, SyncMode, SyncOperation, ConflictStrategy } from '../types/sync.types.js';

/* ------------------------------------------------------------------ */
/* SyncTemplateConfig interface                                        */
/* ------------------------------------------------------------------ */

/** Object entry within a sync template. */
export interface SyncTemplateObjectEntry {
  /** Salesforce object API name. */
  objectApiName: string;
  /** Sync operation to perform. */
  operation: SyncOperation;
  /** External ID field for upsert matching. */
  externalIdField: string;
  /** Batch size for Bulk API processing. */
  batchSize: number;
  /** Insertion order (0-based sequential). */
  insertOrder: number;
}

/**
 * Pre-built sync template configuration.
 *
 * Unlike a full `SyncConfig`, a template does not include runtime fields
 * (id, orgIds, timestamps). It carries only the reusable sync shape that
 * can be applied to populate wizard state.
 */
export interface SyncTemplateConfig {
  /** Unique template identifier. */
  templateId: string;
  /** i18n key for the template name. */
  nameKey: string;
  /** i18n key for the template description. */
  descriptionKey: string;
  /** Tags for filtering and categorisation. */
  tags: string[];
  /** Objects included in this template. */
  objects: SyncTemplateObjectEntry[];
  /** Default sync direction. */
  direction: SyncDirection;
  /** Default sync mode. */
  mode: SyncMode;
  /** Default conflict resolution strategy. */
  conflictStrategy: ConflictStrategy;
}

/* ------------------------------------------------------------------ */
/* Full Account Hierarchy                                              */
/* ------------------------------------------------------------------ */

/**
 * Pre-built sync template for a full account hierarchy.
 *
 * Insert order: Account -> Contact -> Opportunity -> Task -> Note.
 */
export const SYNC_ACCOUNT_HIERARCHY: SyncTemplateConfig = {
  templateId: 'prebuilt-sync-account-hierarchy',
  nameKey: 'sync.templates.accountHierarchy.name',
  descriptionKey: 'sync.templates.accountHierarchy.description',
  tags: ['prebuilt', 'sales', 'hierarchy'],
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  objects: [
    { objectApiName: 'Account', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 0 },
    { objectApiName: 'Contact', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 1 },
    { objectApiName: 'Opportunity', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 2 },
    { objectApiName: 'Task', operation: 'insert', externalIdField: 'Id', batchSize: 200, insertOrder: 3 },
    { objectApiName: 'Note', operation: 'insert', externalIdField: 'Id', batchSize: 200, insertOrder: 4 },
  ],
};

/* ------------------------------------------------------------------ */
/* Opportunities + Products                                            */
/* ------------------------------------------------------------------ */

/**
 * Pre-built sync template for opportunities with product pricing.
 *
 * Insert order: Pricebook2 -> Product2 -> PricebookEntry -> Opportunity -> OpportunityLineItem.
 */
export const SYNC_OPPS_PRODUCTS: SyncTemplateConfig = {
  templateId: 'prebuilt-sync-opps-products',
  nameKey: 'sync.templates.oppsProducts.name',
  descriptionKey: 'sync.templates.oppsProducts.description',
  tags: ['prebuilt', 'sales', 'products'],
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  objects: [
    { objectApiName: 'Pricebook2', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 0 },
    { objectApiName: 'Product2', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 1 },
    { objectApiName: 'PricebookEntry', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 2 },
    { objectApiName: 'Opportunity', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 3 },
    { objectApiName: 'OpportunityLineItem', operation: 'insert', externalIdField: 'Id', batchSize: 200, insertOrder: 4 },
  ],
};

/* ------------------------------------------------------------------ */
/* Cases + Attachments                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pre-built sync template for service cases with attachments.
 *
 * Insert order: Account -> Contact -> Case -> CaseComment -> Attachment.
 */
export const SYNC_CASES_ATTACHMENTS: SyncTemplateConfig = {
  templateId: 'prebuilt-sync-cases-attachments',
  nameKey: 'sync.templates.casesAttachments.name',
  descriptionKey: 'sync.templates.casesAttachments.description',
  tags: ['prebuilt', 'service', 'attachments'],
  direction: 'source_to_target',
  mode: 'full',
  conflictStrategy: 'source_wins',
  objects: [
    { objectApiName: 'Account', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 0 },
    { objectApiName: 'Contact', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 1 },
    { objectApiName: 'Case', operation: 'upsert', externalIdField: 'Id', batchSize: 200, insertOrder: 2 },
    { objectApiName: 'CaseComment', operation: 'insert', externalIdField: 'Id', batchSize: 200, insertOrder: 3 },
    { objectApiName: 'Attachment', operation: 'insert', externalIdField: 'Id', batchSize: 100, insertOrder: 4 },
  ],
};

/* ------------------------------------------------------------------ */
/* Convenience array                                                   */
/* ------------------------------------------------------------------ */

/** All pre-built sync templates. */
export const PREBUILT_SYNC_TEMPLATES: SyncTemplateConfig[] = [
  SYNC_ACCOUNT_HIERARCHY,
  SYNC_OPPS_PRODUCTS,
  SYNC_CASES_ATTACHMENTS,
];
