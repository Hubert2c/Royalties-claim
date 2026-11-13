// ESLint (code quality checks). Run with: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'uploads/**', 'tests/**/results/**'] },
  js.configs.recommended,
  {
    // Server code (Node.js, CommonJS)
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error'
    }
  },
  {
    // Browser tests: code inside page.evaluate() runs in the browser.
    files: ['tests/compatibility/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // Browser code (the portals). Shared helpers are loaded as separate <script> files.
    files: ['app.js', 'artist/**/*.js', 'licensee/**/*.js', 'public/**/*.js', 'shared/**/*.js', 'docs/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, UI: 'readonly', UIWidgets: 'readonly', UIIcons: 'readonly', STORAGE_KEYS: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', vars: 'local' }] }
  }
];
