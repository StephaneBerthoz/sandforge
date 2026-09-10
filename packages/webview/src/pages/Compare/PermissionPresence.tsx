import React from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../theme';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** A permission set or profile, named the way the extension returns it. */
export interface NamedPermissionEntry {
  name: string;
  label?: string;
}

/** Presence buckets computed by `CompareHandler.handlePermissions`. */
export interface PermissionPresenceBuckets {
  sourceOnly: NamedPermissionEntry[];
  targetOnly: NamedPermissionEntry[];
  shared: NamedPermissionEntry[];
}

/**
 * The object `CompareHandler.handlePermissions` puts under `permissions`.
 *
 * This is what the extension actually computes: it queries `PermissionSet` and
 * `Profile` by name on both sides and splits the names three ways. It never
 * queries `ObjectPermissions`, so no CRUD grid is derivable from it — which is
 * why this tab compares presence, and shows no CRUD column to imply otherwise.
 */
export interface PermissionComparison {
  permissionSets: PermissionPresenceBuckets;
  profiles: PermissionPresenceBuckets;
}

/** Props for {@link PermissionPresence}. */
export interface PermissionPresenceProps {
  comparison: PermissionComparison;
  sourceLabel: string;
  targetLabel: string;
  className?: string;
}

/** Buckets survive only as arrays; anything else means "no usable payload". */
function readBuckets(value: unknown): PermissionPresenceBuckets | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const { sourceOnly, targetOnly, shared } = raw;
  if (!Array.isArray(sourceOnly) || !Array.isArray(targetOnly) || !Array.isArray(shared)) {
    return undefined;
  }
  return {
    sourceOnly: sourceOnly as NamedPermissionEntry[],
    targetOnly: targetOnly as NamedPermissionEntry[],
    shared: shared as NamedPermissionEntry[],
  };
}

/**
 * Validate a `compare:permissions` payload before it reaches the view.
 *
 * Returns `undefined` rather than a half-filled object: the caller shows the
 * channel's diagnostic instead of a table that would read as "the two orgs
 * grant the same access".
 */
export function readPermissionComparison(value: unknown): PermissionComparison | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const permissionSets = readBuckets(raw.permissionSets);
  const profiles = readBuckets(raw.profiles);
  if (!permissionSets || !profiles) return undefined;
  /* Every Salesforce org has profiles. Six empty buckets is a query that came
     back with nothing, not a finding — and an empty table would read as "the
     two orgs hold the same permission sets". Treated as no answer. */
  const total = [permissionSets, profiles].reduce(
    (sum, b) => sum + b.sourceOnly.length + b.targetOnly.length + b.shared.length,
    0,
  );
  if (total === 0) return undefined;
  return { permissionSets, profiles };
}

/** Salesforce API type of a row — an API name, shown untranslated. */
type PermissionKind = 'PermissionSet' | 'Profile';

/** One row of the presence matrix. */
interface PresenceRow {
  kind: PermissionKind;
  name: string;
  label: string;
  inSource: boolean;
  inTarget: boolean;
  /** Same vocabulary DiffEngine uses: target-only is added, source-only removed. */
  status: 'added' | 'removed' | 'unchanged';
}

/** Presence cell: this org has the permission set, or it does not. */
const PresenceCell: React.FC<{ present: boolean; testId: string }> = ({ present, testId }) => (
  <span
    className={cn(
      'inline-block h-4 w-4 rounded-sm text-center text-[10px] font-bold leading-4',
      present
        ? 'bg-[rgba(16,185,129,0.2)] text-[var(--sf-success)]'
        : 'bg-[rgba(239,68,68,0.1)] text-[var(--sf-error)]',
    )}
    data-testid={testId}
  >
    {present ? '✓' : '✗'}
  </span>
);

