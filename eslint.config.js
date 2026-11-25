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
  // Every function in js/ stays at complexity 25 or less (Nov 25): over it, split into helpers in the same file.
  { files: ['js/**/*.js'], rules: { complexity: ['error', 25] } },
  // CLAUDE.md module and product rules, checked here so no session can miss them (Nov 25).
  {
    files: ['js/**/*.js'],
    ignores: ['js/dates.js'],
    rules: {
      // Never import js/app.js from a module: deps come in through initX(deps).
      'no-restricted-imports': ['error', { patterns: [{ regex: '(^|/)app\\.js$', message: 'Never import js/app.js: take what you need through initX(deps) (CLAUDE.md, module rules).' }] }],
      // No browser popups: they block the Ride controllers. Use tell() / ask() from js/app.js.
      'no-alert': 'error',
      'no-restricted-syntax': ['error',
        { selector: ':matches(FunctionDeclaration, VariableDeclarator)[id.name=/^(dkey|dayDate|addDays|mondayOf)$/]', message: 'Day keys come from js/dates.js: import it, never keep a local copy.' },
        { selector: "CallExpression[callee.property.name='toLocaleDateString'][arguments.0.value='en-CA']", message: 'This is a day key: use dkey() from js/dates.js.' },
      ],
    },
  },
];
