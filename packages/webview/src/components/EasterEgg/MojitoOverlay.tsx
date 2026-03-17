import React, { useEffect } from 'react';

/** Props for the MojitoOverlay component. */
export interface MojitoOverlayProps {
  /** Called when the overlay is dismissed. */
  onClose: () => void;
}

/**
 * Full-screen easter egg overlay with an animated SVG mojito.
 * Dismissed by clicking anywhere or pressing Escape.
 */
export const MojitoOverlay: React.FC<MojitoOverlayProps> = ({ onClose }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      data-testid="mojito-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Easter egg"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.85)',
        animation: 'mojitoFadeIn 0.5s ease-out',
        cursor: 'pointer',
      }}
    >
      <style>{`
        @keyframes mojitoFadeIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes mojitoBubbleRise1 {
          0% { transform: translateY(0); opacity: 0.7; }
          100% { transform: translateY(-80px); opacity: 0; }
        }
        @keyframes mojitoBubbleRise2 {
          0% { transform: translateY(0); opacity: 0.6; }
          100% { transform: translateY(-70px); opacity: 0; }
        }
        @keyframes mojitoBubbleRise3 {
          0% { transform: translateY(0); opacity: 0.5; }
          100% { transform: translateY(-90px); opacity: 0; }
        }
        @keyframes mojitoBubbleRise4 {
          0% { transform: translateY(0); opacity: 0.8; }
          100% { transform: translateY(-60px); opacity: 0; }
        }
        @keyframes mojitoBubbleRise5 {
          0% { transform: translateY(0); opacity: 0.6; }
          100% { transform: translateY(-75px); opacity: 0; }
        }
        @keyframes mojitoSway {
          0%, 100% { transform: rotate(-5deg); }
          50% { transform: rotate(5deg); }
        }
      `}</style>
      <svg
        viewBox="0 0 400 520"
        width="400"
        height="520"
        xmlns="http://www.w3.org/2000/svg"
        style={{ maxWidth: '90vw', maxHeight: '85vh' }}
        data-testid="mojito-svg"
      >
        {/* Background */}
        <defs>
          <radialGradient id="bgGrad" cx="50%" cy="40%">
            <stop offset="0%" stopColor="#2a2a3e" />
            <stop offset="100%" stopColor="#1a1a2e" />
          </radialGradient>
          <linearGradient id="liquidGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b8e986" />
            <stop offset="100%" stopColor="#4a9e2f" />
          </linearGradient>
          <linearGradient id="glassGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.15)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.05)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="400" height="520" rx="20" fill="url(#bgGrad)" />

        {/* Glass (highball trapezoid) */}
        <path
          d="M135 110 L125 310 Q125 320 135 320 L265 320 Q275 320 275 310 L265 110 Z"
          fill="url(#glassGrad)"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth="1.5"
        />

        {/* Liquid */}
        <path
          d="M130 170 L126 310 Q126 318 135 318 L265 318 Q274 318 274 310 L270 170 Z"
          fill="url(#liquidGrad)"
          opacity="0.85"
        />

        {/* Glass reflections */}
        <line x1="140" y1="120" x2="137" y2="300" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
        <line x1="258" y1="120" x2="261" y2="300" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* Ice cubes */}
        <rect x="155" y="190" width="35" height="28" rx="4" fill="rgba(255,255,255,0.25)" transform="rotate(-8 172 204)" />
        <rect x="205" y="210" width="30" height="25" rx="4" fill="rgba(255,255,255,0.2)" transform="rotate(12 220 222)" />
        <rect x="170" y="245" width="32" height="26" rx="4" fill="rgba(255,255,255,0.18)" transform="rotate(-3 186 258)" />

        {/* Condensation drops */}
        <circle cx="138" cy="200" r="2" fill="rgba(255,255,255,0.3)" />
        <circle cx="140" cy="240" r="1.5" fill="rgba(255,255,255,0.25)" />
        <circle cx="136" cy="270" r="2.5" fill="rgba(255,255,255,0.2)" />
        <circle cx="268" cy="220" r="1.8" fill="rgba(255,255,255,0.2)" />
        <circle cx="270" cy="260" r="2" fill="rgba(255,255,255,0.25)" />

        {/* Lime wedge on rim */}
        <g transform="translate(240, 100)">
          <circle cx="0" cy="0" r="22" fill="#5cb332" />
          <circle cx="0" cy="0" r="17" fill="#8ed45e" />
          <circle cx="0" cy="0" r="11" fill="#b8e986" />
          {/* Segments */}
          <line x1="0" y1="-17" x2="0" y2="17" stroke="#5cb332" strokeWidth="1" opacity="0.5" />
          <line x1="-17" y1="0" x2="17" y2="0" stroke="#5cb332" strokeWidth="1" opacity="0.5" />
          <line x1="-12" y1="-12" x2="12" y2="12" stroke="#5cb332" strokeWidth="1" opacity="0.5" />
          <line x1="12" y1="-12" x2="-12" y2="12" stroke="#5cb332" strokeWidth="1" opacity="0.5" />
        </g>

        {/* Straw (red striped) */}
        <g>
          <line x1="170" y1="60" x2="185" y2="280" stroke="#e84040" strokeWidth="6" strokeLinecap="round" />
          <line x1="170.5" y1="70" x2="172" y2="90" stroke="rgba(255,255,255,0.4)" strokeWidth="3" />
          <line x1="174" y1="110" x2="176" y2="130" stroke="rgba(255,255,255,0.4)" strokeWidth="3" />
          <line x1="177" y1="150" x2="179" y2="170" stroke="rgba(255,255,255,0.4)" strokeWidth="3" />
          <line x1="180" y1="190" x2="182" y2="210" stroke="rgba(255,255,255,0.4)" strokeWidth="3" />
        </g>

        {/* Mint leaves */}
        <g style={{ transformOrigin: '195px 140px', animation: 'mojitoSway 3s ease-in-out infinite' }}>
          {/* Leaf 1 */}
          <path d="M195 140 Q180 115 195 95 Q210 115 195 140" fill="#3da522" />
          <line x1="195" y1="140" x2="195" y2="97" stroke="#2d8019" strokeWidth="0.8" />
          {/* Leaf 2 */}
          <path d="M195 140 Q170 125 175 100 Q195 118 195 140" fill="#4abf2e" />
          <line x1="195" y1="140" x2="177" y2="103" stroke="#359e1f" strokeWidth="0.6" />
          {/* Leaf 3 */}
          <path d="M195 140 Q215 120 220 95 Q200 115 195 140" fill="#5cd43a" />
          <line x1="195" y1="140" x2="217" y2="100" stroke="#3da522" strokeWidth="0.6" />
          {/* Leaf 4 */}
          <path d="M195 140 Q225 130 230 110 Q210 125 195 140" fill="#4abf2e" opacity="0.9" />
          <line x1="195" y1="140" x2="227" y2="113" stroke="#359e1f" strokeWidth="0.5" />
        </g>

        {/* Bubbles */}
        <circle cx="180" cy="280" r="3" fill="rgba(255,255,255,0.5)" style={{ animation: 'mojitoBubbleRise1 3s ease-in infinite' }} />
        <circle cx="200" cy="290" r="2" fill="rgba(255,255,255,0.4)" style={{ animation: 'mojitoBubbleRise2 3.5s ease-in infinite 0.5s' }} />
        <circle cx="215" cy="275" r="2.5" fill="rgba(255,255,255,0.45)" style={{ animation: 'mojitoBubbleRise3 4s ease-in infinite 1s' }} />
        <circle cx="190" cy="260" r="1.5" fill="rgba(255,255,255,0.35)" style={{ animation: 'mojitoBubbleRise4 3.2s ease-in infinite 1.5s' }} />
        <circle cx="230" cy="285" r="2" fill="rgba(255,255,255,0.4)" style={{ animation: 'mojitoBubbleRise5 3.8s ease-in infinite 0.8s' }} />

        {/* Separator */}
        <line x1="120" y1="370" x2="280" y2="370" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />

        {/* Text: SANDFORGE */}
        <text x="200" y="400" textAnchor="middle" fill="#E8A838" fontWeight="600" fontSize="18" letterSpacing="2" fontFamily="system-ui, sans-serif">
          SANDFORGE v1.0.0
        </text>

        {/* Subtitle */}
        <text x="200" y="425" textAnchor="middle" fill="#a0a0b8" fontSize="12" letterSpacing="1" fontFamily="system-ui, sans-serif">
          Crafted with love &amp; mojitos
        </text>

        {/* Author */}
        <text x="200" y="450" textAnchor="middle" fill="#b8e986" fontWeight="500" fontSize="13" fontFamily="system-ui, sans-serif">
          {'by St\u00E9phane B.'}
        </text>

        {/* Separator */}
        <line x1="160" y1="468" x2="240" y2="468" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />

        {/* Thanks */}
        <text x="200" y="490" textAnchor="middle" fill="#7a7a92" fontSize="11" fontStyle="italic" fontFamily="system-ui, sans-serif">
          {'Special thanks to St\u00E9phane H.'}
        </text>
        <text x="200" y="506" textAnchor="middle" fill="#7a7a92" fontSize="10" fontStyle="italic" fontFamily="system-ui, sans-serif">
          {'— partner in crime since day 1'}
        </text>
      </svg>
    </div>
  );
};
