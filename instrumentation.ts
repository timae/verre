// Next.js instrumentation hook — runs once when the server process starts.
// We use it to download the geo IP→country tables from S3 to local disk so
// lib/geo.ts can query them (see lib/geoData.ts for the why/how). Best-effort:
// a failure just means geo labels are unavailable ("Unknown location"), never a
// boot failure.
export async function register() {
  // Only the Node.js server runtime can touch fs / S3 (not the Edge runtime,
  // which also loads instrumentation). Guard on the runtime flag.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { downloadGeoData } = await import('@/lib/geoData')
  await downloadGeoData()
}
