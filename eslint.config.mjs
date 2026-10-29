// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

// Prettier owns formatting; eslint-config-prettier switches off ESLint rules that
// would conflict with it, so it must come last.
export default withNuxt(
  { ignores: ['.claude/**', '.data/**', '.npm-cache/**', 'dev/spike-s1/.local/**'] },
  {
    // Plain Node script run at container start (not part of the Nuxt app).
    files: ['server/validate-config.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  eslintConfigPrettier,
)
