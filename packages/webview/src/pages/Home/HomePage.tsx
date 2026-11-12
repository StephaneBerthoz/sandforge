import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { Flame, Sprout } from 'lucide-react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import type { RecentOp } from '../../stores/useRecentOpsStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Icon } from '../../components/ui/Icon';
import { formatRelativeTimeI18n } from '../../utils/formatters';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { staggerContainer, slideUp, fadeIn } from '../../motion/presets';
import { cn } from '../../theme';
import type { SalesforceOrg } from '@sandforge/shared';
import { extractRecordId } from '../../utils/recordId';
import { useSmartAction } from './useSmartAction';
import { orgToFill } from '../../utils/orgToFill';
import { useOrgHealthSummary } from './useOrgHealthSummary';
import { SmartActionCard } from './SmartActionCard';
import { CheckpointTile } from './CheckpointTile';

/** Payload from org:list bridge query. */
interface OrgListPayload {
  orgs: SalesforceOrg[];
}

/**
 * How a recent op's status reads: its badge colour and its wording.
 *
 * The badge used to print the status as it is stored, in English whatever the
 * language, and a stopped run could only read as one that succeeded. A
 * cancelled one has its own wording, in the neutral colour: nothing failed.
 */
const STATUS_BADGES: Record<RecentOp['status'], { variant: BadgeVariant; labelKey: string }> = {
  success: { variant: 'success', labelKey: 'home.opStatus.success' },
  partial: { variant: 'warning', labelKey: 'home.opStatus.partial' },
  running: { variant: 'warning', labelKey: 'home.opStatus.running' },
  failed: { variant: 'error', labelKey: 'home.opStatus.failed' },
  cancelled: { variant: 'default', labelKey: 'home.opStatus.cancelled' },
};

/**
 * Home page dashboard -- bento command center for SandForge.
 * Shows the KPI row, a hero chosen by the orgs connected, the connected orgs,
 * quick actions, recent operations and the selected org's checkpoints.
 *
 * The hero was Forge's in every case, with Home's only h1, though Forge copies
 * from one org into another: with no org it asked for a record id, and the
 * card that connects one came last, under every tile. It now leads with what
 * the orgs connected allow, as the side panel does: none, Getting started and
 * the two ways to connect one; one org to fill, alone, filling it with demo
 * data; two or more, Forge.
 *
 * A banner said "Your sandbox is empty" whenever a sandbox, a scratch org or a
 * Developer Edition was connected, measuring nothing, beside a full-copy
 * sandbox marked Staging. It is gone: the recommended action counts what the
 * org holds before it says anything.
 */
