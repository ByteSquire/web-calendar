// What a change on a settings or admin page came to, as a toast: it takes no room on the page, so
// nothing below it moves, and it goes away by itself. A failure is also shown where it happened
// (in the dialog or form), so the toast is never the only place that says it.
export function useNotify() {
  const toast = useToast()
  return {
    done: (title: string) => toast.add({ title, icon: 'i-lucide-check' }),
    failed: (title: string) => toast.add({ title, color: 'error', icon: 'i-lucide-x' }),
  }
}
