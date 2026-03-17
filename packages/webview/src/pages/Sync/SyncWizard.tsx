import React from 'react';
import { Wizard } from '../../components/ui/Wizard';
import type { WizardStep, WizardProps } from '../../components/ui/Wizard';

/** Re-export types for backward compatibility. */
export type SyncWizardStep = WizardStep;
export type SyncWizardProps = Omit<WizardProps, 'testIdPrefix'>;

/** Multi-step wizard for the sync module. */
export const SyncWizard: React.FC<SyncWizardProps> = (props) => (
  <Wizard {...props} testIdPrefix="sync" />
);
