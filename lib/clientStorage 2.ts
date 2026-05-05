export function clearSessionNames() {
  if (typeof window === 'undefined') return
  // Clear both name and anon-token keys for every session this browser has
  // touched. Anon tokens are session-scoped and harmless to leave behind, but
  // signing out is a clear "reset this device" intent.
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('vr_name_') || key.startsWith('vr_anon_') || key.startsWith('vr_id_')) {
      localStorage.removeItem(key)
    }
  })
  // Also clear the legacy sessionStorage entries from before the localStorage
  // migration; otherwise stale per-tab data lingers until tab close.
  Object.keys(sessionStorage).forEach(key => {
    if (key.startsWith('vr_name_')) sessionStorage.removeItem(key)
  })
}
