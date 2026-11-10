// Linter (npm run lint): findet Fehler, die beim Lesen untergehen - nicht definierte Namen
// (Tippfehler, nach dem Verschieben in ein anderes Modul nicht importiert), unbenutzte
// Variablen, versehentliche Zuweisungen. Formatierung prüft er bewusst nicht.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'node_modules/**', 'supabase/**', 'dev/screenshots/**'] },
  js.configs.recommended,
  {
    // App im Browser (ES-Module)
    files: ['*.js', 'js/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } },
  },
  {
    // Vorschau/Tests: Node-Skripte, die teils Code im Browser ausführen (page.evaluate)
    files: ['dev/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
];
