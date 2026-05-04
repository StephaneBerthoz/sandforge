import React from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgInfo } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Props for the OrgInfoPanel component. */
export interface OrgInfoPanelProps {
  orgInfo?: OrgInfo;
  className?: string;
}

/** Badge variant for org type. */
function orgTypeBadgeVariant(type: OrgInfo['type']): BadgeVariant {
  switch (type) {
    case 'Production':
      return 'error';
    case 'Sandbox':
      return 'warning';
    case 'Scratch':
      return 'info';
    case 'Developer':
      return 'success';
    default:
      return 'default';
  }
}

/**
 * Displays org metadata overview in a compact info panel.
 * Shows org name, type, edition, instance, and key component counts.
 */
export const OrgInfoPanel: React.FC<OrgInfoPanelProps> = ({ orgInfo, className }) => {
  const { t } = useTranslation();

  if (!orgInfo) {
    return null;
  }

  const stats: Array<{ label: string; value: string | number; testId: string }> = [
    {
      label: t('monitor.orgUsers', 'Users'),
      value: orgInfo.userCount,
      testId: 'org-stat-users',
    },
    {
      label: t('monitor.orgObjects', 'Custom Objects'),
      value: orgInfo.customObjectCount,
      testId: 'org-stat-objects',
    },
    {
      label: t('monitor.orgApexClasses', 'Apex Classes'),
      value: orgInfo.apexClassCount,
      testId: 'org-stat-apex',
    },
    {
      label: t('monitor.orgFlows', 'Active Flows'),
      value: orgInfo.flowCount,
      testId: 'org-stat-flows',
    },
  ];

  return (
    <div
      className={className}
      data-testid="org-info-panel"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 'var(--sf-space-4)',
        padding: 'var(--sf-space-4)',
        borderRadius: 'var(--sf-radius-md)',
        border: '1px solid var(--sf-border)',
        background: 'var(--sf-bg-card)',
        marginBottom: 'var(--sf-space-6)',
      }}
    >
      {/* Left: Org identity */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sf-space-1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sf-space-2)' }}>
          <span
            data-testid="org-info-name"
            style={{
              fontSize: 'var(--sf-font-size-lg)',
              fontWeight: 600,
              color: 'var(--sf-text-primary)',
            }}
          >
            {orgInfo.name}
          </span>
          <span data-testid="org-info-type">
            <Badge variant={orgTypeBadgeVariant(orgInfo.type)}>{orgInfo.type}</Badge>
          </span>
        </div>
        <div
          style={{
            fontSize: 'var(--sf-font-size-sm)',
            color: 'var(--sf-text-secondary)',
            display: 'flex',
            gap: 'var(--sf-space-3)',
            flexWrap: 'wrap',
          }}
        >
          <span data-testid="org-info-edition">{orgInfo.edition}</span>
          <span data-testid="org-info-instance">
            {t('monitor.orgInstance', 'Instance')}: {orgInfo.instanceName}
          </span>
          <span data-testid="org-info-api-version">API v{orgInfo.apiVersion}</span>
          <span data-testid="org-info-id" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
            {orgInfo.orgId}
          </span>
        </div>
      </div>

      {/* Right: Component stats */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--sf-space-4)',
          alignItems: 'center',
        }}
        data-testid="org-info-stats"
      >
        {stats.map((stat) => (
          <div
            key={stat.testId}
            data-testid={stat.testId}
            style={{
              textAlign: 'center',
              minWidth: '60px',
            }}
          >
            <div
              style={{
                fontSize: 'var(--sf-font-size-lg)',
                fontWeight: 700,
                color: 'var(--sf-text-primary)',
              }}
            >
              {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
            </div>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--sf-text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
