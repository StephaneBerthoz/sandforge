import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { Flame, ListChecks, Plug, Plus, Sprout } from 'lucide-react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import type { RecentOp } from '../../stores/useRecentOpsStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { BentoGrid, BentoTile } from '../../components/ui/BentoGrid';
import { KPICard } from '../../components/ui/KPICard';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Icon } from '../../components/ui/Icon';
import {
  formatRelativeTime,
  formatRelativeTimeI18n,
  formatStoredDate,
} from '../../utils/formatters';
import { OrgBadge } from '../../components/ui/OrgBadge';
import { staggerContainer, fadeIn } from '../../motion/presets';
import { cn } from '../../theme';
import type { RecoveryStepId, SalesforceOrg } from '@sandforge/shared';
import { extractRecordId } from '../../utils/recordId';
import { heroFor } from '../../navigation/heroFor';
import type { Hero } from '../../navigation/heroFor';
import { useSmartAction } from './useSmartAction';
import { useOrgHealthSummary } from './useOrgHealthSummary';
import { useRecoveryLeads } from './useRecoveryLeads';
import { SmartActionCard } from './SmartActionCard';
import { CheckpointTile } from './CheckpointTile';
import { OrgHealthCard } from './OrgHealthCard';
import { AllModulesTile } from './AllModulesTile';

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

/** The look of a hero's heading: Home's only h1, focused when the route opens. */
const HERO_HEADING = 'text-lg font-semibold text-text-primary min-w-0 break-words';

/** Props for {@link AfterRefreshHero}. */
interface AfterRefreshHeroProps {
  hero: Extract<Hero, { kind: 'afterRefresh' }>;
  /** The step the recovery is at, when one is left. */
  next: RecoveryStepId | undefined;
  onOpen: () => void;
}

/**
 * A refreshed sandbox: the steps that bring it back, how far it is, and the
 * one it is at. The launcher says how far in its narrow column; Home has the
 * room to say what comes next.
 */
const AfterRefreshHero: React.FC<AfterRefreshHeroProps> = ({ hero, next, onOpen }) => {
  const { t } = useTranslation();
  const age =
    formatStoredDate(Math.min(Date.parse(hero.detectedAt), Date.now()), (d) =>
      formatRelativeTime(d),
    ) ?? t('common.dateUnknown');
  const share = hero.total > 0 ? Math.min(hero.done / hero.total, 1) : 0;
  return (
    <div className="flex flex-col h-full" data-testid="home-after-refresh-hero">
      <div className="flex items-center gap-2 mb-3">
        <ListChecks className="w-6 h-6 shrink-0 text-hue-teal" aria-hidden="true" />
        <h1 tabIndex={-1} className={HERO_HEADING}>
          {t('sidePanel.afterRefresh.title', { alias: hero.alias })}
        </h1>
      </div>
      <p className="text-sm text-text-secondary" data-testid="home-after-refresh-progress">
        {t('sidePanel.afterRefresh.desc', { age, done: hero.done, total: hero.total })}
      </p>
      {/* The words above say how far: the bar draws it. */}
      <div aria-hidden="true" className="mt-2 h-1.5 rounded-full bg-surface-3 overflow-hidden">
        <div
          className="h-full rounded-full bg-hue-teal"
          style={{ width: `${share * 100}%` }}
          data-testid="home-after-refresh-bar"
        />
      </div>
      {next !== undefined && (
        <p className="mt-3 text-sm text-text-primary" data-testid="home-after-refresh-next">
          {t('home.afterRefresh.next', { step: t(`home.afterRefresh.step.${next}`) })}
        </p>
      )}
      <div className="mt-auto pt-4">
        <Button variant="primary" onClick={onOpen} data-testid="home-after-refresh-btn">
          {t('home.openOpModule', { module: t('nav.recovery') })}
        </Button>
      </div>
    </div>
  );
};

