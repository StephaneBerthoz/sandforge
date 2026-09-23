import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { VirtualList } from '../../components/ui/VirtualList';
import type { EnrichedDiff, DiffRiskLevel } from '@sandforge/shared';
import { CHANGE_LOOK, CHANGE_ORDER } from './changeLook';

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

/** Row height fed to the virtualizer — must stay in sync with DIFF_ROW_STYLE's box. */
const DIFF_ROW_HEIGHT = 36;

/** Row chrome shared by every diff; only the tint and the cursor vary per row. */
const DIFF_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sf-space-2)',
  width: '100%',
  /* Fill the slot the virtualizer reserves, so rows neither gap nor overlap. */
  height: '100%',
  boxSizing: 'border-box',
  padding: 'var(--sf-space-2) var(--sf-space-4)',
  borderTop: '1px solid var(--sf-border)',
  border: 'none',
  color: 'var(--sf-text-primary)',
  fontSize: 'var(--sf-font-size-xs)',
  textAlign: 'left',
};

/** Faint tint that keeps the diffs worth reviewing first visible while scrolling. */
const RISK_TINT: Partial<Record<DiffRiskLevel, string>> = {
  critical: 'color-mix(in srgb, var(--sf-error) 5%, transparent)',
  high: 'color-mix(in srgb, var(--sf-warning) 5%, transparent)',
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
          color: 'var(--sf-text-secondary)',
          textAlign: 'center',
          padding: 'var(--sf-space-6) 0',
        }}
        data-testid="no-diffs"
      >
        {/* Shown only once a comparison has answered: it read "No comparison
            results yet" over a run that had found nothing different. */}
        {t('compare.nothingDiffers')}
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
                backgroundColor: 'var(--sf-bg-secondary)',
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
                {t('compare.changeCount', { count: group.diffs.length })}
              </span>
              {CHANGE_ORDER.filter((kind) => group.counts[kind] > 0).map((kind) => {
                // "2+" alone said nothing to a screen reader, nor to a reader
                // who had not found the legend: the count carries its words.
                const words = t(`compare.count.${kind}`, { count: group.counts[kind] });
                return (
                  <Badge key={kind} variant={CHANGE_LOOK[kind].variant} title={words}>
                    <span aria-hidden="true">
                      {group.counts[kind]}
                      {CHANGE_LOOK[kind].symbol}
                    </span>
                    <span className="sr-only">{words}</span>
                  </Badge>
                );
              })}
              {/* It wrote the level's own code, "critical", whatever the language. */}
              <Badge variant={riskBadge[group.maxRisk]}>
                {t(`compare.riskLevel.${group.maxRisk}`)}
              </Badge>
            </button>

            {/* Expanded diff items — virtualized because a single group can be huge:
                "Data Model" collects CustomObject, CustomField and RecordType, the
                three highest-cardinality types, so a real org compare lands thousands
                of rows on one click. */}
            {isExpanded && (
              <div data-testid={`diff-group-items-${group.name}`}>
                <VirtualList
                  items={group.diffs}
                  keyExtractor={(diff, idx) => `${diff.name}-${idx}`}
                  estimatedItemHeight={DIFF_ROW_HEIGHT}
                  renderItem={(diff) => (
                    <button
                      type="button"
                      onClick={() => onSelectDiff?.(diff)}
                      data-testid={`diff-item-${diff.name}`}
                      style={{
                        ...DIFF_ROW_STYLE,
                        backgroundColor: RISK_TINT[diff.riskLevel] ?? 'transparent',
                        cursor: onSelectDiff ? 'pointer' : 'default',
                      }}
                    >
                      {/* Change symbol, in the severity tokens sized to read on the
                          row tints (the raw `var(--sf-success)` read 1.8:1 on a light
                          editor): the badge beside it names the change, so a screen
                          reader reads the name once instead of "plus" and the name. */}
                      <span
                        aria-hidden="true"
                        className={CHANGE_LOOK[diff.changeType].textClass}
                        style={{
                          width: '18px',
                          height: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontFamily: 'monospace',
                        }}
                      >
                        {CHANGE_LOOK[diff.changeType].symbol}
                      </span>

                      {/* Category + Name, in the row's foreground: description text
                          falls under AA on the risk tints. */}
                      <Badge variant={CHANGE_LOOK[diff.changeType].variant}>
                        {t(`compare.change.${diff.changeType}`)}
                      </Badge>
                      <span>{diff.category}</span>
                      <span style={{ flex: 1, fontFamily: 'monospace' }}>{diff.name}</span>

                      {/* Risk badge */}
                      <Badge variant={riskBadge[diff.riskLevel]}>
                        {t(`compare.riskLevel.${diff.riskLevel}`)}
                      </Badge>

                      {/* Dependencies count */}
                      {diff.dependencies.length > 0 && (
                        <span style={{ fontSize: 'var(--sf-font-size-xs)' }}>
                          {t('common.dependencyCount', { count: diff.dependencies.length })}
                        </span>
                      )}
                    </button>
                  )}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
