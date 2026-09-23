import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, m } from 'framer-motion';
import { pageTransition } from '../../motion/presets';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { EmptyState } from '../../components/ui/EmptyState';
import { ForgeInput } from './ForgeInput';
import { ForgeDiscovery } from './ForgeDiscovery';
import { ForgeReview } from './ForgeReview';
import { ForgeExecution } from './ForgeExecution';
import { ForgeResults } from './ForgeResults';
import { PageHeader } from '../../components/ui/PageHeader';
import { ProgressAnnouncer } from '../../components/ui/ProgressBar';

/** Forge phase variants for AnimatePresence transitions. */
const variants = pageTransition(1);

/**
 * Forge page orchestrator.
 * Routes to the correct sub-view based on the current forge phase.
 */
export const ForgePage: React.FC = () => {
  const { t } = useTranslation();
  const phase = useForgeStore((s) => s.phase);
  const stoppedAt = useForgeStore((s) => s.stoppedAt);
  const setStoppedAt = useForgeStore((s) => s.setStoppedAt);
  const orgs = useOrgStore((s) => s.orgs);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const navigate = useAppStore((s) => s.navigate);

  // Said once: coming back to the page must not repeat the stop.
  useEffect(() => () => setStoppedAt(null), [setStoppedAt]);

  if (!selectedOrgId || orgs.length === 0) {
    const noOrgs = orgs.length === 0;
    return (
      <EmptyState
        module="forge"
        title={t('forge.emptyState.title')}
        description={t('forge.emptyState.description')}
        steps={[
          noOrgs ? t('emptyState.connectViaSfdx') : t('forge.emptyState.step1Select'),
          t('forge.emptyState.step2'),
          t('forge.emptyState.step3'),
          t('forge.emptyState.step4'),
          t('forge.emptyState.step5'),
        ]}
        actionLabel={noOrgs ? t('emptyState.connectOrg') : t('emptyState.selectOrgCta')}
        onAction={() => navigate('orgs')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="forge-page">
      <PageHeader title={t('nav.forge')} subtitle={t('forge.subtitle')} icon="flame" />
      {/* A finished run is spoken from the results screen. An aborted run goes
          back to the input screen in the same instant, and a failed one stays
          on the execution screen: this region outlives both, and says where
          the run stopped. */}
      <ProgressAnnouncer
        message={
          stoppedAt === null
            ? ''
            : t('a11y.runStopped', { name: t('nav.forge'), percent: stoppedAt })
        }
        immediate
        testId="forge-run-stopped-status"
      />
      <AnimatePresence mode="wait">
        <m.div key={phase} variants={variants} initial="enter" animate="center" exit="exit">
          {phase === 'input' && <ForgeInput />}
          {phase === 'discovery' && <ForgeDiscovery />}
          {phase === 'review' && <ForgeReview />}
          {phase === 'execution' && <ForgeExecution />}
          {phase === 'results' && <ForgeResults />}
        </m.div>
      </AnimatePresence>
    </div>
  );
};
