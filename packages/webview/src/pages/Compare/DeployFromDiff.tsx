import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DeploymentSuggestion } from '@sandforge/shared';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { BadgeVariant } from '../../components/ui/Badge';

/** DeployFromDiff component props. */
export interface DeployFromDiffProps {
  suggestion?: DeploymentSuggestion;
  onToggleComponent?: (fullName: string) => void;
  onDeploy?: () => void;
  className?: string;
}

const actionVariant: Record<string, BadgeVariant> = {
  deploy: 'success',
  delete: 'error',
  skip: 'default',
};

const riskVariant: Record<string, BadgeVariant> = {
  low: 'success',
  medium: 'warning',
  high: 'error',
};

/** Deployment builder from comparison diffs. */
export const DeployFromDiff: React.FC<DeployFromDiffProps> = ({
  suggestion,
  onToggleComponent,
  onDeploy,
  className,
}) => {
  const { t } = useTranslation();

  const deployCount = suggestion?.components.filter((c) => c.action === 'deploy').length ?? 0;

  return (
    <Card className={className}>
      <CardHeader
        title={t('compare.deploy')}
        action={
          onDeploy && suggestion ? (
            <Button
              variant="primary"
              size="sm"
              onClick={onDeploy}
              disabled={deployCount === 0}
              data-testid="deploy-btn"
            >
              {t('compare.buildDeployment')} ({deployCount})
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        {!suggestion || suggestion.components.length === 0 ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('common.noData')}
          </p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="deploy-builder">
            {/* Estimation row */}
            <div className="flex gap-4 text-[10px] text-[var(--vscode-descriptionForeground,#868686)]">
              <span>
                {t('compare.estimatedDuration')}: {Math.round(suggestion.estimatedDuration / 1000)}s
              </span>
              <span>
                {t('compare.risks')}: {suggestion.risks.length}
              </span>
            </div>

            {/* Component list */}
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {suggestion.components.map((comp) => (
                <button
                  key={comp.fullName}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs',
                    'border border-[var(--vscode-panel-border,#3c3c3c)]',
                    'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]',
                    comp.action === 'skip' && 'opacity-50',
                  )}
                  onClick={() => onToggleComponent?.(comp.fullName)}
                  data-testid={`deploy-comp-${comp.fullName}`}
                >
                  <Badge variant={actionVariant[comp.action]}>{comp.action}</Badge>
                  <span className="text-[var(--vscode-descriptionForeground,#868686)] w-24 truncate">
                    {comp.componentType}
                  </span>
                  <span className="text-[var(--vscode-editor-foreground,#d4d4d4)] flex-1 truncate">
                    {comp.fullName}
                  </span>
                  <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] truncate max-w-[100px]">
                    {comp.reason}
                  </span>
                </button>
              ))}
            </div>

            {/* Risk list */}
            {suggestion.risks.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="deploy-risks">
                <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
                  {t('compare.risks')}
                </span>
                {suggestion.risks.map((risk, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-[10px] text-[var(--vscode-descriptionForeground,#868686)]"
                    data-testid={`risk-${i}`}
                  >
                    <Badge variant={riskVariant[risk.risk]}>{risk.risk}</Badge>
                    <span className="truncate">
                      {risk.component}: {risk.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
};
