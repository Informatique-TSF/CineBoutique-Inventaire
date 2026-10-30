import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import * as tseslint from 'typescript-eslint'

const { plugins: _jsxA11yPlugins, parserOptions: _jsxA11yParserOptions, ...jsxA11yRecommended } =
  jsxA11y.configs.recommended

export default defineConfig([
  globalIgnores(['dist', 'dev-dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11yRecommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: { version: 'detect' },
      'import/core-modules': ['virtual:pwa-register'],
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react/button-has-type': 'error',
      'react/react-in-jsx-scope': 'off',
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either' }],
      'jsx-a11y/control-has-associated-label': 'warn',
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    files: ['**/vite.config.ts', '**/tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
