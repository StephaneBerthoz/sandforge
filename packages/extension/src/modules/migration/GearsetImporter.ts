import { z } from 'zod';
import type {
  CompareConfig,
  CompareMode,
  MetadataComponentType,
} from '@sandforge/shared';

// ── Gearset Report Zod Schemas ────────────────────────────

/** Schema for a single Gearset component diff */
const gearsetComponentDiffSchema = z.object({
  componentName: z.string().min(1),
  componentType: z.string().min(1),
  status: z.enum(['Added', 'Deleted', 'Modified', 'Unchanged']),
  sourceLastModified: z.string().optional(),
  targetLastModified: z.string().optional(),
  details: z.string().optional(),
});

/** Schema for the Gearset comparison report */
export const gearsetReportSchema = z.object({
  reportName: z.string().min(1),
  sourceOrg: z.object({
    name: z.string().min(1),
    id: z.string().min(1),
  }),
  targetOrg: z.object({
    name: z.string().min(1),
    id: z.string().min(1),
  }),
  comparisonDate: z.string().min(1),
  components: z.array(gearsetComponentDiffSchema),
  includeManaged: z.boolean().optional().default(false),
  includeUnmanaged: z.boolean().optional().default(true),
  filterTypes: z.array(z.string()).optional().default([]),
});

/** Inferred type for the Gearset report format */
export type GearsetReport = z.infer<typeof gearsetReportSchema>;

/** Inferred type for a single Gearset component diff */
export type GearsetComponentDiff = z.infer<typeof gearsetComponentDiffSchema>;

// ── File reader interface ─────────────────────────────────

/** Interface for reading files — allows easy mocking in tests */
export interface FileReader {
  readFile(filePath: string): Promise<string>;
}

// ── GearsetImporter ───────────────────────────────────────

/**
 * Imports Gearset comparison reports and converts them
 * to the SandForge CompareConfig format.
 *
 * Maps Gearset component types to SandForge MetadataComponentType
 * and preserves filter and org information.
 */
export class GearsetImporter {
  private readonly fileReader: FileReader;

  constructor(fileReader: FileReader) {
    this.fileReader = fileReader;
  }

  /**
   * Import a Gearset comparison report file and convert to CompareConfig.
   * @param filePath - Path to the Gearset report JSON file
   * @returns Parsed and converted CompareConfig
   */
  async import(filePath: string): Promise<CompareConfig> {
    const content = await this.fileReader.readFile(filePath);
    const parsed: unknown = JSON.parse(content);
    const validated = gearsetReportSchema.parse(parsed);
    return this.convert(validated);
  }

  /**
   * Extract unique component types from a Gearset report.
   * @param report - Validated Gearset report
   * @returns Array of unique MetadataComponentType values
   */
  extractComponentTypes(report: GearsetReport): MetadataComponentType[] {
    const types = new Set<MetadataComponentType>();
    for (const component of report.components) {
      types.add(mapComponentType(component.componentType));
    }
    return Array.from(types);
  }

  /**
   * Get summary statistics from a Gearset report.
   * @param report - Validated Gearset report
   * @returns Object with counts by status
   */
  getSummary(report: GearsetReport): GearsetSummary {
    let added = 0;
    let deleted = 0;
    let modified = 0;
    let unchanged = 0;

    for (const component of report.components) {
      switch (component.status) {
        case 'Added':
          added++;
          break;
        case 'Deleted':
          deleted++;
          break;
        case 'Modified':
          modified++;
          break;
        case 'Unchanged':
          unchanged++;
          break;
      }
    }

    return { total: report.components.length, added, deleted, modified, unchanged };
  }

  /**
   * Convert a validated Gearset report to CompareConfig.
   * @param report - Validated Gearset report
   * @returns Converted CompareConfig
   */
  private convert(report: GearsetReport): CompareConfig {
    const componentTypes = this.extractComponentTypes(report);
    const mode: CompareMode = determineMode(componentTypes);

    return {
      id: generateId(),
      name: report.reportName,
      sourceOrgId: report.sourceOrg.id,
      targetOrgId: report.targetOrg.id,
      mode,
      componentTypes,
      includeManaged: report.includeManaged,
      includeUnmanaged: report.includeUnmanaged,
      createdAt: report.comparisonDate,
    };
  }
}

/** Summary of a Gearset report */
export interface GearsetSummary {
  total: number;
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
}

/**
 * Map a Gearset component type string to SandForge MetadataComponentType.
 * @param gearsetType - Gearset component type string
 * @returns Mapped MetadataComponentType
 */
function mapComponentType(gearsetType: string): MetadataComponentType {
  const mapping: Record<string, MetadataComponentType> = {
    CustomObject: 'CustomObject',
    CustomField: 'CustomField',
    ApexClass: 'ApexClass',
    ApexTrigger: 'ApexTrigger',
    LightningComponentBundle: 'LightningComponentBundle',
    LightningComponent: 'LightningComponentBundle',
    AuraDefinitionBundle: 'LightningComponentBundle',
    Flow: 'Flow',
    FlowDefinition: 'Flow',
    Layout: 'Layout',
    PageLayout: 'Layout',
    Profile: 'Profile',
    PermissionSet: 'PermissionSet',
    ValidationRule: 'ValidationRule',
    WorkflowRule: 'WorkflowRule',
    RecordType: 'RecordType',
    CustomLabel: 'CustomLabel',
    CustomMetadata: 'CustomMetadata',
    CustomSetting: 'CustomSetting',
    StaticResource: 'StaticResource',
    EmailTemplate: 'EmailTemplate',
    Report: 'Report',
    Dashboard: 'Dashboard',
  };

  return mapping[gearsetType] ?? 'Other';
}

/**
 * Determine the CompareMode based on component types found.
 * @param types - Array of MetadataComponentType
 * @returns Most appropriate CompareMode
 */
function determineMode(types: MetadataComponentType[]): CompareMode {
  const hasPermissions = types.some(
    (t) => t === 'Profile' || t === 'PermissionSet'
  );
  const hasMetadata = types.some(
    (t) => t !== 'Profile' && t !== 'PermissionSet'
  );

  if (hasPermissions && hasMetadata) {
    return 'full';
  }
  if (hasPermissions) {
    return 'permissions';
  }
  return 'metadata';
}

/**
 * Generate a placeholder UUID-like string.
 * @returns Generated ID string
 */
function generateId(): string {
  const segments = [8, 4, 4, 4, 12];
  return segments
    .map((len) => {
      let segment = '';
      for (let i = 0; i < len; i++) {
        segment += Math.floor(Math.random() * 16).toString(16);
      }
      return segment;
    })
    .join('-');
}
