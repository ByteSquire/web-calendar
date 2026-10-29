// Focus restoration for dialogs that are opened without a trigger element. Reka UI only restores
// focus to a DialogTrigger, so the event sheet remembers the element that was active when it opened.

/** The opener while it is still in the document, else the fallback (for example a container). */
export function pickFocusTarget<T extends { isConnected: boolean }>(
  opener: T | null | undefined,
  fallback: T | null | undefined,
): T | null {
  if (opener?.isConnected) return opener
  return fallback?.isConnected ? fallback : null
}
