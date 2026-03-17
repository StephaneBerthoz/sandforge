import React from 'react';
import { Wizard } from '../../components/ui/Wizard';
import type { WizardStep, WizardProps } from '../../components/ui/Wizard';

/** Re-export WizardStep for backward compatibility. */
export type { WizardStep };

/** SeedWizard component props. */
export type SeedWizardProps = Omit<WizardProps, 'testIdPrefix'>;

/** Multi-step wizard for the seed module. */
export const SeedWizard: React.FC<SeedWizardProps> = (props) => (
  <Wizard {...props} testIdPrefix="seed" />
);
