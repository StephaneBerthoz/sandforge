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
 * SVG-based SandForge logo: fire in the hearth, with embers rising off it.
 *
 * Geometry is the 24-unit mark from `resources/icons/toolkit.svg`, scaled onto
 * a 64 grid — the in-app logo and the marketplace icon have to be the same
 * object, or the product wears two identities. Only the embers are extra: they
 * need room the activity-bar mark does not have, and they carry the motion.
 *
 * Supports three sizes and a monochrome variant. The ember drift respects
 * `prefers-reduced-motion`.
 */
export const Logo: React.FC<LogoProps> = ({ size = 'medium', mono = false, className }) => {
  const px = SIZE_MAP[size];
  const flameColor = mono ? 'currentColor' : '#F5A623';
  const emberColor = mono ? 'currentColor' : '#FFD97A';
  const hearthColor = mono ? 'currentColor' : '#5F6982';

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
        }
        @keyframes sfSparkDrift {
          from { transform: translateY(0) translateX(0); opacity: 0.55; }
          to { transform: translateY(-3px) translateX(1px); opacity: 1; }
        }
      `}</style>

      {/* Hearth, then flame: the flame has to sit in front, or the hearth lays
          a bar across its flanks and the two read as one shape. */}
      <g transform="scale(2.667)">
        <path d="M3.4 13.6 H6.4 V18.4 H17.6 V13.6 H20.6 V21.6 H3.4 Z" fill={hearthColor} />
        <path
          d="M12.2 2.2 C13.7 6.6 18.3 8.4 18.3 12.9 C18.3 16.1 15.6 19.6 12 19.6
             C8.4 19.6 5.7 16.1 5.7 12.9 C5.7 9.9 7.8 8.5 9.5 6.2
             C10 8.7 10.9 9.5 11.5 9.3 C12.2 9 11.6 5.2 12.2 2.2 Z"
          fill={flameColor}
        />
      </g>

      {/* Embers off the flame tip. */}
      <circle className="sf-spark" cx="24" cy="9" r="1.6" fill={emberColor} opacity="0.75" />
      <circle className="sf-spark-2" cx="40" cy="12" r="1.2" fill={emberColor} opacity="0.6" />
      <circle className="sf-spark-3" cx="43" cy="6" r="1.4" fill={emberColor} opacity="0.85" />
    </svg>
  );
};
