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
          subtle: 'var(--surface-subtle)',
          raised: 'var(--surface-raised)',
        },
        // Semantic text tokens — see the contrast note in styles.css. Use these
        // for secondary copy and up/down deltas instead of picking a slate or
        // emerald step by eye; the raw steps are not AA at the sizes used here.
        muted: 'var(--text-muted)',
        positive: 'var(--text-positive)',
        negative: 'var(--text-negative)',
        // The design's second and third voices: indigo for operational states
        // and entity links, emerald for conversions. Variables like the brand
        // scale, so a recolour stays one place.
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          'on-soft': 'var(--accent-on-soft)',
        },
        /*
          The prototype's two soft voices, used by the record hero's gradient
          and the comment cards. Variables like everything else, so a recolour
          stays one place.
        */
        sage: {
          50: 'var(--sage-50)', 100: 'var(--sage-100)', 200: 'var(--sage-200)',
          300: 'var(--sage-300)', 600: 'var(--sage-600)', 700: 'var(--sage-700)', 800: 'var(--sage-800)',
        },
        cream: { 50: 'var(--cream-50)', 100: 'var(--cream-100)', 200: 'var(--cream-200)' },
        'positive-soft': 'var(--positive-soft)',
        'positive-on-soft': 'var(--positive-on-soft)',
        'negative-soft': 'var(--negative-soft)',
        'negative-on-soft': 'var(--negative-on-soft)',
      },
      fontFamily: {
        /*
          One typeface, on the owner's prototype of 27 September 2026.

          It was a pairing — Geist for dense record text, Space Grotesk for
          names and headings — and the prototype sets `font-sans` to Plus
          Jakarta Sans for everything. `display` stays as a *name* rather than
          being deleted, because `h1..h3` and `.font-display` are written
          across the CRM and pointing them at the same family keeps every one
          of them working while the two faces are one.
        */
        sans: ['Plus Jakarta Sans Variable', 'Plus Jakarta Sans', 'Inter var', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans Variable', 'Plus Jakarta Sans', 'Inter var', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        /*
          The two faintest lifts, which Tailwind 3 does not ship and the
          prototype uses everywhere. Without them `shadow-xs` and `shadow-2xs`
          are quietly nothing in JSX and an outright build error inside
          `@apply` — so they are real here rather than half-real.
        */
        '2xs': '0 1px 1px 0 rgb(15 23 42 / 0.04)',
        xs: '0 1px 2px 0 rgb(15 23 42 / 0.06)',
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
