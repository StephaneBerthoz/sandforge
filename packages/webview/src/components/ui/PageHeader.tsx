import React from 'react';
import { cn } from '../../theme';
import { Icon } from './Icon';

/** Props for the PageHeader component. */
export interface PageHeaderProps {
  /** Page title text. */
  title: string;
  /** Optional subtitle displayed below the title. */
  subtitle?: string;
  /** Codicon name displayed to the left of the title. */
  icon?: string;
  /** Action elements rendered on the right side of the header. */
  actions?: React.ReactNode;
  /** Breadcrumb segments displayed above the title. */
  breadcrumb?: string[];
  /** Additional CSS classes for the root element. */
  className?: string;
}

/**
 * Page header with title, icon, subtitle, breadcrumb and action area.
 * Uses design system tokens for all styling.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon,
  actions,
  breadcrumb,
  className,
}) => {
  return (
    <div
      data-testid="page-header"
      className={cn('flex flex-col', className)}
      style={{ marginBottom: 'var(--sf-space-6)' }}
    >
      {/* Breadcrumb */}
      {breadcrumb && breadcrumb.length > 0 && (
        <nav
          data-testid="page-header-breadcrumb"
          className="flex items-center flex-wrap"
          style={{
            gap: 'var(--sf-space-1)',
            marginBottom: 'var(--sf-space-2)',
            fontSize: 'var(--sf-font-size-sm)',
            color: 'var(--sf-text-muted)',
          }}
          aria-label="Breadcrumb"
        >
          {breadcrumb.map((segment, index) => (
            <React.Fragment key={index}>
              {index > 0 && (
                <span
                  aria-hidden="true"
                  style={{ color: 'var(--sf-text-muted)' }}
                >
                  /
                </span>
              )}
              <span
                className={cn(
                  index === breadcrumb.length - 1 && 'font-medium',
                )}
                style={{
                  color:
                    index === breadcrumb.length - 1
                      ? 'var(--sf-text-secondary)'
                      : 'var(--sf-text-muted)',
                }}
              >
                {segment}
              </span>
            </React.Fragment>
          ))}
        </nav>
      )}

      {/* Title row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center" style={{ gap: 'var(--sf-space-2)' }}>
          {icon && (
            <Icon
              name={icon}
              className="text-lg"
              label={title}
            />
          )}
          <div>
            <h1
              className="font-semibold"
              style={{
                fontSize: 'var(--sf-font-size-xl)',
                color: 'var(--sf-text-primary)',
                lineHeight: 1.3,
              }}
            >
              {title}
            </h1>
            {subtitle && (
              <p
                data-testid="page-header-subtitle"
                style={{
                  fontSize: 'var(--sf-font-size-sm)',
                  color: 'var(--sf-text-secondary)',
                  marginTop: 'var(--sf-space-1)',
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        {actions && (
          <div
            data-testid="page-header-actions"
            className="flex items-center"
            style={{ gap: 'var(--sf-space-2)' }}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
};