/** Flatten the three buckets into rows, differences first. */
function toRows(comparison: PermissionComparison): PresenceRow[] {
  const rows: PresenceRow[] = [];
  const push = (
    kind: PermissionKind,
    entries: NamedPermissionEntry[],
    inSource: boolean,
    inTarget: boolean,
    status: PresenceRow['status'],
  ) => {
    for (const entry of entries) {
      rows.push({
        kind,
        name: entry.name,
        label: entry.label ?? entry.name,
        inSource,
        inTarget,
        status,
      });
    }
  };

  // Source-only and target-only first: they are the reason to open this tab.
  push('PermissionSet', comparison.permissionSets.sourceOnly, true, false, 'removed');
  push('Profile', comparison.profiles.sourceOnly, true, false, 'removed');
  push('PermissionSet', comparison.permissionSets.targetOnly, false, true, 'added');
  push('Profile', comparison.profiles.targetOnly, false, true, 'added');
  push('PermissionSet', comparison.permissionSets.shared, true, true, 'unchanged');
  push('Profile', comparison.profiles.shared, true, true, 'unchanged');
  return rows;
}

/**
 * Which permission sets and profiles exist on each side of the comparison.
 *
 * The tab used to hand this payload to a CRUD matrix expecting
 * `PermissionMatrixRow[]`; the object went into `rows.map` and took the
 * panel's ErrorBoundary down with it. The response is read as what it is: a
 * presence matrix over the two orgs, with no permission-level column that
 * would suggest access was audited.
 */
export const PermissionPresence: React.FC<PermissionPresenceProps> = ({
  comparison,
  sourceLabel,
  targetLabel,
  className,
}) => {
  const { t } = useTranslation();
  const rows = toRows(comparison);

  const statusLabel = (
    status: PresenceRow['status'],
  ): { text: string; variant: 'success' | 'error' | 'default' } => {
    if (status === 'added') return { text: t('compare.added'), variant: 'success' };
    if (status === 'removed') return { text: t('compare.removed'), variant: 'error' };
    return { text: t('compare.unchanged'), variant: 'default' };
  };

  return (
    <Card className={className}>
      <CardHeader title={t('compare.permissions')} />
      <CardBody className="max-h-80 overflow-y-auto">
        {/* `readPermissionComparison` rejects an all-empty payload, so a
            rendered matrix always carries at least one real row. */}
        <table className="w-full text-[10px]" data-testid="perm-presence-matrix">
          <thead>
            <tr className="border-b border-[var(--sf-border)] text-[var(--sf-text-secondary)]">
              <th className="pb-1 pr-3 text-left font-medium" />
              <th className="w-16 pb-1 text-center font-medium" data-testid="perm-header-source">
                {sourceLabel}
              </th>
              <th className="w-16 pb-1 text-center font-medium" data-testid="perm-header-target">
                {targetLabel}
              </th>
              <th className="pb-1 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const status = statusLabel(row.status);
              return (
                <tr
                  key={`${row.kind}-${row.name}`}
                  className={cn(
                    'border-b border-[var(--sf-border)] last:border-0',
                    row.status !== 'unchanged' && 'bg-[rgba(245,158,11,0.05)]',
                  )}
                  data-testid={`perm-row-${row.kind}-${row.name}`}
                >
                  <td className="py-1 pr-3">
                    <span className="mr-2 align-middle">
                      <Badge variant="info">{row.kind}</Badge>
                    </span>
                    <span className="truncate align-middle font-mono text-[var(--sf-text-primary)]">
                      {row.label}
                    </span>
                  </td>
                  <td className="py-1 text-center">
                    <PresenceCell
                      present={row.inSource}
                      testId={`perm-source-${row.kind}-${row.name}`}
                    />
                  </td>
                  <td className="py-1 text-center">
                    <PresenceCell
                      present={row.inTarget}
                      testId={`perm-target-${row.kind}-${row.name}`}
                    />
                  </td>
                  <td className="py-1 text-right">
                    <span data-testid={`perm-status-${row.kind}-${row.name}`}>
                      <Badge variant={status.variant}>{status.text}</Badge>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
};
