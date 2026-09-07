/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // The brand scale is CSS variables (styles.css) so an admin can recolour
        // the whole CRM from Brand settings without a rebuild — the defaults
        // there are the indigo this shipped with.
        brand: {
          50: 'var(--brand-50)', 100: 'var(--brand-100)', 200: 'var(--brand-200)',
          300: 'var(--brand-300)', 400: 'var(--brand-400)', 500: 'var(--brand-500)',
          600: 'var(--brand-600)', 700: 'var(--brand-700)', 800: 'var(--brand-800)',
          900: 'var(--brand-900)', 950: 'var(--brand-950)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          muted: 'var(--surface-muted)',
          raised: 'var(--surface-raised)',
        },
        // Semantic text tokens — see the contrast note in styles.css. Use these
        // for secondary copy and up/down deltas instead of picking a slate or
        // emerald step by eye; the raw steps are not AA at the sizes used here.
        muted: 'var(--text-muted)',
        positive: 'var(--text-positive)',
        negative: 'var(--text-negative)',
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        float: '0 10px 30px -10px rgb(0 0 0 / 0.2)',
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'slide-in-right': 'slideInRight 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
        'scale-in': 'scaleIn 0.18s ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-success': 'pulseRing 0.8s ease-out',
        'pulse-error': 'pulseRingError 0.8s ease-out',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideInRight: { '0%': { opacity: '0', transform: 'translateX(100%)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        scaleIn: { '0%': { opacity: '0', transform: 'scale(0.97) translateY(4px)' }, '100%': { opacity: '1', transform: 'scale(1) translateY(0)' } },
        shimmer: { '0%': { backgroundPosition: '-1000px 0' }, '100%': { backgroundPosition: '1000px 0' } },
        // A quiet confirmation, not an alert — a soft ring that blooms in and
        // fades, so a successful inline edit registers without a toast.
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgb(16 185 129 / 0.45)' },
          '30%': { boxShadow: '0 0 0 4px rgb(16 185 129 / 0.25)' },
          '100%': { boxShadow: '0 0 0 4px rgb(16 185 129 / 0)' },
        },
        pulseRingError: {
          '0%': { boxShadow: '0 0 0 0 rgb(239 68 68 / 0.45)' },
          '30%': { boxShadow: '0 0 0 4px rgb(239 68 68 / 0.25)' },
          '100%': { boxShadow: '0 0 0 4px rgb(239 68 68 / 0)' },
        },
      },
    },
  },
  plugins: [],
};
