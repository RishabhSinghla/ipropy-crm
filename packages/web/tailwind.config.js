/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc',
          400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca',
          800: '#3730a3', 900: '#312e81', 950: '#1e1b4b',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          muted: 'var(--surface-muted)',
          raised: 'var(--surface-raised)',
        },
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
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-success': 'pulseRing 0.8s ease-out',
        'pulse-error': 'pulseRingError 0.8s ease-out',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
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
