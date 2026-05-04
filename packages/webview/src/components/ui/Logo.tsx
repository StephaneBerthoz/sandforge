import React from 'react';

/** Logo display size. */
export type LogoSize = 'small' | 'medium' | 'large';

/** Props for the Logo component. */
export interface LogoProps {
  /** Display size: small (24px), medium (48px), or large (96px). */
  size?: LogoSize;
  /** Use monochrome variant for dark contexts. */
  mono?: boolean;
  /** Optional CSS class name. */
  className?: string;
}

const SIZE_MAP: Record<LogoSize, number> = {
  small: 24,
  medium: 48,
  large: 96,
};

/**
 * SVG-based SandForge logo featuring an anvil silhouette with sand particles and sparks.
 * Supports three sizes and a monochrome variant.
 * Includes a subtle hover animation on particles that respects `prefers-reduced-motion`.
 */
export const Logo: React.FC<LogoProps> = ({ size = 'medium', mono = false, className }) => {
  const px = SIZE_MAP[size];
  const anvilColor = mono ? 'currentColor' : '#E8A838';
  const sparkColor = mono ? 'currentColor' : '#F59E0B';
  const sandColor = mono ? 'currentColor' : '#D97706';
  const baseColor = mono ? 'currentColor' : '#78716C';

  return (
    <svg
      viewBox="0 0 64 64"
      width={px}
      height={px}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="SandForge logo"
      className={className}
      data-testid="logo-svg"
    >
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .sf-spark { animation: sfSparkDrift 2s ease-in-out infinite alternate; }
          .sf-spark-2 { animation: sfSparkDrift 2.4s ease-in-out infinite alternate-reverse; }
          .sf-spark-3 { animation: sfSparkDrift 1.8s ease-in-out infinite alternate; animation-delay: 0.3s; }
          .sf-sand { animation: sfSandShift 3s ease-in-out infinite alternate; }
          .sf-sand-2 { animation: sfSandShift 2.6s ease-in-out infinite alternate-reverse; }
        }
        @keyframes sfSparkDrift {
          from { transform: translateY(0) translateX(0); opacity: 0.7; }
          to { transform: translateY(-3px) translateX(1px); opacity: 1; }
        }
        @keyframes sfSandShift {
          from { transform: translateX(0); opacity: 0.6; }
          to { transform: translateX(2px); opacity: 1; }
        }
      `}</style>

      {/* Anvil base */}
      <rect x="12" y="48" width="40" height="6" rx="2" fill={baseColor} />

      {/* Anvil body */}
      <path d="M18 48 L18 36 L14 32 L14 28 L50 28 L50 32 L46 36 L46 48 Z" fill={anvilColor} />

      {/* Anvil horn (left) */}
      <path d="M14 28 L6 26 L6 30 L14 32 Z" fill={anvilColor} opacity="0.85" />

      {/* Anvil top surface highlight */}
      <rect
        x="14"
        y="28"
        width="36"
        height="2"
        rx="1"
        fill={mono ? 'currentColor' : '#FCD34D'}
        opacity="0.4"
      />

      {/* Sparks */}
      <circle className="sf-spark" cx="28" cy="22" r="2" fill={sparkColor} opacity="0.8" />
      <circle className="sf-spark-2" cx="36" cy="18" r="1.5" fill={sparkColor} opacity="0.7" />
      <circle className="sf-spark-3" cx="42" cy="22" r="1.8" fill={sparkColor} opacity="0.9" />
      <circle className="sf-spark" cx="22" cy="16" r="1.2" fill={sparkColor} opacity="0.6" />

      {/* Sand particles */}
      <circle className="sf-sand" cx="20" cy="56" r="1.2" fill={sandColor} opacity="0.7" />
      <circle className="sf-sand-2" cx="32" cy="57" r="1" fill={sandColor} opacity="0.5" />
      <circle className="sf-sand" cx="44" cy="56" r="1.3" fill={sandColor} opacity="0.6" />
      <circle className="sf-sand-2" cx="26" cy="58" r="0.8" fill={sandColor} opacity="0.4" />
      <circle className="sf-sand" cx="38" cy="58" r="0.9" fill={sandColor} opacity="0.5" />
    </svg>
  );
};
