/**
 * The zone the signed-in user chose to see times in (FR-32): an IANA name, or null for the
 * browser's zone, which is the default. The shared holder of what `/api/me` says; the live loader
 * (utils/live/loader.ts) and the settings screen fill it. For what the UI shows, use
 * `useDisplayTimeZone()`, which also covers the browser's and the organization's zone.
 */
export function useUserTimeZone() {
  return useState<string | null>('user-time-zone', () => null)
}
