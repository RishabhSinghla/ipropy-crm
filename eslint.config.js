/**
 * ESLint 9 flat config — the lint gate the repo never had.
 *
 * The codebase has carried `eslint-disable` comments for a while without a
 * linter to justify them, which is how a gate silently becomes decorative.
 * This config is deliberately lean: it ships the rules that catch real bugs
 * and dead code, and leaves style to `npm run typecheck` and the codebase's
 * own conventions. Adding a rule here that flags a hundred existing lines
 * without a fix is how a green build becomes wallpaper — so the baseline is
 * zero findings and stays that way.
 *
 * Two rules are universal: an unused import is a wrong import wherever it
 * sits, and a bare `any` is a typed API boundary being waved through.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
// `globals` has no named `globals` export — destructure off the default or
// every ESLint invocation dies reading `.browser` of undefined.
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/storage/**',
      '**/backups/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '.claude/**',
      // The Android companion and the Python services are out-of-tree tools
      // with their own conventions; this config is for the npm workspaces.
      'companion-android/**',
      'media-service/**',
      'n8n/**',
      'wa-bridge/**',
      // The web bundle, copied into the native projects by `cap sync`. It is
      // build output that happens to live outside `dist/`, it is gitignored,
      // and linting it produced 9,711 errors in somebody else's minified code
      // — which made `npx eslint .` useless for finding the twenty-three real
      // ones underneath.
      'packages/app/android/app/src/main/assets/public/**',
      'packages/app/ios/App/App/public/**',
      // Per-machine agent wiring, regenerated per session. See .gitignore.
      '.cursor/**',
      '.gemini/**',
      '.windsurf/**',
      '.antigravity/**',
      '.hermes/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // --- the rules that earn their keep ------------------------------
      // `^_` means deliberately unused everywhere — an argument, a local, a
      // destructured property being thrown away (`const { x: _x, ...rest }`),
      // not just parameters.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // An explicit `any` in a typed codebase is a promise to type it later
      // that nobody ever keeps. Fixes are usually a small interface.
      '@typescript-eslint/no-explicit-any': 'error',
      // Throw away control flow that can never run: it is usually a copied
      // branch that has since drifted. `while (true)` loops are intentional
      // and rare — a line comment keeps them.
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-dupe-keys': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-loss-of-precision': 'error',
      'no-template-curly-in-string': 'error',
      // Catches the accidental `case 1 || 2` and a switch whose arms fall
      // through into each other.
      'no-fallthrough': 'error',
      // Two imports from the same module are two chances to drift; the second
      // halves the first one day. Merging lines is mechanical.
      'no-duplicate-imports': ['error', { includeExports: true }],
      'no-unused-expressions': 'error',
      // --- React hooks. The classic two, deliberately. The newer
      // React-Compiler-era rules (set-state-in-effect, purity, refs and
      // friends) read the effects in this codebase as anti-patterns they
      // structurally are not, so they stay off — see e.g. the deliberate
      // "set once when the entity changes" effects in ViewsAdmin.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // CLI scripts and e2e specs are run on a terminal or in CI, where a
    // printed line is the output rather than a debugging artefact.
    files: [
      'scripts/**/*.{js,mjs,ts}',
      'e2e/**/*.ts',
      '**/*.config.{js,ts,mjs}',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);