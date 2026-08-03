import type { BadgeVariant } from '../../components/ui/Badge';

/** Job info for display in the jobs DataTable. */
export interface JobDisplayInfo {
  id: string;
  jobType: string;
  status: string;
  objectType?: string;
  createdBy: string;
  createdDate: string;
  totalRecords?: number;
  processedRecords?: number;
  failedRecords?: number;
}

/** Returns progress bar variant based on usage. */
export function usageVariant(pct: number): 'default' | 'warning' | 'error' {
  if (pct > 80) return 'error';
  if (pct >= 60) return 'warning';
  return 'default';
}

/** Returns badge variant based on usage. */
export function usageBadge(pct: number): BadgeVariant {
  if (pct > 80) return 'error';
  if (pct >= 60) return 'warning';
  return 'success';
}

/** Formats MB as GB with one decimal. */
export function fmtGB(mb: number): string {
  return (mb / 1024).toFixed(1);
}
