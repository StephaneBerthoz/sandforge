import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import type { EnrichedDiff, DiffRiskLevel } from '@sandforge/shared';

/** Props for the DiffGroupAccordion component. */
export interface DiffGroupAccordionProps {
  diffs: EnrichedDiff[];
  onSelectDiff?: (diff: EnrichedDiff) => void;
  className?: string;
}

/** Badge variant for risk level. */
const riskBadge: Record<DiffRiskLevel, BadgeVariant> = {
  none: 'default',
  low: 'success',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

/** Badge variant for change type. */
const changeBadge: Record<EnrichedDiff['changeType'], BadgeVariant> = {
  added: 'success',
  removed: 'error',
  modified: 'warning',
};

/** Symbol for change type. */
const changeSymbol: Record<EnrichedDiff['changeType'], string> = {
  added: '+',
  removed: '-',
  modified: '~',
};

/** Group info computed from diffs. */
interface DiffGroup {
  name: string;
  diffs: EnrichedDiff[];
  maxRisk: DiffRiskLevel;
  counts: { added: number; removed: number; modified: number };
}

/** Risk level ordering for comparison. */
const RISK_ORDER: Record<DiffRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Compute the maximum risk level from a list of diffs. */
function maxRiskLevel(diffs: EnrichedDiff[]): DiffRiskLevel {
  let max: DiffRiskLevel = 'none';
  for (const d of diffs) {
    if (RISK_ORDER[d.riskLevel] > RISK_ORDER[max]) {
      max = d.riskLevel;
    }
  }
  return max;
}

/** Group diffs by their group field. */
function buildGroups(diffs: EnrichedDiff[]): DiffGroup[] {
  const map = new Map<string, EnrichedDiff[]>();

  for (const diff of diffs) {
    const group = diff.group || 'Other';
    const arr = map.get(group) ?? [];
    arr.push(diff);
    map.set(group, arr);
  }

  return Array.from(map.entries())
    .map(([name, groupDiffs]) => ({
      name,
      diffs: groupDiffs,
      maxRisk: maxRiskLevel(groupDiffs),
      counts: {
        added: groupDiffs.filter((d) => d.changeType === 'added').length,
        removed: groupDiffs.filter((d) => d.changeType === 'removed').length,
        modified: groupDiffs.filter((d) => d.changeType === 'modified').length,
      },
    }))
    .sort((a, b) => RISK_ORDER[b.maxRisk] - RISK_ORDER[a.maxRisk]);
}

/**
 * Accordion that groups enriched diffs by logical group (e.g., "Apex Code", "Data Model").
 * Each group header shows the group name, diff count, and max risk badge.
 * Expanding a group reveals individual diff items with their risk level.
 */
export const DiffGroupAccordion: React.FC<DiffGroupAccordionProps> = ({
  diffs,
  onSelectDiff,
  className,
}) => {
  const { t } = useTranslation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => buildGroups(diffs), [diffs]);

  const toggleGroup = (name: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (diffs.length === 0) {
    return (
      <p
        style={{
          fontSize: 'var(--sf-font-size-sm)',
          color: 'var(--sf-text-muted)',
          textAlign: 'center',
          padding: 'var(--sf-space-6) 0',
        }}
        data-testid="no-diffs"
      >
        {t('compare.noResults', 'No comparison results yet')}
      </p>
    );
  }

  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-2)' }}
      data-testid="diff-groups"
    >
      {groups.map((group) => {
        const isExpanded = expandedGroups.has(group.name);
        return (
          <div
            key={group.name}
            style={{
              borderRadius: 'var(--sf-radius-md)',
              border: '1px solid var(--sf-border)',
              overflow: 'hidden',
            }}
            data-testid={`diff-group-${group.name}`}
          >
            {/* Group header */}
            <button
              type="button"
              onClick={() => toggleGroup(group.name)}
              aria-expanded={isExpanded}
              data-testid={`diff-group-toggle-${group.name}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sf-space-2)',
                width: '100%',
                padding: 'var(--sf-space-2) var(--sf-space-3)',
                backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--sf-text-primary)',
                fontSize: 'var(--sf-font-size-sm)',
              }}
            >
              <span
                className={`codicon codicon-${isExpanded ? 'chevron-down' : 'chevron-right'}`}
                aria-hidden="true"
              />
              <span style={{ fontWeight: 600, flex: 1, textAlign: 'left' }}>{group.name}</span>
              <span
                style={{ fontSize: 'var(--sf-font-size-xs)', color: 'var(--sf-text-secondary)' }}
              >
                {group.diffs.length} {t('compare.changes', 'changes')}
              </span>
              {group.counts.added > 0 && <Badge variant="success">{group.counts.added}+</Badge>}
              {group.counts.removed > 0 && <Badge variant="error">{group.counts.removed}-</Badge>}
              {group.counts.modified > 0 && (
                <Badge variant="warning">{group.counts.modified}~</Badge>
              )}
              <Badge variant={riskBadge[group.maxRisk]}>{group.maxRisk}</Badge>
            </button>

            {/* Expanded diff items */}
            {isExpanded && (
              <div data-testid={`diff-group-items-${group.name}`}>
                {group.diffs.map((diff, idx) => (
                  <button
                    key={`${diff.name}-${idx}`}
                    type="button"
                    onClick={() => onSelectDiff?.(diff)}
                    data-testid={`diff-item-${diff.name}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--sf-space-2)',
                      width: '100%',
                      padding: 'var(--sf-space-2) var(--sf-space-4)',
                      borderTop: '1px solid var(--sf-border)',
                      backgroundColor:
                        diff.riskLevel === 'critical'
                          ? 'color-mix(in srgb, var(--sf-error) 5%, transparent)'
                          : diff.riskLevel === 'high'
                            ? 'color-mix(in srgb, var(--sf-warning) 5%, transparent)'
                            : 'transparent',
                      border: 'none',
                      cursor: onSelectDiff ? 'pointer' : 'default',
                      color: 'var(--sf-text-primary)',
                      fontSize: 'var(--sf-font-size-xs)',
                      textAlign: 'left',
                    }}
                  >
                    {/* Change symbol */}
                    <span
                      style={{
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontFamily: 'monospace',
                        color:
                          diff.changeType === 'added'
                            ? 'var(--sf-success)'
                            : diff.changeType === 'removed'
                              ? 'var(--sf-error)'
                              : 'var(--sf-warning)',
                      }}
                    >
                      {changeSymbol[diff.changeType]}
                    </span>

                    {/* Category + Name */}
                    <Badge variant={changeBadge[diff.changeType]}>{diff.changeType}</Badge>
                    <span style={{ color: 'var(--sf-text-secondary)' }}>{diff.category}</span>
                    <span style={{ flex: 1, fontFamily: 'monospace' }}>{diff.name}</span>

                    {/* Risk badge */}
                    <Badge variant={riskBadge[diff.riskLevel]}>{diff.riskLevel}</Badge>

                    {/* Dependencies count */}
                    {diff.dependencies.length > 0 && (
                      <span
                        style={{
                          fontSize: 'var(--sf-font-size-xs)',
                          color: 'var(--sf-text-muted)',
                        }}
                      >
                        {diff.dependencies.length} {t('compare.deps', 'deps')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
