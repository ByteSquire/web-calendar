export default defineAppConfig({
  ui: {
    colors: {
      primary: 'blue',
      neutral: 'slate',
    },
    // Nuxt UI sizes controls at about 32 px. Interactive controls need a 44 px tap target
    // (design §9, FR-20), so the minimum height is set once here instead of per use.
    button: {
      slots: {
        base: 'min-h-11 min-w-11 justify-center',
      },
    },
    input: {
      slots: {
        base: 'min-h-11',
      },
    },
    dropdownMenu: {
      slots: {
        item: 'min-h-11 items-center',
      },
    },
  },
})
