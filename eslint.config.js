// npm run lint. The deploy fails on errors (a misspelt name, unreachable code); warnings are for tidying.
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-self-assign': 'error',
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none' }],
    },
  },
];