export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);
  const grappeEnabled = useAppStore((s) => s.grappeEnabled);
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

  /** The org to fill with demo data, of those connected: the selected one when it is one. */
  const orgToFillNow = orgToFill(connectedOrgs, selectedOrgId);
  /** One org connected, and one to fill: nothing to copy between, so the hero fills it. */
  const fillTarget = connectedOrgs.length === 1 ? orgToFillNow : undefined;
  const hero: 'loading' | 'connect' | 'fill' | 'forge' = hasOrgs
    ? fillTarget
      ? 'fill'
      : 'forge'
    : orgsLoading
      ? 'loading'
      : 'connect';
  const nameOf = (org: SalesforceOrg): string => org.alias || org.username;

  /** Last 5 recent operations for the tile. */
  const recentOpsSlice = useMemo(() => recentOps.slice(0, 5), [recentOps]);

  /** Derived KPI values from recent operations. */
  const activeJobsCount = useMemo(
    () => recentOps.filter((op) => op.status === 'running').length,
    [recentOps],
  );
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
   * field leaves the button as a plain call to action. The id goes with the
   * navigation, and Forge starts its run from it as it opens: written into
   * the Forge store here, it put the store and zod on Home.
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
      setHeroIdInvalid(false);
      navigate('forge', { recordId: parsed, sourceOrgId: selectedOrgId ?? '' });
      return;
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
                accentClassName="text-hue-indigo"
              />
            </m.div>
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              <KPICard
                icon="tasklist"
                label={t('home.activeJobs')}
                value={activeJobsCount}
                accentClassName="text-hue-rose"
              />
            </m.div>
            <m.div className="flex-1 min-w-[140px]" variants={slideUp}>
              <KPICard
                icon="history"
                label={t('home.opsLast7d')}
                value={opsLast7dCount}
                accentClassName="text-hue-forge"
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
                  accentClassName="text-hue-yellow"
                  variant="warning"
                />
              )}
            </m.div>
          </m.div>
        )}
      </AnimatePresence>

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
        {/* Hero: chosen by the orgs connected, as the side panel's is */}
        <BentoTile colSpan={2} className={hero === 'forge' ? 'border-forge/30' : undefined}>
          {hero === 'loading' && (
            <div data-testid="home-hero-loading">
              <Skeleton variant="rect" height="140px" />
            </div>
          )}
          {hero === 'connect' && (
            <div className="flex flex-col h-full" data-testid="getting-started-card">
              <h1 tabIndex={-1} className="text-lg font-semibold text-text-primary mb-2">
                {t('home.gettingStarted')}
              </h1>
              <p className="text-sm text-text-secondary mb-4">{t('home.gettingStartedDesc')}</p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-text-primary">
                <li>{t('home.step1')}</li>
                <li>{t('home.step2')}</li>
                <li>{t('home.step3')}</li>
                <li>{t('home.step4')}</li>
              </ol>
              {/* The two ways to connect, by the names Organizations gives
                  them, each starting there as the side panel's first card
                  does. */}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() => navigate('orgs', { orgAction: 'import-cli' })}
                  icon={<Icon name="cloud-download" />}
                  data-testid="home-import-cli-btn"
                >
                  {t('home.importFromCli')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => navigate('orgs', { orgAction: 'login-web' })}
                  icon={<Icon name="link" />}
                  data-testid="home-login-web-btn"
                >
                  {t('home.loginWeb')}
                </Button>
              </div>
            </div>
          )}
          {hero === 'fill' && fillTarget && (
            <div className="flex flex-col h-full" data-testid="fill-hero-card">
              <div className="flex items-center gap-2 mb-3">
                <Sprout className="w-6 h-6 shrink-0 text-hue-green" aria-hidden="true" />
                <h1
                  tabIndex={-1}
                  className="text-lg font-semibold text-text-primary min-w-0 break-words"
                >
                  {t('home.fillOrg', { alias: nameOf(fillTarget) })}
                </h1>
              </div>
              <p className="text-sm text-text-secondary mb-6">{t('home.fillOrgDesc')}</p>
              <div className="mt-auto">
                <Button
                  variant="primary"
                  onClick={() =>
                    navigate('seed', { seedMode: 'quick-seed', targetOrgId: fillTarget.id })
                  }
                  data-testid="fill-hero-btn"
                >
                  {t('home.fillOrgAction')}
                </Button>
              </div>
            </div>
          )}
          {hero === 'forge' && (
            <div className="flex flex-col h-full" data-testid="forge-hero-card">
              <div className="flex items-center gap-2 mb-3">
                <Flame className="w-6 h-6 text-hue-forge" />
                <h1 tabIndex={-1} className="text-lg font-semibold text-text-primary">
                  {t('home.forgeASandbox')}
                </h1>
              </div>
              {/* The one sentence every surface says Forge in: the side panel,
                  Home, its empty state and Help. */}
              <p className="text-sm text-text-secondary mb-6">{t('moduleSummary.forge')}</p>
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
                      'flex-1 rounded-sm border bg-surface-2 px-3 py-1.5 text-sm',
                      'text-text-primary placeholder:text-text-secondary',
                      'focus:outline-hidden focus:ring-1 focus:ring-(--sf-accent)',
                      heroIdInvalid ? 'border-(--sf-error)' : 'border-subtle',
                    )}
                    data-testid="forge-record-input"
                  />
                  <Button
                    variant="primary"
                    onClick={handleStartForge}
                    data-testid="start-forge-btn"
                  >
                    {t('home.startForge')}
                  </Button>
                </div>
                {heroIdInvalid && (
                  <p
                    id="forge-record-error"
                    className="mt-1.5 text-xs text-status-error"
                    data-testid="forge-record-error"
                  >
                    {t('home.invalidRecordId')}
                  </p>
                )}
              </div>
            </div>
          )}
        </BentoTile>

        {/* Connected orgs: a list, not the health measure its title promised */}
        <BentoTile colSpan={1} rowSpan={1}>
          <div data-testid="health-tile">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {t('home.connectedOrgs')}
            </h3>
            {hasOrgs ? (
              <div className="flex flex-col gap-2" data-testid="connected-orgs-card">
                {connectedOrgs.slice(0, 4).map((org) => (
                  <OrgBadge key={org.id} org={org} />
                ))}
                {connectedOrgs.length > 4 && (
                  <Button variant="ghost" size="sm" onClick={() => navigate('orgs')}>
                    {t('home.viewAll')}
                  </Button>
                )}
              </div>
            ) : (
              <EmptyState
                icon={<Icon name="plug" />}
                title={t('home.noOrgsConnected')}
                actionLabel={t('home.connectOrg')}
                onAction={() => navigate('orgs')}
              />
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
                  {/* Each opens the page of the module that ran it, where a
                      failed run says why and can be run again: a "Failed —
                      Sync Contacts" row led nowhere. */}
                  {recentOpsSlice.map((op) => (
                    <button
                      type="button"
                      key={op.id}
                      className={cn(
                        'w-full flex items-center gap-2 py-1 px-2 rounded-sm text-xs text-left bg-surface-2',
                        // A ring, not a hover background: the time beside
                        // the label fell under AA on the hover colour.
                        'hover:ring-1 hover:ring-(--sf-accent) transition-shadow',
                      )}
                      onClick={() => navigate(op.type)}
                      title={t('home.openOpModule', { module: t(`nav.${op.type}`) })}
                      data-testid="recent-op-item"
                    >
                      <Badge variant={STATUS_BADGES[op.status].variant}>
                        {t(STATUS_BADGES[op.status].labelKey)}
                      </Badge>
                      <span className="flex-1 truncate text-text-primary">{op.label}</span>
                      <span className="text-text-secondary shrink-0">
                        {formatRelativeTimeI18n(op.timestamp, t, 'home')}
                      </span>
                    </button>
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
            {/* Each says the page it opens: Quick Forge, Refresh Monitor and
                Open Pipelines opened Forge, Monitor and Automation, refreshed
                nothing and named no page of that name. */}
            <div className="grid grid-cols-2 gap-2" data-testid="quick-actions-card">
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="flame" />}
                onClick={() => navigate('forge')}
                data-testid="open-forge-btn"
              >
                {t('home.openForge')}
              </Button>
              {/* Grappe only shows a run's partitions while sandforge.grappe.enabled
                  is on: off, its button opened an empty page. */}
              {grappeEnabled && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon name="server" />}
                  onClick={() => navigate('grappe')}
                  data-testid="quick-grappe-btn"
                >
                  {t('nav.grappe')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="pulse" />}
                onClick={() => navigate('monitor')}
                data-testid="open-monitor-btn"
              >
                {t('home.openMonitor')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="zap" />}
                onClick={() => navigate('automation')}
                data-testid="open-automation-btn"
              >
                {t('home.openAutomation')}
              </Button>
              {/* The act the side panel and Organizations name with the same
                  words, on the org they would fill; the hero offers it
                  already when that org is the only one. */}
              {orgToFillNow && hero !== 'fill' && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon name="sprout" />}
                  onClick={() =>
                    navigate('seed', { seedMode: 'quick-seed', targetOrgId: orgToFillNow.id })
                  }
                  data-testid="fill-org-btn"
                >
                  {t('home.fillOrg', { alias: nameOf(orgToFillNow) })}
                </Button>
              )}
            </div>
          </div>
        </BentoTile>

        {/* Checkpoints of the selected org: none on a production org. */}
        <CheckpointTile org={connectedOrgs.find((org) => org.id === selectedOrgId)} />
      </BentoGrid>

      {/* Health Summary — shown when orgs are connected. The org count and
          the active jobs are the KPI row's: this row repeated both, under
          labels French and German wrote the same. */}
      {hasOrgs && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="health-summary">
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
        </div>
      )}
    </m.div>
  );
};
