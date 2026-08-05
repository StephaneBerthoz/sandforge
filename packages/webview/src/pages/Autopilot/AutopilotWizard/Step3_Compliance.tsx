import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ComplianceFrameworkType } from '@sandforge/shared';
import { cn } from '../../../theme';

/** Step3Compliance component props. */
export interface Step3ComplianceProps {
  /** Currently selected compliance framework */
  readonly selectedFramework: ComplianceFrameworkType;
  /** Callback when framework is selected */
  readonly onSelect: (framework: ComplianceFrameworkType) => void;
}

/** Description of each compliance framework. */
interface FrameworkOption {
  readonly value: ComplianceFrameworkType;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly icon: string;
}

/** Available compliance framework options. */
const FRAMEWORK_OPTIONS: FrameworkOption[] = [
  {
    value: 'none',
    labelKey: 'autopilot.step3.none',
    descriptionKey: 'autopilot.step3.noneDesc',
    icon: 'O',
  },
  {
    value: 'gdpr',
    labelKey: 'autopilot.step3.gdpr',
    descriptionKey: 'autopilot.step3.gdprDesc',
    icon: 'G',
  },
  {
    value: 'ccpa',
    labelKey: 'autopilot.step3.ccpa',
    descriptionKey: 'autopilot.step3.ccpaDesc',
    icon: 'C',
  },
  {
    value: 'hipaa',
    labelKey: 'autopilot.step3.hipaa',
    descriptionKey: 'autopilot.step3.hipaaDesc',
    icon: 'H',
  },
  {
    value: 'pci_dss',
    labelKey: 'autopilot.step3.pciDss',
    descriptionKey: 'autopilot.step3.pciDssDesc',
    icon: 'P',
  },
];

/** Step 3: Select compliance framework for PII anonymization. */
export const Step3Compliance: React.FC<Step3ComplianceProps> = ({
  selectedFramework,
  onSelect,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="step3-compliance">
      <p className="text-sm text-text-secondary">{t('autopilot.step3.description')}</p>

      <div className="flex flex-col gap-2" data-testid="framework-options">
        {FRAMEWORK_OPTIONS.map((option) => {
          const isSelected = selectedFramework === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'flex items-start gap-3 p-3 rounded border-2 cursor-pointer transition-colors',
                isSelected
                  ? 'bg-[var(--sf-bg-active)] border-[var(--sf-accent)]'
                  : 'bg-[var(--sf-bg-primary)] border-[var(--sf-border)] hover:bg-[var(--sf-bg-hover)]',
              )}
              data-testid={`framework-${option.value}`}
            >
              <input
                type="radio"
                name="compliance-framework"
                value={option.value}
                checked={isSelected}
                onChange={() => onSelect(option.value)}
                className="mt-1 accent-[var(--sf-accent)]"
              />
              <div className="flex items-center gap-3 flex-1">
                <span
                  className={cn(
                    'w-8 h-8 rounded flex items-center justify-center text-sm font-bold shrink-0',
                    isSelected
                      ? 'bg-[var(--sf-accent)] text-white'
                      : 'bg-[var(--sf-bg-input)] text-text-secondary',
                  )}
                >
                  {option.icon}
                </span>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-text-primary">
                    {t(option.labelKey)}
                  </span>
                  <span className="text-xs text-text-secondary">{t(option.descriptionKey)}</span>
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
};
