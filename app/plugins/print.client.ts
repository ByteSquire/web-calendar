// The browser's own Print command (Ctrl+P, the browser menu) gets the same light page as the ⋮
// menu's (composables/usePrinting.ts). Registered before any calendar mounts, so it runs before
// FullCalendar's own `beforeprint` handler, and Vue draws the light scheme in between.
export default defineNuxtPlugin(() => {
  const { begin, end } = usePrinting()
  window.addEventListener('beforeprint', begin)
  window.addEventListener('afterprint', end)
})
