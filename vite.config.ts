import { defineConfig } from 'vite-plus'

// Nuxt owns the dev server and production build. This config only drives the
// Vite+ quality toolchain (vp check / vp lint / vp fmt / vp test).
export default defineConfig({
  fmt: {
    singleQuote: true,
    semi: false,
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
})
