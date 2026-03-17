import React from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { pageTransition } from '../../motion/presets';
import { useForgeStore } from '../../stores/useForgeStore';
import { ForgeInput } from './ForgeInput';
import { ForgeDiscovery } from './ForgeDiscovery';
import { ForgeReview } from './ForgeReview';
import { ForgeExecution } from './ForgeExecution';
import { ForgeResults } from './ForgeResults';
import { PageHeader } from '../../components/ui/PageHeader';

/** Forge phase variants for AnimatePresence transitions. */
const variants = pageTransition(1);

/**
 * Forge page orchestrator.
 * Routes to the correct sub-view based on the current forge phase.
 */
export const ForgePage: React.FC = () => {
  const { t } = useTranslation();
  const phase = useForgeStore((s) => s.phase);

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="forge-page">
      <PageHeader title={t('nav.forge')} subtitle={t('forge.subtitle')} icon="flame" />
      <AnimatePresence mode="wait">
        <motion.div
          key={phase}
          variants={variants}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {phase === 'input' && <ForgeInput />}
          {phase === 'discovery' && <ForgeDiscovery />}
          {phase === 'review' && <ForgeReview />}
          {phase === 'execution' && <ForgeExecution />}
          {phase === 'results' && <ForgeResults />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};
