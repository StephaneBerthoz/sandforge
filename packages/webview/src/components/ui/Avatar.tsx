import React from 'react';
import { cn } from '../../theme';

/** Avatar size variants. */
export type AvatarSize = 'sm' | 'md' | 'lg';

/** Avatar component props. */
export interface AvatarProps {
  /** Full name used to generate initials. */
  name?: string;
  /** Image source URL. */
  src?: string;
  size?: AvatarSize;
  className?: string;
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
  lg: 'w-12 h-12 text-sm',
};

/** Generates up to two initials from a name. */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Generates a deterministic background color from a name. */
function getColorFromName(name: string): string {
  const colors = [
    'bg-blue-600',
    'bg-emerald-600',
    'bg-amber-600',
    'bg-purple-600',
    'bg-rose-600',
    'bg-cyan-600',
    'bg-indigo-600',
    'bg-teal-600',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/** Avatar displaying an image or colored initials. */
export const Avatar: React.FC<AvatarProps> = ({ name, src, size = 'md', className }) => {
  const initials = name ? getInitials(name) : '?';
  const bgColor = name
    ? getColorFromName(name)
    : 'bg-[var(--vscode-descriptionForeground,#868686)]';

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? 'Avatar'}
        className={cn('rounded-full object-cover', sizeClasses[size], className)}
      />
    );
  }

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center font-semibold text-white select-none',
        sizeClasses[size],
        bgColor,
        className,
      )}
      aria-label={name ?? 'Avatar'}
      role="img"
    >
      {initials}
    </div>
  );
};
