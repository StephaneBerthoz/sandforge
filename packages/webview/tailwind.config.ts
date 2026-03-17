import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // Surface scale — mapped to VSCode CSS variables for theme support
        surface: {
          0: 'var(--sf-bg-primary, #0A0A0F)',
          1: 'var(--sf-bg-card, #12121A)',
          2: 'var(--sf-bg-secondary, #1C1C28)',
          3: 'var(--sf-bg-input, #262635)',
        },
        // Module accent colors (more saturated for dark)
        forge: { DEFAULT: '#F97316', light: '#FFEDD5', dark: '#9A3412' },
        seed: { DEFAULT: '#22C55E', light: '#D1FAE5', dark: '#065F46' },
        sync: { DEFAULT: '#3B82F6', light: '#DBEAFE', dark: '#1E40AF' },
        monitor: { DEFAULT: '#EAB308', light: '#FEF3C7', dark: '#92400E' },
        compare: { DEFAULT: '#A855F7', light: '#EDE9FE', dark: '#5B21B6' },
        dataops: { DEFAULT: '#06B6D4', light: '#CFFAFE', dark: '#0E7490' },
        automation: { DEFAULT: '#F43F5E', light: '#FFE4E6', dark: '#9F1239' },
        // Text — mapped to VSCode CSS variables
        'text-primary': 'var(--sf-text-primary, #F2F2F2)',
        'text-secondary': 'var(--sf-text-secondary, #A3A3A3)',
        'text-muted': 'var(--sf-text-muted, #6B6B7B)',
      },
      borderColor: {
        subtle: 'var(--sf-border-subtle, rgba(255,255,255,0.06))',
        DEFAULT: 'var(--sf-border, rgba(255,255,255,0.10))',
        active: 'rgba(255,255,255,0.16)',
      },
      borderRadius: {
        xl: '12px',
        lg: '8px',
      },
      fontFamily: {
        display: ['Inter Display', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
