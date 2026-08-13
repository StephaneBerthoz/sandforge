import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { Flame } from 'lucide-react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useForgeStore } from '../../stores/useForgeStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Icon } from '../../components/ui/Icon';
import { formatRelativeTimeI18n } from '../../utils/formatters';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { staggerContainer, slideUp, fadeIn } from '../../motion/presets';
import { SandboxBanner } from '../../components/ui/SandboxBanner';
import { useSandboxDetection } from '../../hooks/useSandboxDetection';
import { moduleColors, cn } from '../../theme';
import type { SalesforceOrg } from '@sandforge/shared';
import { extractRecordId } from '../Forge/forgeUtils';
import { useSmartAction } from './useSmartAction';
import { useOrgHealthSummary } from './useOrgHealthSummary';
import { SmartActionCard } from './SmartActionCard';

/** Payload from org:list bridge query. */
interface OrgListPayload {
  orgs: SalesforceOrg[];
}

/** Maps recent op status to badge variant. */
const statusBadgeMap: Record<string, 'success' | 'warning' | 'error'> = {
  success: 'success',
  running: 'warning',
  failed: 'error',
};

/**
 * Home page dashboard -- bento command center for SandForge.
 * Shows KPI row, Forge hero card, sandbox health, quick actions,
 * recent operations, and getting started guide for new users.
 */