/**
 * Home page dashboard -- bento command center for SandForge.
 * Shows the KPI row, a hero chosen by the orgs, the connected orgs, recent
 * operations, the selected org's checkpoints and every module.
 *
 * The hero follows the rule the launcher's does (`heroFor`): none while the
 * org list is out; with no org, Getting started and the two ways to connect
 * one; a refreshed sandbox to bring back into service, with its next step;
 * an org to reconnect; one org to fill, alone, filling it with demo data; two
 * or more, Forge; production orgs alone, the sandbox still to add. Home led
 * with Forge to a production org alone, and said "Connect your first org" to
 * a person whose sessions had all expired, while the launcher offered Forge.
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
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  const recentOps = useRecentOpsStore((s) => s.ops);

  const { data: orgListData, loading: orgsLoading } = useBridgeQuery<OrgListPayload>('org:list');

  /**
   * The orgs registered: the store's, else the page's own answer; undefined
   * while that answer is in flight with nothing in the store, so the hero
   * waits rather than calling the panel empty.
   */
  const registered = useMemo<readonly SalesforceOrg[] | undefined>(() => {
    if (orgs.length > 0) return orgs;
    if (orgListData?.orgs) return orgListData.orgs;
    return orgsLoading ? undefined : [];
  }, [orgs, orgListData, orgsLoading]);

  const connectedOrgs = useMemo(
    () => (registered ?? []).filter((o) => o.status === 'connected'),
    [registered],
  );
  const hasOrgs = connectedOrgs.length > 0;

  const recovery = useRecoveryLeads(registered);
  const hero = heroFor({ orgs: registered, selectedOrgId, afterRefresh: recovery.afterRefresh });

  /** Last 5 recent operations for the tile. */
  const recentOpsSlice = useMemo(() => recentOps.slice(0, 5), [recentOps]);

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

  /**
   * Back into service, on the sandbox refreshed: selected here and in the
   * extension first, so the page opens on it, as the launcher's hero does.
   */
  const openRecoveryOn = useCallback(
    (orgId: string) => {
      if (orgId !== selectedOrgId) {
        selectOrg(orgId);
        sendBridgeMessage('org:select', { orgId });
      }
      navigate('recovery');
    },
    [navigate, selectOrg, selectedOrgId],
  );

  /** The two ways to connect an org, by the names Organizations gives them, each starting there. */
  const connectButtons = (importTestId: string, loginTestId: string): React.ReactNode => (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button
        variant="primary"
        onClick={() => navigate('orgs', { orgAction: 'import-cli' })}
        icon={<Icon name="cloud-download" />}
        data-testid={importTestId}
      >
        {t('home.importFromCli')}
      </Button>
      <Button
        variant="secondary"
        onClick={() => navigate('orgs', { orgAction: 'login-web' })}
        icon={<Icon name="link" />}
        data-testid={loginTestId}
      >
        {t('home.loginWeb')}
      </Button>
    </div>
  );

  return (
    <m.div
      className="flex flex-col gap-6 p-4"
      data-testid="home-page"
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
    >
      {/* KPI row: the runs of the week and the selected org's health. The
          orgs connected are listed beside the hero, and the active jobs
          counted only the runs this panel had seen. */}
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
            <div className="flex-1 min-w-[140px]">
              <Skeleton variant="rect" height="88px" />
            </div>
            <div className="flex-[2] min-w-[280px]">
              <Skeleton variant="rect" height="88px" />
            </div>
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
            {/* The cards are not slid in one by one: the org health comes
                with the orgs, and slid up beside a card already in place, one
                sat lower than the other for a moment. The KPI card slides
                within its place. */}
            <div className="flex-1 min-w-[140px]">
              <KPICard
                icon="history"
                label={t('home.opsLast7d')}
                value={opsLast7dCount}
                accentClassName="text-hue-forge"
              />
            </div>
            {hasOrgs && (
              <div className="flex-[2] min-w-[280px]">
                <OrgHealthCard health={health} />
              </div>
            )}
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
        {/* Hero: the launcher's rule, heroFor */}
        <BentoTile colSpan={2} className={hero.kind === 'forge' ? 'border-forge/30' : undefined}>
          {hero.kind === 'none' && (
            <div data-testid="home-hero-loading">
              <Skeleton variant="rect" height="140px" />
            </div>
          )}
          {hero.kind === 'firstOrg' && (
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
              {connectButtons('home-import-cli-btn', 'home-login-web-btn')}
            </div>
          )}
          {hero.kind === 'afterRefresh' && (
            <AfterRefreshHero
              hero={hero}
              next={recovery.nextStepOf(hero.orgId)}
              onOpen={() => openRecoveryOn(hero.orgId)}
            />
          )}
          {hero.kind === 'reconnect' && (
            <div className="flex flex-col h-full" data-testid="home-reconnect-hero">
              <div className="flex items-center gap-2 mb-3">
                <Plug className="w-6 h-6 shrink-0 text-status-warning" aria-hidden="true" />
                <h1 tabIndex={-1} className={HERO_HEADING}>
                  {t('sidePanel.reconnect.title', { alias: hero.alias })}
                </h1>
              </div>
              <p className="text-sm text-text-secondary mb-6">{t('sidePanel.reconnect.desc')}</p>
              <div className="mt-auto">
                <Button
                  variant="primary"
                  onClick={() => navigate('orgs')}
                  data-testid="home-reconnect-btn"
                >
                  {t('home.openOpModule', { module: t('nav.orgs') })}
                </Button>
              </div>
            </div>
          )}
          {hero.kind === 'seed' && (
            <div className="flex flex-col h-full" data-testid="fill-hero-card">
              <div className="flex items-center gap-2 mb-3">
                <Sprout className="w-6 h-6 shrink-0 text-hue-green" aria-hidden="true" />
                <h1 tabIndex={-1} className={HERO_HEADING}>
                  {t('home.fillOrg', { alias: hero.alias })}
                </h1>
              </div>
              <p className="text-sm text-text-secondary mb-6">{t('home.fillOrgDesc')}</p>
              <div className="mt-auto">
                <Button
                  variant="primary"
                  onClick={() =>
                    navigate('seed', { seedMode: 'quick-seed', targetOrgId: hero.orgId })
                  }
                  data-testid="fill-hero-btn"
                >
                  {t('home.fillOrgAction')}
                </Button>
              </div>
            </div>
          )}
          {hero.kind === 'forge' && (
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
          {/* Production orgs alone: Forge copies from them, into a sandbox
              still to add. Forge was offered, and could only refuse. */}
          {hero.kind === 'addSandbox' && (
            <div className="flex flex-col h-full" data-testid="home-add-sandbox-hero">
              <div className="flex items-center gap-2 mb-3">
                <Plus className="w-6 h-6 shrink-0 text-hue-orange" aria-hidden="true" />
                <h1 tabIndex={-1} className={HERO_HEADING}>
                  {t('sidePanel.addSandbox.title')}
                </h1>
              </div>
              <p className="text-sm text-text-secondary">
                {t('sidePanel.addSandbox.desc', { alias: hero.alias })}
              </p>
              {connectButtons('home-add-sandbox-import-btn', 'home-add-sandbox-login-btn')}
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
                      Sync Contacts" row led nowhere. Each is named by its
                      module, in the panel's language: the extension's own
                      label is English and in the present ("Executing forge
                      operation"), whatever became of the run. */}
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
                      <span
                        className="flex-1 truncate text-text-primary"
                        data-testid="recent-op-module"
                      >
                        {t(`nav.${op.type}`)}
                      </span>
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

        {/* Checkpoints of the selected org: none on a production org. */}
        <CheckpointTile org={connectedOrgs.find((org) => org.id === selectedOrgId)} />
      </BentoGrid>

      <AllModulesTile
        sandboxRegistered={(registered ?? []).some((org) => org.orgType === 'Sandbox')}
      />
    </m.div>
  );
};
