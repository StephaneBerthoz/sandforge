import React, { useEffect, useRef } from 'react';
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
import { useFocusOnChange } from '../../hooks/useFocusOnChange';

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

  /*
   * Each phase is drawn in place of the last, and the button that moved on —
   * Discover, Review & Execute, Execute, Back — goes with it: the keyboard is
   * handed to the phase, named after it, as the wizard hands it its step. Only
   * from nowhere or from inside the page: a dialog keeps it.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<HTMLDivElement>(null);
  useFocusOnChange(phaseRef, phase, { scope: pageRef });

  if (!selectedOrgId || orgs.length === 0) {
    const noOrgs = orgs.length === 0;
    return (
      <EmptyState
        module="forge"
        title={t('forge.emptyState.title')}
        description={t('moduleSummary.forge')}
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
    <div ref={pageRef} className="flex flex-col gap-4 p-4" data-testid="forge-page">
      <PageHeader title={t('nav.forge')} subtitle={t('moduleSummary.forge')} icon="flame" />
      {/* A finished run is spoken from the results screen. One an error or an
          abort stopped stays on the execution screen, which the page can
          leave and come back to: this region outlives it, and says where the
          run stopped. */}
      <ProgressAnnouncer
        message={
          stoppedAt === null
            ? ''
            : t('a11y.runStopped', { name: t('nav.forge'), percent: stoppedAt })
        }
        immediate
        testId="forge-run-stopped-status"
      />
      <div
        ref={phaseRef}
        role="group"
        aria-label={t(`forge.phaseName.${phase}`)}
        tabIndex={-1}
        data-testid="forge-phase"
      >
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
    </div>
  );
};
