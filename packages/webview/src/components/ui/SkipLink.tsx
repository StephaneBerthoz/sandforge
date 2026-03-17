import React from 'react';
import { useTranslation } from 'react-i18next';

/** Props for the SkipLink component. */
export interface SkipLinkProps {
  /** The ID of the main content container to skip to. */
  targetId?: string;
  /** Optional CSS class name override. */
  className?: string;
}

/**
 * Accessible skip-to-main-content link for keyboard navigation.
 * Hidden by default, becomes visible on focus (Tab key).
 * Conforms to WCAG 2.1 AA bypass blocks requirement (2.4.1).
 */
export const SkipLink: React.FC<SkipLinkProps> = ({
  targetId = 'main-content',
  className,
}) => {
  const { t } = useTranslation();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    const target = document.getElementById(targetId);
    if (target) {
      target.focus();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <a
      href={`#${targetId}`}
      onClick={handleClick}
      className={
        className ??
        'sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:rounded focus:text-sm focus:font-medium focus:bg-[var(--vscode-button-background,#0e639c)] focus:text-[var(--vscode-button-foreground,#fff)] focus:outline-none focus:ring-2 focus:ring-[var(--vscode-focusBorder,#007fd4)]'
      }
    >
      {t('common.skipToContent', 'Skip to main content')}
    </a>
  );
};
