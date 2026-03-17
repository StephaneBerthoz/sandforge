import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffStatus, MetadataComponentType } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { ProgressBar } from '../../components/ui/ProgressBar';

/** A detected drift component. */
export interface DriftedComponent {
  componentType: MetadataComponentType;
  fullName: string;
  changeType: DiffStatus;
  detectedAt: string;
  lastModifiedBy?: string;
  lastModifiedDate?: string;
}

/** Drift detection result. */
export interface DriftResult {
  orgId: string;
  driftedComponents: DriftedComponent[];
  driftScore: number;
  detectedAt: string;
}

/** DriftDashboard component props. */
export interface DriftDashboardProps {
  drift?: DriftResult;
  className?: string;
}

/** A group of drifted components by type. */
interface DriftGroup {
  componentType: MetadataComponentType;
  components: DriftedComponent[];
}

/** Dashboard displaying configuration drift analysis with grouping. */
export const DriftDashboard: React.FC<DriftDashboardProps> = ({ drift, className }) => {
  const { t } = useTranslation();

  const driftVariant = (score: number) => {
    if (score >= 70) return 'error' as const;
    if (score >= 40) return 'warning' as const;
    return 'success' as const;
  };

  /** Group drifted components by componentType. */
  const groups = useMemo<DriftGroup[]>(() => {
    if (!drift) return [];
    const map = new Map<MetadataComponentType, DriftedComponent[]>();
    for (const comp of drift.driftedComponents) {
      const list = map.get(comp.componentType) ?? [];
      list.push(comp);
      map.set(comp.componentType, list);
    }
    return Array.from(map.entries()).map(([componentType, components]) => ({
      componentType,
      components,
    }));
  }, [drift]);

  return (
    <Card className={className}>
      <CardHeader title={t('compare.drift')} />
      <CardBody>
        {!drift || drift.driftedComponents.length === 0 ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('compare.noDrift')}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="drift-dashboard">
            {/* Drift score */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
                {t('compare.driftScore')}
              </span>
              <div className="flex-1">
                <ProgressBar
                  value={drift.driftScore}
                  variant={driftVariant(drift.driftScore)}
                  showPercent
                />
              </div>
            </div>

            {/* Grouped drifted components */}
            <div className="flex flex-col gap-3 max-h-64 overflow-y-auto" data-testid="drift-groups">
              {groups.map((group) => (
                <div key={group.componentType} data-testid={`drift-group-${group.componentType}`}>
                  {/* Group header */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {group.componentType}
                    </span>
                    <span data-testid={`drift-group-count-${group.componentType}`}>
                      <Badge variant="default">
                        {group.components.length}
                      </Badge>
                    </span>
                  </div>
                  {/* Components in this group */}
                  <div className="flex flex-col gap-1 pl-2">
                    {group.components.map((comp) => (
                      <div
                        key={`${comp.componentType}-${comp.fullName}`}
                        className={cn(
                          'flex items-center gap-2 px-2 py-1 rounded text-xs',
                          'bg-[var(--vscode-editorWidget-background,#252526)]',
                        )}
                        data-testid={`drift-item-${comp.fullName}`}
                      >
                        <Badge
                          variant={
                            comp.changeType === 'added'
                              ? 'success'
                              : comp.changeType === 'removed'
                                ? 'error'
                                : 'warning'
                          }
                        >
                          {comp.changeType}
                        </Badge>
                        <span className="text-[var(--vscode-editor-foreground,#d4d4d4)] flex-1 truncate">
                          {comp.fullName}
                        </span>
                        {/* Who changed what, when */}
                        {comp.lastModifiedBy && (
                          <span
                            className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] truncate max-w-[100px]"
                            data-testid={`drift-modified-by-${comp.fullName}`}
                          >
                            {comp.lastModifiedBy}
                          </span>
                        )}
                        {comp.lastModifiedDate && (
                          <span
                            className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)]"
                            data-testid={`drift-modified-date-${comp.fullName}`}
                          >
                            {comp.lastModifiedDate}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
};
