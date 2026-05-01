export function clearSessionNames() {
  if (typeof window === 'undefined') return
  Object.keys(sessionStorage).forEach(key => {
    if (key.startsWith('vr_name_')) sessionStorage.removeItem(key)
  })
}