export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);
  const recentOps = useRecentOpsStore((s) => s.ops);

  const { data: orgListData, loading: orgsLoading } = useBridgeQuery<OrgListPayload>('org:list');

  /** Merge store orgs with bridge data, preferring store. */
  const connectedOrgs = useMemo(() => {
    if (orgs.length > 0) {
      return orgs.filter((o) => o.status === 'connected');
    }
    return orgListData?.orgs?.filter((o) => o.status === 'connected') ?? [];
  }, [orgs, orgListData]);

  const hasOrgs = connectedOrgs.length > 0;

  /** Last 5 recent operations for the tile. */
  const recentOpsSlice = useMemo(() => recentOps.slice(0, 5), [recentOps]);

  /** Derived KPI values from recent operations. */
  const activeJobsCount = useMemo(
    () => recentOps.filter((op) => op.status === 'running').length,
    [recentOps],
  );
  const { hasSandbox } = useSandboxDetection();
  const smartAction = useSmartAction();

  const showSmartAction =
    hasOrgs && smartAction.recommendation !== null && smartAction.recommendation.action !== 'none';

  const opsLast7dCount = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return recentOps.filter((op) => op.timestamp >= sevenDaysAgo).length;
  }, [recentOps]);

  /**
   * Real health figures for the selected org. Every field is nullable: a
   * dashboard that cannot measure shows a dash, never a reassuring zero.
   */
  const health = useOrgHealthSummary(selectedOrgId);

  /** Placeholder shown wherever a measurement is not available. */
  const NO_VALUE = '—';

  const [heroRecordId, setHeroRecordId] = useState('');
  const [heroIdInvalid, setHeroIdInvalid] = useState(false);
  const heroInputRef = useRef<HTMLInputElement>(null);

  /**
   * Carry the hero field's record id into the Forge module instead of
   * dropping it. An id the parser rejects keeps focus in the field rather
   * than navigating away with the typed value silently discarded; an empty
   * field leaves the button as a plain call to action.
   */
  const handleStartForge = useCallback(() => {
    const raw = heroRecordId.trim();
    if (raw.length > 0) {
      const parsed = extractRecordId(raw);
      if (parsed === null) {
        setHeroIdInvalid(true);
        heroInputRef.current?.focus();
        return;
      }
      useForgeStore.getState().setConfig({
        inputMode: 'record',
        recordId: parsed,
        depth: 'direct',
        sourceOrgId: selectedOrgId ?? '',
        targetOrgId: '',
        anonymizePII: false,
        skipEmpty: false,
        batchSize: 'auto',
      });
    }
    setHeroIdInvalid(false);
    navigate('forge');
  }, [heroRecordId, navigate, selectedOrgId]);

  return (
    <m.div
      className="flex flex-col gap-6 p-4"
      data-testid="home-page"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* KPI Row */}
      <AnimatePresence mode="wait">
        {orgsLoading ? (
          <m.div
            key="kpi-skeleton"
            className="flex flex-wrap gap-4"
            data-testid="home-loading"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
          >
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex-1 min-w-[140px]">
                <Skeleton variant="rect" height="88px" />
              </div>
            ))}
          </m.div>
        ) : (
          <m.div
            key="kpi-content"
            className="flex flex-wrap gap-4"
            data-testid="home-kpi-row"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
          >
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              <KPICard
                icon="organization"
                label={t('home.orgsConnected')}
                value={connectedOrgs.length}
                accentColor={moduleColors.grappe}
              />
            </m.div>
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              <KPICard
                icon="tasklist"
                label={t('home.activeJobs')}
                value={activeJobsCount}
                accentColor={moduleColors.automation}
              />
            </m.div>
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              <KPICard
                icon="history"
                label={t('home.opsLast7d')}
                value={opsLast7dCount}
                accentColor={moduleColors.forge}
              />
            </m.div>
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              {health.loading ? (
                <Skeleton variant="rect" height="88px" />
              ) : (
                <KPICard
                  icon="warning"
                  label={t('home.limitWarnings')}
                  value={health.limitWarnings ?? NO_VALUE}
                  accentColor={moduleColors.monitor}
                  variant="warning"
                />
              )}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

      {/* Sandbox Banner */}
      <SandboxBanner onNavigate={(page) => navigate(page)} />

      {/* Smart Action Recommendation */}
      <AnimatePresence mode="wait">
        {(showSmartAction || smartAction.loading) && smartAction.recommendation && (
          <m.div
            key="smart-action"
            variants={fadeIn}
            initial="hidden"
            animate="visible"
            exit="hidden"
          >
            <SmartActionCard
              recommendation={smartAction.recommendation}
              onExecute={smartAction.requestConfirm}
              showConfirmation={smartAction.showConfirmation}
              onConfirm={smartAction.confirm}
              onCancel={smartAction.cancelConfirm}
              loading={smartAction.loading}
            />
          </m.div>
        )}
      </AnimatePresence>

      {/* Bento Grid */}
      <BentoGrid columns={3}>
        {/* Forge Hero Tile */}
        <BentoTile colSpan={2} className="border-forge/30">
          <div className="flex flex-col h-full" data-testid="forge-hero-card">
            <div className="flex items-center gap-2 mb-3">
              <Flame className="w-6 h-6" style={{ color: moduleColors.forge }} />
              <h1 className="text-lg font-semibold text-text-primary">{t('home.forgeASandbox')}</h1>
            </div>
            <p className="text-sm text-text-secondary mb-6">{t('home.forgeDescription')}</p>
            <div className="mt-auto">
              <div className="flex items-center gap-2">
                <input
                  ref={heroInputRef}
                  type="text"
                  value={heroRecordId}
                  onChange={(e) => {
                    setHeroRecordId(e.target.value);
                    setHeroIdInvalid(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleStartForge();
                  }}
                  placeholder={t('home.recordIdPlaceholder')}
                  aria-label={t('home.recordIdPlaceholder')}
                  aria-invalid={heroIdInvalid}
                  aria-describedby={heroIdInvalid ? 'forge-record-error' : undefined}
                  className={cn(
                    'flex-1 rounded border bg-surface-2 px-3 py-1.5 text-sm',
                    'text-text-primary placeholder:text-text-muted',
                    'focus:outline-none focus:ring-1 focus:ring-[var(--sf-accent)]',
                    heroIdInvalid ? 'border-[var(--sf-error)]' : 'border-subtle',
                  )}
                  data-testid="forge-record-input"
                />
                <Button variant="primary" onClick={handleStartForge} data-testid="start-forge-btn">
                  {t('home.startForge')}
                </Button>
              </div>
              {heroIdInvalid && (
                <p
                  id="forge-record-error"
                  className="mt-1.5 text-xs text-[var(--sf-error)]"
                  data-testid="forge-record-error"
                >
                  {t('home.invalidRecordId')}
                </p>
              )}
            </div>
          </div>
        </BentoTile>

        {/* Sandbox Health Tile */}
        <BentoTile colSpan={1} rowSpan={1}>
          <div data-testid="health-tile">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {t('home.sandboxHealth')}
            </h3>
            {hasOrgs ? (
              <div className="flex flex-col gap-2" data-testid="connected-orgs-card">
                {connectedOrgs.slice(0, 4).map((org) => (
                  <OrgBadge
                    key={org.id}
                    alias={org.alias}
                    orgType={org.orgType}
                    status={org.status}
                    instanceUrl={org.instanceUrl}
                  />
                ))}
                {connectedOrgs.length > 4 && (
                  <Button variant="ghost" size="sm" onClick={() => navigate('orgs')}>
                    {t('home.viewAll')}
                  </Button>
                )}
              </div>
            ) : (
              <EmptyState icon={<Icon name="plug" />} title={t('home.noOrgsConnected')} />
            )}
          </div>
        </BentoTile>

        {/* Recent Operations Tile */}
        <BentoTile colSpan={1} rowSpan={1}>
          <div data-testid="recent-ops-tile">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {t('home.recentOperations')}
            </h3>
            <div data-testid="recent-ops-card">
              {recentOpsSlice.length === 0 ? (
                <EmptyState icon={<Icon name="history" />} title={t('home.noRecentOps')} />
              ) : (
                <div className="space-y-1.5">
                  {recentOpsSlice.map((op) => (
                    <div
                      key={op.id}
                      className="flex items-center gap-2 py-1 px-2 rounded text-xs bg-surface-2"
                      data-testid="recent-op-item"
                    >
                      <Badge variant={statusBadgeMap[op.status] ?? 'default'}>{op.status}</Badge>
                      <span className="flex-1 truncate text-text-primary">{op.label}</span>
                      <span className="text-text-muted shrink-0">
                        {formatRelativeTimeI18n(op.timestamp, t, 'home')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </BentoTile>

        {/* Quick Actions Tile */}
        <BentoTile colSpan={1} rowSpan={1}>
          <div data-testid="quick-actions-tile">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {t('home.quickActions')}
            </h3>
            <div className="grid grid-cols-2 gap-2" data-testid="quick-actions-card">
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="flame" />}
                onClick={() => navigate('forge')}
                data-testid="quick-forge-btn"
              >
                {t('home.quickForge')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="server" />}
                onClick={() => navigate('grappe')}
                data-testid="quick-grappe-btn"
              >
                {t('nav.grappe')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="refresh" />}
                onClick={() => navigate('monitor')}
                data-testid="refresh-monitor-btn"
              >
                {t('home.refreshMonitor')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="play" />}
                onClick={() => navigate('automation')}
                data-testid="run-pipeline-btn"
              >
                {t('home.runLastPipeline')}
              </Button>
              {hasSandbox && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon name="database" />}
                  onClick={() => navigate('seed')}
                  data-testid="populate-sandbox-btn"
                >
                  {t('onboarding.populateSandbox')}
                </Button>
              )}
            </div>
          </div>
        </BentoTile>
      </BentoGrid>

      {/* Health Summary — shown when orgs are connected */}
      {hasOrgs && (
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
          data-testid="health-summary"
        >
          {health.loading ? (
            <Skeleton variant="rect" height="112px" />
          ) : (
            <KPICard
              icon="pulse"
              label={t('home.healthScore')}
              value={health.healthScore !== null ? `${health.healthScore}%` : NO_VALUE}
              subtitle={t('home.healthSummary')}
              variant={
                health.healthScore !== null && health.healthScore >= 80 ? 'success' : 'default'
              }
            />
          )}
          <KPICard
            icon="organization"
            label={t('home.connectedOrgs')}
            value={connectedOrgs.length}
            variant="success"
          />
          {health.loading ? (
            <Skeleton variant="rect" height="112px" />
          ) : (
            <KPICard
              icon="database"
              label={t('status.apiUsage')}
              value={health.apiUsedPercent !== null ? `${health.apiUsedPercent}%` : NO_VALUE}
              variant="default"
            />
          )}
          <KPICard
            icon="tasklist"
            label={t('status.activeJobs')}
            value={activeJobsCount}
            variant="default"
          />
        </div>
      )}

      {/* Getting Started -- shown when no orgs are connected */}
      {!hasOrgs && !orgsLoading && (
        <Card data-testid="getting-started-card">
          <CardHeader title={t('home.gettingStarted')} />
          <CardBody>
            <p className="text-sm text-[var(--sf-text-secondary)] mb-4">
              {t('home.gettingStartedDesc')}
            </p>
            <ol className="list-decimal list-inside space-y-2 text-sm text-[var(--sf-text-primary)]">
              <li>{t('home.step1')}</li>
              <li>{t('home.step2')}</li>
              <li>{t('home.step3')}</li>
              <li>{t('home.step4')}</li>
            </ol>
            <div className="mt-4">
              <Button
                variant="primary"
                onClick={() => navigate('orgs')}
                icon={<Icon name="plug" />}
                data-testid="connect-org-btn"
              >
                {t('home.connectOrg')}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </m.div>
  );
};
