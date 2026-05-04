import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../theme';
import { cardHover, SPRING } from '../../motion/presets';

/** Props omitted to avoid Framer Motion event-handler type conflicts. */
type MotionEventConflicts =
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onDragOver'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration';

/** Card component props. */
export interface CardProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  MotionEventConflicts
> {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

/** Card header props. */
export interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Content card matching VSCode theme. */
export const Card: React.FC<CardProps> = ({ children, className, onClick, hoverable, ...rest }) => {
  return (
    <motion.div
      whileHover={hoverable ? cardHover.whileHover : undefined}
      transition={SPRING}
      className={cn(
        'rounded-lg border border-[var(--vscode-panel-border,#3c3c3c)]',
        'bg-[var(--vscode-editor-background,#1e1e1e)]',
        hoverable &&
          'cursor-pointer hover:border-[var(--vscode-focusBorder,#007fd4)] transition-colors',
        className,
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick();
            }
          : undefined
      }
      {...rest}
    >
      {children}
    </motion.div>
  );
};

/** Card header with title, optional subtitle and action. */
export const CardHeader: React.FC<CardHeaderProps> = ({ title, subtitle, action, className }) => {
  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-3 border-b border-[var(--vscode-panel-border,#3c3c3c)]',
        className,
      )}
    >
      <div>
        <h3 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {title}
        </h3>
        {subtitle && (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-0.5">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
};

/** Card body. */
export const CardBody: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => {
  return <div className={cn('px-4 py-3', className)}>{children}</div>;
};
